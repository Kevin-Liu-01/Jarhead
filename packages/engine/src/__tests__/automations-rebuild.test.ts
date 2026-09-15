import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
