import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { benchReport, median, percentile, type Sample } from "../bench.ts";
import { stat, summarize, type BrainBenchReport } from "../bench-brain.ts";

/**
 * C4-medians: `pnpm jarhead bench`, `bench --brain` and `ledger --speed` print the true median. For an even n that is
 * the mean of the two middle values. They printed the nearest-rank p50, the lower middle value, so the saved
 * 2026-09-12 brain run read 4.4 s to the first action where its six samples give 4.50 s. The percentiles stay nearest
 * rank, as documented on the helper.
 */

test("C4-medians: an odd n's median is its middle value", () => {
  assert.equal(median([7]), 7);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([9, 2, 4, 8, 1]), 4);
});

test("C4-medians: an even n's median is the mean of the two middle values", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4200, 3900]), 4050);
  assert.equal(median([1200, 55, 70, 60]), 65);
  assert.equal(median([1, 1, 1, 9]), 1, "two equal middles");
  const xs = [4, 3, 2, 1];
  median(xs);
  assert.deepEqual(xs, [4, 3, 2, 1], "the input is not sorted in place");
});

test("C4-medians: no samples, no median", () => {
  assert.ok(Number.isNaN(median([])));
});

test("C4-medians: the percentiles stay nearest rank, so p50 of an even n is still the lower middle", () => {
  const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  assert.equal(percentile(ten, 50), 5, "p50 is a sample, not the median (5.5)");
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile(ten, 95), 10);
  assert.equal(percentile(ten, 0), 1);
  assert.equal(percentile(ten, 100), 10);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
  assert.ok(Number.isNaN(percentile([], 90)));
});

const samples = (metric: string, values: readonly number[]): Sample[] => values.map((value) => ({ metric, value, unit: "ms" }));
const run = (lines: string[]) => ({ codex: false, realHelper: false, gate: true, json: false, print: (l: string) => void lines.push(l), brain: "stand-in", load: "0 0 0", dir: "/tmp/x" });

test("C4-medians: bench's table prints the true median, and a median-judged row passes or misses on it", () => {
  const lines: string[] = [];
  // Target 80 ms, judged at the median: the lower middle (80) passed; the true median is 82.5 ms.
  const r = benchReport(samples("tool round trip (frontmost_app)", [90, 70, 85, 80]), {}, run(lines));
  const row = r.rows[0];
  assert.ok(row);
  assert.equal(row.median, 82.5);
  assert.equal(row.p90, 90, "p90 stays nearest rank");
  assert.equal(row.p95, 90, "p95 stays nearest rank");
  assert.equal(row.pass, false, "82.5 ms is over the 80 ms target");
  assert.match(lines.find((l) => l.includes("tool round trip (frontmost_app)")) ?? "", /^\s+tool round trip \(frontmost_app\)\s+4\s+83\s+90\s+90\s+90\s+80\s+MISS$/);
});

test("C4-medians: bench --brain's stat (and ledger --speed's) gives the true median and keeps p95 nearest rank", () => {
  const s = stat([4200, Number.NaN, 3900]);
  assert.deepEqual([s.n, s.median, s.p95, s.min, s.max], [2, 4050, 4200, 3900, 4200]);
  const odd = stat([3, 1, 2]);
  assert.deepEqual([odd.n, odd.median, odd.p95], [3, 2, 3]);
});

test("C4-medians: the saved 2026-09-12 brain run re-summarized gives 4.50 s to the first action, 9.02 s to done, a 3.91 s model step", () => {
  const saved = JSON.parse(readFileSync(new URL("../../../../docs/latency/after.json", import.meta.url), "utf8")) as BrainBenchReport;
  const s = summarize(saved.records);
  const { firstAction, done } = s.brainPath.overall.metrics;
  assert.deepEqual([firstAction.n, firstAction.median, firstAction.p95], [6, 4499.5, 5099], "the summary saved then reads 4365 ms: the lower middle");
  assert.deepEqual([done.n, done.median, done.p95], [10, 9020, 25631], "saved: 8937 ms");
  assert.deepEqual([s.generationGapMs.n, s.generationGapMs.median, s.generationGapMs.p95], [24, 3907.5, 5979], "saved: 3777 ms");
});
