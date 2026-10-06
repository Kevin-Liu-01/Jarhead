import { test } from "node:test";
import assert from "node:assert/strict";
import { assertion, assertions, allPass, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-8: each judge is shown failing on the fault it is there to catch. The stand-in misbehaves on purpose
 * (DryFaults, dry runs only); the engine, the hands and the brain are as in every dry run. A judge that passes
 * here has stopped judging.
 *
 * F3: the stand-in also plays GPT-Live-1 as the paid checks of 2026-10-06 measured it (a mute that drains, a late
 * farewell, a late stop, a voice that answers the room, a haiku Live writes itself). Those runs are the engine's
 * live-shaped regression guards: they fail on the engine of c7d4e63 and pass with F2's fixes.
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

test("LC-2 at scale 0.6: a mute keeps one session (Live's audio stops 3.4 s into a mute; the frame watch must not take that for a dead socket)", async () => {
  const r = await dryRun("LC-2", { scale: 0.6 });
  const one = assertion(r, /^Mute keeps one session from Go to Pause$/);
  assert.equal(one.pass, true, `${JSON.stringify(one.value)} ${one.expect ?? ""}`);
  const mute = r.marks.find((m) => m.name === "mute")!.t;
  const unmute = r.marks.find((m) => m.name === "unmute")!.t;
  const drained = r.wire.server.filter((f) => f.s === 0 && f.type === "session.output_audio.delta" && f.t > mute + 3400 * 0.6 + 200 && f.t < unmute);
  assert.deepEqual(drained, [], "the premise: no output audio from 3.4 s (check time) into the mute until the unmute");
  assert.deepEqual(
    r.sessions.map((s) => s.closeReason),
    ["close_requested", "close_requested"],
    "two sessions: Go's, closed by Pause, and the resume's, closed by Stop",
  );
  allPass(r);
});

for (const soundLagMs of [335, 466]) {
  test(`LC-4 at GPT-Live-1's farewell timing (its words 1750 ms after the ask, their sound ${soundLagMs} ms later, the close 630 ms): night., heard, closed within 1.8 s of the first heard frame, asleep`, async () => {
    const r = await dryRun("LC-4", { dryFaults: { liveFarewell: { replyMs: 1750, soundLagMs, closeMs: 630 } } });
    for (const trial of [1, 2, 3]) {
      for (const what of ['the farewell is exactly "night."', "the farewell reaches the speaker", "closed within 1.8 s of the first farewell audio", "the phase is asleep"]) {
        const a = r.assertions.find((x) => x.name === `trial ${trial}: ${what}`);
        assert.ok(a, `trial ${trial}: ${what} is judged`);
        assert.equal(a.pass, true, `trial ${trial}: ${what}: ${JSON.stringify(a.value)} ${JSON.stringify(r.metrics[`trial${trial}`])}`);
      }
    }
    allPass(r);
  });
}

test("LC-6 with Live's late stop (its barge-in cuts the words at once and the sound 800 ms later; Kevin's words are transcribed 1.5 s late): the gate is set and nothing reaches the sink inside it", async () => {
  const r = await dryRun("LC-6", { dryFaults: { lateStop: { inputLagMs: 1500, tailMs: 800 } } });
  for (const trial of [1, 2, 3]) {
    assert.equal(assertion(r, new RegExp(`^trial ${trial}: the gate is set at the fragment`)).pass, true, `trial ${trial}: framesInGate ${String(r.metrics[`trial${trial}.framesInGate`])}`);
    assert.equal(assertion(r, new RegExp(`^trial ${trial}: 0 frames reach the speaker sink inside the gate`)).pass, true);
  }
  allPass(r);
});

test("LC-7: a voice that answers the room and delegates its commands (GPT-Live-1, 2026-10-06) fails 'no reply to the room' and 'no delegation'", async () => {
  const r = await dryRun("LC-7", { dryFaults: { answersRoom: "reply-and-delegate" } });
  assert.equal(assertion(r, /^no reply to the room$/).pass, false);
  assert.equal(assertion(r, /^no delegation$/).pass, false);
  assert.equal(r.pass, false);
});

test("LC-9: Live writing the haiku itself (GPT-Live-1, 2026-10-06) passes: B4 is what reaches the hands, not who composes", async () => {
  const r = await dryRun("LC-9", { dryFaults: { composesItself: true } });
  assert.equal(r.metrics["haikuBy"], "voice", String(r.metrics["haikuSaid"]));
  assert.deepEqual(r.metrics["haikuDelegations"], []);
  assert.deepEqual(r.brain.tasks.filter((t) => /haiku/i.test(t.request)), []);
  assert.equal(assertion(r, /the haiku is composed/).pass, true);
  assert.equal(assertion(r, /no type op on the hands/).pass, true);
  allPass(r);
});
