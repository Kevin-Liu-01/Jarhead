import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, clockOf } from "@jarhead/core";
import { DEFAULT_AUTOMATIONS, DEFAULT_SETTINGS, type Automation, type AutomationSettings, type LedgerRow, type Settings } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import { Automations, type AutomationExec, type AutomationSetInput } from "../automations/index.ts";
import { rows, settle, until, world, type World } from "./world.ts";

/**
 * W2-2: automations keep local time, are honest about lateness, file every file and judge real quits.
 * The audit's repros (scratchpad/launch/sleep), adopted. Every exec is a fake (no /usr/bin/open, no
 * caffeinate, no ps), every home a mkdtemp, every hands a RecordingHands, the clock moved by hand.
 */

const M = 60_000;
const H = 60 * M;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
type FiredRow = Extract<LedgerRow, { type: "automation.fired" }>;
type MissedRow = Extract<LedgerRow, { type: "automation.missed" }>;
type SetRow = Extract<LedgerRow, { type: "automation.set" }>;

function fakeExec(): { exec: AutomationExec; holds: { argv: string[]; killed: boolean }[] } {
  const holds: { argv: string[]; killed: boolean }[] = [];
  return {
    holds,
    exec: {
      run: async () => ({ code: 0 }),
      hold: (file, argv) => {
        const h = { argv: [file, ...argv], killed: false };
        holds.push(h);
        return { kill: () => (h.killed = true) };
      },
    },
  };
}
const home = (): string => mkdtempSync(join(tmpdir(), "jh-w22-home-"));
const settings = (w: World, patch: Partial<AutomationSettings>): void => w.engine.updateSettings({ automations: { ...DEFAULT_AUTOMATIONS, ...patch } });
const armed = (r: unknown): Automation => {
  assert.equal((r as { kind: string }).kind, "armed", JSON.stringify(r));
  return (r as { automation: Automation }).automation;
};
const alarmAt = (name: string, at: number): AutomationSetInput => ({ name, when: { kind: "at", at }, then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }], clauses: { quiet: "override" }, echo: `At ${clockOf(at)}, ring.` });
const dayWords = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

// ------------------------------------------------------------------ SL-2
test("SL-2: a nightly routine deferred by quiet hours is due at the quiet end; the Mac asleep past it skips the routine, never runs it hours late", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock, hands } = w;
  clock.t = new Date(2026, 9, 5, 22, 0, 0).getTime(); // Mon 22:00
  try {
    await engine.start();
    settings(w, { quietHours: { from: "23:00", to: "07:00" } });
    tick(engine);
    const a = armed(engine.automations.arm({ name: "notes", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "23:30" }, phrase: "daily 23:30" }, then: [{ kind: "open", app: "Notes" }], echo: "Daily at 23:30, open Notes." }, "brain"));
    for (let t = clock.t; t <= new Date(2026, 9, 5, 23, 30, 0).getTime(); t += M) {
      clock.t = t;
      tick(engine);
    }
    assert.equal(engine.automations.table.get(a.id)?.state, "deferred");
    assert.equal(engine.automations.table.get(a.id)?.lastDetail, "deferred to 07:00");
    assert.equal(engine.automations.table.get(a.id)?.nextAt, new Date(2026, 9, 6, 7, 0, 0).getTime(), "due at the quiet end");
    // 23:45 the lid closes; Tuesday 14:00 it opens (a tick gap → resync "mac-slept").
    clock.t = new Date(2026, 9, 6, 14, 0, 0).getTime();
    tick(engine);
    await settle(60);
    assert.equal(hands.named("open_app").length, 0, `the routine ran ${rows<FiredRow>(w, "automation.fired").map((f) => `lateMs ${f.lateMs}`).join(", ")}`);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 0);
    const missed = rows<MissedRow>(w, "automation.missed").filter((m) => m.id === a.id);
    assert.equal(missed.length, 1, "one missed row");
    assert.equal(missed[0]!.skipped, true, "routines skip");
    assert.equal(missed[0]!.dueAt, new Date(2026, 9, 6, 7, 0, 0).getTime(), "its due instant is the quiet end");
    const row = engine.automations.table.get(a.id)!;
    assert.equal(row.state, "armed");
    assert.equal(row.nextAt, new Date(2026, 9, 6, 23, 30, 0).getTime(), "the next regular slot");
    assert.match(row.lastDetail ?? "", /^skipped 07:00 · Tue 6 Oct · the Mac slept/);
  } finally {
    await engine.stop();
  }
});

