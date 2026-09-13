import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession, SessionConfig } from "@jarhead/live";
import type { Brain, BrainResult, BrainSink, BrainTask, ToolRunner } from "@jarhead/brain";
import { FAKE_ACTING_OPS, HANDS_BUSY_PREFIX, KEVIN_QUIET_MS, NativeRequestError, USER_IDLE_NONE_MS, type NativeHands, type UserIdle } from "@jarhead/hands";
import type { EngineEvent, OverlayCommand } from "@jarhead/protocol";
import type { Exec } from "@jarhead/cli/install";
import { Engine, type EngineOptions } from "../engine.ts";
import type { WorkerBrainFactory } from "../workers.ts";

/**
 * A stand-in world for engine tests: a fake Live session per wake (records the
 * config it was opened with, instructions, mutes; emits what a real one would;
 * closes once, or hangs on close when told to), two sets of hands — the acting
 * helper and the reading one — that answer every op with a canned result and
 * record the ops (a held op can be released later; Kevin's own key or click makes
 * an acting op answer `busy`, as the helper does), a main brain that attaches the
 * runner and holds its task until the abort signal or the test resolves it, a
 * worker-brain factory whose brains a test scripts, and a clock the test moves by
 * hand.
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

/**
 * Hands with canned answers; `hold` names an op to keep in flight until `release()`.
 * Kevin's hands win here as in the helper: after `kevinActed()` every acting op within
 * KEVIN_QUIET_MS answers `busy` (nothing posted) unless the op says `ownDriver`;
 * `user_idle` reports the same clock. `focus_app` / `open_app` change `frontApp`.
 */
export class RecordingHands implements NativeHands {
  ready = true;
  ops: { op: string; params: Record<string, unknown>; at: number }[] = [];
  /** The acting ops that landed (a `busy` refusal is in `ops`, never here). */
  posted: { op: string; params: Record<string, unknown>; at: number }[] = [];
  hold: string | undefined;
  private release_: (() => void) | undefined;
  frontApp = "Notes";
  secure = false;
  /** What focused_text says the focus is (a text field by default; "AXGroup" for a terminal or a canvas). */
  focusedRole = "AXTextField";
  /** What find_element answers: the labels on the "front window". */
  labels: string[] = ["Save", "Cancel", "Send", "Add Folder"];
  now: () => number = Date.now;
  /** When Kevin last pressed a key, clicked or scrolled (never Jarhead's own posts); undefined = never. */
  kevinAt: number | undefined;
  /** The helper's busy check on acting ops (off to play a helper built before it). */
  busyCheck = true;

  /** Kevin used the keyboard or mouse (now, or at `at`). */
  kevinActed(at?: number): void {
    this.kevinAt = at ?? this.now();
  }

