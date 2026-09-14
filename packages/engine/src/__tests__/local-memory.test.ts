import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerRow, LocalServerStatus } from "@jarhead/protocol";
import { fakeLocalServer, localModel, localNone, localStatus, nextUtterance, rows, settle, until, world, type World } from "./world.ts";

/**
 * Memory follows the brain SETTING (docs/LOCAL.md §4): under `brain: "local"` the store is built
 * over the local server — the discovered embedding model and the brain's model as extractor — and
 * nothing goes to api.openai.com even with a key in the config; without an embedding model it is
 * keywords with the local extractor; while the server is down it is keywords and rules. A change
 * of brain relinks the providers only when their identity moved, and a relink heals the vectors
 * at quiet ticks. The real memory service runs here over a temp store; every request it makes
 * goes through a recording fetch, so "no request to api.openai.com" is a number.
 */

const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();

/** A recording fetch: local URLs go to the fake server for real; api.openai.com is answered with a canned model list and counted. */
function recordingFetch(): { fetch: typeof fetch; urls: string[]; openai: () => number } {
  const urls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(`${init?.method ?? "GET"} ${url}`);
    if (/api\.openai\.com/.test(url)) {
      if (/\/v1\/models$/.test(url)) return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-5-mini" }, { id: "text-embedding-3-small" }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/v1\/embeddings$/.test(url)) {
        const n = ((JSON.parse(String(init?.body ?? "{}")) as { input?: string[] }).input ?? []).length;
        return new Response(JSON.stringify({ object: "list", data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: Array.from({ length: 512 }, (_x, k) => (k === i % 512 ? 1 : 0.001)) })) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "not in this test" } }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
  return { fetch: impl, urls, openai: () => urls.filter((u) => /api\.openai\.com/.test(u)).length };
}

/** A state dir whose settings.json already says `local` (the engine reads it in its constructor). */
function localSettingsDir(brainModel: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jh-local-memory-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "settings.json"), JSON.stringify({ brain: "local", brainModel, idleSleepMinutes: 0 }));
  return dir;
}

/** Kevin says a line and the transcript closes it (the memory hook is async: a beat is waited). */
async function heard(w: World, text: string): Promise<void> {
  const live = w.lives.at(-1)!;
  const s = live.nowMs;
  live.nowMs += 900;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  nextUtterance(w);
  tick(w);
  await settle(1);
}

test("brain local with OPENAI_API_KEY set: the store is built over LocalEmbedder (probed on the server) and ChatExtractor (the brain's model); a closed conversation is read on the local server; no request ever goes to api.openai.com", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b", "embeddinggemma:latest"]);
  const rf = recordingFetch();
  const status: LocalServerStatus = localStatus(server.url, [localModel("qwen3.5:27b"), localModel("embeddinggemma:latest", { capabilities: ["embedding"], sizeBytes: 621e6, contextLength: 2048 })], { embedModel: "embeddinggemma:latest" });
  const w = world({ memory: { fetchImpl: rf.fetch }, discoverLocal: async () => ({ ...status, checkedAt: Date.now() }) }, { dir: localSettingsDir("qwen3.5:27b") });
  const { engine, clock } = w;
  try {
    assert.equal(engine.currentSettings.brain, "local");
    assert.ok(engine.config.openaiApiKey, "a key is present — and stays unused for memory");
    await engine.start();
    await engine.ready();
    await engine.memory.ready();
    const summary = engine.snapshot().memory!;
    assert.equal(summary.embeddings, "local");
    assert.equal(summary.embeddingModel, "embeddinggemma:latest");
    assert.equal(summary.embeddingDims, 768, "measured by the probe");
    const probe = server.seen.find((r) => r.path === "/api/embed");
    assert.ok(probe, "LocalEmbedder probed the server once for its dims");
    assert.deepEqual((probe!.body as { input: string[]; model: string }).input, ["probe"]);
    assert.equal((probe!.body as { model: string }).model, "embeddinggemma:latest");
    assert.equal(rf.openai(), 0, `nothing went to api.openai.com: ${rf.urls.join(", ")}`);
    // The data-path row says where memory's words go.
    const memoryRow = engine.snapshot().setup.dataPaths.find((p) => p.what === "memory")!;
    assert.deepEqual(memoryRow, { what: "memory", where: "mac", detail: "embeddings embeddinggemma:latest 768 dims · extractor qwen3.5:27b — nothing leaves" });
    // A conversation with enough Kevin lines closes; the quiet tick reads it — on the local server, through the ChatExtractor.
    await engine.wake("test");
    for (const line of ["call me Kev", "I prefer dark mode", "from now on read the diff first", "my sister is called Anna", "what time is it"]) await heard(w, line);
    await engine.command({ type: "stop" });
    assert.equal(engine.snapshot().memory?.pending, 1);
    clock.t += 1000;
    tick(w);
    assert.ok(await until(() => server.seen.some((r) => r.path === "/v1/chat/completions"), 5000), "the extractor asked the local server");
    const extract = server.seen.find((r) => r.path === "/v1/chat/completions")!;
    assert.equal((extract.body as { model: string }).model, "qwen3.5:27b", "memory uses the brain model");
    assert.ok(await until(() => rows<LedgerRow>(w, "memory.run").length === 1, 5000), "the run landed");
    assert.equal((rows<Extract<LedgerRow, { type: "memory.run" }>>(w, "memory.run")[0] as { extractor: string }).extractor, "local");
    assert.equal(rf.openai(), 0, "still nothing to api.openai.com");
    assert.deepEqual(server.violations, [], "never-writes");
  } finally {
    await engine.stop();
    await server.close();
  }
});