test("SL-2: a deferred row whose quiet end comes on a live tick still runs there", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock, hands } = w;
  clock.t = new Date(2026, 9, 5, 23, 0, 0).getTime();
  try {
    await engine.start();
    settings(w, { quietHours: { from: "22:00", to: "07:00" } });
    tick(engine);
    const a = armed(engine.automations.arm({ name: "notes", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "23:30" }, phrase: "daily 23:30" }, then: [{ kind: "open", app: "Notes" }], echo: "Daily at 23:30, open Notes." }, "brain"));
    clock.t = new Date(2026, 9, 5, 23, 30, 0).getTime();
    tick(engine);
    assert.equal(engine.automations.table.get(a.id)?.state, "deferred");
    // Awake all night: ticks every 30 s until a second past the quiet end.
    for (let t = clock.t; t <= new Date(2026, 9, 6, 7, 0, 1).getTime(); t += 30_000) {
      clock.t = t;
      tick(engine);
    }
    clock.t = new Date(2026, 9, 6, 7, 0, 1).getTime();
    tick(engine);
    await until(() => hands.named("open_app").length >= 1, 1500);
    assert.equal(hands.named("open_app").length, 1, "the deferred routine runs at its quiet end");
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-3
test("SL-3: a folder watcher whose fire was in flight when the daemon died comes back armed and watching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-w22-dir-"));
  const h = home();
  const inbox = join(h, "Inbox");
  mkdirSync(inbox);
  const now = new Date(2026, 9, 5, 9, 0, 0).getTime();
  const row = {
    id: "auto_watchfiring",
    name: "inbox chime",
    when: { kind: "on", on: { kind: "folder.file", path: inbox, settleMs: 1000 } },
    then: [{ kind: "chime", line: "landed", sound: "Glass" }],
    clauses: { quiet: "respect", cooldown: 0 },
    echo: "When a file lands in Inbox, chime.",
    state: "firing",
    fires: 3,
    missed: 0,
    createdAt: now - 24 * H,
    updatedAt: now - 2 * M,
    createdBy: { by: "brain", request: "x" },
  } as Automation;
  mkdirSync(join(dir, "state", "automations"), { recursive: true });
  writeFileSync(join(dir, "state", "automations", "jobs.ndjson"), `${JSON.stringify(row)}\n`);
  writeFileSync(join(dir, "state", "automations", "alive"), String(now - 2 * M));
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: h } }, { dir });
  const { engine, clock } = w;
  clock.t = now;
  try {
    await engine.start();
    assert.equal(engine.automations.table.get(row.id)?.state, "armed", "the row says armed after the restart");
    assert.equal(engine.automations.watchers.folderCount, 1, "and its folder is watched");
    writeFileSync(join(inbox, "fresh.txt"), "landed after the restart");
    for (let i = 0; i < 4; i++) {
      clock.t += 5_000;
      tick(engine);
    }
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 1, "the file that landed after the restart fires");
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-5
test("SL-5: only live rows reserve a name; a done or failed holder is renamed with its day (one automation.set row) and the second pasta timer arms", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const a = armed(engine.automations.arm({ name: "pasta", whenPhrase: "in 12 minutes", then: [{ kind: "chime", line: "pasta" }], echo: "In 12 min, ring pasta." }, "cli"));
    clock.t += 12 * M;
    tick(engine);
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    const firedAt = engine.automations.table.get(a.id)!.lastFiredAt!;
    await engine.command({ type: "automation.done", id: a.id });
    assert.equal(engine.automations.table.get(a.id)?.state, "done");
    clock.t += 7 * 24 * H;
    tick(engine);
    const setsBefore = rows<SetRow>(w, "automation.set").length;
    const b = armed(engine.automations.arm({ name: "pasta", whenPhrase: "in 12 minutes", then: [{ kind: "chime", line: "pasta" }], echo: "In 12 min, ring pasta." }, "cli"));
    assert.notEqual(b.id, a.id);
    const old = engine.automations.table.get(a.id)!;
    assert.equal(old.state, "done", "the holder keeps its state");
    assert.equal(old.name, `pasta · ${dayWords(firedAt)}`, "the holder wears its day");
    const sets = rows<SetRow>(w, "automation.set").slice(setsBefore);
    assert.deepEqual(sets.map((s) => [s.automation.id, s.automation.name]), [[a.id, old.name], [b.id, "pasta"]], "the rename is recorded, then the new row");
    assert.equal(engine.automations.table.find("pasta")?.id, b.id, "the name means the live row");

    // A live holder still reserves the name.
    assert.match((engine.automations.arm({ name: "Pasta", whenPhrase: "in 5 minutes", then: [{ kind: "chime", line: "pasta" }], echo: "x" }, "cli") as { reason: string }).reason, /already set/);

    // A failed holder (a one-shot missed past its grace) frees its name too.
    const c = armed(engine.automations.arm({ name: "tea", whenPhrase: "in 5 minutes", then: [{ kind: "chime", line: "tea" }], echo: "x" }, "cli"));
    clock.t += 3 * H;
    tick(engine);
    await settle(40);
    assert.equal(engine.automations.table.get(c.id)?.state, "failed");
    armed(engine.automations.arm({ name: "tea", whenPhrase: "in 5 minutes", then: [{ kind: "chime", line: "tea" }], echo: "x" }, "cli"));
    assert.match(engine.automations.table.get(c.id)!.name, /^tea · \d{1,2} [A-Z][a-z]{2}$/);
  } finally {
    await engine.stop();
  }
});

