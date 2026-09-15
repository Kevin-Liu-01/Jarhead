import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { LocalModel, LocalServerStatus } from "@jarhead/protocol";
import {
  EMBED_PREFERENCE,
  LOCAL_KEEP_ALIVE,
  LOCAL_KEEP_ALIVE_MS,
  LOCAL_NUM_CTX_MAX,
  LOCAL_NUM_PREDICT,
  LOCAL_SERVER_KEEP_ALIVE_MS,
  LOCAL_TEMPERATURE,
  LOCAL_TOOLS,
  LocalBrain,
  OllamaChatTransport,
  bestFit,
  discoverLocalServer,
  fitFor,
  fitTools,
  resolveLocalModel,
  suggestedPull,
  thinkFor,
} from "../local.ts";
import { toChatTool } from "../compatible.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";
import { fakeServer, makeRunner, makeSink, makeTask, type FakeAnswer, type FakeServer, type Seen } from "./fakes.ts";

const GIB = 1024 ** 3;
const RAM = 128 * GIB;

/**
 * The never-writes pin: every request the daemon may make to a local server. A
 * route wrapped by `localServer` answers anything else with a 500 and records the
 * violation, so a test that passes has only ever read, chatted, embedded or
 * (un)loaded — never pulled, created, copied, pushed or deleted.
 */
const ALLOWED: ReadonlyArray<{ method: string; path: string; body?: (b: unknown) => boolean }> = [
  { method: "GET", path: "/api/version" },
  { method: "GET", path: "/api/tags" },
  { method: "POST", path: "/api/show" },
  { method: "GET", path: "/api/ps" },
  { method: "GET", path: "/v1/models" },
  { method: "POST", path: "/api/chat" },
  { method: "POST", path: "/api/generate", body: (b) => typeof b === "object" && b !== null && "keep_alive" in b && !("prompt" in b) },
  { method: "POST", path: "/api/embed" },
  { method: "POST", path: "/v1/chat/completions" },
  { method: "POST", path: "/v1/embeddings" },
  { method: "GET", path: "/api/v0/models" },
  { method: "GET", path: "/health" },
  { method: "GET", path: "/props" },
];

const violations: string[] = [];

async function localServer(route: (req: Seen, res: ServerResponse) => FakeAnswer): Promise<FakeServer> {
  return fakeServer((req, res) => {
    const path = req.path.split("?")[0]!;
    const ok = ALLOWED.some((a) => a.method === req.method && a.path === path && (a.body ? a.body(req.body) : true));
    if (!ok) {
      violations.push(`${req.method} ${req.path} ${JSON.stringify(req.body ?? null).slice(0, 80)}`);
      return { status: 500, json: { error: `never-writes: ${req.method} ${req.path}` } };
    }
    return route(req, res);
  });
}

// ---- the Ollama fixture ---------------------------------------------------------------------

interface OllamaFixture {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  capabilities: string[];
  arch: string;
  ctx: number;
  family: string;
  parameter_size: string;
  remote_host?: string;
}

function fixture(salt: string): OllamaFixture[] {
  return [
    { name: "qwen3.5:27b", size: 17e9, digest: `${salt}-q35`, modified_at: "2026-09-10T10:00:00Z", capabilities: ["completion", "tools", "vision", "thinking"], arch: "qwen35", ctx: 262144, family: "qwen35", parameter_size: "27B" },
    { name: "gemma3:27b", size: 17e9, digest: `${salt}-g3`, modified_at: "2026-09-11T10:00:00Z", capabilities: ["completion", "vision"], arch: "gemma3", ctx: 131072, family: "gemma3", parameter_size: "27B" },
    { name: "deepseek-r1:32b", size: 20e9, digest: `${salt}-ds`, modified_at: "2026-09-01T10:00:00Z", capabilities: ["completion", "thinking"], arch: "qwen2", ctx: 131072, family: "qwen2", parameter_size: "32B" },
    { name: "glm-5.2:cloud", size: 0, digest: `${salt}-glm`, modified_at: "2026-09-12T10:00:00Z", capabilities: ["completion", "tools"], arch: "glm", ctx: 0, family: "glm", parameter_size: "355B", remote_host: "https://ollama.com" },
    { name: "embeddinggemma:latest", size: 621e6, digest: `${salt}-eg`, modified_at: "2026-09-05T10:00:00Z", capabilities: ["embedding"], arch: "gemma3", ctx: 2048, family: "gemma3", parameter_size: "300M" },
  ];
}

interface OllamaFake {
  version?: string;
  models?: OllamaFixture[];
  loaded?: string[];
  /** Answers POST /api/chat, in order of arrival (the last one repeats). */
  chat?: (req: Seen, n: number) => FakeAnswer;
  shows: number;
}

function ollamaRoute(o: OllamaFake): (req: Seen, res: ServerResponse) => FakeAnswer {
  let chats = 0;
  const models = o.models ?? fixture("default");
  return (req) => {
    if (req.method === "GET" && req.path === "/api/version") return { status: 200, json: { version: o.version ?? "0.34.0" } };
    if (req.method === "GET" && req.path === "/api/tags") {
      return {
        status: 200,
        json: {
          models: models.map((m) => ({ name: m.name, model: m.name, modified_at: m.modified_at, size: m.size, digest: m.digest, details: { family: m.family, parameter_size: m.parameter_size }, ...(m.remote_host ? { remote_host: m.remote_host, remote_model: m.name } : {}) })),
        },
      };
    }
    if (req.method === "POST" && req.path === "/api/show") {
      o.shows++;
      const want = (req.body as { model?: string }).model;
      const m = models.find((x) => x.name === want);
      if (!m) return { status: 404, json: { error: `model '${want}' not found` } };
      return { status: 200, json: { capabilities: m.capabilities, details: { family: m.family, parameter_size: m.parameter_size }, model_info: { "general.architecture": m.arch, [`${m.arch}.context_length`]: m.ctx }, modified_at: m.modified_at } };
    }
    if (req.method === "GET" && req.path === "/api/ps") return { status: 200, json: { models: (o.loaded ?? []).map((name) => ({ name, model: name, size: 1, size_vram: 1 })) } };
    if (req.method === "GET" && req.path === "/v1/models") return { status: 200, json: { object: "list", data: models.map((m) => ({ id: m.name, object: "model", owned_by: "library" })) } };
    if (req.method === "POST" && req.path === "/api/chat") {
      chats++;
      return o.chat ? o.chat(req, chats) : { status: 200, ndjson: [chunk({ content: "done." }, true)] };
    }
    if (req.method === "POST" && req.path === "/api/generate") return { status: 200, json: { model: (req.body as { model: string }).model, done: true, done_reason: (req.body as { keep_alive: unknown }).keep_alive === 0 ? "unload" : "load" } };
    return { status: 404, json: { error: `no route ${req.path}` } };
  };
}

