import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockOf } from "@jarhead/core";
import { AUTOMATION_LINGER_MS, DEFAULT_AUTOMATIONS, type Automation, type AutomationSettings, type LedgerRow } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import type { AutomationExec, AutomationSetInput, ShellGate, ShellRunner } from "../automations/index.ts";
import { rows, settle, until, world, type World } from "./world.ts";

/**
 * Automations (design11): set while awake, carried out by the daemon while ASLEEP —
 * from `tick()` and the app's signals, with no Live session, no brain turn and nothing
 * billed, except `wake-brain`, one headless turn behind its budget. Every case here runs
 * over the world() harness with the clock moved by hand and `tick()` called by hand:
 * nothing waits on real time except the fire's own await.
 */

const M = 60_000;
const H = 60 * M;
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
type FiredRow = Extract<LedgerRow, { type: "automation.fired" }>;
type MissedRow = Extract<LedgerRow, { type: "automation.missed" }>;
type StateRow = Extract<LedgerRow, { type: "automation.state" }>;

/** The processes a fire starts, recorded and never run. */
function fakeExec(): { exec: AutomationExec; runs: string[][]; holds: { argv: string[]; killed: boolean }[] } {
  const runs: string[][] = [];
  const holds: { argv: string[]; killed: boolean }[] = [];
  return {
    runs,
    holds,
    exec: {
      run: async (file, argv) => {
        runs.push([file, ...argv]);
        return { code: 0 };
      },
      hold: (file, argv) => {
        const h = { argv: [file, ...argv], killed: false };
        holds.push(h);
        return { kill: () => (h.killed = true) };
      },
    },
  };
}

/** A shell that records and answers a scripted exit. */
function fakeShell(code = 0, stdout = "ok"): { shell: ShellRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    shell: async (o) => {
      calls.push(o.command);
      return { code, signal: null, stdout, stderr: "", timedOut: false, cancelled: false, ms: 1 };
    },
  };
}

function alarm(name: string, at: number, line = "Wake up, Kevin"): AutomationSetInput {
  return { name, when: { kind: "at", at }, then: [{ kind: "chime", line, sound: "Hero" }], clauses: { quiet: "override" }, echo: `At ${clockOf(at)}, ring "${line}".` };
}

function reminder(name: string, at: number, line: string, quiet: "respect" | "override" = "respect"): AutomationSetInput {
  return { name, when: { kind: "at", at }, then: [{ kind: "say", line }], clauses: { quiet }, echo: `At ${clockOf(at)}, say "${line}".` };
}

function openAt(name: string, at: number, app = "Notes", quiet: "respect" | "override" = "respect"): AutomationSetInput {
  return { name, when: { kind: "at", at }, then: [{ kind: "open", app }], clauses: { quiet }, echo: `At ${clockOf(at)}, open ${app}.` };
}

async function fired(w: World, n = 1): Promise<FiredRow[]> {
  await until(() => rows<FiredRow>(w, "automation.fired").length >= n, 1500);
  return rows<FiredRow>(w, "automation.fired");
}

function armed(w: World, r: ReturnType<Engine["automations"]["arm"]>): Automation {
  assert.equal(r.kind, "armed", JSON.stringify(r));
  return (r as { automation: Automation }).automation;
}

function automations(w: World, patch: Partial<AutomationSettings>): void {
  w.engine.updateSettings({ automations: { ...DEFAULT_AUTOMATIONS, ...patch } });
}

// (1) alarm-fires-asleep
test("alarm-fires-asleep: an alarm armed for +2 h rings when the clock gets there — one automation.fired row, Snapshot.ringing, one local.say and one notify; no session.started, phase asleep, the Live stand-in never opened", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events, live, lives } = w;
  try {
    await engine.start();
    const t0 = clock.t;
    const a = armed(w, engine.automations.arm(alarm("Wake up", t0 + 2 * H), "brain", false, { request: "wake me in two hours" }));
    assert.equal(a.state, "armed");
    assert.equal(a.nextAt, t0 + 2 * H);
    assert.equal(a.clauses.quiet, "override", "alarms default override");
    assert.match((engine.automations.arm(alarm("Wake up", t0 + 3 * H), "brain") as { reason: string }).reason, /already set/, "names are unique");
    assert.equal(engine.snapshot().automations.length, 1);
    assert.deepEqual(engine.snapshot().nextFire, { id: a.id, kind: "alarm", name: "Wake up", at: t0 + 2 * H });
    assert.equal(rows(w, "automation.set").length, 1);
    events.length = 0;

    clock.t += 2 * H;
    tick(engine);
    const f = await fired(w);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.ok, true);
    assert.deepEqual(f[0]!.actions, ["chime"]);
    assert.equal(f[0]!.line, `${clockOf(t0 + 2 * H)} · Wake up`);
    assert.equal(f[0]!.lateMs, undefined, "on time");
    const snap = engine.snapshot();
    assert.equal(snap.ringing?.id, a.id);
    assert.equal(snap.ringing?.line, `${clockOf(t0 + 2 * H)} · Wake up`);
    assert.equal(snap.ringing?.kind, "alarm");
    assert.deepEqual(snap.ringing?.presses, [{ kind: "snooze", minutes: 10 }, { kind: "done" }]);
    assert.equal(snap.ringing?.more, 0);
    assert.equal(snap.automations[0]?.state, "fired");
    assert.equal(snap.automations[0]?.fires, 1);
    const says = events.filter((e) => e.type === "local.say");
    assert.equal(says.length, 1);
    assert.deepEqual(says[0], { type: "local.say", sound: "Hero", automationId: a.id });
    const notes = events.filter((e) => e.type === "notify");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.type === "notify" && notes[0]!.automationId, a.id);
    engine.automations.table.flush();
    const evs = events.filter((e) => e.type === "automation.event").map((e) => (e.type === "automation.event" ? e.event : undefined)!);
    assert.ok(evs.some((e) => e.kind === "fired" && e.id === a.id && e.presses.length === 2), "one fired event with its presses");
    // The rails: nothing opened a session, nothing was billed.
    assert.equal(rows(w, "session.started").length, 0);
    assert.equal(snap.phase, "asleep");
    assert.equal(snap.session, undefined);
    assert.equal(snap.usageToday?.sessions, 0);
    assert.equal(live.currentState, "idle", "the FakeLive the harness holds was never started");
    assert.equal(lives.length, 1);
    assert.equal(events.filter((e) => e.type === "toast").length, 0, "a fire is not a toast");
  } finally {
    await engine.stop();
  }
});

// (2) alarm-snooze-done + skip
test("alarm-snooze-done: Snooze moves the ring to snoozedUntil (state row with until), it rings again there, Done ends a one-shot; skip rolls a repeater's next occurrence and ends a one-shot without firing", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  try {
    await engine.start();
    const t0 = clock.t;
    const a = armed(w, engine.automations.arm(alarm("Wake up", t0 + M), "brain"));
    clock.t += M;
    tick(engine);
    await fired(w);
    assert.equal(engine.snapshot().ringing?.id, a.id);

    await engine.command({ type: "automation.snooze", id: a.id, minutes: 10 });
    let row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "snoozed");
    assert.equal(row.snoozedUntil, clock.t + 10 * M);
    assert.equal(row.nextAt, clock.t + 10 * M);
    assert.equal(engine.snapshot().ringing, undefined, "the line leaves");
    const snoozeRow = rows<StateRow>(w, "automation.state").find((r) => r.state === "snoozed")!;
    assert.equal(snoozeRow.by, "kevin");
    assert.equal(snoozeRow.until, clock.t + 10 * M);

    clock.t += 10 * M;
    tick(engine);
    await fired(w, 2);
    assert.equal(engine.snapshot().ringing?.id, a.id, "rings again at snoozedUntil");
    await engine.command({ type: "automation.done", id: a.id });
    row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "done");
    assert.equal(row.nextAt, undefined);
    assert.equal(engine.snapshot().ringing, undefined);
    assert.equal(engine.snapshot().nextFire, undefined);

    // skip: a weekday routine rolls to the next weekday; a one-shot ends "skipped" without a fire.
    const routine = armed(w, engine.automations.arm({ name: "standup notes", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "09:00" }, phrase: "daily 09:00" }, then: [{ kind: "open", app: "Notes" }], echo: "Daily at 09:00, open Notes." }, "brain"));
    const first = routine.nextAt!;
    await engine.command({ type: "automation.skip", id: routine.id });
    const rolled = engine.snapshot().automations.find((x) => x.id === routine.id)!;
    assert.equal(rolled.state, "armed");
    assert.equal(rolled.nextAt, first + 24 * H);
    assert.equal(rolled.lastDetail?.startsWith("skipped"), true);
    const once = armed(w, engine.automations.arm(reminder("call mum", clock.t + H, "call mum"), "brain"));
    await engine.command({ type: "automation.skip", id: once.id });
    assert.equal(engine.snapshot().automations.find((x) => x.id === once.id)?.state, "done");
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 2, "skips fire nothing");
  } finally {
    await engine.stop();
  }
});

// (3) alarm-linger-self-snooze
test("alarm-linger-self-snooze: an unanswered alarm self-snoozes ONCE after the linger (by engine, 'unanswered · snoozed once'), rings again, and the second linger ends it 'unanswered'; it re-chimes every 30 s meanwhile", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    const a = armed(w, engine.automations.arm(alarm("Wake up", clock.t + M), "brain"));
    clock.t += M;
    tick(engine);
    await fired(w);
    events.length = 0;
    clock.t += 30_000;
    tick(engine);
    assert.equal(events.filter((e) => e.type === "local.say").length, 1, "re-chimed at 30 s");
    clock.t += AUTOMATION_LINGER_MS;
    tick(engine);
    let row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "snoozed");
    assert.equal(row.lastDetail, "unanswered · snoozed once");
    assert.equal(row.snoozedUntil, clock.t + 10 * M);
    const selfSnooze = rows<StateRow>(w, "automation.state").find((r) => r.state === "snoozed")!;
    assert.equal(selfSnooze.by, "engine");
    clock.t += 10 * M;
    tick(engine);
    await fired(w, 2);
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "fired");
    clock.t += AUTOMATION_LINGER_MS;
    tick(engine);
    row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "done");
    assert.equal(row.lastDetail, "unanswered");
    assert.equal(engine.snapshot().ringing, undefined);
  } finally {
    await engine.stop();
  }
});

