import { test } from "node:test";
import assert from "node:assert/strict";
import type { HelloPermissions } from "@jarhead/hands";
import { PERMISSION_KINDS, grantOf, type Grant, type PermissionInfo, type PermissionKind } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { RecordingHands, settle, world, type World } from "./world.ts";

/**
 * The permissions sweep, engine side. The hands helper is a child of the app, so a
 * fresh helper process reads four grants for it (Accessibility, Screen Recording,
 * Input Monitoring, Full Disk Access); the app reads the other twelve and sends
 * them over the wire. Nothing here shows a dialog: the fake answers the helper's
 * `permissions` op and the fresh read comes from `fresh` below.
 */

class PermissionHands extends RecordingHands {
  /** What a fresh helper process (`--permissions`) and the resident helper's greeting say. */
  fresh: HelloPermissions = { accessibility: true, screenRecording: true, inputMonitoring: false, fullDiskAccess: false };
  probes = 0;
  override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (op === "hello") {
      this.ops.push({ op, params, at: this.now() });
      return { version: "fake", pid: 1, permissions: this.fresh } as T;
    }
    return super.request(op, params);
  }
  /** The `which` of every prompt op sent so far, in order. */
  prompted(): unknown[] {
    return this.named("permissions").filter((o) => o.params["prompt"] === true).map((o) => o.params["which"]);
  }
}

function permissionWorld(fresh?: HelloPermissions): { w: World; hands: PermissionHands; poll(): Promise<void>; helperExits(): number } {
  const hands = new PermissionHands();
  if (fresh) hands.fresh = fresh;
  const w = world({
    hands,
    probePermissions: async () => {
      hands.probes++;
      return hands.fresh;
    },
  });
  let exits = 0;
  w.engine.hands.on("exit", () => exits++);
  return {
    w,
    hands,
    // The poll runs from tick() once a second on the wall clock; tests call it directly and move the fake clock past the interval.
    poll: () => (w.engine as unknown as { pollPermissions(): Promise<void> }).pollPermissions(),
    helperExits: () => exits,
  };
}

/** start() reads the helper's greeting in the background; wait for it (the first test in a file pays for cold fs reads in agents.refresh()). */
async function started(w: World): Promise<void> {
  await w.engine.start();
  for (let i = 0; i < 200 && w.engine.snapshot().permissions.all.length === 0; i++) await settle(10);
  assert.ok(w.engine.snapshot().permissions.all.length > 0, "the helper's greeting was folded");
}

const grants = (w: World): [string, string][] => w.engine.snapshot().permissions.all.map((r) => [r.kind, r.grant]);
const row = (w: World, kind: PermissionKind): PermissionInfo | undefined => w.engine.snapshot().permissions.all.find((r) => r.kind === kind);
/** The grant the snapshot's rows carry for a kind ("unknown" without a row) — what every reader of `permissions` computes. */
const grant = (w: World, kind: PermissionKind): Grant => grantOf(w.engine.snapshot().permissions, kind);
const toasts = (w: World): string[] => w.events.flatMap((e) => (e.type === "toast" ? [e.text] : []));
const problems = (w: World): readonly string[] => w.engine.snapshot().problems.map((p) => p.text);
/** What the app's PermissionsCenter sends after a sweep: every kind, its own labels, one grant overridden. */
const appList = (overrides: Partial<Record<PermissionKind, Grant>> = {}): PermissionInfo[] =>
  PERMISSION_KINDS.map((kind) => ({ kind, grant: overrides[kind] ?? "granted", ask: "prompt", required: false, label: `app ${kind}`, why: "from the app", detail: `d-${kind}` }));

