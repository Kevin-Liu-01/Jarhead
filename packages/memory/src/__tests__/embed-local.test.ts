import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedError } from "../embed/errors.ts";
import { LOCAL_THRESHOLDS, LocalEmbedder, localThresholdsFor } from "../embed/local.ts";
import { MemoryStore } from "../store.ts";
import { cosine } from "../vec.ts";
import { fakeFetch, fresh, ids, jsonResponse, T0 } from "./helpers.ts";

/**
 * The local embedder: Ollama's /api/embed matrix and the OpenAI-shaped
 * /v1/embeddings of LM Studio and llama.cpp, dims measured by the probe and
 * enforced after, 64 per request in order, unit vectors, one retry on 5xx,
 * and the codes the service defers on — never `no-key`, because nothing on
 * this Mac asks for one.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** A vector of `dims` with a 1 at position i (so order is visible) and a tiny tail. */
function unitAt(i: number, dims: number): number[] {
  return Array.from({ length: dims }, (_, k) => (k === i % dims ? 1 : 0.0001 * (i + 1)));
}

function ollamaBody(input: readonly string[], dims: number): unknown {
  return { model: "nomic-embed-text", embeddings: input.map((_, i) => unitAt(i, dims)), total_duration: 1, load_duration: 1, prompt_eval_count: input.length };
}

function openaiBody(input: readonly string[], dims: number, reverse = false): unknown {
  const data = input.map((_, i) => ({ object: "embedding", index: i, embedding: unitAt(i, dims) }));
  return { object: "list", data: reverse ? [...data].reverse() : data, model: "text-embedding-nomic", usage: { prompt_tokens: 1, total_tokens: 1 } };
}

const inputOf = (body: unknown): string[] => (body as { input: string[] }).input;

test("ollama: probe measures dims from one embed of ['probe'] with keep_alive in the body; embed sends ≤ 64 texts per POST /api/embed in order, vectors are unit length, and the thresholds come from the table by name", async () => {
  const ff = fakeFetch((call) => jsonResponse(ollamaBody(inputOf(call.body), 768)));
  const e = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434/", model: "nomic-embed-text:latest", fetchImpl: ff.fetch });
  assert.equal(e.kind, "local");
  assert.equal(e.dims, 768);
  assert.equal(e.model, "nomic-embed-text:latest");
  assert.equal(ff.calls.length, 1);
  assert.equal(ff.calls[0]!.url, "http://127.0.0.1:11434/api/embed");
  assert.equal(ff.calls[0]!.method, "POST");
  assert.deepEqual(ff.calls[0]!.body, { model: "nomic-embed-text:latest", input: ["probe"], keep_alive: "30m" });
  assert.equal(ff.calls[0]!.headers["authorization"], undefined, "Ollama wants no bearer");
  assert.deepEqual(e.thresholds, LOCAL_THRESHOLDS["nomic-embed-text"], "the tag is dropped when reading the table");

  const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
  const vecs = await e.embed(texts);
  assert.equal(ff.calls.length, 4);
  assert.deepEqual(ff.calls.slice(1).map((c) => inputOf(c.body).length), [64, 64, 22]);
  assert.deepEqual(inputOf(ff.calls[1]!.body).slice(0, 3), ["text 0", "text 1", "text 2"]);
  assert.ok(ff.calls.slice(1).every((c) => (c.body as { keep_alive: string }).keep_alive === "30m"));
  assert.equal(vecs.length, 150);
  assert.ok(vecs.every((v) => v.length === 768));
  // text i is at position i % 64 of its batch and the fake puts its 1 there
  assert.ok(vecs[5]![5]! > 0.9);
  assert.ok(vecs[70]![70 % 64]! > 0.9);
  assert.ok(vecs[149]![149 % 64]! > 0.9);
  for (const v of [vecs[0]!, vecs[149]!]) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
    assert.ok(Math.abs(n - 1) < 1e-5, "unit length");
  }
  assert.ok(Math.abs(cosine(vecs[0]!, vecs[64]!) - 1) < 1e-5, "the same position in two batches: the fake's vectors match");
  assert.deepEqual(await e.embed([]), []);
});

