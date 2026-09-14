import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HelloPermissions } from "@jarhead/hands";
import { classifyLiveError } from "@jarhead/live";
import type { Problem, ProblemKind } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { FakeLive, RecordingHands, current, settle, world, type World } from "./world.ts";

/**
 * Problems, typed (REDESIGN §16): every problem line carries a kind, one remedy and when
 * it was first seen; the list dedupes by kind + text; a fixed problem clears itself; the
 * remedy button (`problem.retry`) re-runs that kind's check. Plus the disk preflight
 * (a fake statvfs), the crash report row, and the GPT-Live-1 error classifier.
 */

const typed = (w: World): readonly Problem[] => w.engine.typedProblems();
const ofKind = (w: World, kind: ProblemKind): readonly Problem[] => typed(w).filter((p) => p.kind === kind);
const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();

/** Hands whose greeting reports the given grants (the engine's own four). */
class GrantHands extends RecordingHands {
  fresh: HelloPermissions = { accessibility: true, screenRecording: true, inputMonitoring: true, fullDiskAccess: false };
  override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (op === "hello") {
      this.ops.push({ op, params, at: this.now() });
      return { version: "fake", pid: 1, permissions: this.fresh } as T;
    }
    return super.request(op, params);
  }
}

async function greeted(w: World): Promise<void> {
  await w.engine.start();
  for (let i = 0; i < 200 && w.engine.snapshot().permissions.all.length === 0; i++) await settle(10);
}

test("the snapshot's problems carry kind, remedy and since; a repeat keeps its place and its since; the cap and clear-problems apply", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    const t0 = clock.t;
    engine.problemOf("other", "first");
    clock.t += 1000;
    engine.problemOf("other", "first"); // a repeat: no second row, since unchanged
    engine.problemOf("disk.low", "disk", { label: "Reveal shots", open: "/x/shots" });
    assert.deepEqual(engine.snapshot().problems.map((p) => p.text), ["first", "disk"]);
    assert.deepEqual(typed(w), [
      { kind: "other", text: "first", since: t0 },
      { kind: "disk.low", text: "disk", remedy: { label: "Reveal shots", open: "/x/shots" }, since: t0 + 1000 },
    ]);
    // The ledger has one problem row per first sighting.
    assert.equal((engine.ledger.read(clock.t) as { type: string; text?: string }[]).filter((r) => r.type === "problem").length, 2);
    // The cap: the oldest leave, meta with them.
    for (let i = 0; i < Engine.MAX_PROBLEMS; i++) engine.problemOf("other", `p${i}`);
    assert.equal(engine.snapshot().problems.length, Engine.MAX_PROBLEMS);
    assert.equal(typed(w).length, Engine.MAX_PROBLEMS);
    assert.ok(!typed(w).some((p) => p.text === "first"));
    // clear-problems (the command arm K1 wires) empties the plain list; the typed view follows.
    await engine.command({ type: "clear-problems" });
    assert.deepEqual(engine.snapshot().problems, []);
    assert.deepEqual(typed(w), []);
  } finally {
    await engine.stop();
  }
});

test("a missing grant is a permission.* problem with Request / Open pane as its remedy; the grant appearing clears it; the microphone is the app's pane", async () => {
  const hands = new GrantHands();
  const w = world({ hands, probePermissions: async () => hands.fresh });
  const { engine } = w;
  try {
    await greeted(w);
    const fda = ofKind(w, "permission.fullDiskAccess");
    assert.equal(fda.length, 1);
    assert.equal(fda[0]!.text, Engine.PERMISSION_PROBLEMS.fullDiskAccess);
    assert.deepEqual(fda[0]!.remedy, { label: "Open pane", command: { type: "request-permission", which: "fullDiskAccess" } });
    assert.deepEqual(Engine.permissionRemedy("accessibility"), { label: "Request", command: { type: "request-permission", which: "accessibility" } });
    assert.deepEqual(Engine.permissionRemedy("screenRecording"), { label: "Request", command: { type: "request-permission", which: "screenRecording" } });
    assert.equal(Engine.permissionProblemKind("inputMonitoring"), "permission.other");
    // The grant lands: the fresh read clears the row (a fixed problem clears itself).
    hands.fresh = { ...hands.fresh, fullDiskAccess: true };
    w.clock.t += 60_000;
    await (engine as unknown as { pollPermissions(): Promise<void> }).pollPermissions();
    assert.equal(ofKind(w, "permission.fullDiskAccess").length, 0);
    // The microphone: denied is permission.microphone with the app's pane; granted clears it.
    engine.setPermission("microphone", "denied");
    const mic = ofKind(w, "permission.microphone");
    assert.equal(mic.length, 1);
    assert.deepEqual(mic[0]!.remedy, { label: "Open pane", command: { type: "request-permission", which: "microphone" } });
    engine.setPermission("microphone", "granted");
    assert.equal(ofKind(w, "permission.microphone").length, 0);
    // problem.retry on the app-owned kinds reads fresh and closely: a grant revoked meanwhile is seen on that read.
    hands.fresh = { ...hands.fresh, fullDiskAccess: false };
    await engine.retryProblem("permission.fullDiskAccess");
    assert.equal(ofKind(w, "permission.fullDiskAccess").length, 1, "the retry's fresh read found it missing again");
  } finally {
    await engine.stop();
  }
});

