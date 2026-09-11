import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { LineSplitter, logger } from "@jarhead/core";
import type { Rect } from "@jarhead/protocol";

/**
 * Client for the resident Swift helper (packages/hands/native).
 *
 * One process for the whole run, one JSON line per request. The helper is what
 * makes an action cost single-digit milliseconds instead of an osascript
 * startup; when it dies (it should not, but TCC revocations and sleep/wake have
 * surprised us before) the next request respawns it and the failure is reported
 * as a result, not a crash.
 */

const log = logger("hands.native");

export interface NativeError {
  readonly code: "bad_request" | "permission_denied" | "capture_failed" | "not_found" | "internal" | "unavailable" | "timeout";
  readonly message: string;
}

export class NativeRequestError extends Error {
  constructor(readonly detail: NativeError) {
    super(`${detail.code}: ${detail.message}`);
    this.name = "NativeRequestError";
  }
}

export interface Permissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export interface DisplayInfo {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly scale: number;
  readonly main: boolean;
}

export interface ScreenshotResult {
  readonly displayId: number;
  readonly pngBase64: string;
  readonly width: number;
  readonly height: number;
  /** Global points covered by the image. */
  readonly points: Rect;
  /** Image pixels per point. */
  readonly scale: number;
}

export interface FrontmostInfo {
  readonly app: string;
  readonly bundleId?: string;
  readonly pid: number;
  readonly window: { readonly title: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly windowId: number } | null;
}

export interface WindowInfo {
  readonly windowId: number;
  readonly pid: number;
  readonly app: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly layer: number;
}

export interface FocusedText {
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly value?: string;
  readonly selectedText?: string;
  readonly secure: boolean;
  readonly app?: string;
  readonly frame?: Rect | null;
}

export interface ElementInfo {
  readonly role?: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly description?: string;
  readonly value?: string;
  readonly frame?: Rect | null;
  readonly app?: string;
}

/** What the toolset needs from the helper. Faked in tests. */
export interface NativeHands {
  request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  readonly ready: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface NativeHandsProcessOptions {
  readonly binPath: string;
  readonly defaultTimeoutMs?: number;
  readonly spawnImpl?: typeof spawn;
}

export class NativeHandsProcess extends EventEmitter implements NativeHands {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private splitter = new LineSplitter();
  private starting: Promise<void> | undefined;

  constructor(private readonly opts: NativeHandsProcessOptions) {
    super();
  }

  get ready(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  get available(): boolean {
    return existsSync(this.opts.binPath);
  }

  private ensure(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      if (!existsSync(this.opts.binPath)) {
        reject(new NativeRequestError({ code: "unavailable", message: `hands helper not built at ${this.opts.binPath}; run pnpm build:hands` }));
        return;
      }
      const spawnFn = this.opts.spawnImpl ?? spawn;
      const child = spawnFn(this.opts.binPath, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      this.splitter = new LineSplitter();
      child.stdout?.on("data", (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = this.splitter.push(chunk);
        } catch (e) {
          log.warn((e as Error).message);
          return;
        }
        for (const line of lines) this.onLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => log.debug(chunk.toString().trim()));
      child.on("error", (e) => {
        log.error(`helper failed to spawn: ${e.message}`);
        this.failAll({ code: "unavailable", message: e.message });
        reject(e);
      });
      child.on("exit", (code, signal) => {
        log.warn(`helper exited (code ${code}, signal ${signal})`);
        this.child = undefined;
        this.failAll({ code: "unavailable", message: `hands helper exited (${code ?? signal})` });
        this.emit("exit", code, signal);
      });
      // Spawn is asynchronous; "spawn" fires once the process exists.
      child.once("spawn", () => resolve());
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private failAll(error: NativeError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new NativeRequestError(error));
      this.pending.delete(id);
    }
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      log.warn(`non-JSON from helper: ${line.slice(0, 120)}`);
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg.result ?? {});
    else {
      const code = String(msg.error?.code ?? "internal") as NativeError["code"];
      p.reject(new NativeRequestError({ code, message: String(msg.error?.message ?? "unknown helper error") }));
    }
  }

  async request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.ensure();
    const child = this.child;
    if (!child?.stdin) throw new NativeRequestError({ code: "unavailable", message: "hands helper is not running" });
    const id = `r${++this.seq}`;
    const line = `${JSON.stringify({ id, op, ...params })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeRequestError({ code: "timeout", message: `${op} did not answer within ${timeoutMs ?? this.opts.defaultTimeoutMs ?? 8000}ms` }));
      }, timeoutMs ?? this.opts.defaultTimeoutMs ?? 8000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin?.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new NativeRequestError({ code: "unavailable", message: err.message }));
        }
      });
    });
  }

  async hello(): Promise<{ version: string; pid: number; permissions: Permissions }> {
    return this.request("hello", {}, 3000);
  }

  /**
   * Read the grants from a *fresh* helper process (`--permissions`). The resident
   * helper may still report what it saw at launch; a new process asks TCC now.
   */
  probePermissions(timeoutMs = 3000): Promise<Permissions> {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.opts.binPath)) {
        reject(new NativeRequestError({ code: "unavailable", message: `hands helper not built at ${this.opts.binPath}` }));
        return;
      }
      execFile(this.opts.binPath, ["--permissions"], { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => {
        if (err) {
          reject(new NativeRequestError({ code: "unavailable", message: err.message }));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { accessibility?: unknown; screenRecording?: unknown };
          resolve({ accessibility: parsed.accessibility === true, screenRecording: parsed.screenRecording === true });
        } catch (e) {
          reject(new NativeRequestError({ code: "internal", message: `bad --permissions output: ${(e as Error).message}` }));
        }
      });
    });
  }

  /** Stop the resident helper and start a new one (a new grant applies to a new process). */
  async restart(): Promise<void> {
    this.stop();
    await this.ensure();
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.failAll({ code: "unavailable", message: "hands helper stopped" });
    try {
      child?.stdin?.end();
      child?.kill();
    } catch {
      // Already gone.
    }
  }
}
