import { test } from "node:test";
import assert from "node:assert/strict";
import { bench, type BenchRow } from "../bench.ts";

/**
 * `pnpm jarhead bench --fake-hands`, once, as a smoke test: every row the table promises is
 * measured (a row that silently skipped — a regex that stopped matching, a helper that
 * answered differently — would fall out of this list and nobody would read the table to
 * notice), the count row is a count, and the thread rows either saw two stand-in threads
 * or said why not. A real Engine with fake hands, a stand-in Live session and stand-in
 * brains: no socket, no paid session, no model, nothing touches the Mac; the duck probe
 * (a Swift build) is off.
 */

test("bench --fake-hands: the promised rows are measured; the generations row is a count; the thread rows report what they saw", async () => {
  const lines: string[] = [];
  const r = await bench({ runs: 1, codex: false, fakeHands: true, json: true, duck: false, print: (l) => lines.push(l) });
  const byMetric = new Map<string, BenchRow>(r.rows.map((row) => [row.metric, row]));
  const names = [...byMetric.keys()];
  // The rows that depend only on the engine's tool path and the CLI's own harness.
  for (const want of [
    "tool round trip (frontmost_app)",
    "quick screenshot (2000 px / 1.1 MP)",
    "delegation → first action",
    "delegation → done",
    "reflex: utterance end → tool issued (prefired)",
    "ear: partial → dispatch",
    "ear: careful partial → dispatch",
    "ear: final → dispatch",
    "stop: command → everything stopped",
    "read during a type (acting helper held 1.5 s)",
    "acting call incl. observation (mouse_move in place)",
  ]) assert.ok(byMetric.has(want), `row "${want}" was measured; rows: ${names.join(" | ")}`);
  for (const row of r.rows) {
    assert.ok(row.n >= 1 && Number.isFinite(row.median), `${row.metric}: n ${row.n}, median ${row.median}`);
    if (row.metric !== "status reflex: brain generations (count, target 0)") assert.equal(row.unit, "ms", row.metric);
  }
  assert.equal(byMetric.get("acting call incl. observation (mouse_move in place)")?.target, 350);
  const observation = r.extras["observation"] as { acting: number; withLine: number };
  assert.equal(observation.acting, 1, "one acting call measured for one run (the cursor regex matched)");
  // The thread rows need the engine to admit two `thread_start`s; when it does, both rows are there and the count row is a count.
  const threads = r.extras["threads"] as { live: number; names: string[]; source: string; splitResults: string[] } | undefined;
  assert.ok(threads, "the bench records what the split produced");
  if (threads.live >= 2) {
    const gens = byMetric.get("status reflex: brain generations (count, target 0)");
    assert.equal(gens?.unit, "count", "generations are a tally, never a latency");
    assert.ok(byMetric.has("status reflex: delegation → spoken status line"), `the status line was spoken; rows: ${names.join(" | ")}`);
    assert.ok(byMetric.has("targeted stop: command → that thread stopped"), `one thread stopped by id; rows: ${names.join(" | ")}`);
    const stop = r.extras["targetedStop"] as { stoppedOne: boolean; othersLive: number };
    assert.equal(stop.stoppedOne, true);
    assert.equal(stop.othersLive, 1, "the other thread carries on");
  } else {
    assert.ok(threads.splitResults.length > 0, "when two threads could not start, the bench says what thread_start answered");
  }
  // The JSON went to the sink, not to stdout, and it parses to the same rows.
  const json = lines.find((l) => l.startsWith("{"));
  assert.ok(json, "one JSON document printed");
  const parsed = JSON.parse(json) as { rows: BenchRow[]; hands: string; brain: string };
  assert.equal(parsed.hands, "fake");
  assert.equal(parsed.brain, "stand-in");
  assert.deepEqual(parsed.rows.map((x) => x.metric), names);
});
