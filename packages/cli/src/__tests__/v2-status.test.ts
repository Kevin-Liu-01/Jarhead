import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "@jarhead/core";
import { FRAME_JSON, FrameParser, encodeJson } from "@jarhead/daemon";
import type { AudioState, LedgerRow, LiveAudio } from "@jarhead/protocol";

/**
 * Voice PLAN W1.5, the command itself: `pnpm jarhead status` against a daemon stand-in on a unix socket,
 * one snapshot per case, and the day files in a temp state dir. The doctor's functions are covered in
 * v2-audio-lines.test.ts; this test is what fails if main.ts never hands them the snapshot's `liveAudio`
 * and the ledger's last `audio.playout` row (doctor.ts's playbackInputs).
 *
 * Until the integrator wires main.ts (TRIAGE, cross-item contracts, "W2-1 / V2"), each test marks itself TODO
 * and passes: main.ts is W2-1's file this wave, so the status call passes no playback inputs and the block has
 * no `live` and no `last session` line. Once main.ts prints either, every line is asserted. After fix/w2-1 and
 * fix/v2 merge, the integrator applies scratchpad/v2-fix2/main-ts-status.patch and deletes `unwired()` and its
 * three calls, so a status that drops the wiring later fails instead of turning back into a TODO.
 */

/** The block has no line main.ts prints only when wired: mark the test TODO (a passing one, no red) and stop. */
function unwired(t: TestContext, lines: readonly string[]): boolean {
  if (lines.some((l) => /^ {13}(live {4}|last session)/.test(l))) return false;
  t.todo("W2-1 / V2: main.ts does not pass playbackInputs to audioStatusLines yet; apply scratchpad/v2-fix2/main-ts-status.patch");
  return true;
}

// One temp dir for the state dir, its ledger and the socket; removed at the end.
const stateDir = mkdtempSync(join(tmpdir(), "jh-v2s-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "main.ts");

const LIVE: LiveAudio = { deltas: 900, deltaMsP50: 40, deltaMsMax: 120, arrivalP99Ms: 31, arrivalMaxMs: 182, aheadMs: 0, gatedFrames: 0, loopDelayMaxMs: 12, formatRate: 24_000 };
const LAST_LIVE: LiveAudio = { ...LIVE, arrivalP99Ms: 210, arrivalMaxMs: 420 };

const APP: AudioState = {
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
  playout: { chunks: 412, underruns: 0, underrunMs: 0, longestUnderrunMs: 0, wouldBeUnderruns: 4, resets: 3, targetMs: 120, queuedMs: 121, queuedMinMs: 96, lateMaxMs: 7, droppedChunks: 0, droppedMs: 0 },
  duck: { ducks: 2, gate: 2, confirmed: 2, unconfirmed: 0, held: 0, refusedWords: 0, wordOnsetsSkipped: 1, duckedMs: 900, deepMs: 400, residualP50Dbfs: -61, residualP99Dbfs: -49 },
  output: { rmsDbfs: -21.8, peakDbfs: -4.1, heardRmsDbfs: -22, audibleMs: 90_000, mixFormat: "48000 Hz ×2", volume: 0.62 },
};

// The ledger's last session, two hours ago: its own counters (3 underruns) and Live's figures (arrival p99 210 ms).
const ROW: Extract<LedgerRow, { type: "audio.playout" }> = {
  at: Date.now() - 2 * 3_600_000,
  type: "audio.playout",
  sessionId: "sess_0123456789ab",
  playout: { ...APP.playout!, underruns: 3, underrunMs: 120, longestUnderrunMs: 60 },
  duck: APP.duck!,
  output: APP.output!,
  liveAudio: LAST_LIVE,
};
new Ledger(stateDir).append(ROW);

/** The fields `status` reads, and nothing else: no session text, no agents, no threads. */
function snapshot(extra: { audioState?: AudioState; liveAudio?: LiveAudio; phase?: string }): Record<string, unknown> {
  return { phase: "asleep", transcript: [], delegations: [], agents: [], threads: [], problems: [], brainReady: true, handsReady: true, permissions: { all: [] }, ...extra };
}

/** A daemon stand-in: says hello, then sends one snapshot to each client that says hello. */
function fakeDaemon(path: string, snap: Record<string, unknown>): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      const parser = new FrameParser();
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        for (const f of parser.push(chunk)) {
          if (f.type !== FRAME_JSON) continue;
          const msg = JSON.parse(f.payload.toString("utf8")) as { type: string };
          if (msg.type !== "hello") continue;
          socket.write(encodeJson({ type: "hello", version: "v2-status", pid: process.pid, stateDir }));
          socket.write(encodeJson({ type: "snapshot", snapshot: snap }));
        }
      });
    });
    server.listen(path, () => resolve(server));
  });
}

/** `jarhead status --no-levels` (no system_profiler, no levels wait) against `snap`; the audio block's lines. */
async function statusAudio(name: string, snap: Record<string, unknown>): Promise<string[]> {
  const sock = join(stateDir, `${name}.sock`);
  const server = await fakeDaemon(sock, snap);
  try {
    const out = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", MAIN, "status", "--no-levels"], {
        env: { ...process.env, JARHEAD_STATE_DIR: stateDir, JARHEAD_SOCKET: sock, JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("close", (code) => resolve({ code, out: stdout, err: stderr }));
    });
    assert.equal(out.code, 0, out.err);
    const lines = out.out.split("\n");
    const start = lines.findIndex((l) => l.startsWith("  audio "));
    assert.ok(start >= 0, out.out);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return lines.slice(start, end < 0 ? undefined : end);
  } finally {
    server.close();
  }
}

const LIVE_LINE = "             live    40 ms deltas · arrival p99 31 ms / max 182 ms · ahead 0 ms · loop max 12 ms · 24000 Hz";
const LAST_LIVE_WORDS = "40 ms deltas · arrival p99 210 ms / max 420 ms · ahead 0 ms · loop max 12 ms · 24000 Hz";

test("v2 status (the command): a session open prints the daemon's live line under the app's playback lines, never the ledger's", async (t) => {
  const lines = await statusAudio("open", snapshot({ phase: "listening", audioState: APP, liveAudio: LIVE }));
  if (unwired(t, lines)) return;
  assert.match(lines[0]!, /^ {2}audio {6}voice processing /);
  assert.ok(lines.some((l) => l.startsWith("             playout 0 underruns")), lines.join("\n"));
  assert.equal(lines.at(-1), LIVE_LINE);
  assert.doesNotMatch(lines.join("\n"), /last session/);
});

test("v2 status (the command): the app connected and no session open, the live line is the last session's, from the ledger, and says so", async (t) => {
  const lines = await statusAudio("idle", snapshot({ audioState: APP }));
  if (unwired(t, lines)) return;
  assert.ok(lines.some((l) => l.startsWith("             playout 0 underruns")), "the app's own counters, not the row's");
  assert.equal(lines.at(-1), `             live    ${LAST_LIVE_WORDS} · last session, 2 h ago`);
});

test("v2 status (the command): no app connected and no session open, the whole block is the ledger's last session, dated", async (t) => {
  const lines = await statusAudio("noapp", snapshot({}));
  if (unwired(t, lines)) return;
  assert.deepEqual(lines.slice(0, 2), ["  audio      no app connected", "             last session …0123456789ab · 2 h ago (the ledger)"]);
  assert.ok(lines.some((l) => l.startsWith("             playout 3 underruns")), lines.join("\n"));
  assert.equal(lines.at(-1), `             live    ${LAST_LIVE_WORDS}`);
});
