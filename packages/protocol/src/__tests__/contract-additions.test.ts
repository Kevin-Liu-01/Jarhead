// W2-5: the contract additions wave 3 consumes and the voice telemetry V2 fills.
//
// - APP-3: PROTOCOL_VERSION rides both hellos, and `app.version` is the problem a skew raises.
// - V8 / LM-2: a coalesced `session.usage` row, and `lost` as the reason a session the daemon died in is closed with.
// - SL-14: a `fired` event says whether it rang.
// - SL-15: `automation.failed` is the problem a red unattended fire raises.
// - LM-6: the `ledger.days` reply carries each day's totals.
// - Voice PLAN W1.5: AudioState gains `playout`, `duck` and `output`; the snapshot gains `liveAudio`; the
//   ledger gains an `audio.playout` row at session close.
//
// Every addition is optional on the wire, so an old app and a new daemon (or the reverse) still parse each
// other. Protocol.swift is read as text and pinned field for field: a TS field without its mirror fails
// here, not as a snapshot the app cannot decode. The probe fixture (apps/mac/Scripts/fixtures) carries one
// of each, so protocol-probe.sh decodes them with the app's own Codable mirrors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  SESSION_LOST_REASON,
  isAudioState,
  type AudioDuck,
  type AudioDuckLast,
  type AudioOutput,
  type AudioPlayout,
  type AudioState,
  type AutomationEvent,
  type LedgerDayTotals,
  type LedgerRow,
  type LiveAudio,
  type Problem,
  type ProblemKind,
  type Snapshot,
} from "../index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SWIFT = readFileSync(join(ROOT, "apps/mac/Sources/Jarhead/Model/Protocol.swift"), "utf8");
type Frame = Record<string, unknown> & { readonly type: string };
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "apps/mac/Scripts/fixtures/snapshot-threads.json"), "utf8")) as Frame[];

/** The stored `public var`s of one Swift struct, name → declared type, read off its body at depth 1 (computed vars carry a `{` and are skipped). */
function swiftVars(name: string): Map<string, string> {
  const lines = SWIFT.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^public struct ${name}\\b`).test(l));
  assert.ok(start >= 0, `Protocol.swift declares public struct ${name}`);
  const vars = new Map<string, string>();
  let depth = 0;
  for (const line of lines.slice(start)) {
    const code = line.replace(/\/\/.*$/, "");
    if (depth === 1) {
      const m = /^\s*public var (\w+): ([^={]+?)\s*(=.*)?$/.exec(code);
      if (m && !code.includes("{")) vars.set(m[1] as string, (m[2] as string).trim());
    }
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (depth === 0 && code.includes("}")) break;
  }
  return vars;
}

const sameNames = (swift: Map<string, string>, ts: object, what: string): void => {
  assert.deepEqual([...swift.keys()].sort(), Object.keys(ts).sort(), `${what}: the Swift mirror declares exactly the protocol's fields`);
};

const frames = (type: string): Frame[] => FIXTURE.filter((f) => f.type === type);
const snapshots = (): Snapshot[] => frames("snapshot").map((f) => f["snapshot"] as Snapshot);
const ledgerRows = (): LedgerRow[] => frames("ledger.rows").flatMap((f) => f["rows"] as LedgerRow[]);

// ---- APP-3: one number both sides build in --------------------------------------------------------------

test("APP-3: PROTOCOL_VERSION is a positive integer; Protocol.swift's ProtocolVersion.current is the same number; the fixture's hello carries it", () => {
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION >= 1, `PROTOCOL_VERSION ${PROTOCOL_VERSION}`);
  const m = /public enum ProtocolVersion\s*\{[^}]*?public static let current = (\d+)/s.exec(SWIFT);
  assert.ok(m, "Protocol.swift declares ProtocolVersion.current");
  assert.equal(Number(m[1]), PROTOCOL_VERSION, "the app and the daemon build in the same version");
  const hello = frames("hello")[0];
  assert.ok(hello, "the fixture opens with a hello");
  assert.equal(hello["protocol"], PROTOCOL_VERSION, "the daemon's hello carries the version");
  assert.equal(typeof hello["version"], "string", "the package version stays beside it");
});