test("SL-5: a retired name that is taken too gets a number, and a long name is cut to fit 24 characters", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const long = "the long pasta timer xx"; // 23 characters
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = armed(engine.automations.arm({ name: long, whenPhrase: "in 1 minute", then: [{ kind: "chime", line: "pasta" }], echo: "x" }, "cli"));
      ids.push(a.id);
      clock.t += M;
      tick(engine);
      await until(() => rows<FiredRow>(w, "automation.fired").filter((f) => f.id === a.id).length >= 1, 1500);
      await engine.command({ type: "automation.done", id: a.id });
    }
    armed(engine.automations.arm({ name: long, whenPhrase: "in 1 minute", then: [{ kind: "chime", line: "pasta" }], echo: "x" }, "cli"));
    const names = ids.map((id) => engine.automations.table.get(id)!.name);
    for (const n of names) assert.ok(n.length <= 24, `${n} fits`);
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 3, `the retired names are unique: ${names.join(" | ")}`);
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-6
test("SL-6: a PDF that was in Downloads at arm and is then edited in place is not a landing and is not filed away; a new file still is", async () => {
  const h = home();
  const downloads = join(h, "Downloads");
  const papers = join(h, "Papers");
  mkdirSync(downloads);
  writeFileSync(join(downloads, "paper.pdf"), "%PDF original");
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: h } });
  const { engine, clock } = w;
  const step = (): void => {
    clock.t += 5_000;
    tick(engine);
  };
  try {
    await engine.start();
    armed(engine.automations.arm({ name: "file papers", when: { kind: "on", on: { kind: "folder.file", path: downloads, glob: "*.pdf" } }, then: [{ kind: "file", into: papers }, { kind: "chime", line: "filed", sound: "Glass" }], echo: "When a PDF lands in Downloads, file it under Papers and chime." }, "brain", false, { request: `when a pdf lands in ${downloads} file it under ${papers}` }));
    step();
    step();
    appendFileSync(join(downloads, "paper.pdf"), " + an annotation saved by Preview");
    for (let i = 0; i < 4; i++) step();
    await settle(80);
    assert.ok(existsSync(join(downloads, "paper.pdf")), `paper.pdf was moved: Papers holds ${existsSync(papers) ? readdirSync(papers).join(", ") : "nothing"}`);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 0);
    writeFileSync(join(downloads, "new.pdf"), "%PDF new");
    for (let i = 0; i < 3; i++) step();
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    assert.ok(existsSync(join(papers, "new.pdf")), "a new name is a landing");
    assert.ok(existsSync(join(downloads, "paper.pdf")));
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-7
test("SL-7: two PDFs downloaded seconds apart under the default cooldown are both filed; the cooldown keeps only the chime quiet", async () => {
  const h = home();
  const downloads = join(h, "Downloads");
  const papers = join(h, "Papers");
  mkdirSync(downloads);
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: h } });
  const { engine, clock, events } = w;
  const step = (): void => {
    clock.t += 5_000;
    tick(engine);
  };
  try {
    await engine.start();
    const a = armed(engine.automations.arm({ name: "file papers", when: { kind: "on", on: { kind: "download.done", glob: "*.pdf" } }, then: [{ kind: "file", into: papers }, { kind: "chime", line: "filed", sound: "Glass" }], echo: "When a PDF lands in Downloads, file it under Papers and chime." }, "brain", false, { request: `when a pdf lands in Downloads file it under ${papers}` }));
    writeFileSync(join(downloads, "invoice.pdf"), "%PDF a");
    step();
    step();
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    await engine.command({ type: "automation.done", id: a.id });
    writeFileSync(join(downloads, "receipt.pdf"), "%PDF b");
    for (let i = 0; i < 24; i++) step();
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 2, 1500);
    await settle(40);
    assert.deepEqual(readdirSync(downloads), [], `left unfiled: ${readdirSync(downloads).join(", ")} · "${engine.automations.table.get(a.id)?.lastDetail}"`);
    assert.deepEqual(readdirSync(papers).sort(), ["invoice.pdf", "receipt.pdf"]);
    const f = rows<FiredRow>(w, "automation.fired");
    assert.deepEqual(f.map((r) => r.actions), [["file", "chime"], ["file"]], "inside the cooldown the chime is held, the file is filed");
    assert.equal(events.filter((e) => e.type === "local.say" && e.sound === "Glass").length, 1, "one chime");
  } finally {
    await engine.stop();
  }
});

