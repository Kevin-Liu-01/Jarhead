import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOM_COMMANDS } from "../live-check.mts";
import { allPass, assertions, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-8: the spoken live checks, run dry. "Spoken" is typed text turned into PCM and fed as mic
 * frames: live, by gpt-4o-mini-tts; here, a marked tone the scripted server reads back. Never the
 * microphone, never played. These wait out the engine's own clocks (the 2.5 s output gate, a
 * shortened idle limit), so they take a few seconds each.
 */

test("LC-6 spoken-stop: the story sounds, the gate is set at the stop fragment, nothing reaches the sink inside it, and the story does not come back after it", async () => {
  const r = await dryRun("LC-6");
  allPass(r);
  assert.equal(r.speech.length, 6, "three stories, three stops");
  assert.ok(r.sink.some((f) => f.audible) && r.sink.some((f) => !f.audible), "the sink records sound and silence apart");
  for (const trial of [1, 2, 3]) {
    assert.ok(Number(r.metrics[`trial${trial}.storyAudibleBeforeStopMs`]) > 0, `trial ${trial}: the story was sounding`);
    assert.ok(Number(r.metrics[`trial${trial}.afterGateWatchMs`]) >= 500, `trial ${trial}: the harness watched after the gate lapsed`);
  }
  assert.equal(assertions(r, /after the gate lapses, at most an acknowledgement/).pass, true);
});

test("LC-7 room-talk: commands nobody addressed run no reflex; no reply, no delegation, no goodnight sleep; the clause, then sleep at the idle limit", async () => {
  const r = await dryRun("LC-7");
  allPass(r);
  const sleep = r.ledger.filter((row) => row.type === "sleep");
  assert.deepEqual(sleep.map((row) => (row.type === "sleep" ? row.cause : "")), ["idle"]);
  assert.ok(r.speech.some((s) => /goodnight/i.test(s.text)), "the room said goodnight");
  const lines = r.metrics["roomLines"] as { line: string; command: boolean; outsideWindow: boolean; heard?: boolean; asleep: boolean }[];
  const judged = lines.filter((l) => l.command && l.outsideWindow && !l.asleep && l.heard === true);
  assert.ok(judged.length >= 1, `a command was heard outside the exchange window: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.command && !l.outsideWindow && !l.asleep) || judged.length >= 2, "two commands are judged dry, unless a slow run let the clause reach one");
  assert.ok(judged.every((l) => ROOM_COMMANDS.has(l.line)));
  console.log(`[measure] LC-7 dry: ${judged.length} command line(s) judged outside the window: ${judged.map((l) => l.line).join(" | ")}`);
});

test("LC-10 speech-end: five spoken questions, speech end before each delegation, the gap recorded", async () => {
  const r = await dryRun("LC-10");
  allPass(r);
  assert.equal((r.metrics["speechEndToDelegationMs"] as number[]).length, 5);
});