test("Engine.permissionRemedy covers every kind the catalogue names, with the request-permission command the surfaces already route", () => {
  for (const kind of Object.keys(Engine.PERMISSION_CATALOGUE) as (keyof typeof Engine.PERMISSION_CATALOGUE)[]) {
    const r = Engine.permissionRemedy(kind);
    assert.ok(r.label === "Request" || r.label === "Open pane", `${kind}: ${r.label}`);
    assert.deepEqual(r.command, { type: "request-permission", which: kind });
    assert.ok(Engine.permissionProblemKind(kind).startsWith("permission."));
  }
  assert.equal(Engine.permissionRemedy("fullDiskAccess").label, "Open pane");
  assert.equal(Engine.permissionRemedy("microphone").label, "Open pane");
  assert.equal(Engine.permissionRemedy("contacts").label, "Request");
});

test("no hands helper is a hands.helper problem whose remedy is Restart helper; the retry re-probes and a helper that greets clears it", async () => {
  // No fake hands: the binary at config.handsBin does not exist, so the helper is "not built".
  const w = world({}, { noHands: true });
  const { engine } = w;
  try {
    await engine.start();
    await settle(50);
    const rows = ofKind(w, "hands.helper");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.text, /hands helper not built/);
    assert.deepEqual(rows[0]!.remedy, { label: "Restart helper", command: { type: "problem.retry", kind: "hands.helper" } });
    await engine.retryProblem("hands.helper");
    await settle(30);
    assert.equal(ofKind(w, "hands.helper").length, 1, "still not built: the retry raised it again");
  } finally {
    await engine.stop();
  }
  // With a helper that answers, the greeting clears whatever was said about it.
  const w2 = world();
  try {
    await greeted(w2);
    w2.engine.problemOf("hands.helper", "hands helper failed: boom", { label: "Restart helper", command: { type: "problem.retry", kind: "hands.helper" } });
    assert.equal(ofKind(w2, "hands.helper").length, 1);
    await w2.engine.retryProblem("hands.helper");
    await settle(30);
    assert.equal(ofKind(w2, "hands.helper").length, 0);
    assert.ok(w2.hands.named("hello").length >= 2, "the retry restarted the helper and it greeted again");
  } finally {
    await w2.engine.stop();
  }
});