// (4) weekly-walk
test("weekly-walk: a weekdays 09:00 routine walked over nine days fires Monday to Friday and the next Monday and Tuesday — seven opens, none at the weekend", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, hands } = w;
  // Monday 14 Sep 2026, 08:00 local.
  clock.t = new Date(2026, 8, 14, 8, 0, 0).getTime();
  try {
    await engine.start();
    const a = armed(w, engine.automations.arm({ name: "standup notes", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "09:00" }, phrase: "weekdays 09:00" }, then: [{ kind: "open", app: "Notes" }], echo: "Weekdays at 09:00, open Notes." }, "brain"));
    assert.equal(a.nextAt, new Date(2026, 8, 14, 9, 0, 0).getTime());
    const firedOn: number[] = [];
    for (let day = 0; day < 9; day++) {
      clock.t = new Date(2026, 8, 14 + day, 9, 0, 0).getTime();
      tick(engine);
      await settle(40);
      const n = hands.named("open_app").length;
      if (n > firedOn.length) firedOn.push(new Date(clock.t).getDay());
      assert.equal(n, firedOn.length);
    }
    assert.deepEqual(firedOn, [1, 2, 3, 4, 5, 1, 2], "Mon–Fri, then Mon, Tue");
    // The rows sit in nine day files: read each day.
    const across = (type: string): LedgerRow[] => Array.from({ length: 9 }, (_, day) => engine.ledger.read(new Date(2026, 8, 14 + day, 12, 0, 0).getTime())).flat().filter((r) => r.type === type);
    assert.equal(across("automation.fired").length, 7);
    assert.equal(across("automation.missed").length, 0, "a fire exactly on time is never late");
    const row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "armed");
    assert.equal(row.fires, 7);
    assert.equal(row.nextAt, new Date(2026, 8, 23, 9, 0, 0).getTime());
  } finally {
    await engine.stop();
  }
});

// (5) mac-slept-gap
test("mac-slept-gap: the clock jumps two hours — an alarm due at +10 min is missed {why: mac-slept} with ONE problem carrying Run now; one due at +1 h 50 fires with lateMs inside its grace", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const t0 = clock.t;
    const early = armed(w, engine.automations.arm(alarm("early", t0 + 10 * M), "brain"));
    const late = armed(w, engine.automations.arm(alarm("late", t0 + 110 * M), "brain"));
    clock.t += 2 * H;
    tick(engine);
    const f = await fired(w);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.id, late.id);
    assert.equal(f[0]!.lateMs, 10 * M);
    assert.equal(engine.snapshot().ringing?.lateMs, 10 * M);
    const missed = rows<MissedRow>(w, "automation.missed");
    assert.equal(missed.length, 1);
    assert.equal(missed[0]!.id, early.id);
    assert.equal(missed[0]!.why, "mac-slept");
    assert.equal(missed[0]!.dueAt, t0 + 10 * M);
    assert.equal(missed[0]!.skipped, undefined);
    const row = engine.snapshot().automations.find((x) => x.id === early.id)!;
    assert.equal(row.state, "failed");
    assert.equal(row.missed, 1);
    assert.match(row.lastDetail ?? "", /^missed .* · the Mac slept$/);
    const problems = engine.snapshot().problems.filter((p) => p.kind === "automation.missed");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.text, /missed early .* · the Mac slept/);
    assert.deepEqual(problems[0]!.remedy, { label: "Run now", command: { type: "automation.run", id: early.id } });
  } finally {
    await engine.stop();
  }
});

// (6) routine-never-late
test("routine-never-late: an every-2-h routine whose slot passed by five minutes while the Mac slept is skipped — a missed {skipped} row, missed 1, the next slot armed, nothing opened", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, hands } = w;
  try {
    await engine.start();
    tick(engine);
    const t0 = clock.t;
    const a = armed(w, engine.automations.arm({ name: "backup", when: { kind: "every", every: { kind: "interval", everyMs: 2 * H, anchorAt: t0 }, phrase: "every 2 h" }, then: [{ kind: "open", app: "Notes" }], echo: "Every 2 h, open Notes." }, "brain"));
    assert.equal(a.nextAt, t0 + 2 * H);
    clock.t += 2 * H + 5 * M;
    tick(engine);
    await settle(30);
    assert.equal(hands.named("open_app").length, 0, "never a late run");
    const missed = rows<MissedRow>(w, "automation.missed");
    assert.equal(missed.length, 1);
    assert.equal(missed[0]!.skipped, true);
    assert.equal(missed[0]!.why, "mac-slept");
    const row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "armed");
    assert.equal(row.missed, 1);
    assert.equal(row.nextAt, t0 + 4 * H);
    assert.equal(engine.snapshot().problems.filter((p) => p.kind === "automation.missed").length, 0, "a skipped routine is a row, not a problem");
  } finally {
    await engine.stop();
  }
});

// (7) quiet-hours-respect-override
test("quiet-hours-respect-override: inside quiet hours a `respect` say is a silent banner ('quiet hours: shown, not said'), an `open` is deferred to the quiet end and runs there, an `override` alarm rings", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events, hands } = w;
  clock.t = new Date(2026, 8, 14, 23, 0, 0).getTime();
  try {
    await engine.start();
    automations(w, { quietHours: { from: "22:00", to: "07:00" } });
    const t0 = clock.t;
    const say = armed(w, engine.automations.arm(reminder("call mum", t0 + M, "call mum"), "brain"));
    const open = armed(w, engine.automations.arm(openAt("notes", t0 + M), "brain"));
    const ring = armed(w, engine.automations.arm(alarm("Wake up", t0 + M), "brain"));
    events.length = 0;
    clock.t += M;
    tick(engine);
    const f = await fired(w, 2);
    assert.deepEqual(f.map((r) => r.id).sort(), [say.id, ring.id].sort());
    const said = events.filter((e) => e.type === "local.say");
    assert.equal(said.length, 1, "only the override alarm sounds");
    assert.equal(said[0]!.type === "local.say" && said[0]!.automationId, ring.id);
    assert.equal(events.filter((e) => e.type === "notify").length, 2, "both rings post a banner");
    const sayRow = engine.snapshot().automations.find((x) => x.id === say.id)!;
    assert.equal(sayRow.state, "fired");
    assert.match(sayRow.lastDetail ?? "", /quiet hours: shown, not said/);
    const openRow = engine.snapshot().automations.find((x) => x.id === open.id)!;
    assert.equal(openRow.state, "deferred");
    assert.equal(openRow.nextAt, new Date(2026, 8, 15, 7, 0, 0).getTime());
    assert.equal(openRow.lastDetail, "deferred to 07:00");
    assert.equal(hands.named("open_app").length, 0);
    clock.t = new Date(2026, 8, 15, 7, 0, 0).getTime();
    tick(engine);
    await fired(w, 3);
    assert.equal(hands.named("open_app").length, 1, "the deferred open runs at the quiet end");
    assert.equal(engine.snapshot().automations.find((x) => x.id === open.id)?.state, "done");
  } finally {
    await engine.stop();
  }
});

// (8) confirm-at-fire-never
test("confirm-at-fire-never: a recipe approved at set-up whose shell gate says `confirm` at fire is a failed row ('would need a yes; nobody to ask') — the shell never runs, no question is asked anywhere", async () => {
  const { exec } = fakeExec();
  const sh = fakeShell();
  const shellGate: ShellGate = () => ({ verdict: "confirm", reason: "the policy tightened since; ask first" });
  const w = world({ automations: { exec, shell: sh.shell, shellGate } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes: [{ name: "backup", command: "echo hi", timeoutSeconds: 5, approvedAt: clock.t }] });
    const draft: AutomationSetInput = { name: "nightly backup", when: { kind: "at", at: clock.t + M }, then: [{ kind: "run-recipe", recipe: "backup" }], echo: "In a minute, run recipe backup." };
    const first = engine.automations.arm(draft, "brain", false);
    assert.equal(first.kind, "confirm", "the set-up asks once");
    assert.match((first as { question: string }).question, /recipe backup .* unattended/);
    const a = armed(w, engine.automations.arm(draft, "brain", true));
    assert.equal(a.confirmed?.heard, (first as { question: string }).question, "the yes records what Kevin heard");
    events.length = 0;
    clock.t += M;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.ok, false);
    assert.match(f[0]!.detail ?? "", /would need a yes; nobody to ask/);
    assert.equal(sh.calls.length, 0, "the shell never ran");
    const row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "failed");
    assert.equal(events.some((e) => JSON.stringify(e).includes("needs-confirmation") || JSON.stringify(e).includes("needs_confirmation")), false, "no question event");
    assert.equal(rows(w, "grant").length, 0);
    assert.equal(engine.snapshot().threads.some((t) => t.question !== undefined), false);
  } finally {
    await engine.stop();
  }
});

