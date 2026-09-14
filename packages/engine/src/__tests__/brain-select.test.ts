import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { Brain } from "@jarhead/brain";
import type { LocalServerStatus, Problem, ProblemKind } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { FakeMemoryService, delegate, fakeLocalServer, localModel, localNone, localStatus, noShell, settle, until, world as fullWorld } from "./world.ts";

/** Every engine here runs over the memory stand-in: the real service would build an OpenAI embedder over a fake key (no network in tests). */
const fakeMemory = (): { memory: { service: FakeMemoryService } } => ({ memory: { service: new FakeMemoryService() } });

/**
 * How `auto` picks a brain, with a stand-in Codex CLI and a HOME without a
 * Claude login so the walk down AUTO_BRAIN_ORDER is deterministic: codex →
 * (claude-code, anthropic-api, openai-compatible: not configured) → openai-responses.
 * Nothing here opens a Live session or spawns the real hands helper.
 */

/** A stand-in Codex CLI; `broken` is an install whose binary is there but will not run (`--version` fails). */
function fakeCodex(dir: string, broken = false): string {
  const script = join(dir, "fake-codex.mjs");
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
if (args[0] === "--version") { ${broken ? 'console.error("dyld: missing library"); process.exit(1);' : 'console.log("codex-cli 0.153.4-fake"); process.exit(0);'} }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
console.error("fake codex: unexpected " + args.join(" ")); process.exit(2);
`,
  );
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function codexHome(dir: string, signedIn: boolean): string {
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify(signedIn ? { auth_mode: "chatgpt", tokens: { access_token: "acc", refresh_token: "ref" } } : { auth_mode: "chatgpt", tokens: null }));
  return home;
}

interface World {
  dir: string;
  config: JarheadConfig;
  restore: () => void;
}

/** A state dir, a fake codex, an empty HOME (no ~/.claude), no keys, no server URL. */
function world(brain: JarheadConfig["brain"], signedIn: boolean, opts: { brokenCodex?: boolean; brainModel?: string } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "jh-select-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const saved = { HOME: process.env["HOME"], CODEX_HOME: process.env["CODEX_HOME"] };
  process.env["HOME"] = home;
  process.env["CODEX_HOME"] = codexHome(dir, signedIn);
  const config: JarheadConfig = {
    ...readConfig(),
    brain,
    brainModel: opts.brainModel ?? "",
    brainBaseUrl: undefined,
    anthropicApiKey: undefined,
    claudeBin: undefined,
    codexBin: fakeCodex(dir, opts.brokenCodex ?? false),
    handsBin: join(dir, "no-hands"),
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  return {
    dir,
    config,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

test("auto resolves to codex when the CLI is found and signed in, and says so in setup.brainResolved", async () => {
  const w = world("auto", true);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory() });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "codex");
    assert.equal(engine.brainInfo.ready, true);
    // The stand-in CLI has no app-server, so the brain says it fell back to exec per task and why.
    assert.match(engine.brainInfo.detail, /^Codex 0\.153\.4-fake via JARHEAD_CODEX_BIN, signed in with ChatGPT; default model, effort \w+; tools over a private socket; codex exec per task \(app-server: .+\)$/);
    const snap = engine.snapshot();
    assert.equal(snap.setup.brainResolved, "codex");
    assert.equal(snap.brainReady, true);
    assert.equal(snap.problems.filter((p) => /codex/i.test(p.text)).length, 0);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("auto skips a Codex that is installed but not signed in without a problem line, and lands on openai-responses", async () => {
  const w = world("auto", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory() });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.match(engine.brainInfo.detail, /responses delegation via gpt-5\.6-terra \(auto: no other brain is signed in or configured\)/);
    assert.equal(engine.snapshot().setup.brainResolved, "openai-responses");
    // Not configured is not a problem: no key, no login, nothing Kevin asked for.
    assert.deepEqual(engine.snapshot().problems.filter((p) => /codex|claude|anthropic|compatible/i.test(p.text)), []);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("auto says which configured backend broke when it lands on openai-responses, instead of claiming nothing was configured", async () => {
  // Signed in, binary present, but the binary will not run: configured, and a problem — not "not configured".
  const w = world("auto", true, { brokenCodex: true });
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory() });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.match(engine.brainInfo.detail, /responses delegation via gpt-5\.6-terra \(auto: Codex could not start; no other brain is signed in or configured\)/);
    const problems = engine.snapshot().problems.filter((p) => /codex/i.test(p.text)).map((p) => p.text);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0]!, /^Codex brain unavailable \(.*did not answer --version.*\); trying the next backend$/);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("an explicit codex that cannot start records a problem and walks on down the auto order", async () => {
  const w = world("codex", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory() });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.equal(engine.snapshot().setup.brainResolved, "openai-responses");
    const problems = engine.snapshot().problems.filter((p) => /codex/i.test(p.text)).map((p) => p.text);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0]!, /^Codex brain unavailable \(Codex 0\.153\.4-fake via JARHEAD_CODEX_BIN is not signed in; .*\); trying the next backend$/);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("a test-injected brain is used as-is and does not claim a resolved kind", async () => {
  const w = world("auto", true);
  const brain = { kind: "fake", start: async () => ({ ready: true, detail: "fake" }), handle: async () => ({ status: "done" as const }), cancel: async () => undefined, stop: async () => undefined };
  const engine = new Engine({ config: w.config, connectors: [], brain, exec: noShell, ...fakeMemory() });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "fake");
    assert.equal(engine.snapshot().setup.brainResolved, undefined);
    assert.equal(engine.snapshot().memory?.embeddings, "keyword", "the memory stand-in, never an OpenAI embedder over the fake key");
  } finally {
    await engine.stop();
    w.restore();
  }
});

// ---- the local brain -------------------------------------------------------------------------
// Explicit only: `local` is Kevin's pick in Settings › Brain, never auto's. Discovery is answered
// by the `discoverLocal` seam; the brain's own probe (GET /v1/models) and memory's calls go to a
// tiny HTTP stand-in for Ollama that records every request and refuses anything but reads.

const ofKind = (engine: Engine, kind: ProblemKind): readonly Problem[] => engine.typedProblems().filter((p) => p.kind === kind);
const LOCAL_REMEDY = { label: "Retry", command: { type: "problem.retry", kind: "brain.local" } };
const BRAIN_REMEDY = { label: "Retry", command: { type: "problem.retry", kind: "brain.unavailable" } };
const SETUP_REMEDY = { label: "Open Setup", open: "jarhead://setup" };

/** A scripted discovery: what the next look answers, and how many looks were made. */
function scriptedDiscovery(first: LocalServerStatus): { answer: LocalServerStatus; looks: number; discoverLocal: () => Promise<LocalServerStatus> } {
  const d = { answer: first, looks: 0, discoverLocal: async (): Promise<LocalServerStatus> => ({ ...d.answer, checkedAt: Date.now() }) };
  const inner = d.discoverLocal;
  d.discoverLocal = () => {
    d.looks++;
    return inner();
  };
  return d;
}

test("explicit local with a reachable server and an empty brainModel: ready as `local`, the detail opens Local · qwen3.5:27b, setup.local.picked names the best fit, settings.json is not written, the brain row says nothing leaves", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b", "gemma3:27b"]);
  const w = world("local", false);
  const status = localStatus(server.url, [localModel("qwen3.5:27b"), localModel("gemma3:27b", { capabilities: ["completion", "vision"] })]);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => status });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "local");
    assert.equal(engine.brainInfo.ready, true);
    assert.match(engine.brainInfo.detail, /^Local · qwen3\.5:27b on Ollama 0\.34\.0 · 64k ctx · vision · thinking \w+ · \d+ tools.*best fit \(pick another in Settings\)$/);
    const snap = engine.snapshot();
    assert.equal(snap.setup.brainResolved, "local");
    assert.equal(snap.setup.brain, "ok");
    assert.equal(snap.setup.local.reachable, true);
    assert.equal(snap.setup.local.picked, "qwen3.5:27b", "the engine reports its pick on the snapshot");
    assert.equal(snap.settings.brainModel, "", "…and never writes it into the setting");
    assert.equal(existsSync(join(w.config.stateDir, "settings.json")), false, "settings.json is not written by brain selection");
    assert.deepEqual(ofKind(engine, "brain.local"), []);
    assert.deepEqual(ofKind(engine, "brain.unavailable"), []);
    const brainRow = snap.setup.dataPaths.find((p) => p.what === "brain")!;
    assert.deepEqual(brainRow, { what: "brain", where: "mac", detail: "qwen3.5:27b on Ollama 0.34.0 — nothing leaves" });
    assert.deepEqual(snap.setup.dataPaths.map((p) => p.what), ["voice", "brain", "memory", "web"]);
    assert.equal(snap.setup.dataPaths.find((p) => p.what === "memory")!.where, "mac");
    assert.ok(server.seen.some((r) => r.method === "GET" && r.path === "/v1/models"), "the compatible probe read the model list");
    assert.deepEqual(server.violations, [], "never-writes: nothing but reads reached the server");
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

test("explicit local with nothing reachable: an amber brain.local row with Retry and the docs/LOCAL.md sentence, the loud fallback line, brainResolved openai-responses — and memory stays on the Mac", async () => {
  const w = world("local", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => localNone() });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "openai-responses");
    const snap = engine.snapshot();
    assert.equal(snap.setup.brainResolved, "openai-responses");
    const local = ofKind(engine, "brain.local");
    assert.equal(local.length, 1, JSON.stringify(engine.typedProblems()));
    assert.equal(local[0]!.text, "Local brain: nothing answers on this Mac (127.0.0.1:11434, :1234, :8080). Open Ollama, or install it — see docs/LOCAL.md.");
    assert.deepEqual(local[0]!.remedy, LOCAL_REMEDY);
    const loud = ofKind(engine, "brain.unavailable");
    assert.equal(loud.length, 1);
    assert.match(loud[0]!.text, /^Local brain unavailable \(.+\); using the OpenAI backend instead — until it is back, the brain's work goes to OpenAI too\. Memory stays local\.$/);
    assert.deepEqual(loud[0]!.remedy, BRAIN_REMEDY, "a brain row's Retry restarts the brain, never config.probe");
    // The setting is `local`: the brain row turns cloud and says so; memory's row stays on the Mac.
    assert.equal(snap.setup.dataPaths.find((p) => p.what === "brain")!.where, "cloud");
    assert.equal(snap.setup.dataPaths.find((p) => p.what === "memory")!.where, "mac");
    assert.equal(snap.setup.local.reachable, false);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("explicit local, a server with nothing that can call tools: the row carries the pull to run and remedy.copy is the command", async () => {
  const w = world("local", false);
  const status = localStatus("http://127.0.0.1:11434", [localModel("gemma3:27b", { capabilities: ["completion", "vision"] })], { suggested: { id: "qwen3.5:27b", sizeBytes: 17e9, command: "ollama pull qwen3.5:27b" } });
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => status });
  try {
    await engine.start();
    await engine.ready();
    const local = ofKind(engine, "brain.local");
    assert.equal(local.length, 1);
    assert.equal(local[0]!.text, "Local brain: Ollama 0.34.0 is up but nothing on it can call tools. In a terminal: ollama pull qwen3.5:27b (17 GB, fits this Mac).");
    assert.deepEqual(local[0]!.remedy, { ...LOCAL_REMEDY, copy: "ollama pull qwen3.5:27b" });
    assert.equal(engine.brainInfo.kind, "openai-responses");
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("explicit local, the picked id is not on the server: Open Setup with the pull as copy, the listed ids named", async () => {
  const w = world("local", false, { brainModel: "qwen3.5:9b" });
  const status = localStatus("http://127.0.0.1:11434", [localModel("qwen3.5:27b"), localModel("gemma4:26b")]);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => status });
  try {
    await engine.start();
    await engine.ready();
    const local = ofKind(engine, "brain.local");
    assert.equal(local.length, 1);
    assert.equal(local[0]!.text, "Local brain: qwen3.5:9b is not on Ollama 0.34.0 (it has qwen3.5:27b, gemma4:26b). Pull it, or pick another.");
    assert.deepEqual(local[0]!.remedy, { ...SETUP_REMEDY, copy: "ollama pull qwen3.5:9b" });
    assert.equal(engine.snapshot().setup.local.picked, undefined, "nothing was picked for him");
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("auto with a reachable local server never picks local (today's walk is unchanged), yet the snapshot carries the server for Setup", async () => {
  const w = world("auto", false);
  const status = localStatus("http://127.0.0.1:11434", [localModel("qwen3.5:27b")]);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => status });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.equal(engine.snapshot().setup.brainResolved, "openai-responses");
    assert.equal(engine.snapshot().setup.local.reachable, true);
    assert.equal(engine.snapshot().setup.local.models[0]!.id, "qwen3.5:27b");
    assert.equal(engine.snapshot().setup.local.picked, undefined, "no pick under auto");
    assert.deepEqual(ofKind(engine, "brain.local"), []);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("problem.retry brain.local re-selects: the server appeared, the Retry lands on the local brain and both rows clear; brain.unavailable's Retry is problem.retry too", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b"]);
  const d = scriptedDiscovery(localNone());
  const w = world("local", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: d.discoverLocal });
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.equal(ofKind(engine, "brain.local").length, 1);
    d.answer = localStatus(server.url, [localModel("qwen3.5:27b")]);
    await engine.retryProblem("brain.local");
    assert.equal(engine.brainInfo.kind, "local");
    assert.equal(engine.brainInfo.ready, true);
    assert.deepEqual(ofKind(engine, "brain.local"), []);
    assert.deepEqual(ofKind(engine, "brain.unavailable"), [], "the loud fallback line goes with it");
    assert.equal(engine.snapshot().setup.brainResolved, "local");
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

test("a configured backend that cannot start carries problem.retry brain.unavailable as its remedy, not config.probe (which never re-selects)", async () => {
  const w = world("codex", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => localNone() });
  try {
    await engine.start();
    await engine.ready();
    const rows = ofKind(engine, "brain.unavailable");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.remedy, BRAIN_REMEDY);
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("the heal timer: under local with nothing answering, a server that appears is picked up within LOCAL_HEAL_MS on the engine clock and the brain restarts onto it; once the local brain is up the timer is disarmed; under another kind it never fires", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b"]);
  const d = scriptedDiscovery(localNone());
  const clock = { t: 1_757_500_000_000 };
  const w = world("local", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, now: () => clock.t, ...fakeMemory(), discoverLocal: d.discoverLocal });
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  try {
    await engine.start();
    await engine.ready();
    await settle(50); // the start-up probeSetup's own look lands
    assert.equal(engine.brainInfo.kind, "openai-responses");
    const looksAtStart = d.looks;
    // Ollama opens. Before the minute is up nothing looks; at the minute the heal looks and restarts onto it.
    d.answer = localStatus(server.url, [localModel("qwen3.5:27b")]);
    clock.t += Engine.LOCAL_HEAL_MS - 1000;
    tick();
    await settle(20);
    assert.equal(d.looks, looksAtStart, "not yet due: no look");
    clock.t += 2000;
    tick();
    assert.ok(await until(() => engine.brainInfo.kind === "local", 5000), `the heal restarted the brain onto the server: ${engine.brainInfo.kind}`);
    assert.equal(engine.brainInfo.ready, true);
    assert.deepEqual(ofKind(engine, "brain.local"), [], "the rows cleared without a click");
    // Disarmed: a minute later nothing looks (the local brain is up).
    const looksAfterHeal = d.looks;
    clock.t += Engine.LOCAL_HEAL_MS + 1000;
    tick();
    await settle(20);
    assert.equal(d.looks, looksAfterHeal, "a ready local brain arms no heal");
    // Another kind: never armed. Kevin picks auto with the server gone; minutes pass; no look.
    d.answer = localNone();
    engine.updateSettings({ brain: "auto" });
    assert.ok(await until(() => engine.brainInfo.kind === "openai-responses", 5000));
    const looksUnderAuto = d.looks;
    clock.t += 3 * Engine.LOCAL_HEAL_MS;
    tick();
    await settle(20);
    assert.equal(d.looks, looksUnderAuto, "under auto the heal timer never fires");
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

/** Counts the restarts the engine runs (the heal timer's, a Retry's, a settings change's) without changing what they do. */
function countRestarts(engine: Engine): { n: number } {
  const c = { n: 0 };
  const orig = engine.restartBrain.bind(engine);
  engine.restartBrain = (reason: string) => {
    c.n++;
    return orig(reason);
  };
  return c;
}

test("the heal timer decides with the start's own resolver: a pinned model the server lists but that cannot call tools is never restarted onto (no restart a minute, forever), while the look itself goes on", async () => {
  const server = await fakeLocalServer(["gemma3:27b"]);
  const d = scriptedDiscovery(localStatus(server.url, [localModel("gemma3:27b", { capabilities: ["completion", "vision"] })]));
  const clock = { t: 1_757_500_000_000 };
  const w = world("local", false, { brainModel: "gemma3:27b" });
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, now: () => clock.t, ...fakeMemory(), discoverLocal: d.discoverLocal });
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  const restarts = countRestarts(engine);
  try {
    await engine.start();
    await engine.ready();
    await settle(50);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    const row = ofKind(engine, "brain.local");
    assert.equal(row.length, 1);
    assert.equal(row[0]!.text, "gemma3:27b cannot call tools; pick a model with the tools badge (pnpm jarhead models)");
    const looksAtStart = d.looks;
    for (let minute = 1; minute <= 3; minute++) {
      clock.t += Engine.LOCAL_HEAL_MS + 500;
      tick();
      await settle(60);
      assert.equal(d.looks, looksAtStart + minute, `minute ${minute}: the timer still looks (a pull would be seen)`);
      assert.equal(restarts.n, 0, `minute ${minute}: no restart onto a pin the start would refuse`);
    }
    assert.equal(engine.brainInfo.kind, "openai-responses", "the fallback brain was never cut");
    assert.deepEqual(ofKind(engine, "brain.local"), row, "the row stands as it was");
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

test("the heal timer takes the unique-name shortcut the resolver takes: brainModel `qwen3.5` with the server listing qwen3.5:27b heals onto it within LOCAL_HEAL_MS, no click", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b"]);
  const d = scriptedDiscovery(localNone());
  const clock = { t: 1_757_500_000_000 };
  const w = world("local", false, { brainModel: "qwen3.5" });
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, now: () => clock.t, ...fakeMemory(), discoverLocal: d.discoverLocal });
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  try {
    await engine.start();
    await engine.ready();
    await settle(50);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    d.answer = localStatus(server.url, [localModel("qwen3.5:27b")]);
    clock.t += Engine.LOCAL_HEAL_MS + 500;
    tick();
    assert.ok(await until(() => engine.brainInfo.kind === "local", 5000), `healed onto the name match: ${engine.brainInfo.kind} (${engine.brainInfo.detail})`);
    assert.match(engine.brainInfo.detail, /^Local · qwen3\.5:27b on Ollama 0\.34\.0/);
    assert.deepEqual(ofKind(engine, "brain.local"), []);
    assert.deepEqual(ofKind(engine, "brain.unavailable"), []);
    assert.equal(engine.snapshot().setup.local.picked, undefined, "a name match is Kevin's pick, not the engine's");
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

test("a server that resolved the pick and still refused the start (a token it was not given) is not restarted onto every minute: the heal waits for the server to change, Retry tries at once, and a changed listing is tried at the next minute", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b"]);
  server.modelsStatus = 401;
  const d = scriptedDiscovery(localStatus(server.url, [localModel("qwen3.5:27b")]));
  const clock = { t: 1_757_500_000_000 };
  const w = world("local", false, { brainModel: "qwen3.5:27b" });
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, now: () => clock.t, ...fakeMemory(), discoverLocal: d.discoverLocal });
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  const restarts = countRestarts(engine);
  try {
    await engine.start();
    await engine.ready();
    await settle(50);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    const row = ofKind(engine, "brain.local");
    assert.equal(row.length, 1);
    assert.match(row[0]!.text, /^Local brain: .*requires an API key \(401\); set JARHEAD_BRAIN_API_KEY$/);
    assert.deepEqual(row[0]!.remedy, LOCAL_REMEDY);
    // Two minutes on the same server: it looks, it does not restart.
    const looksAtStart = d.looks;
    for (let minute = 1; minute <= 2; minute++) {
      clock.t += Engine.LOCAL_HEAL_MS + 500;
      tick();
      await settle(60);
    }
    assert.equal(d.looks, looksAtStart + 2, "the timer looked each minute");
    assert.equal(restarts.n, 0, "an unchanged server that refused is not tried again by the timer");
    // Kevin's Retry is his click: it tries now, and the refusal stands.
    await engine.retryProblem("brain.local");
    assert.equal(restarts.n, 1);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.match(ofKind(engine, "brain.local")[0]!.text, /\(401\)/);
    // The server changes (a second model pulled, the token now accepted): the next minute tries it and lands.
    server.modelsStatus = 200;
    d.answer = localStatus(server.url, [localModel("qwen3.5:27b"), localModel("gemma4:26b")]);
    clock.t += Engine.LOCAL_HEAL_MS + 500;
    tick();
    assert.ok(await until(() => engine.brainInfo.kind === "local", 5000), `a changed server is tried: ${engine.brainInfo.kind}`);
    assert.equal(restarts.n, 2);
    assert.deepEqual(ofKind(engine, "brain.local"), []);
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

test("switching the kind away from local clears the amber brain.local row and the loud fallback line: under auto nothing about the old kind stands", async () => {
  const w = world("auto", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => localNone() });
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ brain: "local" });
    assert.ok(await until(() => ofKind(engine, "brain.local").length === 1, 5000), "local with nothing answering raises the amber row");
    assert.equal(ofKind(engine, "brain.unavailable").filter((p) => p.text.startsWith("Local brain unavailable")).length, 1);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    // Back to Automatic: Codex is not signed in here, so the walk lands on Responses again — under auto, not as a fallback from local.
    engine.updateSettings({ brain: "auto" });
    assert.ok(await until(() => engine.snapshot().setup.brainResolved === "openai-responses" && engine.snapshot().setup.brain === "ok", 5000));
    await settle(50);
    assert.deepEqual(ofKind(engine, "brain.local"), [], "the amber row went with the kind");
    assert.deepEqual(ofKind(engine, "brain.unavailable"), [], "and the 'work goes to OpenAI' line with it");
    assert.equal(engine.snapshot().setup.dataPaths.find((p) => p.what === "brain")!.where, "cloud");
  } finally {
    await engine.stop();
    w.restore();
  }
});

test("a settings change that lands while the heal timer's own restart is past its read of the setting is not swallowed: one more pass selects the new kind", async () => {
  const server = await fakeLocalServer(["qwen3.5:27b"]);
  const d = scriptedDiscovery(localNone());
  const clock = { t: 1_757_500_000_000 };
  const w = world("local", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, now: () => clock.t, ...fakeMemory(), discoverLocal: d.discoverLocal });
  const inner = engine as unknown as { tick(): void; brainRestart: Promise<void> | undefined; localHealAt: number };
  let hooked = 0;
  let restartInFlightAtHook: boolean | undefined;
  // The compatible probe (GET /v1/models) runs inside LocalBrain.start — after startBrain read `settings.brain`. Kevin clicks Backend → Automatic at that instant.
  server.before = (r) => {
    if (r.path !== "/v1/models" || hooked++ > 0) return;
    restartInFlightAtHook = inner.brainRestart !== undefined;
    engine.updateSettings({ brain: "auto" });
  };
  try {
    await engine.start();
    await engine.ready();
    await settle(50);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.notEqual(inner.localHealAt, 0, "the heal is armed under local");
    d.answer = localStatus(server.url, [localModel("qwen3.5:27b")]);
    clock.t += Engine.LOCAL_HEAL_MS + 500;
    inner.tick();
    assert.ok(await until(() => hooked > 0, 5000), "the heal restart reached the probe");
    assert.equal(restartInFlightAtHook, true, "the click landed while the heal restart was in flight");
    assert.ok(await until(() => inner.brainRestart === undefined && engine.brainInfo.ready, 5000), "the restart finished");
    await settle(50);
    assert.equal(engine.currentSettings.brain, "auto");
    assert.equal(engine.brainInfo.kind, "openai-responses", "the brain follows the setting Kevin ended on, not the one the pass started with");
    assert.equal(engine.snapshot().setup.brainResolved, "openai-responses");
    assert.equal(inner.localHealAt, 0, "under auto the heal is disarmed");
    assert.deepEqual(ofKind(engine, "brain.local"), []);
  } finally {
    await engine.stop();
    await server.close();
    w.restore();
  }
});

test("the pre-warm screenshot is skipped for a brain that cannot take pixels (acceptsImages false): its task carries no screen attachment and no screenshot step; a brain that says nothing gets the eyes' shot as before", async () => {
  const tasks: { screen: boolean }[] = [];
  const fake = (acceptsImages: boolean | undefined): Brain => ({
    kind: "fake",
    ...(acceptsImages === undefined ? {} : { acceptsImages }),
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async (task) => {
      tasks.push({ screen: task.attachments?.some((a) => a.kind === "screen") ?? false });
      return { status: "done", summary: "done." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  });
  for (const acceptsImages of [false, undefined]) {
    tasks.length = 0;
    const w = fullWorld({ brain: fake(acceptsImages), discoverLocal: async () => localNone() });
    const { engine } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      await settle(50);
      // Not a reflex phrase: a request only the brain can take.
      delegate(w, "draft an email to Ben about the quarterly numbers", "item_1");
      assert.ok(await until(() => tasks.length === 1, 3000), "the task reached the brain");
      const steps = engine.snapshot().delegations.find((d) => d.liveId === "item_1")?.steps ?? [];
      if (acceptsImages === false) {
        assert.equal(tasks[0]!.screen, false, "text-only brain: no pre-warm shot rides with the task");
        assert.equal(steps.filter((s) => s.kind === "screenshot").length, 0, "and no screenshot step was recorded for it");
      } else {
        assert.equal(tasks[0]!.screen, true, "a brain that takes pixels gets the eyes' shot");
        assert.equal(steps.filter((s) => s.kind === "screenshot").length, 1);
      }
    } finally {
      await engine.stop();
    }
  }
});

test("a brain kind this build does not know is dropped from a settings patch with a warning; the setting keeps its value", async () => {
  const w = world("auto", false);
  const engine = new Engine({ config: w.config, connectors: [], exec: noShell, ...fakeMemory(), discoverLocal: async () => localNone() });
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ brain: "gemini" as never, brainModel: "x" });
    assert.equal(engine.snapshot().settings.brain, "auto");
    assert.equal(engine.snapshot().settings.brainModel, "x", "the rest of the patch lands");
    engine.updateSettings({ brain: "local" });
    assert.equal(engine.snapshot().settings.brain, "local", "a known kind lands");
  } finally {
    await engine.stop();
    w.restore();
  }
});
