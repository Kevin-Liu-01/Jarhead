import { test } from "node:test";
import assert from "node:assert/strict";
import type { AudioState, LedgerRow, LiveAudio } from "@jarhead/protocol";
import * as doctor from "../doctor.ts";
import { audioChecks, audioStatusLines, type Check } from "../doctor.ts";

/**
 * Voice PLAN W1.5 (CLI): `jarhead status` shows four playback lines under the audio block (playout,
 * duck, output, live), and with no app connected the last session's figures from the ledger. The
 * doctor gets five `audio` rows, none required: playout, duck, residual echo, output level, live
 * arrival. Fixture states, text compared, no daemon.
 */

type PlayoutRow = Extract<LedgerRow, { type: "audio.playout" }>;
type Extras = { readonly liveAudio?: LiveAudio; readonly lastPlayout?: PlayoutRow; readonly now?: number };
const statusLines = audioStatusLines as (state: AudioState | undefined, settings: { recording: boolean } | undefined, profiler?: undefined, extras?: Extras) => string[];
type CheckInput = Parameters<typeof audioChecks>[0] & Extras;
const checks = audioChecks as (i: CheckInput) => Check[];
const readLastPlayout = (doctor as { readLastPlayout?: (ledger: { read(at: number): unknown[] }, now: number, days?: number) => PlayoutRow | undefined }).readLastPlayout;

const NOW = Date.UTC(2026, 9, 5, 14, 30, 0);

/** Kevin's setup: the speakers, echo cancelled, a calm session. */
const CALM: AudioState = {
  running: true,
  voiceProcessing: true,
  duckLevel: 10,
  advancedDucking: true,
  agc: true,
  bypassed: false,
  rung: 2,
  wiring: "input-rate",
  hears: { name: "MacBook Pro Microphone", uid: "BuiltInMicrophoneDevice", rate: 48000, channels: 1, transport: "built-in" },
  speaks: { name: "MacBook Pro Speakers", uid: "BuiltInSpeakerDevice", rate: 48000, channels: 2, transport: "built-in" },
  tapFormat: "48000 Hz ×1 Float32",
  recording: false,
  fallback: false,
  guardOn: false,
  guardTailMs: 0,
  gated: 0,
  chunks: 0,
  breakthroughs: 0,
  sharedWith: [],
  inputMuted: false,
  aggregatePresent: true,
  playout: { chunks: 412, underruns: 0, underrunMs: 0, longestUnderrunMs: 0, wouldBeUnderruns: 4, resets: 3, targetMs: 120, queuedMs: 121, queuedMinMs: 96, lateMaxMs: 7, droppedChunks: 0, droppedMs: 0 },
  duck: { ducks: 2, gate: 2, confirmed: 2, unconfirmed: 0, held: 0, refusedWords: 0, wordOnsetsSkipped: 1, duckedMs: 900, deepMs: 400, residualP50Dbfs: -61, residualP99Dbfs: -49, echoFloorDbfs: -58 },
  output: { rmsDbfs: -21.8, peakDbfs: -4.1, heardRmsDbfs: -22, audibleMs: 90_000, mixFormat: "48000 Hz ×2", volume: 0.62 },
};

const LIVE: LiveAudio = { deltas: 900, deltaMsP50: 40, deltaMsMax: 120, arrivalP99Ms: 31, arrivalMaxMs: 182, aheadMs: 0, gatedFrames: 0, loopDelayMaxMs: 12, formatRate: 24_000 };

const PLAYBACK = [
  "             playout 0 underruns (zero-cushion would be 4) · queued 121 ms (min 96) · target 120 ms · late max 7 ms · 3 resets · 0 dropped",
  "             duck    2 (2 gate · 2 confirmed · 0 unconfirmed) · 0.9 s ducked, 0.4 s deep · residual p50 -61 / p99 -49 dBFS",
  "             output  rms -21.8 dBFS · peak -4.1 dBFS · heard -22.0 dBFS · mix 48000 Hz ×2 · volume 62%",
];
const LIVE_LINE = "             live    40 ms deltas · arrival p99 31 ms / max 182 ms · ahead 0 ms · loop max 12 ms · 24000 Hz";

test("v2 status: the four playback lines follow the audio block; an older app (no telemetry) prints none", () => {
  const lines = statusLines(CALM, { recording: false }, undefined, { liveAudio: LIVE });
  assert.equal(lines.length, 4 + 4);
  assert.deepEqual(lines.slice(4), [...PLAYBACK, LIVE_LINE]);
  // Without the daemon's live figures (a daemon before them, or main.ts not passing them yet): three lines.
  assert.deepEqual(statusLines(CALM, { recording: false }).slice(4), PLAYBACK);
  const { playout: _p, duck: _d, output: _o, ...older } = CALM;
  assert.equal(statusLines(older, { recording: false }).length, 4, "an app from before the telemetry: the block as it was");
});