test("APP-3 and SL-15: ProblemKind gains app.version and automation.failed; Swift keeps Problem.kind a String, so an app that predates a kind still decodes it", () => {
  const added = { "app.version": 0, "automation.failed": 0 } satisfies Partial<Record<ProblemKind, 0>>;
  assert.equal(swiftVars("Problem").get("kind"), "String", "a kind this app does not know decodes as itself");
  const seen = new Map(snapshots().flatMap((s) => s.problems).map((p: Problem) => [p.kind, p] as const));
  for (const kind of Object.keys(added) as ProblemKind[]) {
    const p = seen.get(kind);
    assert.ok(p, `the fixture carries a ${kind} problem`);
    assert.ok(p.remedy?.label, `${kind} has its one remedy`);
  }
  assert.match(seen.get("app.version")?.text ?? "", /pnpm build:mac/, "the skew row names the rebuild");
  assert.equal(seen.get("app.version")?.remedy?.copy, "pnpm build:mac", "the command is offered to copy, never run");
});

// ---- V8 / LM-2: billed seconds a dead daemon cannot lose -------------------------------------------------

test("V8 / LM-2: session.usage is a LedgerRow; `lost` is the close reason for a session the daemon died in, dated and billed as its last usage row; Swift's LedgerRow reads both from the columns it has", () => {
  assert.equal(SESSION_LOST_REASON, "lost");
  const usage: LedgerRow = { at: 60_000, type: "session.usage", sessionId: "sess_a", usageSeconds: 60 };
  const lost: LedgerRow = { at: 60_000, type: "session.closed", sessionId: "sess_a", reason: SESSION_LOST_REASON, usageSeconds: 60 };
  assert.ok(JSON.stringify(usage).length < 100, "one row a minute stays small");
  assert.equal(lost.type, "session.closed", "readers that sum closed rows count it as they are");
  const row = swiftVars("LedgerRow");
  assert.equal(row.get("sessionId"), "String?");
  assert.equal(row.get("usageSeconds"), "Double?");
  assert.equal(row.get("reason"), "String?");
  assert.match(SWIFT, /static let lostReason = "lost"/, "the Swift side names the word once");
  const rows = ledgerRows();
  const usages = rows.filter((r): r is Extract<LedgerRow, { type: "session.usage" }> => r.type === "session.usage");
  const closedLost = rows.find((r): r is Extract<LedgerRow, { type: "session.closed" }> => r.type === "session.closed" && r.reason === SESSION_LOST_REASON);
  assert.ok(usages.length > 0, "the fixture carries session.usage rows");
  assert.ok(closedLost, "the fixture carries a session closed as lost");
  const last = usages.filter((u) => u.sessionId === closedLost.sessionId).at(-1);
  assert.equal(closedLost.usageSeconds, last?.usageSeconds, "a lost close carries the last usage row's seconds");
  assert.equal(closedLost.at, last?.at, "and its `at`, so a restart after midnight still closes it in the day it billed");
});

// ---- SL-14: a fire that did not ring says so -------------------------------------------------------------

