import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../embed/embedder.ts";
import { KeywordEmbedder } from "../embed/keyword.ts";
import { EmbedError } from "../embed/openai.ts";
import type { DecideContext, Decider } from "../extract/extractor.ts";
import { RulesDecider } from "../extract/rules.ts";
import { combineConfidence, mergeCandidates, postFilter, trimSentence } from "../merge.ts";
import { MemoryStore } from "../store.ts";
import type { Candidate, Decision, MemoryRow, Neighbour } from "../types.ts";
import { atCosine, clock, fresh, ids, T0 } from "./helpers.ts";

/**
 * The write path against pinned cosines: touch on the same words, newest-wins
 * UPDATE with `prev` on a reversal (never a silent touch), the decider in the
 * band, supersession on a contradiction, ADD below. Both threshold tables.
 */

const src = { at: T0, type: "heard" as const, sessionId: "A" };
const cand = (text: string, over: Partial<Candidate> = {}): Candidate => ({ kind: "preference", text, subjects: [], importance: 0.6, confidence: 0.7, evidence: [1], ...over });

class ScriptedDecider implements Decider {
  readonly kind = "responses" as const;
  readonly seen: { c: Candidate; n: Neighbour[] }[] = [];
  constructor(private readonly answer: Decision) {}
  async decide(c: Candidate, n: readonly Neighbour[], _ctx: DecideContext): Promise<Decision> {
    this.seen.push({ c, n: [...n] });
    return this.answer;
  }
}

function world(): { store: MemoryStore; rows: () => MemoryRow[] } {
  const dir = fresh();
  const store = new MemoryStore({ dir, now: clock().now, newId: ids() });
  store.load();
  return { store, rows: () => store.log.read().rows };
}

const TABLE = {
  "Kevin prefers dark mode": atCosine(1),
  "kevin prefers dark mode.": atCosine(1),
  "Kevin likes dark mode": atCosine(0.95),
  "Kevin prefers light mode": atCosine(0.92),
  "Kevin prefers dark mode in every editor": atCosine(0.8),
  "Kevin likes jazz while coding": atCosine(0.5),
  "Kevin's dentist is Dr. Patel": [0, 0, 1],
};

test("merge: the same words at ≥ update → touch (seenCount 2, confidence 1−(1−a)(1−b), importance max, no new id); one embed() call for the whole run", async () => {
  const { store } = world();
  const e = new FakeEmbedder({ table: TABLE });
  const first = await mergeCandidates(store, [cand("Kevin prefers dark mode", { confidence: 0.6, importance: 0.5 })], e, new RulesDecider(), { now: T0, source: src });
  assert.deepEqual([first.added, first.updated, first.noop], [1, 0, 0]);
  const again = await mergeCandidates(store, [cand("kevin prefers dark mode.", { confidence: 0.5, importance: 0.9, subjects: ["editor"] })], e, new RulesDecider(), { now: T0 + 1, source: { ...src, at: T0 + 1 } });
  assert.deepEqual([again.added, again.updated, again.noop], [0, 0, 1]);
  const it = store.items("live");
  assert.equal(it.length, 1);
  assert.equal(it[0]!.seenCount, 2);
  assert.equal(it[0]!.text, "Kevin prefers dark mode", "the words stay as first said");
  assert.ok(Math.abs(it[0]!.confidence - combineConfidence(0.6, 0.5)) < 1e-9);
  assert.equal(it[0]!.importance, 0.9);
  assert.deepEqual(it[0]!.subjects, ["editor"]);
  assert.equal(e.calls.length, 1, "the second run's words share the sha with the first: a cache hit, no embedder call");
});

