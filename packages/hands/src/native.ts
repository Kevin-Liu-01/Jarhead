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
  readonly code: "bad_request" | "permission_denied" | "capture_failed" | "not_found" | "internal" | "unavailable" | "timeout" | "cancelled";
  readonly message: string;
}

export class NativeRequestError extends Error {
  constructor(readonly detail: NativeError) {
    super(`${detail.code}: ${detail.message}`);
    this.name = "NativeRequestError";
  }
}

/**
 * The grants a helper process reads for itself (`jarhead-hands --permissions`). TCC
 * keys them on the responsible app, so under Jarhead.app these are the app's answers;
 * from a terminal they are the terminal's. The app reads the other twelve kinds
 * (microphone, speech, camera, contacts, …) itself and reports them over the wire.
 */
export interface Permissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  /** Input Monitoring: IOHIDCheckAccess(listen) — the app's global key monitors (mark mode) need it. */
  readonly inputMonitoring: boolean;
  /** Full Disk Access: a read probe of an FDA-only path (no API, no prompt exists). */
  readonly fullDiskAccess: boolean;
}

/** The kinds the helper reads, in the order `--permissions` prints them. */
export const HELPER_PERMISSION_KINDS = ["accessibility", "screenRecording", "inputMonitoring", "fullDiskAccess"] as const;
export type HelperPermissionKind = (typeof HELPER_PERMISSION_KINDS)[number];

/** `hello` from a helper built before Input Monitoring / Full Disk Access were read lacks those two. */
export type HelloPermissions = Pick<Permissions, "accessibility" | "screenRecording"> & Partial<Permissions>;

/** The helper's JSON (any build) as booleans; a key a build did not print is absent, never false. */
export function parseHelperPermissions(raw: unknown): HelloPermissions {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, boolean> = { accessibility: o["accessibility"] === true, screenRecording: o["screenRecording"] === true };
  for (const kind of ["inputMonitoring", "fullDiskAccess"] as const) if (typeof o[kind] === "boolean") out[kind] = o[kind];
  return out as unknown as HelloPermissions;
}

/** Every kind a boolean: what a current `--permissions` run yields (a missing key reads as not granted). */
export function completeHelperPermissions(p: HelloPermissions): Permissions {
  return { accessibility: p.accessibility, screenRecording: p.screenRecording, inputMonitoring: p.inputMonitoring === true, fullDiskAccess: p.fullDiskAccess === true };
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
  /** The helper's running frame number (absent from the screencapture fallback and older helpers). */
  readonly frameId?: number;
  /** The display-configuration hash the shot was taken under (display ids and bounds, the front app and its front window). */
  readonly config?: string;
}

export interface FrontmostInfo {
  readonly app: string;
  readonly bundleId?: string;
  readonly pid: number;
  readonly window: { readonly title: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly windowId: number } | null;
  /** The screen is locked or another user's session is on the console (a probe may carry it). */
  readonly locked?: boolean;
}

/** What the helper's `type` op reports back: how the text was delivered and whether it read back. */
export interface TypeResult {
  readonly characters: number;
  readonly events: number;
  /** The strategy that delivered it (the last one, when several were tried). */
  readonly via: "ax" | "keystrokes" | "paste";
  readonly attempts: number;
  /** True when the field's value read back with the text; false when the field exposes no value to read; absent when nothing was typed. */
  readonly verified?: boolean;
  /** "the Subject field in Mail" — the field it landed in, when accessibility knew. */
  readonly field?: string;
  /** A stop landed between two graphemes: `characters` were typed, the rest were not. */
  readonly cancelled?: boolean;
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
  /** The display-configuration hash right now (see ScreenshotResult.config); the gate compares it with the last shot's. */
  readonly config?: string;
  /** The screen is locked (CGSessionCopyCurrentDictionary). */
  readonly locked?: boolean;
}

export interface ElementInfo {
  readonly role?: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly description?: string;
  readonly value?: string;
  readonly frame?: Rect | null;
  readonly app?: string;
  /** The display-configuration hash right now; a coordinate action compares it with the last screenshot's. */
  readonly config?: string;
  /** The screen is locked (CGSessionCopyCurrentDictionary). */
  readonly locked?: boolean;
}

/** One node of the frontmost window's accessibility tree, as `ax_tree` / `find_element` report it. */
export interface AxNodeInfo {
  readonly i: number;
  readonly depth: number;
  readonly role: string;
  readonly subrole?: string;
  readonly title?: string;
  readonly description?: string;
  readonly value?: string;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly pressable?: boolean;
}

/** `find_element`'s best match: the node plus how it matched and where to click. */
export interface FoundElement extends AxNodeInfo {
  readonly app: string;
  readonly score: number;
  readonly label: string;
  readonly center?: { readonly x: number; readonly y: number };
}