  /** What `user_idle` answers right now. */
  get userIdle(): UserIdle {
    const foreignMs = this.kevinAt === undefined ? USER_IDLE_NONE_MS : Math.max(0, this.now() - this.kevinAt);
    return { keyMs: foreignMs, clickMs: foreignMs, scrollMs: USER_IDLE_NONE_MS, moveMs: foreignMs, foreignMs };
  }

  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const at = this.now();
    this.ops.push({ op, params, at });
    if (this.hold === op && this.release_ === undefined) await new Promise<void>((r) => (this.release_ = r));
    if (FAKE_ACTING_OPS.has(op)) {
      // As the helper does, before its first CGEvent.post: Kevin's hands on the machine → nothing is posted.
      if (this.busyCheck && params["ownDriver"] !== true && this.kevinAt !== undefined) {
        const ms = this.now() - this.kevinAt;
        if (ms < KEVIN_QUIET_MS) throw new NativeRequestError({ code: "busy", message: `${HANDS_BUSY_PREFIX} ${Math.max(0, Math.round(ms))} ms ago; nothing was posted` });
      }
      this.posted.push({ op, params, at });
    }
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "user_idle":
        return this.userIdle as T;
      case "frontmost":
        return { app: this.frontApp, pid: 1, window: { title: "Untitled", x: 100, y: 100, w: 800, h: 600, windowId: 1 } } as T;
      case "focus_app":
      case "open_app": {
        const name = String(params["name"] ?? params["app"] ?? "");
        if (name && (op === "focus_app" || params["activate"] !== false)) this.frontApp = name;
        return { pid: 1, app: name || this.frontApp } as T;
      }
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

/** One worker's fake brain: what it was asked, what it was told, how often it was cancelled and stopped. */
export interface FakeWorkerBrain {
  readonly id: string;
  /** The worker's name, read from its first task (`<parentLiveId>/<name>`). */
  name: string;
  readonly runner: ToolRunner;
  tasks: BrainTask[];
  sink: BrainSink | undefined;
  started: number;
  cancels: number;
  stops: number;
  /** Settle the current turn (the runner is detached first, as a real brain does at the end of a turn). */
  resolve: ((r: BrainResult) => void) | undefined;
}

/** What a scripted worker turn sees. Return a result to finish the turn; return undefined to hold it for `brain.resolve`. */
export interface WorkerJob {
  readonly brain: FakeWorkerBrain;
  readonly task: BrainTask;
  readonly sink: BrainSink;
  /** The worker's own lane runner: `runner.run("type", …)` goes through its lane's rules. */
  readonly runner: ToolRunner;
}

export interface WorkerWorld {
  /** Every worker brain the engine built, in order (the spare included). */
  brains: FakeWorkerBrain[];
  /** What a worker does when its turn starts; absent, the turn holds until the test resolves it. */
  script: ((job: WorkerJob) => Promise<BrainResult | undefined>) | undefined;
  /** What a worker brain's `start()` answers (default: ready at once); a test makes the spare's boot hang or fail. Set before the wake that warms the spare. */
  startResult: ((brain: FakeWorkerBrain) => Promise<{ ready: boolean; detail: string }>) | undefined;
  /** The brain of the worker named `name` (the first task tells a brain its name). */
  byName(name: string): FakeWorkerBrain | undefined;
}

export interface World {
  engine: Engine;
  /** The first session's Live (the one a single-wake test talks to). */
  live: FakeLive;
  /** Every session the engine opened, in order; a resume or a re-wake appends one. `lives.at(-1)` is the current. */
  lives: FakeLive[];
  /** The acting helper: the main brain's, dictation's and screen-lane workers' ops. */
  hands: RecordingHands;
  /** The reading helper: the AX warm tick, ear hints, the wake shot, `user_idle`, background workers' ops. */
  handsBg: RecordingHands;
  events: EngineEvent[];
  overlays: OverlayCommand[];
  audio: Buffer[];
  brain: BrainState;
  workers: WorkerWorld;
  clock: { t: number };
  dir: string;
}

/**
 * `where.dir` reuses another world's state dir (its ledger, its settings) — a second engine
 * over the same day. `where.firstSessionId` names that engine's first FakeLive (default
 * `sess_1`), so two engines over one ledger do not write the same session id twice.
 * `where.oneHands` gives both helpers the same RecordingHands (a test that patches
 * `hands.request` and does not care which helper answered).
 */
/** No shell: the engine's own shell-outs (the Dock read) answer "not found" unless a test scripts `exec`, so no test ever reads Kevin's Dock. Every `new Engine` in a test passes it. */
export const noShell: Exec = () => ({ code: 127, stdout: "", stderr: "no shell in tests" });

export function world(extra: Partial<EngineOptions> = {}, where: { readonly dir?: string; readonly firstSessionId?: string; readonly noHands?: boolean; readonly oneHands?: boolean } = {}): World {
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
  let engine!: Engine;
  const brainState: BrainState = { cancels: 0, cancelDelayMs: 0, resolve: undefined, tasks: [] };
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: (task, sink) =>
      new Promise<BrainResult>((resolve) => {
        brainState.tasks.push(task);
        // As every real brain does: the runner carries this task for the turn (the daemon's `attached` check, the lease's turn end).
        engine.runner.attach(sink, task);
        const done = (r: BrainResult): void => {
          engine.runner.attach(undefined);
          resolve(r);
        };
        brainState.resolve = done;
        task.signal.addEventListener("abort", () => done({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      brainState.cancels++;
      if (brainState.cancelDelayMs > 0) await new Promise((r) => setTimeout(r, brainState.cancelDelayMs));
    },
    stop: async () => undefined,
  };
  // Worker brains: one fake per worker, scripted by the test.
  const workers: WorkerWorld = {
    brains: [],
    script: undefined,
    startResult: undefined,
    byName: (name) => workers.brains.find((b) => b.name === name),
  };
  const makeWorkerBrain: WorkerBrainFactory = (spec) => {
    const fb: FakeWorkerBrain = { id: spec.workerId, name: "", runner: spec.runner, tasks: [], sink: undefined, started: 0, cancels: 0, stops: 0, resolve: undefined };
    workers.brains.push(fb);
    return {
      kind: "fake-worker",
      start: async () => {
        fb.started++;
        return workers.startResult ? workers.startResult(fb) : { ready: true, detail: "fake worker" };
      },
      handle: (task, sink) =>
        new Promise<BrainResult>((resolve) => {
          fb.name = task.delegationId.split("/").pop() ?? fb.name;
          fb.tasks.push(task);
          fb.sink = sink;
          fb.runner.attach(sink, task);
          let settled = false;
          const done = (r: BrainResult): void => {
            if (settled) return;
            settled = true;
            fb.runner.attach(undefined);
            fb.resolve = undefined;
            resolve(r);
          };
          fb.resolve = done;
          task.signal.addEventListener("abort", () => done({ status: "cancelled" }), { once: true });
          const script = workers.script;
          if (script) {
            void script({ brain: fb, task, sink, runner: fb.runner })
              .then((r) => {
                if (r) done(r);
              })
              .catch((e: unknown) => done({ status: "failed", error: (e as Error).message }));
          }
        }),
      cancel: async () => {
        fb.cancels++;
      },
      stop: async () => {
        fb.stops++;
      },
    };
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
  const handsBg = where.oneHands ? hands : new RecordingHands();
  const clock = { t: 1_757_500_000_000 };
  hands.now = () => clock.t;
  handsBg.now = () => clock.t;
  // Short ear windows (120 / 450 ms in production): 40 ms for the prefire kinds, 70 ms for the careful ones.
  // `where.noHands`: no stand-in helper — the binary at config.handsBin does not exist, so the engine sees a helper that is not built.
  engine = new Engine({ config, connectors: [], brain, ...(where.noHands ? {} : { hands, backgroundHands: handsBg }), makeLive, now: () => clock.t, earStableMs: 40, earCarefulMs: 70, makeWorkerBrain, exec: noShell, ...extra });
  const events: EngineEvent[] = [];
  const overlays: OverlayCommand[] = [];
  const audio: Buffer[] = [];
  engine.on("event", (e) => events.push(e));
  engine.on("overlay", (c) => overlays.push(c));
  engine.on("audio", (pcm) => audio.push(pcm));
  return { engine, live, lives, hands, handsBg, events, overlays, audio, brain: brainState, workers, clock, dir };
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

/** Wait until `cond` holds (polled every 10 ms) or `ms` pass; returns whether it held. */
export async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await settle(10);
  }
  return cond();
}