test("SL-14: a fired AutomationEvent carries ring?: boolean (absent from a daemon before it); the Swift AutomationEvent has it; with ring the fired event stays under 290 B at the table's 80-char line cap", () => {
  const presses = [{ kind: "snooze", minutes: 10 }, { kind: "done" }] as const;
  // Ids and stamps as the engine mints them, the way protocol.test.ts measures the fired event without the flag (268 B).
  const base = { seq: 4096, at: 1_789_243_218_790, id: `auto_${(1_789_243_208_790).toString(36)}k3q9zx` };
  const opened: AutomationEvent = { ...base, kind: "fired", actions: ["open"], line: "notes · opened Notes", ok: true, presses, ring: false };
  const rang: AutomationEvent = { ...base, kind: "fired", actions: ["chime"], line: "x".repeat(80), ok: true, lateMs: 720_000, presses, ring: true };
  const bytes = Buffer.byteLength(JSON.stringify(rang));
  console.log(`[measure] fired with ring at an 80-char line: ${bytes} B`);
  assert.ok(bytes < 290, `${bytes} B`);
  assert.equal(opened.kind === "fired" ? opened.ring : undefined, false);
  assert.equal(swiftVars("AutomationEvent").get("ring"), "Bool?");
  const fired = frames("automation.event").map((f) => f["event"] as AutomationEvent).filter((e) => e.kind === "fired");
  assert.ok(fired.some((e) => e.kind === "fired" && e.ring === false), "the fixture carries a fire that acted and did not ring");
});

// ---- LM-6: the Ledger tab's day totals -------------------------------------------------------------------

test("LM-6: the ledger.days reply's totals are {day, sessions, billedSeconds}; Swift's LedgerDayTotals is the same three fields; the fixture's totals name days of its own list", () => {
  const total = { day: "2026-10-05", sessions: 4, billedSeconds: 603 } satisfies Required<LedgerDayTotals>;
  sameNames(swiftVars("LedgerDayTotals"), total, "LedgerDayTotals");
  assert.equal(swiftVars("LedgerDayTotals").get("sessions"), "Int");
  const reply = frames("ledger.days")[0];
  assert.ok(reply, "the fixture carries a ledger.days reply");
  const days = reply["days"] as string[];
  const totals = reply["totals"] as LedgerDayTotals[];
  assert.ok(Array.isArray(days) && days.length > 0, "the day list stays, for an app that reads only it");
  assert.ok(Array.isArray(totals) && totals.length > 0, "the totals ride beside it");
  for (const t of totals) {
    assert.ok(days.includes(t.day), `${t.day} is in the reply's day list`);
    assert.ok(Number.isInteger(t.sessions) && t.sessions >= 0 && Number.isFinite(t.billedSeconds) && t.billedSeconds >= 0, JSON.stringify(t));
  }
});

// ---- voice PLAN W1.5: the playback telemetry V2 fills --------------------------------------------------

const PLAYOUT = {
  chunks: 412, underruns: 0, underrunMs: 0, longestUnderrunMs: 0, wouldBeUnderruns: 4, resets: 3, targetMs: 120,
  queuedMs: 121, queuedMinMs: 96, lateMaxMs: 7, lateMaxGraphMs: 31, droppedChunks: 0, droppedMs: 0,
} satisfies Required<AudioPlayout>;
const LAST = { source: "gate", confirmed: true, depthDb: -20, runDbfs: -31.5, thresholdDbfs: -38, releasedAfterMs: 900, reason: "quiet after gate" } satisfies Required<AudioDuckLast>;
const DUCK = {
  ducks: 2, gate: 2, confirmed: 2, unconfirmed: 0, held: 0, refusedWords: 1, refusedLive: 0, wordOnsetsSkipped: 3, duckedMs: 900, deepMs: 400,
  residualP50Dbfs: -61, residualP99Dbfs: -49, echoFloorDbfs: -55, last: LAST,
} satisfies Required<AudioDuck>;
const OUTPUT = { rmsDbfs: -21.8, peakDbfs: -4.1, heardRmsDbfs: -22, audibleMs: 61_000, mixFormat: "48000 Hz ×2", volume: 0.62 } satisfies Required<AudioOutput>;
const LIVE = {
  deltas: 640, deltaMsP50: 40, deltaMsMax: 120, arrivalP99Ms: 31, arrivalMaxMs: 182, aheadMs: 0, gatedFrames: 0, loopDelayMaxMs: 12, formatRate: 24000,
} satisfies Required<LiveAudio>;