function chunk(message: { content?: string; thinking?: string; tool_calls?: unknown[] }, done = false, extra: Record<string, unknown> = {}): unknown {
  return { model: "qwen3.5:27b", created_at: "2026-09-13T00:00:00Z", message: { role: "assistant", content: "", ...message }, done, ...(done ? { done_reason: "stop", total_duration: 9_800_000_000, load_duration: 1_000_000, prompt_eval_count: 12_400, eval_count: 310, ...extra } : extra) };
}

function model(over: Partial<LocalModel> & { id: string }): LocalModel {
  return { capabilities: ["completion", "tools"], fit: "good", loaded: false, cloud: false, ...over };
}

const status = (over: Partial<LocalServerStatus>): LocalServerStatus => ({ reachable: true, flavor: "ollama", version: "0.34.0", baseUrl: "http://127.0.0.1:11434", models: [], ramBytes: RAM, checkedAt: Date.now(), ...over });

/** A fetch that reaches the fake for one loopback port and refuses the others, so the parallel port scan can be exercised. */
function portFetch(map: Record<number, string>): typeof fetch {
  return (input, init) => {
    const url = String(input);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/.*)$/.exec(url);
    if (m && map[Number(m[1])]) return fetch(`${map[Number(m[1])]}${m[2]}`, init);
    return Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
  };
}

// ---- discovery ------------------------------------------------------------------------------

test("local: discovers ollama by /api/version", async () => {
  const fake: OllamaFake = { shows: 0 };
  const server = await localServer(ollamaRoute(fake));
  try {
    const s = await discoverLocalServer({ fetch: portFetch({ 11434: server.url }), ramBytes: RAM, timeoutMs: 1000 });
    assert.equal(s.reachable, true);
    assert.equal(s.flavor, "ollama");
    assert.equal(s.version, "0.34.0");
    assert.equal(s.baseUrl, "http://127.0.0.1:11434");
    assert.equal(server.seen[0]?.path, "/api/version");
    assert.equal(s.ramBytes, RAM);
    assert.ok(s.checkedAt > 0);
  } finally {
    await server.close();
  }
});

test("local: discovers lm studio and llama.cpp by their signatures", async () => {
  const lm = await localServer((req) => {
    if (req.path === "/api/v0/models") return { status: 200, json: { object: "list", data: [{ id: "qwen2.5-vl-7b-instruct", object: "model", type: "vlm", publisher: "qwen", arch: "qwen2_vl", state: "loaded", max_context_length: 32768 }, { id: "text-embedding-nomic-embed-text-v1.5", object: "model", type: "embeddings", state: "not-loaded" }, { id: "phi-4", type: "llm", state: "not-loaded", max_context_length: 16384 }] } };
    return { status: 404, json: {} };
  });
  const llama = await localServer((req) => {
    if (req.path === "/health") return { status: 200, json: { status: "ok" } };
    if (req.path === "/props") return { status: 200, json: { default_generation_settings: { n_ctx: 32768 }, build_info: "b6100-abc", model_path: "/models/qwen3-8b.gguf" } };
    if (req.path === "/v1/models") return { status: 200, json: { object: "list", data: [{ id: "qwen3-8b.gguf", object: "model" }] } };
    return { status: 404, json: {} };
  });
  try {
    const a = await discoverLocalServer({ fetch: portFetch({ 1234: lm.url }), ramBytes: RAM, timeoutMs: 1000 });
    assert.equal(a.flavor, "lmstudio");
    assert.equal(a.baseUrl, "http://127.0.0.1:1234");
    assert.deepEqual(a.models.map((m) => m.id), ["qwen2.5-vl-7b-instruct", "phi-4"], "the embedding model is not a brain; the vlm sorts first");
    assert.deepEqual(a.models[0]!.capabilities, ["completion", "tools", "vision"]);
    assert.equal(a.models[0]!.fit, "unknown");
    assert.equal(a.models[0]!.loaded, true);
    assert.equal(a.models[0]!.contextLength, 32768);
    assert.equal(a.embedModel, undefined, "LM Studio's nomic id is not one of EMBED_PREFERENCE's Ollama names");

    const b = await discoverLocalServer({ fetch: portFetch({ 8080: llama.url }), ramBytes: RAM, timeoutMs: 1000 });
    assert.equal(b.flavor, "llamacpp");
    assert.equal(b.version, "b6100-abc");
    assert.deepEqual(b.models.map((m) => m.id), ["qwen3-8b.gguf"]);
    assert.equal(b.models[0]!.contextLength, 32768);
    assert.equal(b.models[0]!.loaded, true);
  } finally {
    await lm.close();
    await llama.close();
  }
});

test("local: pinned baseUrl probes the three signatures on one root", async () => {
  const llama = await localServer((req) => {
    if (req.path === "/health") return { status: 200, json: { status: "ok" } };
    if (req.path === "/props") return { status: 200, json: { default_generation_settings: { n_ctx: 8192 } } };
    if (req.path === "/v1/models") return { status: 200, json: { data: [{ id: "small.gguf" }] } };
    return { status: 404, json: { error: "no" } };
  });
  try {
    const s = await discoverLocalServer({ baseUrl: `${llama.url}/v1/`, ramBytes: RAM, timeoutMs: 1000 });
    assert.equal(s.flavor, "llamacpp");
    assert.equal(s.baseUrl, llama.url, "the /v1 is stripped from the pinned root");
    assert.deepEqual(llama.seen.slice(0, 3).map((r) => r.path), ["/api/version", "/api/v0/models", "/health"], "ollama → lmstudio → llamacpp on the one root");
  } finally {
    await llama.close();
  }
});

test("local: nothing answers within the timeout → LOCAL_NONE-shaped with ramBytes and checkedAt", async () => {
  const never: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
    });
  const started = Date.now();
  const s = await discoverLocalServer({ fetch: never, ramBytes: RAM, timeoutMs: 60, now: () => 1234 });
  assert.deepEqual(s, { reachable: false, baseUrl: "", models: [], ramBytes: RAM, checkedAt: 1234 });
  assert.ok(Date.now() - started < 2000, "the three probes ran in parallel and gave up together");
  const refused = await discoverLocalServer({ fetch: portFetch({}), ramBytes: RAM, timeoutMs: 60, now: () => 5 });
  assert.deepEqual(refused, { reachable: false, baseUrl: "", models: [], ramBytes: RAM, checkedAt: 5 });
  const pinned = await discoverLocalServer({ baseUrl: "http://127.0.0.1:9/v1", fetch: portFetch({}), ramBytes: RAM, timeoutMs: 60, now: () => 6 });
  assert.equal(pinned.baseUrl, "http://127.0.0.1:9", "a pinned root is reported even when it does not answer");
});