// (9) press-not-in-front
test("press-not-in-front: a press with another app in front fails ('Cursor is not in front (Notes is)') and the hands record no key; with Cursor in front and no secure field the key lands with expectFront; a secure field fails", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, hands } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "press"] });
    const draft = (name: string, at: number): AutomationSetInput => ({ name, when: { kind: "at", at }, then: [{ kind: "press", app: "Cursor", key: "cmd+s" }], echo: "Press cmd+s in Cursor." });
    const a = armed(w, engine.automations.arm(draft("save", clock.t + M), "brain", true));
    hands.frontApp = "Notes";
    clock.t += M;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.ok, false);
    assert.equal(f[0]!.detail, "Cursor is not in front (Notes is)");
    assert.equal(hands.named("key").length, 0);
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "failed");

    hands.frontApp = "Cursor";
    armed(w, engine.automations.arm(draft("save again", clock.t + M), "brain", true));
    clock.t += M;
    tick(engine);
    const g = await fired(w, 2);
    assert.equal(g[1]!.ok, true);
    assert.equal(g[1]!.line, "save again · pressed cmd+s in Cursor");
    assert.equal(hands.named("key").length, 1);
    assert.deepEqual(hands.named("key")[0]!.params, { combo: "cmd+s", repeat: 1, expectFront: { pid: 1 } });

    hands.secure = true;
    armed(w, engine.automations.arm(draft("save thrice", clock.t + M), "brain", true));
    clock.t += M;
    tick(engine);
    const h = await fired(w, 3);
    assert.equal(h[2]!.detail, "a password field has focus");
    assert.equal(hands.named("key").length, 1, "nothing pressed into a password field");

    // The combo is re-read at fire: a row an older journal armed with cmd+shift+delete never reaches the hands.
    hands.secure = false;
    const refused = engine.automations.arm({ ...draft("empty trash", clock.t + M), then: [{ kind: "press", app: "Finder", key: "cmd+shift+delete" }] }, "brain", true);
    assert.equal(refused.kind, "refused", "set-up refuses the combo even with the yes");
    const old = await (engine.automations.executor as unknown as { press(action: { kind: "press"; app: string; key: string }): Promise<{ ok: boolean; detail?: string }> }).press({ kind: "press", app: "Cursor", key: "cmd+shift+delete" });
    assert.equal(old.ok, false);
    assert.match(old.detail ?? "", /never pressed unattended/);
    assert.equal(hands.named("key").length, 1, "the hands saw no delete");
  } finally {
    await engine.stop();
  }
});

// (10) folder-file-settle-no-overwrite + folder-burst-cooldown
test("folder-file-settle-no-overwrite: a partial never counts; a PDF that settles fires once and is filed (a clash takes ' (2)', nothing unlinked); five files inside the cooldown are one fire and '+4 in cooldown'", async () => {
  const home = mkdtempSync(join(tmpdir(), "jh-auto-home-"));
  const downloads = join(home, "Downloads");
  const papers = join(home, "Papers");
  mkdirSync(downloads);
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home } });
  const { engine, clock, events } = w;
  const files = (): string[] => [...(existsSync(downloads) ? readdirSync(downloads) : []), ...(existsSync(papers) ? readdirSync(papers) : [])].sort();
  const step = (): void => {
    clock.t += 5_000;
    tick(engine);
  };
  try {
    await engine.start();
    writeFileSync(join(downloads, "old.pdf"), "already here");
    const a = armed(w, engine.automations.arm({ name: "file papers", when: { kind: "on", on: { kind: "folder.file", path: downloads, glob: "*.pdf", settleMs: 12_000 } }, then: [{ kind: "file", into: papers }, { kind: "chime", line: "filed", sound: "Glass" }], clauses: { quiet: "respect", cooldown: 0 }, echo: "When a PDF lands in Downloads, file it under Papers and chime." }, "brain", false, { request: `when a pdf lands in ${downloads} file it under ${papers}` }));
    assert.equal(a.state, "armed");
    assert.equal(a.nextAt, undefined, "a watcher has no clock");
    assert.equal(engine.automations.watchers.folderCount, 1);
    writeFileSync(join(downloads, "a.crdownload"), "partial");
    step();
    step();
    renameSync(join(downloads, "a.crdownload"), join(downloads, "a.pdf"));
    step(); // first sighting
    step(); // 5 s: inside the 12 s settle
    step(); // 10 s: still inside
    await settle(30);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 0, "nothing until it settles");
    assert.ok(existsSync(join(downloads, "a.pdf")));
    step(); // 15 s: settled
    const f = await fired(w);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.ok, true);
    assert.deepEqual(f[0]!.actions, ["file", "chime"]);
    assert.equal(f[0]!.line, "file papers · filed a.pdf → Papers");
    assert.ok(existsSync(join(papers, "a.pdf")));
    assert.ok(!existsSync(join(downloads, "a.pdf")));
    assert.ok(existsSync(join(downloads, "old.pdf")), "what was there at arm never fires or moves");
    assert.deepEqual(engine.snapshot().ringing?.presses, [{ kind: "open", target: join(papers, "a.pdf") }, { kind: "done" }]);
    assert.equal(events.filter((e) => e.type === "local.say" && e.sound === "Glass").length, 1);
    await engine.command({ type: "automation.done", id: a.id });
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "armed", "a watcher re-arms after Done");

    // A second a.pdf lands: the filed one is never overwritten.
    const before = files();
    writeFileSync(join(downloads, "a.pdf"), "second");
    step();
    step();
    step();
    step();
    const g = await fired(w, 2);
    assert.match(g[1]!.line, /filed a\.pdf → Papers as a \(2\)\.pdf/);
    assert.ok(existsSync(join(papers, "a.pdf")));
    assert.ok(existsSync(join(papers, "a (2).pdf")));
    assert.equal(readFileSync(join(papers, "a.pdf"), "utf8"), "partial", "the first file is untouched");
    assert.equal(readFileSync(join(papers, "a (2).pdf"), "utf8"), "second");
    assert.equal(files().length, before.length + 1, "the new file moved, nothing unlinked");
    await engine.command({ type: "automation.done", id: a.id });

    // A burst under the default cooldown: one fire, the rest counted.
    const inbox = join(home, "Inbox");
    mkdirSync(inbox);
    const b = armed(w, engine.automations.arm({ name: "inbox chime", when: { kind: "on", on: { kind: "folder.file", path: inbox, settleMs: 1_000 } }, then: [{ kind: "chime", line: "landed" }], clauses: { quiet: "respect" }, echo: "When a file lands in Inbox, chime." }, "brain"));
    for (let i = 0; i < 5; i++) writeFileSync(join(inbox, `f${i}.txt`), `${i}`);
    step();
    step();
    await fired(w, 3);
    await settle(30);
    assert.equal(rows<FiredRow>(w, "automation.fired").filter((r) => r.id === b.id).length, 1, "one fire for the burst");
    const row = engine.snapshot().automations.find((x) => x.id === b.id)!;
    assert.match(row.lastDetail ?? "", /\+4 in cooldown$/);
  } finally {
    await engine.stop();
  }
});

// (11) signal-app-quit
test("signal-app-quit: system.signal {app.quit Slack} fires the rule (the local speaker reads the line); a second quit inside the 30 s cooldown is counted, not fired; a signal for another app does nothing", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    const a = armed(w, engine.automations.arm({ name: "log hours", when: { kind: "on", on: { kind: "app.quit", app: "Slack" } }, then: [{ kind: "say", line: "log your hours" }], echo: "When Slack quits, say 'log your hours'." }, "brain"));
    engine.systemSignal({ kind: "app.quit", app: "Figma" }, clock.t);
    engine.systemSignal({ kind: "app.quit", app: "slack" }, clock.t);
    const f = await fired(w);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.id, a.id);
    assert.deepEqual(events.filter((e) => e.type === "local.say"), [{ type: "local.say", text: "log your hours", automationId: a.id }]);
    await engine.command({ type: "automation.done", id: a.id });
    clock.t += 10_000;
    engine.systemSignal({ kind: "app.quit", app: "Slack" }, clock.t);
    await settle(30);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 1, "inside the cooldown");
    assert.match(engine.snapshot().automations.find((x) => x.id === a.id)?.lastDetail ?? "", /\+1 in cooldown$/);
    clock.t += 30_000;
    engine.systemSignal({ kind: "app.quit", app: "Slack" }, clock.t);
    await fired(w, 2);
    // Evidence signals are data: mac.sleep stamps nothing but sleptAt, and no command reaches the engine.
    engine.systemSignal({ kind: "mac.sleep" }, clock.t);
    engine.systemSignal({ kind: "screen.lock" }, clock.t);
    assert.equal(engine.snapshot().phase, "asleep");
    assert.equal(rows(w, "session.started").length, 0);
  } finally {
    await engine.stop();
  }
});