const FRAME: AudioState = {
  running: true, voiceProcessing: true, duckLevel: 10, rung: 2, wiring: "input-rate", tapFormat: "24000 Hz ×9 Float32",
  recording: false, fallback: false, guardOn: false, guardTailMs: 0, gated: 0, chunks: 340, breakthroughs: 0, inputMuted: false, aggregatePresent: true,
};

test("PLAN W1.5: isAudioState accepts a frame with and without playout, duck and output; a malformed one costs only itself, deleted from the frame, never the frame", () => {
  assert.ok(isAudioState(FRAME), "the frame of before the telemetry");
  const whole = { ...FRAME, playout: PLAYOUT, duck: DUCK, output: OUTPUT };
  assert.ok(isAudioState(whole), "the frame with all three");
  assert.deepEqual(whole, { ...FRAME, playout: PLAYOUT, duck: DUCK, output: OUTPUT }, "a well-formed frame is left as sent");
  const { queuedMinMs: _q, ...playoutBare } = PLAYOUT;
  const { last: _l, residualP50Dbfs: _p50, residualP99Dbfs: _p99, echoFloorDbfs: _e, refusedLive: _r, ...duckBare } = DUCK;
  assert.ok(isAudioState({ ...FRAME, playout: playoutBare, duck: duckBare, output: {} }), "a silent window: no backlog minimum, no residual yet, no voiced chunk");
  // [why, the bad telemetry, the frame it should leave]: the same frame with the bad object (or the duck's bad `last`) gone.
  const { last: _dropped, ...duckNoLast } = DUCK;
  const shed: readonly [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["playout not an object", { playout: 5 }, {}],
    ["a playout counter spelled as a string", { playout: { ...PLAYOUT, underruns: "3" } }, {}],
    ["a playout counter missing", { playout: { ...PLAYOUT, chunks: undefined } }, {}],
    ["a NaN target", { playout: { ...PLAYOUT, targetMs: Number.NaN } }, {}],
    ["a null backlog minimum", { playout: { ...PLAYOUT, queuedMinMs: null } }, {}],
    ["a duck without its count", { duck: { ...DUCK, ducks: undefined } }, {}],
    ["a residual spelled as a string", { duck: { ...DUCK, residualP99Dbfs: "-49" } }, {}],
    ["a last duck without its source: the duck's counts stay", { duck: { ...DUCK, last: { ...LAST, source: undefined } } }, { duck: duckNoLast }],
    ["a last duck whose confirmed is a number: the duck's counts stay", { duck: { ...DUCK, last: { ...LAST, confirmed: 1 } } }, { duck: duckNoLast }],
    ["a last duck that is a number", { duck: { ...DUCK, last: 5 } }, { duck: duckNoLast }],
    ["an infinite output level", { output: { ...OUTPUT, rmsDbfs: Number.NEGATIVE_INFINITY } }, {}],
    ["a mix format that is a number", { output: { ...OUTPUT, mixFormat: 48000 } }, {}],
    ["output null", { output: null }, {}],
    ["all three at once, beside good devices", { playout: "x", duck: [1, 2, 3], output: 3 }, {}],
  ];
  for (const [why, telemetry, kept] of shed) {
    const frame: Record<string, unknown> = { ...FRAME, hears: { name: "Mic", uid: "m", rate: 48000, channels: 1, transport: "built-in" }, ...telemetry };
    assert.equal(isAudioState(frame), true, `${why}: the frame passes`);
    assert.deepEqual(frame, { ...FRAME, hears: { name: "Mic", uid: "m", rate: 48000, channels: 1, transport: "built-in" }, ...kept }, `${why}: only the bad object is gone`);
  }
  const badBase: Record<string, unknown> = { ...FRAME, gated: "13", playout: 5 };
  assert.equal(isAudioState(badBase), false, "a frame whose own counters are malformed is dropped whole");
  assert.equal(badBase["playout"], 5, "and nothing is deleted from a frame that did not pass");
  const frozen = Object.freeze({ ...FRAME, playout: 5 });
  assert.equal(isAudioState(frozen), false, "a frozen frame cannot shed its bad object, so it is dropped whole");
  assert.equal(isAudioState(Object.freeze({ ...FRAME, playout: PLAYOUT })), true, "a frozen well-formed frame passes untouched");
});

