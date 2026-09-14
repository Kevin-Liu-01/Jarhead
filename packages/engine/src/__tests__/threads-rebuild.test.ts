import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { MAIN_THREAD_ID, THREAD_LINGER_MS, type Delegation, type LedgerRow, type Thread } from "@jarhead/protocol";
import { RESTART_REASON, ThreadTable } from "../threads/table.ts";
import { world } from "./world.ts";

/**
 * A daemon that restarts over a state dir whose day files hold a live thread: the
 * table is rebuilt from the rows (yesterday's file too — a thread may cross
 * midnight), the thread is ended `failed` with RESTART_REASON, exactly one
 * `thread.ended` row is appended per orphan, nothing acts (no brain, no hands are
 * ever touched here), and the thread shows in the summaries within the linger. A
 * second rebuild over the same files appends nothing.
 */

/** What a day file written before 2026-09-13 holds that no writer produces now: a row of the retired type and a step tagged with the old key. Built here once, as JSON, the way Ledger.parse meets it. */
function oldDayRows(now: number): LedgerRow[] {
  const rows = `[{"at":${now - 8000},"type":"worker","worker":{"id":"w_old","name":"Spotify","delegationId":"dlg_old","task":"play Focus","lane":"background","status":"working","startedAt":${now - 8000},"steps":1}},{"at":${now - 7000},"type":"delegation.step","delegationId":"dlg_old","step":{"id":"s_old","at":${now - 7000},"kind":"note","text":"Spotify: on it.","worker":"Spotify"}}]`; // before 2026-09-13
  return JSON.parse(rows) as LedgerRow[];
}

function mk(id: string, name: string, at: number, extra: Partial<Thread> = {}): Thread {
  return { id, name, lane: "background", status: "starting", parentId: MAIN_THREAD_ID, parentDelegationId: "dlg_p", liveId: "item_1", task: `${name}'s job`, apps: [], startedAt: at, updatedAt: at, turns: 0, steps: 0, waits: 0, budget: { steps: 25, seconds: 180 }, canSay: true, canStop: true, ...extra };
}

