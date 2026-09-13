import { execFile } from "node:child_process";
import { logger } from "@jarhead/core";
import type { Brain } from "@jarhead/brain";
import { DEFAULT_SETTINGS } from "@jarhead/protocol";

/**
 * Warm brains for threads: N `codex app-server` PROCESSES kept ready (their thread
 * started, no primer — a spare's boot is a process, not a model request), so the
 * first splits land at once instead of paying initialize + thread/start (0.6–7 s
 * on this Mac, over a minute under load). WARM_SPARES comes from
 * Settings.warmThreads (default 2, clamped 0..3); the pool tops up after every
 * take, retries a failed boot after WARM_SPARE_RETRY_MS instead of never again
 * this wake, and logs one line per spare with its RSS when the brain tells its
 * pid. Sleep stops every spare AND closes the pool: a thread's process released
 * after `stopAll()` (a real `brain.stop()` takes time), a tick, a late take — none
 * of them boots a spare behind Jarhead's back while it sleeps or shuts down; only
 * the wake path's `warm()` opens it again. Nothing here ever opens a Live session.
 */

const log = logger("engine.threads.pool");

export const WARM_SPARES_DEFAULT = DEFAULT_SETTINGS.warmThreads;
export const WARM_SPARES_MAX = 3;
/** A failed spare boot (Codex signed out, the app-server missing) is tried again after this. */
export const WARM_SPARE_RETRY_MS = 60_000;

export interface Ready {
  readonly ready: boolean;
  readonly detail: string;
}

/** What the pool needs of a lane: an id, its brain, and the boot promise it shares with the scheduler. */
export interface PoolLane {
  readonly id: string;
  readonly brain: Brain;
  started: Promise<Ready> | undefined;
}

export interface BrainPoolOptions<L extends PoolLane> {
  /** Settings.warmThreads, read live; clamped to 0..WARM_SPARES_MAX. */
  readonly spares?: (() => number) | undefined;
  readonly retryMs?: number | undefined;
  /** Builds a lane with a brain that has its own thread, or undefined when the current brain kind cannot. */
  readonly makeLane: () => L | undefined;
  readonly now?: (() => number) | undefined;
  /** Settings.workers (the on/off flag): no spares while off. */
  readonly enabled?: (() => boolean) | undefined;
  /** The idle spare's RSS in MB, for the one log line per spare (default: `ps` over the brain's pid when it exposes one). */
  readonly rssOf?: ((lane: L) => Promise<number | undefined>) | undefined;
}

export class BrainPool<L extends PoolLane> {
  /** Spares, ready or booting, oldest first. */
  private readonly spares: L[] = [];
  private readonly ready = new Set<string>();
  private failedAt: number | undefined;
  /** Closed by `stopAll()`: nothing boots until the wake path's `warm()`. */
  private closed = false;
  private readonly now: () => number;
  private readonly retryMs: number;
  /** Boots started over the pool's life (tests). */
  boots = 0;

  constructor(private readonly opts: BrainPoolOptions<L>) {
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? WARM_SPARE_RETRY_MS;
  }

  /** How many spares the settings want right now. */
  get wanted(): number {
    const n = Math.round(Number(this.opts.spares?.() ?? WARM_SPARES_DEFAULT));
    return Math.min(WARM_SPARES_MAX, Math.max(0, Number.isFinite(n) ? n : WARM_SPARES_DEFAULT));
  }

  /** Spares whose brain is up. */
  get warmCount(): number {
    return this.ready.size;
  }

  /** Spares still booting. */
  get bootingCount(): number {
    return this.spares.length - this.ready.size;
  }

  get spareIds(): readonly string[] {
    return this.spares.map((l) => l.id);
  }

  /** A boot failed and the retry is not due yet. */
  get cooling(): boolean {
    return this.failedAt !== undefined && this.now() - this.failedAt < this.retryMs;
  }

  /** Asleep or shutting down: no spare boots until `warm()`. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Close the pool without stopping anything yet (the scheduler closes it before it cancels its threads, so their releases top nothing up). */
  close(): void {
    this.closed = true;
  }