// (12) wake-brain-headless-no-session · wake-brain-needs-confirmation-cancelled · wake-brain-budget
test("wake-brain-headless-no-session: a wake-brain fire runs ONE headless turn on a background-lane brain — delegation.created {origin, liveId ''}, the summary's first sentence spoken, brainSeconds counted, no session, no connect; a needs-confirmation step cancels it; a spent budget refuses", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events, threads, live } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"], wakeBudgetMinutesPerDay: 5 });
    threads.script = async () => ({ status: "done", summary: "Two agents finished. Both are green." });
    const draft = (name: string, at: number, seconds = 60): AutomationSetInput => ({ name, when: { kind: "at", at }, then: [{ kind: "wake-brain", prompt: "summarise what my agents did today", budget: { steps: 5, seconds }, speak: true }], echo: "Wake the brain: summarise the agents." });
    const asked = engine.automations.arm(draft("rundown", clock.t + M), "brain", false);
    assert.equal(asked.kind, "confirm");
    assert.match((asked as { question: string }).question, /about 1 brain minute per fire on Kevin's plan, up to 5 a day/, "the cost line is the question");
    const a = armed(w, engine.automations.arm(draft("rundown", clock.t + M), "brain", true));
    events.length = 0;
    tick(engine); // the scheduler's own tick tops the (never yet closed) pool up; from here the fire must add no boot
    const bootsBefore = engine.threads.pool.boots;
    const madeBefore = threads.brains.length;
    clock.t += M;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.ok, true, f[0]!.detail);
    assert.ok((f[0]!.brainSeconds ?? 0) >= 1, "brain seconds counted");
    assert.ok(f[0]!.delegationId, "the turn has a record");
    assert.equal(f[0]!.line, "rundown · Two agents finished.");
    const created = rows<Extract<LedgerRow, { type: "delegation.created" }>>(w, "delegation.created");
    assert.equal(created.length, 1);
    assert.equal(created[0]!.delegation.liveId, "");
    assert.deepEqual(created[0]!.delegation.origin, { automationId: a.id });
    assert.equal(created[0]!.delegation.request, "summarise what my agents did today");
    assert.equal(rows(w, "delegation.finished").length, 1);
    const brain = threads.brains.find((b) => b.tasks.length > 0)!;
    assert.ok(brain, "a thread brain took the turn");
    assert.equal(brain.tasks[0]!.thread?.lane, "background");
    assert.match(brain.tasks[0]!.notes?.join(" ") ?? "", /headless/);
    assert.ok(brain.stops >= 1, "its process was stopped after the turn");
    assert.deepEqual(events.filter((e) => e.type === "local.say"), [{ type: "local.say", text: "Two agents finished.", automationId: a.id }]);
    assert.equal(events.filter((e) => e.type === "notify").length, 1);
    assert.equal(engine.automations.brainSecondsToday, f[0]!.brainSeconds);
    // The rails: no session, nothing billed, the pool closed again.
    assert.equal(rows(w, "session.started").length, 0);
    assert.equal(engine.snapshot().usageToday?.sessions, 0);
    assert.equal(engine.snapshot().phase, "asleep");
    assert.equal(live.currentState, "idle", "connect() was never called");
    assert.equal(engine.threads.pool.isClosed, true);
    assert.equal(engine.threads.pool.boots, bootsBefore, "no spare booted for the headless turn: one cold lane, never Settings.warmThreads");
    assert.equal(threads.brains.length, madeBefore + 1, "exactly one brain process was made for the turn");
    assert.deepEqual(engine.threads.pool.spareIds, [], "nothing left running: the pool's spares were stopped after the turn");
    assert.ok(threads.brains.every((b) => b.stops >= 1), "every thread brain process is stopped, the turn's included");

    // A turn that asks: cancelled, failed "asked a question; nobody to answer" — no question anywhere.
    threads.script = async ({ sink }) => {
      sink.step({ kind: "confirm", text: "Send the summary to Ben?" });
      return undefined;
    };
    const b = armed(w, engine.automations.arm(draft("asker", clock.t + M), "brain", true));
    clock.t += M;
    tick(engine);
    const g = await fired(w, 2);
    assert.equal(g[1]!.id, b.id);
    assert.equal(g[1]!.ok, false);
    assert.equal(g[1]!.detail, "asked a question; nobody to answer");
    assert.equal(engine.snapshot().automations.find((x) => x.id === b.id)?.state, "failed");
    const finished = rows<Extract<LedgerRow, { type: "delegation.finished" }>>(w, "delegation.finished");
    assert.equal(finished[1]!.status, "cancelled");

    // The budget: one minute a day, a two-minute turn — refused before any brain runs.
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"], wakeBudgetMinutesPerDay: 1 });
    threads.script = async () => ({ status: "done", summary: "never reached" });
    const brainsBefore = threads.brains.filter((x) => x.tasks.length > 0).length;
    const c = armed(w, engine.automations.arm(draft("greedy", clock.t + M, 120), "brain", true));
    clock.t += M;
    tick(engine);
    const h = await fired(w, 3);
    assert.equal(h[2]!.id, c.id);
    assert.equal(h[2]!.detail, "budget");
    assert.equal(threads.brains.filter((x) => x.tasks.length > 0).length, brainsBefore, "no turn ran");
    assert.ok(engine.snapshot().problems.some((p) => p.kind === "automation.budget"));
  } finally {
    await engine.stop();
  }
});

// (13) awake-delivery-appendInstructions
test("awake-delivery-appendInstructions: with a session open a fire is one instruction to Live (say the line once, with its name) and no local.say; the island line still shows; a chime and a say on one row are still one instruction", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const a = armed(w, engine.automations.arm(reminder("call mum", clock.t + M, "call mum"), "brain"));
    live.instructions.length = 0;
    events.length = 0;
    clock.t += M;
    tick(engine);
    await fired(w);
    assert.deepEqual(live.instructions, ["Kevin's call mum fired: say 'call mum' once, with its name, and nothing more."]);
    assert.equal(events.filter((e) => e.type === "local.say").length, 0, "the speaker stays quiet while the voice is up");
    assert.equal(engine.snapshot().ringing?.id, a.id);
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.lastDetail, "said by the voice");

    // A chime AND a say on one row: Live is told ONCE for the fire, with both lines, never twice.
    const both = armed(w, engine.automations.arm({ name: "standup", when: { kind: "at", at: clock.t + M }, then: [{ kind: "chime", line: "Standup", sound: "Ping" }, { kind: "say", line: "standup in five" }], clauses: { quiet: "override" }, echo: "In a minute, chime and say standup." }, "brain"));
    live.instructions.length = 0;
    clock.t += M;
    tick(engine);
    await fired(w, 2);
    assert.equal(live.instructions.length, 1, "one instruction per fire, not one per line kind");
    assert.equal(live.instructions[0], "Kevin's standup fired: say 'Standup; standup in five' once, with its name, and nothing more.");
    assert.equal(engine.snapshot().automations.find((x) => x.id === both.id)?.state, "fired");
  } finally {
    await engine.stop();
  }
});

// (14) trash-restore-journal-grows
test("trash-restore-journal-grows: Move to Trash moves the row into the snapshot's Trash tail and frees its name, the journal keeps every line and only grows; Restore arms it again with a fresh nextAt; nothing is ever deleted", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  try {
    await engine.start();
    const journal = engine.automations.table.journalPath;
    const a = armed(w, engine.automations.arm({ name: "standup notes", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "09:00" }, phrase: "weekdays 09:00" }, then: [{ kind: "open", app: "Notes" }], echo: "Weekdays at 09:00, open Notes." }, "brain"));
    const lines = (): string[] => readFileSync(journal, "utf8").split("\n").filter(Boolean);
    assert.equal(lines().length, 1);
    await engine.command({ type: "automation.trash", id: a.id });
    assert.deepEqual(engine.snapshot().automations.map((x) => x.state), ["trashed"], "off the rails, in the snapshot's Trash tail for the fold");
    assert.equal(engine.snapshot().nextFire, undefined);
    assert.equal(lines().length, 2, "the journal grew by one full row");
    assert.equal(JSON.parse(lines()[1]!).state, "trashed");
    assert.equal(engine.automations.table.get(a.id)?.state, "trashed", "kept for Restore");
    assert.equal(rows<StateRow>(w, "automation.state").at(-1)?.state, "trashed");
    // The name is free while it sits in the Trash.
    armed(w, engine.automations.arm({ name: "standup notes", when: { kind: "at", at: clock.t + H }, then: [{ kind: "chime", line: "standup" }], echo: "In an hour, chime." }, "brain"));
    const clash = await engine.automations.change(a.id, "restore");
    assert.equal(clash.ok, false, "restore refuses while another row wears the name");
    await engine.command({ type: "automation.trash", id: engine.snapshot().automations[0]!.id });
    clock.t += 3 * H;
    await engine.command({ type: "automation.restore", id: a.id });
    const back = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(back.state, "armed");
    assert.ok((back.nextAt ?? 0) > clock.t, "a fresh nextAt");
    assert.equal(back.lastDetail, "restored");
    assert.ok(lines().length >= 5, "every change is a line; none was rewritten");
    assert.deepEqual(readdirSync(join(engine.config.stateDir, "automations")).filter((f) => f.endsWith(".ndjson")), ["jobs.ndjson"], "one journal, nothing unlinked (the alive heartbeat sits beside it)");
  } finally {
    await engine.stop();
  }
});

// (15) rebuild-idempotent
test("rebuild-idempotent: a second engine over the same state dir rebuilds the same rows from the journal (last by id) and appends nothing to it; a third load is the same", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  let second: World | undefined;
  let stopped = false;
  const automationRows = (e: Engine): number => e.ledger.read(clock.t).filter((r) => r.type.startsWith("automation.")).length;
  try {
    await engine.start();
    const a = armed(w, engine.automations.arm(alarm("Wake up", clock.t + 2 * H), "brain"));
    const b = armed(w, engine.automations.arm({ name: "log hours", when: { kind: "on", on: { kind: "app.quit", app: "Slack" } }, then: [{ kind: "say", line: "log your hours" }], echo: "When Slack quits, say it." }, "brain"));
    await engine.command({ type: "automation.pause", id: b.id });
    await engine.stop();
    stopped = true;
    const journal = engine.automations.table.journalPath;
    const before = readFileSync(journal, "utf8");
    const ledgerBefore = automationRows(engine);

    second = world({ automations: { exec } }, { dir: w.dir, firstSessionId: "sess_2" });
    second.clock.t = clock.t;
    await second.engine.start();
    const snap = second.engine.snapshot();
    assert.deepEqual(snap.automations.map((x) => [x.id, x.state]).sort(), [[a.id, "armed"], [b.id, "paused"]].sort());
    assert.equal(snap.nextFire?.id, a.id);
    assert.equal(readFileSync(journal, "utf8"), before, "a clean rebuild appends nothing");
    assert.equal(automationRows(second.engine), ledgerBefore, "and writes no automation row");
    second.engine.automations.load(second.clock.t);
    assert.equal(readFileSync(journal, "utf8"), before, "a third load appends nothing");
    assert.equal(second.engine.snapshot().automations.length, 2);
  } finally {
    if (!stopped) await engine.stop();
    if (second) await second.engine.stop();
  }
});