export interface FindElementResult {
  readonly app: string;
  readonly window: string;
  readonly found: boolean;
  /** Exactly one control carries the name; two candidates mean the caller must not guess. */
  readonly unique: boolean;
  readonly candidates: number;
  readonly tier: "exact" | "fuzzy" | "none";
  readonly element?: FoundElement;
  readonly others?: readonly FoundElement[];
  readonly cached: boolean;
  readonly treeMs: number;
  readonly nodes: number;
  readonly truncated: boolean;
  readonly ms: number;
}

export interface AxTreeResult {
  readonly app: string;
  readonly pid: number;
  readonly window: string;
  readonly count: number;
  readonly cached: boolean;
  readonly ageMs: number;
  readonly treeMs: number;
  readonly truncated: boolean;
  /** Absent with `summary: true`. */
  readonly nodes?: readonly AxNodeInfo[];
}

export interface BrowserTab {
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
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
  op: string;
}

/**
 * The out-of-band stop for a `type` in flight. The helper is serial — a cancel line
 * would queue behind the very op it means to stop — so the client sends a signal
 * instead: the helper's type loop checks between grapheme clusters and stops
 * mid-word. SIGURG because its default action is "ignore": a helper built before
 * the handler existed shrugs it off instead of dying.
 */
export const TYPE_CANCEL_SIGNAL: NodeJS.Signals = "SIGURG";

export interface NativeHandsProcessOptions {
  readonly binPath: string;
  readonly defaultTimeoutMs?: number;
  readonly spawnImpl?: typeof spawn;
  /** With a stand-in `spawnImpl` there is no binary to find: treat the helper as available. */
  readonly assumeAvailable?: boolean;
  /** Test seam for the fresh-process read (`--permissions`): what a new helper process would print. */
  readonly probeImpl?: () => Promise<HelloPermissions>;
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
    return this.opts.assumeAvailable === true || existsSync(this.opts.binPath);
  }

  private ensure(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      if (!this.available) {
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
        // After restart() a successor may already be running: only the current child
        // clears the slot and fails the pending requests; a late exit of an old one
        // must not orphan the new helper (which then leaks as a second process).
        if (this.child === child) {
          this.child = undefined;
          this.failAll({ code: "unavailable", message: `hands helper exited (${code ?? signal})` });
        }
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

  /** Requests still waiting on the helper right now. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Kevin pressed stop: every request in flight is failed now with `cancelled`,
   * so the toolset awaiting it returns an error instead of acting on the answer.
   * The helper is serial and cannot be interrupted mid-op — a click already sent
   * still lands — but its late reply arrives for an id nobody waits on and is
   * dropped in onLine(), and nothing queued behind it is written. Returns how
   * many were dropped.
   */
  cancelPending(reason = "stopped"): number {
    const n = this.pending.size;
    // A `type` in flight is the one op the helper can stop part way: tell it, out of band,
    // before the ids are forgotten. Nothing to send for anything else (a click has landed).
    const typing = [...this.pending.values()].some((p) => p.op === "type");
    this.failAll({ code: "cancelled", message: reason });
    if (typing) this.signalTypeCancel();
    return n;
  }

  /** SIGURG to the resident helper: its type loop stops at the next grapheme. Harmless to a helper that does not listen. */
  private signalTypeCancel(): void {
    const pid = this.child?.pid;
    if (typeof pid !== "number" || pid <= 0 || !this.ready) return;
    try {
      process.kill(pid, TYPE_CANCEL_SIGNAL);
    } catch (e) {
      log.debug(`type cancel signal: ${(e as Error).message}`);
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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, op });
      child.stdin?.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new NativeRequestError({ code: "unavailable", message: err.message }));
        }
      });
    });
  }

  /** The resident helper's greeting: its version, pid and the grants it read at launch (a key an older build did not print is absent). */
  async hello(): Promise<{ version: string; pid: number; permissions: HelloPermissions }> {
    const raw = await this.request<{ version: string; pid: number; permissions?: unknown }>("hello", {}, 3000);
    return { version: raw.version, pid: raw.pid, permissions: parseHelperPermissions(raw.permissions) };
  }

  /**
   * Read the grants from a *fresh* helper process (`--permissions`). The resident
   * helper may still report what it saw at launch; a new process asks TCC now. All
   * four kinds come back as booleans (a key an older binary did not print reads as
   * not granted; `pnpm build:hands` fixes that).
   */
  probePermissions(timeoutMs = 3000): Promise<Permissions> {
    if (this.opts.probeImpl) return this.opts.probeImpl().then(completeHelperPermissions);
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
          resolve(completeHelperPermissions(parseHelperPermissions(JSON.parse(stdout.trim()))));
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
