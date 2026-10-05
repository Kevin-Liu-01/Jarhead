import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "@jarhead/core";
import { MAIN_THREAD_ID, SESSION_LOST_REASON, type LedgerRow, type Thread } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import { world } from "./world.ts";

/**
 * W3-1, V8 / LM-2: billed seconds survive a crash. The open session's seconds go on the ledger as a coalesced
 * `session.usage` row (the first report at once, then at most one a minute, and one at detach), so a daemon that dies
 * with a session open (SIGKILL by the app's liveness kick, a crash, power loss) leaves them behind. The next engine
 * counts that row on its meter, and its start writes the session's close before anything else (W2-5's contract):
 * `reason` SESSION_LOST_REASON, `usageSeconds` the last usage row's, `at` the newest the dead daemon wrote. Every
 * reader then counts the session once, from its closed row. Fake Live, fake clock, temp state dir; nothing is paid.
 */

type Closed = Extract<LedgerRow, { type: "session.closed" }>;
type Usage = Extract<LedgerRow, { type: "session.usage" }>;

const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
/** The meter's seconds today. */
const billed = (engine: Engine): number | undefined => engine.snapshot().usageToday?.seconds;
const DAY_MS = 86_400_000;

/** Every row of the day file `at` falls on, in file order. */
function dayRows(engine: Engine, at: number): LedgerRow[] {
  return engine.ledger.read(at);
}

test("LM-2 (audit repro): a session the process died in still counts what it billed: the next engine's meter and the walk's summary keep its 120 s", async () => {
  const w = world();
  await w.engine.start();
  await w.engine.ready();
  await w.engine.wake("test");
  w.live.reportUsage(120); // the server said: 120 s billed so far
  assert.deepEqual(w.engine.snapshot().usageToday, { seconds: 120, sessions: 1 });
  // The process dies here: no close, no row from it. A new engine is built over the same state dir.
  const again = world({}, { dir: w.dir, firstSessionId: "sess_9" });
  again.clock.t = w.clock.t;
  try {
    const meter = billed(again.engine);
    const lost = again.engine.ledger.sessions().find((s) => s.id === "sess_1");
    console.log(`[measure] after the crash: meter today ${meter} s; walk usage for the dead session ${lost?.usageSeconds}s (billed 120 s)`);
    assert.equal(meter, 120, "the meter keeps the 120 billed seconds");
    assert.equal(lost?.usageSeconds, 120, "the walk bills the dead session its last usage row");
  } finally {
    await again.engine.stop();
    await w.engine.stop();
  }
});

test("V8 (audit repro): a session that never got its closed row (the process died) keeps its 300 s on the next engine's meter", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    a.live.reportUsage(300); // five minutes billed so far
    assert.equal(billed(a.engine), 300);
    // SIGKILL: no stop(), no closed row. A new process starts over the same state dir.
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t + 5_000;
    await b.engine.start();
    await b.engine.ready();
    const seen = b.engine.snapshot().usageToday;
    console.log(`[V8] engine A had billed 300 s; engine B's meter reads ${seen?.seconds} s over ${seen?.sessions} session(s)`);
    assert.equal(seen?.seconds, 300, "the billed seconds stay on the meter, counted once");
  } finally {
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("V8 / LM-2: a usage row at the first report, then at most one a minute (the open seconds, never less than the server said), one at detach, none after the close", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const opened = clock.t;
    const usage = (): Usage[] => dayRows(engine, clock.t).filter((r): r is Usage => r.type === "session.usage");
    clock.t += 10_000;
    live.reportUsage(4); // the server is late: 10 s have been open
    assert.deepEqual(usage().map((r) => [r.sessionId, r.usageSeconds, r.at - opened]), [["sess_1", 10, 10_000]], "the first report is written at once, at the seconds the session has been open");
    clock.t += 20_000;
    live.reportUsage(30);
    tick(engine);
    assert.equal(usage().length, 1, "inside the minute: coalesced");
    clock.t += 45_000;
    tick(engine); // 65 s after the last row, 75 s open
    assert.deepEqual(usage().map((r) => r.usageSeconds), [10, 75], "a minute on, the tick writes the open seconds with no report");
    clock.t += 30_000;
    live.reportUsage(200); // the server's figure leads the clock
    tick(engine);
    assert.equal(usage().length, 2, "a report inside the minute waits");
    clock.t += 31_000;
    tick(engine);
    assert.deepEqual(usage().map((r) => r.usageSeconds), [10, 75, 200], "never less than the server said");
    clock.t += 70_000;
    await engine.command({ type: "pause" }); // detach: the last word, then the close
    const rows = dayRows(engine, clock.t);
    const last = usage().at(-1)!;
    assert.equal(last.usageSeconds, 206, "at detach: the 206 s the session was open");
    const closedAt = rows.findIndex((r) => r.type === "session.closed" && r.sessionId === "sess_1");
    assert.ok(closedAt >= 0, "the session closed");
    assert.ok(rows.indexOf(last) < closedAt, "the detach row comes before the close");
    assert.equal(rows.slice(closedAt).filter((r) => r.type === "session.usage").length, 0, "nothing after the close");
    // The meter counts the session once, from its closed row, however many usage rows it left.
    const closed = rows[closedAt] as Closed;
    assert.equal(billed(engine), closed.usageSeconds);
    (engine as unknown as { loadUsageToday(): void }).loadUsageToday();
    assert.equal(billed(engine), closed.usageSeconds, "re-read from the day file: the closed row, not the usage rows on top");
  } finally {
    await engine.stop();
  }
});

