import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import type { Rect } from "@jarhead/protocol";
import { HANDS_BUSY_PREFIX, NativeRequestError, USER_IDLE_NONE_MS, type NativeHands, type TypeResult, type UserIdle } from "./native.ts";
import { KEVIN_QUIET_MS } from "./lease.ts";

/**
 * A stand-in for the Swift helper as a child process: every request line the
 * client writes is answered by `hands.request(op, params)` on the fake's stdout,
 * in the helper's JSON shape. Tests and `jarhead bench --fake-hands` plug this in
 * as `spawnImpl`, so the real client code — the pending map, timeouts, a stop's
 * cancelPending, the late-answer drop — runs unchanged over canned answers.
 */
export function fakeHandsSpawn(hands: NativeHands): typeof spawn {
  return ((): ChildProcess => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: NodeJS.Signals | null; pid: number; kill(): boolean };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 424242;
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let req: { id?: string; op?: string } & Record<string, unknown>;
        try {
          req = JSON.parse(line) as typeof req;
        } catch {
          continue;
        }
        const { id, op, ...params } = req;
        void hands
          .request(String(op), params)
          .then((result) => {
            if (child.exitCode === null) child.stdout.write(`${JSON.stringify({ id, ok: true, result: result ?? {} })}\n`);
          })
          .catch((e: Error & { detail?: { code?: string } }) => {
            if (child.exitCode === null) child.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: e.detail?.code ?? "internal", message: e.message } })}\n`);
          });
      }
    });
    child.kill = () => {
      child.exitCode = 0;
      setImmediate(() => child.emit("exit", 0, null));
      return true;
    };
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
}

/** The ops that post events or activate an app — the ones the helper judges Kevin's hands and the front app for. */
export const FAKE_ACTING_OPS: ReadonlySet<string> = new Set(["click", "mouse_down", "mouse_up", "drag", "scroll", "type", "key", "hold_key"]);

/**
 * The helper in process, with knobs, behaving as the Swift one does where the lease
 * and the lanes care: `user_idle` reads from `kevinActed(at)`; an acting op answers
 * `busy` while Kevin's last input is within KEVIN_QUIET_MS (unless `ownDriver`), and
 * `focus_moved` when `expectFront.pid` is not the front app's — in both cases nothing
 * is recorded in `posted`. `focus_app` / `open_app` bring the named app to the front.
 * Every request is in `calls` (with the clock's time); a `hold` keeps one op in flight
 * until `release()`, so a test can prove nobody takes the lease mid-op.
 */
export class FakeHands implements NativeHands {
  ready = true;
  calls: { op: string; params: Record<string, unknown>; at: number }[] = [];
  /** The acting ops that actually landed (nothing here for a `busy` or `focus_moved` refusal). */
  posted: { op: string; params: Record<string, unknown>; at: number }[] = [];
  now: () => number = Date.now;
  frontApp = "Notes";
  frontBundle: string | undefined = "com.apple.Notes";
  frontPid = 100;
  /** Every app the fake knows: `focus_app`/`open_app` by name resolve here (pid per app). Unknown names are added on open. */
  apps = new Map<string, number>([["Notes", 100], ["Slack", 200], ["Spotify", 300], ["Mail", 400], ["Safari", 500]]);
  config = "cfg-1";
  locked = false;
  elementTitle = "Search";
  elementRole = "AXButton";
  elementApp: string | undefined;
  elementFrame: Rect | undefined;
  focusedRole = "AXTextField";
  focusedTitle: string | undefined = "Subject";
  secure = false;
  typeResult: TypeResult = { characters: 5, events: 5, via: "ax", attempts: 1, verified: true };
  typeError: Error | undefined;
  /** The helper's busy check on acting ops (off to test a helper built before it). */
  busyCheck = true;
  /** When Kevin last pressed a key, clicked or scrolled (never Jarhead's own posts); undefined = never. */
  kevinAt: number | undefined;
  hold: string | undefined;
  private release_: (() => void) | undefined;

  /** Kevin used the keyboard or mouse (now, or at `at`). */
  kevinActed(at?: number): void {
    this.kevinAt = at ?? this.now();
  }

  /** What `user_idle` answers right now. */
  get userIdle(): UserIdle {
    const foreignMs = this.kevinAt === undefined ? USER_IDLE_NONE_MS : Math.max(0, this.now() - this.kevinAt);
    return { keyMs: foreignMs, clickMs: foreignMs, scrollMs: USER_IDLE_NONE_MS, moveMs: foreignMs, foreignMs };
  }

  /** The op named by `hold` is in flight until this is called. */
  release(): void {
    this.release_?.();
    this.release_ = undefined;
  }

  named(op: string): { op: string; params: Record<string, unknown>; at: number }[] {
    return this.calls.filter((c) => c.op === op);
  }

  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const at = this.now();
    this.calls.push({ op, params, at });
    if (this.hold === op && this.release_ === undefined) await new Promise<void>((r) => (this.release_ = r));
    if (FAKE_ACTING_OPS.has(op)) this.guardActing(op, params);
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "user_idle":
        return this.userIdle as T;
      case "frontmost":
        return { app: this.frontApp, ...(this.frontBundle ? { bundleId: this.frontBundle } : {}), pid: this.frontPid, window: null, locked: this.locked } as T;
      case "focus_app":
      case "open_app": {
        const name = String(params["name"] ?? params["app"] ?? "");
        const pid = this.apps.get(name) ?? this.apps.get(this.appNamed(name) ?? "");
        if (op === "focus_app" && pid === undefined) throw new NativeRequestError({ code: "not_found", message: `no running application named ${name}` });
        const resolved = this.appNamed(name) ?? name;
        const p = pid ?? 1000 + this.apps.size;
        if (pid === undefined) this.apps.set(resolved, p);
        if (op === "focus_app" || params["activate"] !== false) {
          this.frontApp = resolved;
          this.frontPid = p;
          this.frontBundle = undefined;
        }
        return { pid: p, app: resolved, activated: true } as T;
      }
      case "cursor":
        return { x: 100, y: 100 } as T;
      case "screenshot":
        return { displayId: 1, pngBase64: "AAAA", width: 1000, height: 500, points: { x: 0, y: 0, w: 2000, h: 1000 }, scale: 0.5, frameId: 7, config: this.config } as T;
      case "element_at":
        return { role: this.elementRole, title: this.elementTitle, ...(this.elementApp ? { app: this.elementApp } : { app: this.frontApp }), ...(this.elementFrame ? { frame: this.elementFrame } : {}), config: this.config, locked: this.locked } as T;
      case "focused_text":
        return { role: this.focusedRole, ...(this.focusedTitle ? { title: this.focusedTitle } : {}), secure: this.secure, app: this.frontApp, frame: { x: 10, y: 10, w: 200, h: 20 }, config: this.config, locked: this.locked } as T;
      case "type":
        if (this.typeError) throw this.typeError;
        this.posted.push({ op, params, at });
        return this.typeResult as T;
      case "windows":
        return { windows: [] } as T;
      default:
        if (FAKE_ACTING_OPS.has(op)) this.posted.push({ op, params, at });
        return {} as T;
    }
  }

  /**
   * As the helper does, before its first CGEvent.post: Kevin's hands, then the front
   * app. `mouse_up` skips the busy check as Input.swift does (a refused release would
   * leave a posted button held down) but not the front check.
   */
  private guardActing(op: string, params: Record<string, unknown>): void {
    if (op !== "mouse_up" && this.busyCheck && params["ownDriver"] !== true && this.kevinAt !== undefined) {
      const ms = this.now() - this.kevinAt;
      if (ms < KEVIN_QUIET_MS) throw new NativeRequestError({ code: "busy", message: `${HANDS_BUSY_PREFIX} ${Math.max(0, Math.round(ms))} ms ago; nothing was posted` });
    }
    const expect = params["expectFront"];
    if (typeof expect === "object" && expect !== null) {
      const pid = (expect as { pid?: unknown }).pid;
      if (typeof pid === "number" && pid !== this.frontPid) {
        throw new NativeRequestError({ code: "focus_moved", message: `the front app is ${this.frontApp} (pid ${this.frontPid}), not pid ${pid}; nothing was posted` });
      }
    }
  }

  private appNamed(name: string): string | undefined {
    const wanted = name.trim().toLowerCase();
    for (const app of this.apps.keys()) if (app.toLowerCase() === wanted) return app;
    return undefined;
  }
}