test("brain local with no embedding model on the server: keyword matching with the local extractor (nothing leaves); brainModel empty uses the engine's pick", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b"]);
  const rf = recordingFetch();
  const status = localStatus(server.url, [localModel("qwen3.5:27b")]);
  const w = world({ memory: { fetchImpl: rf.fetch }, discoverLocal: async () => ({ ...status, checkedAt: Date.now() }) }, { dir: localSettingsDir("qwen3.5:27b") });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.memory.ready();
    const summary = engine.snapshot().memory!;
    assert.equal(summary.embeddings, "keyword");
    assert.equal(summary.embeddingModel, undefined);
    assert.equal(server.seen.filter((r) => r.path === "/api/embed").length, 0, "no embedding model: nothing to probe");
    assert.deepEqual(engine.snapshot().setup.dataPaths.find((p) => p.what === "memory"), { what: "memory", where: "mac", detail: "keywords · extractor qwen3.5:27b — nothing leaves" });
    assert.equal(rf.openai(), 0);
  } finally {
    await engine.stop();
    await server.close();
  }
});

test("relink: switching the brain to codex rebuilds memory over the OpenAI providers (the key's model list is asked then, not before); back to local rebuilds over the server; a restart with the same identity rebuilds nothing", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b", "embeddinggemma:latest"]);
  const rf = recordingFetch();
  const status = localStatus(server.url, [localModel("qwen3.5:27b"), localModel("embeddinggemma:latest", { capabilities: ["embedding"] })], { embedModel: "embeddinggemma:latest" });
  const w = world({ memory: { fetchImpl: rf.fetch }, discoverLocal: async () => ({ ...status, checkedAt: Date.now() }) }, { dir: localSettingsDir("qwen3.5:27b") });
  const { engine } = w;
  const probes = (): number => server.seen.filter((r) => r.path === "/api/embed" && (r.body as { input: string[] }).input[0] === "probe").length;
  try {
    await engine.start();
    await engine.ready();
    await engine.memory.ready();
    assert.equal(engine.snapshot().memory?.embeddings, "local");
    assert.equal(probes(), 1);
    assert.equal(rf.openai(), 0);
    // Away from local: the OpenAI branch (with a key in the config) — the model list is read once, the store is rebuilt.
    engine.updateSettings({ brain: "codex" });
    assert.ok(await until(() => engine.snapshot().memory?.embeddings === "openai", 5000), `openai providers after the switch: ${engine.snapshot().memory?.embeddings}`);
    assert.ok(rf.openai() >= 1, "the key's model list was asked for the extractor pick");
    assert.equal(engine.snapshot().setup.dataPaths.find((p) => p.what === "memory")!.where, "cloud");
    // Back to local: rebuilt over the server (a second probe), nothing more to OpenAI.
    const openaiBefore = rf.openai();
    engine.updateSettings({ brain: "local" });
    assert.ok(await until(() => engine.snapshot().memory?.embeddings === "local", 5000));
    assert.equal(probes(), 2, "a second probe: the local embedder was built again");
    assert.equal(rf.openai(), openaiBefore, "nothing more to api.openai.com once memory is local again");
    // A restart that changes nothing about memory's providers (the effort moved) rebuilds nothing.
    engine.updateSettings({ effort: "high" });
    await settle(50);
    await engine.memory.ready();
    assert.equal(probes(), 2, "identity unchanged → no rebuild");
    assert.equal(engine.snapshot().memory?.embeddings, "local");
  } finally {
    await engine.stop();
    await server.close();
  }
});

