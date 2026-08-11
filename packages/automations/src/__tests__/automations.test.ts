import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomation, parseSchedule, readRegistry, slugify } from "../create.ts";
import { isConsent, isRefusal, shouldOffer } from "../offer.ts";

const NOW = new Date("2026-08-11T00:00:00.000Z");
const state = (): string => mkdtempSync(join(tmpdir(), "jarvis-test-"));

test("consent must be affirmative and explicit", () => {
  for (const yes of ["go for it", "yes", "yeah do it", "sure", "ok", "sounds good"]) {
    assert.ok(isConsent(yes), yes);
  }
  for (const no of ["no", "nope", "not now", "later", "don't", "maybe", "hmm", ""]) {
    assert.ok(!isConsent(no), no);
  }
});

test("ambiguity is not consent", () => {
  // Anything unrecognized must fall through to "no". A standing or implied yes
  // is not approval under the wiki's governance rules.
  for (const u of ["i guess", "whatever", "why not", "tell me more"]) {
    assert.ok(!isConsent(u), u);
  }
});

test("refusal is detected separately from non-consent", () => {
  assert.ok(isRefusal("no thanks"));
  assert.ok(!isRefusal("i guess"));
});

test("offers only for recurring-worthy intents, and only once", () => {
  const offered = new Set<string>();
  assert.ok(shouldOffer("brief", offered));
  assert.ok(shouldOffer("hackernews", offered));
  assert.ok(!shouldOffer("greeting", offered));
  assert.ok(!shouldOffer("general", offered));

  offered.add("brief");
  assert.ok(!shouldOffer("brief", offered), "should not nag twice in a session");
});

test("schedule words map onto the contract enum", () => {
  assert.equal(parseSchedule("go for it, daily"), "daily");
  assert.equal(parseSchedule("yes every morning"), "daily");
  assert.equal(parseSchedule("weekly please"), "weekly");
  assert.equal(parseSchedule("every 4 hours"), "every-4-hours");
  assert.equal(parseSchedule("only when i ask"), "on-demand");
});

test("inexpressible cadences return undefined rather than rounding silently", () => {
  assert.equal(parseSchedule("every hour"), undefined);
  assert.equal(parseSchedule("every 10 minutes"), undefined);
});

test("slugify produces a bounded, filesystem-safe name", () => {
  assert.equal(slugify("what's on hackernews"), "whats-on-hackernews");
  assert.equal(slugify(""), "automation");
  assert.ok(slugify("a b c d e f g h i j").split("-").length <= 6);
});

test("creates an automation that validates against the real wiki contract", () => {
  const dir = state();
  const result = createAutomation({
    intent: "what's on hackernews",
    schedule: "daily",
    stateDir: dir,
    spokenConsent: "go for it",
    now: NOW,
  });

  assert.equal(result.slug, "whats-on-hackernews");
  assert.equal(result.entry.schedule, "daily");
  assert.equal(result.entry.enabled, true);

  // readRegistry round-trips, and assertContract already ran inside create.
  const registry = readRegistry(dir);
  assert.equal(registry.entries.length, 1);
  assert.match(registry.digest, /^[a-f0-9]{64}$/);
  assert.equal(registry.entries[0]!.input["intent"], "what's on hackernews");
});

test("records the verbatim spoken consent as the approval trail", () => {
  const dir = state();
  const result = createAutomation({
    intent: "what's my daily briefing",
    schedule: "daily",
    stateDir: dir,
    spokenConsent: "yeah go for it",
    now: NOW,
  });
  const md = readFileSync(result.markdownPath, "utf8");
  assert.match(md, /yeah go for it/);
  assert.match(md, /what's my daily briefing/);
});

test("re-creating the same automation on the same day replaces rather than duplicates", () => {
  const dir = state();
  const req = {
    intent: "what's on hackernews",
    schedule: "daily" as const,
    stateDir: dir,
    spokenConsent: "go for it",
    now: NOW,
  };
  createAutomation(req);
  createAutomation({ ...req, schedule: "weekly" as const });

  const registry = readRegistry(dir);
  assert.equal(registry.entries.length, 1, "should not accumulate duplicates");
  assert.equal(registry.entries[0]!.schedule, "weekly", "latest wins");
});

test("an empty state dir yields an empty but valid-shaped registry", () => {
  const registry = readRegistry(state());
  assert.equal(registry.entries.length, 0);
  assert.equal(registry.schemaVersion, "1");
});