test("lmstudio / llamacpp: POST /v1/embeddings {model, input} with no keep_alive, the answer put back in `index` order; a bearer only when a key is given; the base URL loses a trailing /v1", async () => {
  const ff = fakeFetch((call) => jsonResponse(openaiBody(inputOf(call.body), 16, true)));
  const e = await LocalEmbedder.probe({ flavor: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", model: "text-embedding-nomic-embed-text-v1.5", fetchImpl: ff.fetch, apiKey: "lm-token" });
  assert.equal(e.dims, 16);
  assert.equal(ff.calls[0]!.url, "http://127.0.0.1:1234/v1/embeddings");
  assert.deepEqual(ff.calls[0]!.body, { model: "text-embedding-nomic-embed-text-v1.5", input: ["probe"] });
  assert.equal(ff.calls[0]!.headers["authorization"], "Bearer lm-token");
  const vecs = await e.embed(["a", "b", "c"]);
  assert.ok(vecs[0]![0]! > 0.9 && vecs[1]![1]! > 0.9 && vecs[2]![2]! > 0.9, "the reversed answer was sorted back by index");
  assert.deepEqual(e.thresholds, LOCAL_THRESHOLDS["default"], "an unlisted model reads the default row");
  const llama = fakeFetch((call) => jsonResponse(openaiBody(inputOf(call.body), 4)));
  const l = await LocalEmbedder.probe({ flavor: "llamacpp", baseUrl: "http://127.0.0.1:8080", model: "bge-small", fetchImpl: llama.fetch });
  assert.equal(llama.calls[0]!.url, "http://127.0.0.1:8080/v1/embeddings");
  assert.equal(l.dims, 4);
});

test("dims are the space: a later answer of another width is bad-response (never a vector of the wrong space); a wrong count and non-JSON are bad-response; a probe with no vector throws", async () => {
  let dims = 8;
  const ff = fakeFetch((call) => jsonResponse(ollamaBody(inputOf(call.body), dims)));
  const e = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "embeddinggemma", fetchImpl: ff.fetch });
  assert.equal(e.dims, 8);
  dims = 12;
  await assert.rejects(e.embed(["x"]), (err: unknown) => err instanceof EmbedError && err.code === "bad-response" && /12 dims.*has 8/.test(err.message));
  const short = fakeFetch(() => jsonResponse({ embeddings: [[1, 0]] }));
  const s = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: short.fetch });
  await assert.rejects(s.embed(["a", "b"]), (err: unknown) => err instanceof EmbedError && err.code === "bad-response" && /wrong count/.test(err.message));
  const html = fakeFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: html.fetch }), (err: unknown) => err instanceof EmbedError && err.code === "bad-response");
  const empty = fakeFetch(() => jsonResponse({ embeddings: [[]] }));
  await assert.rejects(LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: empty.fetch }), (err: unknown) => err instanceof EmbedError && err.code === "bad-response");
});

test("codes: 500 then 200 is one retry; 5xx twice is http with the status; a 404 (model not pulled) is http at once with the server's words; a hung server is timeout; an outside abort is rethrown as itself", async () => {
  const once = fakeFetch((call, n) => (n === 1 ? jsonResponse({ error: "loading" }, 503) : jsonResponse(ollamaBody(inputOf(call.body), 4))));
  const e = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: once.fetch });
  assert.equal(once.calls.length, 2, "one retry, no backoff");
  assert.equal(e.dims, 4);
  const twice = fakeFetch(() => jsonResponse({}, 502));
  // the probe answers, then the model is removed underneath the embedder
  const gone = fakeFetch((call, n) => (n === 1 ? jsonResponse(ollamaBody(inputOf(call.body), 4)) : jsonResponse({ error: 'model "m" not found, try pulling it first' }, 404)));
  const g = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: gone.fetch });
  await assert.rejects(g.embed(["a"]), (err: unknown) => err instanceof EmbedError && err.code === "http" && err.status === 404 && /not found/.test(err.message));
  assert.equal(gone.calls.length, 2, "a 4xx is a configuration fault: no retry");
  const down = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: fakeFetch((call, n) => (n === 1 ? jsonResponse(ollamaBody(inputOf(call.body), 4)) : twice.fetch(call.url, { method: "POST" }))).fetch });
  await assert.rejects(down.embed(["a"]), (err: unknown) => err instanceof EmbedError && err.code === "http" && err.status === 502);
  assert.equal(twice.calls.length, 2, "exactly one retry on a 5xx");
  const hung = fakeFetch(() => new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("aborted")), 50)));
  await assert.rejects(LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: hung.fetch, timeoutMs: 10 }), (err: unknown) => err instanceof EmbedError && err.code === "timeout");
  const ac = new AbortController();
  const aborted = fakeFetch((call, n) => (n === 1 ? jsonResponse(ollamaBody(inputOf(call.body), 4)) : new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("The operation was aborted")), 5))));
  const a = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: aborted.fetch });
  const p = a.embed(["a"], ac.signal);
  ac.abort();
  await assert.rejects(p, (err: unknown) => !(err instanceof EmbedError));
});

