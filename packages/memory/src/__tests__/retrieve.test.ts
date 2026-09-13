import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder, hashVector } from "../embed/embedder.ts";
import { KeywordEmbedder, keywordSimilarity, tokens } from "../embed/keyword.ts";
import { baseScore, importanceFactor, isPinned, recency, retrieve, SCORE_FLOOR, seenFactor } from "../retrieve.ts";
import { estimateTokens } from "../tokens.ts";
import { l2normalize } from "../vec.ts";
import { atCosine, item, T0 } from "./helpers.ts";

/**
 * The formula, numerically; the pinned lane; MMR; the floor; the budget.
 * Deterministic: ties break by id.
 */

const DAY = 86_400_000;

test("score: an episode last seen 30 days ago has recency 0.5 and 60 days 0.25; facts halve at 180 d; a preference never decays; importance 0 still scores (0.5); seen 6× → 1.5, capped", () => {
  const ep = item({ id: "e", text: "Kevin shipped auth", kind: "episode", lastSeenAt: T0 });
  assert.ok(Math.abs(recency(ep, T0 + 30 * DAY) - 0.5) < 1e-9);
  assert.ok(Math.abs(recency(ep, T0 + 60 * DAY) - 0.25) < 1e-9);
  assert.ok(Math.abs(recency(item({ id: "f", text: "x", kind: "fact", lastSeenAt: T0 }), T0 + 180 * DAY) - 0.5) < 1e-9);
  assert.ok(Math.abs(recency(item({ id: "c", text: "x", kind: "contact", lastSeenAt: T0 }), T0 + 365 * DAY) - 0.5) < 1e-9);
  assert.equal(recency(item({ id: "p", text: "x", kind: "preference", lastSeenAt: T0 }), T0 + 5000 * DAY), 1);
  assert.equal(recency(item({ id: "q", text: "x", kind: "procedure", lastSeenAt: T0 }), T0 + 5000 * DAY), 1);
  assert.equal(importanceFactor(item({ id: "i", text: "x", importance: 0 })), 0.5);
  assert.equal(importanceFactor(item({ id: "i", text: "x", importance: 1 })), 1);
  assert.equal(seenFactor(item({ id: "s", text: "x", seenCount: 1 })), 1);
  assert.ok(Math.abs(seenFactor(item({ id: "s", text: "x", seenCount: 6 })) - 1.5) < 1e-9);
  assert.ok(Math.abs(seenFactor(item({ id: "s", text: "x", seenCount: 60 })) - 1.5) < 1e-9);
  const full = item({ id: "z", text: "x", kind: "preference", importance: 1, confidence: 0.8, seenCount: 3 });
  assert.ok(Math.abs(baseScore(full, T0) - 1 * 1 * 0.8 * 1.2) < 1e-9);
});

test("pinned lane: strong preferences/procedures seen twice or asked for are always in, with no query, and take at most 40 % of the budget; ties by id", () => {
  const e = new KeywordEmbedder();
  const pins = Array.from({ length: 12 }, (_, i) => item({ id: `p${String(i).padStart(2, "0")}`, text: `Kevin prefers option number ${i} for everything he does`, kind: "preference", importance: 0.9, seenCount: 2 }));
  const asked = item({ id: "a1", text: "Kevin goes by Kev", kind: "preference", importance: 0.8, seenCount: 1, origin: "kevin" });
  const weak = item({ id: "w1", text: "Kevin likes jazz", kind: "preference", importance: 0.5, seenCount: 5 });
  const fact = item({ id: "f1", text: "Kevin's dentist is Dr. Patel", kind: "contact", importance: 0.9, seenCount: 4 });
  assert.ok(isPinned(asked));
  assert.ok(!isPinned(weak));
  assert.ok(!isPinned(fact));
  const r = retrieve([...pins, asked, weak, fact], { embedder: e, now: T0, budgetTokens: 120 });
  const pinnedCost = r.picked.slice(0, r.pinned).reduce((n, it) => n + estimateTokens(it.text) + 1, 0);
  assert.ok(pinnedCost <= 48, `pinned lane ${pinnedCost} tokens > 40 % of 120`);
  assert.ok(r.pinned >= 2 && r.pinned < pins.length + 1, "some pins had to wait");
  assert.ok(r.picked.slice(0, r.pinned).some((it) => it.id === "a1") || r.picked.some((it) => it.id === "a1"));
  assert.ok(r.tokens <= 120);
  const ids = r.picked.slice(0, r.pinned).map((it) => it.id).filter((id) => id.startsWith("p"));
  assert.deepEqual(ids, [...ids].sort(), "equal pins come in id order");
  assert.equal(r.picked[r.pinned - 1]?.id, "a1", "the asked-for item scores under the twice-seen ones and comes last of the pins");
});

