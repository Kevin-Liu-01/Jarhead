import { test } from "node:test";
import assert from "node:assert/strict";
import { JUDGES, Recorder, median, percentile, type Assertion, type Judge } from "../live-check.mts";

/**
 * C4-medians: the live-check harness prints the true median. For an even n that is the mean of the two middle values.
 * It printed the nearest-rank p50, the lower middle value, so LC-5 on 2026-10-06 (at 98c7cfe) read 1350 ms where its
 * ten latencies give 1384 ms. The percentiles stay nearest rank, as documented on the helper.
 */

test("C4-medians live-check: an odd n's median is its middle value", () => {
  assert.equal(median([7]), 7);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([9, 2, 4, 8, 1]), 4);
});

test("C4-medians live-check: an even n's median is the mean of the two middle values", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([14_998, 15_002]), 15_000);
  assert.equal(median([1, 1, 1, 9]), 1, "two equal middles");
  const xs = [4, 3, 2, 1];
  median(xs);
  assert.deepEqual(xs, [4, 3, 2, 1], "the input is not sorted in place");
  assert.ok(Number.isNaN(median([])));
});

test("C4-medians live-check: the percentiles stay nearest rank, so p50 of an even n is still the lower middle", () => {
  const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  assert.equal(percentile(ten, 50), 5, "p50 is a sample, not the median (5.5)");
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile(ten, 99), 10);
  assert.equal(percentile(ten, 0), 1);
  assert.ok(Number.isNaN(percentile([], 90)));
});

/** LC-5's ten typed-send → first-audible-frame latencies on 2026-10-06 at 98c7cfe (lc-5-first-word-094046-879.json). */
const LC5_FIRST_AUDIO_MS = [1306, 1673, 1350, 1597, 1494, 1709, 1418, 1344, 1235, 1033];

/** A recorder holding the ten asks, each answered by its first audible frame after the saved latency. */
function lc5Recorder(): Recorder {
  const rec = new Recorder(0);
  LC5_FIRST_AUDIO_MS.forEach((ms, i) => {
    const t = i * 10_000;
    rec.marks.push({ t, name: "ask" });
    rec.server.push({ t: t + ms, s: 1, type: "session.output_audio.delta", bytes: 1920, audible: true, audioMs: 40 });
  });
  return rec;
}

test("C4-medians live-check: LC-5's judge gives the saved run's ten latencies a 1384 ms median, not 1350, and keeps p90 at 1673", () => {
  const metrics: Record<string, unknown> = {};
  const assertions: Assertion[] = [];
  const j = {
    rec: lc5Recorder(),
    slack: 1,
    mode: "live",
    metric: (name: string, value: unknown) => void (metrics[name] = value),
    expect: (name: string, pass: boolean, value?: unknown) => void assertions.push({ name, pass, value }),
  } as unknown as Judge;
  JUDGES["LC-5"](j);
  assert.equal(metrics["n"], 10);
  assert.equal(metrics["firstAudioMedianMs"], 1384);
  assert.equal(metrics["firstAudioP90Ms"], 1673);
  const quoted = assertions.find((a) => /GPT-Live-1's typed path/.test(a.name));
  assert.equal(quoted?.value, 1384);
});