test("a helper read builds the list when the app has not sent one; missing grants are problems, granted ones are not", async () => {
  const { w } = permissionWorld();
  try {
    await started(w);
    assert.equal(grant(w, "accessibility"), "granted");
    assert.equal(grant(w, "screenRecording"), "granted");
    assert.equal(grant(w, "microphone"), "unknown", "the microphone is the app's to report: no row until it does");
    assert.deepEqual(grants(w), [
      ["accessibility", "granted"],
      ["screenRecording", "granted"],
      ["inputMonitoring", "denied"],
      ["fullDiskAccess", "denied"],
    ]);
    const fda = row(w, "fullDiskAccess")!;
    assert.equal(fda.label, "Full Disk Access");
    assert.equal(fda.ask, "settings", "only System Settings grants it");
    assert.equal(fda.required, true);
    assert.ok(typeof fda.checkedAt === "number");
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess));
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.inputMonitoring));
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.screenRecording));
    assert.match(Engine.PERMISSION_PROBLEMS.fullDiskAccess, /EPERM/);
    assert.match(Engine.PERMISSION_PROBLEMS.fullDiskAccess, /Full Disk Access/);
    assert.match(Engine.PERMISSION_PROBLEMS.inputMonitoring, /earlier build/, "the ad-hoc-row hint is on every helper kind");
    assert.equal(toasts(w).length, 0, "a first read toasts nothing");
  } finally {
    await w.engine.stop();
  }
});

test("the catalogue's required kinds are the app's seven (PermissionsKit.meta), so status and Setup name the same missing kinds", () => {
  const required = PERMISSION_KINDS.filter((k) => Engine.PERMISSION_CATALOGUE[k].required);
  assert.deepEqual(required, ["microphone", "speechRecognition", "screenRecording", "accessibility", "inputMonitoring", "automation", "fullDiskAccess"]);
  assert.equal(Engine.PERMISSION_CATALOGUE.fullDiskAccess.ask, "settings");
  assert.equal(Engine.PERMISSION_CATALOGUE.automation.ask, "perApp");
  for (const k of PERMISSION_KINDS) if (k !== "fullDiskAccess" && k !== "automation") assert.equal(Engine.PERMISSION_CATALOGUE[k].ask, "prompt", k);
});

test("problems clear and a toast fires when a grant appears; a revocation is a problem and a warning; only AX/SR restart the helper", async () => {
  const { w, hands, poll, helperExits } = permissionWorld();
  try {
    await started(w);
    // Full Disk Access dragged in: the row flips, the problem goes, the toast says what works now, the helper is not restarted (FDA is the daemon's reads, not the helper's connections).
    hands.fresh = { ...hands.fresh, fullDiskAccess: true };
    w.clock.t += 31_000;
    await poll();
    assert.equal(row(w, "fullDiskAccess")?.grant, "granted");
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess));
    assert.ok(toasts(w).some((t) => /^Full Disk Access granted/.test(t)));
    assert.equal(helperExits(), 0);
    // Accessibility revoked: problem back, a warning, and the row follows.
    hands.fresh = { ...hands.fresh, accessibility: false };
    w.clock.t += 31_000;
    await poll();
    assert.equal(grant(w, "accessibility"), "denied");
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.ok(toasts(w).includes("Accessibility was revoked"));
    // Granted again: the resident helper restarts so its AX connection carries the new right.
    hands.fresh = { ...hands.fresh, accessibility: true };
    w.clock.t += 31_000;
    await poll();
    await settle();
    assert.equal(grant(w, "accessibility"), "granted");
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.ok(toasts(w).some((t) => /^Accessibility granted/.test(t)));
    assert.equal(helperExits(), 1, "the helper was restarted once, for the Accessibility grant");
  } finally {
    await w.engine.stop();
  }
});