test("local: lists tool-capable models from /api/tags + /api/show, greys tools-less, drops cloud, finds embedModel from EMBED_PREFERENCE, caches /api/show by digest", async () => {
  const fake: OllamaFake = { shows: 0, models: fixture("list") };
  const server = await localServer(ollamaRoute(fake));
  try {
    const s = await discoverLocalServer({ baseUrl: server.url, ramBytes: RAM });
    assert.equal(s.reachable, true);
    assert.deepEqual(s.models.map((m) => m.id), ["qwen3.5:27b", "gemma3:27b", "deepseek-r1:32b"], "brain-capable first, then the greyed ones newest first; cloud and embedding models are not brains");
    const q = s.models[0]!;
    assert.deepEqual(q.capabilities, ["completion", "tools", "vision", "thinking"]);
    assert.equal(q.sizeBytes, 17e9);
    assert.equal(q.contextLength, 262144);
    assert.equal(q.family, "qwen35");
    assert.equal(q.parameterSize, "27B");
    assert.equal(q.modifiedAt, Date.parse("2026-09-10T10:00:00Z"));
    assert.equal(q.fit, "good");
    assert.equal(q.cloud, false);
    assert.equal(s.models[1]!.capabilities.includes("tools"), false, "gemma3 is listed but greyed");
    assert.equal(s.embedModel, "embeddinggemma:latest");
    assert.equal(EMBED_PREFERENCE[0], "embeddinggemma");
    assert.equal(s.suggested, undefined, "a tool-capable model is present, so nothing is suggested");
    assert.equal(fake.shows, 4, "one /api/show per local model; the cloud row is never asked");
    const shows = server.seen.filter((r) => r.path === "/api/show").map((r) => (r.body as { model: string }).model);
    assert.equal(shows.includes("glm-5.2:cloud"), false);

    const again = await discoverLocalServer({ baseUrl: server.url, ramBytes: RAM });
    assert.equal(fake.shows, 4, "a second look reuses the /api/show answers by digest");
    assert.deepEqual(again.models.map((m) => m.id), s.models.map((m) => m.id));
  } finally {
    await server.close();
  }
});

test("local: marks loaded from /api/ps; nothing tool-capable → suggested pull", async () => {
  const fake: OllamaFake = { shows: 0, models: fixture("ps"), loaded: ["qwen3.5:27b"] };
  const server = await localServer(ollamaRoute(fake));
  try {
    const s = await discoverLocalServer({ baseUrl: server.url, ramBytes: RAM });
    assert.deepEqual(s.models.map((m) => [m.id, m.loaded]), [["qwen3.5:27b", true], ["gemma3:27b", false], ["deepseek-r1:32b", false]]);
  } finally {
    await server.close();
  }
  const empty: OllamaFake = { shows: 0, models: fixture("empty").filter((m) => !m.capabilities.includes("tools")) };
  const bare = await localServer(ollamaRoute(empty));
  try {
    const s = await discoverLocalServer({ baseUrl: bare.url, ramBytes: RAM });
    assert.deepEqual(s.models.map((m) => m.id), ["gemma3:27b", "deepseek-r1:32b"]);
    assert.deepEqual(s.suggested, { id: "qwen3.5:27b", sizeBytes: 17e9, command: "ollama pull qwen3.5:27b" });
    assert.equal(s.embedModel, "embeddinggemma:latest");
  } finally {
    await bare.close();
  }
});

// ---- pure functions -------------------------------------------------------------------------

test("local: fitFor tiers at 16 GiB and 128 GiB", () => {
  const ram16 = 16 * GIB; // usable 12 GiB: good ≤ 6, tight ≤ 10.2
  assert.equal(fitFor(3.4e9, ram16), "good");
  assert.equal(fitFor(6.6e9, ram16), "tight");
  assert.equal(fitFor(11e9, ram16), "no");
  assert.equal(fitFor(17e9, ram16), "no");
  const ram128 = 128 * GIB; // usable 96 GiB: good ≤ 48, tight ≤ 81.6
  assert.equal(fitFor(17e9, ram128), "good");
  assert.equal(fitFor(50e9, ram128), "good");
  assert.equal(fitFor(65e9, ram128), "tight");
  assert.equal(fitFor(90e9, ram128), "no");
  assert.equal(fitFor(undefined, ram128), "unknown");
  assert.equal(fitFor(17e9, 0), "unknown");
});

test("local: bestFit prefers good > tools+vision > newest > smaller", () => {
  const tight = model({ id: "big:70b", fit: "tight", capabilities: ["completion", "tools", "vision"], modifiedAt: 9, sizeBytes: 40e9 });
  const goodText = model({ id: "text:9b", capabilities: ["completion", "tools"], modifiedAt: 9, sizeBytes: 6e9 });
  const goodVisionOld = model({ id: "vision-old:27b", capabilities: ["completion", "tools", "vision"], modifiedAt: 1, sizeBytes: 17e9 });
  const goodVisionNew = model({ id: "vision-new:27b", capabilities: ["completion", "tools", "vision"], modifiedAt: 5, sizeBytes: 17e9 });
  const goodVisionNewSmall = model({ id: "vision-new:9b", capabilities: ["completion", "tools", "vision"], modifiedAt: 5, sizeBytes: 6e9 });
  const noTools = model({ id: "gemma3:27b", capabilities: ["completion", "vision"], modifiedAt: 99, sizeBytes: 1e9 });
  const cloud = model({ id: "glm:cloud", cloud: true, modifiedAt: 99 });
  const doesNotFit = model({ id: "huge:400b", fit: "no", modifiedAt: 99 });
  assert.equal(bestFit([tight, goodText, goodVisionOld, goodVisionNew, goodVisionNewSmall, noTools, cloud, doesNotFit])?.id, "vision-new:9b");
  assert.equal(bestFit([tight, goodText])?.id, "text:9b", "good beats tight even without vision");
  assert.equal(bestFit([goodText, goodVisionOld])?.id, "vision-old:27b", "vision beats text at the same fit");
  assert.equal(bestFit([goodVisionOld, goodVisionNew])?.id, "vision-new:27b", "newest wins");
  assert.equal(bestFit([goodVisionNew, goodVisionNewSmall])?.id, "vision-new:9b", "smaller wins at the same date");
  assert.equal(bestFit([noTools, cloud, doesNotFit]), undefined);
  assert.equal(bestFit([tight]), tight, "tight still qualifies when it is all there is");
});

test("local: suggestedPull tier boundaries", () => {
  const at = (gib: number) => suggestedPull(gib * GIB);
  assert.equal(at(8).id, at(4).id);
  assert.notEqual(at(8).id, at(9).id, "8 GiB is the top of the first tier");
  assert.equal(at(16).id, at(9).id);
  assert.notEqual(at(16).id, at(17).id);
  assert.equal(at(32).id, at(17).id);
  assert.notEqual(at(32).id, at(33).id);
  assert.equal(at(64).id, at(33).id);
  assert.notEqual(at(64).id, at(65).id);
  assert.equal(at(128).id, at(65).id);
  for (const gib of [8, 16, 32, 64, 128]) {
    const s = at(gib);
    assert.equal(s.command, `ollama pull ${s.id}`);
    assert.ok(s.sizeBytes > 1e9);
    assert.ok(fitFor(s.sizeBytes, gib * GIB) !== "no", `${s.id} fits a ${gib} GiB Mac at the top of its tier`);
  }
});