test("merge: a paraphrase at 0.95 and a reversal at 0.92 both land as UPDATE with the new words and prev.text in the log — never a silent touch; the paraphrase folds evidence, the reversal restarts it", async () => {
  const { store, rows } = world();
  const e = new FakeEmbedder({ table: TABLE });
  await mergeCandidates(store, [cand("Kevin prefers dark mode", { confidence: 0.6 })], e, new RulesDecider(), { now: T0, source: src });
  const r1 = await mergeCandidates(store, [cand("Kevin likes dark mode", { confidence: 0.6 })], e, new RulesDecider(), { now: T0, source: src });
  assert.deepEqual([r1.added, r1.updated, r1.noop], [0, 1, 0]);
  const same = store.items("live")[0]!;
  assert.equal(same.text, "Kevin likes dark mode");
  assert.equal(same.seenCount, 2, "the same thing said again: evidence folds");
  assert.ok(Math.abs(same.confidence - combineConfidence(0.6, 0.6)) < 1e-9);
  const r2 = await mergeCandidates(store, [cand("Kevin prefers light mode", { confidence: 0.7 })], e, new RulesDecider(), { now: T0 + 5, source: { ...src, at: T0 + 5 } });
  assert.deepEqual([r2.added, r2.updated, r2.noop], [0, 1, 0]);
  const live = store.items("live");
  assert.equal(live.length, 1, "one item, not a twin");
  assert.equal(live[0]!.text, "Kevin prefers light mode");
  assert.equal(live[0]!.seenCount, 1, "a reversal is one utterance for the new words: not a thrice-confirmed fact");
  assert.equal(live[0]!.confidence, 0.7, "the candidate's confidence, not 1 − (1−a)(1−b)(1−c)");
  assert.equal(live[0]!.lastSeenAt, T0 + 100_000, "seen now (the store's clock), as any update with a source");
  assert.equal(live[0]!.sources.length, 3, "the trail of where things were said stays");
  const updates = rows().filter((r): r is Extract<MemoryRow, { op: "update" }> => r.op === "update");
  assert.deepEqual(updates.map((u) => u.prev?.text), ["Kevin prefers dark mode", "Kevin likes dark mode"]);
  assert.deepEqual(updates.map((u) => u.replaces ?? false), [false, true], "the log says which update was a reversal");
});

test("merge: when a comparison falls back to words (an un-embedded neighbour, withVectors:false) the keyword table decides, not the embedder's cosine table — a 0.75 word overlap updates instead of adding a twin", async () => {
  const { store } = world();
  const e = new FakeEmbedder({ table: TABLE }); // openai thresholds {0.90, 0.75, 0.93}
  const d = new RulesDecider();
  // "Kevin prefers short answers" → {like, short, answer}; "Kevin prefers short spoken answers" → {like, short, spoken, answer}: Jaccard 0.75
  const first = await mergeCandidates(store, [cand("Kevin prefers short answers")], e, d, { now: T0, source: src, withVectors: false });
  assert.equal(first.added, 1);
  assert.equal(store.vectorFor(first.addedIds[0]!, e), undefined, "landed by words");
  const r = await mergeCandidates(store, [cand("Kevin prefers short spoken answers")], e, d, { now: T0, source: src, withVectors: false });
  assert.deepEqual([r.added, r.updated, r.noop], [0, 1, 0], "0.75 is the openai band (→ ADD in rules mode) but the keyword update lane: the words decide on their own scale");
  assert.equal(store.items("live").length, 1);
  assert.equal(store.items("live")[0]!.text, "Kevin prefers short spoken answers");
  // the same pair with the neighbour embedded but the candidate landing by words is still a text comparison
  const { store: s2 } = world();
  await mergeCandidates(s2, [cand("Kevin prefers short answers")], e, d, { now: T0, source: src });
  const mixed = await mergeCandidates(s2, [cand("Kevin prefers short spoken answers")], e, d, { now: T0, source: src, withVectors: false });
  assert.deepEqual([mixed.added, mixed.updated, mixed.noop], [0, 1, 0]);
  // below the keyword band a different fact stays a different fact
  const { store: s3 } = world();
  await mergeCandidates(s3, [cand("Kevin prefers short answers")], e, d, { now: T0, source: src, withVectors: false });
  const apart = await mergeCandidates(s3, [cand("Kevin wants answers in English")], e, d, { now: T0, source: src, withVectors: false });
  assert.equal(apart.added, 1);
});