test("poll cadence: 3 s while a kind with a prompt is missing, 30 s when only Full Disk Access is (or nothing is), 1.5 s inside the fast window", async () => {
  // Kevin's likely steady state: the three prompt kinds granted, FDA never dragged in. That must not cost a process every 3 s for the daemon's life.
  const { w, hands, poll } = permissionWorld({ accessibility: true, screenRecording: true, inputMonitoring: true, fullDiskAccess: false });
  try {
    await started(w);
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess), "the problem line still stands");
    w.clock.t += 31_000;
    await poll();
    let probes = hands.probes;
    w.clock.t += 5_000;
    await poll();
    assert.equal(hands.probes, probes, "FDA alone missing: no read inside 30 s");
    w.clock.t += 26_000;
    await poll();
    assert.equal(hands.probes, probes + 1, "a read at 30 s");
    // Input Monitoring lost: it has a prompt Setup can fire, so the poll tightens to 3 s.
    hands.fresh = { ...hands.fresh, inputMonitoring: false };
    w.clock.t += 31_000;
    await poll();
    probes = hands.probes;
    w.clock.t += 2_000;
    await poll();
    assert.equal(hands.probes, probes, "no read inside 3 s");
    w.clock.t += 1_100;
    await poll();
    assert.equal(hands.probes, probes + 1, "a read at 3 s");
    // Everything granted: 30 s again.
    hands.fresh = { accessibility: true, screenRecording: true, inputMonitoring: true, fullDiskAccess: true };
    w.clock.t += 3_100;
    await poll();
    await settle();
    probes = hands.probes;
    w.clock.t += 5_000;
    await poll();
    assert.equal(hands.probes, probes, "all granted: no read inside 30 s");
    w.clock.t += 26_000;
    await poll();
    assert.equal(hands.probes, probes + 1);
  } finally {
    await w.engine.stop();
  }
});

test("the app's list wins for everything else; the helper's fresh read updates only its four kinds", async () => {
  const { w, hands, poll } = permissionWorld();
  try {
    await started(w);
    // The app read every kind. It says Full Disk Access is on (a resident process's stale answer); contacts denied.
    const list = appList({ contacts: "denied" });
    w.engine.setPermissions([...list, null, {}, { kind: "teleport", grant: "granted" }, "nonsense"]);
    const all = w.engine.snapshot().permissions.all;
    assert.deepEqual(all.map((r) => r.kind), [...PERMISSION_KINDS], "the app's rows, in its order; junk dropped");
    assert.equal(row(w, "contacts")?.grant, "denied");
    assert.equal(row(w, "contacts")?.label, "app contacts");
    assert.equal(row(w, "fullDiskAccess")?.grant, "denied", "the engine's fresh read of an FDA it can see wins over the app's stale one");
    assert.equal(row(w, "fullDiskAccess")?.label, "app fullDiskAccess", "but the row stays the app's");
    assert.equal(row(w, "fullDiskAccess")?.detail, "d-fullDiskAccess");
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess), "the app's stale 'granted' clears no problem");
    assert.equal(toasts(w).length, 0);
    assert.equal(grant(w, "microphone"), "granted", "the microphone follows the app's list");
    // A fresh read flips Input Monitoring: that row's grant moves, its label stays the app's, nothing else changes.
    hands.fresh = { ...hands.fresh, inputMonitoring: true };
    w.clock.t += 31_000;
    await poll();
    assert.equal(row(w, "inputMonitoring")?.grant, "granted");
    assert.equal(row(w, "inputMonitoring")?.label, "app inputMonitoring");
    assert.equal(row(w, "contacts")?.grant, "denied");
    assert.equal(w.engine.snapshot().permissions.all.length, 16);
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.inputMonitoring));
    // The app's list carrying the microphone denied raises the mic problem; granted again clears it.
    w.engine.setPermissions(appList({ microphone: "denied" }));
    assert.ok(problems(w).some((p) => /Microphone access denied/.test(p)));
    w.engine.setPermissions(appList());
    assert.ok(!problems(w).some((p) => /Microphone access denied/.test(p)));
  } finally {
    await w.engine.stop();
  }
});