test("rebuildFrom(ledger): a thread live in yesterday's file and one live in today's each get one thread.ended {failed, 'the daemon restarted'} row; finished ones are read as they were; the orphans show within the linger; a second rebuild appends nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-threads-rebuild-"));
  const ledger = new Ledger(dir);
  // "now" is 00:02 local on a day; yesterday's rows sit in the previous file.
  const now = new Date(2026, 8, 13, 0, 2, 0).getTime();
  const yesterday = now - 3 * 3600_000; // 21:02 the day before
  assert.notEqual(Ledger.dayFor(yesterday), Ledger.dayFor(now), "the fixture crosses midnight");
  const a = mk("t_a", "Spotify", yesterday);
  ledger.append({ at: yesterday, type: "thread.started", thread: a });
  const dlg = { id: "dlg_a1", liveId: "item_1", createdAt: yesterday, offsetMs: 0, request: "play focus on spotify", status: "running" as const, steps: [], timings: { delegatedAt: yesterday }, threadId: "t_a" };
  ledger.append({ at: yesterday, type: "delegation.created", delegation: dlg });
  for (let i = 0; i < 4; i++) ledger.append({ at: yesterday + 1000 * (i + 1), type: "delegation.step", delegationId: dlg.id, step: { id: `s${i}`, at: yesterday + 1000 * (i + 1), kind: "tool", tool: { name: "applescript", input: {}, ok: true, ms: 4 } } });
  ledger.append({ at: yesterday + 5000, type: "thread.said", threadId: "t_a", text: "Spotify: on it." });
  const b = mk("t_b", "Slack", yesterday + 6000, { lane: "screen" });
  ledger.append({ at: yesterday + 6000, type: "thread.started", thread: b });
  ledger.append({ at: yesterday + 7000, type: "thread.status", threadId: "t_b", status: "waiting-kevin", detail: "send it to Ben?" });
  ledger.append({ at: now - 60_000, type: "thread.ended", threadId: "t_b", status: "stopped", summary: "Kevin stopped it", steps: 2, seconds: 9000 });
  const c = mk("t_c", "Mail", now - 30_000);
  ledger.append({ at: now - 30_000, type: "thread.started", thread: c });
  ledger.append({ at: now - 20_000, type: "thread.status", threadId: "t_c", status: "waiting-screen", detail: "jarhead has the screen" });
  const before = ledger.read(now).length + ledger.read(yesterday).length;

  const { table, orphans, rows } = ThreadTable.rebuildFrom(ledger, { now: () => now });
  assert.deepEqual(orphans.map((t) => t.id).sort(), ["t_a", "t_c"], "the two live when the daemon died, one from each day file");
  assert.equal(rows.length, 2, "one row each");
  for (const r of rows) {
    assert.equal(r.type, "thread.ended");
    assert.equal(r.status, "failed");
    assert.equal(r.summary, RESTART_REASON);
    assert.equal(r.at, now);
  }
  const appended = [...ledger.read(yesterday), ...ledger.read(now)];
  assert.equal(appended.length, before + 2, "exactly the two rows were written");
  const written = appended.filter((r): r is Extract<LedgerRow, { type: "thread.ended" }> => r.type === "thread.ended" && r.summary === RESTART_REASON);
  assert.deepEqual(written.map((r) => r.threadId).sort(), ["t_a", "t_c"]);
  assert.equal(written.find((r) => r.threadId === "t_a")!.steps, 4, "steps recounted from its own delegation rows");
  assert.ok(written.every((r) => Ledger.dayFor(r.at) === Ledger.dayFor(now)), "appended to TODAY's file");

  assert.equal(table.get("t_a")!.status, "failed");
  assert.equal(table.get("t_a")!.detail, RESTART_REASON);
  assert.equal(table.get("t_a")!.steps, 4);
  assert.equal(table.get("t_a")!.turns, 1);
  assert.equal(table.get("t_b")!.status, "stopped", "read back as it ended");
  assert.equal(table.get("t_b")!.doneAt, now - 60_000, "with its own clock");
  assert.equal(table.get("t_b")!.detail, "Kevin stopped it");
  assert.equal(table.get("t_b")!.steps, 2);
  assert.equal(table.get("t_c")!.status, "failed");
  assert.equal(table.liveCount(), 0, "nothing is live: nothing acts");
  const shown = table.summaries(now).map((t) => t.id);
  assert.ok(shown.includes("t_a") && shown.includes("t_c"), "the orphans show within the linger");
  assert.ok(!shown.includes("t_b"), "a thread that ended a minute ago is past the linger");
  assert.equal(table.statusLine("mail"), `Mail failed: ${RESTART_REASON}`);
  assert.equal(table.statusLine(), "nothing is running");
  assert.equal(table.summaries(now + THREAD_LINGER_MS + 1).length, 0);

  // The daemon restarts again a minute later: the ended rows are there, so nothing is an orphan.
  const again = ThreadTable.rebuildFrom(ledger, { now: () => now + 60_000 });
  assert.equal(again.orphans.length, 0);
  assert.equal(again.rows.length, 0);
  assert.equal([...ledger.read(yesterday), ...ledger.read(now)].length, before + 2, "no third row");
  assert.equal(again.table.get("t_a")!.status, "failed");
});

test("rebuild keeps the main thread: a `thread.started` for main comes back idle, never failed, with no row appended", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-threads-rebuild-"));
  const ledger = new Ledger(dir);
  const now = Date.now();
  const main: Thread = { ...mk(MAIN_THREAD_ID, "Jarhead", now - 5000), lane: "voice", status: "acting", task: "" };
  ledger.append({ at: now - 5000, type: "thread.started", thread: main });
  const { table, orphans, rows } = ThreadTable.rebuildFrom(ledger, { now: () => now });
  assert.equal(orphans.length, 0);
  assert.equal(rows.length, 0);
  assert.equal(table.get(MAIN_THREAD_ID)!.status, "idle");
  assert.equal(table.liveCount(), 1);
  assert.equal(table.spawnedLiveCount(), 0);
  assert.equal(ledger.read(now).length, 1, "nothing appended");
});