test("no `no-key` path exists: the source never raises it, and an embedder with no key and no bearer embeds", async () => {
  const src = readFileSync(join(here, "..", "embed", "local.ts"), "utf8");
  assert.ok(!/"no-key"/.test(src), "embed/local.ts never spells the no-key code");
  const ff = fakeFetch((call) => jsonResponse(ollamaBody(inputOf(call.body), 4)));
  const e = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: ff.fetch });
  const [v] = await e.embed(["hello"]);
  assert.equal(v!.length, 4);
  assert.ok(ff.calls.every((c) => !("authorization" in c.headers)));
});

test("the cache key is the full server id and the measured dims: embeddings.jsonl rows say model 'nomic-embed-text:latest' / dims 768, and a different local model sees none of them", async () => {
  const dir = fresh();
  const store = new MemoryStore({ dir, now: () => T0, newId: ids() });
  store.load();
  const ff = fakeFetch((call) => jsonResponse(ollamaBody(inputOf(call.body), 768)));
  const e = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text:latest", fetchImpl: ff.fetch });
  const before = ff.calls.length;
  const vecs = await store.embed(e, ["Kevin goes by Kev", "Kevin prefers short answers", "Kevin goes by Kev"]);
  assert.equal(ff.calls.length, before + 1, "one call for the misses; the duplicate embeds once");
  assert.deepEqual(inputOf(ff.calls[before]!.body), ["Kevin goes by Kev", "Kevin prefers short answers"]);
  assert.equal(vecs.length, 3);
  const rows = readFileSync(join(dir, "embeddings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { model: string; dims: number; sha: string });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.model === "nomic-embed-text:latest" && r.dims === 768));
  await store.embed(e, ["kevin goes by kev."]);
  assert.equal(ff.calls.length, before + 1, "a hit never reaches the server");
  const other = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "embeddinggemma", fetchImpl: fakeFetch((call) => jsonResponse(ollamaBody(inputOf(call.body), 768))).fetch });
  const it = store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, { at: T0, type: "kevin" });
  assert.ok(store.vectorFor(it.id, e));
  assert.equal(store.vectorFor(it.id, other), undefined, "same dims, other model: another space");
});

test("thresholds: the table has nomic and mxbai rows and a wider default; localThresholdsFor drops namespace and tag; an explicit override wins", async () => {
  assert.deepEqual(Object.keys(LOCAL_THRESHOLDS).sort(), ["default", "mxbai-embed-large", "nomic-embed-text"]);
  for (const t of Object.values(LOCAL_THRESHOLDS)) assert.ok(t.band < t.update && t.update < t.dup && t.band >= 0.72, "conservative: the band hands doubt to the decider");
  assert.deepEqual(localThresholdsFor("mxbai-embed-large:335m"), LOCAL_THRESHOLDS["mxbai-embed-large"]);
  assert.deepEqual(localThresholdsFor("library/nomic-embed-text:latest"), LOCAL_THRESHOLDS["nomic-embed-text"]);
  assert.deepEqual(localThresholdsFor("embeddinggemma"), LOCAL_THRESHOLDS["default"]);
  const ff = fakeFetch((call) => jsonResponse(ollamaBody(inputOf(call.body), 4)));
  const e = await LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text", fetchImpl: ff.fetch, thresholds: { update: 0.8, band: 0.6, dup: 0.9 } });
  assert.deepEqual(e.thresholds, { update: 0.8, band: 0.6, dup: 0.9 });
});