test("Live errors are typed by the classifier: a limit is voice.limit with Retry in 30 s and clears itself after 30 s; a key error is voice.key → Setup; a socket error is voice.connection; the reconnect row counts seconds and clears when the session is back", async () => {
  assert.equal(classifyLiveError("response_input_buffer_full: Backend response input history is limited to 128 items and 32768 U…"), "limit");
  assert.equal(classifyLiveError("rate_limit_exceeded: Rate limit reached for gpt-live-1"), "limit");
  assert.equal(classifyLiveError("invalid_api_key: Incorrect API key provided"), "key");
  assert.equal(classifyLiveError("OPENAI_API_KEY is missing; set it in ~/.jarhead/env (Setup › Voice writes it)"), "key");
  assert.equal(classifyLiveError("live socket closed before start (code 1006)"), "connection");
  assert.equal(classifyLiveError("live session did not start within 15000ms"), "connection");
  assert.equal(classifyLiveError("unknown_parameter: nope"), "other");
  assert.equal(classifyLiveError(""), "other");

  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.emit("error", new Error("response_input_buffer_full: Backend response input history is limited to 128 items"), "steer_9");
    live.emit("error", new Error("response_input_buffer_full: Backend response input history is limited to 128 items"), "steer_10");
    const limit = ofKind(w, "voice.limit");
    assert.equal(limit.length, 1, "deduped by kind + text");
    assert.equal(limit[0]!.remedy?.label, "Retry in 30 s");
    assert.equal(limit[0]!.since, clock.t);
    live.emit("error", new Error("context_injection_incomplete: The session closed before the estimated context"), "x");
    assert.equal(typed(w).length, 1, "an append racing a close is not a problem");
    live.emit("error", new Error("invalid_api_key: Incorrect API key provided"), "y");
    assert.deepEqual(ofKind(w, "voice.key")[0]!.remedy, { label: "Open Setup", open: "jarhead://setup" });
    // The limit clears itself after 30 s; the key row stays (nothing fixes a key by waiting).
    clock.t += Engine.VOICE_LIMIT_CLEAR_MS - 1000;
    tick(w);
    assert.equal(ofKind(w, "voice.limit").length, 1);
    clock.t += 1000;
    tick(w);
    assert.equal(ofKind(w, "voice.limit").length, 0);
    assert.equal(ofKind(w, "voice.key").length, 1);
    await engine.retryProblem("voice.key");
    // The reconnect row: the server drops the session; the engine reconnects and the row counts.
    live.serverClosed("connection_lost", 5);
    const conn = ofKind(w, "voice.connection");
    assert.equal(conn.length, 1);
    assert.match(conn[0]!.text, /^connection lost · reconnecting$/);
    assert.deepEqual(conn[0]!.remedy, { label: "Retry", command: { type: "go" } });
    const since = conn[0]!.since;
    clock.t += 3000;
    tick(w);
    const later = ofKind(w, "voice.connection");
    assert.equal(later.length, 1, "one row per kind, its text refreshed");
    assert.match(later[0]!.text, /reconnecting for 3 s$/);
    assert.equal(later[0]!.since, since, "a refresh keeps the first-seen");
    await settle(600); // the 500 ms reconnect
    assert.equal(w.lives.length, 2);
    assert.equal(current(w).currentState, "started");
    assert.equal(ofKind(w, "voice.connection").length, 0, "the session is back: the row is gone");
  } finally {
    await engine.stop();
  }
});

test("no OPENAI_API_KEY is voice.key with Open Setup; a failed start is typed by its message and Go retries it", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    const key = engine.config.openaiApiKey;
    engine.config = { ...engine.config, openaiApiKey: undefined };
    await engine.wake("test");
    assert.equal(engine.currentPhase, "error");
    assert.deepEqual(ofKind(w, "voice.key").map((p) => p.remedy), [{ label: "Open Setup", open: "jarhead://setup" }]);
    engine.config = { ...engine.config, openaiApiKey: key };
    live.failStart = true;
    await engine.wake("test");
    const conn = ofKind(w, "voice.connection");
    assert.equal(conn.length, 1);
    assert.match(conn[0]!.text, /could not start a Live session/);
    assert.deepEqual(conn[0]!.remedy, { label: "Retry", command: { type: "go" } });
  } finally {
    await engine.stop();
  }
});

test("the disk preflight: under 500 MB free is disk.low with Reveal shots, a mark is not captured, and space returning clears it on the next re-check", async () => {
  const disk = { bavail: 10, bsize: 4096 }; // 40 KB free
  const w = world({ statfs: () => disk });
  const { engine, hands, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    const low = ofKind(w, "disk.low");
    assert.equal(low.length, 1);
    assert.match(low[0]!.text, /^Disk low: 0 MB free on .*; screenshots are not being saved$/);
    assert.deepEqual(low[0]!.remedy, { label: "Reveal shots", open: join(engine.config.stateDir, "shots") });
    await engine.wake("test");
    assert.equal(engine.transportState, "awake", "a session still opens with a low disk");
    await engine.command({ type: "mark.add", rect: { x: 10, y: 10, w: 100, h: 50 } });
    assert.equal(hands.named("zoom").length, 0, "the mark's capture was skipped");
    assert.equal(engine.snapshot().marks?.length, 1, "the mark itself still counts");
    // Space comes back: the tick re-measures after DISK_RECHECK_MS and the row clears.
    disk.bavail = 1_000_000; // ~4 GB
    clock.t += Engine.DISK_RECHECK_MS - 1000;
    tick(w);
    assert.equal(ofKind(w, "disk.low").length, 1, "not re-measured yet");
    clock.t += 1000;
    tick(w);
    assert.equal(ofKind(w, "disk.low").length, 0);
    await engine.command({ type: "mark.add", rect: { x: 10, y: 10, w: 100, h: 50 } });
    assert.equal(hands.named("zoom").length, 1, "captures again");
    // The remedy button re-measures at once.
    disk.bavail = 10;
    await engine.retryProblem("disk.low");
    assert.equal(ofKind(w, "disk.low").length, 1);
  } finally {
    await engine.stop();
  }
});

