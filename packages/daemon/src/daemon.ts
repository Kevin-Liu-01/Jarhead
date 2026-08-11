import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";
import type { JarvisConfig } from "@jarvis/core";
import { readRegistry } from "@jarvis/automations";
import { topStories, useCacheDir, HN_TTL_MS } from "@jarvis/answers";
import { recentRuns, runDueAutomations, type Executor, type RunRecord } from "./runner.ts";
import type { Clock } from "./scheduler.ts";
import { startIpcServer } from "./ipc.ts";

/**
 * jarvisd — the missing clock.
 *
 * Automations created by voice were being written and never run, because
 * nothing resident owned a timer. This is that resident process: a tick loop
 * that runs whatever the scheduler says is due, plus a prefetch pass that
 * keeps the Hacker News cache warm so the voice path's "what's on hackernews"
 * answers from disk instead of doing a fan-out while Kevin waits.
 */

export const DEFAULT_TICK_MS = 5 * 60 * 1000;

export function pidfilePathFor(stateDir: string): string {
  return join(stateDir, "jarvisd.pid");
}

/** Signal 0 probes without killing. EPERM means alive but not ours — still alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AlreadyRunningError extends Error {
  constructor(pid: number, path: string) {
    super(
      `jarvisd is already running (pid ${pid}, per ${path}). ` +
        `Stop it over the socket ({"cmd":"stop"}) or kill ${pid} before starting another.`,
    );
    this.name = "AlreadyRunningError";
  }
}

/**
 * Two daemons ticking the same state dir would race the run-state file, so
 * the pidfile is a hard gate. A pidfile whose process is gone (crash, reboot)
 * is cleaned up silently — refusing to start over a corpse would mean every
 * unclean shutdown needs a manual `rm` before Jarvis works again.
 */
export function acquirePidfile(stateDir: string, pid: number = process.pid): void {
  const path = pidfilePathFor(stateDir);
  if (existsSync(path)) {
    const recorded = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(recorded) && recorded > 0 && recorded !== pid && pidAlive(recorded)) {
      throw new AlreadyRunningError(recorded, path);
    }
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, `${pid}\n`);
}

/** Removes the pidfile only if it is still ours — a newer daemon may have replaced a stale one. */
export function releasePidfile(stateDir: string, pid: number = process.pid): void {
  const path = pidfilePathFor(stateDir);
  if (!existsSync(path)) return;
  const recorded = Number(readFileSync(path, "utf8").trim());
  if (recorded === pid) rmSync(path, { force: true });
}

export interface DaemonStatus {
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly ticks: number;
  readonly tickMs: number;
  readonly lastTickAt: string | undefined;
  readonly lastPrefetchAt: string | undefined;
  readonly registrations: number;
  readonly enabledRegistrations: number;
  readonly stateDir: string;
  readonly socketPath: string;
}

export interface DaemonOptions {
  readonly config: JarvisConfig;
  readonly execute: Executor;
  readonly tickMs?: number;
  /** How often the prefetch pass actually refetches. Defaults to the HN cache TTL. */
  readonly prefetchMs?: number;
  /** Injected so tests can warm a fake cache instead of the network. */
  readonly prefetch?: () => Promise<unknown>;
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
}

export class Daemon {
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly prefetchMs: number;
  private readonly doPrefetch: () => Promise<unknown>;
  private readonly log: (line: string) => void;

  private timer: NodeJS.Timeout | undefined;
  private server: Server | undefined;
  private ticking = false;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private startedAtMs = 0;
  private ticks = 0;
  private lastTickAtMs: number | undefined;
  private lastPrefetchAtMs: number | undefined;

  constructor(private readonly opts: DaemonOptions) {
    this.clock = opts.clock ?? ((): number => Date.now());
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.prefetchMs = opts.prefetchMs ?? HN_TTL_MS;
    // force:true because the whole point of a resident prefetcher is that the
    // cache never gets old enough for a live turn to pay the fetch.
    this.doPrefetch = opts.prefetch ?? ((): Promise<unknown> => topStories({ force: true }));
    this.log = opts.log ?? ((line): void => console.log(line));
  }

