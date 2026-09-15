import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation, LedgerRow } from "@jarhead/protocol";
import { RESTART_DETAIL } from "../automations/index.ts";
import { rows, until, world } from "./world.ts";

/**
 * A daemon that restarts over a state dir whose automations journal holds rows: the
 * table is rebuilt from the journal (the newest row per id wins), a row left `firing`
 * is failed "the daemon restarted", an alarm due while the daemon was down fires late
 * inside its grace and is missed past it (one problem with Run now), a routine is
 * skipped. Nothing here opens a session; the journal only grows.
 */

const M = 60_000;
const H = 60 * M;
type FiredRow = Extract<LedgerRow, { type: "automation.fired" }>;
type MissedRow = Extract<LedgerRow, { type: "automation.missed" }>;

function row(id: string, name: string, at: number, extra: Partial<Automation> = {}): Automation {
  return {
    id,
    name,
    when: { kind: "at", at },
    then: [{ kind: "chime", line: name, sound: "Hero" }],
    clauses: { quiet: "override" },
    echo: `At some time, ring "${name}".`,
    state: "armed",
    nextAt: at,
    fires: 0,
    missed: 0,
    createdAt: at - H,
    updatedAt: at - H,
    createdBy: { by: "brain", request: name },
    ...extra,
  };
}

