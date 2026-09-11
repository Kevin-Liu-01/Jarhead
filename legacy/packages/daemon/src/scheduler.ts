import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRegistry, type RegistrationEntry, type Schedule } from "@jarvis/automations";

/**
 * Decides what is due, and remembers what already ran.
 *
 * Idempotency is bucket-based rather than "last ran at" arithmetic, because
 * the tick is allowed to be sloppy: it fires late after laptop sleep, twice
 * when a manual tick races the timer, and not at all while the machine is
 * off. Deriving a deterministic bucket key from (registration, schedule, now)
 * and refusing to run a bucket twice makes every one of those failure modes
 * a no-op instead of a double-run or a skip.
 *
 * The clock is always injected. Schedule logic that reads Date.now() directly
 * cannot be tested at a boundary, and boundaries are where this code earns
 * its keep.
 */

/** Epoch ms. Injected everywhere so tests can freeze and step time. */
export type Clock = () => number;

/**
 * ISO-8601 week, computed in UTC.
 *
 * The week-year is not the calendar year: Jan 1 can belong to the previous
 * year's W52/W53, and Dec 29–31 can belong to next year's W01. Getting this
 * wrong would double-run a weekly automation at every year boundary.
 */
function isoWeek(at: Date): { readonly year: number; readonly week: number } {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  // A date's ISO week is the week of its nearest Thursday, per ISO 8601.
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/**
 * Buckets are UTC on purpose. The registration carries Kevin's timezone, but
 * that is a delivery-window concern; the bucket is an identity, and identities
 * derived from local time repeat or vanish across DST transitions.
 */
export function bucketFor(schedule: Schedule, atMs: number): string {
  const at = new Date(atMs);
  const day = at.toISOString().slice(0, 10);
  switch (schedule) {
    case "daily":
      return day;
    case "weekly": {
      const { year, week } = isoWeek(at);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "every-4-hours": {
      const windowStart = Math.floor(at.getUTCHours() / 4) * 4;
      return `${day}-h${String(windowStart).padStart(2, "0")}`;
    }
    case "on-demand":
      // Every explicit trigger is its own bucket: "run it now" must always
      // run, while the ms-precision key still deduplicates a doubled request.
      return at.toISOString();
  }
}

export function bucketKey(registrationId: string, schedule: Schedule, atMs: number): string {
  return `${registrationId}#${bucketFor(schedule, atMs)}`;
}

/**
 * The persisted claim on a bucket. Once a key appears here — in any status,
 * including "running" — that bucket is spent forever. A crash mid-run leaves
 * a "running" claim behind, and that is deliberate: re-running a job whose
 * side effects may have half-happened is worse than losing one cycle.
 */
export interface BucketClaim {
  readonly registrationId: string;
  readonly bucket: string;
  readonly startedAt: string;
  readonly status: "running" | "completed" | "failed";
  readonly finishedAt: string | undefined;
}

export interface RunState {
  schemaVersion: "1";
  buckets: Record<string, BucketClaim>;
}

export function runStatePathFor(stateDir: string): string {
  return join(stateDir, "automations", "runs.json");
}

export function readRunState(stateDir: string): RunState {
  const path = runStatePathFor(stateDir);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as RunState;
      if (parsed?.schemaVersion === "1" && typeof parsed.buckets === "object" && parsed.buckets !== null) {
        return parsed;
      }
    } catch {
      // Fall through to a fresh state rather than wedging the daemon. The cost
      // is one extra run per registration, bounded by the bucket granularity.
    }
  }
  return { schemaVersion: "1", buckets: {} };
}

export function writeRunState(stateDir: string, state: RunState): void {
  mkdirSync(join(stateDir, "automations"), { recursive: true });
  writeFileSync(runStatePathFor(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

export interface DueAutomation {
  readonly entry: RegistrationEntry;
  /** Full bucket key, already scoped to the registration. */
  readonly bucket: string;
}

/**
 * Everything scheduled that has not run in the current bucket. On-demand
 * registrations never appear: they have no clock, only explicit triggers.
 */
export function dueAutomations(stateDir: string, atMs: number): DueAutomation[] {
  const state = readRunState(stateDir);
  const due: DueAutomation[] = [];
  for (const entry of readRegistry(stateDir).entries) {
    if (!entry.enabled || entry.schedule === "on-demand") continue;
    const key = bucketKey(entry.registrationId, entry.schedule, atMs);
    if (state.buckets[key]) continue;
    due.push({ entry, bucket: key });
  }
  return due;
}