  async start(): Promise<void> {
    const { stateDir, socketPath } = this.opts.config;
    mkdirSync(stateDir, { recursive: true });
    acquirePidfile(stateDir);

    try {
      useCacheDir(stateDir);
      this.server = await startIpcServer(socketPath, {
        status: () => this.status(),
        runs: (limit) => recentRuns(stateDir, limit),
        tick: () => this.tick(),
        stop: () => this.stop("ipc stop"),
      });
    } catch (e) {
      // Don't hold the lock for a daemon that never came up.
      releasePidfile(stateDir);
      throw e;
    }

    this.installSignalHandlers();
    this.startedAtMs = this.clock();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.log(`jarvisd up: pid ${process.pid}, tick every ${Math.round(this.tickMs / 1000)}s, socket ${socketPath}`);
  }

  /** One scheduler pass. Safe to call while the timer is armed; overlapping calls no-op. */
  async tick(): Promise<RunRecord[]> {
    // A tick slower than the interval must not stack on itself — the bucket
    // claim would catch the double-run anyway, but there is no reason to race.
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      const now = this.clock();
      this.ticks += 1;
      this.lastTickAtMs = now;
      await this.prefetch(now);
      const runs = await runDueAutomations(this.opts.config.stateDir, this.opts.execute, this.clock);
      for (const run of runs) {
        this.log(`ran ${run.registrationId} [${run.bucket}] -> ${run.status}${run.error ? `: ${run.error}` : ""}`);
      }
      return runs;
    } finally {
      this.ticking = false;
    }
  }

  private async prefetch(nowMs: number): Promise<void> {
    if (this.lastPrefetchAtMs !== undefined && nowMs - this.lastPrefetchAtMs < this.prefetchMs) return;
    this.lastPrefetchAtMs = nowMs;
    try {
      await this.doPrefetch();
    } catch (e) {
      // A cold cache is a slow turn, not a dead daemon.
      this.log(`prefetch failed: ${(e as Error).message}`);
    }
  }

  status(): DaemonStatus {
    const now = this.clock();
    const entries = readRegistry(this.opts.config.stateDir).entries;
    return {
      pid: process.pid,
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs: now - this.startedAtMs,
      ticks: this.ticks,
      tickMs: this.tickMs,
      lastTickAt: this.lastTickAtMs === undefined ? undefined : new Date(this.lastTickAtMs).toISOString(),
      lastPrefetchAt: this.lastPrefetchAtMs === undefined ? undefined : new Date(this.lastPrefetchAtMs).toISOString(),
      registrations: entries.length,
      enabledRegistrations: entries.filter((e) => e.enabled).length,
      stateDir: this.opts.config.stateDir,
      socketPath: this.opts.config.socketPath,
    };
  }

  /**
   * Tears everything down and releases the pidfile. Does not call
   * process.exit: once the timer and server are gone the event loop drains
   * and the process ends on its own, which is the exit path that cannot skip
   * cleanup.
   */
  async stop(reason: string): Promise<void> {
    // Returning early on re-entry is not enough. The IPC "stop" handler replies
    // before teardown finishes, so a caller that then awaits stop() would get an
    // already-resolved promise and observe the pidfile still on disk. Hand back
    // the in-flight teardown instead, so every caller waits for the same one.
    this.stopping ??= this.teardown(reason);
    return this.stopping;
  }

  private async teardown(reason: string): Promise<void> {
    this.stopped = true;

    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    rmSync(this.opts.config.socketPath, { force: true });
    releasePidfile(this.opts.config.stateDir);
    this.log(`jarvisd stopped (${reason})`);
  }

  private installSignalHandlers(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        // Exit explicitly after teardown: launchd's KeepAlive watches the exit
        // code, and a second signal mid-teardown should not race the cleanup.
        void this.stop(signal).then(() => process.exit(0));
      });
    }
  }
}
