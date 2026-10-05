import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JarheadConfig } from "@jarhead/core";
import { BENCH_OPENAI_KEY, EAR_CAREFUL_DISPATCH_TARGET_MS, EAR_DISPATCH_TARGET_MS, EAR_GATE_METRICS, bench, benchConfig, benchReport, earGate, type BenchRow, type BenchRun, type Sample } from "../bench.ts";

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
  assert.equal(r.ok, true, "fake hands are never judged, so the bench exits 0");
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
  // The gate judges the bench's own rows by name: a renamed ear row would fail every real-helper run.
  for (const metric of EAR_GATE_METRICS) assert.ok(byMetric.has(metric), `the gate's row "${metric}" is one the bench measures`);
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
    // PERF-7: the row times the table's own answer, never the split's lines that also name Spotify.
    const status = r.extras["statusReflex"] as { line: string | null; generations: number };
    assert.match(status.line ?? "", /^Spotify is/, "the status row timed the table's answer");
    assert.equal(status.generations, 0, "the table answered, not the brain");
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

/** One table row as bench() builds it: the p95 is what the gate reads. */
function row(metric: string, p95: number, target?: number): BenchRow {
  return { metric, unit: "ms", n: 20, median: p95, p90: p95, p95, max: p95, target, pass: target === undefined ? undefined : p95 <= target };
}
/** The three ear rows at the given p95s (the fake-hands medians by default: the 120 ms window, the 450 ms one, a final at once). */
function earRows(partial = 122, careful = 452, final = 1): BenchRow[] {
  return [row("ear: partial → dispatch", partial, EAR_DISPATCH_TARGET_MS), row("ear: careful partial → dispatch", careful, EAR_CAREFUL_DISPATCH_TARGET_MS), row("ear: final → dispatch", final, EAR_DISPATCH_TARGET_MS)];
}

test("RX-10: with the real helper the bench exits 1 when an ear row's p95 is over 250 / 580 ms; --no-gate and fake hands exit 0", () => {
  // The README's numbers, held here so a moved target is a failing test and a README edit.
  assert.equal(EAR_DISPATCH_TARGET_MS, 250);
  assert.equal(EAR_CAREFUL_DISPATCH_TARGET_MS, 580);
  const real = { realHelper: true, gate: true };
  assert.deepEqual(earGate(earRows(), real), { verdict: "ok", exitCode: 0 });
  assert.deepEqual(earGate(earRows(250, 580, 250), real), { verdict: "ok", exitCode: 0 }, "at the target is a pass");
  assert.deepEqual(earGate(earRows(251), real), { verdict: "FAIL", exitCode: 1 }, "a prefire partial over 250 ms");
  assert.deepEqual(earGate(earRows(122, 581), real), { verdict: "FAIL", exitCode: 1 }, "a careful partial over 580 ms");
  assert.deepEqual(earGate(earRows(122, 452, 251), real), { verdict: "FAIL", exitCode: 1 }, "a final over 250 ms");
  assert.deepEqual(earGate(earRows().slice(1), real), { verdict: "FAIL", exitCode: 1 }, "a missing ear row: the ear never dispatched");
  assert.deepEqual(earGate([], real), { verdict: "FAIL", exitCode: 1 });
  // The acting call is judged at p95 in the table, but it is not the ear's gate.
  assert.deepEqual(earGate([...earRows(), row("acting call incl. observation (mouse_move in place)", 900, 350)], real), { verdict: "ok", exitCode: 0 });
  assert.deepEqual(earGate(earRows(400), { realHelper: true, gate: false }), { verdict: "FAIL", exitCode: 0 }, "--no-gate prints the FAIL and exits 0");
  assert.deepEqual(earGate(earRows(400), { realHelper: false, gate: true }), { verdict: "not judged (fake hands)", exitCode: 0 });
});

/** n samples of one metric at one value: its median and p95 are that value. */
function samples(metric: string, value: number, n = 20): Sample[] {
  return Array.from({ length: n }, () => ({ metric, value, unit: "ms" as const }));
}
/** The three ear metrics' samples, a prefire partial at `partial` ms (the fake-hands values otherwise). */
function earSamples(partial: number): Sample[] {
  return [...samples("ear: partial → dispatch", partial), ...samples("ear: careful partial → dispatch", 452), ...samples("ear: final → dispatch", 1)];
}
/** One benchReport over the samples, its printed lines captured. */
function report(s: readonly Sample[], o: Partial<BenchRun> = {}): { ok: boolean; lines: string[]; json: { hands: string; earGate: string; rows: BenchRow[]; threads?: unknown } | undefined } {
  const lines: string[] = [];
  const r = benchReport(s, { threads: { live: 2 } }, { codex: false, realHelper: true, gate: true, json: false, brain: "stand-in", load: "1.0 1.0 1.0", dir: "/tmp/jh-bench-x", ...o, print: (l) => lines.push(l) });
  const doc = lines.find((l) => l.startsWith("{"));
  return { ok: r.ok, lines, json: doc ? (JSON.parse(doc) as { hands: string; earGate: string; rows: BenchRow[] }) : undefined };
}