test("local: resolveLocalModel exact / :latest / unique name / ambiguous / cloud / no tools / missing / empty → bestFit", () => {
  const models = [
    model({ id: "qwen3.5:27b", capabilities: ["completion", "tools", "vision", "thinking"], modifiedAt: 5, sizeBytes: 17e9 }),
    model({ id: "qwen3:8b", modifiedAt: 1, sizeBytes: 5e9 }),
    model({ id: "qwen3:32b", modifiedAt: 2, sizeBytes: 20e9 }),
    model({ id: "llama3.1:latest", modifiedAt: 3, sizeBytes: 5e9 }),
    model({ id: "gemma3:27b", capabilities: ["completion", "vision"], modifiedAt: 9, sizeBytes: 17e9 }),
  ];
  const s = status({ models });
  const ok = (r: ReturnType<typeof resolveLocalModel>) => ("model" in r ? { id: r.model.id, picked: r.picked } : r);
  assert.deepEqual(ok(resolveLocalModel("qwen3.5:27b", s)), { id: "qwen3.5:27b", picked: false });
  assert.deepEqual(ok(resolveLocalModel("llama3.1", s)), { id: "llama3.1:latest", picked: false });
  assert.deepEqual(ok(resolveLocalModel("qwen3.5", s)), { id: "qwen3.5:27b", picked: false }, "a unique name match");
  assert.deepEqual(ok(resolveLocalModel("qwen3", s)), { error: "qwen3 is ambiguous here: qwen3:8b, qwen3:32b — pick one" });
  assert.deepEqual(ok(resolveLocalModel("qwen3.5:cloud", s)), { error: "qwen3.5:cloud runs on ollama.com, not this Mac; pick a local tag" });
  assert.deepEqual(ok(resolveLocalModel("gemma3:27b", s)), { error: "gemma3:27b cannot call tools; pick a model with the tools badge (pnpm jarhead models)" });
  const missing = resolveLocalModel("qwen3.6:27b", s);
  assert.ok("error" in missing);
  assert.match(missing.error, /^qwen3\.6:27b is not on Ollama 0\.34\.0 \(it has qwen3\.5:27b, qwen3:8b/);
  assert.equal(missing.copy, "ollama pull qwen3.6:27b");
  assert.deepEqual(ok(resolveLocalModel("", s)), { id: "qwen3.5:27b", picked: true });
  assert.deepEqual(ok(resolveLocalModel("  ", s)), { id: "qwen3.5:27b", picked: true });

  const none = resolveLocalModel("", status({ models: [models[4]!], suggested: suggestedPull(RAM) }));
  assert.ok("error" in none);
  assert.match(none.error, /^nothing on Ollama 0\.34\.0 can call tools; pull one — ollama pull qwen3\.5:27b \(17 GB\)/);
  assert.equal(none.copy, "ollama pull qwen3.5:27b");

  const down = resolveLocalModel("qwen3.5:27b", { reachable: false, baseUrl: "", models: [], ramBytes: RAM, checkedAt: 1 });
  assert.ok("error" in down);
  assert.match(down.error, /^nothing answers at 127\.0\.0\.1:11434, :1234 or :8080/);
  assert.equal(down.copy, "open -a Ollama");
});

test("local: thinkFor by effort, only for thinking models, gpt-oss strings", () => {
  const thinker = model({ id: "qwen3.5:27b", capabilities: ["completion", "tools", "thinking"] });
  const plain = model({ id: "llama3.1:8b" });
  const oss = model({ id: "gpt-oss:20b", capabilities: ["completion", "tools", "thinking"], family: "gptoss" });
  assert.equal(thinkFor("low", thinker), false);
  assert.equal(thinkFor("medium", thinker), "low");
  assert.equal(thinkFor("high", thinker), "medium");
  assert.equal(thinkFor("xhigh", thinker), "high");
  assert.equal(thinkFor("max", thinker), "high");
  for (const e of ["low", "medium", "high", "xhigh", "max"] as const) assert.equal(thinkFor(e, plain), undefined);
  assert.equal(thinkFor("low", oss), "low", "gpt-oss ignores booleans");
  assert.equal(thinkFor("medium", oss), "low");
  assert.equal(thinkFor("max", oss), "high");
});

test("local: fitTools drops draw then browser then thread at ctx 16384 and nothing at 65536; LOCAL_TOOLS has no self_* or agent_*; ALL_TOOL_SPECS.length is 71", () => {
  assert.equal(ALL_TOOL_SPECS.length, 71);
  assert.equal(LOCAL_TOOLS.some((t) => t.name.startsWith("self_") || t.name.startsWith("agent_") || t.name.startsWith("agents_")), false);
  assert.ok(LOCAL_TOOLS.some((t) => t.name.startsWith("thread_")), "thread_* stay in the table; the brain gates them by Settings.threads");
  assert.ok(LOCAL_TOOLS.length < ALL_TOOL_SPECS.length);
  const saved = JSON.stringify(ALL_TOOL_SPECS.map(toChatTool)).length - JSON.stringify(LOCAL_TOOLS.map(toChatTool)).length;
  assert.ok(saved > 4000, `≈ 8.6 KB less per turn, measured ${saved}`);

  const systemBytes = 6600;
  const small = fitTools({ ctx: 16384, systemBytes, tools: LOCAL_TOOLS });
  // design11: the automation group (≈ 6.6 KB, automation_set's grammar most of it) drops second — after the
  // teaching shapes, before the browser and the threads: a tight local model reads pages before it arms alarms.
  assert.deepEqual(small.dropped, ["draw", "automation", "browser", "thread"]);
  assert.equal(small.tools.some((t) => t.name.startsWith("show_") || t.name.startsWith("browser_") || t.name.startsWith("thread_") || t.name.startsWith("automation_") || t.name === "recipe_list" || t.name === "web_search" || t.name === "web_fetch"), false);
  assert.ok(small.tools.some((t) => t.name === "screenshot"), "the computer tools are never dropped");

  const mid = fitTools({ ctx: 32768, systemBytes, tools: LOCAL_TOOLS });
  assert.deepEqual(mid.dropped, [], "a 32k window takes the whole local table");
  const narrow = fitTools({ ctx: 24576, systemBytes, tools: LOCAL_TOOLS });
  assert.deepEqual(narrow.dropped, ["draw", "automation"], "two groups at 24k; the browser and the threads stay");

  const large = fitTools({ ctx: LOCAL_NUM_CTX_MAX, systemBytes, tools: LOCAL_TOOLS });
  assert.deepEqual(large.dropped, []);
  assert.equal(large.tools.length, LOCAL_TOOLS.length);

  const already = fitTools({ ctx: 16384, systemBytes, tools: [specByName("screenshot")!, specByName("key")!] });
  assert.deepEqual(already, { tools: already.tools, dropped: [] });
  assert.equal(already.tools.length, 2);
});

// ---- the brain over Ollama ------------------------------------------------------------------

test("local: LocalBrain start builds the Ollama transport and the detail reads Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · N tools", async () => {
  const fake: OllamaFake = { shows: 0, models: fixture("brain") };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const seen: LocalServerStatus[] = [];
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "", effort: "medium", threads: () => true, ramBytes: RAM, onStatus: (s) => seen.push(s) });
    assert.equal(brain.kind, "local");
    assert.equal(brain.acceptsImages, true, "until a model is known the engine may take its pre-warm shot");
    const r = await brain.start();
    assert.equal(r.ready, true, r.detail);
    const tools = LOCAL_TOOLS.length;
    assert.equal(r.detail, `Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · ${tools} tools · best fit (pick another in Settings)`);
    assert.equal(brain.detail, r.detail);
    assert.equal(brain.acceptsImages, true);
    assert.equal(brain.status.picked, "qwen3.5:27b");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.picked, "qwen3.5:27b");
    assert.ok(server.seen.some((s) => s.path === "/v1/models"), "the inner loop's probe ran");

    const pinned = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "low", threads: () => false, ramBytes: RAM, status: brain.status });
    const p = await pinned.start();
    assert.equal(p.ready, true, p.detail);
    assert.equal(p.detail, `Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking off · ${LOCAL_TOOLS.filter((t) => !t.name.startsWith("thread_")).length} tools`);
    assert.equal(pinned.status.picked, undefined, "Kevin's own pick is not a best-fit pick");
    assert.equal(fake.shows, 4, "a fresh status handed in is not re-discovered");

    const bad = new LocalBrain({ runner, baseUrl: server.url, model: "gemma3:27b", effort: "medium", threads: () => true, ramBytes: RAM });
    const b = await bad.start();
    assert.equal(b.ready, false);
    assert.match(b.detail, /gemma3:27b cannot call tools/);
    assert.equal(bad.acceptsImages, true);
    assert.equal((await bad.handle(makeTask("x"), makeSink().sink)).status, "failed");
    await brain.stop();
    await pinned.stop();
  } finally {
    await server.close();
  }
});

