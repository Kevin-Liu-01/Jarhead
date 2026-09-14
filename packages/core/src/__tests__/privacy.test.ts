import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataPath, LocalModel, LocalServerStatus } from "@jarhead/protocol";
import { dataPaths, type DataPathsInput } from "../privacy.ts";

// The four "where words go" rows the Console's "Leaves the Mac" section and `pnpm jarhead
// doctor` both print from this one function. Each case pins the `where` column and the words
// that carry the promise; every detail is one line and no row claims the Mac as a whole.

const QWEN: LocalModel = { id: "qwen3.5:27b", capabilities: ["completion", "tools", "vision", "thinking"], sizeBytes: 17e9, contextLength: 262144, fit: "good", loaded: true, cloud: false };
const EMBED: LocalModel = { id: "embeddinggemma", capabilities: ["embedding"], sizeBytes: 3e8, fit: "good", loaded: false, cloud: false };

function ollama(baseUrl: string): LocalServerStatus {
  return { reachable: true, flavor: "ollama", version: "0.34.0", baseUrl, models: [QWEN, EMBED], picked: "qwen3.5:27b", embedModel: "embeddinggemma", ramBytes: 128 * 2 ** 30, checkedAt: 1_789_243_208_790 };
}

const NONE: LocalServerStatus = { reachable: false, baseUrl: "", models: [], ramBytes: 128 * 2 ** 30, checkedAt: 0 };

const localMemory = { enabled: true, embeddings: "local", embeddingModel: "embeddinggemma", embeddingDims: 768 } as const;
const openaiMemory = { enabled: true, embeddings: "openai", embeddingModel: "text-embedding-3-small", embeddingDims: 512 } as const;
const keywordMemory = { enabled: true, embeddings: "keyword" } as const;

const base: DataPathsInput = { brain: "local", brainModel: "", brainResolved: "local", brainDetail: "Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools", local: ollama("http://127.0.0.1:11434"), memory: localMemory, hasOpenAIKey: true, liveModel: "gpt-live-1" };

function rows(i: DataPathsInput): { paths: DataPath[]; where: string[]; byWhat: Record<string, DataPath> } {
  const paths = dataPaths(i);
  const byWhat: Record<string, DataPath> = {};
  for (const p of paths) byWhat[p.what] = p;
  return { paths, where: paths.map((p) => p.where), byWhat };
}

/** The invariants every case shares: four rows in order, one line each, the promise per row never about Jarhead whole. */
function wellFormed(paths: DataPath[]): void {
  assert.deepEqual(paths.map((p) => p.what), ["voice", "brain", "memory", "web"], "four rows, voice · brain · memory · web");
  for (const p of paths) {
    assert.ok(p.detail.length > 0, `${p.what} has a detail`);
    assert.equal(p.detail.includes("\n"), false, `${p.what} is one line`);
    assert.equal(/nothing leaves the Mac/i.test(p.detail), false, `${p.what} does not claim the whole Mac: ${p.detail}`);
  }
  assert.equal(paths[0]?.where, "cloud", "the voice is always cloud");
  assert.match(paths[0]?.detail ?? "", /^OpenAI gpt-live-1 — every word heard and said; billed per second/);
  assert.equal(paths[3]?.where, "cloud", "the web is the sites Kevin asks for");
  assert.match(paths[3]?.detail ?? "", /web_fetch, web_search/);
}

test("(a) a local brain on loopback with a local embedder: voice cloud · brain mac · memory mac · web cloud", () => {
  const { paths, where, byWhat } = rows(base);
  wellFormed(paths);
  assert.deepEqual(where, ["cloud", "mac", "mac", "cloud"]);
  assert.equal(byWhat.brain?.detail, "qwen3.5:27b on Ollama 0.34.0 — nothing leaves", "the brain row names the picked model and the server");
  assert.equal(byWhat.memory?.detail, "embeddings embeddinggemma 768 dims · extractor qwen3.5:27b — nothing leaves");
});

test("(b) the same brain pinned on a LAN box: the brain row is lan and says the words leave for the network", () => {
  const { paths, where, byWhat } = rows({ ...base, local: ollama("http://10.0.0.5:11434") });
  wellFormed(paths);
  assert.deepEqual(where, ["cloud", "lan", "mac", "cloud"]);
  assert.match(byWhat.brain?.detail ?? "", /^qwen3.5:27b on Ollama 0.34.0 at 10\.0\.0\.5:11434 — .*leave for your network$/);
});