test("the app reports a helper kind's grant before the poll: the engine keeps its own read until the next one, which clears the problem and restarts the helper exactly once; the app's stale word never flips a fresh read", async () => {
  const { w, hands, poll, helperExits } = permissionWorld({ accessibility: false, screenRecording: true, inputMonitoring: true, fullDiskAccess: true });
  try {
    await started(w);
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    // The grant lands. The app's own 1.5 s watch sees it first and reports it the way PermissionsCenter.apply does: one `permission`, then the list.
    hands.fresh = { ...hands.fresh, accessibility: true };
    w.engine.setPermission("accessibility", "granted", "asked just now");
    w.engine.setPermissions(appList());
    assert.equal(row(w, "accessibility")?.grant, "denied", "the engine's last fresh read stands until it reads again");
    assert.equal(row(w, "accessibility")?.detail, "d-accessibility", "the row itself is the app's");
    assert.equal(grant(w, "accessibility"), "denied");
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility), "the app's word clears no problem");
    assert.equal(helperExits(), 0, "and restarts no helper");
    // The disagreement made the next tick read fresh (no waiting for the 3 s interval): the read clears the problem, toasts, restarts the helper.
    w.clock.t += 100;
    await poll();
    await settle();
    assert.equal(row(w, "accessibility")?.grant, "granted");
    assert.equal(grant(w, "accessibility"), "granted");
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.ok(toasts(w).some((t) => /^app accessibility granted — hands can click and type now$/.test(t)), "the toast wears the app's row label");
    assert.equal(helperExits(), 1, "restarted once, by the fresh read");
    w.clock.t += 31_000;
    await poll();
    await settle();
    assert.equal(helperExits(), 1, "a later read that agrees restarts nothing");
    // The inverse: the app's stale 'denied' arrives while the fresh read says granted. Nothing moves, nothing is revoked, nothing restarts.
    const toastsBefore = toasts(w).length;
    w.engine.setPermission("accessibility", "denied");
    w.engine.setPermissions(appList({ accessibility: "denied", fullDiskAccess: "denied" }));
    assert.equal(row(w, "accessibility")?.grant, "granted");
    assert.equal(row(w, "fullDiskAccess")?.grant, "granted");
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess));
    w.clock.t += 100;
    await poll();
    await settle();
    assert.equal(toasts(w).length, toastsBefore, "no 'was revoked' for a stale word");
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.equal(helperExits(), 1);
  } finally {
    await w.engine.stop();
  }
});

test("a single permission message updates its row, or adds the catalogue row for a kind not listed yet", async () => {
  const { w } = permissionWorld();
  try {
    await started(w);
    assert.equal(row(w, "contacts"), undefined);
    w.engine.setPermission("contacts", "denied", "asked today");
    const contacts = row(w, "contacts")!;
    assert.equal(contacts.grant, "denied");
    assert.equal(contacts.label, "Contacts");
    assert.equal(contacts.ask, "prompt");
    assert.equal(contacts.detail, "asked today");
    w.engine.setPermission("contacts", "granted");
    assert.equal(row(w, "contacts")?.grant, "granted");
    assert.equal(row(w, "contacts")?.detail, "asked today", "a message without detail keeps the last one");
    w.engine.setPermission("microphone", "denied");
    assert.equal(grant(w, "microphone"), "denied");
    assert.equal(row(w, "microphone")?.grant, "denied");
    assert.ok(problems(w).some((p) => /Microphone access denied/.test(p)));
    w.engine.setPermission("microphone", "granted");
    assert.ok(!problems(w).some((p) => /Microphone access denied/.test(p)));
    // An unknown kind is dropped, not a row.
    w.engine.setPermission("teleport", "granted");
    assert.ok(!w.engine.snapshot().permissions.all.some((r) => (r.kind as string) === "teleport"));
  } finally {
    await w.engine.stop();
  }
});