test("local: body carries options.num_ctx clamped, num_predict, temperature, keep_alive, truncate false, think only for a thinking model", async () => {
  const fake: OllamaFake = { shows: 0, models: [...fixture("body"), { name: "llama3.1:8b", size: 5e9, digest: "body-l31", modified_at: "2026-09-01T00:00:00Z", capabilities: ["completion", "tools"], arch: "llama", ctx: 8192, family: "llama", parameter_size: "8B" }] };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "high", threads: () => true, ramBytes: RAM });
    assert.equal((await brain.start()).ready, true);
    const r = await brain.handle(makeTask("hello"), makeSink().sink);
    assert.equal(r.status, "done", r.error);
    const chat = server.seen.find((s) => s.path === "/api/chat")!;
    const body = chat.body as Record<string, unknown>;
    assert.equal(body.model, "qwen3.5:27b");
    assert.equal(body.stream, true);
    assert.deepEqual(body.options, { num_ctx: LOCAL_NUM_CTX_MAX, num_predict: LOCAL_NUM_PREDICT, temperature: LOCAL_TEMPERATURE });
    assert.equal(body.keep_alive, LOCAL_KEEP_ALIVE);
    assert.equal(body.truncate, false);
    assert.equal(body.think, "medium");
    assert.equal(body.tool_choice, undefined, "Ollama ignores tool_choice; it is not sent");
    const tools = body.tools as Array<{ type: string; function: { name: string } }>;
    assert.equal(tools.length, LOCAL_TOOLS.length);
    assert.equal(tools[0]!.type, "function");
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
    assert.match(messages[0]!.content, /brain of Jarhead/);

    const small = new LocalBrain({ runner, baseUrl: server.url, model: "llama3.1:8b", effort: "high", threads: () => true, ramBytes: RAM });
    const s = await small.start();
    assert.equal(s.ready, true, s.detail);
    assert.match(s.detail, /^Local · llama3\.1:8b on Ollama 0\.34\.0 · 8k ctx \(small\) · text-only · thinking off · \d+ tools \(draw, automation, browser, thread dropped\)$/);
    assert.equal(small.acceptsImages, false);
    await small.handle(makeTask("hello"), makeSink().sink);
    const b2 = server.seen.filter((x) => x.path === "/api/chat").at(-1)!.body as Record<string, unknown>;
    assert.deepEqual((b2.options as { num_ctx: number }).num_ctx, 8192, "a trained context below the minimum is sent as-is");
    assert.equal("think" in b2, false, "no think for a model without the thinking capability");
    await brain.stop();
    await small.stop();
  } finally {
    await server.close();
  }
});

