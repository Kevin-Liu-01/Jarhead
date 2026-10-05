// W3-3 on the socket, over a real Ledger in a temp state dir:
// - LM-6: the `ledger.days` reply carries every day's totals, not only the days the Console opened. A session counts
//   once, in the day file of the row that carries its seconds: its last session.closed row (a lost close included),
//   else its last session.usage row. Never both. The totals follow an append.
// - Search older: `ledger.search` answers one page (Ledger.searchPage), `older` names where the page stopped, and a
//   request with that `before` reads on from there. A ledger with no searchPage (a fake) still answers in one read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { SESSION_LOST_REASON, type LedgerDayTotals, type LedgerRow } from "@jarhead/protocol";
import { DaemonServer, DayTotals, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";
import type { DaemonMessage } from "../wire.ts";

/** A local instant on a day of September 2026: the day file a row lands in is its local day. */
const on = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime();

/** The least engine a live server needs, over the given ledger. */
function engineOver(ledger: EngineLike["ledger"], stateDir: string): EngineLike {
  const none = (): unknown[] => [];
  return {
    on: () => undefined,
    snapshot: () => ({ phase: "asleep" }),
    command: async () => undefined,
    feedMic: () => undefined,
    reportInputLevel: () => undefined,
    setPermission: () => undefined,
    setPermissions: () => undefined,
    registerOwnPid: () => undefined,
    ear: () => undefined,
    problem: () => undefined,
    ledger,
    memory: { list: none, search: async () => [] },
    dropViewers: () => undefined,
    config: { stateDir },
    runner: { run: async () => ({ result: { kind: "text", text: "" } }) },
    runnerFor: () => undefined,
  };
}

/** Wait until the socket delivered what the test expects: a fixed pause is too short under a loaded full run. */
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withServer(engine: EngineLike, run: (ask: (message: Record<string, unknown>) => Promise<DaemonMessage>) => Promise<void>, searchPageBytes?: number): Promise<void> {
  const path = join(mkdtempSync(join(tmpdir(), "jh-w33-sock-")), "d.sock");
  const server = new DaemonServer(engine, path, searchPageBytes !== undefined ? { searchPageBytes } : {});
  await server.listen();
  const client = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  client.on("message", (m) => got.push(m));
  let n = 0;
  const ask = async (message: Record<string, unknown>): Promise<DaemonMessage> => {
    const id = `q${++n}`;
    client.sendJson({ ...message, id } as never);
    await until(() => got.some((m) => (m as { id?: string }).id === id), `the answer to ${String(message["type"])} ${id}`);
    return got.find((m) => (m as { id?: string }).id === id) as DaemonMessage;
  };
  try {
    await client.connect({ pid: 1, audio: true });
    await run(ask);
  } finally {
    client.close();
    await server.close();
  }
}

const started = (at: number, sessionId: string): LedgerRow => ({ at, type: "session.started", sessionId, voice: "ballad" });
const closed = (at: number, sessionId: string, usageSeconds: number, reason = "close_requested"): LedgerRow => ({ at, type: "session.closed", sessionId, reason, usageSeconds });
const usage = (at: number, sessionId: string, usageSeconds: number): LedgerRow => ({ at, type: "session.usage", sessionId, usageSeconds });
const heard = (at: number, text: string): LedgerRow => ({ at, type: "heard", item: { id: `u_${at}`, speaker: "kevin", text, startMs: 0, endMs: 1, at, final: true } });

/**
 * Three days. Sep 8: s1 (100 s), s2 starts at 23:58. Sep 9: s2 closes (50 s, crossing midnight), s3 bills 60 then 120 and
 * its daemon dies (a lost close repeats 120), s4 opens and bills 30. Sep 10: s4 bills 90 (still open), an old close
 * with no session id bills 7.
 */
function history(stateDir: string): Ledger {
  const ledger = new Ledger(stateDir);
  for (const row of [
    started(on(8, 9), "s1"),
    heard(on(8, 9, 1), "the needle on the eighth"),
    closed(on(8, 10), "s1", 100),
    started(on(8, 23, 58), "s2"),
    closed(on(9, 0, 3), "s2", 50),
    started(on(9, 9), "s3"),
    usage(on(9, 9, 1), "s3", 60),
    heard(on(9, 9, 2), "the needle on the ninth"),
    usage(on(9, 9, 2), "s3", 120),
    closed(on(9, 9, 3), "s3", 120, SESSION_LOST_REASON),
    started(on(9, 20), "s4"),
    usage(on(9, 20, 1), "s4", 30),
    usage(on(10, 8), "s4", 90),
    heard(on(10, 8, 1), "the needle on the tenth"),
  ]) ledger.append(row);
  // A close as day files before 2026-09-13 hold it: no session to dedupe it by, so it counts on its own.
  appendFileSync(join(ledger.dir, "2026-09-10.jsonl"), `${JSON.stringify({ at: on(10, 9), type: "session.closed", sessionId: "?", reason: "idle", usageSeconds: 7 })}\n`);
  return ledger;
}

test("LM-6: ledger.days carries every day's totals: each session once, in the file of the row that carries its seconds (its last close, else its last usage row); never both; an append moves them", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-w33-days-"));
  const ledger = history(stateDir);
  await withServer(engineOver(ledger, stateDir), async (ask) => {
    const first = (await ask({ type: "ledger.days" })) as Extract<DaemonMessage, { type: "ledger.days" }>;
    assert.deepEqual(first.days, ["2026-09-10", "2026-09-09", "2026-09-08"], "the day list, newest first, as before");
    assert.deepEqual(first.totals, [
      { day: "2026-09-10", sessions: 0, billedSeconds: 97 },
      { day: "2026-09-09", sessions: 2, billedSeconds: 170 },
      { day: "2026-09-08", sessions: 2, billedSeconds: 100 },
    ] satisfies LedgerDayTotals[], "s2's 50 s on the 9th (its close), s3's 120 s once (the lost close, not its usage rows), s4's open 90 s on the 10th, the unnamed close's 7 s");

    // s4 closes on the 10th: its seconds are its close's now, and its usage row on the 9th no longer counts anywhere.
    ledger.append(closed(on(10, 9, 30), "s4", 95));
    const second = (await ask({ type: "ledger.days" })) as Extract<DaemonMessage, { type: "ledger.days" }>;
    assert.deepEqual(second.totals?.map((t) => t.billedSeconds), [102, 170, 100], "the 10th re-read after the append; the other days unchanged");
  });
});

