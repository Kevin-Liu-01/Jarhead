import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeHands } from "@jarhead/hands";
import { Ledger, Trash } from "@jarhead/core";
import type { LedgerRow } from "@jarhead/protocol";
import { SHOTS_CAP } from "../runner.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * K5 (2026-09-12): the screenshot archive in ToolRunner.archive().
 *   - identical PNG bytes within one delegation are archived once (the same path comes back)
 *   - a new delegation archives the same bytes again (the dedupe is per task)
 *   - past the cap the oldest files MOVE to <stateDir>/trash/shots/<day>/ by rename — never unlinked
 *   - every move is recorded: a manifest line per file, a `ledger.moved` row per day touched
 *   - the Trash (core's whole-day unit) still moves and restores a day the cap has started
 */

/** Hands whose screenshot bytes the test chooses. */
class ShotHands implements NativeHands {
  ready = true;
  png = "AAAA";
  async request<T>(op: string): Promise<T> {
    if (op === "screenshot") return { displayId: 1, pngBase64: this.png, width: 10, height: 5, points: { x: 0, y: 0, w: 20, h: 10 }, scale: 0.5 } as T;
    return {} as T;
  }
}

function shotFiles(dir: string): string[] {
  const root = join(dir, "shots");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((day) => readdirSync(join(root, day)).map((f) => `${day}/${f}`));
}

function trashFiles(dir: string): string[] {
  const root = join(dir, "trash", "shots");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((day) => readdirSync(join(root, day)).map((f) => `${day}/${f}`));
}

test("archive: the same frame twice in one delegation is one file; a new delegation archives it again", async () => {
  const hands = new ShotHands();
  const { runner, dir } = makeRunner({}, hands);
  const log = makeSink();
  runner.attach(log.sink, makeTask("look at the screen"));

  const a = await runner.run("screenshot", {});
  const b = await runner.run("screenshot", {});
  assert.ok(a.screenshotPath && b.screenshotPath);
  assert.equal(a.screenshotPath, b.screenshotPath, "identical bytes → the same archived path");
  assert.equal(shotFiles(dir).length, 1);
  assert.equal(log.steps.filter((s) => s.startsWith("shot:")).length, 2, "the timeline still shows both looks");

  hands.png = "BBBB";
  const c = await runner.run("screenshot", {});
  assert.notEqual(c.screenshotPath, a.screenshotPath);
  assert.equal(shotFiles(dir).length, 2);

  // The next delegation starts its own set: the first frame is archived anew.
  runner.attach(log.sink, makeTask("look again"));
  hands.png = "AAAA";
  const d = await runner.run("screenshot", {});
  assert.notEqual(d.screenshotPath, a.screenshotPath);
  assert.equal(shotFiles(dir).length, 3);
});

test("archive: past the cap the oldest files move to trash/shots by rename, oldest first, and nothing is unlinked", async () => {
  const hands = new ShotHands();
  const { runner, dir } = makeRunner({ shotsCap: { files: 3, bytes: SHOTS_CAP.bytes } }, hands);
  runner.attach(makeSink().sink, makeTask("look"));

  // Two old files from an earlier day, already on disk before the runner ever looked.
  const oldDay = join(dir, "shots", "2026-01-01");
  mkdirSync(oldDay, { recursive: true });
  for (const [name, hoursAgo] of [["shot_old1.png", 48], ["shot_old2.png", 47]] as const) {
    const p = join(oldDay, name);
    writeFileSync(p, Buffer.from("old"));
    const t = new Date(Date.now() - hoursAgo * 3600_000);
    utimesSync(p, t, t);
  }

  hands.png = "AAAA";
  await runner.run("screenshot", {});
  assert.equal(shotFiles(dir).length, 3, "at the cap: nothing moves yet");
  assert.equal(trashFiles(dir).length, 0);

  hands.png = "BBBB";
  await runner.run("screenshot", {});
  assert.equal(shotFiles(dir).length, 3);
  assert.deepEqual(trashFiles(dir), ["2026-01-01/shot_old1.png"], "the oldest moved, into the trash's shots/<day>/");
  assert.equal(Buffer.from("old").toString(), "old");

  hands.png = "CCCC";
  await runner.run("screenshot", {});
  assert.deepEqual(trashFiles(dir).sort(), ["2026-01-01/shot_old1.png", "2026-01-01/shot_old2.png"]);
  assert.ok(!existsSync(oldDay), "the emptied live day folder is gone (rmdir of an empty folder; its files are in the trash)");
  assert.equal(shotFiles(dir).length, 3);

  // Bytes are the same file: moved, not copied and deleted.
  assert.equal(readdirSync(join(dir, "trash", "shots", "2026-01-01")).length, 2);
});

test("archive: every eviction is recorded — a manifest line per file in the Trash's shape, one ledger.moved row per day touched — and the Trash still moves and restores that day whole", async () => {
  const hands = new ShotHands();
  const rows: LedgerRow[] = [];
  const { runner, dir } = makeRunner({ shotsCap: { files: 2, bytes: SHOTS_CAP.bytes }, ledger: { append: (row: LedgerRow) => rows.push(row) } as unknown as Ledger }, hands);
  runner.attach(makeSink().sink, makeTask("look"));

  // Three old files from an earlier day.
  const oldDay = join(dir, "shots", "2026-01-01");
  mkdirSync(oldDay, { recursive: true });
  for (const [name, hoursAgo] of [["shot_a.png", 50], ["shot_b.png", 49], ["shot_c.png", 48]] as const) {
    const p = join(oldDay, name);
    writeFileSync(p, Buffer.from(name));
    const t = new Date(Date.now() - hoursAgo * 3600_000);
    utimesSync(p, t, t);
  }

  hands.png = "AAAA";
  await runner.run("screenshot", {});
  // Four files, cap two: the two oldest of 2026-01-01 moved in one pass; one stays live.
  assert.deepEqual(trashFiles(dir).sort(), ["2026-01-01/shot_a.png", "2026-01-01/shot_b.png"]);
  assert.deepEqual(readdirSync(oldDay), ["shot_c.png"], "the day is now in both places");

  // The manifest: one line per file, the Trash's own record shape.
  const manifest = readFileSync(join(dir, "trash", "manifest.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(manifest.length, 2);
  for (const [i, name] of ["shot_a.png", "shot_b.png"].entries()) {
    const line = manifest[i]!;
    assert.equal(line["day"], "2026-01-01");
    assert.equal(line["what"], "shots");
    assert.equal(line["to"], "trash");
    assert.equal(line["by"], "retention");
    assert.equal(line["from"], join(oldDay, name));
    assert.equal(line["path"], join(dir, "trash", "shots", "2026-01-01", name));
    assert.equal(typeof line["at"], "number");
  }
  // The ledger: one row for the day, not one per file.
  const moved = rows.filter((r) => r.type === "ledger.moved");
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0], { at: (moved[0] as { at: number }).at, type: "ledger.moved", day: "2026-01-01", what: "shots", to: "trash", path: join(dir, "trash", "shots", "2026-01-01"), by: "retention" });

  // The Trash's unit is the whole day: a day the cap has started still moves (merging into what is there) and restores (merging back).
  const trash = new Trash(dir, new Ledger(dir));
  assert.equal(trash.refusal("2026-01-01", "shots"), undefined, "a folder already in the Trash is a merge, not a refusal");
  assert.deepEqual(trash.plan({ ledgerRetentionDays: 0, shotsRetentionDays: 14 }).refused.filter((r) => r.day === "2026-01-01"), [], "the retention sweep is not blocked");
  const res = trash.moveDay("2026-01-01", "shots", "retention");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(readdirSync(join(dir, "trash", "shots", "2026-01-01")).sort(), ["shot_a.png", "shot_b.png", "shot_c.png"]);
  assert.ok(!existsSync(oldDay), "the emptied live folder is gone");
  const back = trash.restoreDay("2026-01-01");
  assert.deepEqual(back.refused, []);
  assert.deepEqual(readdirSync(oldDay).sort(), ["shot_a.png", "shot_b.png", "shot_c.png"], "restored whole");
  for (const name of ["shot_a.png", "shot_b.png", "shot_c.png"]) assert.equal(readFileSync(join(oldDay, name), "utf8"), name, "the same bytes: moved, never copied and deleted");
  assert.equal(trash.info().days, 0);
});

test("archive: the byte cap works the same way", async () => {
  const hands = new ShotHands();
  // Each fake PNG is 3 bytes ("AAAA" → 3 bytes); a 7-byte cap keeps two.
  const { runner, dir } = makeRunner({ shotsCap: { files: 400, bytes: 7 } }, hands);
  runner.attach(makeSink().sink, makeTask("look"));
  for (const png of ["AAAA", "BBBB", "CCCC", "DDDD"]) {
    hands.png = png;
    await runner.run("screenshot", {});
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(shotFiles(dir).length, 2);
  assert.equal(trashFiles(dir).length, 2);
});
