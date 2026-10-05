import { test } from "node:test";
import assert from "node:assert/strict";
import { addLogSink } from "@jarhead/core";
import type { AudioState, LedgerRow, LiveAudio } from "@jarhead/protocol";
import { AudioTelemetry, FigureWindow, audioLine, type LoopMonitor } from "../audio-telemetry.ts";
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

/** A monitorEventLoopDelay stand-in: `max` is set by the test, in ms; reset and disable are counted. */
class FakeLoop implements LoopMonitor {
  maxMs = 0;
  resets = 0;
  disabled = false;
  get max(): number {
    return this.maxMs * 1e6;
  }
  enable(): void {}
  disable(): void {
    this.disabled = true;
  }
  reset(): void {
    this.resets++;
    this.maxMs = 0;
  }
}

function telemetry(): { t: AudioTelemetry; clock: { t: number }; lines: string[]; loops: FakeLoop[] } {
  const clock = { t: 1_000_000 };
  const lines: string[] = [];
  const loops: FakeLoop[] = [];
  const t = new AudioTelemetry({
    now: () => clock.t,
    log: (line) => {
      if (/^audio(:| \(session )/.test(line)) lines.push(line);
    },
    loopMonitor: () => {
      const l = new FakeLoop();
      loops.push(l);
      return l;
    },
  });
  return { t, clock, lines, loops };
}

test("v2 telemetry: loop max is the event loop's longest delay this window, less the monitor's 10 ms sampling, and each audio: line starts a new window", () => {
  const { t, clock, lines, loops } = telemetry();
  t.open("sess_a", { type: "audio/pcm", rate: 24_000 });
  for (let i = 0; i < 5; i++) {
    t.delta("sess_a", 40 * 48, false);
    clock.t += 40;
  }
  const loop = loops[0]!;
  // One play block that waited behind a slow tick: 160 ms measured, 150 ms of it the stall.
  loop.maxMs = 160;
  assert.equal(t.snapshotField().liveAudio?.loopDelayMaxMs, 150, "the sampling interval is taken off");
  t.frame(FRAME);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, / · loop max 150 ms$/);
  assert.equal(loop.resets, 1, "the line closed the window");
  // The next window is calm: 12 ms measured.
  loop.maxMs = 12;
  clock.t += 5000;
  t.frame({ ...FRAME, playout: { ...FRAME.playout!, queuedMs: 140 } });
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, / · loop max 2 ms$/, "the stall no longer pins the figure");
  // Only the loop figure moved: that is not news, so no line and the window keeps running.
  loop.maxMs = 40;
  clock.t += 6000;
  t.frame({ ...FRAME, playout: { ...FRAME.playout!, queuedMs: 140 } });
  assert.equal(lines.length, 2, "a moving loop figure alone writes no line");
  assert.equal(loop.resets, 2);
  assert.equal(t.snapshotField().liveAudio?.loopDelayMaxMs, 30);
  loop.maxMs = 5;
  assert.equal(t.snapshotField().liveAudio?.loopDelayMaxMs, 0, "never below zero");
});

test("v2 telemetry: a session that never emits closed does not keep its meter: the next open retires it, its monitor stops, a late close still writes its row", () => {
  const { t, clock, loops } = telemetry();
  t.open("sess_a", undefined);
  for (let i = 0; i < 4; i++) {
    t.delta("sess_a", 40 * 48, false);
    clock.t += 40;
  }
  // live.on("error") settled sess_a and nothing more: no close. The reconnect opens sess_b.
  t.open("sess_b", undefined);
  assert.equal(t.running, 1, "one meter runs, the open session's");
  assert.equal(loops[0]!.disabled, true, "sess_a's 10 ms event-loop timer is off");
  assert.equal(loops[1]!.disabled, false);
  t.delta("sess_a", 40 * 48, false);
  assert.equal(t.running, 1, "a straggling delta for a retired session starts no meter");
  t.delta("sess_b", 40 * 48, false);
  assert.equal(t.snapshotField().liveAudio?.deltas, 1, "the snapshot reports the open session");
  // sess_a's closed arrives after all: its row carries its own figures.
  const late = t.close("sess_a", undefined);
  assert.equal(late?.type, "audio.playout");
  assert.equal(late?.type === "audio.playout" ? late.liveAudio?.deltas : undefined, 4);
  assert.equal(t.snapshotField().liveAudio?.deltas, 1, "closing the retired session leaves the open one alone");
  // Sessions that never close, one after another: still one meter, and the retired figures stay bounded.
  for (let i = 0; i < 20; i++) {
    t.open(`sess_${i}`, undefined);
    t.delta(`sess_${i}`, 40 * 48, false);
  }
  assert.equal(t.running, 1);
  assert.equal(loops.filter((l) => !l.disabled).length, 1, "every monitor but the open session's is off");
  assert.equal(t.close("sess_0", undefined), undefined, "a session retired long ago is forgotten: no figures, no app frame, no row");
  assert.equal(t.close("sess_18", undefined)?.type, "audio.playout", "a recent one still closes with its figures");
});