test("reembed drains at quiet ticks: items remembered on keywords (the server had no embedding model) get vectors after the embedding model appears, 96 a tick, until none is left", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b", "embeddinggemma:latest"]);
  const rf = recordingFetch();
  const noEmbed = localStatus(server.url, [localModel("qwen3.5:27b")]);
  const withEmbed = localStatus(server.url, [localModel("qwen3.5:27b"), localModel("embeddinggemma:latest", { capabilities: ["embedding"] })], { embedModel: "embeddinggemma:latest" });
  const d = { answer: noEmbed };
  const w = world({ memory: { fetchImpl: rf.fetch }, discoverLocal: async () => ({ ...d.answer, checkedAt: Date.now() }) }, { dir: localSettingsDir("qwen3.5:27b") });
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.memory.ready();
    assert.equal(engine.snapshot().memory?.embeddings, "keyword");
    for (const text of ["I prefer dark mode", "my sister is called Anna", "I take the 8:15 train"]) await engine.command({ type: "memory.add", text });
    assert.equal(engine.snapshot().memory?.count, 3);
    assert.equal(server.seen.filter((r) => r.path === "/api/embed").length, 0, "keywords: no vectors were made");
    // Kevin pulls embeddinggemma; the next brain restart (a Retry, a heal, a pick) relinks memory onto it.
    d.answer = withEmbed;
    await engine.retryProblem("brain.local");
    await engine.memory.ready();
    assert.equal(engine.snapshot().memory?.embeddings, "local");
    // Quiet ticks: one reembed slice embeds the three items, the next finds nothing left.
    const embedsBefore = server.seen.filter((r) => r.path === "/api/embed").length;
    clock.t += 1000;
    tick(w);
    assert.ok(
      await until(() => server.seen.filter((r) => r.path === "/api/embed").some((r) => ((r.body as { input: string[] }).input ?? []).some((t) => /dark mode/.test(t))), 5000),
      "the items' texts were embedded on the server",
    );
    const texts = server.seen
      .filter((r) => r.path === "/api/embed")
      .slice(embedsBefore)
      .flatMap((r) => (r.body as { input: string[] }).input);
    assert.equal(texts.filter((t) => /dark mode|Anna|8:15/.test(t)).length, 3, `every keyword-era item got a vector: ${texts.join(" | ")}`);
    await settle(30);
    const after = server.seen.filter((r) => r.path === "/api/embed").length;
    clock.t += 1000;
    tick(w);
    await settle(50);
    clock.t += 1000;
    tick(w);
    await settle(50);
    assert.equal(server.seen.filter((r) => r.path === "/api/embed").length, after, "drained: later quiet ticks embed nothing more");
    assert.equal(rf.openai(), 0);
    assert.deepEqual(server.violations, []);
  } finally {
    await engine.stop();
    await server.close();
  }
});

test("brain local while nothing answers: memory runs on keywords and rules — never on OpenAI, though the brain itself fell back to it", async () => {
  const rf = recordingFetch();
  const w = world({ memory: { fetchImpl: rf.fetch }, discoverLocal: async () => localNone() }, { dir: localSettingsDir("") });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.memory.ready();
    assert.equal(engine.brainInfo.kind, "fake", "the test brain stands in for the fallback");
    assert.equal(engine.snapshot().memory?.embeddings, "keyword");
    assert.equal(rf.openai(), 0, "the setting is local: no OpenAI embedder, no Responses extractor");
    assert.deepEqual(engine.snapshot().setup.dataPaths.find((p) => p.what === "memory"), { what: "memory", where: "mac", detail: "keywords · rules — nothing leaves" });
  } finally {
    await engine.stop();
  }
});