test("the app's list is one row per kind (the last wins) and never drops a helper kind the engine has read", async () => {
  const { w } = permissionWorld();
  try {
    await started(w);
    const contacts = (grant: Grant): PermissionInfo => ({ kind: "contacts", grant, ask: "prompt", required: false, label: "Contacts", why: "who" });
    const mic = (grant: Grant): PermissionInfo => ({ kind: "microphone", grant, ask: "prompt", required: true, label: "Microphone", why: "hearing" });
    // Two contacts rows and no helper kinds at all.
    w.engine.setPermissions([contacts("granted"), mic("granted"), contacts("denied")]);
    assert.deepEqual(grants(w), [
      ["contacts", "denied"],
      ["microphone", "granted"],
      ["accessibility", "granted"],
      ["screenRecording", "granted"],
      ["inputMonitoring", "denied"],
      ["fullDiskAccess", "denied"],
    ]);
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess), "the problem and its row agree");
    w.engine.setPermission("contacts", "granted");
    assert.deepEqual(w.engine.snapshot().permissions.all.filter((r) => r.kind === "contacts").map((r) => r.grant), ["granted"], "one row moved, not a first of two");
  } finally {
    await w.engine.stop();
  }
});

test("request-permission 'all' prompts Accessibility, then Screen Recording only once it lands (or 30 s pass); a single kind prompts that one; other kinds are the app's", async () => {
  const { w, hands, poll } = permissionWorld({ accessibility: false, screenRecording: false, inputMonitoring: true, fullDiskAccess: true });
  try {
    await started(w);
    const probesBefore = hands.probes;
    await w.engine.command({ type: "request-permission", which: "all" });
    assert.deepEqual(hands.prompted(), ["accessibility"], "one dialog: Accessibility; Screen Recording waits");
    assert.equal(hands.probes, probesBefore + 1, "a fresh read right after the prompt");
    // The fast window: 1.5 s, and Screen Recording is still not asked while Accessibility is pending.
    w.clock.t += 1_600;
    await poll();
    assert.equal(hands.probes, probesBefore + 2);
    assert.deepEqual(hands.prompted(), ["accessibility"]);
    // Accessibility lands: the next read shows the Screen Recording dialog and reads again.
    hands.fresh = { ...hands.fresh, accessibility: true };
    w.clock.t += 1_600;
    await poll();
    await settle();
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording"]);
    assert.equal(hands.probes, probesBefore + 4, "the read that saw the grant, and one right after the second prompt");
    // Screen Recording lands: the queue is empty, no further prompt.
    hands.fresh = { ...hands.fresh, screenRecording: true };
    w.clock.t += 1_600;
    await poll();
    await settle();
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording"]);
    // The fast window closes 90 s after the last prompt: back to the slow cadence (all four granted: 30 s).
    w.clock.t += 91_000;
    await poll();
    const probes = hands.probes;
    w.clock.t += 1_600;
    await poll();
    assert.equal(hands.probes, probes, "the window closed");
    // A kind the app owns: nothing happens here (the app intercepts the command and shows the prompt itself).
    await w.engine.command({ type: "request-permission", which: "contacts" });
    await w.engine.command({ type: "request-permission", which: "fullDiskAccess" });
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording"]);
    assert.equal(hands.probes, probes);
    // A single helper kind prompts that one only, even when the other is missing too.
    hands.fresh = { ...hands.fresh, accessibility: false, screenRecording: false };
    w.clock.t += 31_000;
    await poll();
    await w.engine.command({ type: "request-permission", which: "screenRecording" });
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording", "screenRecording"]);
    // 'all' with only one missing asks for that one.
    hands.fresh = { ...hands.fresh, accessibility: true };
    w.clock.t += 1_600;
    await poll();
    await w.engine.command({ type: "request-permission", which: "all" });
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording", "screenRecording", "screenRecording"]);
    // A granted kind is not asked for again.
    hands.fresh = { ...hands.fresh, screenRecording: true };
    w.clock.t += 1_600;
    await poll();
    await w.engine.command({ type: "request-permission", which: "accessibility" });
    await w.engine.command({ type: "request-permission", which: "all" });
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording", "screenRecording", "screenRecording"]);
  } finally {
    await w.engine.stop();
  }
});