// (16) timer-ticks-and-caffeinate
test("timer-ticks-and-caffeinate: a 12-minute timer holds the Mac awake with `caffeinate -t 720` through the injected exec (a fixed argv, never a shell line); a viewer sees remainingMs ticks and nobody looking sees none; at 12:00 it rings 'pasta · 12:00 is up' with Snooze 5 · Done and the hold is killed; Snooze holds again for 5 min and Done kills that; a 90-minute timer holds nothing", async () => {
  const { exec, holds, runs } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    tick(engine);
    engine.setViewers(1);
    const t0 = clock.t;
    const a = armed(w, engine.automations.arm({ name: "pasta", when: { kind: "in", ms: 12 * M }, then: [{ kind: "chime", line: "pasta is up", sound: "Glass" }], echo: "In 12 minutes, chime." }, "brain"));
    assert.equal(a.nextAt, t0 + 12 * M);
    assert.equal(engine.snapshot().nextFire?.kind, "timer");
    assert.deepEqual(holds.map((h) => h.argv), [["/usr/bin/caffeinate", "-t", "720"]], "one hold, a fixed argv");
    assert.equal(holds[0]!.killed, false);
    assert.equal(runs.length, 0, "nothing else ran");

    // A viewer looks: the countdown ticks.
    events.length = 0;
    clock.t += 1000;
    tick(engine);
    engine.automations.table.flush();
    const ticks = events.flatMap((e) => (e.type === "automation.event" && e.event.kind === "tick" ? [e.event] : []));
    assert.ok(ticks.length >= 1, "a viewer sees the countdown");
    assert.equal(ticks[0]!.id, a.id);
    assert.equal(ticks[0]!.remainingMs, 12 * M - 1000);

    // Nobody looks: silence.
    engine.setViewers(0);
    engine.automations.table.flush();
    events.length = 0;
    clock.t += 1000;
    tick(engine);
    engine.automations.table.flush();
    assert.equal(events.flatMap((e) => (e.type === "automation.event" && e.event.kind === "tick" ? [e.event] : [])).length, 0, "nobody looks: no ticks");

    // 12:00 is up.
    clock.t = t0 + 12 * M;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.id, a.id);
    assert.equal(f[0]!.line, "pasta · 12:00 is up");
    assert.equal(f[0]!.lateMs, undefined);
    assert.equal(holds[0]!.killed, true, "the hold ends when the timer fires");
    const snap = engine.snapshot();
    assert.equal(snap.ringing?.kind, "timer");
    assert.deepEqual(snap.ringing?.presses, [{ kind: "snooze", minutes: 5 }, { kind: "done" }], "timers snooze 5");
    assert.deepEqual(events.filter((e) => e.type === "local.say"), [{ type: "local.say", sound: "Glass", automationId: a.id }]);
    assert.equal(rows(w, "automation.missed").length, 0);

    // Snooze (the timer's default, 5) holds the Mac again; Done kills that hold.
    const snoozed = engine.automations.changeNow(a.id, "snooze");
    assert.equal(snoozed.ok, true);
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.snoozedUntil, clock.t + 5 * M);
    assert.deepEqual(holds.map((h) => h.argv), [["/usr/bin/caffeinate", "-t", "720"], ["/usr/bin/caffeinate", "-t", "300"]], "the snooze holds the Mac again");
    assert.equal(holds[1]!.killed, false);
    await engine.command({ type: "automation.done", id: a.id });
    assert.equal(holds[1]!.killed, true, "Done kills the hold");
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "done");

    // Over an hour: nothing keeps the Mac awake (and nothing wakes it).
    armed(w, engine.automations.arm({ name: "long bake", when: { kind: "in", ms: 90 * M }, then: [{ kind: "chime", line: "bake is up" }], echo: "In 90 minutes, chime." }, "brain"));
    assert.equal(holds.length, 2, "over an hour: no hold");
    assert.equal(runs.length, 0);
    assert.equal(rows(w, "session.started").length, 0);
  } finally {
    await engine.stop();
  }
});

// the wire's `by` (integration seam 2)
test("automation.set from the wire stamps who sent it: by: \"cli\" → createdBy.by cli on the row and the ledger's automation.set; absent → console (an older Console); the brain's rows come through its tool and never this command; a rename wears its surface; the CLI's set is never a yes", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    const draft = (name: string) => ({ name, when: { kind: "at" as const, at: clock.t + H }, then: [{ kind: "chime" as const, line: "up" }], clauses: { quiet: "override" as const }, echo: "In an hour, chime." });
    await engine.command({ type: "automation.set", automation: draft("from the cli"), by: "cli" });
    await engine.command({ type: "automation.set", automation: draft("from the console") });
    const by = new Map(engine.snapshot().automations.map((a) => [a.name, a.createdBy.by]));
    assert.equal(by.get("from the cli"), "cli");
    assert.equal(by.get("from the console"), "console");
    assert.deepEqual(rows<Extract<LedgerRow, { type: "automation.set" }>>(w, "automation.set").map((r) => r.by), ["cli", "console"]);

    // A rename from the wire wears its surface too: the CLI's rename is a cli row, the Console's (or an older client's) a console row.
    const cliRow = engine.snapshot().automations.find((a) => a.name === "from the cli")!;
    await engine.command({ type: "automation.rename", id: cliRow.id, name: "cli renamed", by: "cli" });
    await engine.command({ type: "automation.rename", id: cliRow.id, name: "console renamed" });
    assert.deepEqual(rows<Extract<LedgerRow, { type: "automation.set" }>>(w, "automation.set").slice(2).map((r) => [r.automation.name, r.by]), [["cli renamed", "cli"], ["console renamed", "console"]]);

    // The wire is never a yes for the CLI: a confirm-tier row (run-recipe with a new recipeCommand) is refused, not armed, and
    // no recipe lands in settings as "approved by Kevin"; the Console's Add is the two-press idiom and arms it.
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"] });
    events.length = 0;
    const recipeDraft = (name: string) => ({ name, when: { kind: "at" as const, at: clock.t + H }, then: [{ kind: "run-recipe" as const, recipe: "tests" }], clauses: { quiet: "respect" as const }, echo: "In an hour, run tests.", recipeCommand: "pnpm test" });
    await engine.command({ type: "automation.set", automation: recipeDraft("cli tests") as never, by: "cli" });
    assert.equal(engine.snapshot().automations.some((a) => a.name === "cli tests"), false, "nothing armed");
    assert.deepEqual(engine.snapshot().settings.automations.recipes, [], "no recipe approved behind Kevin's back");
    const refusal = events.find((e) => e.type === "toast");
    assert.ok(refusal && refusal.type === "toast");
    assert.equal(refusal.tone, "warn");
    assert.match(refusal.text, /^not armed: recipe tests .* the CLI hears none/);
    assert.equal(rows(w, "recipe.set").length, 0);
    await engine.command({ type: "automation.set", automation: recipeDraft("console tests") as never, by: "console" });
    const consoleRow = engine.snapshot().automations.find((a) => a.name === "console tests")!;
    assert.ok(consoleRow, "the Console's Add arms it");
    assert.match(consoleRow.confirmed?.heard ?? "", /recipe tests/);
    assert.equal(engine.snapshot().settings.automations.recipes[0]?.name, "tests");
  } finally {
    await engine.stop();
  }
});

// the snapshot's Trash tail, recipesAsking and the ring's second line (integration seam 3)
test("snapshot: the live rows come first, then the Trash's newest eight as trashed (the Console's fold; every rail filters by state); recipesAsking names the recipes the shell gate now rates confirm; a ring carries calm, lateMs and more", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  try {
    await engine.start();
    automations(w, { recipes: [{ name: "tidy", command: "echo tidy", timeoutSeconds: 5, approvedAt: clock.t }, { name: "purge", command: "rm -rf ~/Downloads/old", timeoutSeconds: 5, approvedAt: clock.t }] });
    assert.deepEqual(engine.snapshot().recipesAsking, ["purge"], "the gate's present verdict, by name");
    const t0 = clock.t;
    const kept = armed(w, engine.automations.arm(alarm("kept", t0 + 3 * H), "brain"));
    const binned: Automation[] = [];
    for (let i = 0; i < 10; i++) {
      const a = armed(w, engine.automations.arm(alarm(`bin ${i}`, t0 + 4 * H), "brain"));
      clock.t += 1000;
      await engine.command({ type: "automation.trash", id: a.id });
      binned.push(a);
    }
    const snap = engine.snapshot();
    assert.equal(snap.automations[0]!.id, kept.id, "live first");
    const tail = snap.automations.slice(1);
    assert.equal(tail.length, 8, "the Trash tail is capped at eight");
    assert.ok(tail.every((a) => a.state === "trashed"));
    assert.deepEqual(tail.map((a) => a.name), binned.slice(2).reverse().map((a) => a.name), "newest first; the two oldest fell off the tail, never out of the journal");
    assert.equal(engine.automations.table.get(binned[0]!.id)?.state, "trashed", "still in the table for Restore");
    // Two alarms due in the same tick, two minutes late: the newest is the ring; more counts the other; calm is the one-shot's echo.
    const first = armed(w, engine.automations.arm(alarm("first", clock.t + M), "brain"));
    const second = armed(w, engine.automations.arm(alarm("second", clock.t + M), "brain"));
    clock.t += 3 * M;
    tick(engine);
    await fired(w, 2);
    const ring = engine.snapshot().ringing;
    assert.ok(ring);
    assert.ok([first.id, second.id].includes(ring.id));
    assert.equal(ring.more, 1);
    assert.equal(ring.lateMs, 2 * M);
    assert.equal(ring.calm, ring.id === first.id ? first.echo : second.echo, "a one-shot's calm line is its echo");
  } finally {
    await engine.stop();
  }
});

