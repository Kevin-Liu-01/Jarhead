import { test } from "node:test";
import assert from "node:assert/strict";
import { addLogSink } from "@jarhead/core";
import type { AudioState, LedgerRow, LiveAudio } from "@jarhead/protocol";
import { audioLine } from "../audio-telemetry.ts";
import { rows, settle, world, type World } from "./world.ts";

/**
 * Voice PLAN W1.5: every audio status line the app wrote went to NSLog, which this Mac does not
 * keep, so no cause of the spotty voice could be confirmed from a real session. The engine now
 * keeps Live's arrival figures for the session (`snapshot.liveAudio`), writes one `audio:` line to
 * daemon.log at most every 5 s while a session is open and the app's counters moved, a summary at
 * close, and one `audio.playout` ledger row at session close with the last counters. No words.
 */

/** 40 ms of 24 kHz PCM16. */
const delta = (ms = 40): Buffer => Buffer.alloc(ms * 48, 1);

const FRAME: AudioState = {
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
  playout: { chunks: 10, underruns: 0, underrunMs: 0, longestUnderrunMs: 0, wouldBeUnderruns: 4, resets: 1, targetMs: 120, queuedMs: 121, queuedMinMs: 96, lateMaxMs: 7, droppedChunks: 0, droppedMs: 0 },
  duck: { ducks: 2, gate: 2, confirmed: 2, unconfirmed: 0, held: 0, refusedWords: 0, wordOnsetsSkipped: 0, duckedMs: 900, deepMs: 400, residualP50Dbfs: -61, residualP99Dbfs: -49, echoFloorDbfs: -58 },
  output: { rmsDbfs: -21.8, peakDbfs: -4.1, heardRmsDbfs: -22, audibleMs: 30_000, mixFormat: "48000 Hz ×2", volume: 0.62 },
};

async function awake(w: World): Promise<void> {
  await w.engine.start();
  await w.engine.ready();
  w.engine.updateSettings({ idleSleepMinutes: 0 });
  await w.engine.wake("test");
  await settle();
}

/** `n` deltas of `ms` each, `gapMs` of clock apart. */
function stream(w: World, n: number, gapMs: number, ms = 40): void {
  const live = w.lives.at(-1)!;
  for (let i = 0; i < n; i++) {
    if (i > 0) w.clock.t += gapMs;
    live.emit("audio", delta(ms));
  }
}

const liveAudio = (w: World): LiveAudio | undefined => (w.engine.snapshot() as { liveAudio?: LiveAudio }).liveAudio;

test("v2 telemetry: liveAudio counts Live's deltas, their sizes and their spacing inside a reply, and how far a reply ran ahead of real time", async () => {
  const w = world();
  try {
    await awake(w);
    // Reply 1: paced in real time, 25 deltas of 40 ms, then one 80 ms late, then a 120 ms delta.
    stream(w, 25, 40);
    w.clock.t += 80;
    w.lives.at(-1)!.emit("audio", delta());
    w.clock.t += 40;
    w.lives.at(-1)!.emit("audio", delta(120));
    let a = liveAudio(w);
    assert.ok(a, "liveAudio is in the snapshot while a session is open");
    assert.equal(a.deltas, 27);
    assert.equal(a.deltaMsP50, 40);
    assert.equal(a.deltaMsMax, 120);
    assert.equal(a.arrivalMaxMs, 80);
    assert.equal(a.aheadMs, 0, "paced: never ahead of real time");
    assert.equal(a.gatedFrames, 0);
    // Reply 2 and 3, 2 s later each: ten deltas handed over at once (Live sending ahead), 360 ms past real time at their peak.
    w.clock.t += 2000;
    stream(w, 10, 0);
    w.clock.t += 2000;
    stream(w, 10, 0);
    a = liveAudio(w)!;
    assert.equal(a.deltas, 47);
    assert.equal(a.arrivalMaxMs, 80, "the 2 s between replies is not an arrival gap");
    assert.equal(a.aheadMs, 360, "the median reply ran 360 ms ahead");
    // After a stop the output gate drops what Live still sends; those are counted.
    await w.engine.command({ type: "interrupt" });
    w.lives.at(-1)!.emit("audio", delta());
    w.lives.at(-1)!.emit("audio", delta());
    assert.equal(liveAudio(w)!.gatedFrames, 2);
    assert.equal(liveAudio(w)!.deltas, 49, "a gated delta still arrived");
  } finally {
    await w.engine.stop();
  }
});

