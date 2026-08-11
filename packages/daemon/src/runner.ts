import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistrationEntry } from "@jarvis/automations";
import { dueAutomations, readRunState, writeRunState, type Clock } from "./scheduler.ts";

/**
 * Executes due automations by re-running their stored intent through the
 * answer pipeline.
 *
 * The executor is injected rather than imported: the runner's correctness is
 * about claiming buckets and recording outcomes, and that must be provable
 * without a model call or a network. The daemon's entry point wires in the
 * real route → prompt → Brain pipeline.
 */
export type Executor = (intent: string) => Promise<string>;

export interface RunRecord {
  readonly registrationId: string;
  readonly bucket: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "completed" | "failed";
  readonly answer: string | undefined;
  readonly error: string | undefined;
}

export function runLogPathFor(stateDir: string): string {
  return join(stateDir, "automations", "run-log.ndjson");
}

/**
 * NDJSON append, not a rewritten JSON array: a crash mid-write loses at most
 * the final line, where rewriting the whole file risks the entire history.
 */
function appendRunLog(stateDir: string, record: RunRecord): void {
  mkdirSync(join(stateDir, "automations"), { recursive: true });
  appendFileSync(runLogPathFor(stateDir), `${JSON.stringify(record)}\n`);
}

/** Newest first. Lines that fail to parse are skipped, not fatal. */
export function recentRuns(stateDir: string, limit: number): RunRecord[] {
  const path = runLogPathFor(stateDir);
  if (!existsSync(path)) return [];
  const records: RunRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RunRecord;
      if (typeof parsed?.registrationId === "string" && typeof parsed.bucket === "string") {
        records.push(parsed);
      }
    } catch {
      // A torn final line from a crash is expected; everything before it is intact.
    }
  }
  return records.slice(-Math.max(1, Math.floor(limit))).reverse();
}

/**
 * Run one automation in one bucket. Returns undefined if the bucket was
 * already claimed — the never-run-a-bucket-twice guarantee lives here.
 *
 * The claim is persisted BEFORE the executor runs. If the process dies
 * mid-run, the bucket stays spent; and a failed run is not retried within its
 * bucket either, because a deterministic clock retrying a failing API turns
 * into a hammer. The failure is recorded and the next bucket gets a fresh try.
 */
export async function runOne(
  stateDir: string,
  entry: RegistrationEntry,
  bucket: string,
  execute: Executor,
  clock: Clock,
): Promise<RunRecord | undefined> {
  const state = readRunState(stateDir);
  if (state.buckets[bucket]) return undefined;

  const startedAt = new Date(clock()).toISOString();
  state.buckets[bucket] = {
    registrationId: entry.registrationId,
    bucket,
    startedAt,
    status: "running",
    finishedAt: undefined,
  };
  writeRunState(stateDir, state);

  const intent = entry.input["intent"];
  let status: RunRecord["status"];
  let answer: string | undefined;
  let error: string | undefined;

  if (typeof intent !== "string" || intent.trim() === "") {
    status = "failed";
    answer = undefined;
    error = "registration has no stored intent to re-run";
  } else {
    try {
      answer = await execute(intent);
      status = "completed";
      error = undefined;
    } catch (e) {
      status = "failed";
      answer = undefined;
      error = (e as Error).message;
    }
  }

  const finishedAt = new Date(clock()).toISOString();
  const record: RunRecord = { registrationId: entry.registrationId, bucket, startedAt, finishedAt, status, answer, error };

  // Re-read before updating: the executor can take a long time, and a claim
  // written by another run in the meantime must not be clobbered.
  const after = readRunState(stateDir);
  after.buckets[bucket] = { registrationId: entry.registrationId, bucket, startedAt, status, finishedAt };
  writeRunState(stateDir, after);
  appendRunLog(stateDir, record);

  return record;
}

/**
 * One pass over everything due. Sequential on purpose: two automations hitting
 * the model at once buys nothing and doubles the failure modes, and the daemon
 * has all day.
 */
export async function runDueAutomations(stateDir: string, execute: Executor, clock: Clock): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const due of dueAutomations(stateDir, clock())) {
    const record = await runOne(stateDir, due.entry, due.bucket, execute, clock);
    if (record) records.push(record);
  }
  return records;
}
