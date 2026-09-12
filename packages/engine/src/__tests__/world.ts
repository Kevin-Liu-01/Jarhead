import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession, SessionConfig } from "@jarhead/live";
import type { Brain, BrainResult, BrainTask } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import type { EngineEvent, OverlayCommand } from "@jarhead/protocol";
import { Engine, type EngineOptions } from "../engine.ts";

/**
 * A stand-in world for engine tests: a fake Live session per wake (records the
 * config it was opened with, instructions, mutes; emits what a real one would;
 * closes once, or hangs on close when told to), hands that answer every op with a
 * canned result and record the ops (a held op can be released later), a brain that
 * holds its task until the abort signal or the test resolves it, and a clock the
 * test moves by hand.
 */

export class FakeLive extends EventEmitter {
  instructions: string[] = [];
  commentary: string[] = [];
  mutes: string[] = [];
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  /** The config the engine opened this session with (instructions, voice, delegation). */
  config: SessionConfig | undefined;
  nowMs = 1000;
  audioIn = 0;
  /** What the server has billed so far (a `usage` emit updates it; the closed event carries it). */
  usage = 0;
  closes = 0;
  terminates = 0;
  closedEmitted = false;
  /** The server never answers `session.close`: close() leaves the session closing. The engine's deadline / watchdog must end it. */
  hangOnClose = false;
  /** The server refuses the socket: start() reports `closed("connection_lost")` and rejects, as the real session does when the socket closes before `session.started`. */
  failStart = false;
  constructor(readonly id = "sess_1") {
    super();
  }
  async start(): Promise<{ id: string; expires_at: number }> {
    if (this.failStart) {
      // Same order as LiveSession's onclose: state closed, `closed` emitted, then the start rejects.
      this.finish("connection_lost");
      throw new Error("live socket closed before start (code 1000)");
    }
    this.currentState = "started";
    this.session = { id: this.id, expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
  }
  get billedSeconds(): number {
    return this.usage;
  }
  /** `session.usage.updated`: the meter moved. */
  reportUsage(seconds: number): void {
    this.usage = seconds;
    this.emit("usage", seconds, undefined);
  }
  appendInstructions(_id: string | null, content: string): string {
    this.instructions.push(content);
    return "i";
  }
  appendThinking(): string {
    return "t";
  }
  appendCommentary(_id: string | null, content: string): string {
    this.commentary.push(content);
    return "c";
  }
  appendAudio(): void {
    this.audioIn++;
  }
  mute(): string {
    this.mutes.push("mute");
    return "m";
  }
  unmute(): string {
    this.mutes.push("unmute");
    return "u";
  }
  createResponseItem(): void {}
  createResponse(): void {}
  /** A graceful close: the server answers at once (unless `hangOnClose`). */
  close(): void {
    this.closes++;
    if (this.currentState === "closed") return;
    if (this.hangOnClose) {
      this.currentState = "closing";
      return;
    }
    this.finish("client_closed");
  }
  /** The socket dropped now; `closed` fires once whatever came before. */
  terminate(): void {
    this.terminates++;
    this.finish("client_closed");
  }
  /** The server ended the session (expired, connection_lost, …) with a final usage figure. */
  serverClosed(reason: string, usage = this.usage): void {
    this.usage = usage;
    this.finish(reason);
  }
  private finish(reason: string): void {
    this.currentState = "closed";
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit("closed", reason, this.usage);
  }
}

/** Hands with canned answers; `hold` names an op to keep in flight until `release()`. */
export class RecordingHands implements NativeHands {
  ready = true;
  ops: { op: string; params: Record<string, unknown>; at: number }[] = [];
  hold: string | undefined;
  private release_: (() => void) | undefined;
  frontApp = "Notes";
  secure = false;
  /** What focused_text says the focus is (a text field by default; "AXGroup" for a terminal or a canvas). */
  focusedRole = "AXTextField";
  /** What find_element answers: the labels on the "front window". */
  labels: string[] = ["Save", "Cancel", "Send", "Add Folder"];
  now: () => number = Date.now;
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.ops.push({ op, params, at: this.now() });
    if (this.hold === op && this.release_ === undefined) await new Promise<void>((r) => (this.release_ = r));
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "frontmost":
        return { app: this.frontApp, pid: 1, window: { title: "Untitled", x: 100, y: 100, w: 800, h: 600, windowId: 1 } } as T;
      case "cursor":
        return { x: 400, y: 300 } as T;
      case "element_at": {
        // A small element around the point asked (the Save button's label at the cursor, or inside the control click_element found).
        const x = Number(params["x"] ?? 400);
        const y = Number(params["y"] ?? 300);
        return { role: "AXButton", title: "Save", frame: { x: x - 20, y: y - 10, w: 40, h: 20 }, app: this.frontApp } as T;
      }
      case "focused_text":
        return { role: this.focusedRole, secure: this.secure, app: this.frontApp, frame: { x: 200, y: 200, w: 300, h: 24 } } as T;
      case "screenshot":
        return { displayId: 1, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", width: 1280, height: 828, points: { x: 0, y: 0, w: 1728, h: 1117 }, scale: 1280 / 1728 } as T;
      case "ax_tree":
        return { app: this.frontApp, pid: 1, window: "Untitled", count: this.labels.length, cached: true, ageMs: 1, treeMs: 3, truncated: false } as T;
      case "find_element": {
        const name = String(params["name"] ?? "").toLowerCase();
        const hits = this.labels.filter((l) => l.toLowerCase() === name);
        const el = hits[0] ? { i: 1, depth: 2, role: "AXButton", title: hits[0], app: this.frontApp, score: 1, label: hits[0], x: 500, y: 400, w: 60, h: 24, center: { x: 530, y: 412 }, pressable: true } : undefined;
        return { app: this.frontApp, window: "Untitled", found: hits.length > 0, unique: hits.length === 1, candidates: hits.length, tier: hits.length ? "exact" : "none", ...(el ? { element: el } : {}), cached: true, treeMs: 3, nodes: 10, truncated: false, ms: 1 } as T;
      }
      case "windows":
        return { windows: [] } as T;
      default:
        return {} as T;
    }
  }
  release(): void {
    this.release_?.();
    this.release_ = undefined;
  }
  named(op: string): { op: string; params: Record<string, unknown>; at: number }[] {
    return this.ops.filter((o) => o.op === op);
  }
}

