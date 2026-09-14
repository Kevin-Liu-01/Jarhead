import { test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { LocalModel, LocalServerStatus, MemorySummary } from "@jarhead/protocol";
import { dataPaths } from "@jarhead/core";
import { localChecks, memoryChecks, privacyChecks, render, type Check, type MemoryCheckInput } from "../doctor.ts";
import { modelsLines } from "../local-cli.ts";

/**
 * The doctor's `local` and `privacy` groups, and the memory rows under the local brain, without a
 * server, a daemon or the network: every row is a function of one discovery status and the
 * settings; every fix is a command Kevin runs himself. A spy on child_process pins that nothing
 * here spawns `ollama` or `brew` — the doctor reads, it never pulls.
 */

const GIB = 1024 ** 3;
const model = (id: string, over: Partial<LocalModel> = {}): LocalModel => ({ id, capabilities: ["completion", "tools", "vision", "thinking"], sizeBytes: 17e9, contextLength: 262_144, modifiedAt: 2, fit: "good", loaded: false, cloud: false, ...over });

/** `o` without `keys` — exactOptionalPropertyTypes refuses an explicit undefined in a spread. */
function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const out = { ...o } as Record<string, unknown>;
  for (const k of keys) delete out[k as string];
  return out as Omit<T, K>;
}
const up: LocalServerStatus = {
  reachable: true,
  flavor: "ollama",
  version: "0.34.0",
  baseUrl: "http://127.0.0.1:11434",
  models: [model("qwen3.5:27b"), model("qwen3.5:9b", { sizeBytes: 6.6e9, modifiedAt: 1 }), model("gemma3:27b", { capabilities: ["completion", "vision"] }), model("embeddinggemma:latest", { capabilities: ["embedding"], sizeBytes: 621e6, contextLength: 2048 })],
  embedModel: "embeddinggemma:latest",
  ramBytes: 128 * GIB,
  checkedAt: 1,
};
const down: LocalServerStatus = { reachable: false, baseUrl: "", models: [], ramBytes: 128 * GIB, checkedAt: 1 };
const byName = (rows: readonly Check[]): Record<string, Check> => Object.fromEntries(rows.map((r) => [r.name, r]));

// The spy: every execFileSync the doctor's module could reach goes through the CommonJS export, which the
// builtin ESM binding follows after syncBuiltinESMExports(). Nothing under test spawns anything.
const spawned: string[] = [];
const realExecFileSync = cp.execFileSync;
cp.execFileSync = ((file: string, args?: readonly string[]) => {
  spawned.push([file, ...(args ?? [])].join(" "));
  return realExecFileSync(file, args as string[], { encoding: "utf8" });
}) as typeof cp.execFileSync;
const realSpawn = cp.spawn;
cp.spawn = ((file: string, args?: readonly string[]) => {
  spawned.push([file, ...(args ?? [])].join(" "));
  return realSpawn(file, args as string[]);
}) as typeof cp.spawn;
syncBuiltinESMExports();