test("LM-6: DayTotals keeps a file while it is unchanged, reads zero for a day whose file left, and skips a torn line", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-w33-tally-"));
  const ledger = history(stateDir);
  appendFileSync(join(ledger.dir, "2026-09-08.jsonl"), '{"at":1,"type":"session.closed","sessionId":"s9","usageSec');
  const totals = new DayTotals(ledger.dir);
  const a = await totals.totals(["2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07"]);
  assert.deepEqual(a.map((t) => [t.day, t.sessions, t.billedSeconds]), [
    ["2026-09-10", 0, 97],
    ["2026-09-09", 2, 170],
    ["2026-09-08", 2, 100],
    ["2026-09-07", 0, 0],
  ], "the torn last line is skipped; a listed day with no file reads zero");
  const kept = (totals as unknown as { tallies: Map<string, unknown> }).tallies;
  const ninth = kept.get("2026-09-09");
  const tenth = kept.get("2026-09-10");
  ledger.append(usage(on(10, 10), "s4", 100));
  const b = await totals.totals(["2026-09-10", "2026-09-09", "2026-09-08"]);
  assert.equal(kept.get("2026-09-09"), ninth, "an unchanged file is not read again");
  assert.notEqual(kept.get("2026-09-10"), tenth, "the file appended to is");
  assert.equal(kept.has("2026-09-07"), false, "a day no longer listed is let go");
  assert.equal(b[0]?.billedSeconds, 107, "s4's newest usage row on the 10th, the unnamed close's 7 s");
  assert.deepEqual(DayTotals.scan('{"at":1,"type":"session.started","sessionId":"x"}\n{"at":2,"type":"heard","item":{"text":"\\"type\\":\\"session.closed\\""}}\n'), {
    started: 1, closes: new Map(), usages: new Map(), unnamed: 0,
  }, "a heard line that quotes a row type is not a row");
});

