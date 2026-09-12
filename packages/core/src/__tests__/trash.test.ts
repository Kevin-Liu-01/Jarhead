import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { LedgerRow, TranscriptItem } from "@jarhead/protocol";
import { Ledger } from "../ledger.ts";
import { Trash } from "../trash.ts";

/**
 * The Trash moves whole day files by rename(2) and never unlinks a live one. These
 * tests hold a fake clock at noon on 2026-09-12 so "today" is that day whatever the
 * machine's zone, and read the ledger.moved rows and the manifest back.
 */

const local = (day: number, h: number, m: number, s = 0): number => new Date(2026, 8, day, h, m, s).getTime();
const NOON_12 = local(12, 12, 0);

function item(id: string, text: string, at: number): TranscriptItem {
  return { id, speaker: "kevin", text, startMs: 0, endMs: 1000, at, final: true };
}
const heard = (at: number, text: string): LedgerRow => ({ at, type: "heard", item: item(`h${at}`, text, at) });

interface Rig {
  stateDir: string;
  ledger: Ledger;
  trash: Trash;
  log: string[];
  openIds: string[];
}

function rig(opts: { rename?: (from: string, to: string) => void } = {}): Rig {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-trash-"));
  const ledger = new Ledger(stateDir);
  const log: string[] = [];
  const openIds: string[] = [];
  const trash = new Trash(stateDir, ledger, { now: () => NOON_12, openSessionIds: () => openIds, log: (l) => log.push(l), ...(opts.rename ? { rename: opts.rename } : {}) });
  return { stateDir, ledger, trash, log, openIds };
}

/** One closed session on `day` at 10:00, with a line heard. */
function closedSession(r: Rig, day: number, id: string, extra: Partial<{ resumedFrom: string }> = {}): void {
  r.ledger.append({ at: local(day, 10, 0), type: "session.started", sessionId: id, voice: "cedar", ...(extra.resumedFrom ? { resumedFrom: extra.resumedFrom } : {}) });
  r.ledger.append(heard(local(day, 10, 1), `words on the ${day}th`));
  r.ledger.append({ at: local(day, 10, 5), type: "session.closed", sessionId: id, reason: "idle", usageSeconds: 300 });
}