test("a fresh crash report under <stateDir>/crashes is a crash row with Details opening the file; a stale one, or one the process survived, is not", async () => {
  const w = world();
  const dir = join(w.engine.config.stateDir, "crashes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-09-12 10-00-00.txt"), "jarhead crash report\nreason: NSInternalInconsistencyException — Failed to create tap due to format mismatch\nrelaunch: yes (1 of 3)\n");
  try {
    await w.engine.start();
    const crash = ofKind(w, "crash");
    assert.equal(crash.length, 1);
    assert.match(crash[0]!.text, /^Jarhead crashed just now · NSInternalInconsistencyException — Failed to create tap/);
    assert.deepEqual(crash[0]!.remedy, { label: "Details", open: join(dir, "2026-09-12 10-00-00.txt") });
    await w.engine.retryProblem("crash");
    assert.equal(ofKind(w, "crash").length, 0, "the retry on a report is a dismiss");
  } finally {
    await w.engine.stop();
  }
  const w2 = world();
  const dir2 = join(w2.engine.config.stateDir, "crashes");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "a.txt"), "jarhead crash report\nreason: boom\nsurvived: AppKit swallowed the exception\n");
  try {
    await w2.engine.start();
    assert.equal(ofKind(w2, "crash").length, 0, "an exception the process outlived is a note, not a crash");
  } finally {
    await w2.engine.stop();
  }
});

test("problem.retry on the brain clears the rows and restarts the brain; on voice.connection it reconnects only when Jarhead should be awake", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.problemOf("brain.unavailable", "Codex brain unavailable (x); trying the next backend", { label: "Retry", command: { type: "config.probe" } });
    assert.equal(ofKind(w, "brain.unavailable").length, 1);
    await engine.retryProblem("brain.unavailable");
    assert.equal(ofKind(w, "brain.unavailable").length, 0);
    assert.equal(engine.brainInfo.ready, true, "the fake brain restarted and is ready");
    // voice.connection while asleep on purpose: cleared, no session opened.
    engine.problemOf("voice.connection", "connection lost · reconnecting", { label: "Retry", command: { type: "go" } });
    await engine.retryProblem("voice.connection");
    assert.equal(ofKind(w, "voice.connection").length, 0);
    assert.equal(engine.transportState, "asleep");
    assert.equal(live.currentState, "idle", "no session was opened for a retry while asleep");
  } finally {
    await engine.stop();
  }
});

test("the snapshot's problems are the typed list, and the problem.retry command reaches retryProblem", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.problemOf("other", "command failed: nope");
    engine.problemOf("disk.low", "Disk low: 3 MB free", { label: "Reveal shots", open: "/x/shots" });
    const snap = engine.snapshot();
    assert.deepEqual(
      snap.problems.map((p) => p.text),
      ["command failed: nope", "Disk low: 3 MB free"],
      "the typed list carries the lines, in order",
    );
    assert.deepEqual(
      snap.problems.map((p) => p.kind),
      ["other", "disk.low"],
    );
    assert.deepEqual(snap.problems[1]?.remedy, { label: "Reveal shots", open: "/x/shots" });
    // The remedy button's command, through the command arm the rail sends.
    await engine.command({ type: "problem.retry", kind: "other" });
    assert.deepEqual(engine.snapshot().problems.map((p) => p.text), ["Disk low: 3 MB free"]);
    assert.equal(engine.snapshot().problems.length, 1);
  } finally {
    await engine.stop();
  }
});