test("local rows: the server not running is one advisory row (and under local a model row that waits), with the open-Ollama fix; a pinned root is named", () => {
  const auto = localChecks({ status: down, brain: "auto", brainModel: "" });
  assert.deepEqual(auto.map((r) => r.name), ["server"]);
  assert.equal(auto[0]!.group, "local");
  assert.equal(auto[0]!.status, "warn");
  assert.equal(auto[0]!.detail, "not running (127.0.0.1:11434, :1234, :8080)");
  assert.equal(auto[0]!.fix, "open Ollama.app — or brew install --cask ollama-app; see docs/LOCAL.md");
  assert.equal(auto[0]!.required, false, "a Mac without a local server is on the cloud brains, not broken");
  const local = byName(localChecks({ status: down, brain: "local", brainModel: "qwen3.5:27b" }));
  assert.deepEqual(Object.keys(local), ["server", "model"]);
  assert.equal(local["model"]!.status, "warn");
  assert.match(local["model"]!.detail, /^qwen3\.5:27b waits for a server — until one answers the brain's work goes to OpenAI \(memory stays on the Mac\)$/);
  const pinned = localChecks({ status: { ...down, baseUrl: "http://10.0.0.5:11434" }, brain: "local", brainModel: "", brainBaseUrl: "http://10.0.0.5:11434" });
  assert.equal(pinned[0]!.detail, "not answering at http://10.0.0.5:11434");
});

test("local rows: server ok counts models and tool-capable ones; under local the model row is ok for a pick, warn for the best fit (nothing picked), fail with the pull for an id not listed, fail naming the tool-capable ids for one that cannot call tools, fail with the pull when nothing can", () => {
  const picked = byName(localChecks({ status: up, brain: "local", brainModel: "qwen3.5:27b" }));
  assert.deepEqual(Object.keys(picked), ["server", "model", "embeddings"]);
  assert.equal(picked["server"]!.status, "ok");
  assert.equal(picked["server"]!.detail, "Ollama 0.34.0 @ 127.0.0.1:11434 · 4 models · 2 with tools");
  assert.equal(picked["model"]!.status, "ok");
  assert.equal(picked["model"]!.detail, "qwen3.5:27b · tools vision thinking · trained 262144, Jarhead asks 65536 · 17 GB of 128 GB");
  assert.equal(picked["model"]!.fix, undefined);

  const best = byName(localChecks({ status: up, brain: "local", brainModel: "" }));
  assert.equal(best["model"]!.status, "warn");
  assert.match(best["model"]!.detail, /^best fit qwen3\.5:27b \(nothing picked\) · tools vision thinking · trained 262144, Jarhead asks 65536 · 17 GB of 128 GB$/);
  assert.match(best["model"]!.fix ?? "", /pnpm jarhead brain local qwen3\.5:27b/);

  const missing = byName(localChecks({ status: up, brain: "local", brainModel: "qwen3.5:35b" }));
  assert.equal(missing["model"]!.status, "fail");
  assert.equal(missing["model"]!.detail, "qwen3.5:35b not listed on Ollama 0.34.0 (with tools: qwen3.5:27b, qwen3.5:9b)");
  assert.equal(missing["model"]!.fix, "ollama pull qwen3.5:35b");
  assert.equal(missing["model"]!.required, false);

  const noTools = byName(localChecks({ status: up, brain: "local", brainModel: "gemma3:27b" }));
  assert.equal(noTools["model"]!.status, "fail");
  assert.equal(noTools["model"]!.detail, "gemma3:27b cannot call tools — with tools: qwen3.5:27b, qwen3.5:9b");
  assert.match(noTools["model"]!.fix ?? "", /^pick one of qwen3\.5:27b, qwen3\.5:9b in Settings › Brain, or pnpm jarhead brain local qwen3\.5:27b$/);

  const nothing = byName(localChecks({ status: { ...omit(up, "embedModel"), models: [model("gemma3:27b", { capabilities: ["completion", "vision"] })], suggested: { id: "qwen3.5:27b", sizeBytes: 17e9, command: "ollama pull qwen3.5:27b" } }, brain: "local", brainModel: "" }));
  assert.equal(nothing["server"]!.detail, "Ollama 0.34.0 @ 127.0.0.1:11434 · 1 model · 0 with tools");
  assert.equal(nothing["model"]!.status, "fail");
  assert.equal(nothing["model"]!.detail, "nothing on Ollama 0.34.0 can call tools");
  assert.equal(nothing["model"]!.fix, "ollama pull qwen3.5:27b  (17 GB, fits this Mac's 128 GB)");

  // A small trained window says so in the row.
  const small = byName(localChecks({ status: { ...up, models: [model("qwen3.5:4b", { contextLength: 8192, sizeBytes: 3.4e9 })] }, brain: "local", brainModel: "qwen3.5:4b" }));
  assert.match(small["model"]!.detail, /trained 8192, Jarhead asks 8192 \(small: Jarhead's tools alone are ~11k tokens\)/);
  // Under another kind: the server row only.
  assert.deepEqual(localChecks({ status: up, brain: "codex", brainModel: "" }).map((r) => r.name), ["server"]);
});

test("local rows: embeddings ok with the discovered model (the daemon's dims when it answers); warn with the pull when none is pulled — Ollama's is `ollama pull embeddinggemma`", () => {
  const summary: MemorySummary = { enabled: true, count: 1, forgotten: 0, archived: 0, embeddings: "local", embeddingModel: "embeddinggemma:latest", embeddingDims: 768, pending: 0 };
  const withDaemon = byName(localChecks({ status: up, brain: "local", brainModel: "qwen3.5:27b", memory: summary }));
  assert.equal(withDaemon["embeddings"]!.status, "ok");
  assert.equal(withDaemon["embeddings"]!.detail, "embeddinggemma:latest · 768 dims · local");
  const noDaemon = byName(localChecks({ status: up, brain: "local", brainModel: "qwen3.5:27b" }));
  assert.equal(noDaemon["embeddings"]!.detail, "embeddinggemma:latest · local");
  const none = byName(localChecks({ status: omit(up, "embedModel"), brain: "local", brainModel: "qwen3.5:27b" }));
  assert.equal(none["embeddings"]!.status, "warn");
  assert.equal(none["embeddings"]!.detail, "keyword matching until an embedding model is pulled (embeddinggemma, ~300 MB)");
  assert.equal(none["embeddings"]!.fix, "ollama pull embeddinggemma");
  const lm = byName(localChecks({ status: { ...omit(up, "version", "embedModel"), flavor: "lmstudio" }, brain: "local", brainModel: "qwen3.5:27b" }));
  assert.match(lm["embeddings"]!.fix ?? "", /^load an embedding model \(embeddinggemma, nomic-embed-text/);
});

test("privacy rows equal dataPaths(): one ok row per path, name = what, detail = where · detail — the Console's four rows, from the one function", () => {
  const paths = dataPaths({ brain: "local", brainModel: "", brainResolved: "local", brainDetail: "Local · qwen3.5:27b on Ollama 0.34.0", local: { ...up, picked: "qwen3.5:27b" }, memory: { enabled: true, embeddings: "local", embeddingModel: "embeddinggemma:latest", embeddingDims: 768 }, hasOpenAIKey: true, liveModel: "gpt-live-1" });
  const rows = privacyChecks(paths);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.name), ["voice", "brain", "memory", "web"]);
  assert.ok(rows.every((r) => r.group === "privacy" && r.status === "ok" && !r.required && r.fix === undefined), "they inform; nothing to fix");
  assert.deepEqual(
    rows.map((r) => r.detail),
    paths.map((p) => `${p.where} · ${p.detail}`),
  );
  assert.equal(rows[1]!.detail, "mac · qwen3.5:27b on Ollama 0.34.0 — nothing leaves");
  assert.equal(rows[2]!.detail, "mac · embeddings embeddinggemma:latest 768 dims · extractor qwen3.5:27b — nothing leaves");
  assert.match(render(rows).text, /\n {2}privacy\n {4}✔ voice {24}cloud · OpenAI gpt-live-1/);
});

test("memory rows under the local brain: matching names the local space (or keywords) and the extractor is the brain's model on the local server — never the OpenAI plan, whatever the key", () => {
  const base: MemoryCheckInput = { enabled: true, hasOpenAIKey: true, modelIds: new Set(["gpt-5-mini"]), override: undefined, summary: undefined, storeDir: "/tmp/jh/memory", storeRows: 12, localChat: "qwen3.5:27b" };
  const noDaemon = byName(memoryChecks(base));
  assert.match(noDaemon["memory"]!.detail, /^on · matching local \(qwen3\.5:27b on this Mac's server — nothing leaves for memory\) · 12 rows in/);
  assert.equal(noDaemon["extractor"]!.status, "ok");
  assert.equal(noDaemon["extractor"]!.detail, "runs qwen3.5:27b on the local server (Chat Completions JSON mode; rules when it cannot answer) — nothing leaves for memory");
  const summary: MemorySummary = { enabled: true, count: 5, forgotten: 0, archived: 0, embeddings: "local", embeddingModel: "embeddinggemma:latest", embeddingDims: 768, pending: 0, lastRunAt: Date.now() - 60_000, lastRun: { extractor: "local", added: 2, updated: 0, noop: 1, refused: 0, ms: 900 } };
  const withDaemon = byName(memoryChecks({ ...base, summary }));
  assert.match(withDaemon["memory"]!.detail, /matching local embeddings \(embeddinggemma:latest, 768 dims\) · extractor qwen3\.5:27b — nothing leaves for memory · learned 1 min ago \(\+2 · ~0 · 1 noop · local\)/);
  const keywords = byName(memoryChecks({ ...base, summary: { ...omit(summary, "embeddingModel", "embeddingDims"), embeddings: "keyword" } }));
  assert.match(keywords["memory"]!.detail, /matching keywords · extractor qwen3\.5:27b — nothing leaves for memory/);
  const noModel = byName(memoryChecks({ ...base, localChat: "" }));
  assert.equal(noModel["extractor"]!.status, "warn");
  assert.match(noModel["extractor"]!.detail, /^rules until the local brain has a model/);
  // Not local: the rows are as before (the OpenAI plan applies).
  const cloud = byName(memoryChecks({ ...base, localChat: undefined }));
  assert.match(cloud["memory"]!.detail, /matching openai embeddings \(text-embedding-3-small, 512 dims\)/);
  assert.match(cloud["extractor"]!.detail, /^runs gpt-5-mini/);
  for (const c of [...memoryChecks(base), ...memoryChecks({ ...base, summary })]) assert.doesNotMatch(`${c.detail} ${c.fix ?? ""}`, /openai|ChatGPT/i, `nothing about OpenAI under the local brain: ${c.detail}`);
});

test("the doctor reads, never pulls: the child_process spy saw no ollama or brew spawn across every row above and the models table; the commands live only in fix strings", () => {
  // Every pure row once more, plus the table, under the spy.
  localChecks({ status: down, brain: "local", brainModel: "" });
  localChecks({ status: up, brain: "local", brainModel: "" });
  localChecks({ status: { ...omit(up, "embedModel"), models: [] }, brain: "local", brainModel: "" });
  privacyChecks(dataPaths({ brain: "local", brainModel: "", brainDetail: "", local: up, hasOpenAIKey: false, liveModel: "gpt-live-1" }));
  modelsLines({ ...omit(up, "embedModel"), models: [] });
  assert.deepEqual(
    spawned.filter((s) => /\b(ollama|brew|lms)\b/.test(s)),
    [],
    `no spawn of ollama / brew / lms: ${spawned.join("; ")}`,
  );
});