test("v2 status: underruns and drops are counted in words, nothing voiced yet says so, a duck-less plain graph prints no duck line", () => {
  const rough: AudioState = {
    ...CALM,
    voiceProcessing: false,
    recording: true,
    playout: { ...CALM.playout!, underruns: 1, underrunMs: 40, longestUnderrunMs: 40, droppedChunks: 2, droppedMs: 80, queuedMinMs: 0 },
    output: { audibleMs: 0, mixFormat: "48000 Hz ×2" },
  };
  const { duck: _d, ...plain } = rough;
  const lines = statusLines(plain, { recording: true }).slice(4);
  assert.deepEqual(lines, [
    "             playout 1 underrun (zero-cushion would be 4) · queued 121 ms (min 0) · target 120 ms · late max 7 ms · 3 resets · 2 dropped (80 ms)",
    "             output  nothing voiced yet · mix 48000 Hz ×2",
  ]);
});

test("v2 status: no app connected, the last session's figures come from the ledger row", () => {
  const row: PlayoutRow = { at: NOW - 3_600_000, type: "audio.playout", sessionId: "live_u7_abcdefgh1234", playout: CALM.playout!, duck: CALM.duck!, output: CALM.output!, liveAudio: LIVE };
  const lines = statusLines(undefined, { recording: false }, undefined, { lastPlayout: row, now: NOW });
  assert.equal(lines[0], "  audio      no app connected");
  assert.equal(lines[1], "             last session …abcdefgh1234 · 1 h ago (the ledger)");
  assert.deepEqual(lines.slice(2), [...PLAYBACK, LIVE_LINE]);
  // readLastPlayout looks back 7 days: a clock time alone would read as today.
  const old = statusLines(undefined, { recording: false }, undefined, { lastPlayout: { ...row, at: NOW - 6 * 86_400_000 }, now: NOW });
  assert.equal(old[1], "             last session …abcdefgh1234 · 6 d ago (the ledger)");
});

test("v2 status: the app connected and no session open, the live line is the last session's, and says so", () => {
  const row: PlayoutRow = { at: NOW - 3_600_000, type: "audio.playout", sessionId: "s1", liveAudio: LIVE };
  const lines = statusLines(CALM, { recording: false }, undefined, { lastPlayout: row, now: NOW });
  assert.deepEqual(lines.slice(4), [...PLAYBACK, `${LIVE_LINE} · last session, 1 h ago`]);
  // A session open: the daemon's own figures, never the row's.
  assert.deepEqual(statusLines(CALM, { recording: false }, undefined, { liveAudio: LIVE, lastPlayout: row, now: NOW }).slice(4), [...PLAYBACK, LIVE_LINE]);
});

test("v2 status: readLastPlayout finds the newest audio.playout row across the last days", () => {
  assert.ok(readLastPlayout, "doctor.ts exports readLastPlayout");
  const day = 86_400_000;
  const older: PlayoutRow = { at: NOW - day - 5, type: "audio.playout", sessionId: "a", liveAudio: LIVE };
  const newer: PlayoutRow = { at: NOW - 60_000, type: "audio.playout", sessionId: "b", playout: CALM.playout! };
  const files = new Map<number, unknown[]>([
    [Math.floor(NOW / day), [{ at: NOW - 90_000, type: "heard" }, newer, { at: NOW - 30_000, type: "session.closed" }]],
    [Math.floor((NOW - day) / day), [older]],
  ]);
  const ledger = { read: (at: number) => files.get(Math.floor(at / day)) ?? [] };
  assert.equal(readLastPlayout(ledger, NOW)?.sessionId, "b");
  assert.equal(readLastPlayout({ read: (at: number) => (Math.floor(at / day) === Math.floor(NOW / day) ? [] : (files.get(Math.floor(at / day)) ?? [])) }, NOW)?.sessionId, "a");
  assert.equal(readLastPlayout({ read: () => [] }, NOW), undefined);
});

const base = { settings: { recording: false }, phase: "listening" as const, profiler: undefined, probe: undefined, appBuiltAt: undefined, now: NOW };
const playback = (c: readonly Check[]): Check[] => c.filter((r) => ["playout", "duck", "residual echo", "output level", "live arrival"].includes(r.name));