test("v2 telemetry: one audio: line at most every 5 s while a session is open and the app's counters moved, and a summary at close", async () => {
  const w = world();
  const lines: string[] = [];
  const formats: string[] = [];
  const off = addLogSink((_level, scope, message) => {
    if (scope !== "engine") return;
    if (/^audio(:| \(session )/.test(message)) lines.push(message);
    if (message.startsWith("audio format")) formats.push(message);
  });
  try {
    await awake(w);
    assert.deepEqual(formats, ["audio format: session.started echoed none (session sess_1)"], "the echoed format is said once at session.started");
    stream(w, 5, 40);
    w.engine.reportAudioState(FRAME);
    assert.equal(lines.length, 1, `the first frame of a session logs: ${lines.join(" | ")}`);
    assert.match(lines[0]!, /^audio: playout 0 underruns \(would be 4\) · queued 121 ms min 96 · late max 7 ms · duck 2 \(2 gate · 2 confirmed\) · residual p50 -61 p99 -49 dBFS · output rms -21\.8 peak -4\.1 dBFS vol 0\.62 · live 40 ms deltas · arrival p99 40 ms · ahead 0 ms · loop max \d+ ms$/);
    // A second later the counters moved: within 5 s, no line.
    w.clock.t += 1000;
    w.engine.reportAudioState({ ...FRAME, playout: { ...FRAME.playout!, chunks: 30 } });
    w.clock.t += 3000;
    w.engine.reportAudioState({ ...FRAME, playout: { ...FRAME.playout!, chunks: 60 } });
    assert.equal(lines.length, 1, "at most one line per 5 s");
    // 5 s after the first line, a frame whose counters moved logs again.
    w.clock.t += 1000;
    w.engine.reportAudioState({ ...FRAME, playout: { ...FRAME.playout!, chunks: 90, underruns: 1, underrunMs: 30, longestUnderrunMs: 30 } });
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /^audio: playout 1 underrun \(would be 4\)/);
    // The same counters again, 6 s on: nothing new to say.
    w.clock.t += 6000;
    w.engine.reportAudioState({ ...FRAME, playout: { ...FRAME.playout!, chunks: 90, underruns: 1, underrunMs: 30, longestUnderrunMs: 30 }, guardTailMs: 1 });
    assert.equal(lines.length, 2, "unchanged counters log nothing");
    await w.engine.command({ type: "sleep" });
    await settle();
    const closing = lines.filter((l) => l.startsWith("audio (session "));
    assert.equal(closing.length, 1, `one summary at close: ${lines.join(" | ")}`);
    assert.match(closing[0]!, /^audio \(session sess_1 closed\): playout 1 underrun/);
    assert.doesNotMatch(lines.join("\n"), /\btext\b|transcript/, "no words in the lines");
  } finally {
    off();
    await w.engine.stop();
  }
});

test("v2 telemetry: no app frame and no session, no line; asleep, a frame logs nothing", async () => {
  const w = world();
  const lines: string[] = [];
  const off = addLogSink((_level, scope, message) => {
    if (scope === "engine" && /^audio(:| \(session )/.test(message)) lines.push(message);
  });
  try {
    await w.engine.start();
    await w.engine.ready();
    w.engine.reportAudioState(FRAME);
    assert.equal(lines.length, 0, "asleep: the graph's frame is kept, not logged");
    assert.equal(liveAudio(w), undefined, "no session, no liveAudio");
  } finally {
    off();
    await w.engine.stop();
  }
});

test("v2 telemetry: session close appends one audio.playout row with the app's last counters and the session's Live figures, before the closed row", async () => {
  const w = world();
  try {
    await awake(w);
    stream(w, 12, 40);
    w.engine.reportAudioState(FRAME);
    w.clock.t += 7000;
    const last: AudioState = { ...FRAME, playout: { ...FRAME.playout!, chunks: 412, underruns: 2, underrunMs: 70, longestUnderrunMs: 50 } };
    w.engine.reportAudioState(last);
    await w.engine.command({ type: "sleep" });
    await settle();
    type PlayoutRow = Extract<LedgerRow, { type: "audio.playout" }>;
    const got = rows<PlayoutRow>(w, "audio.playout");
    assert.equal(got.length, 1, "one row per session");
    const row = got[0]!;
    assert.equal(row.sessionId, "sess_1");
    assert.deepEqual(row.playout, last.playout, "the app's last counters");
    assert.deepEqual(row.duck, FRAME.duck);
    assert.deepEqual(row.output, FRAME.output);
    assert.equal(row.liveAudio?.deltas, 12, "the row carries Live's figures as `liveAudio`, the contract's name");
    assert.equal(row.liveAudio?.deltaMsP50, 40);
    assert.equal((row as Record<string, unknown>)["live"], undefined, "never under another name");
    const all = w.engine.ledger.read(w.clock.t) as unknown as LedgerRow[];
    const at = all.findIndex((r) => r.type === "audio.playout");
    const closed = all.findIndex((r) => r.type === "session.closed");
    assert.ok(at >= 0 && closed > at, "the row lands before session.closed, inside the session");
    assert.equal(liveAudio(w), undefined, "closed: no liveAudio");
    // A second session that never heard Live and never got a frame writes nothing.
    w.engine.reportAudioState(undefined);
    await w.engine.wake("test");
    await settle();
    await w.engine.command({ type: "sleep" });
    await settle();
    assert.equal(rows<PlayoutRow>(w, "audio.playout").length, 1, "nothing measured, no row");
  } finally {
    await w.engine.stop();
  }
});

test("v2 telemetry: the audio: line leaves out a live figure the contract lets be absent", () => {
  assert.equal(audioLine(undefined, { deltas: 3, gatedFrames: 0 }), "live 3 deltas");
  assert.equal(audioLine(undefined, { deltas: 30, gatedFrames: 0, deltaMsP50: 40, aheadMs: 0 }), "live 40 ms deltas · ahead 0 ms");
  assert.equal(audioLine(undefined, undefined), "nothing measured");
});