test("(c) the fallback: brain local in settings, openai-responses running → brain cloud naming OpenAI, memory still mac (it follows the setting)", () => {
  const { paths, where, byWhat } = rows({ ...base, brainResolved: "openai-responses", brainDetail: "Responses · gpt-5.6-terra", local: NONE });
  wellFormed(paths);
  assert.deepEqual(where, ["cloud", "cloud", "mac", "cloud"]);
  assert.match(byWhat.brain?.detail ?? "", /^OpenAI .*screenshots and tool results leave$/);
  assert.equal(byWhat.brain?.detail.includes("ChatGPT login"), false, "Responses is the key, not the plan");
  assert.equal(byWhat.memory?.where, "mac");
  assert.match(byWhat.memory?.detail ?? "", /^embeddings embeddinggemma 768 dims · extractor .* — nothing leaves$/);
});

test("(d) codex with an OpenAI key and OpenAI embeddings: brain cloud via the ChatGPT login, memory cloud naming what leaves", () => {
  const { paths, where, byWhat } = rows({ brain: "codex", brainModel: "gpt-5.6", brainResolved: "codex", brainDetail: "Codex app-server · gpt-5.6", local: NONE, memory: openaiMemory, hasOpenAIKey: true, liveModel: "gpt-live-1" });
  wellFormed(paths);
  assert.deepEqual(where, ["cloud", "cloud", "cloud", "cloud"]);
  assert.equal(byWhat.brain?.detail, "OpenAI via your ChatGPT login gpt-5.6 — screenshots and tool results leave");
  assert.equal(byWhat.memory?.detail, "text-embedding-3-small + a mini model — item text and closed conversations leave");
});

test("(e) memory disabled → off, whatever the brain; no summary at all reads as off too", () => {
  const { memory: _m, ...noMemory } = base;
  void _m;
  for (const memory of [{ ...localMemory, enabled: false }, { ...openaiMemory, enabled: false }]) {
    const { paths, where } = rows({ ...noMemory, memory });
    wellFormed(paths);
    assert.deepEqual(where, ["cloud", "mac", "off", "cloud"]);
  }
  const absent = rows(noMemory);
  wellFormed(absent.paths);
  assert.deepEqual(absent.where, ["cloud", "mac", "off", "cloud"]);
});

test("(f) keyword matching with no key and a cloud brain → memory mac, 'keywords · rules — nothing leaves'", () => {
  const { paths, where, byWhat } = rows({ brain: "codex", brainModel: "", brainResolved: "codex", brainDetail: "Codex app-server", local: NONE, memory: keywordMemory, hasOpenAIKey: false, liveModel: "gpt-live-1" });
  wellFormed(paths);
  assert.deepEqual(where, ["cloud", "cloud", "mac", "cloud"]);
  assert.equal(byWhat.memory?.detail, "keywords · rules — nothing leaves");
  // Under a local brain the extractor is the brain model, and the row says so.
  const local = rows({ ...base, memory: keywordMemory }).byWhat.memory;
  assert.equal(local?.where, "mac");
  assert.equal(local?.detail, "keywords · extractor qwen3.5:27b — nothing leaves");
});

test("the vendor names: claude-code and anthropic-api say Anthropic, openai-compatible says OpenAI, auto before it resolves is cloud", () => {
  const cloud = (kind: DataPathsInput["brain"], resolved?: DataPathsInput["brainResolved"]): DataPath | undefined =>
    rows({ ...base, brain: kind, brainModel: "", brainDetail: "", ...(resolved ? { brainResolved: resolved } : {}), local: NONE }).byWhat.brain;
  const { brainResolved: _drop, ...unresolved } = base;
  void _drop;
  assert.match(rows({ ...unresolved, brain: "auto", local: NONE }).byWhat.brain?.detail ?? "", /not started yet/);
  assert.equal(cloud("claude-code", "claude-code")?.detail, "Anthropic the backend's default model — screenshots and tool results leave");
  assert.match(cloud("anthropic-api", "anthropic-api")?.detail ?? "", /^Anthropic /);
  assert.match(cloud("openai-compatible", "openai-compatible")?.detail ?? "", /^OpenAI /);
  // An explicit local that has not started yet is cloud-bound while the key is present, and says so.
  const notYet = rows({ ...unresolved, local: NONE }).byWhat.brain;
  assert.equal(notYet?.where, "cloud");
  assert.match(notYet?.detail ?? "", /not running yet — until it is, the brain's work goes to OpenAI/);
  const noKey = rows({ ...unresolved, local: NONE, hasOpenAIKey: false }).byWhat.brain;
  assert.match(noKey?.detail ?? "", /nothing runs the brain until it is/);
});
