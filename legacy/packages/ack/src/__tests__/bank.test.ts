import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AckBank, ackDir, cacheKey, phrasePath, planBank, ensureBank, type BankPhrases } from "../bank.ts";

const VOICE = "voice-a";
const MODEL = "model-a";

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-ack-test-"));
}

/** Simulates a bank that was already built: real bytes on disk, no network. */
function cachePhrase(stateDir: string, text: string): void {
  mkdirSync(ackDir(stateDir), { recursive: true });
  writeFileSync(phrasePath(stateDir, text, VOICE, MODEL), Buffer.from("fake mp3"));
}

test("cache key is stable for identical text+voice+model", () => {
  assert.equal(cacheKey("on it", VOICE, MODEL), cacheKey("on it", VOICE, MODEL));
});

test("cache key changes when any of text, voice, or model changes", () => {
  const base = cacheKey("on it", VOICE, MODEL);
  assert.notEqual(cacheKey("one sec", VOICE, MODEL), base);
  assert.notEqual(cacheKey("on it", "voice-b", MODEL), base);
  assert.notEqual(cacheKey("on it", VOICE, "model-b"), base);
});

test("cache key does not collide when the field boundary moves", () => {
  // Without a separator these two would concatenate identically.
  assert.notEqual(cacheKey("ab", "c", MODEL), cacheKey("a", "bc", MODEL));
});

test("rotation never repeats consecutively, even with an adversarial index source", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: ["hey", "hey Kevin", "what's up"], thinking: [], working: [] };
  for (const p of phrases.greeting) cachePhrase(stateDir, p);

  // Always-zero is the worst case: a naive implementation returns the same
  // phrase every time.
  const bank = new AckBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases, pickIndex: () => 0 });
  let previous = bank.pickAck("greeting");
  assert.ok(previous, "expected a path from a fully cached category");
  for (let i = 0; i < 50; i++) {
    const next = bank.pickAck("greeting");
    assert.ok(next);
    assert.notEqual(next, previous, `repeat at pick ${i}`);
    previous = next;
  }
});

test("rotation reaches every cached phrase", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: [], thinking: ["let me look", "checking", "hmm"], working: [] };
  for (const p of phrases.thinking) cachePhrase(stateDir, p);

  // A deterministic LCG: varied like Math.random, replayable unlike it. High
  // bits, because a power-of-two LCG's low bit just alternates.
  let seed = 1;
  const lcg = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor(seed / 65536) % n;
  };
  const bank = new AckBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases, pickIndex: lcg });
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const path = bank.pickAck("thinking");
    assert.ok(path);
    seen.add(path);
  }
  assert.equal(seen.size, 3, "rotation should cycle through all three phrases");
});

test("a single cached phrase repeats rather than going silent", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: [], thinking: [], working: ["on it"] };
  cachePhrase(stateDir, "on it");

  const bank = new AckBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases, pickIndex: () => 0 });
  const first = bank.pickAck("working");
  assert.ok(first);
  assert.equal(bank.pickAck("working"), first);
});

test("pickAck returns undefined when nothing is cached", () => {
  const bank = new AckBank({ stateDir: freshStateDir(), voiceId: VOICE, modelId: MODEL, pickIndex: () => 0 });
  assert.equal(bank.pickAck("thinking"), undefined);
});

test("pickAck skips phrases whose files are missing", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: [], thinking: ["let me look", "checking"], working: [] };
  cachePhrase(stateDir, "checking");

  const bank = new AckBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases, pickIndex: () => 0 });
  assert.equal(bank.pickAck("thinking"), phrasePath(stateDir, "checking", VOICE, MODEL));
});

test("refresh picks up files cached after the first scan", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: ["hey"], thinking: [], working: [] };

  const bank = new AckBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases, pickIndex: () => 0 });
  assert.equal(bank.pickAck("greeting"), undefined);

  cachePhrase(stateDir, "hey");
  bank.refresh();
  assert.ok(bank.pickAck("greeting"));
});

test("planBank counts exactly the characters of the missing phrases", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: ["hey"], thinking: ["let me look"], working: ["on it"] };
  cachePhrase(stateDir, "hey");

  const plan = planBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases });
  assert.deepEqual([...plan.toSynthesize].sort(), ["let me look", "on it"]);
  assert.equal(plan.characters, "let me look".length + "on it".length);
  assert.equal(plan.alreadyCached, 1);
});

test("planBank bills a phrase shared by two categories once", () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: [], thinking: ["one sec"], working: ["one sec"] };

  const plan = planBank({ stateDir, voiceId: VOICE, modelId: MODEL, phrases });
  assert.deepEqual(plan.toSynthesize, ["one sec"]);
  assert.equal(plan.characters, "one sec".length);
});

test("ensureBank spends nothing when everything is already on disk", async () => {
  const stateDir = freshStateDir();
  const phrases: BankPhrases = { greeting: ["hey"], thinking: ["checking"], working: ["on it"] };
  for (const p of ["hey", "checking", "on it"]) cachePhrase(stateDir, p);

  let reported: number | undefined;
  // A garbage key proves no request happens: a fetch would fail loudly.
  const result = await ensureBank({
    stateDir,
    voiceId: VOICE,
    modelId: MODEL,
    phrases,
    apiKey: "must-never-be-sent",
    onPlan: (plan) => {
      reported = plan.characters;
    },
  });

  assert.equal(reported, 0, "onPlan must report the spend before synthesis");
  assert.equal(result.synthesized, 0);
  assert.equal(result.plan.alreadyCached, 3);
});
