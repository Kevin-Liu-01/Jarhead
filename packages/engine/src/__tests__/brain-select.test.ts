import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import { Engine } from "../engine.ts";
import { FakeMemoryService, noShell } from "./world.ts";

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
function world(brain: JarheadConfig["brain"], signedIn: boolean, opts: { brokenCodex?: boolean } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "jh-select-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const saved = { HOME: process.env["HOME"], CODEX_HOME: process.env["CODEX_HOME"] };
  process.env["HOME"] = home;
  process.env["CODEX_HOME"] = codexHome(dir, signedIn);
  const config: JarheadConfig = {
    ...readConfig(),
    brain,
    brainModel: "",
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