test("search older: one page per request; `older` names where the byte bound stopped it; `before` reads on from there; the last page has no `older`", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-w33-search-"));
  const ledger = history(stateDir);
  // A page bound of one byte: every page reads exactly one day file, newest first.
  await withServer(engineOver(ledger, stateDir), async (ask) => {
    const texts = (m: DaemonMessage): string[] => ((m as Extract<DaemonMessage, { type: "ledger.hits" }>).hits as { text: string }[]).map((h) => h.text);
    const older = (m: DaemonMessage): string | undefined => (m as Extract<DaemonMessage, { type: "ledger.hits" }>).older;
    const p1 = await ask({ type: "ledger.search", query: "needle" });
    assert.deepEqual(texts(p1), ["the needle on the tenth"]);
    assert.equal(older(p1), "2026-09-10", "the page stopped after the 10th");
    const p2 = await ask({ type: "ledger.search", query: "needle", before: older(p1) });
    assert.deepEqual(texts(p2), ["the needle on the ninth"]);
    const p3 = await ask({ type: "ledger.search", query: "needle", before: older(p2) });
    assert.deepEqual(texts(p3), ["the needle on the eighth"]);
    assert.equal(older(p3), undefined, "nothing older is unread");
    const odd = await ask({ type: "ledger.search", query: "needle", before: "../../etc" });
    assert.deepEqual(texts(odd), ["the needle on the tenth"], "a `before` that is not a day is ignored: the newest page");
  }, 1);
  // The ledger's own bound (32 MB): one page reads the whole small history, newest first, and says nothing is older.
  await withServer(engineOver(ledger, stateDir), async (ask) => {
    const all = (await ask({ type: "ledger.search", query: "needle", limit: 2 })) as Extract<DaemonMessage, { type: "ledger.hits" }>;
    assert.deepEqual((all.hits as { text: string }[]).map((h) => h.text), ["the needle on the tenth", "the needle on the ninth"], "the limit holds");
    assert.equal(all.older, undefined);
  });
});

test("search older: a ledger without searchPage (a fake) answers from search() in one read, with no `older`", async () => {
  const asked: { query: string; limit?: number }[] = [];
  const none = (): unknown[] => [];
  const fake: EngineLike["ledger"] = {
    read: none,
    days: () => [],
    sessions: none,
    readSession: none,
    search: (query: string, limit?: number) => {
      asked.push({ query, ...(limit !== undefined ? { limit } : {}) });
      return [{ sessionId: "s1", chainId: "s1", state: "active", at: 1, kind: "heard", text: `hit for ${query}` }];
    },
    readChain: () => ({ rows: [], truncated: false }),
  };
  await withServer(engineOver(fake, ""), async (ask) => {
    const page = (await ask({ type: "ledger.search", query: "plan", limit: 5, before: "2026-09-09" })) as Extract<DaemonMessage, { type: "ledger.hits" }>;
    assert.equal(page.hits.length, 1);
    assert.equal(page.older, undefined);
    assert.deepEqual(asked, [{ query: "plan", limit: 5 }]);
    const days = (await ask({ type: "ledger.days" })) as Extract<DaemonMessage, { type: "ledger.days" }>;
    assert.equal(days.totals, undefined, "a ledger with no folder sends the list alone");
  });
});