// open never executes: the lexical gate at fire, then the execute bit the lexicon cannot see
test("open-path-never-executes: an open of an executable file (no extension, mode 755) that passed the lexical set-up gate fails at fire ('is executable') and /usr/bin/open is never spawned; a .command armed through an older journal is refused at fire too; a plain document opens", async () => {
  const home = mkdtempSync(join(tmpdir(), "jh-auto-open-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "hook"), "#!/bin/sh\necho hi\n");
  chmodSync(join(bin, "hook"), 0o755);
  writeFileSync(join(home, "notes.txt"), "plain");
  const { exec, runs } = fakeExec();
  const w = world({ automations: { exec, home } });
  const { engine, clock } = w;
  try {
    await engine.start();
    const a = armed(w, engine.automations.arm({ name: "hook", when: { kind: "at", at: clock.t + M }, then: [{ kind: "open", path: join(bin, "hook") }], echo: "In a minute, open hook." }, "brain"));
    const refused = engine.automations.arm({ name: "deploy", when: { kind: "at", at: clock.t + M }, then: [{ kind: "open", path: join(bin, "deploy.command") }], echo: "In a minute, open deploy." }, "brain");
    assert.equal(refused.kind, "refused", "the lexical gate refuses at set-up");
    assert.match((refused as { reason: string }).reason, /would run when opened/);
    const doc = armed(w, engine.automations.arm({ name: "notes", when: { kind: "at", at: clock.t + M }, then: [{ kind: "open", path: join(home, "notes.txt") }], echo: "In a minute, open notes." }, "brain"));
    clock.t += M;
    tick(engine);
    const f = await fired(w, 2);
    const hook = f.find((r) => r.id === a.id)!;
    assert.equal(hook.ok, false);
    assert.match(hook.detail ?? "", /hook is executable; an open never runs anything/);
    const notes = f.find((r) => r.id === doc.id)!;
    assert.equal(notes.ok, true, notes.detail);
    assert.deepEqual(runs, [["/usr/bin/open", join(home, "notes.txt")]], "only the document reached /usr/bin/open");
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "failed");
    // A row an older journal armed with a .command path: the executor's own gate refuses it at fire.
    const detail = await (engine.automations.executor as unknown as { open(action: { kind: "open"; path: string }, id: string): Promise<{ ok: boolean; detail?: string }> }).open({ kind: "open", path: join(bin, "deploy.command") }, "auto_old");
    assert.equal(detail.ok, false);
    assert.match(detail.detail ?? "", /would run when opened/);
    assert.equal(runs.length, 1, "still only the document");
  } finally {
    await engine.stop();
  }
});

// the While asleep chips are a kill switch at fire, not only at set-up
test("chip-off-at-fire: a run-recipe row armed with the chip on fails at fire once the chip is off ('run-recipe is off in Settings › Automations › While asleep'), the shell never runs and the repeater re-arms with the reason; the chip back on, the next fire runs", async () => {
  const { exec } = fakeExec();
  const sh = fakeShell();
  const w = world({ automations: { exec, shell: sh.shell } });
  const { engine, clock } = w;
  try {
    await engine.start();
    const recipes = [{ name: "tidy", command: "echo tidy", timeoutSeconds: 5, approvedAt: clock.t }];
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes });
    const anchor = clock.t;
    const a = armed(w, engine.automations.arm({ name: "tidy hourly", when: { kind: "every", every: { kind: "interval", everyMs: H, anchorAt: anchor }, phrase: "every 1 h" }, then: [{ kind: "run-recipe", recipe: "tidy" }], echo: "Every hour, run recipe tidy." }, "brain", true));
    automations(w, { unattended: DEFAULT_AUTOMATIONS.unattended, recipes });
    clock.t += H;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.ok, false);
    assert.equal(f[0]!.detail, "run-recipe is off in Settings › Automations › While asleep");
    assert.equal(sh.calls.length, 0, "the shell never ran");
    let row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "armed", "a repeater re-arms");
    assert.equal(row.nextAt, anchor + 2 * H);
    assert.equal(row.lastDetail, "run-recipe is off in Settings › Automations › While asleep");
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes });
    clock.t += H;
    tick(engine);
    const g = await fired(w, 2);
    assert.equal(g[1]!.ok, true, g[1]!.detail);
    assert.deepEqual(sh.calls, ["echo tidy"]);
    row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "armed");
  } finally {
    await engine.stop();
  }
});

// the master switch off → on: the missed table, never a late run
test("switch-off-on-resync: with Automations off nothing fires — not even across a sleep gap; flipping it back on three hours later skips the every-2-h routine (missed {skipped, daemon-down}, nothing opened, the next slot armed), fails the alarm past its grace with ONE Run now problem, and rings the alarm inside its grace late with lateMs", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, hands } = w;
  try {
    await engine.start();
    tick(engine);
    const t0 = clock.t;
    const routine = armed(w, engine.automations.arm({ name: "backup", when: { kind: "every", every: { kind: "interval", everyMs: 2 * H, anchorAt: t0 }, phrase: "every 2 h" }, then: [{ kind: "open", app: "Notes" }], echo: "Every 2 h, open Notes." }, "brain"));
    const early = armed(w, engine.automations.arm(alarm("early", t0 + 10 * M), "brain"));
    const late = armed(w, engine.automations.arm(alarm("late", t0 + 3 * H - 5 * M), "brain"));
    automations(w, { enabled: false });
    clock.t += 20 * M;
    tick(engine);
    clock.t += 2 * H;
    tick(engine);
    await settle(30);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 0, "off: nothing fires, sleep gap or not");
    assert.equal(rows<MissedRow>(w, "automation.missed").length, 0, "off: nothing is settled either; the rows wait");
    clock.t = t0 + 3 * H;
    automations(w, { enabled: true });
    tick(engine);
    const f = await fired(w);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.id, late.id, "inside the alarm's 15-min grace: rang late");
    assert.equal(f[0]!.lateMs, 5 * M);
    await settle(30);
    assert.equal(hands.named("open_app").length, 0, "never a late run");
    const missed = rows<MissedRow>(w, "automation.missed");
    assert.deepEqual(missed.map((m) => [m.id, m.why, m.skipped ?? false]).sort(), [[early.id, "daemon-down", false], [routine.id, "daemon-down", true]].sort());
    const r = engine.snapshot().automations.find((x) => x.id === routine.id)!;
    assert.equal(r.state, "armed");
    assert.equal(r.nextAt, t0 + 4 * H);
    assert.equal(r.missed, 1);
    const e = engine.snapshot().automations.find((x) => x.id === early.id)!;
    assert.equal(e.state, "failed");
    assert.match(e.lastDetail ?? "", /^missed .* · Jarhead was off$/);
    const problems = engine.snapshot().problems.filter((p) => p.kind === "automation.missed");
    assert.equal(problems.length, 1);
    assert.deepEqual(problems[0]!.remedy, { label: "Run now", command: { type: "automation.run", id: early.id } });
  } finally {
    await engine.stop();
  }
});

// quiet hours hold on the resync's late fire too
test("resync-respects-quiet-hours: a `respect` reminder that opens Notes, due while the Mac slept inside quiet hours and still inside its grace, is deferred to the quiet end on wake — not opened at 23:40; the deferred open runs at 07:00", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, hands } = w;
  clock.t = new Date(2026, 8, 14, 23, 0, 0).getTime();
  try {
    await engine.start();
    automations(w, { quietHours: { from: "22:00", to: "07:00" } });
    tick(engine);
    const a = armed(w, engine.automations.arm(openAt("notes", clock.t + 10 * M), "brain"));
    clock.t += 40 * M; // the Mac slept through 23:10: a tick gap → resync, 30 min late, inside the reminder's hour
    tick(engine);
    await settle(30);
    assert.equal(hands.named("open_app").length, 0, "quiet hours hold on the late fire");
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 0);
    const row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "deferred");
    assert.equal(row.nextAt, new Date(2026, 8, 15, 7, 0, 0).getTime());
    assert.equal(row.lastDetail, "deferred to 07:00");
    clock.t = new Date(2026, 8, 15, 7, 0, 0).getTime();
    tick(engine);
    await fired(w);
    assert.equal(hands.named("open_app").length, 1, "runs at the quiet end");
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "done");
  } finally {
    await engine.stop();
  }
});

// recipes are never deleted: Move to Trash keeps the text, Restore brings it back
test("recipe-trash-restore: recipe.trash keeps the recipe in Settings with trashedAt (a recipe.trashed row), hides it from recipe_list and recipesAsking, refuses it as a row's target, fails the row that names it at fire without running the shell, and refuses recipe.set under its name; recipe.restore clears trashedAt (a recipe.restored row) and the next fire runs", async () => {
  const { exec } = fakeExec();
  const sh = fakeShell();
  const w = world({ automations: { exec, shell: sh.shell } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"] });
    await engine.command({ type: "recipe.set", recipe: { name: "tidy", command: "echo tidy", timeoutSeconds: 5, approvedAt: clock.t } });
    await engine.command({ type: "recipe.set", recipe: { name: "purge", command: "rm -rf ~/Downloads/old", timeoutSeconds: 5, approvedAt: clock.t } });
    const anchor = clock.t;
    const a = armed(w, engine.automations.arm({ name: "tidy hourly", when: { kind: "every", every: { kind: "interval", everyMs: H, anchorAt: anchor }, phrase: "every 1 h" }, then: [{ kind: "run-recipe", recipe: "tidy" }], echo: "Every hour, run recipe tidy." }, "brain", true));
    events.length = 0;
    await engine.command({ type: "recipe.trash", name: "tidy" });
    const recipes = (): readonly { name: string; trashedAt?: number }[] => engine.snapshot().settings.automations.recipes;
    assert.deepEqual(recipes().map((r) => [r.name, r.trashedAt !== undefined]), [["tidy", true], ["purge", false]], "kept in Settings, marked");
    assert.equal(recipes()[0]!.trashedAt, clock.t);
    assert.deepEqual(rows(w, "recipe.trashed").length, 1);
    assert.match((events.find((e) => e.type === "toast") as { text: string }).text, /moved to the Trash · Restore brings it back/);
    assert.deepEqual((await engine.automations.recipes()).map((r) => r.recipe.name), ["purge"], "recipe_list never lists the Trash");
    assert.deepEqual(engine.snapshot().recipesAsking, ["purge"]);
    const refused = engine.automations.arm({ name: "tidy again", when: { kind: "at", at: clock.t + M }, then: [{ kind: "run-recipe", recipe: "tidy" }], echo: "Run tidy." }, "brain", true);
    assert.equal(refused.kind, "refused");
    assert.match((refused as { reason: string }).reason, /in the Trash; restore it/);
    events.length = 0;
    await engine.command({ type: "recipe.set", recipe: { name: "tidy", command: "echo other", timeoutSeconds: 5, approvedAt: clock.t } });
    assert.match((events.find((e) => e.type === "toast") as { text: string }).text, /tidy is in the Trash; restore it, or pick another name/);
    assert.equal(recipes()[0]!.trashedAt, clock.t, "the trashed text was not overwritten");
    clock.t += H;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.ok, false);
    assert.equal(f[0]!.detail, "recipe tidy is in the Trash; restore it first");
    assert.equal(sh.calls.length, 0, "the shell never ran");
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "armed", "the repeater re-arms and says so");
    await engine.command({ type: "recipe.restore", name: "TIDY" });
    assert.deepEqual(recipes().map((r) => [r.name, "trashedAt" in r]), [["tidy", false], ["purge", false]], "trashedAt is gone, not undefined");
    assert.equal(rows(w, "recipe.restored").length, 1);
    assert.deepEqual((await engine.automations.recipes()).map((r) => r.recipe.name), ["tidy", "purge"]);
    clock.t += H;
    tick(engine);
    const g = await fired(w, 2);
    assert.equal(g[1]!.ok, true, g[1]!.detail);
    assert.deepEqual(sh.calls, ["echo tidy"]);
    assert.equal(recipes().length, 2, "nothing was ever deleted");
  } finally {
    await engine.stop();
  }
});

