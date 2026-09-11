import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPathFor, type RegistrationEntry } from "@jarvis/automations";
import {
  bucketFor,
  bucketKey,
  dueAutomations,
  readRunState,
  runStatePathFor,
  writeRunState,
  type RunState,
} from "../scheduler.ts";

const state = (): string => mkdtempSync(join(tmpdir(), "jarvisd-test-"));

const T = (iso: string): number => new Date(iso).getTime();

/**
 * Registrations are written directly rather than through createAutomation, so
 * these tests do not depend on the wiki checkout being linked and healthy.
 */
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
    registrationId: "jarvis-whats-on-hackernews-2026-08-11",
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

test("daily bucket is stable across the whole UTC day", () => {
  assert.equal(bucketFor("daily", T("2026-08-11T00:00:00.000Z")), "2026-08-11");
  assert.equal(bucketFor("daily", T("2026-08-11T23:59:59.999Z")), "2026-08-11");
  assert.equal(bucketFor("daily", T("2026-08-12T00:00:00.000Z")), "2026-08-12");
});

test("every-4-hours buckets on window starts, including the midnight edge", () => {
  assert.equal(bucketFor("every-4-hours", T("2026-08-11T00:00:00.000Z")), "2026-08-11-h00");
  assert.equal(bucketFor("every-4-hours", T("2026-08-11T03:59:59.999Z")), "2026-08-11-h00");
  assert.equal(bucketFor("every-4-hours", T("2026-08-11T04:00:00.000Z")), "2026-08-11-h04");
  assert.equal(bucketFor("every-4-hours", T("2026-08-11T23:59:59.999Z")), "2026-08-11-h20");
  assert.equal(bucketFor("every-4-hours", T("2026-08-12T00:00:00.000Z")), "2026-08-12-h00");
});

test("weekly buckets follow ISO weeks, Sunday-to-Monday boundary included", () => {
  assert.equal(bucketFor("weekly", T("2026-08-11T12:00:00.000Z")), "2026-W33");
  assert.equal(bucketFor("weekly", T("2026-08-16T23:59:59.999Z")), "2026-W33", "Sunday still closes the ISO week");
  assert.equal(bucketFor("weekly", T("2026-08-17T00:00:00.000Z")), "2026-W34", "Monday opens the next");
});

test("weekly buckets get the ISO week-year right at year boundaries", () => {
  // Jan 1 2027 is a Friday: it belongs to 2026's W53, not 2027's W01. A
  // calendar-year bucket here would run the same weekly job twice in one week.
  assert.equal(bucketFor("weekly", T("2027-01-01T00:00:00.000Z")), "2026-W53");
  // And Dec 29 2025 is the Monday that opens 2026's W01.
  assert.equal(bucketFor("weekly", T("2025-12-29T00:00:00.000Z")), "2026-W01");
});

test("on-demand buckets are unique per trigger but deterministic for a timestamp", () => {
  const at = T("2026-08-11T12:00:00.123Z");
  assert.equal(bucketFor("on-demand", at), bucketFor("on-demand", at));
  assert.notEqual(bucketFor("on-demand", at), bucketFor("on-demand", at + 1));
});

test("bucket keys are scoped to the registration", () => {
  const at = T("2026-08-11T12:00:00.000Z");
  assert.notEqual(bucketKey("reg-a", "daily", at), bucketKey("reg-b", "daily", at));
  assert.equal(bucketKey("reg-a", "daily", at), "reg-a#2026-08-11");
});

test("due-detection with a frozen clock: enabled+scheduled only, until claimed", () => {
  const dir = state();
  const now = T("2026-08-11T12:00:00.000Z");
  seedRegistry(dir, [
    entry({ registrationId: "reg-daily", schedule: "daily" }),
    entry({ registrationId: "reg-weekly", schedule: "weekly" }),
    entry({ registrationId: "reg-disabled", schedule: "daily", enabled: false }),
    entry({ registrationId: "reg-manual", schedule: "on-demand" }),
  ]);

  const due = dueAutomations(dir, now);
  assert.deepEqual(
    due.map((d) => d.entry.registrationId).sort(),
    ["reg-daily", "reg-weekly"],
    "disabled and on-demand registrations must never be clock-due",
  );

  const runState = readRunState(dir);
  for (const d of due) {
    runState.buckets[d.bucket] = {
      registrationId: d.entry.registrationId,
      bucket: d.bucket,
      startedAt: new Date(now).toISOString(),
      status: "completed",
      finishedAt: new Date(now).toISOString(),
    };
  }
  writeRunState(dir, runState);

  assert.equal(dueAutomations(dir, now).length, 0, "a claimed bucket is never due again");
});

test("advancing the clock a day makes daily due again but not weekly", () => {
  const dir = state();
  const monday = T("2026-08-11T12:00:00.000Z");
  seedRegistry(dir, [
    entry({ registrationId: "reg-daily", schedule: "daily" }),
    entry({ registrationId: "reg-weekly", schedule: "weekly" }),
  ]);

  const runState = readRunState(dir);
  for (const d of dueAutomations(dir, monday)) {
    runState.buckets[d.bucket] = {
      registrationId: d.entry.registrationId,
      bucket: d.bucket,
      startedAt: new Date(monday).toISOString(),
      status: "completed",
      finishedAt: new Date(monday).toISOString(),
    };
  }
  writeRunState(dir, runState);

  const nextDay = dueAutomations(dir, monday + 24 * 60 * 60 * 1000);
  assert.deepEqual(
    nextDay.map((d) => d.entry.registrationId),
    ["reg-daily"],
    "same ISO week: weekly stays spent while daily rolls over",
  );
});

test("run state round-trips through disk", () => {
  const dir = state();
  const runState: RunState = {
    schemaVersion: "1",
    buckets: {
      "reg-daily#2026-08-11": {
        registrationId: "reg-daily",
        bucket: "reg-daily#2026-08-11",
        startedAt: "2026-08-11T12:00:00.000Z",
        status: "failed",
        finishedAt: "2026-08-11T12:00:02.000Z",
      },
    },
  };
  writeRunState(dir, runState);
  assert.deepEqual(readRunState(dir), runState);
});

test("a corrupt runs.json degrades to a fresh state instead of wedging", () => {
  const dir = state();
  mkdirSync(join(dir, "automations"), { recursive: true });
  writeFileSync(runStatePathFor(dir), "{ not json");
  const runState = readRunState(dir);
  assert.equal(runState.schemaVersion, "1");
  assert.deepEqual(runState.buckets, {});
});
