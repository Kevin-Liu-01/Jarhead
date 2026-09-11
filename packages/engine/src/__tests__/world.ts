import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession } from "@jarhead/live";
import type { Brain, BrainResult, BrainTask } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import type { EngineEvent, OverlayCommand } from "@jarhead/protocol";
import { Engine, type EngineOptions } from "../engine.ts";

/**
 * A stand-in world for engine tests: a fake Live session (records instructions,
 * mutes, emits what a real one would), hands that answer every op with a canned
 * result and record the ops (a held op can be released later), a brain that holds
 * its task until the abort signal or the test resolves it, and a clock the test
 * moves by hand.
 */

export class FakeLive extends EventEmitter {
  instructions: string[] = [];
  commentary: string[] = [];
  mutes: string[] = [];
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  nowMs = 1000;
  audioIn = 0;
  async start(): Promise<{ id: string; expires_at: number }> {
    this.currentState = "started";
    this.session = { id: "sess_1", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
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
  close(): void {
    this.currentState = "closed";
    this.emit("closed", "client_closed", 0);
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
  live: FakeLive;
  hands: RecordingHands;
  events: EngineEvent[];
  overlays: OverlayCommand[];
  audio: Buffer[];
  brain: BrainState;
  clock: { t: number };
  dir: string;
}

export function world(extra: Partial<EngineOptions> = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "jh-engine-"));
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
  const live = new FakeLive();
  const hands = new RecordingHands();
  const clock = { t: 1_757_500_000_000 };
  hands.now = () => clock.t;
  // Short ear windows (120 / 450 ms in production): 40 ms for the prefire kinds, 70 ms for the careful ones.
  const engine = new Engine({ config, connectors: [], brain, hands, makeLive: () => live as unknown as LiveSession, now: () => clock.t, earStableMs: 40, earCarefulMs: 70, ...extra });
  const events: EngineEvent[] = [];
  const overlays: OverlayCommand[] = [];
  const audio: Buffer[] = [];
  engine.on("event", (e) => events.push(e));
  engine.on("overlay", (c) => overlays.push(c));
  engine.on("audio", (pcm) => audio.push(pcm));
  return { engine, live, hands, events, overlays, audio, brain: brainState, clock, dir };
}

export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const frame = (): Buffer => Buffer.alloc(480, 7);

/** Live heard Kevin and delegated: one fragment, then the delegation for it. */
export function delegate(w: World, text: string, liveId: string): void {
  const s = w.live.nowMs;
  w.live.nowMs += 900;
  w.live.emit("inputTranscript", ` ${text}`, s, w.live.nowMs);
  w.live.emit("delegation", liveId, "client", w.live.nowMs);
}

/** Spaced well past the transcript's merge gap so the next words are a new utterance. */
export function nextUtterance(w: World): void {
  w.live.nowMs += 3000;
}