test("SL-7: a burst of PDFs is filed one by one, and files that land while the row rings are polled and filed too", async () => {
  const h = home();
  const downloads = join(h, "Downloads");
  const papers = join(h, "Papers");
  mkdirSync(downloads);
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: h } });
  const { engine, clock } = w;
  const step = (): void => {
    clock.t += 5_000;
    tick(engine);
  };
  try {
    await engine.start();
    const a = armed(engine.automations.arm({ name: "file papers", when: { kind: "on", on: { kind: "download.done", glob: "*.pdf" } }, then: [{ kind: "file", into: papers }, { kind: "chime", line: "filed", sound: "Glass" }], echo: "When a PDF lands in Downloads, file it under Papers and chime." }, "brain", false, { request: `when a pdf lands in Downloads file it under ${papers}` }));
    for (let i = 0; i < 4; i++) writeFileSync(join(downloads, `p${i}.pdf`), `%PDF ${i}`);
    step();
    step();
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 4, 2000);
    assert.equal(engine.automations.table.get(a.id)?.state, "fired", "the row rings, nobody pressed Done");
    writeFileSync(join(downloads, "late.pdf"), "%PDF late");
    step();
    step();
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 5, 2000);
    await settle(40);
    assert.deepEqual(readdirSync(downloads), [], `left unfiled: ${readdirSync(downloads).join(", ")}`);
    assert.equal(readdirSync(papers).length, 5);
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-8
test("SL-8: an alarm ringing when the lid closes ends 'unanswered · the Mac slept' on wake, and does not ring again", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  clock.t = new Date(2026, 9, 5, 7, 9, 0).getTime();
  try {
    await engine.start();
    tick(engine);
    const a = armed(engine.automations.arm(alarmAt("Wake up", clock.t + M), "brain"));
    clock.t += M;
    tick(engine);
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    clock.t += 8 * H;
    tick(engine);
    assert.equal(engine.automations.table.get(a.id)?.state, "done");
    assert.equal(engine.automations.table.get(a.id)?.lastDetail, "unanswered · the Mac slept");
    assert.equal(engine.snapshot().ringing, undefined, "nothing rings on the island");
    clock.t += 10 * M;
    tick(engine);
    await settle(60);
    const f = rows<FiredRow>(w, "automation.fired");
    assert.equal(f.length, 1, `rang again at ${clockOf(clock.t)}`);
  } finally {
    await engine.stop();
  }
});