test("v2 telemetry: liveAudio leaves out what it has not measured: one delta has a size but no arrival and no lead", () => {
  const { t } = telemetry();
  t.open("sess_a", undefined);
  t.delta("sess_a", 40 * 48, false);
  const live = t.snapshotField().liveAudio!;
  assert.equal(live.deltas, 1);
  assert.equal(live.deltaMsP50, 40);
  assert.equal(live.arrivalP99Ms, undefined);
  assert.equal(live.arrivalMaxMs, undefined);
  assert.equal(live.aheadMs, undefined);
  t.close("sess_a", undefined);
  t.open("sess_b", undefined);
  assert.deepEqual(Object.keys(t.snapshotField().liveAudio!).sort(), ["deltas", "gatedFrames", "loopDelayMaxMs"], "nothing heard yet: the counts and the loop");
});

/** The nearest rank over a plain sorted copy: what FigureWindow replaces, kept here as the reference. */
function sortedRank(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

test("v2 telemetry: FigureWindow's percentiles equal the rounded nearest rank of the newest figures, with and without the reply under way", () => {
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  for (const keep of [1, 2, 7, 64]) {
    const w = new FigureWindow(keep);
    const all: number[] = [];
    for (let i = 0; i < 400; i++) {
      // Jittered gaps, repeats, a few far outliers and the odd negative (a clock step back).
      const v = rnd() < 0.05 ? rnd() * 5000 : rnd() < 0.3 ? 40 : rnd() * 200 - 3;
      w.add(v);
      all.push(v);
      const newest = all.slice(-keep);
      assert.equal(w.size, newest.length);
      for (const p of [0.01, 0.5, 0.99, 1]) {
        assert.equal(w.percentile(p), Math.round(sortedRank(newest, p)), `keep ${keep}, n ${all.length}, p ${p}`);
        const extra = rnd() * 300 - 10;
        assert.equal(w.percentile(p, extra), Math.round(sortedRank([...newest, extra], p)), `keep ${keep}, n ${all.length}, p ${p}, extra ${extra}`);
      }
    }
  }
  assert.equal(new FigureWindow().percentile(0.5), 0, "empty");
  assert.equal(new FigureWindow().percentile(0.5, 12.4), 12, "only the reply under way");
});

test("v2 telemetry: at the cap the snapshot's percentiles read the newest 4096 figures and the maxima the whole session, as the sorted reference does", () => {
  const { t, clock } = telemetry();
  t.open("sess_a", { type: "audio/pcm", rate: 24_000 });
  const sizes: number[] = [];
  const gaps: number[] = [];
  let seed = 3;
  const rnd = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 5000; i++) {
    const gap = 20 + Math.floor(rnd() * 30);
    if (i > 0) {
      clock.t += gap;
      gaps.push(gap);
    }
    const ms = 20 + Math.floor(rnd() * 40);
    sizes.push(ms);
    t.delta("sess_a", ms * 48, false);
  }
  const live = t.snapshotField().liveAudio!;
  assert.equal(live.deltas, 5000);
  assert.equal(live.deltaMsP50, sortedRank(sizes.slice(-4096), 0.5), "the newest 4096 sizes");
  assert.equal(live.arrivalP99Ms, sortedRank(gaps.slice(-4096), 0.99), "the newest 4096 gaps");
  assert.equal(live.deltaMsMax, Math.max(...sizes), "the maxima are the session's");
  assert.equal(live.arrivalMaxMs, Math.max(...gaps));
});

test("v2 telemetry: the audio: line's late max is the longest wait in any frame since the last line, and the graph's figure rides beside it", () => {
  const { t, clock, lines } = telemetry();
  t.open("sess_a", undefined);
  t.delta("sess_a", 40 * 48, false);
  const at = (lateMaxMs: number, extra: Partial<NonNullable<AudioState["playout"]>> = {}): AudioState => ({ ...FRAME, playout: { ...FRAME.playout!, lateMaxMs, ...extra } });
  t.frame(at(7, { lateMaxGraphMs: 31 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, / · late max 7 ms \(31 ms since start\) · /);
  // A 300 ms stall lands in a frame a second later: the rate limit keeps it out of the log for now.
  clock.t += 1000;
  t.frame(at(300, { chunks: 20, lateMaxGraphMs: 300 }));
  assert.equal(lines.length, 1);
  // The next frame's own window is calm; the line carries the stall anyway.
  clock.t += 4500;
  t.frame(at(4, { chunks: 40, lateMaxGraphMs: 300 }));
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, / · late max 300 ms \(300 ms since start\) · /);
  // The line closed the fold: the next one says what came after it.
  clock.t += 5000;
  t.frame(at(5, { chunks: 60, lateMaxGraphMs: 300 }));
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, / · late max 5 ms \(300 ms since start\) · /);
  // An app before lateMaxGraphMs: the window's figure alone, as before.
  clock.t += 5000;
  t.frame(at(6, { chunks: 80 }));
  assert.match(lines[3]!, / · late max 6 ms · duck /);
  // A stall between the last line and the close: the summary carries it, the row keeps the app's own figures.
  clock.t += 1000;
  t.frame(at(220, { chunks: 90 }));
  clock.t += 1000;
  const last = at(3, { chunks: 95 });
  t.frame(last);
  const row = t.close("sess_a", last);
  assert.match(lines.at(-1)!, /^audio \(session sess_a closed\): .* · late max 220 ms · /);
  assert.equal(row?.type === "audio.playout" ? row.playout?.lateMaxMs : undefined, 3, "the ledger row is the app's frame as it came");
  // A new session starts its own fold.
  t.open("sess_b", undefined);
  t.delta("sess_b", 40 * 48, false);
  t.frame(at(2, { chunks: 1 }));
  assert.match(lines.at(-1)!, /^audio: .* · late max 2 ms · /);
});