test("local: NDJSON tool call round trip: arguments object → runner, tool result carries tool_name; usage note", async () => {
  const fake: OllamaFake = {
    shows: 0,
    models: fixture("roundtrip"),
    chat: (_req, n) =>
      n === 1
        ? { status: 200, ndjson: [chunk({ thinking: "Which app is in front? " }), chunk({ thinking: "frontmost_app tells me." }), chunk({ tool_calls: [{ id: "call_a1b2c3d4", function: { index: 0, name: "frontmost_app", arguments: {} } }] }), chunk({}, true)] }
        : { status: 200, ndjson: [chunk({ content: "Finder " }), chunk({ content: "is in front." }), chunk({}, true)] },
  };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => true, ramBytes: RAM });
    assert.equal((await brain.start()).ready, true);
    const log = makeSink();
    const r = await brain.handle(makeTask("what app is in front"), log.sink);
    assert.equal(r.status, "done", r.error);
    assert.equal(r.summary, "Finder is in front.");
    assert.ok(log.steps.includes("tool:frontmost_app"));
    assert.ok(log.thinking.includes("Which app is in front? frontmost_app tells me."), `thinking chunks are gathered: ${JSON.stringify(log.thinking)}`);
    assert.ok(log.thinking.includes("Checking which app is in front."));
    assert.equal(log.steps.filter((s) => s.startsWith("note:12.4k prompt · 310 out · 9.8 s")).length, 2, "one cost note per model turn");
    const second = server.seen.filter((s) => s.path === "/api/chat")[1]!.body as { messages: Array<{ role: string; content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: unknown } }>; tool_name?: string; tool_call_id?: string }> };
    assert.deepEqual(second.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.deepEqual(second.messages[2]!.tool_calls, [{ id: "call_a1b2c3d4", function: { name: "frontmost_app", arguments: {} } }], "arguments go back as an object");
    assert.equal(second.messages[2]!.content, "");
    assert.equal(second.messages[3]!.tool_name, "frontmost_app");
    assert.equal(second.messages[3]!.tool_call_id, "call_a1b2c3d4");
    assert.match(second.messages[3]!.content, /Finder/);
    assert.equal(JSON.stringify(second.messages).includes("frontmost_app tells me"), false, "reasoning never goes back into history");
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("local: thinking chunks → sink.thinking, never the summary; <think> in content is stripped too", async () => {
  const fake: OllamaFake = {
    shows: 0,
    models: fixture("thinking"),
    loaded: ["qwen3.5:27b"],
    chat: () => ({ status: 200, ndjson: [chunk({ thinking: "The clock says noon." }), chunk({ content: "<think>double-check</think>It is noon." }), chunk({}, true)] }),
  };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => true, ramBytes: RAM });
    await brain.start();
    const log = makeSink();
    const r = await brain.handle(makeTask("time?"), log.sink);
    assert.equal(r.summary, "It is noon.");
    assert.deepEqual(log.thinking, ["The clock says noon.\ndouble-check"]);
    assert.equal(log.commentary.length, 0);
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("local: images as messages[].images only for a vision model; newest-image-only history", async () => {
  const shot = (n: number) => chunk({ tool_calls: [{ id: `call_shot${n}`, function: { index: 0, name: "screenshot", arguments: {} } }] });
  const fake: OllamaFake = { shows: 0, models: fixture("images"), chat: (_req, n) => (n <= 2 ? { status: 200, ndjson: [shot(n), chunk({}, true)] } : { status: 200, ndjson: [chunk({ content: "Looks like the desktop." }), chunk({}, true)] }) };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const vision = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => true, ramBytes: RAM });
    await vision.start();
    assert.equal((await vision.handle(makeTask("look"), makeSink().sink)).status, "done");
    const chats = server.seen.filter((s) => s.path === "/api/chat");
    const third = chats[2]!.body as { messages: Array<{ role: string; content: string; images?: string[] }> };
    assert.deepEqual(third.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user", "assistant", "tool", "user"]);
    const withImages = third.messages.filter((m) => Array.isArray(m.images));
    assert.equal(withImages.length, 1, "only the newest screenshot keeps its pixels");
    assert.equal(withImages[0], third.messages[7]);
    assert.equal(withImages[0]!.images![0], Buffer.from("png").toString("base64"), "base64 without the data: prefix");
    assert.match(withImages[0]!.content, /^Screenshot from screenshot \(100x50 px\)/);
    assert.equal(third.messages[4]!.content, "[screenshot from screenshot, superseded]");
    assert.equal(third.messages[4]!.images, undefined);

    const text = new LocalBrain({ runner, baseUrl: server.url, model: "deepseek-r1:32b", effort: "medium", threads: () => true, ramBytes: RAM });
    const t = await text.start();
    assert.equal(t.ready, false, "deepseek-r1 has no tools capability in the fixture");
  } finally {
    await server.close();
  }
  // A text-only tools model: the screenshot becomes a sentence, never an images[] entry.
  const fake2: OllamaFake = {
    shows: 0,
    models: [{ name: "llama3.1:8b", size: 5e9, digest: "images-l31", modified_at: "2026-09-01T00:00:00Z", capabilities: ["completion", "tools"], arch: "llama", ctx: 131072, family: "llama", parameter_size: "8B" }],
    chat: (_req, n) => (n === 1 ? { status: 200, ndjson: [shot(1), chunk({}, true)] } : { status: 200, ndjson: [chunk({ content: "I cannot see it." }), chunk({}, true)] }),
  };
  const server2 = await localServer(ollamaRoute(fake2));
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server2.url, model: "llama3.1:8b", effort: "medium", threads: () => true, ramBytes: RAM });
    await brain.start();
    assert.equal(brain.acceptsImages, false);
    assert.equal((await brain.handle(makeTask("look"), makeSink().sink)).status, "done");
    const second = server2.seen.filter((s) => s.path === "/api/chat")[1]!.body as { messages: Array<{ role: string; content: string; images?: string[] }> };
    assert.deepEqual(second.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(second.messages.some((m) => m.images), false);
    assert.match(second.messages[3]!.content, /cannot receive images/);
  } finally {
    await server2.close();
  }
});

// ---- the transport's own timeouts and error sentences ---------------------------------------

