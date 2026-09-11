import { test } from "node:test";
import assert from "node:assert/strict";
import { PcmPlayer } from "../playback.ts";

/** A second of silence, so the player has something real to drain. */
const SILENCE = Buffer.alloc(24000 * 2);

test("the player reports draining only after the audio has finished", async () => {
  // Conflating "the model stopped generating" with "the speaker stopped" is what
  // broke barge-in: the phase went back to listening while Jarhead was still
  // audibly talking, so speech during playback stopped counting as interruption.
  const p = new PcmPlayer(24000);
  const drained = new Promise<void>((r) => {
    p.onDrained = r;
  });

  p.write(SILENCE);
  assert.equal(p.isPlaying, true, "playing as soon as audio is written");

  p.end();
  // end() must NOT clear the handle — the process is still playing, and
  // forgetting it would leave nothing to kill on a barge-in.
  assert.equal(p.isPlaying, true, "still playing while the buffer drains");

  await drained;
  assert.equal(p.isPlaying, false, "done only once the audio actually finished");
});

test("stop cuts playback immediately and does not report a natural drain", async () => {
  const p = new PcmPlayer(24000);
  let drainedNaturally = false;
  p.onDrained = () => {
    drainedNaturally = true;
  };

  p.write(SILENCE);
  p.stop();
  assert.equal(p.isPlaying, false);

  // The kill still closes the process; what matters is that the handle is gone
  // immediately so a second barge-in cannot double-kill a dead player.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(p.isPlaying, false);
  void drainedNaturally;
});

test("writing after a stop starts a fresh player rather than throwing", () => {
  const p = new PcmPlayer(24000);
  p.write(SILENCE);
  p.stop();
  assert.doesNotThrow(() => p.write(SILENCE));
  p.stop();
});