test("merge: in the band (0.80) the decider rules — ADD adds, UPDATE with merged text replaces, NOOP touches, contradicts supersedes (old merged with mergedInto, new carries supersedes)", async () => {
  const e = new FakeEmbedder({ table: TABLE });
  const seed = async (): Promise<{ store: MemoryStore; id: string }> => {
    const { store } = world();
    const r = await mergeCandidates(store, [cand("Kevin prefers dark mode")], e, new RulesDecider(), { now: T0, source: src });
    return { store, id: r.addedIds[0]! };
  };
  const c = cand("Kevin prefers dark mode in every editor");

  const a = await seed();
  const add = new ScriptedDecider({ op: "ADD", contradicts: false });
  const ra = await mergeCandidates(a.store, [c], e, add, { now: T0, source: src });
  assert.deepEqual([ra.added, ra.updated, ra.noop], [1, 0, 0]);
  assert.equal(a.store.items("live").length, 2);
  assert.ok(Math.abs(add.seen[0]!.n[0]!.sim - 0.8) < 1e-6, "the decider saw the neighbour and its similarity");

  const u = await seed();
  const ru = await mergeCandidates(u.store, [c], e, new ScriptedDecider({ op: "UPDATE", target: "A", text: "Kevin prefers dark mode everywhere." }), { now: T0, source: src });
  assert.deepEqual([ru.added, ru.updated, ru.noop], [0, 1, 0]);
  assert.equal(u.store.get(u.id)!.text, "Kevin prefers dark mode everywhere.", "an unknown target letter falls back to the top neighbour");

  const n = await seed();
  const rn = await mergeCandidates(n.store, [c], e, new ScriptedDecider({ op: "NOOP" }), { now: T0, source: src });
  assert.deepEqual([rn.added, rn.updated, rn.noop], [0, 0, 1]);
  assert.equal(n.store.get(n.id)!.seenCount, 2);
  assert.equal(n.store.get(n.id)!.text, "Kevin prefers dark mode");

  const x = await seed();
  const rx = await mergeCandidates(x.store, [c], e, new ScriptedDecider({ op: "ADD", target: x.id, contradicts: true }), { now: T0, source: src });
  assert.deepEqual([rx.added, rx.updated, rx.noop], [1, 0, 0]);
  const old = x.store.get(x.id)!;
  const fresh_ = x.store.get(rx.addedIds[0]!)!;
  assert.equal(old.state, "merged");
  assert.equal(old.mergedInto, fresh_.id);
  assert.deepEqual(fresh_.supersedes, [x.id]);
  assert.equal(fresh_.seenCount, 1, "a supersession does not inherit the old count");
  assert.equal(x.store.items("live").length, 1);
});

test("merge: below the band (0.50) and across incompatible kinds → ADD; two near-identical candidates in one batch collapse to one add + one touch", async () => {
  const { store } = world();
  const e = new FakeEmbedder({ table: TABLE });
  await mergeCandidates(store, [cand("Kevin prefers dark mode")], e, new RulesDecider(), { now: T0, source: src });
  const r = await mergeCandidates(store, [cand("Kevin likes jazz while coding"), cand("Kevin's dentist is Dr. Patel", { kind: "contact" })], e, new RulesDecider(), { now: T0, source: src });
  assert.deepEqual([r.added, r.updated, r.noop], [2, 0, 0]);
  const { store: s2 } = world();
  const batch = await mergeCandidates(s2, [cand("Kevin prefers dark mode"), cand("kevin prefers dark mode.")], e, new RulesDecider(), { now: T0, source: src });
  assert.deepEqual([batch.added, batch.updated, batch.noop], [1, 0, 1]);
  assert.equal(e.calls[e.calls.length - 1]!.length, 1, "identical words share one sha: one text in the one call");
  assert.equal(s2.items("live")[0]!.seenCount, 2);
  const { store: s4 } = world();
  const pair = await mergeCandidates(s4, [cand("Kevin prefers dark mode"), cand("Kevin likes dark mode")], e, new RulesDecider(), { now: T0, source: src });
  assert.deepEqual([pair.added, pair.updated, pair.noop], [1, 1, 0], "a paraphrase later in the same batch updates the item added earlier in it");
  assert.equal(e.calls[e.calls.length - 1]!.length, 2, "both texts in the one call");
  assert.equal(s4.items("live").length, 1);
  const { store: s3 } = world();
  await mergeCandidates(s3, [cand("Kevin prefers dark mode", { kind: "episode" })], e, new RulesDecider(), { now: T0, source: src });
  const cross = await mergeCandidates(s3, [cand("Kevin prefers dark mode", { kind: "preference" })], e, new RulesDecider(), { now: T0, source: src });
  assert.equal(cross.added, 1, "an episode and a preference are never the same item");
});