// a client's whole settings block never un-trashes a recipe: the Trash is the engine's fact
test("recipe-trash-survives-set-settings: a Console chip toggle sends the whole automations block re-encoded without trashedAt — the trashed recipe stays in the Trash (trashedAt kept, still unpickable), a block with no recipes array keeps the stored recipes, and recipe.restore is still the one way back", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.command({ type: "recipe.set", recipe: { name: "tidy", command: "echo tidy", timeoutSeconds: 5, approvedAt: clock.t } });
    await engine.command({ type: "recipe.set", recipe: { name: "purge", command: "echo purge", timeoutSeconds: 5, approvedAt: clock.t } });
    await engine.command({ type: "recipe.trash", name: "tidy" });
    const block = (): AutomationSettings => engine.snapshot().settings.automations;
    assert.equal(block().recipes[0]?.trashedAt, clock.t);
    // The Console's write(): the block as its ShellRecipe knows it — every field but trashedAt — with one chip flipped.
    const stripped = block().recipes.map(({ trashedAt: _gone, ...r }) => r);
    await engine.command({ type: "set-settings", patch: { automations: { ...block(), unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes: stripped } } });
    assert.deepEqual(block().unattended.includes("run-recipe"), true, "the chip landed");
    assert.deepEqual(block().recipes.map((r) => [r.name, r.trashedAt]), [["tidy", clock.t], ["purge", undefined]], "the Trash survived the round trip");
    assert.deepEqual((await engine.automations.recipes()).map((r) => r.recipe.name), ["purge"], "still unpickable");
    // An older client's block with no recipes at all: the stored list stays.
    const { recipes: _none, ...noRecipes } = block();
    await engine.command({ type: "set-settings", patch: { automations: noRecipes as AutomationSettings } });
    assert.equal(block().recipes.length, 2, "nothing dropped");
    assert.equal(block().recipes[0]?.trashedAt, clock.t);
    // Restore is the engine's own write and still works.
    await engine.command({ type: "recipe.restore", name: "tidy" });
    assert.deepEqual(block().recipes.map((r) => "trashedAt" in r), [false, false]);
    assert.deepEqual((await engine.automations.recipes()).map((r) => r.recipe.name), ["tidy", "purge"]);
  } finally {
    await engine.stop();
  }
});

// two wake-brain rows in one tick share one budget
test("wake-brain-budget-reserved: two wake-brain rows due in the same tick against a 2-minute cap with 90 s budgets each — the first reserves its budget before anything awaits, the second fails 'budget' before any brain runs; after the first settles its spend stands and the reservation is gone", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, threads } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"], wakeBudgetMinutesPerDay: 2 });
    threads.script = async () => ({ status: "done", summary: "Fine." });
    const draft = (name: string): AutomationSetInput => ({ name, when: { kind: "at", at: clock.t + M }, then: [{ kind: "wake-brain", prompt: "how are the agents", budget: { steps: 3, seconds: 90 }, speak: false }], echo: "Wake the brain." });
    const a = armed(w, engine.automations.arm(draft("first"), "brain", true));
    const b = armed(w, engine.automations.arm(draft("second"), "brain", true));
    clock.t += M;
    tick(engine);
    const f = await fired(w, 2);
    const ok = f.filter((r) => r.ok);
    const budget = f.filter((r) => !r.ok);
    assert.equal(ok.length, 1, "one turn ran");
    assert.equal(budget.length, 1, "the other never started");
    assert.equal(budget[0]!.detail, "budget");
    assert.ok([a.id, b.id].includes(ok[0]!.id) && [a.id, b.id].includes(budget[0]!.id));
    assert.equal(threads.brains.filter((x) => x.tasks.length > 0).length, 1, "one brain took a turn");
    assert.equal(engine.automations.brainSecondsToday, ok[0]!.brainSeconds, "the real spend stands; no reservation lingers");
    assert.ok(engine.snapshot().problems.some((p) => p.kind === "automation.budget"));
  } finally {
    await engine.stop();
  }
});

// recipe.red with a new recipe: the yes approves the recipe the poll runs
test("recipe-red-saves-recipe: arming a recipe.red watcher on a recipe not yet approved, with recipeCommand, asks once and — with the yes — saves the recipe to Settings (a recipe.set row by brain) so the poll has something to run; the watcher then fires on the flip to red", async () => {
  const { exec } = fakeExec();
  const calls: string[] = [];
  // Green on the first poll (the baseline), red from the second: the flip is the fire.
  const shell: ShellRunner = async (o) => {
    calls.push(o.command);
    return { code: calls.length === 1 ? 0 : 1, signal: null, stdout: calls.length === 1 ? "ok" : "FAIL", stderr: "", timedOut: false, cancelled: false, ms: 1 };
  };
  const w = world({ automations: { exec, shell } });
  const { engine, clock } = w;
  try {
    await engine.start();
    const draft: AutomationSetInput = { name: "ci red", when: { kind: "on", on: { kind: "recipe.red", recipe: "ci", everySeconds: 60 } }, then: [{ kind: "notify", title: "CI is red" }], echo: "When ci goes red, notify.", recipeCommand: "echo checking" };
    const asked = engine.automations.arm(draft, "brain", false);
    assert.equal(asked.kind, "confirm");
    assert.match((asked as { question: string }).question, /recipe ci .* every 60 s unattended/);
    assert.deepEqual(engine.snapshot().settings.automations.recipes, [], "nothing saved before the yes");
    const a = armed(w, engine.automations.arm(draft, "brain", true, { heard: (asked as { question: string }).question }));
    assert.deepEqual(engine.snapshot().settings.automations.recipes.map((r) => [r.name, r.command]), [["ci", "echo checking"]]);
    assert.deepEqual(rows<Extract<LedgerRow, { type: "recipe.set" }>>(w, "recipe.set").map((r) => r.by), ["brain"]);
    clock.t += 61_000;
    tick(engine);
    await until(() => calls.length === 1, 1500);
    await settle(20);
    assert.equal(rows(w, "automation.fired").length, 0, "the first poll is the baseline");
    clock.t += 61_000;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.id, a.id);
    assert.equal(f[0]!.ok, true, f[0]!.detail);
    assert.match(f[0]!.detail ?? "", /recipe ci red · exit 1/);
    assert.deepEqual(calls, ["echo checking", "echo checking"], "the poll ran the approved text");
  } finally {
    await engine.stop();
  }
});

// an executor exception is redacted before it reaches lastDetail, the ledger and the event
test("exception-detail-redacted: a fire whose gate throws with a secret in its message records 'failed: …' with the secret replaced — in the automation.fired row, the row's lastDetail and the fired event", async () => {
  const secret = "shh-brain-key-0123456789";
  process.env["JARHEAD_BRAIN_API_KEY"] = secret;
  const { exec } = fakeExec();
  const sh = fakeShell();
  const shellGate: ShellGate = () => {
    throw new Error(`gate exploded reading ${secret} from the env`);
  };
  const w = world({ automations: { exec, shell: sh.shell, shellGate } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes: [{ name: "tidy", command: "echo tidy", timeoutSeconds: 5, approvedAt: clock.t }] });
    const a = armed(w, engine.automations.arm({ name: "tidy once", when: { kind: "at", at: clock.t + M }, then: [{ kind: "run-recipe", recipe: "tidy" }], echo: "Run tidy." }, "brain", true));
    events.length = 0;
    clock.t += M;
    tick(engine);
    const f = await fired(w);
    assert.equal(f[0]!.ok, false);
    assert.match(f[0]!.detail ?? "", /^failed: gate exploded reading \[redacted secret\] from the env$/);
    assert.equal((f[0]!.detail ?? "").includes(secret), false);
    const row = engine.snapshot().automations.find((x) => x.id === a.id)!;
    assert.equal(row.state, "failed");
    assert.equal((row.lastDetail ?? "").includes(secret), false);
    assert.match(row.lastDetail ?? "", /\[redacted secret\]/);
    engine.automations.table.flush();
    assert.equal(JSON.stringify(events).includes(secret), false, "no event carries it");
    assert.equal(sh.calls.length, 0);
  } finally {
    delete process.env["JARHEAD_BRAIN_API_KEY"];
    await engine.stop();
  }
});

// then[] runs in Kevin's order and stops at the first failure
test("then-in-order: [say, run-recipe] with a failing shell says the line first (local.say) and then fails on the recipe — the say is not withheld; [chime, wake-brain] sounds the chime before the brain turn starts; [file, chime] still files first so the line can say what it did", async () => {
  const { exec } = fakeExec();
  const sh = fakeShell(1, "boom");
  const w = world({ automations: { exec, shell: sh.shell } });
  const { engine, clock, events, threads } = w;
  try {
    await engine.start();
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe", "wake-brain"], recipes: [{ name: "backup", command: "echo hi", timeoutSeconds: 5, approvedAt: clock.t }] });
    const a = armed(w, engine.automations.arm({ name: "backup night", when: { kind: "at", at: clock.t + M }, then: [{ kind: "say", line: "starting backup" }, { kind: "run-recipe", recipe: "backup" }], echo: "Say it, then back up." }, "brain", true));
    events.length = 0;
    clock.t += M;
    tick(engine);
    const f = await fired(w);
    assert.deepEqual(f[0]!.actions, ["say", "run-recipe"], "the order is Kevin's");
    assert.equal(f[0]!.ok, false);
    assert.match(f[0]!.detail ?? "", /recipe backup exit 1/);
    const says = events.filter((e) => e.type === "local.say");
    assert.deepEqual(says, [{ type: "local.say", text: "starting backup", automationId: a.id }], "the say went out before the recipe failed");
    assert.deepEqual(sh.calls, ["echo hi"]);

    // The chime sounds before the headless turn starts, not after it ends.
    let chimeBeforeBrain: boolean | undefined;
    threads.script = async () => {
      chimeBeforeBrain = events.some((e) => e.type === "local.say" && "sound" in e && e.sound === "Glass");
      return { status: "done", summary: "All quiet." };
    };
    events.length = 0;
    const b = armed(w, engine.automations.arm({ name: "rundown", when: { kind: "at", at: clock.t + M }, then: [{ kind: "chime", line: "rundown", sound: "Glass" }, { kind: "wake-brain", prompt: "what happened", budget: { steps: 3, seconds: 60 }, speak: false }], clauses: { quiet: "override" }, echo: "Chime, then wake the brain." }, "brain", true));
    clock.t += M;
    tick(engine);
    const g = await fired(w, 2);
    assert.equal(g[1]!.id, b.id);
    assert.equal(g[1]!.ok, true, g[1]!.detail);
    assert.deepEqual(g[1]!.actions, ["chime", "wake-brain"]);
    assert.equal(chimeBeforeBrain, true, "the chime's local.say preceded the brain turn");
  } finally {
    await engine.stop();
  }
});