  /**
   * The wake path: the pool opens and tops up to `wanted` spares. Nothing awaits a
   * boot; a spare that fails is dropped, its process stopped, and the next top-up
   * waits out the retry window. Returns how many boots this call started.
   */
  warm(): number {
    this.closed = false;
    return this.topUp();
  }

  /**
   * Top up to `wanted` spares while the pool is open (after a take, a release, the
   * tick). Closed — asleep — it boots nothing and says so with 0.
   */
  topUp(): number {
    if (this.closed) return 0;
    if (this.opts.enabled?.() === false) return 0;
    if (this.cooling) return 0;
    let started = 0;
    while (this.spares.length < this.wanted) {
      const lane = this.opts.makeLane();
      if (!lane) break;
      this.spares.push(lane);
      this.boots++;
      started++;
      lane.started = lane.brain.start().catch((e: unknown) => ({ ready: false, detail: (e as Error).message }));
      void lane.started.then((r) => this.booted(lane, r));
    }
    return started;
  }

  private booted(lane: L, r: Ready): void {
    if (!this.spares.includes(lane)) return; // taken, or stopped meanwhile
    if (!r.ready) {
      log.warn(`spare thread brain ${lane.id} did not start: ${r.detail}; next try in ${Math.round(this.retryMs / 1000)} s`);
      this.remove(lane);
      this.failedAt = this.now();
      void lane.brain.stop().catch((e: unknown) => log.debug(`spare ${lane.id} stop: ${(e as Error).message}`));
      return;
    }
    this.ready.add(lane.id);
    this.failedAt = undefined;
    void this.rss(lane).then((mb) => log.info(`spare thread brain ready (${lane.id}): ${r.detail}${mb !== undefined ? `; rss ${mb} MB` : ""}`));
  }

  /**
   * A lane for a new thread: a ready spare first (its process is up: the caller's
   * `start()` returns in microseconds), else one still booting (its boot is ahead
   * of a cold one), else undefined — the caller builds a cold lane and awaits its
   * boot inside the run, never on the caller's path. The pool tops up after.
   */
  take(): L | undefined {
    let lane = this.spares.find((l) => this.ready.has(l.id)) ?? this.spares[0];
    if (!lane) {
      this.topUp();
      return undefined;
    }
    this.remove(lane);
    lane = lane as L;
    // Top up in the background: the next split within seconds finds a spare too (not while closed).
    queueMicrotask(() => this.topUp());
    return lane;
  }

  /** A thread ended: its process goes (the spare, if any, is a different lane), then the pool tops up — unless it closed meanwhile (a sleep). */
  async release(lane: PoolLane): Promise<void> {
    await lane.brain.stop().catch((e: unknown) => log.debug(`thread brain ${lane.id} stop: ${(e as Error).message}`));
    this.topUp();
  }

  /** Sleep / shutdown: the pool closes, every spare — booting too — is stopped; a failed boot is forgotten (the next wake tries again). */
  async stopAll(): Promise<void> {
    this.closed = true;
    const spares = this.spares.splice(0);
    this.ready.clear();
    this.failedAt = undefined;
    await Promise.all(spares.map((l) => l.brain.stop().catch((e: unknown) => log.debug(`spare ${l.id} stop: ${(e as Error).message}`))));
  }

  private remove(lane: L): void {
    const i = this.spares.indexOf(lane);
    if (i >= 0) this.spares.splice(i, 1);
    this.ready.delete(lane.id);
  }

  private async rss(lane: L): Promise<number | undefined> {
    try {
      if (this.opts.rssOf) return await this.opts.rssOf(lane);
      const pid = (lane.brain as { readonly pid?: number }).pid;
      return typeof pid === "number" && pid > 0 ? await rssMbOfPid(pid) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A process's resident set in MB, by `ps` (macOS reports KB); undefined when it cannot be read. */
export function rssMbOfPid(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 1500 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const kb = Number(String(stdout).trim());
        resolve(Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}