test("V8 / LM-2 (W2-5's contract): the start writes the lost close before anything else, with the last usage row's seconds, at the newest `at` the dead daemon wrote; the walk, the meter and a re-read count it once; an engine that is only built writes nothing", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    a.clock.t += 2_000;
    a.live.reportUsage(2);
    a.clock.t += 61_000;
    tick(a.engine); // 63 s open: the second usage row
    // The dead daemon's last write is not the session's: a row 40 s later, then SIGKILL.
    const lastWrite = a.clock.t + 40_000;
    a.engine.ledger.append({ at: lastWrite, type: "problem", text: "the last thing the dead daemon wrote" });
    const before = dayRows(a.engine, a.clock.t).length;
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = lastWrite + 10_000;
    assert.equal(dayRows(b.engine, b.clock.t).length, before, "built, not started: nothing written");
    assert.equal(billed(b.engine), 63, "the meter reads the last usage row before the start");
    await b.engine.start();
    const rows = dayRows(b.engine, b.clock.t);
    const close = rows[before] as Closed;
    assert.deepEqual(close, { at: lastWrite, type: "session.closed", sessionId: "sess_1", reason: SESSION_LOST_REASON, usageSeconds: 63 }, "the first row the start writes");
    assert.ok(rows.slice(0, before).every((r) => r.at <= close.at), "it sorts after every row the dead daemon wrote");
    assert.equal(rows.filter((r) => r.type === "session.closed" && r.sessionId === "sess_1").length, 1, "one close");
    const lost = b.engine.ledger.sessions().find((s) => s.id === "sess_1");
    assert.equal(lost?.reason, SESSION_LOST_REASON);
    assert.equal(lost?.usageSeconds, 63);
    assert.equal(lost?.closedAt, lastWrite);
    assert.equal(billed(b.engine), 63, "counted once");
    (b.engine as unknown as { loadUsageToday(): void }).loadUsageToday();
    assert.equal(billed(b.engine), 63, "a re-read counts the closed row, never the usage rows as well");
    // A second start over the same dir finds nothing open: nothing more is written.
    const c = world({}, { dir: a.dir, firstSessionId: "sess_c" });
    c.clock.t = b.clock.t + 1_000;
    try {
      const count = dayRows(c.engine, c.clock.t).length;
      await c.engine.start();
      assert.equal(dayRows(c.engine, c.clock.t).filter((r) => r.type === "session.closed").length, rows.filter((r) => r.type === "session.closed").length);
      assert.ok(dayRows(c.engine, c.clock.t).length >= count);
    } finally {
      await c.engine.stop();
    }
  } finally {
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("V8 / LM-2: a restart days later puts the lost close in the dead daemon's last day file, not today's; a session with no usage row closes at 0 s", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    a.clock.t += 3_000; // no report from the server before the crash
    const deadDay = Ledger.dayFor(a.clock.t);
    const newest = Math.max(...dayRows(a.engine, a.clock.t).map((r) => r.at));
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t + 2 * DAY_MS;
    await b.engine.start();
    const there = dayRows(b.engine, a.clock.t).filter((r): r is Closed => r.type === "session.closed");
    assert.deepEqual(there, [{ at: newest, type: "session.closed", sessionId: "sess_1", reason: SESSION_LOST_REASON, usageSeconds: 0 }], `in ${deadDay}, at its newest row`);
    assert.equal(dayRows(b.engine, b.clock.t).filter((r) => r.type === "session.closed").length, 0, "today's file holds no close for it");
    assert.equal(billed(b.engine), 0, "today's meter: nothing from two days ago");
  } finally {
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("V8 / LM-2 (review): `jarhead live` beside a running daemon closes nothing of the daemon's: its open session gets one close, the real one, and the day bills it once; its live thread gets no thread.ended", async () => {
  const d = world(); // the daemon's engine: it holds the state dir
  let cli: ReturnType<typeof world> | undefined;
  let fresh: ReturnType<typeof world> | undefined;
  try {
    await d.engine.start();
    await d.engine.ready();
    d.engine.updateSettings({ idleSleepMinutes: 0 });
    await d.engine.wake("test");
    d.clock.t += 2_000;
    d.live.reportUsage(120);
    const at = d.clock.t;
    const spotify: Thread = { id: "t_live", name: "Spotify", lane: "background", status: "thinking", parentId: MAIN_THREAD_ID, parentDelegationId: "dlg_p", liveId: "item_x", task: "play Focus", apps: [], startedAt: at, updatedAt: at, turns: 1, steps: 2, waits: 0, budget: { steps: 25, seconds: 180 }, canSay: true, canStop: true };
    d.engine.ledger.append({ at, type: "thread.started", thread: spotify });
    // `jarhead live` (cli/main.ts withEngine) builds its own engine over the same state dir: it does not hold the lock.
    cli = world({ ownsStateDir: false }, { dir: d.dir, firstSessionId: "sess_cli" });
    cli.clock.t = d.clock.t + 1_000;
    await cli.engine.start();
    assert.equal(billed(cli.engine), 120, "the CLI's meter counts the daemon's open session once, by its usage row");
    await cli.engine.stop();
    // The daemon's session goes on, then closes for real.
    d.clock.t += 60_000;
    d.live.reportUsage(180);
    await d.engine.command({ type: "pause" });
    const rows = dayRows(d.engine, d.clock.t);
    const closes = rows.filter((r): r is Closed => r.type === "session.closed" && r.sessionId === "sess_1");
    assert.equal(closes.length, 1, "one close for one session");
    assert.notEqual(closes[0]!.reason, SESSION_LOST_REASON, "the daemon's own, not a lost one");
    assert.equal(closes[0]!.usageSeconds, 180);
    assert.equal(rows.filter((r) => r.type === "thread.ended" && r.threadId === "t_live").length, 0, "the daemon's live thread was not ended by the CLI");
    fresh = world({ ownsStateDir: false }, { dir: d.dir, firstSessionId: "sess_z" });
    fresh.clock.t = d.clock.t + 1_000;
    const meter = fresh.engine.snapshot().usageToday;
    const summary = fresh.engine.ledger.sessions().find((x) => x.id === "sess_1");
    console.log(`[review] a CLI engine started beside the daemon's open session: closes ${closes.length}; a fresh engine's meter ${meter?.seconds} s; walk ${summary?.reason} ${summary?.usageSeconds} s`);
    assert.equal(meter?.seconds, 180, "the day bills the session once");
    assert.equal(summary?.usageSeconds, 180);
  } finally {
    await fresh?.engine.stop();
    await cli?.engine.stop();
    await d.engine.stop();
  }
});

test("V8 / LM-2 (review): a lost close that cannot be written (a full or read-only disk) is logged and skipped; the start still resolves, and the next start closes the session once", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  let c: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    a.clock.t += 2_000;
    a.live.reportUsage(42);
    // SIGKILL. The next start cannot write its close: the disk is full.
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t + 5_000;
    const ledger = b.engine.ledger as unknown as { append(row: LedgerRow): void };
    const append = ledger.append.bind(ledger);
    let refused = 0;
    ledger.append = (row) => {
      if (row.type !== "session.closed") return append(row);
      refused++;
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    };
    await b.engine.start(); // resolves: the daemon is up
    await b.engine.stop();
    assert.equal(refused, 1, "the close was tried once");
    assert.equal(dayRows(a.engine, a.clock.t).filter((r) => r.type === "session.closed" && r.sessionId === "sess_1").length, 0, "nothing closed yet");
    // A start that can write closes it, once.
    c = world({}, { dir: a.dir, firstSessionId: "sess_c" });
    c.clock.t = b.clock.t + 5_000;
    await c.engine.start();
    const closes = dayRows(c.engine, a.clock.t).filter((r): r is Closed => r.type === "session.closed" && r.sessionId === "sess_1");
    assert.deepEqual(closes.map((x) => [x.reason, x.usageSeconds]), [[SESSION_LOST_REASON, 42]]);
  } finally {
    await c?.engine.stop();
    await b?.engine.stop();
    await a.engine.stop();
  }
});
