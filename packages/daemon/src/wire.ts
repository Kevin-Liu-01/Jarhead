/**
 * The app ↔ daemon wire: one unix socket, binary frames.
 *
 *   [type: u8][length: u32 big-endian][payload: length bytes]
 *
 * type 1  JSON control message (UTF-8)
 * type 2  microphone PCM16 mono 24 kHz, app → daemon
 * type 3  speaker PCM16 mono 24 kHz, daemon → app
 *
 * Binary rather than NDJSON so 100 ms audio chunks are not base64'd and parsed
 * ten times a second on both sides. Sixteen megabytes caps any single frame; a
 * peer that sends more is broken, not ambitious.
 */

import type { ToolResult } from "@jarhead/hands";
import type { SystemSignal } from "@jarhead/protocol";

export const FRAME_JSON = 1;
export const FRAME_MIC = 2;
export const FRAME_SPEAKER = 3;

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER = 5;

export interface Frame {
  readonly type: number;
  readonly payload: Buffer;
}

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  if (body.length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${body.length} bytes`);
  const out = Buffer.allocUnsafe(HEADER + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, HEADER);
  return out;
}

export function encodeJson(message: unknown): Buffer {
  return encodeFrame(FRAME_JSON, JSON.stringify(message));
}

/** Incremental decoder. Throws on an oversized frame; the caller should drop the connection. */
export class FrameParser {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffered < HEADER) break;
      const buf = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks);
      this.chunks = [buf];
      const type = buf.readUInt8(0);
      const length = buf.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error(`frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES} byte cap`);
      if (buf.length < HEADER + length) break;
      frames.push({ type, payload: buf.subarray(HEADER, HEADER + length) });
      const rest = buf.subarray(HEADER + length);
      this.chunks = rest.length ? [Buffer.from(rest)] : [];
      this.buffered = rest.length;
    }
    return frames;
  }
}

// ----------------------------------------------------------------- messages

/** daemon → app */
export type DaemonMessage =
  | { readonly type: "hello"; readonly version: string; readonly pid: number; readonly stateDir: string }
  | { readonly type: "snapshot"; readonly snapshot: unknown }
  | { readonly type: "levels"; readonly levels: unknown }
  | { readonly type: "toast"; readonly text: string; readonly tone: "info" | "warn" | "error" }
  | { readonly type: "overlay"; readonly command: unknown }
  | { readonly type: "audio"; readonly control: "flush" }
  /** Rows of a day, a session or a whole chain; `truncated` when a chain read kept only its newest CHAIN_ROWS_MAX rows. */
  | { readonly type: "ledger.rows"; readonly id: string; readonly rows: unknown[]; readonly truncated?: boolean }
  | { readonly type: "ledger.days"; readonly id: string; readonly days: string[] }
  /** Memory items (MemoryItem[]) for `memory.list` / `memory.search`; never a vector. */
  | { readonly type: "memory.items"; readonly id: string; readonly items: unknown[] }
  /** Jarhead's own sessions (JarheadSessionSummary[]), newest first. */
  | { readonly type: "ledger.sessions"; readonly id: string; readonly sessions: unknown[] }
  /** Liveness: the daemon answers a client's ping at once; two missed pongs and the app respawns it. */
  | { readonly type: "pong"; readonly id: string; readonly at: number }
  /** Words the on-device ear should be biased toward right now: visible control titles, the front app and window, agent names. */
  | { readonly type: "ear.hints"; readonly strings: readonly string[] }
  /** Full-text hits over the ledger for the Console's search box. */
  | { readonly type: "ledger.hits"; readonly id: string; readonly hits: unknown[] }
  /** A page of an agent's conversation: sent to the clients viewing that agent (`agent.open`), never to the CLI's join/leave clients. */
  | { readonly type: "agent.transcript"; readonly transcript: unknown; readonly mode: "replace" | "append" | "prepend" }
  /** One change on one thread (a ThreadEvent; ≤ 200 B once the table caps its text, `started` excepted — it carries the record): broadcast, so the orb's satellites and the rail follow without a snapshot. */
  | { readonly type: "thread.event"; readonly event: unknown }
  /** A page of a thread's conversation (a ThreadTranscript): sent only to the clients that opened that thread (`thread.open`). */
  | { readonly type: "thread.transcript"; readonly transcript: unknown; readonly mode: "replace" | "append" | "prepend" }
  /** One change on one automation row (an AutomationEvent; ≤ 200 B, `fired` ≈ 270 B with its presses): broadcast, like `thread.event`. */
  | { readonly type: "automation.event"; readonly event: unknown }
  /** Engine → app: play an earcon and/or have the LocalSpeaker read a FIXED line on-device; never model text except a redacted wake-brain line. Broadcast. */
  | { readonly type: "local.say"; readonly text?: string; readonly sound?: string; readonly automationId: string }
  /** Engine → app: a banner with the ring's presses (Snooze · Done / Open · Done); a press comes back as an `automation.*` command. Broadcast. */
  | { readonly type: "notify"; readonly id: string; readonly title: string; readonly body?: string; readonly presses: readonly unknown[]; readonly automationId: string }
  /**
   * Answer to `tool.run`, sent only to the client that asked. `result` is the
   * ToolResult as the runner produced it (text / image {pngBase64, width, height,
   * note} / error / needs-confirmation); a name outside the tool table answers
   * with an error result rather than a protocol error, so the model reads it.
   */
  | { readonly type: "tool.result"; readonly id: string; readonly result: ToolResult }
  /**
   * The answer to a client's `bye`: the daemon has read it. The app waits for this before
   * closing the connection — a close while the daemon's hello/snapshot write is still
   * queued fails that write with EPIPE, Node destroys the socket, and a bye still unread
   * in the buffer is lost with it (seen against a real daemon; 64 agents make a big snapshot).
   */
  | { readonly type: "bye" }
  | { readonly type: "error"; readonly message: string };

/** app → daemon */
export type ClientMessage =
  | { readonly type: "hello"; readonly pid: number; readonly version?: string; readonly audio?: boolean }
  | { readonly type: "command"; readonly command: unknown }
  | { readonly type: "mic-level"; readonly level: number }
  /**
   * design12: the app's audio graph as it read itself back (the protocol's AudioState: voice
   * processing and its knobs, the winning rung, what it hears and speaks through, the echo
   * guard's counters, who else holds the mic). Sent on start, stop, a route change and every
   * 5 s with the counters, ≤ 1 Hz. The daemon checks the shape (`isAudioState`) and keeps it in
   * the snapshot for `status`, the doctor and the Console; a malformed frame is dropped. Data,
   * never a command: nothing here changes a setting or the graph.
   */
  | { readonly type: "audio-state"; readonly state: unknown }
  | { readonly type: "permission"; readonly which: string; readonly state: "granted" | "denied" | "unknown"; readonly detail?: string }
  /** The app's full read of every permission (PermissionInfo[]), after a sweep or a poll. */
  | { readonly type: "permissions"; readonly all: unknown[] }
  | { readonly type: "ledger.read"; readonly id: string; readonly date: string }
  | { readonly type: "ledger.days"; readonly id: string }
  /** List Jarhead's own sessions across the ledger. */
  | { readonly type: "ledger.sessions"; readonly id: string }
  /** The rows of one session (its started row through its closed row); answered with `ledger.rows`. */
  | { readonly type: "ledger.session"; readonly id: string; readonly sessionId: string }
  /** A whole conversation in one read: every session of the chain `rootId` names (any member id will do), oldest first; answered with `ledger.rows` (+ `truncated`). */
  | { readonly type: "ledger.chain"; readonly id: string; readonly rootId: string }
  | { readonly type: "ping"; readonly id: string }
  /** Search heard/said text and delegation requests across the live ledger (not the trash); `limit` default 50. */
  | { readonly type: "ledger.search"; readonly id: string; readonly query: string; readonly limit?: number }
  /** The Memory rail: items by state (default live; "all"), `limit` default 50, at most 200; answered with `memory.items`. */
  | { readonly type: "memory.list"; readonly id: string; readonly state?: string; readonly limit?: number }
  | { readonly type: "memory.search"; readonly id: string; readonly query: string; readonly limit?: number }
  /**
   * Run one of Jarhead's tools through the engine's ToolRunner (policy, ledger,
   * screenshot archive, confirmation handshake included). Used by the MCP bridge
   * that gives an external brain (Codex) the same tools the in-process brains
   * have. Only local unix-socket clients exist, so there is no further auth.
   *
   * `thread` is the `t_…` id the bridge was started with as JARHEAD_THREAD: the daemon
   * routes the call to that thread's lane runner — its lane's refusals, its budget, its
   * place in the confirmation queue — and refuses an unknown id rather than falling back
   * to the main runner, which holds the pointer. Absent = the main brain.
   */
  | { readonly type: "tool.run"; readonly id: string; readonly name: string; readonly input: unknown; readonly thread?: string }
  /**
   * The app's on-device ear while awake: a partial or final transcript of what
   * Kevin is saying, ~100–200 ms behind his speech. `at` is ms since epoch when the
   * recogniser produced it. The engine's reflex layer acts on unambiguous commands.
   */
  | { readonly type: "ear"; readonly text: string; readonly isFinal: boolean; readonly segment: number; readonly at: number }
  /**
   * A signal the app observed on Kevin's behalf (design11): an app launched or quit
   * (`NSWorkspace`), the Mac slept or woke, the screen locked or unlocked, a display
   * connected or disconnected, the clock changed. `signal` is the protocol's SystemSignal
   * (the parser types it; the engine still checks its shape — the wire is JSON); `at` is
   * wall-clock ms. Data for the automations' watchers and their resync — never a
   * command, never a wake: the engine reads it, matches armed rows, and nothing else.
   */
  | { readonly type: "system.signal"; readonly signal: SystemSignal; readonly at: number }
  /**
   * A clean quit is on its way: the app sends this right before it closes the daemon's
   * stdin (DaemonProcess.stop / applicationWillTerminate). Stdin closing *without* a
   * recent bye means the app crashed, and the daemon lingers for the relaunch instead
   * of shutting down (main.ts `Lifeline`). A bye to a daemon whose stdin is already gone
   * — an orphan the relaunched app attached to — is the quit itself.
   */
  | { readonly type: "bye" };

export function parseClientMessage(payload: Buffer): ClientMessage | undefined {
  try {
    const msg = JSON.parse(payload.toString("utf8")) as { type?: unknown };
    return typeof msg.type === "string" ? (msg as ClientMessage) : undefined;
  } catch {
    return undefined;
  }
}