// an alarm's one self-snooze is per occurrence
test("self-snooze-per-occurrence: a daily alarm self-snoozes once on day one, rings again, Kevin presses Done on the re-ring; on day two the unanswered ring self-snoozes once again ('unanswered · snoozed once') instead of ending 'unanswered' after ten minutes", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock } = w;
  clock.t = new Date(2026, 8, 14, 7, 0, 0).getTime();
  try {
    await engine.start();
    const a = armed(w, engine.automations.arm({ name: "Wake up", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "07:10" }, phrase: "daily 07:10" }, then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }], clauses: { quiet: "override" }, echo: "Daily at 07:10, ring." }, "brain"));
    const row = (): Automation => engine.snapshot().automations.find((x) => x.id === a.id)!;
    // Day one: ring, self-snooze after the linger, ring again, Kevin's Done.
    clock.t = new Date(2026, 8, 14, 7, 10, 0).getTime();
    tick(engine);
    await fired(w);
    clock.t += AUTOMATION_LINGER_MS;
    tick(engine);
    assert.equal(row().state, "snoozed");
    assert.equal(row().lastDetail, "unanswered · snoozed once");
    clock.t += 10 * M;
    tick(engine);
    await fired(w, 2);
    assert.equal(row().state, "fired");
    clock.t += M;
    await engine.command({ type: "automation.done", id: a.id });
    assert.equal(row().state, "armed", "a repeater re-arms on Done");
    assert.equal(row().nextAt, new Date(2026, 8, 15, 7, 10, 0).getTime());
    // Day two: the same alarm, unanswered — it self-snoozes ONCE again, as the design says, rather than ending.
    clock.t = new Date(2026, 8, 15, 7, 10, 0).getTime();
    tick(engine);
    await fired(w, 3);
    assert.equal(row().state, "fired");
    clock.t += AUTOMATION_LINGER_MS;
    tick(engine);
    assert.equal(row().state, "snoozed", "day two's first linger self-snoozes; the flag did not leak from day one");
    assert.equal(row().lastDetail, "unanswered · snoozed once");
    assert.equal(rows<StateRow>(w, "automation.state").filter((r) => r.state === "snoozed" && r.by === "engine").length, 1, "today's ledger file holds day two's self-snooze (day one's is in its own day file)");
    // And Kevin's own Snooze on a ring resets it too: after his snooze, the re-ring's linger still gets the engine's one self-snooze.
    clock.t += 10 * M;
    tick(engine);
    await fired(w, 4);
    await engine.command({ type: "automation.snooze", id: a.id, minutes: 5 });
    clock.t += 5 * M;
    tick(engine);
    await fired(w, 5);
    clock.t += AUTOMATION_LINGER_MS;
    tick(engine);
    assert.equal(row().state, "snoozed", "Kevin's Snooze answered the ring; the engine's self-snooze is available again");
  } finally {
    await engine.stop();
  }
});

// a fire's record stands even when Kevin moved the row while it ran
test("fired-row-when-trashed-mid-run: a recipe that is still running when Kevin moves the row to the Trash finishes with ONE automation.fired row and a fired event; the row stays trashed with fires 1; a pause mid-run keeps it paused", async () => {
  const { exec } = fakeExec();
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const shell: ShellRunner = async (o) => {
    calls.push(o.command);
    await new Promise<void>((r) => (release = r));
    return { code: 0, signal: null, stdout: "done", stderr: "", timedOut: false, cancelled: false, ms: 1 };
  };
  const w = world({ automations: { exec, shell } });
  const { engine, clock, events } = w;
  try {
    await engine.start();
    const recipes = [{ name: "tidy", command: "echo tidy", timeoutSeconds: 5, approvedAt: clock.t }];
    automations(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes });
    const a = armed(w, engine.automations.arm({ name: "tidy once", when: { kind: "at", at: clock.t + M }, then: [{ kind: "run-recipe", recipe: "tidy" }], echo: "Run tidy." }, "brain", true));
    clock.t += M;
    tick(engine);
    await until(() => calls.length === 1, 1500);
    assert.equal(engine.snapshot().automations.find((x) => x.id === a.id)?.state, "firing");
    await engine.command({ type: "automation.trash", id: a.id });
    assert.equal(engine.automations.table.get(a.id)?.state, "trashed");
    events.length = 0;
    release!();
    const f = await fired(w);
    assert.equal(f.length, 1, "the fire's record stands");
    assert.equal(f[0]!.id, a.id);
    assert.equal(f[0]!.ok, true);
    assert.equal(f[0]!.line, "tidy once · recipe tidy exit 0 · done", "what the recipe did is the fire's line");
    const row = engine.automations.table.get(a.id)!;
    assert.equal(row.state, "trashed", "the state is Kevin's");
    assert.equal(row.fires, 1);
    assert.equal(row.lastFiredAt, f[0]!.at);
    engine.automations.table.flush();
    assert.ok(events.some((e) => e.type === "automation.event" && e.event.kind === "fired" && e.event.id === a.id), "the fired event went out");
    assert.equal(engine.snapshot().nextFire, undefined);

    // Paused mid-run: the same record, the row stays paused.
    const anchor = clock.t;
    const b = armed(w, engine.automations.arm({ name: "tidy hourly", when: { kind: "every", every: { kind: "interval", everyMs: H, anchorAt: anchor }, phrase: "every 1 h" }, then: [{ kind: "run-recipe", recipe: "tidy" }], echo: "Every hour, tidy." }, "brain", true));
    clock.t += H;
    tick(engine);
    await until(() => calls.length === 2, 1500);
    await engine.command({ type: "automation.pause", id: b.id });
    release!();
    const g = await fired(w, 2);
    assert.equal(g[1]!.id, b.id);
    const paused = engine.automations.table.get(b.id)!;
    assert.equal(paused.state, "paused");
    assert.equal(paused.fires, 1);
    assert.equal(paused.nextAt, undefined, "paused rows wait; nothing is in the heap for it");
  } finally {
    release?.();
    await engine.stop();
  }
});

// one `when` grammar: the wire may send Kevin's phrase and the engine parses it with core's parseWhen
test("when-phrase-on-the-wire: automation.set with whenPhrase 'in 12 minutes' arms a timer parsed by the engine (nextAt = now + 12 min); 'tonight at seven' arms 19:00; a phrase the grammar does not catch is refused with parseWhen's own words as a toast, nothing armed; `when` wins when both ride", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec } });
  const { engine, clock, events } = w;
  clock.t = new Date(2026, 8, 14, 9, 0, 0).getTime();
  try {
    await engine.start();
    await engine.command({ type: "automation.set", automation: { name: "pasta", whenPhrase: "in 12 minutes", then: [{ kind: "chime", line: "pasta" }], clauses: { quiet: "override" }, echo: "In 12 minutes, chime pasta." }, by: "console" });
    const pasta = engine.snapshot().automations.find((a) => a.name === "pasta")!;
    assert.ok(pasta, "armed from the phrase");
    assert.deepEqual(pasta.when, { kind: "in", ms: 12 * M });
    assert.equal(pasta.nextAt, clock.t + 12 * M);
    await engine.command({ type: "automation.set", automation: { name: "call mum", whenPhrase: "tonight at seven", then: [{ kind: "say", line: "call mum" }], clauses: { quiet: "respect" }, echo: "Tonight at seven, say call mum." } });
    assert.equal(engine.snapshot().automations.find((a) => a.name === "call mum")?.nextAt, new Date(2026, 8, 14, 19, 0, 0).getTime());
    events.length = 0;
    await engine.command({ type: "automation.set", automation: { name: "whenever", whenPhrase: "whenever", then: [{ kind: "chime", line: "x" }], clauses: { quiet: "override" }, echo: "Whenever." }, by: "cli" });
    assert.equal(engine.snapshot().automations.some((a) => a.name === "whenever"), false, "nothing armed");
    const toast = events.find((e) => e.type === "toast");
    assert.ok(toast && toast.type === "toast");
    assert.equal(toast.tone, "warn");
    assert.equal(toast.text, 'not armed: didn\'t catch "whenever" in "whenever"', "parseWhen's words, verbatim");
    await engine.command({ type: "automation.set", automation: { name: "both", when: { kind: "at", at: clock.t + H }, whenPhrase: "in 5 minutes", then: [{ kind: "chime", line: "both" }], clauses: { quiet: "override" }, echo: "Both." } });
    assert.equal(engine.snapshot().automations.find((a) => a.name === "both")?.nextAt, clock.t + H, "a normalised when wins over the phrase");
    events.length = 0;
    await engine.command({ type: "automation.set", automation: { name: "neither", then: [{ kind: "chime", line: "x" }], clauses: { quiet: "override" }, echo: "Neither." } as never });
    assert.match((events.find((e) => e.type === "toast") as { text: string }).text, /^not armed: say when it fires/);
  } finally {
    await engine.stop();
  }
});