function journalWith(dir: string, rowsToWrite: readonly Automation[]): string {
  const stateDir = join(dir, "state");
  mkdirSync(join(stateDir, "automations"), { recursive: true });
  const path = join(stateDir, "automations", "jobs.ndjson");
  writeFileSync(path, rowsToWrite.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

test("rebuild: the newest journal row per id wins; a restart at nextAt + 5 min fires the alarm late (lateMs, no problem); at + 20 min it is missed with ONE problem carrying Run now; a `firing` row is failed 'the daemon restarted'; a routine's slot is skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-auto-rebuild-"));
  const now = new Date(2026, 8, 14, 7, 30, 0).getTime();
  const lateAlarm = row("auto_late", "five late", now - 5 * M);
  const missedAlarm = row("auto_missed", "twenty late", now - 20 * M);
  const renamed = row("auto_ren", "old name", now + H);
  const wasFiring = row("auto_firing", "backup", now - 2 * M, { state: "firing", then: [{ kind: "open", app: "Notes" }], clauses: { quiet: "respect" } });
  const routine: Automation = { ...row("auto_routine", "standup", now - 30 * M, { then: [{ kind: "open", app: "Notes" }], clauses: { quiet: "respect" } }), when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "07:00" }, phrase: "daily 07:00" } };
  const future = row("auto_future", "tonight", now + 12 * H);
  const path = journalWith(dir, [lateAlarm, missedAlarm, renamed, { ...renamed, name: "new name", updatedAt: now - H / 2 }, wasFiring, routine, future]);
  const before = readFileSync(path, "utf8");

  const exec = { run: async () => ({ code: 0 }), hold: () => undefined };
  const w = world({ automations: { exec } }, { dir });
  const { engine, clock, hands, handsBg } = w;
  clock.t = now;
  try {
    await engine.start();
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    const snap = engine.snapshot();
    const by = (id: string): Automation | undefined => engine.automations.table.get(id);
    assert.equal(by("auto_ren")?.name, "new name", "the newest row per id wins");
    assert.equal(snap.automations.filter((a) => a.name === "old name").length, 0);

    // Five minutes late, inside the alarm's grace: rang, with lateMs.
    const fired = rows<FiredRow>(w, "automation.fired");
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.id, "auto_late");
    assert.equal(fired[0]!.lateMs, 5 * M);
    assert.equal(by("auto_late")?.state, "fired");
    assert.equal(snap.ringing?.id, "auto_late");
    assert.equal(snap.ringing?.lateMs, 5 * M);

    // Twenty minutes late, past the grace: missed, failed, one problem with Run now.
    const missed = rows<MissedRow>(w, "automation.missed");
    assert.deepEqual(missed.filter((m) => m.id === "auto_missed").map((m) => [m.why, m.skipped]), [["daemon-down", undefined]]);
    assert.equal(by("auto_missed")?.state, "failed");
    assert.equal(by("auto_missed")?.missed, 1);
    assert.match(by("auto_missed")?.lastDetail ?? "", /Jarhead was off/);
    const problems = snap.problems.filter((p) => p.kind === "automation.missed");
    assert.equal(problems.length, 1);
    assert.deepEqual(problems[0]!.remedy, { label: "Run now", command: { type: "automation.run", id: "auto_missed" } });

    // daemon-down-missed-run-now: Run now is Kevin's press — refused while nobody is at the Mac (never a question); with his
    // hands on it the missed alarm rings now, on time, and the problem clears. Nothing here opens a session.
    const away = await engine.automations.change("auto_missed", "run");
    assert.equal(away.ok, false);
    assert.match((away as { reason: string }).reason, /needs you at the Mac/);
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 1, "refused: nothing fired");
    clock.t += 1000; // a second on: the press rings newest, so the island shows it
    handsBg.kevinActed();
    await engine.command({ type: "automation.run", id: "auto_missed" });
    const rang = rows<FiredRow>(w, "automation.fired");
    assert.equal(rang.length, 2);
    assert.equal(rang[1]!.id, "auto_missed");
    assert.equal(rang[1]!.lateMs, undefined, "Run now is on time");
    assert.equal(by("auto_missed")?.state, "fired");
    assert.equal(engine.snapshot().ringing?.id, "auto_missed");
    assert.equal(engine.snapshot().ringing?.more, 1, "the five-minutes-late ring still waits behind it");
    assert.equal(engine.snapshot().problems.filter((p) => p.kind === "automation.missed").length, 0, "the press clears the problem");

    // A row the dead daemon left `firing`: failed "the daemon restarted"; nothing acted.
    assert.equal(by("auto_firing")?.state, "failed");
    assert.equal(by("auto_firing")?.lastDetail, RESTART_DETAIL);
    assert.equal(hands.named("open_app").length, 0, "nothing acts at rebuild");

    // The routine's 07:00 slot passed: skipped, the next slot armed.
    assert.deepEqual(missed.filter((m) => m.id === "auto_routine").map((m) => [m.why, m.skipped]), [["daemon-down", true]]);
    assert.equal(by("auto_routine")?.state, "armed");
    assert.equal(by("auto_routine")?.nextAt, new Date(2026, 8, 15, 7, 0, 0).getTime());
    assert.equal(by("auto_routine")?.missed, 1);

    // The one still ahead waits as it was.
    assert.equal(by("auto_future")?.state, "armed");
    assert.equal(by("auto_future")?.nextAt, now + 12 * H);
    assert.equal(snap.nextFire?.id, "auto_ren", "the soonest waiting row (an hour ahead) is the foot's next fire");

    // The rails: no session; the journal grew (every change is a line) and was never rewritten.
    assert.equal(rows(w, "session.started").length, 0);
    const after = readFileSync(path, "utf8");
    assert.ok(after.startsWith(before), "appended, never rewritten");
    assert.ok(after.length > before.length);
    const ids = after.split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Automation).id);
    assert.ok(ids.filter((id) => id === "auto_firing").length >= 2, "the failed row was journaled");
  } finally {
    await engine.stop();
  }
});

test("rebuild: a torn last line is skipped, a row missing its shape is skipped, and a second load over the same journal appends nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-auto-rebuild-torn-"));
  const now = new Date(2026, 8, 14, 7, 30, 0).getTime();
  const good = row("auto_good", "tonight", now + 12 * H);
  const path = journalWith(dir, [good]);
  writeFileSync(path, `${readFileSync(path, "utf8")}{"id":"auto_bad"}\n{"id":"auto_torn","name":"x","when":{"kind":"at","at":1},"then":[{"kind":"ch`);
  const w = world({ automations: { exec: { run: async () => ({ code: 0 }), hold: () => undefined } } }, { dir });
  const { engine, clock } = w;
  clock.t = now;
  try {
    await engine.start();
    assert.deepEqual(engine.snapshot().automations.map((a) => a.id), ["auto_good"]);
    const before = readFileSync(path, "utf8");
    engine.automations.load(now);
    assert.equal(readFileSync(path, "utf8"), before, "a clean load appends nothing");
    assert.deepEqual(engine.snapshot().automations.map((a) => a.id), ["auto_good"]);
  } finally {
    await engine.stop();
  }
});

