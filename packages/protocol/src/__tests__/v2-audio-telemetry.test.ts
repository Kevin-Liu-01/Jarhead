import { test } from "node:test";
import assert from "node:assert/strict";
import { isAudioState, type AudioState, type LedgerRow, type LiveAudio, type Snapshot } from "../index.ts";

/**
 * Voice PLAN W1.5, as V2 fills W2-5's contract (contract-additions.test.ts pins the contract itself, its
 * shedding included). These are the shapes the app and the engine actually send: the app's frame with every
 * object it fills (`output.audibleMs` and `duck.refusedLive` among them), the frames of a quiet window, and
 * the `audio.playout` row under the contract's names (`liveAudio`, never `live`).
 */

const BASE: AudioState = {
  running: true,
  voiceProcessing: true,
  duckLevel: 10,
  rung: 2,
  wiring: "input-rate",
  tapFormat: "48000 Hz ×1 Float32",
  recording: false,
  fallback: false,
  guardOn: false,
  guardTailMs: 0,
  gated: 0,
  chunks: 0,
  breakthroughs: 0,
  inputMuted: false,
  aggregatePresent: true,
};

/** What AppDelegate's mapping writes from the readbacks (AudioStateInfo.json). */
export const TELEMETRY: AudioState = {
  ...BASE,
  playout: { chunks: 412, underruns: 0, underrunMs: 0, longestUnderrunMs: 0, wouldBeUnderruns: 4, resets: 3, targetMs: 120, queuedMs: 121, queuedMinMs: 96, lateMaxMs: 7, droppedChunks: 0, droppedMs: 0 },
  duck: {
    ducks: 2,
    gate: 2,
    confirmed: 2,
    unconfirmed: 0,
    held: 0,
    refusedWords: 1,
    refusedLive: 0,
    wordOnsetsSkipped: 3,
    duckedMs: 900,
    deepMs: 400,
    residualP50Dbfs: -61,
    residualP99Dbfs: -49,
    echoFloorDbfs: -58.2,
    last: { source: "gate", confirmed: true, depthDb: -20, runDbfs: -31.5, thresholdDbfs: -42, releasedAfterMs: 640, reason: "quiet after ear words" },
  },
  output: { rmsDbfs: -21.8, peakDbfs: -4.1, heardRmsDbfs: -22, audibleMs: 61_000, mixFormat: "48000 Hz ×2", volume: 0.62 },
};

test("v2 telemetry: the app's frame passes untouched with every object V2 fills, and so does a frame without them (an older app)", () => {
  const frame = structuredClone(TELEMETRY);
  assert.ok(isAudioState(frame));
  assert.deepEqual(frame, TELEMETRY, "nothing is shed from a well-formed frame");
  assert.ok(isAudioState(structuredClone(BASE)), "an app from before the telemetry: no new objects");
});

test("v2 telemetry: a quiet window's frame passes: no residual or last duck yet, nothing voiced, no backlog minimum", () => {
  const { last: _last, residualP50Dbfs: _p50, residualP99Dbfs: _p99, echoFloorDbfs: _floor, ...duckBare } = TELEMETRY.duck!;
  const { queuedMinMs: _min, ...playoutBare } = TELEMETRY.playout!;
  // OutputReadback before the first voiced chunk: the time voiced is 0, the levels are absent.
  const frame: AudioState = { ...BASE, playout: playoutBare, duck: duckBare, output: { audibleMs: 0, mixFormat: "48000 Hz ×2" } };
  const copy = structuredClone(frame);
  assert.ok(isAudioState(copy));
  assert.deepEqual(copy, frame);
});

test("v2 telemetry: a mistyped audibleMs costs only the output object, never the frame", () => {
  const frame = structuredClone({ ...TELEMETRY, output: { ...TELEMETRY.output, audibleMs: "61 s" } }) as Record<string, unknown>;
  assert.ok(isAudioState(frame), "the frame passes");
  assert.equal(frame["output"], undefined, "the malformed output is shed");
  assert.deepEqual(frame["playout"], TELEMETRY.playout, "the rest stays");
});

test("v2 telemetry: the snapshot's liveAudio and the audio.playout row carry the same figures under the contract's names, and no words", () => {
  const live: LiveAudio = { deltas: 900, deltaMsP50: 40, deltaMsMax: 120, arrivalP99Ms: 31, arrivalMaxMs: 182, aheadMs: 0, gatedFrames: 0, loopDelayMaxMs: 12, formatRate: 24_000 };
  const snap: Pick<Snapshot, "liveAudio" | "audioState"> = { liveAudio: live, audioState: TELEMETRY };
  const row: LedgerRow = { at: 1, type: "audio.playout", sessionId: "sess_1", playout: TELEMETRY.playout!, duck: TELEMETRY.duck!, output: TELEMETRY.output!, liveAudio: live };
  assert.equal(snap.liveAudio?.formatRate, 24_000);
  assert.equal(row.type, "audio.playout");
  assert.deepEqual(Object.keys(row).sort(), ["at", "duck", "liveAudio", "output", "playout", "sessionId", "type"]);
  assert.doesNotMatch(JSON.stringify(row), /"text"|"delta"|"transcript"/, "no transcript text in the row");
  // A daemon's own counts with only the required fields (a session that heard nothing yet) are still a LiveAudio.
  const bare: LiveAudio = { deltas: 0, gatedFrames: 0 };
  assert.equal(bare.deltaMsP50, undefined);
});