test("merge: under the keyword table (no key) paraphrases collapse the same way — 'prefers' ≈ 'likes' updates, a reversal updates with prev, unrelated adds", async () => {
  const { store, rows } = world();
  const e = new KeywordEmbedder();
  const d = new RulesDecider();
  await mergeCandidates(store, [cand("Kevin prefers dark mode")], e, d, { now: T0, source: src });
  const r1 = await mergeCandidates(store, [cand("Kevin likes dark mode")], e, d, { now: T0, source: src });
  assert.deepEqual([r1.added, r1.updated, r1.noop], [0, 1, 0]);
  const r2 = await mergeCandidates(store, [cand("Kevin prefers light mode")], e, d, { now: T0, source: src });
  assert.deepEqual([r2.added, r2.updated, r2.noop], [0, 1, 0]);
  assert.equal(store.items("live").length, 1);
  assert.equal(store.items("live")[0]!.text, "Kevin prefers light mode");
  assert.equal(rows().filter((r) => r.op === "update").length, 2);
  const r3 = await mergeCandidates(store, [cand("Kevin's dentist is Dr. Patel", { kind: "contact" })], e, d, { now: T0, source: src });
  assert.equal(r3.added, 1);
  assert.equal(store.cache.size, 0, "keyword mode stores no vectors");
  const same = await mergeCandidates(store, [cand("kevin prefers light mode.")], e, d, { now: T0, source: src });
  assert.deepEqual([same.added, same.updated, same.noop], [0, 0, 1]);
});

test("merge: an embedding failure throws before anything is written; withVectors:false lands items without a vector (matched by words)", async () => {
  const { store } = world();
  let fail = true;
  const e = new FakeEmbedder({ table: TABLE, fail: () => (fail ? new EmbedError("http", "429", 429) : undefined) });
  const lines = store.lineCount;
  await assert.rejects(mergeCandidates(store, [cand("Kevin prefers dark mode")], e, new RulesDecider(), { now: T0, source: src }), (err: unknown) => err instanceof EmbedError);
  assert.equal(store.lineCount, lines, "nothing written");
  const r = await mergeCandidates(store, [cand("Kevin prefers dark mode")], e, new RulesDecider(), { now: T0, source: src, withVectors: false });
  assert.equal(r.added, 1);
  assert.equal(store.vectorFor(r.addedIds[0]!, e), undefined);
  fail = false;
  const again = await mergeCandidates(store, [cand("Kevin likes dark mode")], e, new RulesDecider(), { now: T0, source: src });
  assert.deepEqual([again.added, again.updated, again.noop], [0, 1, 0], "the vector-less item still matches by its words");
});

test("postFilter: importance 1..5 becomes 0..1, over-long text is cut at a sentence end or refused, evidence must cite a Kevin line, refusal shapes refuse", () => {
  const kevin = new Set([1, 3]);
  const ok = postFilter(cand("Kevin goes by Kev.", { importance: 5, confidence: 0.9, evidence: [1], subjects: ["Name", "name"] }), { kevinLines: kevin });
  assert.ok("ok" in ok);
  assert.equal(ok.ok.importance, 1);
  assert.deepEqual(ok.ok.subjects, ["name"]);
  const jarheadOnly = postFilter(cand("Kevin is tired.", { evidence: [2] }), { kevinLines: kevin });
  assert.deepEqual(jarheadOnly, { refused: "no Kevin line cited" });
  const long = postFilter(cand(`How Kevin likes it done: ${"read the diff carefully. ".repeat(12)}`, { evidence: [1] }), { kevinLines: kevin });
  assert.ok("ok" in long && long.ok.text.length <= 200 && long.ok.text.endsWith("."));
  const unbreakable = postFilter(cand("x".repeat(250), { evidence: [1] }), { kevinLines: kevin });
  assert.deepEqual(unbreakable, { refused: "over 200 chars" });
  assert.deepEqual(postFilter(cand("Kevin's card is 4111 1111 1111 1111", { evidence: [1] }), { kevinLines: kevin }), { refused: "card number" });
  assert.deepEqual(postFilter(cand("Kevin's SSN is 123-45-6789", { evidence: [1] }), { kevinLines: kevin }), { refused: "SSN" });
  assert.deepEqual(postFilter(cand("Kevin's password is hunter22", { evidence: [1] }), { kevinLines: kevin }), { refused: "password" });
  assert.deepEqual(postFilter(cand("Kevin said [redacted secret]", { evidence: [1] }), { kevinLines: kevin }), { refused: "redacted secret" });
  assert.ok("ok" in postFilter(cand("Kevin prefers dark mode", { evidence: [] }), { requireEvidence: false }), "an explicit remember has no transcript");
  assert.equal(trimSentence("short"), "short");
  assert.equal(trimSentence("a".repeat(30) + ". " + "b".repeat(200)), "a".repeat(30) + ".");
});