export interface BrainState {
  cancels: number;
  /** ms the brain's cancel takes to settle. */
  cancelDelayMs: number;
  resolve: ((r: BrainResult) => void) | undefined;
  tasks: BrainTask[];
}

export interface World {
  engine: Engine;
  /** The first session's Live (the one a single-wake test talks to). */
  live: FakeLive;
  /** Every session the engine opened, in order; a resume or a re-wake appends one. `lives.at(-1)` is the current. */
  lives: FakeLive[];
  hands: RecordingHands;
  events: EngineEvent[];
  overlays: OverlayCommand[];
  audio: Buffer[];
  brain: BrainState;
  clock: { t: number };
  dir: string;
}

/**
 * `where.dir` reuses another world's state dir (its ledger, its settings) — a second engine
 * over the same day. `where.firstSessionId` names that engine's first FakeLive (default
 * `sess_1`), so two engines over one ledger do not write the same session id twice.
 */
export function world(extra: Partial<EngineOptions> = {}, where: { readonly dir?: string; readonly firstSessionId?: string; readonly noHands?: boolean } = {}): World {
  const dir = where.dir ?? mkdtempSync(join(tmpdir(), "jh-engine-"));
  const config: JarheadConfig = {
    ...readConfig(),
    openaiApiKey: "sk-test-not-used",
    brain: "auto",
    brainModel: "",
    brainBaseUrl: undefined,
    anthropicApiKey: undefined,
    claudeBin: undefined,
    codexBin: undefined,
    handsBin: join(dir, "no-hands"),
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  const brainState: BrainState = { cancels: 0, cancelDelayMs: 0, resolve: undefined, tasks: [] };
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        brainState.tasks.push(task);
        brainState.resolve = resolve;
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      brainState.cancels++;
      if (brainState.cancelDelayMs > 0) await new Promise((r) => setTimeout(r, brainState.cancelDelayMs));
    },
    stop: async () => undefined,
  };
  // One FakeLive per session: the first exists before the wake (tests hold it as `live`);
  // every wake after that — a resume, a re-wake — gets a fresh one, as the engine does.
  const first = where.firstSessionId ?? "sess_1";
  const live = new FakeLive(first);
  const lives: FakeLive[] = [live];
  let opened = 0;
  const makeLive = (config: SessionConfig): LiveSession => {
    const l = lives[opened] ?? new FakeLive(where.firstSessionId ? `${first}_${opened + 1}` : `sess_${opened + 1}`);
    if (!lives.includes(l)) lives.push(l);
    opened++;
    l.config = config;
    return l as unknown as LiveSession;
  };
  const hands = new RecordingHands();
  const clock = { t: 1_757_500_000_000 };
  hands.now = () => clock.t;
  // Short ear windows (120 / 450 ms in production): 40 ms for the prefire kinds, 70 ms for the careful ones.
  // `where.noHands`: no stand-in helper — the binary at config.handsBin does not exist, so the engine sees a helper that is not built.
  const engine = new Engine({ config, connectors: [], brain, ...(where.noHands ? {} : { hands }), makeLive, now: () => clock.t, earStableMs: 40, earCarefulMs: 70, ...extra });
  const events: EngineEvent[] = [];
  const overlays: OverlayCommand[] = [];
  const audio: Buffer[] = [];
  engine.on("event", (e) => events.push(e));
  engine.on("overlay", (c) => overlays.push(c));
  engine.on("audio", (pcm) => audio.push(pcm));
  return { engine, live, lives, hands, events, overlays, audio, brain: brainState, clock, dir };
}

export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const frame = (): Buffer => Buffer.alloc(480, 7);

/** The session the engine is talking to now (the latest opened). */
export function current(w: World): FakeLive {
  return w.lives[w.lives.length - 1] ?? w.live;
}

/** Live heard Kevin and delegated: one fragment, then the delegation for it — on the current session. */
export function delegate(w: World, text: string, liveId: string): void {
  const live = current(w);
  const s = live.nowMs;
  live.nowMs += 900;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  live.emit("delegation", liveId, "client", live.nowMs);
}

/** Spaced well past the transcript's merge gap so the next words are a new utterance. */
export function nextUtterance(w: World): void {
  current(w).nowMs += 3000;
}

/** Ledger rows of one type for the world's day, in order. */
export function rows<T extends { type: string }>(w: World, type: string): T[] {
  return (w.engine.ledger.read(w.clock.t) as unknown as T[]).filter((r) => r.type === type);
}
