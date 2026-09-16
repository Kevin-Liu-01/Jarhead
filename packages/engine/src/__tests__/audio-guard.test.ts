import { test } from "node:test";
import assert from "node:assert/strict";
import type { AudioState, LedgerRow } from "@jarhead/protocol";
import { nextUtterance, rows, settle, world, type World } from "./world.ts";

/**
 * design12: one `audio.guard` ledger row per Kevin turn while the software echo guard holds the
 * wire (Recording, or the fallback rung) — the counters as the app last reported them — and none
 * while the guard is off, none for Jarhead's own turns. The row rides the `heard` row's clock.
 */

const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();

/** Kevin says a line and the transcript closes it. */
async function heard(w: World, text: string): Promise<void> {
  const live = w.lives.at(-1)!;
  const s = live.nowMs;
  live.nowMs += 900;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  nextUtterance(w);
  tick(w);
  await settle(1);
}

type GuardRow = Extract<LedgerRow, { type: "audio.guard" }>;

const GUARDED: AudioState = {
  running: true,
  voiceProcessing: false,
  rung: 1,
  wiring: "hardware",
  tapFormat: "48000 Hz ×1 Float32",
  recording: true,
  fallback: false,
  guardOn: true,
  guardTailMs: 420,
  guardHeldMs: 3200,
  gated: 12,
  chunks: 340,
  breakthroughs: 1,
  inputMuted: false,
  aggregatePresent: false,
};

test("audio.guard: a Kevin turn while the guard holds leaves one row with the counters and the session id; a turn with the guard off leaves none; Jarhead's turn leaves none; the fallback rung is said", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();

    // Recording off, no frame yet: a turn leaves a heard row and nothing else.
    await heard(w, "hello there");
    assert.equal(rows<GuardRow>(w, "audio.guard").length, 0, "no frame: no guard row");

    // The app reports the plain graph with the guard holding.
    engine.reportAudioState(GUARDED);
    await heard(w, "turn the lights down");
    const one = rows<GuardRow>(w, "audio.guard");
    assert.equal(one.length, 1, "one row per Kevin turn while guardOn");
    assert.deepEqual(one[0], { at: one[0]!.at, type: "audio.guard", sessionId: engine.snapshot().session?.id, tailMs: 420, heldMs: 3200, gated: 12, chunks: 340, breakthroughs: 1, fallback: false });
    const heardRows = rows<Extract<LedgerRow, { type: "heard" }>>(w, "heard");
    assert.equal(one[0]!.at, heardRows.at(-1)!.at, "the row rides the heard row's clock");

    // Jarhead answering is not a Kevin turn.
    const live = w.lives.at(-1)!;
    live.emit("outputTranscript", " Done.", live.nowMs, live.nowMs + 500);
    nextUtterance(w);
    tick(w);
    await settle(1);
    assert.equal(rows<GuardRow>(w, "audio.guard").length, 1, "Jarhead's turn leaves no guard row");

    // The counters move; the fallback rung is said as such.
    engine.reportAudioState({ ...GUARDED, recording: false, fallback: true, rung: 4, gated: 40, breakthroughs: 0 });
    await heard(w, "and the music");
    const two = rows<GuardRow>(w, "audio.guard");
    assert.equal(two.length, 2);
    assert.deepEqual([two[1]!.gated, two[1]!.breakthroughs, two[1]!.fallback], [40, 0, true]);

    // The guard released (the unit came back, or the graph stopped): no row.
    engine.reportAudioState({ ...GUARDED, guardOn: false, recording: false, voiceProcessing: true });
    await heard(w, "thanks");
    assert.equal(rows<GuardRow>(w, "audio.guard").length, 2, "guard off: no row");
    engine.reportAudioState(undefined);
    await heard(w, "goodnight");
    assert.equal(rows<GuardRow>(w, "audio.guard").length, 2, "the app left: no row");
    assert.equal(engine.snapshot().settings.audio.recording, false, "the frame never wrote the setting");
  } finally {
    await engine.stop();
  }
});