test("PLAN W1.5: Swift's AudioStateInfo carries playout, duck and output; each mirror declares exactly the protocol's fields", () => {
  const state = swiftVars("AudioStateInfo");
  assert.equal(state.get("playout"), "AudioPlayoutInfo?");
  assert.equal(state.get("duck"), "AudioDuckInfo?");
  assert.equal(state.get("output"), "AudioOutputInfo?");
  sameNames(swiftVars("AudioPlayoutInfo"), PLAYOUT, "AudioPlayoutInfo");
  sameNames(swiftVars("AudioDuckInfo"), DUCK, "AudioDuckInfo");
  sameNames(swiftVars("AudioDuckLastInfo"), LAST, "AudioDuckLastInfo");
  sameNames(swiftVars("AudioOutputInfo"), OUTPUT, "AudioOutputInfo");
});

test("PLAN W1.5: snapshot.liveAudio (the daemon's own) and the audio.playout row at session close; Swift's Snapshot and LedgerRow carry them; LiveAudioInfo declares exactly the protocol's fields", () => {
  const snap: Pick<Snapshot, "liveAudio"> = { liveAudio: LIVE };
  assert.equal(snap.liveAudio?.deltas, 640);
  const row: LedgerRow = { at: 1, type: "audio.playout", sessionId: "sess_a", playout: PLAYOUT, duck: DUCK, output: OUTPUT, liveAudio: LIVE };
  const bytes = Buffer.byteLength(JSON.stringify(row));
  console.log(`[measure] audio.playout row with every field: ${bytes} B`);
  assert.ok(bytes < 1024, `${bytes} B: one row per session`);
  assert.equal(swiftVars("Snapshot").get("liveAudio"), "LiveAudioInfo?");
  const ledger = swiftVars("LedgerRow");
  assert.equal(ledger.get("playout"), "AudioPlayoutInfo?");
  assert.equal(ledger.get("duck"), "AudioDuckInfo?");
  assert.equal(ledger.get("output"), "AudioOutputInfo?");
  assert.equal(ledger.get("liveAudio"), "LiveAudioInfo?");
  sameNames(swiftVars("LiveAudioInfo"), LIVE, "LiveAudioInfo");
});

test("PLAN W1.5: no telemetry field can carry what Kevin or Jarhead said: the only strings are the duck's source and reason and the mix format", () => {
  const strings = (o: object, at: string): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [`${at}${k}`] : typeof v === "object" && v !== null ? strings(v, `${at}${k}.`) : []));
  assert.deepEqual([...strings(PLAYOUT, "playout."), ...strings(DUCK, "duck."), ...strings(OUTPUT, "output."), ...strings(LIVE, "liveAudio.")].sort(), ["duck.last.reason", "duck.last.source", "output.mixFormat"]);
});

test("PLAN W1.5: the fixture's snapshot carries the frame with all three objects and liveAudio, and its ledger an audio.playout row, so protocol-probe.sh decodes them with the app's mirrors", () => {
  const withAudio = snapshots().find((s) => s.audioState?.playout !== undefined);
  assert.ok(withAudio?.audioState, "a snapshot with the app's frame");
  assert.ok(isAudioState(withAudio.audioState), "the fixture's frame passes the wire's own check");
  assert.ok(withAudio.audioState.duck && withAudio.audioState.output, "duck and output ride with it");
  assert.ok(withAudio.liveAudio, "and the daemon's liveAudio");
  sameNames(new Map(Object.keys(withAudio.liveAudio).map((k) => [k, ""])), LIVE, "the fixture's liveAudio");
  const row = ledgerRows().find((r): r is Extract<LedgerRow, { type: "audio.playout" }> => r.type === "audio.playout");
  assert.ok(row?.playout && row.duck && row.output && row.liveAudio, "an audio.playout row with all four");
});