test("rebuild: a folder watcher's files that landed while the daemon was off are counted from the alive heartbeat — 'not watching HH:MM–HH:MM · 1 new file not handled', missed 1 — never filed or fired; a file older than the heartbeat is the baseline; a file landing after the restart fires as ever; the missed alarm's words carry the span", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-auto-rebuild-watch-"));
  const home = mkdtempSync(join(tmpdir(), "jh-auto-rebuild-home-"));
  const inbox = join(home, "Inbox");
  const papers = join(home, "Papers");
  mkdirSync(inbox);
  const now = new Date(2026, 8, 14, 7, 30, 0).getTime();
  // Every instant here is the test clock's: the heartbeat, the files' mtimes (set by hand), the engine's now.
  const stamp = (name: string, text: string, at: number): void => {
    writeFileSync(join(inbox, name), text);
    utimesSync(join(inbox, name), at / 1000, at / 1000);
  };
  stamp("old.pdf", "already here before the daemon quit", now - 3 * H);
  stamp("landed.pdf", "landed while Jarhead was off", now - H);
  stamp("landed.txt", "not a pdf: outside the glob, not counted", now - H);
  const watcher: Automation = { ...row("auto_watch", "file papers", now - H, { then: [{ kind: "file", into: papers }, { kind: "chime", line: "filed", sound: "Glass" }], clauses: { quiet: "respect", cooldown: 0 } }), when: { kind: "on", on: { kind: "folder.file", path: inbox, glob: "*.pdf", settleMs: 3000 } } };
  delete (watcher as { nextAt?: number }).nextAt;
  const missedAlarm = row("auto_missed", "twenty late", now - 20 * M);
  const path = journalWith(dir, [watcher, missedAlarm]);
  // The previous daemon's last heartbeat: two hours before this start.
  writeFileSync(join(dir, "state", "automations", "alive"), String(now - 2 * H));
  const exec = { run: async () => ({ code: 0 }), hold: () => undefined };
  const w = world({ automations: { exec, home } }, { dir });
  const { engine, clock } = w;
  clock.t = now;
  try {
    await engine.start();
    const by = (id: string): Automation | undefined => engine.automations.table.get(id);
    assert.equal(by("auto_watch")?.state, "armed");
    assert.match(by("auto_watch")?.lastDetail ?? "", /^not watching \d\d:\d\d–\d\d:\d\d · 1 new file not handled$/);
    assert.equal(by("auto_watch")?.missed, 1);
    assert.equal(existsSync(papers), false, "nothing was filed: a folder is not a queue");
    assert.equal(rows<FiredRow>(w, "automation.fired").length, 0);
    assert.match(by("auto_missed")?.lastDetail ?? "", /^missed \d\d:\d\d · Jarhead was off from \d\d:\d\d$/, "the missed alarm says since when");
    // The watcher still works: a PDF landing now settles and is filed; the counted one stays put.
    writeFileSync(join(inbox, "fresh.pdf"), "landed after the restart");
    for (let i = 0; i < 3; i++) {
      clock.t += 5_000;
      (engine as unknown as { tick(): void }).tick();
    }
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    assert.deepEqual(readdirSync(papers), ["fresh.pdf"]);
    assert.deepEqual(readdirSync(inbox).sort(), ["landed.pdf", "landed.txt", "old.pdf"]);
    assert.ok(Number(readFileSync(join(dir, "state", "automations", "alive"), "utf8")) >= now, "this daemon stamped alive");
  } finally {
    await engine.stop();
  }
});
