import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTOMATIONS, type Automation, type AutomationEvent, type LedgerRow, type Problem } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import type { AutomationExec, ShellGate, ShellRunner } from "../automations/index.ts";
import { rows, settle, until, world, type World } from "./world.ts";

/**
 * W3-2, the sleep audit's repros adopted:
 * - SL-14: a fire that is not a ring does not flash. The `fired` event says `ring: false` when the fire only acted (a
 *   routine that opened Notes), so the app puts no ring up; a chime that rang says `ring: true`.
 * - SL-15: an unattended fire that failed (a nightly recipe's red exit) is an `automation.failed` problem on the island
 *   in the morning, Run now on it (Open Console when a setting has to change first), until the row's next ok fire.
 * - The zone why: a row a time zone move put behind now is missed `zone-moved`, and its words say the time zone moved,
 *   whichever of the tick and the app's clock.changed reads the move.
 * node --test runs this file in its own process, so the zone is this file's to move.
 */

const NY = "America/New_York";
const LA = "America/Los_Angeles";
process.env.TZ = NY;

const M = 60_000;
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
const home = (): string => mkdtempSync(join(tmpdir(), "jh-w32-home-"));
/** The wall clock of a Date in the process zone as it is when this runs (month 0-based, as Date takes it). */
const local = (y: number, mo: number, d: number, hh: number, mm: number): number => new Date(y, mo, d, hh, mm, 0, 0).getTime();
const exec: AutomationExec = { run: async () => ({ code: 0 }), hold: () => undefined };
/** No process runs; `zone` is the /etc/localtime link, scripted. */
const execWith = (zone: () => string | undefined): AutomationExec => ({ run: async () => ({ code: 0 }), hold: () => undefined, zone });
const gate: ShellGate = () => ({ verdict: "run", reason: "fake gate" });
type Fired = Extract<AutomationEvent, { kind: "fired" }>;
type MissedRow = Extract<LedgerRow, { type: "automation.missed" }>;
const firedEvents = (w: World, id: string): Fired[] => w.events.flatMap((e) => (e.type === "automation.event" && e.event.kind === "fired" && e.event.id === id ? [e.event] : []));
const missedEvents = (w: World, id: string): Extract<AutomationEvent, { kind: "missed" }>[] =>
  w.events.flatMap((e) => (e.type === "automation.event" && e.event.kind === "missed" && e.event.id === id ? [e.event] : []));
const failedProblems = (engine: Engine): Problem[] => engine.snapshot().problems.filter((p) => p.kind === "automation.failed");
const armedId = (r: unknown): string => {
  assert.equal((r as { kind: string }).kind, "armed", JSON.stringify(r));
  return (r as { automation: Automation }).automation.id;
};

/** A recipe shell whose exit code the test sets; every call is recorded. */
function scriptedShell(): { shell: ShellRunner; calls: string[]; code: { v: number } } {
  const calls: string[] = [];
  const code = { v: 1 };
  const shell = (async (o: { command: string }) => {
    calls.push(o.command);
    return { code: code.v, signal: null, stdout: "", stderr: code.v === 0 ? "" : "disk full", timedOut: false, cancelled: false, ms: 1 };
  }) as unknown as ShellRunner;
  return { shell, calls, code };
}

/** "backup" runs ~/bin/backup.sh nightly at 23:00, armed with the run-recipe chip on (Kevin said yes at set-up). */
function nightlyBackup(engine: Engine, clock: { t: number }): string {
  engine.updateSettings({ automations: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes: [{ name: "backup", command: "~/bin/backup.sh", timeoutSeconds: 120, approvedAt: clock.t }] } });
  tick(engine);
  return armedId(
    engine.automations.arm(
      { name: "backup", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "23:00" }, phrase: "daily 23:00" }, then: [{ kind: "run-recipe", recipe: "backup" }], clauses: { quiet: "respect" }, echo: "Nightly at 23:00, run recipe backup." } as never,
      "console",
      true,
    ),
  );
}

// ------------------------------------------------------------------------------------------------ SL-14

test("SL-14: a routine that only opens Notes fires with ring:false, and the engine puts no ring up", async () => {
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "notes", when: { kind: "at", at: clock.t + M }, then: [{ kind: "open", app: "Notes" }], clauses: { quiet: "respect" }, echo: "open Notes" } as never, "brain"));
    clock.t += M;
    tick(engine);
    await settle(80);
    engine.automations.table.flush();
    const fired = firedEvents(w, id);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.ok, true);
    assert.equal(fired[0]!.ring, false, `fired event: ${JSON.stringify(fired[0])}: the app would show it as a ring`);
    assert.equal(engine.snapshot().ringing, undefined, "the engine did not ring");
    assert.equal(engine.automations.table.get(id)!.state, "done");
  } finally {
    await engine.stop();
  }
});