test("query lane: MMR (λ 0.7) ranks a diverse item of close relevance above an exact twin of the top pick; the floor 0.12 drops unrelated items; the result strips vectors", () => {
  const e = new FakeEmbedder({ table: {}, dims: 3 });
  const q = l2normalize(Float32Array.from([1, 0, 0]));
  const tv = l2normalize(Float32Array.from([0.8, 0.6, 0]));
  const top = { ...item({ id: "t", text: "Kevin prefers dark mode", kind: "fact", importance: 0.8, confidence: 0.9 }), vec: tv };
  const twin = { ...item({ id: "u", text: "Kevin likes dark mode", kind: "fact", importance: 0.8, confidence: 0.9 }), vec: tv };
  const diverse = { ...item({ id: "d", text: "Kevin's dentist is Dr. Patel", kind: "fact", importance: 0.8, confidence: 0.9 }), vec: l2normalize(Float32Array.from([0.75, -0.4, 0.527])) };
  const far = { ...item({ id: "x", text: "Kevin's office is in SoMa", kind: "fact", importance: 0.2, confidence: 0.5 }), vec: l2normalize(Float32Array.from([0, 0, 1])) };
  const r = retrieve([far, twin, diverse, top], { query: { text: "dark mode", vec: q }, embedder: e, now: T0, budgetTokens: 100 });
  assert.deepEqual(r.picked.map((i) => i.id), ["t", "d", "u"], "top first (id order between equals), then the diverse item, the twin last");
  assert.ok(!("vec" in r.picked[0]!), "no vector leaves retrieve()");
  assert.ok(!JSON.stringify(r.picked).includes("vec"));
  assert.ok(!r.picked.some((i) => i.id === "x"), "cosine 0 × anything is under the floor");
  const tight = retrieve([far, twin, diverse, top], { query: { text: "dark mode", vec: q }, embedder: e, now: T0, budgetTokens: 20 });
  assert.deepEqual(tight.picked.map((i) => i.id), ["t", "d"], "with room for two, the twin is the one left out");
});

test("budget: the picked texts never exceed the budget (chars / 3.2 + a newline each), items that do not fit are skipped for smaller ones, and equal scores come in id order", () => {
  const e = new KeywordEmbedder();
  const items = Array.from({ length: 60 }, (_, i) => item({ id: `m_${String(i).padStart(3, "0")}`, text: `Kevin's fact number ${i} about his world and the way it works`, kind: "fact", importance: 0.6, confidence: 0.8, lastSeenAt: T0 }));
  const r = retrieve(items, { embedder: e, now: T0, budgetTokens: 250 });
  assert.ok(r.tokens <= 250, `${r.tokens} > 250`);
  assert.equal(r.tokens, r.picked.reduce((n, it) => n + estimateTokens(it.text) + 1, 0));
  assert.deepEqual(r.picked.map((i) => i.id), [...r.picked.map((i) => i.id)].sort(), "ties by id");
  const tiny = item({ id: "m_zzz", text: "Kevin is Kev", kind: "fact", importance: 0.6, confidence: 0.8, lastSeenAt: T0 });
  const r2 = retrieve([...items, tiny], { embedder: e, now: T0, budgetTokens: 250 });
  assert.ok(r2.picked.some((i) => i.id === "m_zzz"), "a short item fills what a long one could not");
  assert.ok(r2.tokens <= 250);
  const voice = retrieve(items, { embedder: e, now: T0, budgetTokens: 120 });
  assert.ok(voice.tokens <= 120);
  assert.deepEqual(retrieve([], { embedder: e, now: T0, budgetTokens: 250 }).picked, []);
  assert.deepEqual(retrieve([item({ id: "g", text: "gone", state: "forgotten" }), item({ id: "h", text: "old", state: "archived" })], { embedder: e, now: T0, budgetTokens: 250 }).picked, [], "only live items");
});

