import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Instant playback of an already-cached file.
 *
 * ffplay rather than afplay for the same reason as tts.ts: one player binary
 * across the codebase, and its probe knobs start decoding without sniffing
 * the whole file. With no network involved the budget is process startup —
 * measured ~100ms on this machine, inside the ~120ms target.
 *
 * No TCC startup guard here on purpose: the hang trap documented in mic.ts is
 * device *capture*. Playback is not TCC-gated, so ffplay either plays or exits.
 */

/** Generous: covers the longest ack plus process startup, far short of a stall. */
export const WATCHDOG_MS = 15_000;

export interface PlaybackResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly error: string | undefined;
}

export interface PlaybackHandle {
  /** Barge-in: kill playback immediately. Safe to call more than once. */
  readonly stop: () => void;
  /**
   * Resolves when playback ends, including after stop(). Never rejects: the
   * caller fires acks without awaiting them, and an unawaited rejection would
   * take down the process over what is only a missed grace note.
   */
  readonly done: Promise<PlaybackResult>;
}

export function playFile(path: string): PlaybackHandle {
  // Fail loudly before spawning: a missing file means the bank was never
  // built, and silence with exit code 1 from ffplay would hide that.
  if (!existsSync(path)) {
    throw new Error(`no cached audio at ${path} — run ensureBank/ensureEarcon first`);
  }

  const startedAt = Date.now();
  const ff = spawn(
    "ffplay",
    ["-nodisp", "-autoexit", "-loglevel", "quiet", "-probesize", "32", "-analyzeduration", "0", "-i", path],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  let stopped = false;
  // An ack is a two-second clip. If ffplay has not finished well past that, it
  // has wedged (CoreAudio device changes do this), and a hung ack would block a
  // turn that is supposed to feel instant. Kill it and move on.
  const done = new Promise<PlaybackResult>((resolve) => {
    let settled = false;
    const finish = (r: PlaybackResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(r);
    };
    const watchdog = setTimeout(() => {
      ff.kill("SIGKILL");
      finish({ ok: false, ms: Date.now() - startedAt, error: `playback exceeded ${WATCHDOG_MS}ms; killed` });
    }, WATCHDOG_MS);

    ff.on("error", (e) => finish({ ok: false, ms: Date.now() - startedAt, error: e.message }));
    ff.on("close", (code) => {
      const ok = stopped || code === 0;
      finish({ ok, ms: Date.now() - startedAt, error: ok ? undefined : `ffplay exited ${code}` });
    });
  });

  return {
    stop: (): void => {
      stopped = true;
      ff.kill("SIGKILL");
    },
    done,
  };
}
