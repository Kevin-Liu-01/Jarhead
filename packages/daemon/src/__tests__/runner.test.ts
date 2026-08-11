import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPathFor, type RegistrationEntry } from "@jarvis/automations";
import { readRunState, type Clock } from "../scheduler.ts";
import { recentRuns, runDueAutomations, runLogPathFor, runOne, type RunRecord } from "../runner.ts";

const state = (): string => mkdtempSync(join(tmpdir(), "jarvisd-test-"));

const FROZEN = new Date("2026-08-11T12:00:00.000Z").getTime();
const frozenClock: Clock = () => FROZEN;

function seedRegistry(dir: string, entries: RegistrationEntry[]): void {
  mkdirSync(join(dir, "automations"), { recursive: true });
  writeFileSync(
    registryPathFor(dir),
    JSON.stringify({
      schemaVersion: "1",
      generatedAt: new Date(0).toISOString(),
      digest: "0".repeat(64),
      entries,
    }),
  );
}

function entry(overrides: Partial<RegistrationEntry> = {}): RegistrationEntry {
  return {
    registrationId: "reg-hn",
    slug: "whats-on-hackernews",
    workflowId: "research.refresh",
    profile: "jarvis-voice",
    schedule: "daily",
    timezone: "UTC",
    enabled: true,
    quietDelivery: false,
    jitterSeconds: 0,
    input: { intent: "what's on hackernews" },
    ...overrides,
  };
}

test("runs a due automation through the injected executor and records everything", async () => {
  const dir = state();
  seedRegistry(dir, [entry()]);
  const asked: string[] = [];

  const records = await runDueAutomations(
    dir,
    async (intent) => {
      asked.push(intent);
      return "top story is about postgres";
    },
    frozenClock,
  );

  assert.deepEqual(asked, ["what's on hackernews"], "the stored intent is what gets re-asked");
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.status, "completed");
  assert.equal(record.answer, "top story is about postgres");
  assert.equal(record.error, undefined);
  assert.equal(record.bucket, "reg-hn#2026-08-11");
  assert.equal(record.startedAt, "2026-08-11T12:00:00.000Z", "timestamps come from the injected clock");

  const runState = readRunState(dir);
  assert.equal(runState.buckets[record.bucket]?.status, "completed");
});

test("never runs a bucket twice, even across separate tick passes", async () => {
  const dir = state();
  seedRegistry(dir, [entry()]);
  let calls = 0;
  const execute = async (): Promise<string> => {
    calls += 1;
    return "answer";
  };

  const first = await runDueAutomations(dir, execute, frozenClock);
  const second = await runDueAutomations(dir, execute, frozenClock);
  const third = await runDueAutomations(dir, execute, () => FROZEN + 60_000);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(third.length, 0, "a minute later is still the same daily bucket");
  assert.equal(calls, 1, "the executor must have run exactly once");
});

test("a failed run spends its bucket — no retry until the next bucket", async () => {
  const dir = state();
  seedRegistry(dir, [entry()]);
  let calls = 0;

  const failing = async (): Promise<string> => {
    calls += 1;
    throw new Error("anthropic 529: overloaded");
  };

  const records = await runDueAutomations(dir, failing, frozenClock);
  assert.equal(records[0]?.status, "failed");
  assert.equal(records[0]?.error, "anthropic 529: overloaded");
  assert.equal(records[0]?.answer, undefined);

  const retry = await runDueAutomations(dir, failing, frozenClock);
  assert.equal(retry.length, 0, "retrying a failing job inside its bucket would hammer the API");
  assert.equal(calls, 1);

  const nextDay = await runDueAutomations(dir, async () => "recovered", () => FROZEN + 24 * 60 * 60 * 1000);
  assert.equal(nextDay[0]?.status, "completed", "the next bucket gets a fresh try");
});

test("runOne refuses an already-claimed bucket outright", async () => {
  const dir = state();
  const reg = entry();
  const first = await runOne(dir, reg, "reg-hn#2026-08-11", async () => "a", frozenClock);
  const second = await runOne(dir, reg, "reg-hn#2026-08-11", async () => "b", frozenClock);
  assert.equal(first?.answer, "a");
  assert.equal(second, undefined);
});

test("a registration without a stored intent fails cleanly instead of running nothing", async () => {
  const dir = state();
  seedRegistry(dir, [entry({ input: { requestId: "x" } })]);

  const records = await runDueAutomations(dir, async () => "should never be called", frozenClock);
  assert.equal(records[0]?.status, "failed");
  assert.match(records[0]?.error ?? "", /no stored intent/);
  assert.equal(readRunState(dir).buckets["reg-hn#2026-08-11"]?.status, "failed");
});

test("every run is appended to the durable log, newest first from recentRuns", async () => {
  const dir = state();
  seedRegistry(dir, [
    entry({ registrationId: "reg-a", input: { intent: "question a" } }),
    entry({ registrationId: "reg-b", input: { intent: "question b" } }),
  ]);

  await runDueAutomations(dir, async (intent) => `answer to ${intent}`, frozenClock);

  const lines = readFileSync(runLogPathFor(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "one NDJSON line per run");
  for (const line of lines) {
    const parsed = JSON.parse(line) as RunRecord;
    assert.equal(parsed.status, "completed");
  }

  const recent = recentRuns(dir, 10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.registrationId, "reg-b", "newest first");

  assert.equal(recentRuns(dir, 1).length, 1, "limit is respected");
});

test("recentRuns tolerates a torn final line from a crash", async () => {
  const dir = state();
  seedRegistry(dir, [entry()]);
  await runDueAutomations(dir, async () => "fine", frozenClock);

  writeFileSync(runLogPathFor(dir), `${readFileSync(runLogPathFor(dir), "utf8")}{"registrationId":"reg-hn","buc`);
  const recent = recentRuns(dir, 10);
  assert.equal(recent.length, 1, "the intact record survives; the torn one is skipped");
});

test("recentRuns on a fresh state dir is empty, not an error", () => {
  const dir = state();
  assert.equal(existsSync(runLogPathFor(dir)), false);
  assert.deepEqual(recentRuns(dir, 5), []);
});