test("v2 doctor: a calm session reads five ok rows, none required", () => {
  const rows = playback(checks({ ...base, state: CALM, liveAudio: LIVE }));
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.required]), [
    ["playout", "ok", false],
    ["duck", "ok", false],
    ["residual echo", "ok", false],
    ["output level", "ok", false],
    ["live arrival", "ok", false],
  ]);
  assert.equal(rows[0]!.detail, "0 underruns (zero-cushion would be 4) · longest 0 ms · late max 7 ms · arrival p99 31 ms");
  assert.equal(rows[2]!.detail, "p50 -61 / p99 -49 dBFS · echo floor -58 dBFS");
  assert.equal(rows[3]!.detail, "heard -22.0 dBFS · peak -4.1 dBFS · volume 62%");
  assert.equal(rows[4]!.detail, "40 ms deltas · arrival p99 31 ms / max 182 ms · ahead 0 ms · loop max 12 ms · 24000 Hz");
});

test("v2 doctor: each row warns on its own rule and says what explains it", () => {
  const lateApp = playback(checks({ ...base, state: { ...CALM, playout: { ...CALM.playout!, underruns: 4, underrunMs: 300, longestUnderrunMs: 90, lateMaxMs: 160 } }, liveAudio: LIVE }));
  assert.equal(lateApp[0]!.status, "warn", "4 underruns in 1.5 min of speech, longest 90 ms");
  assert.match(lateApp[0]!.fix ?? "", /late max 160 ms/);
  assert.match(lateApp[0]!.fix ?? "", /the app/);
  const lateNet = playback(checks({ ...base, state: { ...CALM, playout: { ...CALM.playout!, underruns: 3, underrunMs: 150, longestUnderrunMs: 60 } }, liveAudio: { ...LIVE, arrivalP99Ms: 140 } }));
  assert.equal(lateNet[0]!.status, "warn", "3 underruns in 1.5 min: more than one a minute");
  assert.match(lateNet[0]!.fix ?? "", /arrival p99 140 ms/);
  assert.match(lateNet[0]!.fix ?? "", /network or the daemon/);
  const oneShort = playback(checks({ ...base, state: { ...CALM, output: { ...CALM.output!, audibleMs: 20_000 }, playout: { ...CALM.playout!, underruns: 1, underrunMs: 30, longestUnderrunMs: 30 } }, liveAudio: LIVE }));
  assert.equal(oneShort[0]!.status, "ok", "one short underrun in 20 s of speech is under the line");

  const ducks = playback(checks({ ...base, state: { ...CALM, duck: { ...CALM.duck!, ducks: 5, unconfirmed: 3 } }, liveAudio: LIVE }));
  assert.equal(ducks[1]!.status, "warn", "3 unconfirmed in 1.5 min");
  const echo = playback(checks({ ...base, state: { ...CALM, duck: { ...CALM.duck!, residualP99Dbfs: -44 } }, liveAudio: LIVE }));
  assert.equal(echo[2]!.status, "warn");
  assert.equal(echo[2]!.fix, "lower the volume, or the gate trips on Jarhead's own echo");

  const quiet = playback(checks({ ...base, state: { ...CALM, output: { ...CALM.output!, volume: 0.25 } }, liveAudio: LIVE }));
  assert.equal(quiet[3]!.status, "warn", "volume 25%: hard to hear");
  assert.match(quiet[3]!.fix ?? "", /25%/);
  assert.equal(playback(checks({ ...base, state: { ...CALM, output: { ...CALM.output!, volume: 0.31 } }, liveAudio: LIVE }))[3]!.status, "ok", "31% is over the line (PLAN: under 30%)");
  const faint = playback(checks({ ...base, state: { ...CALM, output: { ...CALM.output!, heardRmsDbfs: -33 } }, liveAudio: LIVE }));
  assert.equal(faint[3]!.status, "warn", "heard under -30 dBFS");
  const hot = playback(checks({ ...base, state: { ...CALM, output: { ...CALM.output!, peakDbfs: -0.5 } }, liveAudio: LIVE }));
  assert.equal(hot[3]!.status, "warn", "peaks at the limiter");
  assert.match(hot[3]!.fix ?? "", /limiter/);

  for (const live of [{ ...LIVE, arrivalP99Ms: 121 }, { ...LIVE, loopDelayMaxMs: 101 }, { ...LIVE, formatRate: 16_000 }]) {
    assert.equal(playback(checks({ ...base, state: CALM, liveAudio: live }))[4]!.status, "warn", JSON.stringify(live));
  }
});

test("v2 doctor: no app and no session reads the ledger's last session; nothing measured adds no row", () => {
  const row: PlayoutRow = { at: NOW - 3_600_000, type: "audio.playout", sessionId: "s1", playout: { ...CALM.playout!, underruns: 5, longestUnderrunMs: 120 }, duck: CALM.duck!, output: CALM.output!, liveAudio: LIVE };
  const rows = playback(checks({ ...base, state: undefined, phase: "asleep", lastPlayout: row }));
  assert.equal(rows.length, 5);
  assert.equal(rows[0]!.status, "warn");
  assert.match(rows[0]!.detail, / · last session, 1 h ago$/);
  assert.deepEqual(playback(checks({ ...base, state: undefined, phase: "asleep" })), [], "nothing measured: the doctor reads as before");
});

