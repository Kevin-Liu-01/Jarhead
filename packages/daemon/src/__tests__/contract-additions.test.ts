// W2-5 on the socket: the two hellos carry PROTOCOL_VERSION (APP-3) and the ledger.days reply carries the
// day totals (LM-6). Both are optional, so a peer from before them still parses. The frames go through the
// wire's own encoder and parser, the way the server and the app read them. On a live DaemonServer: an
// audio-state frame with malformed playback telemetry loses only that object (voice PLAN W1.5), and the hello
// carries PROTOCOL_VERSION once server.ts sends it (a todo until W3-3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type AudioState, type LedgerDayTotals } from "@jarhead/protocol";
import { FRAME_JSON, FrameParser, encodeJson, parseClientMessage, type ClientMessage, type DaemonMessage } from "../wire.ts";
import { DaemonServer, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";

const roundTrip = (message: DaemonMessage | ClientMessage): Record<string, unknown> => {
  const frames = new FrameParser().push(encodeJson(message));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.type, FRAME_JSON);
  return JSON.parse((frames[0]?.payload ?? Buffer.alloc(0)).toString("utf8")) as Record<string, unknown>;
};

test("APP-3: the daemon's hello and the app's hello each carry PROTOCOL_VERSION; a hello without it (a peer from before the field) still parses", () => {
  const daemon: DaemonMessage = { type: "hello", version: "2.0.0", pid: 41, stateDir: "/tmp/jh", protocol: PROTOCOL_VERSION };
  assert.equal(roundTrip(daemon)["protocol"], PROTOCOL_VERSION);
  const app: ClientMessage = { type: "hello", pid: 42, version: "2.0.0", audio: true, protocol: PROTOCOL_VERSION };
  const parsed = parseClientMessage(encodeJson(app).subarray(5));
  assert.ok(parsed?.type === "hello");
  assert.equal(parsed.protocol, PROTOCOL_VERSION);
  const before = parseClientMessage(Buffer.from(JSON.stringify({ type: "hello", pid: 42, version: "2.0.0", audio: true })));
  assert.ok(before?.type === "hello");
  assert.equal(before.protocol, undefined, "absent: the app predates the field, which a surface reads as a skew");
});

test("LM-6: the ledger.days reply keeps its day list and carries each day's totals beside it", () => {
  const totals: LedgerDayTotals[] = [
    { day: "2026-10-05", sessions: 4, billedSeconds: 603 },
    { day: "2026-10-04", sessions: 0, billedSeconds: 0 },
  ];
  const reply: DaemonMessage = { type: "ledger.days", id: "q1", days: ["2026-10-05", "2026-10-04"], totals };
  const back = roundTrip(reply);
  assert.deepEqual(back["days"], ["2026-10-05", "2026-10-04"], "an app that reads only the list still gets it");
  assert.deepEqual(back["totals"], totals);
  const bare: DaemonMessage = { type: "ledger.days", id: "q2", days: [] };
  assert.equal(roundTrip(bare)["totals"], undefined, "a daemon from before the totals sends the list alone");
});

/** The least engine a live server needs: inert, except that it keeps every audio-state frame the wire let through. */
function audioEngine(audioStates: (AudioState | undefined)[]): EngineLike {
  const none = (): unknown[] => [];
  return {
    on: () => undefined,
    snapshot: () => ({ phase: "asleep" }),
    command: async () => undefined,
    feedMic: () => undefined,
    reportInputLevel: () => undefined,
    reportAudioState: (state) => void audioStates.push(state),
    setPermission: () => undefined,
    setPermissions: () => undefined,
    registerOwnPid: () => undefined,
    ear: () => undefined,
    problem: () => undefined,
    ledger: { read: none, days: () => [], sessions: none, readSession: none, search: none, readChain: () => ({ rows: [], truncated: false }) },
    memory: { list: none, search: async () => [] },
    dropViewers: () => undefined,
    config: { stateDir: "" },
    runner: { run: async () => ({ result: { kind: "text", text: "" } }) },
    runnerFor: () => undefined,
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

test("PLAN W1.5 on the socket: an audio-state frame whose playout, duck or output is malformed reaches the engine without that object; a frame whose own counters are malformed is still dropped", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "jh-w25-audio-")), "d.sock");
  const audioStates: (AudioState | undefined)[] = [];
  const server = new DaemonServer(audioEngine(audioStates), path);
  await server.listen();
  const app = new DaemonClient(path);
  try {
    await app.connect({ pid: 1, audio: true });
    const frame: AudioState = {
      running: true, voiceProcessing: true, rung: 2, wiring: "input-rate", tapFormat: "24000 Hz ×9 Float32", recording: false, fallback: false,
      guardOn: true, guardTailMs: 400, gated: 12, chunks: 340, breakthroughs: 1, inputMuted: false, aggregatePresent: true,
      hears: { name: "MacBook Pro Microphone", uid: "BuiltInMicrophoneDevice", rate: 48000, channels: 1, transport: "built-in" },
    };
    const output = { rmsDbfs: -21.8, mixFormat: "48000 Hz ×2" };
    app.sendJson({ type: "audio-state", state: { ...frame, playout: { chunks: 1, queuedMinMs: null }, duck: "x", output } });
    app.sendJson({ type: "audio-state", state: { ...frame, gated: "13", output } });
    await settle();
    assert.deepEqual(audioStates, [{ ...frame, output }], "the devices and the guard counters landed; only the bad playout and duck were shed; the bad-counter frame never landed");
  } finally {
    app.close();
    await settle();
    await server.close();
  }
});

test("APP-3 on the socket: a live DaemonServer's hello carries PROTOCOL_VERSION", { todo: "W3-3 sends it from server.ts, then drops this todo and makes `protocol` required on the DaemonMessage hello" }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), "jh-w25-hello-")), "d.sock");
  const server = new DaemonServer(audioEngine([]), path);
  await server.listen();
  const client = new DaemonClient(path);
  const hello = new Promise<DaemonMessage>((resolve) => client.once("message", resolve));
  try {
    await client.connect({ pid: 1, audio: true });
    const first = await hello;
    assert.equal(first.type, "hello", "the hello is the first frame");
    assert.equal(first.type === "hello" ? first.protocol : undefined, PROTOCOL_VERSION);
  } finally {
    client.close();
    await settle();
    await server.close();
  }
});