test("SL-14: an alarm's chime fires with ring:true, and Snapshot.ringing names it", async () => {
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "wake", when: { kind: "at", at: clock.t + M }, then: [{ kind: "chime", line: "wake up" }], clauses: { quiet: "override" }, echo: "wake up" } as never, "brain"));
    clock.t += M;
    tick(engine);
    await settle(80);
    engine.automations.table.flush();
    const fired = firedEvents(w, id);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.ring, true);
    assert.equal(engine.snapshot().ringing?.id, id);
  } finally {
    await engine.stop();
  }
});

test("SL-14: a fire that failed is never a ring (ring:false), whatever its line", async () => {
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "notes", when: { kind: "at", at: clock.t + M }, then: [{ kind: "open", app: "Notes" }], clauses: { quiet: "respect" }, echo: "open Notes" } as never, "brain"));
    // The chip turned off after the row was armed: the fire fails at the step.
    engine.updateSettings({ automations: { ...DEFAULT_AUTOMATIONS, unattended: DEFAULT_AUTOMATIONS.unattended.filter((k) => k !== "open") } });
    clock.t += M;
    tick(engine);
    await settle(80);
    engine.automations.table.flush();
    const fired = firedEvents(w, id);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.ok, false);
    assert.equal(fired[0]!.ring, false);
    assert.equal(engine.snapshot().ringing, undefined);
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------------------------------------ SL-15

test("SL-15: a nightly recipe's red exit is on the island the next morning: automation.failed, Run now", async () => {
  const { shell, calls } = scriptedShell();
  const w = world({ automations: { exec, shell, shellGate: gate, home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 22, 0);
  try {
    await engine.start();
    const id = nightlyBackup(engine, clock);
    clock.t = local(2026, 9, 5, 23, 0);
    tick(engine);
    await settle(80);
    assert.equal(calls.length, 1, "the recipe ran at 23:00");
    clock.t = local(2026, 9, 6, 7, 30); // the morning (one tick gap: the Mac slept)
    tick(engine);
    await settle(60);
    const snap = engine.snapshot();
    const row = snap.automations.find((a) => a.id === id);
    assert.equal(row?.state, "armed", "the repeater re-armed for tonight");
    const problems = failedProblems(engine);
    assert.equal(problems.length, 1, `morning: problems=${JSON.stringify(snap.problems)}`);
    assert.equal(problems[0]!.text, "backup failed 23:00 · recipe backup exit 1 · disk full");
    assert.deepEqual(problems[0]!.remedy, { label: "Run now", command: { type: "automation.run", id } });
    assert.ok(!/—/.test(problems[0]!.text), "no em dash");
  } finally {
    await engine.stop();
  }
});

test("SL-15: a second red exit replaces the row's problem (one per row); the next ok fire clears it", async () => {
  const { shell, calls, code } = scriptedShell();
  const w = world({ automations: { exec, shell, shellGate: gate, home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 22, 0);
  try {
    await engine.start();
    nightlyBackup(engine, clock);
    for (const day of [5, 6]) {
      clock.t = local(2026, 9, day, 23, 0);
      tick(engine);
      await settle(60);
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(failedProblems(engine).map((p) => p.text), ["backup failed 23:00 · recipe backup exit 1 · disk full"], "the second night's failure stands alone");
    code.v = 0;
    clock.t = local(2026, 9, 7, 23, 0);
    tick(engine);
    await settle(60);
    assert.equal(calls.length, 3);
    assert.deepEqual(failedProblems(engine), [], "the ok fire cleared it");
  } finally {
    await engine.stop();
  }
});

test("SL-15: Run now that goes green clears the problem; Run now is Kevin's press, so its own red exit raises none", async () => {
  const { shell, calls, code } = scriptedShell();
  const w = world({ automations: { exec, shell, shellGate: gate, home: home() } });
  const { engine, clock, handsBg } = w;
  clock.t = local(2026, 9, 5, 22, 0);
  try {
    await engine.start();
    const id = nightlyBackup(engine, clock);
    clock.t = local(2026, 9, 5, 23, 0);
    tick(engine);
    await settle(60);
    assert.equal(failedProblems(engine).length, 1);
    // Morning: Kevin is at the Mac and presses Run now; the disk is still full.
    clock.t = local(2026, 9, 6, 7, 30);
    tick(engine);
    handsBg.kevinActed();
    await engine.command({ type: "automation.run", id });
    await until(() => calls.length === 2);
    assert.deepEqual(failedProblems(engine), [], "his press answers the problem; the toast says how it went");
    // He clears space and presses it again: green.
    code.v = 0;
    clock.t += 1000;
    handsBg.kevinActed();
    await engine.command({ type: "automation.run", id });
    await until(() => calls.length === 3);
    assert.deepEqual(failedProblems(engine), []);
    assert.equal(engine.automations.table.get(id)!.state, "armed");
  } finally {
    await engine.stop();
  }
});

test("SL-15: a failure a retry cannot fix (the chip is off) offers Open Console, not Run now", async () => {
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "standup", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "09:00" }, phrase: "daily 09:00" }, then: [{ kind: "open", app: "Zoom" }], clauses: { quiet: "respect" }, echo: "open Zoom" } as never, "brain"));
    engine.updateSettings({ automations: { ...DEFAULT_AUTOMATIONS, unattended: DEFAULT_AUTOMATIONS.unattended.filter((k) => k !== "open") } });
    clock.t = engine.automations.table.get(id)!.nextAt!;
    tick(engine);
    await settle(80);
    const problems = failedProblems(engine);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.text, /^standup failed \d\d:\d\d · open is off in Settings › Automations › While asleep$/);
    assert.deepEqual(problems[0]!.remedy, { label: "Open Console", command: { type: "open-console" } });
  } finally {
    await engine.stop();
  }
});