const qwen = model({ id: "qwen3.5:27b", capabilities: ["completion", "tools", "vision", "thinking"], sizeBytes: 17e9, contextLength: 262144 });
const req = { model: "qwen3.5:27b", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("local: stall of 60 s → went quiet (the constant, scaled for the test)", async () => {
  const server = await localServer(() => ({ status: 200, ndjson: [chunk({ content: "Fin" })], hang: true }));
  try {
    const t = new OllamaChatTransport({ baseUrl: server.url, fetch, model: qwen, numCtx: 65536, think: false, loaded: () => true, timeouts: { stallMs: 120 } });
    const started = Date.now();
    const turn = await t.complete(req, new AbortController().signal, Date.now() + 60_000, { thinking: () => {} });
    assert.equal(turn.finish, "error");
    assert.equal(turn.error, "the local model went quiet for 0 s");
    assert.ok(Date.now() - started < 3000);
  } finally {
    await server.close();
  }
});

test("local: first-chunk timeout cold vs warm", async () => {
  const server = await localServer(() => ({ status: 200, ndjson: [chunk({ content: "late" }, true)], delayMs: [400] }));
  try {
    const cold = new OllamaChatTransport({ baseUrl: server.url, fetch, model: qwen, numCtx: 65536, think: false, loaded: () => false, timeouts: { firstChunkColdMs: 100, firstChunkWarmMs: 1000, stallMs: 5000 } });
    const thinking: string[] = [];
    const c = await cold.complete(req, new AbortController().signal, Date.now() + 60_000, { thinking: (t) => thinking.push(t) });
    assert.equal(c.finish, "error");
    assert.equal(c.error, "qwen3.5:27b sent nothing for 0 s while loading; is Ollama busy with another model?");
    assert.deepEqual(thinking, ["loading qwen3.5:27b (17 GB)"]);

    const warm = new OllamaChatTransport({ baseUrl: server.url, fetch, model: qwen, numCtx: 65536, think: false, loaded: () => true, timeouts: { firstChunkColdMs: 100, firstChunkWarmMs: 1000, stallMs: 5000 } });
    const w = await warm.complete(req, new AbortController().signal, Date.now() + 60_000, { thinking: () => {} });
    assert.equal(w.finish, "stop", w.error);
    assert.equal(w.content, "late", "a warm model is given its own, shorter budget — 1 s here — and made it");

    const tight = new OllamaChatTransport({ baseUrl: server.url, fetch, model: qwen, numCtx: 65536, think: false, loaded: () => true, timeouts: { firstChunkWarmMs: 5000, stallMs: 5000 } });
    const d = await tight.complete(req, new AbortController().signal, Date.now() + 100, { thinking: () => {} });
    assert.equal(d.error, "I ran out of time", "the deadline wins over every budget");

    const abort = new AbortController();
    const pending = new OllamaChatTransport({ baseUrl: server.url, fetch, model: qwen, numCtx: 65536, think: false, loaded: () => true }).complete(req, abort.signal, Date.now() + 60_000, { thinking: () => {} });
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(pending, "a cancel is the one thing complete() throws for");
  } finally {
    await server.close();
  }
});

test("local: a context 4xx → did not fit … say it in fewer steps; a tools 400 → unready with the badge sentence; the streamed error line too", async () => {
  let mode = "ctx";
  const server = await localServer(() => {
    if (mode === "ctx") return { status: 400, json: { error: "input length exceeds the context length" } };
    if (mode === "tools") return { status: 400, json: { error: '"qwen3.5:27b" does not support tools' } };
    if (mode === "gone") return { status: 404, json: { error: "model 'qwen3.5:27b' not found" } };
    return { status: 200, ndjson: [chunk({ content: "partial" }), { error: "something broke mid-stream: context length" }] };
  });
  try {
    const t = new OllamaChatTransport({ baseUrl: server.url, fetch, model: qwen, numCtx: 65536, think: "low", loaded: () => true });
    const sink = { thinking: () => {} };
    const ctx = await t.complete(req, new AbortController().signal, Date.now() + 60_000, sink);
    assert.equal(ctx.finish, "error");
    assert.equal(ctx.error, "the request did not fit qwen3.5:27b's 64k context; say it in fewer steps");
    assert.equal(ctx.unready, undefined, "a too-long prompt is this turn's problem, not the brain's");

    mode = "tools";
    const tools = await t.complete(req, new AbortController().signal, Date.now() + 60_000, sink);
    assert.equal(tools.error, "qwen3.5:27b cannot call tools; pick a model with the tools badge");
    assert.equal(tools.unready, tools.error);

    mode = "gone";
    const gone = await t.complete(req, new AbortController().signal, Date.now() + 60_000, sink);
    assert.equal(gone.error, "qwen3.5:27b is not on Ollama any more; pick another model");
    assert.equal(gone.unready, gone.error);

    mode = "stream";
    const streamed = await t.complete(req, new AbortController().signal, Date.now() + 60_000, sink);
    assert.equal(streamed.finish, "error");
    assert.match(streamed.error ?? "", /did not fit/);
  } finally {
    await server.close();
  }
});

test("local: warmUp posts /api/generate keep_alive 30m without prompt; cool posts keep_alive 0", async () => {
  const fake: OllamaFake = { shows: 0, models: fixture("warm") };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => true, ramBytes: RAM });
    assert.deepEqual(await brain.warmUp(), { warm: false, detail: "not started" });
    await brain.start();
    assert.equal(brain.status.models.find((m) => m.id === "qwen3.5:27b")?.loaded, false);
    const w = await brain.warmUp();
    assert.equal(w.warm, true);
    assert.match(w.detail, /^Local · qwen3\.5:27b/);
    const gen = server.seen.filter((s) => s.path === "/api/generate");
    assert.equal(gen.length, 1);
    assert.deepEqual(gen[0]!.body, { model: "qwen3.5:27b", keep_alive: "30m", stream: false });
    assert.equal(brain.status.models.find((m) => m.id === "qwen3.5:27b")?.loaded, true, "a preload marks the model loaded, so the next turn gets the warm budget");
    await brain.cool();
    const cooled = server.seen.filter((s) => s.path === "/api/generate")[1]!.body as Record<string, unknown>;
    assert.deepEqual(cooled, { model: "qwen3.5:27b", keep_alive: 0, stream: false });
    assert.equal("prompt" in cooled, false);
    assert.equal(brain.status.models.find((m) => m.id === "qwen3.5:27b")?.loaded, false);
    await brain.stop();
    assert.equal(server.seen.filter((s) => s.path === "/api/generate").length, 2, "stop() does not unload; that is cool()'s job");
  } finally {
    await server.close();
  }
});

test("local: the warm guess ages — /api/ps alone is trusted for Ollama's 5 m default, Jarhead's own chunk or preload for its 30 m keep_alive; a warm guess that saw no chunk flips cold for the next turn", async () => {
  assert.equal(LOCAL_KEEP_ALIVE, "30m", "the string Ollama gets and the span the guess ages by are one constant");
  assert.equal(LOCAL_KEEP_ALIVE_MS, 30 * 60_000);
  assert.equal(LOCAL_SERVER_KEEP_ALIVE_MS, 5 * 60_000);
  const T0 = 1_789_243_208_790;
  let now = T0;
  let answer: "hang" | "chunk" = "hang";
  const fake: OllamaFake = { shows: 0, models: fixture("aging"), loaded: ["qwen3.5:27b"], chat: () => (answer === "hang" ? "hang" : { status: 200, ndjson: [chunk({ content: "here." }, true)] }) };
  const server = await localServer(ollamaRoute(fake));
  // Budgets far apart: the sentence and the "loading …" line say which one was picked, the elapsed time confirms it.
  const timeouts = { firstChunkColdMs: 400, firstChunkWarmMs: 60, stallMs: 5000 };
  const loadedFlag = (b: LocalBrain) => b.status.models.find((m) => m.id === "qwen3.5:27b")?.loaded;
  const turn = async (b: LocalBrain) => {
    const log = makeSink();
    const started = Date.now();
    const r = await b.handle(makeTask("hi"), log.sink);
    return { r, log, ms: Date.now() - started };
  };
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => true, ramBytes: RAM, timeouts, now: () => now });
    assert.equal((await brain.start()).ready, true);
    assert.equal(loadedFlag(brain), true, "discovery saw it in /api/ps");

    // Within Ollama's default keep_alive of the sighting: warm budget, and when nothing comes the guess is dropped.
    now = T0 + 4 * 60_000;
    const warm = await turn(brain);
    assert.equal(warm.r.status, "failed");
    assert.equal(warm.r.error, "qwen3.5:27b sent nothing for 0 s; Ollama is busy or let it go — say it again and I will wait for the load");
    assert.equal(warm.log.thinking.some((t) => t.startsWith("loading ")), false, "a warm guess shows no loading line");
    assert.ok(warm.ms < 300, `the warm budget (60 ms) ended it, not the cold one: ${warm.ms} ms`);
    assert.equal(loadedFlag(brain), false, "the warm guess was wrong, so it is gone");

    // The next turn is cold: the loading line, the long budget, the loading sentence.
    const cold = await turn(brain);
    assert.equal(cold.r.error, "qwen3.5:27b sent nothing for 0 s while loading; is Ollama busy with another model?");
    assert.deepEqual(cold.log.thinking.filter((t) => t.startsWith("loading ")), ["loading qwen3.5:27b (17 GB)"]);
    assert.ok(cold.ms >= 350, `the cold budget (400 ms) ran: ${cold.ms} ms`);

    // A preload marks it loaded at `now`; 29 minutes on it is still warm, 31 minutes on it is cold again.
    assert.equal((await brain.warmUp()).warm, true);
    assert.equal(loadedFlag(brain), true);
    now += 29 * 60_000;
    const stillWarm = await turn(brain);
    assert.match(stillWarm.r.error ?? "", /let it go/);
    assert.ok(stillWarm.ms < 300, `warm budget within keep_alive: ${stillWarm.ms} ms`);
    assert.equal((await brain.warmUp()).warm, true);
    now += 31 * 60_000;
    const aged = await turn(brain);
    assert.match(aged.r.error ?? "", /while loading/, "keep_alive ran out: the weights are gone and the cold budget applies although nothing flipped the flag");
    assert.ok(aged.ms >= 350, `cold budget past keep_alive: ${aged.ms} ms`);
    assert.equal(loadedFlag(brain), true, "the flag itself is discovery's word; only the budget ages it");

    // A turn that answers refreshes the clock from its end: 29 minutes later the guess is still warm.
    answer = "chunk";
    const ok = await turn(brain);
    assert.equal(ok.r.status, "done", ok.r.error);
    now += 29 * 60_000;
    answer = "hang";
    const afterAnswer = await turn(brain);
    assert.match(afterAnswer.r.error ?? "", /let it go/);
    assert.ok(afterAnswer.ms < 300, `a completed turn restarted the 30 m: ${afterAnswer.ms} ms`);
    await brain.stop();

    // A sighting alone, 6 minutes old: Ollama's default keep_alive has passed, so the first turn is cold without any timeout first.
    const later = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => true, ramBytes: RAM, timeouts, now: () => now });
    await later.start();
    assert.equal(loadedFlag(later), true);
    now += 6 * 60_000;
    const stale = await turn(later);
    assert.match(stale.r.error ?? "", /while loading/);
    assert.ok(stale.ms >= 350, `a stale /api/ps sighting gets the cold budget: ${stale.ms} ms`);
    await later.stop();
  } finally {
    await server.close();
  }
});