test("SL-8: a weekday alarm left ringing across two nights re-arms, and the occurrence the lid slept through is a missed row", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  clock.t = new Date(2026, 9, 5, 7, 0, 0).getTime(); // Mon 07:00
  try {
    await engine.start();
    tick(engine);
    const a = armed(engine.automations.arm({ name: "Wake up", whenPhrase: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up", sound: "Hero" }], echo: "Weekdays at 07:10, ring." }, "console", true));
    clock.t = new Date(2026, 9, 5, 7, 10, 0).getTime();
    tick(engine);
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    clock.t = new Date(2026, 9, 7, 6, 0, 0).getTime(); // Wed 06:00: Tue 07:10 went by with the lid shut
    tick(engine);
    await settle(40);
    const row = engine.automations.table.get(a.id)!;
    assert.equal(row.state, "armed");
    assert.equal(row.nextAt, new Date(2026, 9, 7, 7, 10, 0).getTime(), "Wednesday's ring stands");
    const missed = rows<MissedRow>(w, "automation.missed").filter((m) => m.id === a.id);
    assert.deepEqual(missed.map((m) => m.dueAt), [new Date(2026, 9, 6, 7, 10, 0).getTime()], "Tuesday's is missed and says so");
    const firedOn = (t: number): number => w.engine.ledger.read(t).filter((r) => r.type === "automation.fired").length;
    assert.deepEqual([firedOn(new Date(2026, 9, 5, 12, 0).getTime()), firedOn(new Date(2026, 9, 6, 12, 0).getTime()), firedOn(clock.t)], [1, 0, 0], "Monday's ring, and no other");
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-11
test("SL-11: quiet hours default from the kind: a timer with no clauses respects them, an alarm overrides, a form draft with an empty clause block gets the same", async () => {
  const { exec } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    const timer = armed(engine.automations.arm({ name: "pasta", whenPhrase: "in 12 minutes", then: [{ kind: "chime", line: "pasta" }], echo: "In 12 min, ring pasta." }, "console", true));
    assert.equal(timer.clauses.quiet, "respect", "a chime at `in` is a timer");
    const alarm = armed(engine.automations.arm({ name: "Wake up", when: { kind: "at", at: clock.t + 3 * H }, then: [{ kind: "chime", line: "Wake up" }], echo: "x" }, "console", true));
    assert.equal(alarm.clauses.quiet, "override", "a chime on a clock is an alarm");
    await engine.command({ type: "automation.set", automation: { name: "tea", whenPhrase: "in 5 minutes", then: [{ kind: "chime", line: "tea" }], clauses: {}, echo: "In 5 min, ring tea." } as never });
    assert.equal(engine.automations.table.find("tea")?.clauses.quiet, "respect", "the Console's form sends no quiet clause");
    const kept = armed(engine.automations.arm({ name: "loud", whenPhrase: "in 5 minutes", then: [{ kind: "chime", line: "loud" }], clauses: { quiet: "override" }, echo: "x" }, "console", true));
    assert.equal(kept.clauses.quiet, "override", "a clause that is said is kept");
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ SL-19
test("SL-19: a 90-minute timer holds the Mac awake in chunks of at most an hour, re-held before the first runs out, released at the fire", async () => {
  const { exec, holds } = fakeExec();
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    tick(engine);
    const r = armed(engine.automations.arm({ name: "roast", whenPhrase: "in 90 minutes", then: [{ kind: "chime", line: "roast" }], echo: "In 90 min, ring roast." }, "console", true));
    assert.deepEqual(holds.map((h) => h.argv), [["/usr/bin/caffeinate", "-t", "3600"]], "the first hour is held at arm");
    for (let i = 0; i < 59; i++) {
      clock.t += M;
      tick(engine);
    }
    assert.equal(holds.length, 2, `re-held before the hour runs out: ${JSON.stringify(holds.map((h) => h.argv))}`);
    assert.equal(holds[0]!.killed, true, "the old hold is let go");
    assert.deepEqual(holds[1]!.argv, ["/usr/bin/caffeinate", "-t", String(31 * 60)], "the rest of the timer");
    clock.t = r.nextAt!;
    tick(engine);
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    assert.equal(holds[1]!.killed, true, "the fire lets it go");
    assert.equal(holds.length, 2);
  } finally {
    await engine.stop();
  }
});

test("SL-19: a snoozed timer is held again when the daemon restarts", async () => {
  const { exec, holds } = fakeExec();
  const h = home();
  const w = world({ automations: { exec, home: h } });
  let second: World | undefined;
  let stopped = false;
  try {
    await w.engine.start();
    tick(w.engine);
    const a = armed(w.engine.automations.arm({ name: "pasta", whenPhrase: "in 12 minutes", then: [{ kind: "chime", line: "pasta" }], echo: "x" }, "console", true));
    w.clock.t += 12 * M;
    tick(w.engine);
    await until(() => rows(w, "automation.fired").length >= 1, 1500);
    assert.equal(w.engine.automations.changeNow(a.id, "snooze", 30).ok, true);
    await w.engine.stop();
    stopped = true;
    const before = holds.length;
    second = world({ automations: { exec, home: h } }, { dir: w.dir, firstSessionId: "sess_2" });
    second.clock.t = w.clock.t + 1000;
    await second.engine.start();
    assert.equal(second.engine.automations.table.get(a.id)?.state, "snoozed");
    assert.deepEqual(holds.slice(before).map((x) => x.argv), [["/usr/bin/caffeinate", "-t", String(30 * 60 - 1)]], "the snoozed timer is held for the rest of its snooze");
  } finally {
    if (!stopped) await w.engine.stop();
    if (second) await second.engine.stop();
  }
});

// ------------------------------------------------------------------ SL-18
test("SL-18: the wake-brain question says how the brain is paid for: the plan, API tokens on the key, or a warm-up on this Mac", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-w22-cost-"));
  let brain: Settings["brain"] = "codex";
  let current: Settings = { ...DEFAULT_SETTINGS, automations: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"], wakeBudgetMinutesPerDay: 5 } };
  const t = new Date(2026, 9, 5, 9, 0, 0).getTime();
  const autos = new Automations({
    stateDir: dir,
    now: () => t,
    ledger: new Ledger(dir),
    settings: () => current,
    updateSettings: (patch) => (current = { ...current, ...patch } as Settings),
    hands: {} as never,
    reader: {} as never,
    redact: (s) => s,
    emit: () => undefined,
    problem: () => undefined,
    live: () => undefined,
    brain: { warmUp: async () => undefined, lane: async () => undefined, after: async () => undefined },
    present: async () => false,
    localBrain: () => brain === "local",
    brainKind: () => brain,
    onChange: () => undefined,
    exec: fakeExec().exec,
    home: home(),
  });
  const draft: AutomationSetInput = { name: "rundown", when: { kind: "at", at: t + H }, then: [{ kind: "wake-brain", prompt: "summarise my agents", budget: { steps: 5, seconds: 60 }, speak: true }], echo: "Wake the brain." };
  const ask = (): string => {
    const r = autos.arm(draft, "brain", false);
    assert.equal(r.kind, "confirm", JSON.stringify(r));
    return (r as { question: string }).question;
  };
  try {
    assert.match(ask(), /about 1 brain minute per fire on your plan, up to 5 a day/);
    brain = "openai-responses";
    assert.match(ask(), /about 1 brain minute per fire billed as API tokens on your key, up to 5 a day/);
    brain = "anthropic-api";
    assert.match(ask(), /billed as API tokens on your key/);
    brain = "local";
    assert.match(ask(), /a model warm-up on this Mac/);
    brain = "claude-code";
    assert.match(ask(), /on your plan/);
  } finally {
    autos.dispose();
  }
});

test("SL-18: under 'auto', the question and the heard the Console records name the brain auto resolved to: API tokens on the key, or a warm-up on this Mac", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-w22-cost-auto-"));
  let resolved: string | undefined = "anthropic-api";
  let current: Settings = { ...DEFAULT_SETTINGS, brain: "auto", automations: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"], wakeBudgetMinutesPerDay: 5 } };
  const t = new Date(2026, 9, 5, 9, 0, 0).getTime();
  const autos = new Automations({
    stateDir: dir,
    now: () => t,
    ledger: new Ledger(dir),
    settings: () => current,
    updateSettings: (patch) => (current = { ...current, ...patch } as Settings),
    hands: {} as never,
    reader: {} as never,
    redact: (s) => s,
    emit: () => undefined,
    problem: () => undefined,
    live: () => undefined,
    brain: { warmUp: async () => undefined, lane: async () => undefined, after: async () => undefined },
    present: async () => false,
    // Settings say auto, so the settings-based seam says "not local": the resolved kind decides instead.
    localBrain: () => current.brain === "local",
    brainKind: () => resolved,
    onChange: () => undefined,
    exec: fakeExec().exec,
    home: home(),
  });
  const draft = (name: string): AutomationSetInput => ({ name, when: { kind: "at", at: t + H }, then: [{ kind: "wake-brain", prompt: "summarise my agents", budget: { steps: 5, seconds: 60 }, speak: true }], echo: "Wake the brain." });
  const consoleHeard = async (name: string): Promise<string | undefined> => {
    const toasts: string[] = [];
    await autos.command({ type: "automation.set", automation: draft(name) } as never, (text) => void toasts.push(text));
    assert.match(toasts[0] ?? "", /^armed: /, toasts.join(" | "));
    return autos.table.named(name)?.confirmed?.heard;
  };
  try {
    const q = autos.arm(draft("rundown"), "brain", false);
    assert.equal(q.kind, "confirm");
    assert.match((q as { question: string }).question, /per fire billed as API tokens on your key/);
    assert.equal(await consoleHeard("rundown"), (q as { question: string }).question, "what the Console recorded as heard is the engine's question");
    resolved = "local";
    const local = autos.arm(draft("rundown local"), "brain", false);
    assert.match((local as { question: string }).question, /per fire a model warm-up on this Mac/);
    assert.equal(await consoleHeard("rundown local"), (local as { question: string }).question);
    resolved = undefined;
    assert.match((autos.arm(draft("rundown later"), "brain", false) as { question: string }).question, /per fire on your plan/, "nothing resolved yet: Settings' brain, as the form reads it");
  } finally {
    autos.dispose();
  }
});

test("SL-18: the engine names the brain 'auto' resolved to in the wake-brain question and in the heard it records (runs once engine.ts passes brainKind)", async (t) => {
  const apiBrain = { kind: "anthropic-api", start: async () => ({ ready: true, detail: "api" }), handle: async () => ({ status: "done", text: "" }), cancel: async () => undefined, stop: async () => undefined };
  const w = world({ brain: apiBrain as never, automations: { exec: fakeExec().exec, home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    // The W2-1 / W2-2 contract: engine.ts hands Automations `brainKind`; until that merge the engine judges by Settings' brain,
    // and the Console's form reads Settings' brain too, so the two agree.
    if ((engine.automations as unknown as { opts: { brainKind?: unknown } }).opts.brainKind === undefined) {
      t.skip("engine.ts passes no brainKind yet (the W2-1 merge wires it, and AutomationForm.billedBrain reads setup.brainResolved with it)");
      return;
    }
    assert.equal(engine.snapshot().settings.brain, "auto");
    // The brain proves itself after start(): until it is ready, auto has resolved to nothing.
    await until(() => engine.snapshot().brainReady, 1500);
    settings(w, { unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"], wakeBudgetMinutesPerDay: 5 });
    const draft: AutomationSetInput = { name: "rundown", when: { kind: "at", at: clock.t + H }, then: [{ kind: "wake-brain", prompt: "summarise my agents", budget: { steps: 5, seconds: 60 }, speak: true }], echo: "Wake the brain." };
    const q = engine.automations.arm(draft, "brain", false);
    assert.equal(q.kind, "confirm");
    assert.match((q as { question: string }).question, /billed as API tokens on your key/);
    await engine.automations.command({ type: "automation.set", automation: draft } as never, () => undefined);
    assert.match(engine.automations.table.named("rundown")?.confirmed?.heard ?? "", /billed as API tokens on your key/);
  } finally {
    await engine.stop();
  }
});
