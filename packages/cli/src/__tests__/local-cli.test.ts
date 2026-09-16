import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type EngineCommand, type LocalModel, type LocalServerStatus, type Snapshot } from "@jarhead/protocol";
import { BRAIN_WAIT_MS, DAEMON_PREDATES_LOCAL, NO_DAEMON_FOR_BRAIN, brainLines, brainPatch, landedAfter, localStatusLine, modelsLines, parseBrainArgs, runBrain, runModels, type BrainDaemon } from "../local-cli.ts";

/**
 * `jarhead models`, `jarhead brain` and the `local` line of `jarhead status`, without a daemon or
 * a server: the table is a function of the discovery status, the brain verb sends one
 * `set-settings` patch and waits for the snapshot that carries it with the brain re-selected,
 * and no daemon is a refusal — the daemon owns settings.json.
 *
 * The status fixture is shaped as discovery produces it: `models` holds only the chat models
 * (packages/brain/src/local.ts keeps `!cloud && completion`), the embedding model rides as
 * `embedModel`, and a cloud tag is not there at all.
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
  models: [model("qwen3.5:27b", { loaded: true }), model("gemma3:27b", { capabilities: ["completion", "vision"], contextLength: 131_072 })],
  picked: "qwen3.5:27b",
  embedModel: "embeddinggemma:latest",
  ramBytes: 128 * GIB,
  checkedAt: 1,
};

test("modelsLines: the header counts the chat models, the tool-capable ones and the embedding model; each row is id · size · ctx · badges · fit · loaded · mark; the embedding model (carried as embedModel, never in `models`) gets its own row with the memory mark", () => {
  const lines = modelsLines(status, { brain: "qwen3.5:27b", memory: "embeddinggemma:latest" });
  assert.equal(lines[0], "  Ollama 0.34.0 @ 127.0.0.1:11434 · 2 models · 1 with tools · 1 embedding · 128 GiB on this Mac");
  assert.match(lines[1]!, /^ {2}qwen3\.5:27b\s+17 GB\s+256k\s+tools vision thinking\s+good\s+loaded\s+← brain$/);
  assert.match(lines[2]!, /^ {2}gemma3:27b\s+17 GB\s+128k\s+vision\s+good$/, "tools-less: no badge for tools, no mark");
  assert.match(lines[3]!, /^ {2}embeddinggemma:latest\s+—\s+—\s+embedding\s+—\s+← memory$/, "the row discovery never lists: size and window are not in the status");
  assert.equal(lines.length, 4, "a list with a tool-capable model prints no pull line");
  assert.ok(lines.every((l) => !/cloud/.test(l)), "no cloud rows: discovery drops cloud tags before the status");
  // No embedding model pulled: no row, no count.
  const none = modelsLines(omit(status, "embedModel"), { brain: "qwen3.5:27b" });
  assert.equal(none[0], "  Ollama 0.34.0 @ 127.0.0.1:11434 · 2 models · 1 with tools · 128 GiB on this Mac");
  assert.equal(none.length, 3);
  // The same model serving both is said once, on its one row.
  const both = modelsLines({ ...status, models: [model("qwen3.5:27b")], embedModel: "qwen3.5:27b" }, { brain: "qwen3.5:27b", memory: "qwen3.5:27b" });
  assert.match(both[1]!, /← brain, memory$/);
  assert.equal(both.length, 2, "an embedding model that is also a chat model is not listed twice");
  assert.doesNotMatch(both[0]!, /embedding/);
});

test("modelsLines: nothing tool-capable prints the pull to run for this Mac on Ollama, and says to load one on LM Studio / llama.cpp (their models are not pulled with `ollama pull`); nothing answering says where it looked; a pinned root is named", () => {
  const noTools: LocalServerStatus = { ...omit(status, "picked", "embedModel"), models: [model("gemma3:27b", { capabilities: ["completion", "vision"] })], suggested: { id: "qwen3.5:27b", sizeBytes: 17e9, command: "ollama pull qwen3.5:27b" } };
  const lines = modelsLines(noTools);
  assert.equal(lines.at(-1), "  no models with tools — ollama pull qwen3.5:27b (17 GB; fits this Mac's 128 GiB)");
  assert.deepEqual(modelsLines({ reachable: false, baseUrl: "", models: [], ramBytes: 128 * GIB, checkedAt: 1 }), ["  nothing on 127.0.0.1:11434 / :1234 / :8080 — open Ollama, or see docs/LOCAL.md"]);
  assert.deepEqual(modelsLines({ reachable: false, baseUrl: "http://10.0.0.5:11434", models: [], ramBytes: 128 * GIB, checkedAt: 1 }), ["  nothing on 10.0.0.5:11434 — open Ollama, or see docs/LOCAL.md"]);
  // A tools-less list without a suggestion still names the pull (the RAM tier's).
  const bare = modelsLines(omit(noTools, "suggested"));
  assert.match(bare.at(-1)!, /^ {2}no models with tools — ollama pull \S+ \(\d+ GB; fits this Mac's 128 GiB\)$/);
  // Discovery sets `suggested` (an `ollama pull`) for every flavour; the table does not repeat it for a server that is not Ollama.
  const lmStudio = modelsLines({ ...omit(noTools, "version"), flavor: "lmstudio", baseUrl: "http://127.0.0.1:1234", models: [] });
  assert.equal(lmStudio[0], "  LM Studio @ 127.0.0.1:1234 · 0 models · 0 with tools · 128 GiB on this Mac");
  assert.equal(lmStudio.at(-1), "  no models with tools — load a model that can call tools in LM Studio");
  const llamaCpp = modelsLines({ ...omit(noTools, "version"), flavor: "llamacpp", baseUrl: "http://127.0.0.1:8080" });
  assert.equal(llamaCpp.at(-1), "  no models with tools — load a model that can call tools in llama.cpp");
  for (const l of [...lmStudio, ...llamaCpp]) assert.doesNotMatch(l, /ollama pull/);
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

test("localStatusLine: flavor · version · N models (M fit), then `brain <the setting or the pick>` only under the local brain — under another kind brainModel is that backend's (cloud) model, so the line says the server is not the brain; none when nothing answers", () => {
  assert.equal(localStatusLine(status, "local", ""), "  local      ollama 0.34.0 · 2 models (1 fit) · brain qwen3.5:27b");
  assert.equal(localStatusLine(status, "local", "gemma3:27b"), "  local      ollama 0.34.0 · 2 models (1 fit) · brain gemma3:27b", "the setting wins over the pick");
  assert.equal(localStatusLine(omit(status, "picked"), "local", ""), "  local      ollama 0.34.0 · 2 models (1 fit) · brain —");
  // Brain openai-compatible with brainModel llama-3.3-70b and Ollama up: the cloud id is not a local brain.
  assert.equal(localStatusLine(omit(status, "picked"), "openai-compatible", "llama-3.3-70b"), "  local      ollama 0.34.0 · 2 models (1 fit) · not the brain (settings: openai-compatible)");
  assert.equal(localStatusLine(omit(status, "picked"), "codex", ""), "  local      ollama 0.34.0 · 2 models (1 fit) · not the brain (settings: codex)");
  assert.equal(localStatusLine(status, "auto", ""), "  local      ollama 0.34.0 · 2 models (1 fit) · not the brain (settings: auto)", "a stale pick is not the brain under auto");
  assert.equal(localStatusLine(status, undefined, "x"), "  local      ollama 0.34.0 · 2 models (1 fit)", "a snapshot without settings: the server alone");
  assert.equal(localStatusLine({ reachable: false, baseUrl: "", models: [], ramBytes: 0, checkedAt: 0 }, "local", ""), "  local      none");
  assert.equal(localStatusLine(undefined, "local", ""), "  local      none", "a daemon from before the field");
});

/** A snapshot with just what `jarhead brain` reads. `noLocal` leaves out `setup.local`, as a daemon from before the field answers. */
function snapshotOf(over: { brain?: Snapshot["settings"]["brain"]; brainModel?: string; brainBaseUrl?: string; resolved?: Snapshot["setup"]["brainResolved"]; ready?: boolean; setupBrain?: Snapshot["setup"]["brain"]; brainDetail?: string; local?: LocalServerStatus; noLocal?: boolean; dataPaths?: Snapshot["setup"]["dataPaths"] } = {}): Pick<Snapshot, "settings" | "setup" | "brainReady" | "memory"> {
  return {
    settings: { voice: "ballad", brain: over.brain ?? "local", brainModel: over.brainModel ?? "", ...(over.brainBaseUrl ? { brainBaseUrl: over.brainBaseUrl } : {}), effort: "medium", onboarded: true, idleSleepMinutes: 10, autoWake: true, wake: { enabled: true, phrases: ["jarhead"], auth: "touch-id" }, reflexes: true, orbHome: "notch", ledgerRetentionDays: 0, shotsRetentionDays: 14, threads: true, language: "en", accent: "british", memory: true, observe: true, typedWakes: false, threadOverflow: "supersede", warmThreads: 2, automations: DEFAULT_SETTINGS.automations, audio: DEFAULT_SETTINGS.audio },
    setup: {
      openaiKey: "ok",
      brain: over.setupBrain ?? "ok",
      brainDetail: over.brainDetail ?? "Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools",
      ...(over.resolved ? { brainResolved: over.resolved } : {}),
      liveModel: "gpt-live-1",
      secrets: { openai: true, anthropic: false, brainApiKey: false },
      ...(over.noLocal ? ({} as { local: LocalServerStatus }) : { local: over.local ?? status }),
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
  // A daemon from before the local brain (no setup.local): the lines still print, and the last one says so — the tolerance is loud.
  const old = brainLines(snapshotOf({ brain: "codex", resolved: "codex", brainDetail: "Codex 0.60", noLocal: true, dataPaths: [] }));
  assert.equal(old[0], "  setting    codex");
  assert.equal(old.at(-1), `  daemon     ${DAEMON_PREDATES_LOCAL}`);
  assert.ok(lines.every((l) => !l.startsWith("  daemon")), "a current daemon: no such line");
});

test("landedAfter: the first snapshot after the patch can carry the new setting with the OLD brain still ok (the engine snapshots 50 ms after the setting, re-selects later) — it does not end the wait; the wait ends once a re-selecting snapshot was followed by one that is not, or, without the first phase, once what runs differs from before", () => {
  const codexDetail = "Codex 0.60 · warm";
  const before = snapshotOf({ brain: "codex", resolved: "codex", brainDetail: codexDetail });
  const pick = { kind: "local" as const, model: "qwen3.5:27b", server: undefined };
  const stale = snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", resolved: "codex", brainDetail: codexDetail, ready: true });
  const reselecting = snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", setupBrain: "unchecked", brainDetail: "restarting", ready: false });
  const landed = snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", resolved: "local" });
  // The sequence the engine produces: stale-ok → unchecked → landed.
  const until = landedAfter(pick, before);
  assert.equal(until(stale), false, "the new setting with the old brain still marked ok is the pre-restart snapshot");
  assert.equal(until(reselecting), false, "still re-selecting");
  assert.equal(until(landed), true);
  // Phase one only needs one of the two signs.
  const uncheckedOnly = landedAfter(pick, before);
  assert.equal(uncheckedOnly(snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", setupBrain: "unchecked", brainDetail: codexDetail })), false);
  assert.equal(uncheckedOnly(snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", resolved: "openai-responses", brainDetail: "Responses gpt-5" })), true, "after the first phase, whatever the brain landed on counts — a fallback included");
  // Without the first phase: the same brain as before is stale, a different one has landed.
  const missedPhaseOne = landedAfter(pick, before);
  assert.equal(missedPhaseOne(stale), false);
  assert.equal(missedPhaseOne(landed), true);
  // The old setting, or a server still pinned when the pick cleared it, never counts.
  const strict = landedAfter(pick, before);
  assert.equal(strict(snapshotOf({ brain: "local", brainModel: "", resolved: "local" })), false, "the old setting");
  assert.equal(strict(snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", brainBaseUrl: "http://10.0.0.5:11434", resolved: "local" })), false, "a server still pinned when the pick cleared it");
  assert.equal(strict(snapshotOf({ brain: "codex", brainModel: "qwen3.5:27b", resolved: "local" })), false, "the wrong kind");
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

test("runBrain local <model>: reads the snapshot before, sends the patch through the daemon, waits up to BRAIN_WAIT_MS for the snapshot that carries the new setting with the brain re-selected (the stale pre-restart one is skipped), then prints the lines and closes once; the wait is the daemon's snapshots, not a timer; no daemon is the refusal", async () => {
  const sent: EngineCommand[] = [];
  let untilSeen: ((s: ReturnType<typeof snapshotOf>) => boolean) | undefined;
  let waitSeen = 0;
  let closed = 0;
  let snapshotsRead = 0;
  // Brain codex, Ollama up, then `brain local qwen3.5:27b`: the engine's snapshots after the patch are stale-ok, re-selecting, landed.
  const codexDetail = "Codex 0.60 · warm";
  const stale = snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", resolved: "codex", brainDetail: codexDetail });
  const reselecting = snapshotOf({ brain: "local", brainModel: "qwen3.5:27b", setupBrain: "unchecked", brainDetail: "restarting", ready: false });
  const landed = snapshotOf({ brainModel: "qwen3.5:27b", resolved: "local" });
  const daemon: BrainDaemon = {
    snapshot: async () => {
      snapshotsRead += 1;
      return snapshotOf({ brain: "codex", resolved: "codex", brainDetail: codexDetail });
    },
    command: async (cmd, until, waitMs) => {
      sent.push(cmd);
      untilSeen = until;
      waitSeen = waitMs;
      return [stale, reselecting, landed].find((s) => until(s));
    },
    close: () => {
      closed += 1;
    },
  };
  const out: string[] = [];
  await runBrain(["local", "qwen3.5:27b"], undefined, async () => daemon, (l) => out.push(l));
  assert.deepEqual(sent, [{ type: "set-settings", patch: { brain: "local", brainModel: "qwen3.5:27b", brainBaseUrl: null } }]);
  assert.equal(waitSeen, BRAIN_WAIT_MS);
  assert.equal(BRAIN_WAIT_MS, 20_000);
  assert.equal(snapshotsRead, 1, "one read before the command: the brain that ran before the pick");
  assert.equal(closed, 1, "one connection, closed once the verb is done");
  // What printed is what landed, not the codex brain the stale snapshot still carried.
  assert.equal(out[1], "  sent brain local qwen3.5:27b");
  assert.ok(out.includes("  setting    local · model qwen3.5:27b"), out.join("\n"));
  assert.ok(out.includes("  running    local · ready — Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools"), out.join("\n"));
  assert.ok(out.every((l) => !/codex/i.test(l)), `the pre-restart brain never prints: ${out.join("\n")}`);
  assert.ok(out.some((l) => /^ {4}brain {3}mac {4}qwen3\.5:27b on Ollama/.test(l)));
  // The predicate handed to the daemon is landedAfter's: the stale snapshot alone never ends the wait.
  assert.equal(landedAfter({ kind: "local", model: "qwen3.5:27b", server: undefined }, snapshotOf({ brain: "codex", resolved: "codex", brainDetail: codexDetail }))(stale), false);
  assert.equal(untilSeen!(snapshotOf({ brainModel: "", resolved: "local" })), false, "the old setting");
  // Best fit: the empty model, said so.
  out.length = 0;
  await runBrain(["local"], undefined, async () => daemon, (l) => out.push(l));
  assert.equal(sent[1]!.type === "set-settings" && sent[1]!.patch.brainModel, "");
  assert.equal(out[1], "  sent brain local (best fit)");
  // The daemon never reports: said, not hung on; still closed.
  const silent: BrainDaemon = { ...daemon, command: async () => undefined };
  out.length = 0;
  closed = 0;
  await runBrain(["auto"], undefined, async () => silent, (l) => out.push(l));
  assert.ok(out.some((l) => /did not report the new brain within 20 s/.test(l)), out.join("\n"));
  assert.equal(closed, 1);
  // No arguments: the current lines from one snapshot, no command sent, closed.
  out.length = 0;
  closed = 0;
  const before = sent.length;
  const current: BrainDaemon = { ...daemon, snapshot: async () => snapshotOf({ resolved: "local" }) };
  await runBrain([], undefined, async () => current, (l) => out.push(l));
  assert.equal(sent.length, before);
  assert.equal(out[1], "  setting    local · model best fit (qwen3.5:27b)");
  assert.equal(closed, 1);
  // A daemon from a build before the local brain (no setup.local): a pick is refused before anything is sent — that daemon would write the setting and land on Responses without a word.
  closed = 0;
  const old: BrainDaemon = { ...daemon, snapshot: async () => snapshotOf({ brain: "codex", resolved: "codex", brainDetail: codexDetail, noLocal: true }) };
  await assert.rejects(runBrain(["local", "qwen3.5:27b"], undefined, async () => old, () => undefined), new RegExp(`the daemon ${DAEMON_PREDATES_LOCAL.replace(/[()]/g, "\\$&")}; nothing was sent`));
  assert.equal(sent.length, before, "nothing sent to the old daemon");
  assert.equal(closed, 1, "closed on the refusal too");
  // No daemon: refused with the reason; settings.json is never written from here.
  await assert.rejects(
    runBrain(["local"], undefined, async () => {
      throw new Error("no daemon on /tmp/x.sock");
    }, () => undefined),
    new RegExp(NO_DAEMON_FOR_BRAIN.replace(/[()]/g, "\\$&")),
  );
});