test("a dialog nobody answers: Screen Recording is asked 30 s after Accessibility anyway, and a new request replaces the queue", async () => {
  const { w, hands, poll } = permissionWorld({ accessibility: false, screenRecording: false, inputMonitoring: true, fullDiskAccess: true });
  try {
    await started(w);
    await w.engine.command({ type: "request-permission", which: "all" });
    assert.deepEqual(hands.prompted(), ["accessibility"]);
    w.clock.t += Engine.PROMPT_WAIT_MS - 1_000;
    await poll();
    assert.deepEqual(hands.prompted(), ["accessibility"], "still waiting");
    w.clock.t += 1_600;
    await poll();
    await settle();
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording"], "moved on without the grant");
    // A fresh 'all' while Screen Recording is pending starts over: Accessibility first, the old queue gone.
    await w.engine.command({ type: "request-permission", which: "all" });
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording", "accessibility"]);
    hands.fresh = { ...hands.fresh, accessibility: true };
    w.clock.t += 1_600;
    await poll();
    await settle();
    assert.deepEqual(hands.prompted(), ["accessibility", "screenRecording", "accessibility", "screenRecording"]);
  } finally {
    await w.engine.stop();
  }
});

test("JARHEAD_PERMISSIONS_DRY_RUN=1 logs what the sweep would ask and asks nothing", async () => {
  const { w, hands } = permissionWorld({ accessibility: false, screenRecording: false, inputMonitoring: true, fullDiskAccess: true });
  const before = process.env["JARHEAD_PERMISSIONS_DRY_RUN"];
  process.env["JARHEAD_PERMISSIONS_DRY_RUN"] = "1";
  try {
    await started(w);
    const probesBefore = hands.probes;
    await w.engine.command({ type: "request-permission", which: "all" });
    assert.deepEqual(hands.prompted(), [], "no prompt op reached the helper");
    assert.equal(hands.probes, probesBefore + 1, "the read still happens");
  } finally {
    if (before === undefined) delete process.env["JARHEAD_PERMISSIONS_DRY_RUN"];
    else process.env["JARHEAD_PERMISSIONS_DRY_RUN"] = before;
    await w.engine.stop();
  }
});

test("a helper that prints only two grants leaves the other rows alone; for those the app's word is taken and its problems follow it", async () => {
  const { w, helperExits } = permissionWorld({ accessibility: false, screenRecording: true });
  try {
    await started(w);
    assert.deepEqual(grants(w), [
      ["accessibility", "denied"],
      ["screenRecording", "granted"],
    ]);
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.accessibility));
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess), "nothing is said about a kind the helper did not read");
    // No fresh read of Full Disk Access exists here, so the app's word is the truth: a denial raises the problem, the grant clears it and toasts.
    w.engine.setPermission("fullDiskAccess", "denied", "not in the list");
    assert.equal(row(w, "fullDiskAccess")?.grant, "denied");
    assert.equal(row(w, "fullDiskAccess")?.detail, "not in the list");
    assert.ok(problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess));
    assert.equal(toasts(w).length, 0, "a first word toasts nothing");
    w.engine.setPermissions(appList({ accessibility: "denied" }));
    assert.equal(row(w, "fullDiskAccess")?.grant, "granted", "the list's word, the engine having no read of its own");
    assert.ok(!problems(w).includes(Engine.PERMISSION_PROBLEMS.fullDiskAccess));
    assert.ok(toasts(w).some((t) => /^Full Disk Access granted/.test(t)));
    assert.equal(row(w, "accessibility")?.grant, "denied", "Accessibility the engine did read: its own answer stands");
    await settle();
    assert.equal(helperExits(), 0, "no restart for a kind that is not the helper's connection");
  } finally {
    await w.engine.stop();
  }
});