test("before 2026-09-13: day files hold `worker` rows and `delegation.step` rows whose step says `worker` — rebuild skips both, yields no thread and does not throw; the step is main's (no tag) on a replay", () => {
  const now = Date.now();
  const dlg: Delegation = { id: "dlg_old", liveId: "item_old", createdAt: now - 9000, offsetMs: 0, request: "play focus on spotify", status: "done", steps: [], timings: { delegatedAt: now - 9000 } };
  const oldRows: LedgerRow[] = [
    { at: now - 9000, type: "delegation.created", delegation: dlg },
    ...oldDayRows(now),
    { at: now - 6000, type: "delegation.step", delegationId: "dlg_old", step: { id: "s_old2", at: now - 6000, kind: "tool", tool: { name: "applescript", input: {}, ok: true, ms: 4 } } },
    { at: now - 5000, type: "session.started", sessionId: "live_old", voice: "cedar" } as unknown as LedgerRow,
  ];
  const { table, orphans, rows } = ThreadTable.rebuild(oldRows, { now: () => now });
  assert.equal(orphans.length, 0, "a row of the retired type is not a thread");
  assert.equal(rows.length, 0, "nothing to end, nothing appended");
  assert.equal(table.summaries(now).length, 0);
  assert.equal(table.liveCount(), 0);
  assert.equal(table.byNameRecent("spotify"), undefined);
  assert.equal(table.statusLine(), "nothing is running");
  // The old step's tag is not `thread`: every reader of DelegationStep.thread sees main's step.
  const step = (oldRows[2] as Extract<LedgerRow, { type: "delegation.step" }>).step;
  assert.equal(step.kind, "note");
  assert.equal(step.thread, undefined, "no [Name] tag on a step from before the rename");
  // A torn last line never reaches rebuild (Ledger.parse skips it); a row of a type nobody knows is skipped the same way.
  assert.doesNotThrow(() => ThreadTable.rebuild([...oldRows, { at: now, type: "nothing.known" } as unknown as LedgerRow], { now: () => now }));
});

test("before 2026-09-13: an engine starting over a state dir whose day file holds those old rows rebuilds its table without a thread and reads the day (usage, sessions) without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-threads-rebuild-old-"));
  // The world's clock starts here (world.ts); the rows sit on that day so the engine's day reads find them.
  const now = 1_757_500_000_000;
  // The world's engine keeps its state under <dir>/state (world.ts).
  const ledger = new Ledger(join(dir, "state"));
  const oldRows: LedgerRow[] = [
    { at: now - 9000, type: "delegation.created", delegation: { id: "dlg_old", liveId: "item_old", createdAt: now - 9000, offsetMs: 0, request: "play focus on spotify", status: "done", steps: [], timings: { delegatedAt: now - 9000 } } },
    ...oldDayRows(now),
    { at: now - 5000, type: "session.started", sessionId: "live_old", voice: "cedar" } as unknown as LedgerRow,
    { at: now - 4000, type: "session.closed", sessionId: "live_old", reason: "sleep", usageSeconds: 3 } as unknown as LedgerRow,
  ];
  for (const row of oldRows) ledger.append(row);
  const w = world({}, { dir });
  try {
    await w.engine.start();
    const snap = w.engine.snapshot();
    assert.deepEqual(snap.threads.map((t) => t.id), [MAIN_THREAD_ID], "the retired row is not a thread; main is the table's only record");
    assert.equal(w.engine.ledger.read(now).length, 5, "every old row still reads; Ledger.parse is not a schema check");
    assert.equal(ledger.read(now).filter((r) => r.type === "thread.ended").length, 0, "nothing to end, nothing appended");
  } finally {
    await w.engine.stop();
  }
});
