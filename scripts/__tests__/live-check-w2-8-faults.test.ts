import { test } from "node:test";
import assert from "node:assert/strict";
import { assertion, assertions, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-8: each judge is shown failing on the fault it is there to catch. The stand-in misbehaves on purpose
 * (DryFaults, dry runs only); the engine, the hands and the brain are as in every dry run. A judge that passes
 * here has stopped judging.
 */

test("LC-1: an output-audio hole under a running meter fails 'continuous', where the all-frames gap does not see it", async () => {
  const r = await dryRun("LC-1", { dryFaults: { audioHoleMs: 1500 } });
  assert.equal(assertion(r, /no output-audio gap over 2 s/).pass, false, `outputAudioGapMaxMs ${String(r.metrics["outputAudioGapMaxMs"])}`);
  assert.equal(assertion(r, /no server gap over 10 s/).pass, true, "the meter's frames keep the all-frames gap small");
  assert.ok(Number(r.metrics["outputAudioGapMaxMs"]) > Number(r.metrics["frameGapMaxMs"]));
  assert.equal(r.pass, false);
});

test("LC-6: a story that plays on over the stop fails after the gate lapses, though nothing leaks inside the gate", async () => {
  const r = await dryRun("LC-6", { dryFaults: { noBargeIn: true } });
  assert.equal(assertions(r, /0 frames reach the speaker sink inside the gate/).pass, true, "the gate itself holds");
  const after = assertions(r, /after the gate lapses, at most an acknowledgement/);
  assert.ok(after.all.every((a) => !a.pass), `every trial fails: ${JSON.stringify(after.all.map((a) => a.value))}`);
  // The stand-in's story is one 37-word sentence on a loop, so on a loaded runner a short window after the gate can
  // miss every word it said before the stop: the sound above is the judge that holds in every trial.
  const words = assertions(r, /none of the story's words after the gate lapses/);
  assert.ok(words.all.some((a) => !a.pass), `the story's words come back: ${JSON.stringify(words.all.map((a) => a.value))}`);
  for (const trial of [1, 2, 3]) assert.ok(Number(r.metrics[`trial${trial}.bargeInMs`]) > 2000, `trial ${trial}: no barge-in, the run of story audio goes on past the gate (${String(r.metrics[`trial${trial}.bargeInMs`])} ms)`);
  assert.equal(r.pass, false);
});

test("LC-9: a delegation for a line Jarhead already handled reconciles as done and never reaches the brain", async () => {
  const r = await dryRun("LC-9", { dryFaults: { delegateHandled: true } });
  assert.equal(r.metrics["reconcileExercised"], true, "Live delegated the scroll");
  const reconcile = assertion(r, /reconciles as already done/);
  assert.equal(reconcile.soft, undefined, "judged hard once exercised");
  assert.equal(reconcile.pass, true, JSON.stringify(reconcile.value));
  assert.equal(assertion(r, /the scroll never reaches the brain/).pass, true);
});