test("v2 status and doctor: a liveAudio with only the contract's required counts (W2-5 makes the rest optional) prints and checks without inventing figures", () => {
  const bare: LiveAudio = { deltas: 3, gatedFrames: 0 };
  const lines = statusLines(CALM, { recording: false }, undefined, { liveAudio: bare });
  assert.equal(lines.at(-1), "             live    3 deltas");
  const rows = playback(checks({ ...base, state: CALM, liveAudio: bare }));
  const live = rows.find((r) => r.name === "live arrival");
  assert.deepEqual([live?.status, live?.detail], ["ok", "3 deltas"]);
  assert.equal(rows.find((r) => r.name === "playout")?.detail, "0 underruns (zero-cushion would be 4) · longest 0 ms · late max 7 ms", "no arrival figure, none printed");
  const partial: LiveAudio = { deltas: 40, gatedFrames: 1, deltaMsP50: 40, arrivalP99Ms: 130 };
  assert.equal(statusLines(CALM, { recording: false }, undefined, { liveAudio: partial }).at(-1), "             live    40 ms deltas · arrival p99 130 ms");
  assert.equal(playback(checks({ ...base, state: CALM, liveAudio: partial })).find((r) => r.name === "live arrival")?.status, "warn", "arrival p99 130 ms is over the line");
});

test("v2 doctor: the app is blamed for underruns only when its queue ran late enough to explain them; with no figure that does, the cause is not known yet", () => {
  // Kevin ran the doctor after sleeping Jarhead: the app's frame has the counters, no session is open, so no liveAudio.
  const rough: AudioState = { ...CALM, playout: { ...CALM.playout!, underruns: 6, underrunMs: 400, longestUnderrunMs: 150, lateMaxMs: 2 } };
  const unknown = playback(checks({ ...base, phase: "asleep", state: rough }))[0]!;
  assert.equal(unknown.status, "warn");
  assert.equal(unknown.fix, "the cause is not known yet: the app's queue ran at most 2 ms late, and Live's arrival was not measured");
  // Live paced in real time (arrival p99 31 ms for 40 ms deltas): no lateness on either side explains a 150 ms hole.
  assert.equal(playback(checks({ ...base, state: rough, liveAudio: LIVE }))[0]!.fix, "the cause is not known yet: the app's queue ran at most 2 ms late, and Live fell at most 0 ms behind");
  // The window's late max is 2 ms, but since the graph started a play block waited 160 ms: that is the app.
  const graph = playback(checks({ ...base, state: { ...rough, playout: { ...rough.playout!, lateMaxGraphMs: 160 } }, liveAudio: LIVE }))[0]!;
  assert.match(graph.detail, /late max 160 ms/);
  assert.match(graph.fix ?? "", /^the speaker's queue in the app ran late \(late max 160 ms\)/);
  // As long as the longest hole is material too, even under 40 ms.
  const short = { ...rough, playout: { ...rough.playout!, underruns: 9, longestUnderrunMs: 30, lateMaxMs: 30 } };
  assert.match(playback(checks({ ...base, state: short, liveAudio: LIVE }))[0]!.fix ?? "", /the app, not the network$/);
});

test("v2 doctor: with no session open, Live's figures come from the newest audio.playout row, and the rows say it was the last session", () => {
  const rough: AudioState = { ...CALM, playout: { ...CALM.playout!, underruns: 6, underrunMs: 400, longestUnderrunMs: 150, lateMaxMs: 2 } };
  const row: PlayoutRow = { at: NOW - 3_600_000, type: "audio.playout", sessionId: "s1", playout: rough.playout!, liveAudio: { ...LIVE, arrivalP99Ms: 210, arrivalMaxMs: 420 } };
  const rows = playback(checks({ ...base, phase: "asleep", state: rough, lastPlayout: row }));
  assert.equal(rows[0]!.detail, "6 underruns (zero-cushion would be 4) · longest 150 ms · late max 2 ms · arrival p99 210 ms (last session)");
  assert.equal(rows[0]!.fix, "Live's audio arrived late (arrival p99 210 ms): the network or the daemon, not the app");
  const live = rows.find((r) => r.name === "live arrival")!;
  assert.equal(live.status, "warn");
  assert.match(live.detail, / · last session, 1 h ago$/);
  assert.doesNotMatch(rows.find((r) => r.name === "duck")!.detail, /last session/, "the app's own rows are the app's");
  // A session open: the daemon's figures win over the row.
  const open = playback(checks({ ...base, state: rough, liveAudio: LIVE, lastPlayout: row }));
  assert.doesNotMatch(open[0]!.detail, /last session/);
  assert.doesNotMatch(open.find((r) => r.name === "live arrival")!.detail, /last session/);
});
