import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineCommand, LocalModel, LocalServerStatus, Snapshot } from "@jarhead/protocol";
import { BRAIN_WAIT_MS, NO_DAEMON_FOR_BRAIN, brainLines, brainPatch, localStatusLine, modelsLines, parseBrainArgs, runBrain, runModels, type BrainDaemon } from "../local-cli.ts";

/**
 * `jarhead models`, `jarhead brain` and the `local` line of `jarhead status`, without a daemon or
 * a server: the table is a function of the discovery status, the brain verb sends one
 * `set-settings` patch and waits for the snapshot that carries it, and no daemon is a refusal
 * — the daemon owns settings.json.
 */

const GIB = 1024 ** 3;

/** `o` without `keys` — exactOptionalPropertyTypes refuses an explicit undefined in a spread. */
function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const out = { ...o } as Record<string, unknown>;
  for (const k of keys) delete out[k as string];
  return out as Omit<T, K>;
}

const model = (id: string, over: Partial<LocalModel> = {}): LocalModel => ({ id, capabilities: ["completion", "tools", "vision", "thinking"], sizeBytes: 17e9, contextLength: 262_144, fit: "good", loaded: false, cloud: false, ...over });

const status: LocalServerStatus = {
  reachable: true,
  flavor: "ollama",
  version: "0.34.0",
  baseUrl: "http://127.0.0.1:11434",
  models: [
    model("qwen3.5:27b", { loaded: true }),
    model("gemma3:27b", { capabilities: ["completion", "vision"], contextLength: 131_072 }),
    model("embeddinggemma:latest", { capabilities: ["embedding"], sizeBytes: 621e6, contextLength: 2048 }),
    model("glm-5.2:cloud", { cloud: true, sizeBytes: 0, fit: "unknown" }),
  ],
  picked: "qwen3.5:27b",
  embedModel: "embeddinggemma:latest",
  ramBytes: 128 * GIB,
  checkedAt: 1,
};

test("modelsLines: the header counts local models, tool-capable ones and skipped cloud tags; each row is id · size · ctx · badges · fit · loaded · mark; a cloud tag is dimmed and never offered", () => {
  const lines = modelsLines(status, { brain: "qwen3.5:27b", memory: "embeddinggemma:latest" });
  assert.equal(lines[0], "  Ollama 0.34.0 @ 127.0.0.1:11434 · 3 models · 1 with tools · 1 cloud (skipped) · 128 GiB on this Mac");
  assert.match(lines[1]!, /^ {2}qwen3\.5:27b\s+17 GB\s+256k\s+tools vision thinking\s+good\s+loaded\s+← brain$/);
  assert.match(lines[2]!, /^ {2}gemma3:27b\s+17 GB\s+128k\s+vision\s+good$/, "tools-less: no badge for tools, no mark");
  assert.match(lines[3]!, /^ {2}embeddinggemma:latest\s+0\.6 GB\s+2k\s+embedding\s+good\s+← memory$/);
  assert.match(lines[4]!, /^ {2}glm-5\.2:cloud\s+\(cloud — never offered\)$/);
  assert.equal(lines.length, 5, "a list with a tool-capable model prints no pull line");
  // The same model serving both is said once.
  const both = modelsLines({ ...status, models: [model("qwen3.5:27b")] }, { brain: "qwen3.5:27b", memory: "qwen3.5:27b" });
  assert.match(both[1]!, /← brain, memory$/);
});

