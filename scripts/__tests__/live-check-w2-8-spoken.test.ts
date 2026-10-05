import { test } from "node:test";
import assert from "node:assert/strict";
import { allPass, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-8: the spoken live checks, run dry. "Spoken" is typed text turned into PCM and fed as mic
 * frames: live, by gpt-4o-mini-tts; here, a marked tone the scripted server reads back. Never the
 * microphone, never played. These wait out the engine's own clocks (the 2.5 s output gate, a
 * shortened idle limit), so they take a few seconds each.
 */

test("LC-6 spoken-stop: the gate is set at the stop fragment and nothing reaches the sink inside it; the session stays open", async () => {
  const r = await dryRun("LC-6");
  allPass(r);
  assert.equal(r.speech.length, 6, "three stories, three stops");
  assert.ok(r.sink.length > 0, "the story reached the speaker sink");
});

test("LC-7 room-talk: no reply, no delegation, no reflex, no goodnight sleep; the clause, then sleep at the idle limit", async () => {
  const r = await dryRun("LC-7");
  allPass(r);
  const sleep = r.ledger.filter((row) => row.type === "sleep");
  assert.deepEqual(sleep.map((row) => (row.type === "sleep" ? row.cause : "")), ["idle"]);
  assert.ok(r.speech.some((s) => /goodnight/i.test(s.text)), "the room said goodnight");
});

test("LC-10 speech-end: five spoken questions, speech end before each delegation, the gap recorded", async () => {
  const r = await dryRun("LC-10");
  allPass(r);
  assert.equal((r.metrics["speechEndToDelegationMs"] as number[]).length, 5);
});
