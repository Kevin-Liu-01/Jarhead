import { test } from "node:test";
import assert from "node:assert/strict";
import { EmbeddingCache } from "../embed/cache.ts";
import { compare, FakeEmbedder, querySimilarityOf, similarityOf, thresholdsFor } from "../embed/embedder.ts";
import { KeywordEmbedder, keywordQuerySimilarity, keywordSimilarity, stem, tokenWeights } from "../embed/keyword.ts";
import { KEYWORD_THRESHOLDS } from "../limits.ts";
import { EmbedError, OpenAIEmbedder } from "../embed/openai.ts";
import { cosine, fromBase64, l2normalize, toBase64 } from "../vec.ts";
import { atCosine, fakeFetch, jsonResponse } from "./helpers.ts";

/**
 * Embedders: the OpenAI one batches, retries once and fails loudly (the service
 * defers); the keyword one has no vectors and its own thresholds; the fake one
 * pins cosines for the merge tests. Vectors round-trip through base64 exactly.
 */

function embeddingsBody(input: readonly string[], dims: number, shuffle = false): unknown {
  const data = input.map((_, i) => ({ object: "embedding", index: i, embedding: Array.from({ length: dims }, (__, k) => (k === i % dims ? 1 : 0.001 * i)) }));
  return { object: "list", data: shuffle ? [...data].reverse() : data, model: "text-embedding-3-small", usage: { prompt_tokens: 10, total_tokens: 10 } };
}

test("openai embedder: ≤ 96 texts per call, dimensions 512 and the model in the body, bearer auth from the getter, order preserved when the server answers out of order", async () => {
  const ff = fakeFetch((call) => jsonResponse(embeddingsBody((call.body as { input: string[] }).input, 512, true)));
  const e = new OpenAIEmbedder({ apiKey: () => "sk-test-key", fetchImpl: ff.fetch, backoffMs: 0 });
  const texts = Array.from({ length: 200 }, (_, i) => `text ${i}`);
  const vecs = await e.embed(texts);
  assert.equal(ff.calls.length, 3);
  assert.deepEqual(ff.calls.map((c) => (c.body as { input: string[] }).input.length), [96, 96, 8]);
  const body = ff.calls[0]!.body as Record<string, unknown>;
  assert.equal(body["model"], "text-embedding-3-small");
  assert.equal(body["dimensions"], 512);
  assert.equal(ff.calls[0]!.url, "https://api.openai.com/v1/embeddings");
  assert.equal(ff.calls[0]!.headers["authorization"], "Bearer sk-test-key");
  assert.equal(vecs.length, 200);
  // text i sits at position i % 96 of its batch and the fake puts its 1 there: the reversed answer was put back by `index`
  assert.ok(vecs[5]![5]! > 0.9);
  assert.ok(vecs[100]![100 % 96]! > 0.9);
  assert.ok(vecs[199]![199 % 96]! > 0.9);
  assert.ok(Math.abs(cosine(vecs[0]!, vecs[0]!) - 1) < 1e-6, "unit length");
});

test("openai embedder: no key throws no-key without a call; 429 then 200 is one retry; 429 twice throws http; a hung server times out", async () => {
  const none = fakeFetch(() => jsonResponse({}));
  await assert.rejects(new OpenAIEmbedder({ apiKey: () => undefined, fetchImpl: none.fetch }).embed(["x"]), (e: unknown) => e instanceof EmbedError && e.code === "no-key");
  assert.equal(none.calls.length, 0);

  const once = fakeFetch((call, n) => (n === 1 ? jsonResponse({ error: { message: "rate" } }, 429) : jsonResponse(embeddingsBody((call.body as { input: string[] }).input, 8))));
  const v = await new OpenAIEmbedder({ apiKey: () => "k", fetchImpl: once.fetch, dims: 8, backoffMs: 0 }).embed(["a"]);
  assert.equal(once.calls.length, 2);
  assert.equal(v[0]!.length, 8);

  const twice = fakeFetch(() => jsonResponse({}, 503));
  await assert.rejects(new OpenAIEmbedder({ apiKey: () => "k", fetchImpl: twice.fetch, dims: 8, backoffMs: 0 }).embed(["a"]), (e: unknown) => e instanceof EmbedError && e.code === "http" && e.status === 503);
  assert.equal(twice.calls.length, 2, "exactly one retry");

  const hung = fakeFetch((_call) => new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new Error("aborted")), 50)));
  await assert.rejects(new OpenAIEmbedder({ apiKey: () => "k", fetchImpl: hung.fetch, dims: 8, timeoutMs: 10, backoffMs: 0 }).embed(["a"]), (e: unknown) => e instanceof EmbedError && e.code === "timeout");
});

test("vectors: base64 float32 round trip is exact; the cache sha is stable under whitespace, case and trailing punctuation", () => {
  const v = l2normalize(Float32Array.from([0.1, -0.2, 0.3, 0.4, -0.5]));
  const back = fromBase64(toBase64(v));
  assert.deepEqual([...back], [...v]);
  assert.equal(EmbeddingCache.sha("Kevin goes by Kev"), EmbeddingCache.sha("  kevin   goes by Kev. "));
  assert.notEqual(EmbeddingCache.sha("Kevin goes by Kev"), EmbeddingCache.sha("Kevin goes by Kevin"));
});