test("modelsLines: nothing tool-capable prints the pull to run for this Mac; nothing answering says where it looked; a pinned root is named", () => {
  const noTools: LocalServerStatus = { ...omit(status, "picked", "embedModel"), models: [model("gemma3:27b", { capabilities: ["completion", "vision"] })], suggested: { id: "qwen3.5:27b", sizeBytes: 17e9, command: "ollama pull qwen3.5:27b" } };
  const lines = modelsLines(noTools);
  assert.equal(lines.at(-1), "  no models with tools — ollama pull qwen3.5:27b (17 GB; fits this Mac's 128 GiB)");
  assert.deepEqual(modelsLines({ reachable: false, baseUrl: "", models: [], ramBytes: 128 * GIB, checkedAt: 1 }), ["  nothing on 127.0.0.1:11434 / :1234 / :8080 — open Ollama, or see docs/LOCAL.md"]);
  assert.deepEqual(modelsLines({ reachable: false, baseUrl: "http://10.0.0.5:11434", models: [], ramBytes: 128 * GIB, checkedAt: 1 }), ["  nothing on 10.0.0.5:11434 — open Ollama, or see docs/LOCAL.md"]);
  // A tools-less list without a suggestion still names the pull (the RAM tier's).
  const bare = modelsLines(omit(noTools, "suggested"));
  assert.match(bare.at(-1)!, /^ {2}no models with tools — ollama pull \S+ \(\d+ GB; fits this Mac's 128 GiB\)$/);
});

test("runModels: one discovery call (the pinned root when --server is given), the table with the best fit and the embedding model marked, or the status as JSON; nothing is pulled", async () => {
  const calls: { baseUrl?: string | undefined; ramBytes: number }[] = [];
  const discover = (async (o: { baseUrl?: string | undefined; ramBytes: number }) => {
    calls.push(o);
    return status;
  }) as unknown as typeof import("@jarhead/brain").discoverLocalServer;
  const out: string[] = [];
  await runModels({ json: false, discover, ramBytes: 128 * GIB, out: (l) => out.push(l) });
  assert.deepEqual(calls, [{ ramBytes: 128 * GIB }]);
  assert.ok(out.some((l) => /qwen3\.5:27b.*← brain$/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /embeddinggemma:latest.*← memory$/.test(l)));
  out.length = 0;
  await runModels({ json: true, server: "http://10.0.0.5:11434", discover, ramBytes: 128 * GIB, out: (l) => out.push(l) });
  assert.deepEqual(calls[1], { baseUrl: "http://10.0.0.5:11434", ramBytes: 128 * GIB });
  assert.deepEqual(JSON.parse(out.join("\n")), status, "--json prints the discovery status verbatim");
});

test("localStatusLine: flavor · version · N models (M fit) · brain <picked or the setting>; none when nothing answers", () => {
  assert.equal(localStatusLine(status, ""), "  local      ollama 0.34.0 · 4 models (1 fit) · brain qwen3.5:27b");
  assert.equal(localStatusLine(status, "gemma3:27b"), "  local      ollama 0.34.0 · 4 models (1 fit) · brain gemma3:27b", "the setting wins over the pick");
  assert.equal(localStatusLine(omit(status, "picked"), ""), "  local      ollama 0.34.0 · 4 models (1 fit) · brain —");
  assert.equal(localStatusLine({ reachable: false, baseUrl: "", models: [], ramBytes: 0, checkedAt: 0 }, ""), "  local      none");
  assert.equal(localStatusLine(undefined, ""), "  local      none", "a daemon from before the field");
});

/** A snapshot with just what `jarhead brain` reads. */
function snapshotOf(over: { brain?: Snapshot["settings"]["brain"]; brainModel?: string; brainBaseUrl?: string; resolved?: Snapshot["setup"]["brainResolved"]; ready?: boolean; setupBrain?: Snapshot["setup"]["brain"]; local?: LocalServerStatus; dataPaths?: Snapshot["setup"]["dataPaths"] } = {}): Pick<Snapshot, "settings" | "setup" | "brainReady" | "memory"> {
  return {
    settings: { voice: "ballad", brain: over.brain ?? "local", brainModel: over.brainModel ?? "", ...(over.brainBaseUrl ? { brainBaseUrl: over.brainBaseUrl } : {}), effort: "medium", onboarded: true, idleSleepMinutes: 10, autoWake: true, wake: { enabled: true, phrases: ["jarhead"], auth: "touch-id" }, reflexes: true, orbHome: "notch", ledgerRetentionDays: 0, shotsRetentionDays: 14, threads: true, language: "en", accent: "british", memory: true, observe: true, typedWakes: false, threadOverflow: "supersede", warmThreads: 2 },
    setup: {
      openaiKey: "ok",
      brain: over.setupBrain ?? "ok",
      brainDetail: "Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools",
      ...(over.resolved ? { brainResolved: over.resolved } : {}),
      liveModel: "gpt-live-1",
      secrets: { openai: true, anthropic: false, brainApiKey: false },
      local: over.local ?? status,
      dataPaths: over.dataPaths ?? [
        { what: "voice", where: "cloud", detail: "OpenAI gpt-live-1 — every word heard and said; billed per second of open session" },
        { what: "brain", where: "mac", detail: "qwen3.5:27b on Ollama 0.34.0 — nothing leaves" },
        { what: "memory", where: "mac", detail: "embeddings embeddinggemma:latest 768 dims · extractor qwen3.5:27b — nothing leaves" },
        { what: "web", where: "cloud", detail: "the sites you ask for (web_fetch, web_search)" },
      ],
    },
    brainReady: over.ready ?? true,
    memory: { enabled: true, count: 3, forgotten: 0, archived: 0, embeddings: "local", embeddingModel: "embeddinggemma:latest", embeddingDims: 768, pending: 0 },
  };
}

test("brainLines: the setting (best fit named), what runs, and the four data-path rows from the daemon — or the same function over the snapshot when the daemon sent none", () => {
  const lines = brainLines(snapshotOf({ resolved: "local" }));
  assert.deepEqual(lines, [
    "  setting    local · model best fit (qwen3.5:27b)",
    "  running    local · ready — Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools",
    "  leaves the Mac",
    "    voice   cloud  OpenAI gpt-live-1 — every word heard and said; billed per second of open session",
    "    brain   mac    qwen3.5:27b on Ollama 0.34.0 — nothing leaves",
    "    memory  mac    embeddings embeddinggemma:latest 768 dims · extractor qwen3.5:27b — nothing leaves",
    "    web     cloud  the sites you ask for (web_fetch, web_search)",
  ]);
  const pinned = brainLines(snapshotOf({ brainModel: "qwen3.5:27b", brainBaseUrl: "http://10.0.0.5:11434", resolved: "openai-responses", ready: true }));
  assert.equal(pinned[0], "  setting    local · model qwen3.5:27b · server http://10.0.0.5:11434");
  assert.equal(pinned[1], "  running    openai-responses · ready — Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools");
  // No rows from the daemon: computed here from the same function (@jarhead/core dataPaths).
  const computed = brainLines(snapshotOf({ resolved: "local", dataPaths: [] }));
  assert.deepEqual(computed.slice(3), lines.slice(3), "one function, the same four rows");
});

test("parseBrainArgs / brainPatch: no arguments prints; a kind with an optional model and --server is one set-settings patch (server null clears the pin); an unknown kind or a second positional is refused", () => {
  assert.equal(parseBrainArgs([], undefined), undefined);
  assert.deepEqual(parseBrainArgs(["local"], undefined), { kind: "local", model: "", server: undefined });
  assert.deepEqual(parseBrainArgs(["local", "qwen3.5:27b"], "http://10.0.0.5:11434"), { kind: "local", model: "qwen3.5:27b", server: "http://10.0.0.5:11434" });
  assert.deepEqual(brainPatch({ kind: "local", model: "", server: undefined }), { type: "set-settings", patch: { brain: "local", brainModel: "", brainBaseUrl: null } });
  assert.deepEqual(brainPatch({ kind: "openai-compatible", model: "llama-3.3-70b", server: "https://openrouter.ai/api" }), { type: "set-settings", patch: { brain: "openai-compatible", brainModel: "llama-3.3-70b", brainBaseUrl: "https://openrouter.ai/api" } });
  assert.deepEqual(brainPatch({ kind: "auto", model: "", server: undefined }), { type: "set-settings", patch: { brain: "auto", brainModel: "", brainBaseUrl: null } });
  assert.throws(() => parseBrainArgs(["gemini"], undefined), /usage: jarhead brain \[auto\|codex\|claude-code\|anthropic-api\|openai-responses\|openai-compatible\|local\]/);
  assert.throws(() => parseBrainArgs(["local", "a", "b"], undefined), /one model id/);
});

test("runBrain local <model>: sends the patch through the daemon, waits up to BRAIN_WAIT_MS for the snapshot that carries the new setting with the brain re-selected, then prints the lines; the wait is the daemon's snapshots, not a timer; no daemon is the refusal", async () => {
  const sent: EngineCommand[] = [];
  let untilSeen: ((s: ReturnType<typeof snapshotOf>) => boolean) | undefined;
  let waitSeen = 0;
  const landed = snapshotOf({ brainModel: "qwen3.5:27b", resolved: "local" });
  const daemon: BrainDaemon = {
    snapshot: async () => snapshotOf({ resolved: "local" }),
    command: async (cmd, until, waitMs) => {
      sent.push(cmd);
      untilSeen = until;
      waitSeen = waitMs;
      return landed;
    },
  };
  const out: string[] = [];
  await runBrain(["local", "qwen3.5:27b"], undefined, async () => daemon, (l) => out.push(l));
  assert.deepEqual(sent, [{ type: "set-settings", patch: { brain: "local", brainModel: "qwen3.5:27b", brainBaseUrl: null } }]);
  assert.equal(waitSeen, BRAIN_WAIT_MS);
  assert.equal(BRAIN_WAIT_MS, 20_000);
  // The predicate: the new setting AND a re-selected brain; a stale "unchecked" or the old setting does not end the wait.
  assert.equal(untilSeen!(landed), true);
  assert.equal(untilSeen!(snapshotOf({ brainModel: "qwen3.5:27b", setupBrain: "unchecked" })), false, "still re-selecting");
  assert.equal(untilSeen!(snapshotOf({ brainModel: "", resolved: "local" })), false, "the old setting");
  assert.equal(untilSeen!(snapshotOf({ brainModel: "qwen3.5:27b", brainBaseUrl: "http://10.0.0.5:11434", resolved: "local" })), false, "a server still pinned when the pick cleared it");
  assert.equal(out[1], "  sent brain local qwen3.5:27b");
  assert.ok(out.includes("  setting    local · model qwen3.5:27b"), out.join("\n"));
  assert.ok(out.some((l) => /^ {4}brain {3}mac {4}qwen3\.5:27b on Ollama/.test(l)));
  // Best fit: the empty model, said so.
  out.length = 0;
  await runBrain(["local"], undefined, async () => daemon, (l) => out.push(l));
  assert.equal(sent[1]!.type === "set-settings" && sent[1]!.patch.brainModel, "");
  assert.equal(out[1], "  sent brain local (best fit)");
  // The daemon never reports: said, not hung on.
  const silent: BrainDaemon = { ...daemon, command: async () => undefined };
  out.length = 0;
  await runBrain(["auto"], undefined, async () => silent, (l) => out.push(l));
  assert.ok(out.some((l) => /did not report the new brain within 20 s/.test(l)), out.join("\n"));
  // No arguments: the current lines from one snapshot, no command sent.
  out.length = 0;
  const before = sent.length;
  await runBrain([], undefined, async () => daemon, (l) => out.push(l));
  assert.equal(sent.length, before);
  assert.equal(out[1], "  setting    local · model best fit (qwen3.5:27b)");
  // No daemon: refused with the reason; settings.json is never written from here.
  await assert.rejects(
    runBrain(["local"], undefined, async () => {
      throw new Error("no daemon on /tmp/x.sock");
    }, () => undefined),
    new RegExp(NO_DAEMON_FOR_BRAIN.replace(/[()]/g, "\\$&")),
  );
});