test("RX-10 / PF-4: what bench() returns is the gate's exit: ok false on a FAIL with the real helper (main.ts exits 1 on it), in the JSON and in the table alike", () => {
  // The JSON: a prefire partial at 300 ms is over 250.
  const failJson = report(earSamples(300), { json: true });
  assert.equal(failJson.ok, false, "a FAIL is ok: false, which main.ts exits 1 on");
  assert.equal(failJson.json?.earGate, "FAIL");
  assert.equal(failJson.json?.hands, "helper");
  assert.equal(failJson.json?.rows.find((r) => r.metric === "ear: partial → dispatch")?.pass, false);
  assert.deepEqual(failJson.json?.threads, { live: 2 }, "the run's extras ride the JSON");
  // The table: the same verdict, and no --no-gate note.
  const failTable = report(earSamples(300));
  assert.equal(failTable.ok, false);
  const gateLine = failTable.lines.find((l) => l.includes("ear gate:"));
  assert.match(gateLine ?? "", /with the real helper: FAIL\n$/);
  assert.ok(failTable.lines.some((l) => /ear: partial → dispatch .* MISS \(p95\)/.test(l)), failTable.lines.join("\n"));
  // --no-gate: the FAIL still prints, and the exit is 0.
  const noGate = report(earSamples(300), { gate: false });
  assert.equal(noGate.ok, true);
  assert.match(noGate.lines.find((l) => l.includes("ear gate:")) ?? "", /FAIL \(--no-gate, so the exit is 0\)/);
  assert.equal(report(earSamples(300), { gate: false, json: true }).json?.earGate, "FAIL");
  // Under the targets, and fake hands at any speed: exit 0.
  const pass = report(earSamples(122), { json: true });
  assert.equal(pass.ok, true);
  assert.equal(pass.json?.earGate, "ok");
  const fake = report(earSamples(300), { realHelper: false, json: true });
  assert.equal(fake.ok, true);
  assert.equal(fake.json?.earGate, "not judged (fake hands)");
  assert.equal(fake.json?.hands, "fake");
  assert.match(report(earSamples(300), { realHelper: false }).lines.find((l) => l.includes("ear gate:")) ?? "", /not judged with fake hands/);
  // An ear that never dispatched is not fast: no ear samples with the real helper fails.
  assert.equal(report(samples("tool round trip (frontmost_app)", 10)).ok, false);
});

test("W2-7: the bench's config keeps the user's settings and none of their secrets; with fake hands the helper's path does not exist", () => {
  // What readConfig() gives on a Mac with keys in ~/.jarhead/env and a server URL set.
  const base: JarheadConfig = {
    openaiApiKey: "sk-user",
    anthropicApiKey: "sk-ant-user",
    liveModel: "gpt-live-1",
    liveVoice: "ballad",
    brain: "auto",
    brainModel: "",
    brainEffort: "medium",
    brainBaseUrl: "https://example.com/v1",
    brainApiKey: "sk-user",
    stateDir: "/Users/someone/.jarhead",
    socketPath: "/Users/someone/.jarhead/jarhead.sock",
    idleSleepMinutes: 10,
    logLevel: "info",
    claudeBin: undefined,
    codexBin: undefined,
    handsBin: "/repo/build/jarhead-hands",
    memoryModel: undefined,
  };
  const fake = benchConfig(base, "/tmp/jh-bench-1", { codex: false, fakeHands: true });
  assert.equal(fake.openaiApiKey, BENCH_OPENAI_KEY);
  assert.equal(fake.anthropicApiKey, undefined);
  assert.equal(fake.brainApiKey, undefined);
  assert.equal(fake.brainBaseUrl, undefined);
  assert.equal(fake.liveVoice, "ballad", "the user's settings stay");
  assert.equal(fake.brain, "auto");
  assert.equal(fake.stateDir, "/tmp/jh-bench-1/state");
  assert.equal(fake.handsBin, "/tmp/jh-bench-1/no-hands");
  const real = benchConfig(base, "/tmp/jh-bench-1", { codex: true, fakeHands: false });
  assert.equal(real.handsBin, "/repo/build/jarhead-hands", "the real helper is what a real-helper run measures");
  assert.equal(real.brain, "codex");
  assert.equal(real.openaiApiKey, BENCH_OPENAI_KEY, "Codex runs on its own login, never on the user's OpenAI key");
  // `bench --brain --allow-api-spend` without Codex: the user chose the auto brain on API dollars, so its keys stay.
  const spend = benchConfig(base, "/tmp/jh-bb-1", { codex: false, fakeHands: true, brainKeys: true });
  assert.deepEqual([spend.openaiApiKey, spend.anthropicApiKey, spend.brainApiKey, spend.brainBaseUrl], ["sk-user", "sk-ant-user", "sk-user", "https://example.com/v1"]);
  assert.equal(spend.brain, "auto");
  assert.equal(spend.handsBin, "/tmp/jh-bb-1/no-hands", "the brain bench's hands are in process");
  assert.equal(benchConfig({ ...base, openaiApiKey: undefined }, "/tmp/jh-bb-1", { codex: false, fakeHands: true, brainKeys: true }).openaiApiKey, BENCH_OPENAI_KEY, "a wake still wants a key");
});

test("W2-7: `pnpm jarhead bench --no-duck` reaches bench(); main.ts passes the flag as `duck` and help lists it", () => {
  // bench() reads no argv, so the flag works only when main.ts passes it. Through the CLI an unwired flag
  // builds and runs the Swift duck probe, so this reads main.ts instead of running it.
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "main.ts"), "utf8");
  const call = main.split("\n").find((line) => line.includes("await bench({"));
  assert.ok(call, "main.ts calls bench()");
  assert.match(call, /\bduck: !flags\.has\("--no-duck"\)/, "the bench() call turns --no-duck into duck: false");
  assert.match(main, /^ {2}--no-duck +\(bench\) skip the Swift duck probe$/m, "help lists --no-duck with the bench flags");
});