test("a reconnect whose start fails: the counting row ends and the failed start's own line stands with Retry → go; ticks do not rewrite it; Go retries and clears it", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // The session the reconnect will open refuses the socket.
    const refused = new FakeLive("sess_2");
    refused.failStart = true;
    w.lives.push(refused);
    live.serverClosed("connection_lost", 5);
    assert.match(ofKind(w, "voice.connection")[0]!.text, /^connection lost · reconnecting$/);
    await settle(700); // the 500 ms reconnect fires and its start fails
    assert.equal(w.lives.length, 2);
    assert.equal(engine.currentPhase, "error");
    let conn = ofKind(w, "voice.connection");
    assert.equal(conn.length, 1, `one row, the failed start's: ${JSON.stringify(conn.map((p) => p.text))}`);
    assert.match(conn[0]!.text, /^could not start a Live session/);
    assert.deepEqual(conn[0]!.remedy, { label: "Retry", command: { type: "go" } });
    // Ticks later: nothing is reconnecting, so nothing counts and the failure text stays.
    clock.t += 5000;
    tick(w);
    clock.t += 5000;
    tick(w);
    conn = ofKind(w, "voice.connection");
    assert.equal(conn.length, 1);
    assert.match(conn[0]!.text, /^could not start a Live session/, "ticks leave the failure where it is");
    assert.doesNotMatch(conn[0]!.text, /reconnecting for/);
    // The remedy: Go opens a session that starts, and the row is gone.
    await engine.command({ type: "go" });
    assert.equal(engine.transportState, "awake");
    assert.equal(w.lives.length, 3);
    assert.equal(ofKind(w, "voice.connection").length, 0);
  } finally {
    await engine.stop();
  }
});

test("an exhausted quota is a billing problem, not a limit: voice.key with Open Setup, and it does not clear after 30 s", async () => {
  assert.equal(classifyLiveError("insufficient_quota: You exceeded your current quota, please check your plan and billing details."), "key");
  assert.equal(classifyLiveError("billing_hard_limit_reached: Billing hard limit has been reached"), "key");
  assert.equal(classifyLiveError("rate_limit_exceeded: Rate limit reached for gpt-live-1: Limit 3, Used 3, Requested 1"), "limit");
  assert.equal(classifyLiveError("invalid_api_key: Incorrect API key provided"), "key");
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.emit("error", new Error("insufficient_quota: You exceeded your current quota, please check your plan and billing details."), "r_1");
    assert.equal(ofKind(w, "voice.limit").length, 0);
    const key = ofKind(w, "voice.key");
    assert.equal(key.length, 1);
    assert.deepEqual(key[0]!.remedy, { label: "Open Setup", open: "jarhead://setup" });
    clock.t += Engine.VOICE_LIMIT_CLEAR_MS + 5000;
    tick(w);
    assert.equal(ofKind(w, "voice.key").length, 1, "nothing fixes a quota by waiting");
  } finally {
    await engine.stop();
  }
});

test("the disk preflight runs before every capture: a disk that fills mid-session skips the next shot and raises disk.low at once, not at the next connect", async () => {
  const disk = { bavail: 1_000_000, bsize: 4096 }; // ~4 GB free
  const w = world({ statfs: () => disk });
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    assert.equal(ofKind(w, "disk.low").length, 0);
    await engine.command({ type: "mark.add", rect: { x: 10, y: 10, w: 100, h: 50 } });
    assert.equal(hands.named("zoom").length, 1, "room: captured");
    disk.bavail = 10; // 40 KB free, mid-session
    await engine.command({ type: "mark.add", rect: { x: 20, y: 20, w: 100, h: 50 } });
    assert.equal(hands.named("zoom").length, 1, "the capture was skipped without waiting for a re-check");
    assert.equal(ofKind(w, "disk.low").length, 1);
    assert.equal(engine.snapshot().marks?.length, 2, "both marks count");
    disk.bavail = 1_000_000;
    await engine.command({ type: "mark.add", rect: { x: 30, y: 30, w: 100, h: 50 } });
    assert.equal(hands.named("zoom").length, 2, "space back: captured, and the row is gone");
    assert.equal(ofKind(w, "disk.low").length, 0);
  } finally {
    await engine.stop();
  }
});