test("SL-15: a row moved to the Trash takes its problem with it", async () => {
  const { shell } = scriptedShell();
  const w = world({ automations: { exec, shell, shellGate: gate, home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 22, 0);
  try {
    await engine.start();
    const id = nightlyBackup(engine, clock);
    clock.t = local(2026, 9, 5, 23, 0);
    tick(engine);
    await settle(60);
    assert.equal(failedProblems(engine).length, 1);
    assert.equal(engine.automations.changeNow(id, "trash").ok, true);
    assert.deepEqual(failedProblems(engine), []);
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------------------------------- the zone why

test("zone: awake, the app's clock.changed reads a move east that put 07:10 behind now: missed zone-moved, the time zone moved", async () => {
  process.env.TZ = LA;
  let link = LA;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 5, 0); // Mon 05:00 Los Angeles, 08:00 in New York
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "Wake up", whenPhrase: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up", sound: "Hero" }], echo: "x" }, "console", true));
    link = NY;
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    await settle(40);
    assert.equal(process.env.TZ, NY);
    const missed = rows<MissedRow>(w, "automation.missed").filter((m) => m.id === id);
    assert.deepEqual(missed.map((m) => [m.dueAt, m.why]), [[local(2026, 9, 5, 7, 10), "zone-moved"]], "the ledger says why");
    engine.automations.table.flush();
    assert.deepEqual(missedEvents(w, id).map((e) => e.why), ["zone-moved"], "the stream entry's event says why");
    const problems = engine.snapshot().problems.filter((p) => p.kind === "automation.missed");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.text, /^missed Wake up 07:10 · the time zone moved$/);
    assert.match(engine.automations.table.get(id)!.lastDetail ?? "", /the time zone moved/);
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("zone: awake, the tick reads the same move: missed zone-moved", async () => {
  process.env.TZ = LA;
  let link = LA;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 5, 0);
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "Wake up", whenPhrase: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up", sound: "Hero" }], echo: "x" }, "console", true));
    link = NY;
    for (let i = 0; i < 61; i++) {
      clock.t += 1000;
      tick(engine);
    }
    await settle(40);
    const missed = rows<MissedRow>(w, "automation.missed").filter((m) => m.id === id);
    assert.deepEqual(missed.map((m) => m.why), ["zone-moved"]);
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("zone: the lid closed over the alarm and the Mac flew east: the Mac slept through it in either zone, so the why stays mac-slept", async () => {
  process.env.TZ = LA;
  let link = LA;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 6, 0); // Mon 06:00 Los Angeles
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "Wake up", whenPhrase: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up", sound: "Hero" }], echo: "x" }, "console", true));
    engine.systemSignal({ kind: "mac.sleep" }, clock.t + M);
    clock.t = local(2026, 9, 5, 9, 0); // 12:00 in New York, where the lid opens
    link = NY;
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    engine.systemSignal({ kind: "mac.wake" }, clock.t);
    await settle(60);
    const missed = rows<MissedRow>(w, "automation.missed").filter((m) => m.id === id);
    assert.deepEqual(missed.map((m) => m.why), ["mac-slept"]);
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});