test("query lane by words: a realistic delegation query (request + Kevin's recent lines, ≥ 25 content tokens) against a keyword store surfaces the relevant procedure and not the dentist — Jaccard would have left the block empty", () => {
  const e = new KeywordEmbedder();
  const items = [
    item({ id: "kev", text: "Kevin goes by Kev", kind: "fact", importance: 1, confidence: 0.9 }),
    item({ id: "short", text: "Kevin prefers short answers", kind: "preference", importance: 0.6, confidence: 0.7 }),
    item({ id: "dentist", text: "Kevin's dentist is Dr. Patel", kind: "contact", importance: 0.6, confidence: 0.7 }),
    item({ id: "diff", text: "How Kevin likes it done: read the diff before saying a PR is fine", kind: "procedure", importance: 0.8, confidence: 0.8 }),
    item({ id: "dark", text: "Kevin likes dark mode", kind: "preference", importance: 0.6, confidence: 0.7 }),
    item({ id: "english", text: "Kevin wants answers in English", kind: "preference", importance: 1, confidence: 0.9 }),
    item({ id: "office", text: "Kevin's office is in SoMa", kind: "place", importance: 0.6, confidence: 0.7 }),
    item({ id: "barber", text: "Kevin's barber is Tony", kind: "contact", importance: 0.6, confidence: 0.7 }),
  ];
  const request = "open the pull request for the auth work, read through the diff and tell me if the PR is fine, then push it if it is";
  const kevinRecent = ["okay so I merged the feature branch this morning and the CI was green", "I'd like you to open the pull request for the auth work and read through the diff", "then tell me if the PR is fine and push it if it is", "also the standup moved to ten so keep the summary short"].join("\n");
  const query = `${request}\n${kevinRecent}`;
  assert.ok(tokens(query).size >= 25, `query has ${tokens(query).size} content tokens`);
  const jaccardScore = keywordSimilarity(query, items[3]!.text) * baseScore(items[3]!, T0);
  assert.ok(jaccardScore < SCORE_FLOOR, `Jaccard × base = ${jaccardScore.toFixed(3)} sits under the floor ${SCORE_FLOOR} for the relevant item — the old dead lane`);
  const r = retrieve(items, { query: { text: query }, embedder: e, now: T0, budgetTokens: 250 });
  const ids = r.picked.map((i) => i.id);
  assert.ok(ids.includes("diff"), `the procedure about diffs and PRs must be in the block; got ${ids.join(",")}`);
  assert.ok(ids.includes("short"), "'keep the summary short' reaches the short-answers preference");
  assert.ok(!ids.includes("dentist") && !ids.includes("barber") && !ids.includes("office"), "nothing the query does not mention");
  assert.ok(!ids.includes("dark"), "'I'd like' alone does not drag in every preference: 'like' is in most items and weighs little");
  assert.equal(r.pinned, 0, "none of these is pinned (seen once, not asked for): the query lane did the work");

  // the same store under a vector embedder with the query vector withheld (the race was lost): the same words path, the same answer
  const fake = new FakeEmbedder();
  const vectored = items.map((it) => ({ ...it, vec: hashVector(it.text, fake.dims) }));
  const lost = retrieve(vectored, { query: { text: query }, embedder: fake, now: T0, budgetTokens: 250 });
  assert.ok(lost.picked.some((i) => i.id === "diff"), "a lost embedding race still ranks by words");
  assert.ok(!lost.picked.some((i) => i.id === "dentist"));
});