test("local: LM Studio path uses OpenAIChatTransport with images from vlm and a 401 says LM Studio wants a token", async () => {
  let posts = 0;
  let auth = false;
  const lm = await localServer((req) => {
    if (req.path === "/api/v0/models") return { status: 200, json: { data: [{ id: "qwen2.5-vl-7b-instruct", type: "vlm", state: "loaded", max_context_length: 32768 }, { id: "phi-4", type: "llm", state: "not-loaded", max_context_length: 16384 }] } };
    if (auth && req.headers["authorization"] !== "Bearer lm-token") return { status: 401, json: { error: "Unauthorized" } };
    if (req.path === "/v1/models") return { status: 200, json: { data: [{ id: "qwen2.5-vl-7b-instruct" }, { id: "phi-4" }] } };
    if (req.path === "/v1/chat/completions") {
      posts++;
      const message = posts === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "screenshot", arguments: "{}" } }] } : { role: "assistant", content: "A desktop.", reasoning: "I see icons." };
      return { status: 200, json: { choices: [{ message, finish_reason: posts === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 900, completion_tokens: 12 } } };
    }
    return { status: 404, json: {} };
  });
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: lm.url, model: "", effort: "medium", threads: () => true, ramBytes: RAM });
    const r = await brain.start();
    assert.equal(r.ready, true, r.detail);
    assert.equal(r.detail, `Local · qwen2.5-vl-7b-instruct on LM Studio · 32k ctx · vision · thinking off · ${LOCAL_TOOLS.length} tools · best fit (pick another in Settings)`);
    assert.equal(brain.acceptsImages, true);
    const log = makeSink();
    const res = await brain.handle(makeTask("look"), log.sink);
    assert.equal(res.status, "done", res.error);
    assert.equal(res.summary, "A desktop.");
    assert.ok(log.thinking.includes("I see icons."));
    const second = lm.seen.filter((s) => s.path === "/v1/chat/completions")[1]!.body as { messages: Array<{ role: string; content: unknown }>; tool_choice: string };
    assert.equal(second.tool_choice, "auto");
    assert.deepEqual(second.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
    const parts = second.messages[4]!.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.equal(parts[1]?.type, "image_url");
    assert.ok(parts[1]!.image_url!.url.startsWith("data:image/png;base64,"));
    assert.equal(lm.seen.some((s) => s.path === "/api/chat"), false, "LM Studio speaks Chat Completions, never Ollama's native route");

    const phi = new LocalBrain({ runner, baseUrl: lm.url, model: "phi-4", effort: "medium", threads: () => true, ramBytes: RAM });
    const p = await phi.start();
    assert.match(p.detail, /^Local · phi-4 on LM Studio · 16k ctx · text-only · thinking off · \d+ tools \(draw, automation, browser, thread dropped\) · tools: LM Studio default mode$/);
    assert.equal(phi.acceptsImages, false);

    auth = true;
    const locked = new LocalBrain({ runner, baseUrl: lm.url, model: "", effort: "medium", threads: () => true, ramBytes: RAM });
    const l = await locked.start();
    assert.equal(l.ready, false);
    assert.equal(l.detail, "LM Studio wants a token: put JARHEAD_BRAIN_API_KEY=… in ~/.jarhead/env");
    const keyed = new LocalBrain({ runner, baseUrl: lm.url, model: "", effort: "medium", threads: () => true, ramBytes: RAM, apiKey: "lm-token" });
    const k = await keyed.start();
    assert.equal(k.ready, true, k.detail);
    await brain.stop();
    await keyed.stop();
  } finally {
    await lm.close();
  }
});

test("local: Settings.threads read live — thread_* leave the table without a restart", async () => {
  let threads = true;
  const fake: OllamaFake = { shows: 0, models: fixture("threads") };
  const server = await localServer(ollamaRoute(fake));
  try {
    const { runner } = makeRunner();
    const brain = new LocalBrain({ runner, baseUrl: server.url, model: "qwen3.5:27b", effort: "medium", threads: () => threads, ramBytes: RAM });
    await brain.start();
    await brain.handle(makeTask("a"), makeSink().sink);
    const names = (n: number) => ((server.seen.filter((s) => s.path === "/api/chat")[n]!.body as { tools: Array<{ function: { name: string } }> }).tools ?? []).map((t) => t.function.name);
    assert.ok(names(0).includes("thread_start"));
    threads = false;
    await brain.handle(makeTask("b"), makeSink().sink);
    assert.equal(names(1).includes("thread_start"), false);
    assert.match(brain.detail, new RegExp(`· ${LOCAL_TOOLS.filter((t) => !t.name.startsWith("thread_")).length} tools$`));
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("local: never-writes — no test above asked a local server for anything outside the allowlist", () => {
  assert.deepEqual(violations, []);
});
