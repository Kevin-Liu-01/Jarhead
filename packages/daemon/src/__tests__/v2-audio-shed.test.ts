// W2-5 / V2 (voice PLAN W1.5): isAudioState sheds a malformed playout, duck (or only its `last`) or output and
// passes the rest of the frame. server.ts passes it the shed list and says what was shed in one debug line a
// minute at most, so a malformed object never vanishes without a trace, and a frame at 1 Hz never floods the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLogSink, setLogLevel } from "@jarhead/core";
import type { AudioState } from "@jarhead/protocol";
import { DaemonServer, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";

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

test("v2: a frame that sheds a malformed telemetry object passes and says what it shed, one debug line a minute at most; a whole frame sheds nothing", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "jh-v2-shed-")), "d.sock");
  const audioStates: (AudioState | undefined)[] = [];
  const lines: string[] = [];
  setLogLevel("debug");
  const off = addLogSink((level, scope, message) => {
    if (level === "debug" && scope === "daemon" && message.startsWith("audio-state")) lines.push(message);
  });
  const server = new DaemonServer(audioEngine(audioStates), path);
  await server.listen();
  const app = new DaemonClient(path);
  try {
    await app.connect({ pid: 1, audio: true });
    const frame: AudioState = {
      running: true, voiceProcessing: true, rung: 2, wiring: "input-rate", tapFormat: "48000 Hz ×1 Float32", recording: false, fallback: false,
      guardOn: false, guardTailMs: 0, gated: 0, chunks: 0, breakthroughs: 0, inputMuted: false, aggregatePresent: true,
    };
    const output = { rmsDbfs: -21.8, mixFormat: "48000 Hz ×2" };
    // A whole frame: nothing shed, nothing said.
    app.sendJson({ type: "audio-state", state: { ...frame, output } });
    await settle();
    assert.deepEqual(lines, []);
    // The app sends the same malformed duck with every frame: three frames, one line.
    for (let i = 0; i < 3; i++) app.sendJson({ type: "audio-state", state: { ...frame, chunks: i + 1, duck: "x", output } });
    await settle();
    assert.equal(audioStates.length, 4, "every frame passed");
    assert.ok(audioStates.every((s) => s && !("duck" in s) && s.output?.rmsDbfs === -21.8), "the duck was shed, the output kept");
    assert.deepEqual(lines, ["audio-state: shed duck (malformed) · 1 frame shed since the last line"], "one line, not one per frame");
    // A frame whose own counters are malformed is still dropped whole, with its own line.
    app.sendJson({ type: "audio-state", state: { ...frame, gated: "13" } });
    await settle();
    assert.equal(audioStates.length, 4);
    assert.deepEqual(lines.slice(1), ["audio-state frame dropped: malformed"]);
  } finally {
    off();
    setLogLevel("info");
    app.close();
    await settle();
    await server.close();
  }
});