/** A shots folder for a day with two small PNG-shaped files. */
function shots(r: Rig, day: string): string {
  const dir = join(r.stateDir, "shots", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shot_1.png"), Buffer.alloc(1000, 1));
  writeFileSync(join(dir, "shot_2.png"), Buffer.alloc(2000, 2));
  return dir;
}

const moved = (r: Rig): LedgerRow[] => r.ledger.read(NOON_12).filter((row) => row.type === "ledger.moved");

test("trash: a whole day moves by rename, is recorded in today's ledger and the manifest, shows in info(), and moves back", () => {
  const r = rig();
  closedSession(r, 9, "A");
  closedSession(r, 10, "B");
  closedSession(r, 12, "T");
  const shotsDir = shots(r, "2026-09-09");
  assert.deepEqual(r.trash.info(), { path: join(r.stateDir, "trash"), days: 0, bytes: 0 });

  const before = readFileSync(join(r.ledger.dir, "2026-09-09.jsonl"));
  const res = r.trash.moveDay("2026-09-09", "ledger", "kevin");
  assert.equal(res.ok, true);
  assert.ok(!existsSync(join(r.ledger.dir, "2026-09-09.jsonl")), "the live file is gone from ledger/");
  const inTrash = join(r.stateDir, "trash", "ledger", "2026-09-09.jsonl");
  assert.ok(existsSync(inTrash));
  assert.ok(readFileSync(inTrash).equals(before), "the same bytes, moved, not rewritten");
  // The walk notices: A's day is no longer listed; B and T remain.
  assert.deepEqual(r.ledger.days(), ["2026-09-10.jsonl", "2026-09-12.jsonl"]);
  assert.deepEqual(r.ledger.sessions().map((s) => s.id), ["T", "B"]);

  const shotsRes = r.trash.moveDay("2026-09-09", "shots", "kevin");
  assert.equal(shotsRes.ok, true);
  assert.ok(!existsSync(shotsDir));
  assert.deepEqual(readdirSync(join(r.stateDir, "trash", "shots", "2026-09-09")).sort(), ["shot_1.png", "shot_2.png"]);

  // Recorded: two ledger.moved rows in TODAY's file (the 12th), and two manifest lines.
  const rows = moved(r) as Extract<LedgerRow, { type: "ledger.moved" }>[];
  assert.deepEqual(
    rows.map((m) => [m.day, m.what, m.to, m.by]),
    [
      ["2026-09-09", "ledger", "trash", "kevin"],
      ["2026-09-09", "shots", "trash", "kevin"],
    ],
  );
  assert.equal(rows[0]!.path, inTrash);
  const manifest = readFileSync(join(r.stateDir, "trash", "manifest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { day: string; what: string; to: string; from: string; path: string });
  assert.equal(manifest.length, 2);
  assert.equal(manifest[0]!.from, join(r.ledger.dir, "2026-09-09.jsonl"));
  assert.equal(manifest[1]!.path, join(r.stateDir, "trash", "shots", "2026-09-09"));

  const info = r.trash.info();
  assert.equal(info.days, 1);
  assert.equal(info.bytes, before.length + 3000);
  assert.deepEqual(r.trash.days(), [{ day: "2026-09-09", ledger: true, shots: true, bytes: before.length + 3000 }]);

  // Restore: both come back by rename; the record says so; the Trash is empty again.
  const back = r.trash.restoreDay("2026-09-09");
  assert.deepEqual(back.refused, []);
  assert.deepEqual(back.restored.map((m) => m.what), ["ledger", "shots"]);
  assert.ok(readFileSync(join(r.ledger.dir, "2026-09-09.jsonl")).equals(before));
  assert.ok(existsSync(join(shotsDir, "shot_2.png")));
  assert.deepEqual(r.ledger.sessions().map((s) => s.id), ["T", "B", "A"]);
  assert.deepEqual((moved(r) as Extract<LedgerRow, { type: "ledger.moved" }>[]).map((m) => m.to), ["trash", "trash", "live", "live"]);
  assert.equal(r.trash.info().days, 0);
  // Nothing to restore now; a restore never overwrites a live file.
  assert.equal(r.trash.restoreDay("2026-09-09").refused[0]?.reason, "nothing for that day in the Trash");
  assert.ok(r.log.some((l) => /moved to the Trash \(kevin\)/.test(l)));
});

test("trash: refusals — today, a day that has not come, no file, already in the Trash, the open session's day, a pinned chain, a chain still open", () => {
  const r = rig();
  closedSession(r, 8, "P");
  closedSession(r, 9, "A");
  // A chain: B on the 10th paused, C on the 11th resumed it and is still open (no closed row, no later start).
  closedSession(r, 10, "B");
  r.ledger.append({ at: local(11, 10, 0), type: "session.started", sessionId: "C", voice: "cedar", resumedFrom: "B" });
  r.ledger.append(heard(local(11, 10, 1), "still going"));
  r.ledger.append({ at: local(12, 9, 0), type: "conversation.pinned", chainId: "P", pinned: true });

  assert.equal(r.trash.refusal("2026-09-12", "ledger"), "today is live");
  assert.equal(r.trash.refusal("2026-09-13", "ledger"), "that day has not happened yet");
  assert.equal(r.trash.refusal("nonsense", "ledger"), "not a day (YYYY-MM-DD)");
  assert.equal(r.trash.refusal("2026-09-01", "ledger"), "no ledger file for that day");
  assert.equal(r.trash.refusal("2026-09-09", "shots"), "no screenshots for that day");
  assert.equal(r.trash.refusal("2026-09-08", "ledger"), "a pinned conversation");
  assert.equal(r.trash.refusal("2026-09-11", "ledger"), "the open session's day", "the ledger's own notion of open: no closed row, no later start");
  assert.equal(r.trash.refusal("2026-09-10", "ledger"), "a conversation still open has a session that day", "B started the chain C is still in");
  assert.equal(r.trash.refusal("2026-09-09", "ledger"), undefined, "A is closed, unpinned, alone");

  // The engine's word: while it holds A open (or paused), A's day stays too.
  r.openIds.push("A");
  assert.equal(r.trash.refusal("2026-09-09", "ledger"), "the open session's day");
  r.openIds.length = 0;

  // A refused move records nothing and moves nothing.
  const res = r.trash.moveDay("2026-09-08", "ledger", "retention");
  assert.deepEqual(res, { ok: false, day: "2026-09-08", what: "ledger", reason: "a pinned conversation" });
  assert.ok(existsSync(join(r.ledger.dir, "2026-09-08.jsonl")));
  assert.equal(moved(r).length, 0);

  // Once moved, the day reads "already in the Trash", and the Trash is never overwritten.
  assert.equal(r.trash.moveDay("2026-09-09", "ledger", "kevin").ok, true);
  assert.equal(r.trash.refusal("2026-09-09", "ledger"), "already in the Trash");
  writeFileSync(join(r.ledger.dir, "2026-09-09.jsonl"), "{}\n");
  assert.equal(r.trash.refusal("2026-09-09", "ledger"), "the Trash already holds that day");
  assert.equal(r.trash.restoreDay("2026-09-09").refused[0]?.reason, "a live ledger file for that day already exists");
  // Unpinned: the 8th may move now.
  r.ledger.append({ at: local(12, 9, 1), type: "conversation.pinned", chainId: "P", pinned: false });
  assert.equal(r.trash.refusal("2026-09-08", "ledger"), undefined);
});

test("trash: the sweep lists first, then moves what the windows say; 0 = never; the guards hold; the boundary day stays", () => {
  const r = rig();
  // Ledger days: 1st, 4th, 5th, 8th (pinned), 11th; shots for the 1st, 4th, 10th, 12th.
  closedSession(r, 1, "A");
  closedSession(r, 4, "B");
  closedSession(r, 5, "C");
  closedSession(r, 8, "P");
  closedSession(r, 11, "E");
  r.ledger.append({ at: local(12, 9, 0), type: "conversation.pinned", chainId: "P", pinned: true });
  shots(r, "2026-09-01");
  shots(r, "2026-09-04");
  shots(r, "2026-09-10");
  shots(r, "2026-09-12");

  // Off: nothing planned, nothing moved.
  const off = r.trash.sweep({ ledgerRetentionDays: 0, shotsRetentionDays: 0 });
  assert.deepEqual(off.cutoff, {});
  assert.deepEqual(off.moves, []);
  assert.deepEqual(off.moved, []);
  assert.equal(moved(r).length, 0);

  // Ledger 7 days (cutoff the 5th: the 5th stays, the 4th moves), shots 1 day (cutoff the 11th).
  const plan = r.trash.plan({ ledgerRetentionDays: 7, shotsRetentionDays: 1 });
  assert.deepEqual(plan.cutoff, { ledger: "2026-09-05", shots: "2026-09-11" });
  assert.deepEqual(plan.moves, [
    { day: "2026-09-01", what: "ledger" },
    { day: "2026-09-01", what: "shots" },
    { day: "2026-09-04", what: "ledger" },
    { day: "2026-09-04", what: "shots" },
    { day: "2026-09-10", what: "shots" },
  ]);
  assert.deepEqual(plan.refused, []);
  assert.equal(moved(r).length, 0, "a plan moves nothing");

  r.log.length = 0;
  const swept = r.trash.sweep({ ledgerRetentionDays: 7, shotsRetentionDays: 1 });
  assert.deepEqual(swept.moved.map((m) => [m.day, m.what]), plan.moves.map((m) => [m.day, m.what]));
  assert.deepEqual(swept.failed, []);
  // The listing came first, then the moves, in the log.
  const firstMove = r.log.findIndex((l) => /moved to the Trash \(retention\)/.test(l));
  const lastWould = r.log.map((l, i) => (/would move/.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastWould >= 0 && firstMove > lastWould, "dry run listed before anything moved");
  assert.deepEqual(r.ledger.days(), ["2026-09-05.jsonl", "2026-09-08.jsonl", "2026-09-11.jsonl", "2026-09-12.jsonl"]);
  assert.deepEqual(readdirSync(join(r.stateDir, "shots")).sort(), ["2026-09-12"]);
  assert.deepEqual((moved(r) as Extract<LedgerRow, { type: "ledger.moved" }>[]).map((m) => m.by), ["retention", "retention", "retention", "retention", "retention"]);
  assert.equal(r.trash.info().days, 3);

  // A second sweep with a wider window: the pinned 8th stays and says why; nothing else is left to move.
  const again = r.trash.sweep({ ledgerRetentionDays: 1, shotsRetentionDays: 1 });
  assert.deepEqual(again.moves, [{ day: "2026-09-05", what: "ledger" }]);
  assert.deepEqual(again.refused, [
    { day: "2026-09-08", what: "ledger", reason: "a pinned conversation" },
    { day: "2026-09-11", what: "ledger", reason: "the open session's day" },
  ].filter((x) => x.day !== "2026-09-11"), "E on the 11th is closed; only the pin keeps a day");
  assert.equal(again.moved.length, 1);
});

test("trash: a rename across devices falls back to copy + fsync + verify + rename, then removes the copy's source; a fallback that cannot finish refuses whole", () => {
  // The seam refuses the live → trash rename with EXDEV (as a trash on another volume would) and performs every other rename.
  let exdevs = 0;
  const r = rig({
    rename: (from, to) => {
      if (!from.endsWith(".partial")) {
        exdevs++;
        const e = new Error("cross-device link") as NodeJS.ErrnoException;
        e.code = "EXDEV";
        throw e;
      }
      renameSync(from, to);
    },
  });
  closedSession(r, 9, "A");
  shots(r, "2026-09-09");
  const before = readFileSync(join(r.ledger.dir, "2026-09-09.jsonl"));

  const res = r.trash.moveDay("2026-09-09", "ledger", "kevin");
  assert.equal(res.ok, true);
  assert.equal(exdevs, 1);
  const inTrash = join(r.stateDir, "trash", "ledger", "2026-09-09.jsonl");
  assert.ok(readFileSync(inTrash).equals(before), "the verified copy stands under the final name");
  assert.ok(!existsSync(`${inTrash}.partial`), "no .partial left behind");
  assert.ok(!existsSync(join(r.ledger.dir, "2026-09-09.jsonl")), "the source is gone only after the copy verified");
  // A folder goes the same way.
  assert.equal(r.trash.moveDay("2026-09-09", "shots", "kevin").ok, true);
  assert.deepEqual(readdirSync(join(r.stateDir, "trash", "shots", "2026-09-09")).sort(), ["shot_1.png", "shot_2.png"]);
  assert.ok(!existsSync(join(r.stateDir, "shots", "2026-09-09")));
  assert.equal(moved(r).length, 2);

  // Every rename fails: the copy is made, cannot be put in place, is removed — and the live file was never touched.
  const stuck = rig({
    rename: () => {
      const e = new Error("cross-device link") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    },
  });
  closedSession(stuck, 9, "A");
  const live = join(stuck.ledger.dir, "2026-09-09.jsonl");
  const bytes = readFileSync(live);
  const bad = stuck.trash.moveDay("2026-09-09", "ledger", "kevin");
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /^move failed: cross-device link/);
  assert.ok(readFileSync(live).equals(bytes), "the live file is untouched");
  assert.ok(!existsSync(join(stuck.stateDir, "trash", "ledger", "2026-09-09.jsonl")));
  assert.ok(!existsSync(join(stuck.stateDir, "trash", "ledger", "2026-09-09.jsonl.partial")));
  assert.equal(moved(stuck).length, 0, "a failed move records nothing");
});

test("trash: a shots day merges into the folder the screenshot cap already left in the Trash, and back into a live folder; a taken name refuses the whole day; a ledger day never merges; info() follows Finder", () => {
  const r = rig();
  closedSession(r, 9, "A");
  const live = shots(r, "2026-09-09"); // shot_1, shot_2
  // The cap (runner.ts evictShots) renamed one file there already: the day folder exists in the Trash before the day's turn.
  const inTrash = join(r.stateDir, "trash", "shots", "2026-09-09");
  mkdirSync(inTrash, { recursive: true });
  writeFileSync(join(inTrash, "shot_0.png"), Buffer.alloc(500, 0));
  assert.equal(r.trash.info().days, 1, "what the cap moved counts: it sits under the day folder");

  assert.equal(r.trash.refusal("2026-09-09", "shots"), undefined, "a folder already there is a merge, not a refusal");
  assert.deepEqual(r.trash.plan({ ledgerRetentionDays: 0, shotsRetentionDays: 1 }).moves, [{ day: "2026-09-09", what: "shots" }]);
  const res = r.trash.moveDay("2026-09-09", "shots", "retention");
  assert.equal(res.ok, true);
  assert.deepEqual(readdirSync(inTrash).sort(), ["shot_0.png", "shot_1.png", "shot_2.png"]);
  assert.ok(!existsSync(live), "the emptied live folder is gone");
  assert.equal(moved(r).length, 1, "one ledger.moved row for the day");
  assert.equal(r.trash.info().bytes, 3500);
  assert.equal(r.trash.refusal("2026-09-09", "shots"), "already in the Trash");
  assert.ok(r.log.some((l) => /shots 2026-09-09 merged into the Trash \(retention\)/.test(l)));

  // Restore into a live folder that exists (a screenshot landed meanwhile): the files come back beside it.
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "shot_9.png"), Buffer.alloc(100, 9));
  const back = r.trash.restoreDay("2026-09-09");
  assert.deepEqual(back.refused, []);
  assert.deepEqual(back.restored.map((m) => m.what), ["shots"]);
  assert.deepEqual(readdirSync(live).sort(), ["shot_0.png", "shot_1.png", "shot_2.png", "shot_9.png"]);
  assert.ok(!existsSync(inTrash));
  assert.equal(r.trash.info().days, 0);
  assert.deepEqual((moved(r) as Extract<LedgerRow, { type: "ledger.moved" }>[]).map((m) => m.to), ["trash", "live"]);

  // A taken name refuses the whole day, both ways; nothing moves, nothing is recorded.
  mkdirSync(inTrash, { recursive: true });
  writeFileSync(join(inTrash, "shot_1.png"), Buffer.alloc(1, 1));
  const rowsBefore = moved(r).length;
  assert.equal(r.trash.refusal("2026-09-09", "shots"), "the Trash already holds shot_1.png for that day");
  assert.equal(r.trash.moveDay("2026-09-09", "shots", "kevin").ok, false);
  assert.deepEqual(readdirSync(live).sort(), ["shot_0.png", "shot_1.png", "shot_2.png", "shot_9.png"]);
  assert.deepEqual(r.trash.restoreDay("2026-09-09").refused, [{ day: "2026-09-09", what: "shots", reason: "the live shots folder for that day already holds shot_1.png" }]);
  assert.deepEqual(readdirSync(inTrash), ["shot_1.png"]);
  assert.equal(moved(r).length, rowsBefore);
  assert.deepEqual(r.trash.plan({ ledgerRetentionDays: 0, shotsRetentionDays: 1 }).refused, [{ day: "2026-09-09", what: "shots", reason: "the Trash already holds shot_1.png for that day" }]);

  // A ledger day is one file: a second one is a conflict, never a merge.
  assert.equal(r.trash.moveDay("2026-09-09", "ledger", "kevin").ok, true);
  writeFileSync(join(r.ledger.dir, "2026-09-09.jsonl"), "{}\n");
  assert.equal(r.trash.refusal("2026-09-09", "ledger"), "the Trash already holds that day");
  assert.equal(r.trash.info().days, 1);

  // Finder emptied the Trash: info() reads 0 on the next call (the memo is keyed on the folders' mtimes, never per call).
  rmSync(join(r.stateDir, "trash", "shots"), { recursive: true, force: true });
  rmSync(join(r.stateDir, "trash", "ledger"), { recursive: true, force: true });
  assert.deepEqual(r.trash.info(), { path: join(r.stateDir, "trash"), days: 0, bytes: 0 });
});

test("trash: a merge that fails part-way moves the moved files back — the day is whole on one side or the other — and records nothing", () => {
  const stuck = rig({
    rename: (from, to) => {
      // The second file's rename INTO the Trash fails (a full disk, a permission); every other rename, the way back included, is real.
      if (from.endsWith("shot_2.png") && to.includes(`${sep}trash${sep}`)) throw new Error("EIO: i/o error");
      renameSync(from, to);
    },
  });
  closedSession(stuck, 9, "A");
  const live = shots(stuck, "2026-09-09");
  const inTrash = join(stuck.stateDir, "trash", "shots", "2026-09-09");
  mkdirSync(inTrash, { recursive: true });
  writeFileSync(join(inTrash, "shot_0.png"), Buffer.alloc(500, 0));
  const bad = stuck.trash.moveDay("2026-09-09", "shots", "kevin");
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /^move failed: EIO/);
  assert.deepEqual(readdirSync(live).sort(), ["shot_1.png", "shot_2.png"], "shot_1 came back");
  assert.deepEqual(readdirSync(inTrash), ["shot_0.png"]);
  assert.equal(moved(stuck).length, 0);
});