test("keyword embedder: no vectors, Jaccard over stemmed folded tokens — identical 1.0, paraphrase ≥ 0.6, a reversal in the band, different facts apart, unrelated < 0.3", async () => {
  const e = new KeywordEmbedder();
  assert.equal(e.dims, 0);
  assert.deepEqual(e.thresholds, { update: 0.6, band: 0.4, dup: 0.7 });
  const vs = await e.embed(["a", "b"]);
  assert.equal(vs[0]!.length, 0);
  assert.equal(keywordSimilarity("Kevin prefers short answers", "Kevin prefers short answers."), 1);
  assert.ok(keywordSimilarity("Kevin prefers dark mode", "Kevin likes dark mode") >= 0.6, "prefers ≈ likes");
  assert.ok(keywordSimilarity("Kevin prefers short answers", "Kevin likes his answers brief") >= 0.6);
  const rev = keywordSimilarity("Kevin prefers dark mode", "Kevin prefers light mode");
  assert.ok(rev >= 0.4 && rev < 0.6, `a reversal (${rev}) sits in the band, where the rules decider's antonym rule reads it`);
  assert.ok(keywordSimilarity("Kevin prefers short answers", "Kevin wants answers in English") < 0.4, "two different facts about answers stay apart");
  assert.ok(keywordSimilarity("Kevin prefers dark mode", "Kevin's dentist is Dr. Patel") < 0.3);
  assert.equal(stem("prefers"), "prefer");
  assert.equal(stem("answers"), "answer");
  assert.equal(stem("policies"), "policy");
  assert.equal(stem("reading"), "read");
});

test("fake embedder: a table pins exact cosines; texts outside the table hash their tokens deterministically; similarityOf falls back to words when a vector is missing", async () => {
  const e = new FakeEmbedder({ table: { "Kevin prefers dark mode": atCosine(1), "Kevin likes dark mode": atCosine(0.95), "Kevin prefers light mode": atCosine(0.92) }, dims: 3 });
  const [a, b, c] = await e.embed(["Kevin prefers dark mode", "kevin likes dark mode.", "Kevin prefers light mode"]);
  assert.ok(Math.abs(e.similarity(a!, b!) - 0.95) < 1e-6);
  assert.ok(Math.abs(e.similarity(a!, c!) - 0.92) < 1e-6);
  const h = new FakeEmbedder();
  const [x1, x2, y] = await h.embed(["Kevin prefers dark mode", "Kevin prefers dark mode", "Kevin's dentist is Dr. Patel"]);
  assert.deepEqual([...x1!], [...x2!]);
  assert.ok(h.similarity(x1!, y!) < 0.3);
  assert.equal(h.calls.length, 1);
  assert.equal(similarityOf(h, { text: "Kevin prefers dark mode", vec: x1 }, { text: "Kevin prefers dark mode." }), 1, "words when one side has no vector");
  const failing = new FakeEmbedder({ fail: () => new EmbedError("http", "429", 429) });
  await assert.rejects(failing.embed(["x"]), (err: unknown) => err instanceof EmbedError);
});

test("query similarity is coverage of the item, weighted against words most items share; compare() names the space so words are judged by the keyword table", () => {
  const q = "open the pull request for the auth work, read through the diff and tell me if the PR is fine, then push it";
  const proc = "How Kevin likes it done: read the diff before saying a PR is fine";
  assert.ok(keywordSimilarity(q, proc) < 0.3, `symmetric overlap punishes the long query: Jaccard ${keywordSimilarity(q, proc).toFixed(2)}`);
  assert.ok(keywordQuerySimilarity(q, proc) >= 0.5, `coverage ${keywordQuerySimilarity(q, proc).toFixed(2)}: four of the item's eight words are in the query`);
  assert.ok(keywordQuerySimilarity(q, proc) > 2 * keywordSimilarity(q, proc), "coverage does not pay for the query's length");
  assert.equal(keywordQuerySimilarity("Kevin prefers short answers", "Kevin likes his answers brief"), 1, "the query says everything the item says");
  assert.equal(keywordQuerySimilarity("", proc), 0);
  assert.equal(keywordQuerySimilarity(q, "the and of"), 0, "an item of stop words matches nothing");
  const weight = tokenWeights(["Kevin likes dark mode", "Kevin prefers short answers", "Kevin likes jazz", "Kevin's dentist is Dr. Patel"]);
  assert.equal(weight("dentist"), 1, "a word one item carries counts fully");
  assert.ok(weight("like") < 0.5, `'like' is in three of four items: ${weight("like").toFixed(2)}`);
  assert.ok(keywordQuerySimilarity("I'd like you to open the diff", "Kevin likes dark mode", weight) < keywordQuerySimilarity("I'd like you to open the diff", "Kevin likes dark mode"), "a shared verb weighs less than a rare noun");
  const e = new FakeEmbedder({ dims: 3 });
  const a = { text: "Kevin prefers short answers", vec: l2normalize(Float32Array.from([1, 0, 0])) };
  const b = { text: "Kevin prefers short spoken answers", vec: l2normalize(Float32Array.from([0.8, 0.6, 0])) };
  const vec = compare(e, a, b);
  assert.equal(vec.space, "vector");
  assert.ok(Math.abs(vec.sim - 0.8) < 1e-6);
  const words = compare(e, a, { text: b.text });
  assert.equal(words.space, "text");
  assert.equal(words.sim, 0.75);
  assert.deepEqual(thresholdsFor(e, "text"), KEYWORD_THRESHOLDS);
  assert.deepEqual(thresholdsFor(e, "vector"), e.thresholds);
  assert.deepEqual(thresholdsFor(e, undefined), e.thresholds);
  assert.ok(Math.abs(querySimilarityOf(e, a, b) - 0.8) < 1e-6, "both vectors: cosine");
  assert.equal(querySimilarityOf(e, { text: a.text }, b), 0.75, "no query vector: coverage of the item's words — 'short answers' says three of the item's four");
  assert.equal(querySimilarityOf(e, { text: b.text }, a), 1, "and the longer text as the query says everything the shorter item says");
  assert.equal(new KeywordEmbedder().similarityQuery(q, proc), keywordQuerySimilarity(q, proc));
});
