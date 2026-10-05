import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_KEYS } from "@jarhead/protocol";

/**
 * W1-11, a hermetic suite. `pnpm test` runs every file behind scripts/test-preload.mjs, so a test
 * never reads Kevin's ~/.jarhead or his shell's keys, never reaches past this Mac, and leaves no
 * temp dir behind. Each case runs a child process, so the claims hold whatever this process was
 * started with. Nothing here opens a socket off the Mac: the off-Mac address is TEST-NET-1
 * (192.0.2.1, never routed), and api.openai.com is asked only after that one answered offline.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRELOAD = join(REPO, "scripts", "test-preload.mjs");
const CANARY = "canary-6b7a12a4";

interface Child {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Node with tsx (and the preload unless `bare`), running `script` as a module from the repo root. */
function child(script: string, env: NodeJS.ProcessEnv, bare = false): Child {
  const imports = bare ? ["--import", "tsx"] : ["--import", "tsx", "--import", PRELOAD];
  const r = spawnSync(process.execPath, [...imports, "--input-type=module", "-e", script], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The last stdout line as JSON (the child prints one). */
function out<T>(r: Child): T {
  assert.equal(r.status, 0, `the child exited ${r.status}: ${r.stderr.slice(-2000)}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "") as T;
}

/** A HOME whose ~/.jarhead/env holds a canary for every secret key, and a shell env that exports more of them. */
function canaryHome(): { root: string; home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "jh-hermetic-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".jarhead"), { recursive: true });
  writeFileSync(join(home, ".jarhead", "env"), SECRET_KEYS.map((k) => `${k}=sk-${CANARY}-file-${k}`).join("\n") + "\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    JARHEAD_STATE_DIR: join(home, ".jarhead"),
    JARHEAD_SOCKET: join(home, ".jarhead", "jarhead.sock"),
    JARHEAD_AUTO_WAKE: "1",
    JARHEAD_TEST_NET: "",
    JARHEAD_TEST_NET_LOG: join(root, "net.log"),
  };
  for (const k of SECRET_KEYS) env[k] = `sk-${CANARY}-shell-${k}`;
  return { root, home, env };
}

test("pnpm test runs every file behind the preload, imported after tsx; the root asks for pnpm 10 or newer (INS-5)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string>; engines: Record<string, string>; packageManager: string };
  assert.match(pkg.scripts["test"] ?? "", /^node --import tsx --import \.\/scripts\/test-preload\.mjs --test /);
  assert.ok(existsSync(PRELOAD));
  assert.equal(pkg.engines["pnpm"], ">=10");
  assert.ok(Number(/^pnpm@(\d+)\./.exec(pkg.packageManager)?.[1]) >= 10, pkg.packageManager);
});

test("the preload: a canary in ~/.jarhead/env and in the shell never reaches a test; the state dir is a temp dir; off the Mac fetch answers 401 and a WebSocket is refused; loopback goes through; every temp dir is gone at exit", () => {
  const { root, home, env } = canaryHome();
  try {
    const script = `
      import { createServer } from "node:http";
      import { existsSync, mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { readConfig, secretsPresent } from "@jarhead/core";
      const config = readConfig();
      const stateDir = process.env.JARHEAD_STATE_DIR;
      const made = mkdtempSync(join(tmpdir(), "jh-hermetic-made-"));
      const probe = await fetch("http://192.0.2.1/v1/models", { signal: AbortSignal.timeout(3000) });
      const offline = probe.status === 401 && probe.headers.get("x-jarhead-test") === "offline";
      // Only once an unrouted address answered offline: the key probe the engine makes, with whatever key the config holds.
      const openai = offline ? await fetch("https://api.openai.com/v1/models/gpt-live-1", { headers: { authorization: "Bearer " + (config.openaiApiKey ?? "") } }) : undefined;
      const server = createServer((_q, r) => r.end("on this Mac")).listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const local = await (await fetch("http://127.0.0.1:" + server.address().port + "/")).text();
      server.close();
      let ws = "opened";
      try { new WebSocket("ws://192.0.2.1/v1/realtime"); } catch (e) { ws = e.message; }
      console.log(JSON.stringify({
        stateDir, stateExists: existsSync(stateDir), made, madeExists: existsSync(made),
        configCanary: JSON.stringify(config).includes(${JSON.stringify(CANARY)}),
        envCanary: Object.keys(process.env).filter((k) => String(process.env[k]).includes(${JSON.stringify(CANARY)})),
        present: secretsPresent(), socket: process.env.JARHEAD_SOCKET ?? null, autoWake: process.env.JARHEAD_AUTO_WAKE, noAudio: process.env.JARHEAD_NO_AUDIO,
        probe: probe.status, offline, openai: openai?.status ?? null, openaiBody: openai ? await openai.json() : null, local, ws,
      }));
      process.exit(0);
    `;
    const r = out<{ stateDir: string; stateExists: boolean; made: string; madeExists: boolean; configCanary: boolean; envCanary: string[]; present: Record<string, boolean>; socket: string | null; autoWake: string; noAudio: string; probe: number; offline: boolean; openai: number | null; openaiBody: { error: { message: string } } | null; local: string; ws: string }>(child(script, env));
    assert.equal(r.configCanary, false, "readConfig() carries no canary");
    assert.deepEqual(r.envCanary, [], "no canary in the test's env, from the shell or from ~/.jarhead/env");
    assert.deepEqual(r.present, { openai: false, anthropic: false, brainApiKey: false });
    assert.ok(r.stateDir.startsWith(tmpdir()) && !r.stateDir.startsWith(home), `JARHEAD_STATE_DIR is a fresh temp dir, not ~/.jarhead (${r.stateDir})`);
    assert.equal(r.stateExists, true);
    assert.equal(r.socket, null, "JARHEAD_SOCKET is unset: a socket path comes from the temp state dir");
    assert.equal(r.autoWake, "0");
    assert.equal(r.noAudio, "1");
    assert.equal(r.probe, 401);
    assert.equal(r.offline, true, "the answer is the preload's, marked offline");
    assert.equal(r.openai, 401, "the engine's key probe answers 401 with no request made");
    assert.match(r.openaiBody?.error.message ?? "", /^no network in tests: GET https:\/\/api\.openai\.com\/v1\/models\/gpt-live-1$/);
    assert.equal(r.local, "on this Mac", "loopback is untouched (the local model fakes, the daemon's own HTTP)");
    assert.match(r.ws, /^WebSocket refused: ws:\/\/192\.0\.2\.1\/v1\/realtime is off this Mac/);
    assert.equal(r.madeExists, true);
    assert.equal(existsSync(r.made), false, "a temp dir the test made is gone at exit");
    assert.equal(existsSync(r.stateDir), false, "and so is the state dir");
    const log = readFileSync(join(root, "net.log"), "utf8");
    assert.match(log, /^\d+ 401 GET http:\/\/192\.0\.2\.1\/v1\/models$/m);
    assert.match(log, /^\d+ 401 GET https:\/\/api\.openai\.com\/v1\/models\/gpt-live-1$/m);
    assert.match(log, /^\d+ refused WebSocket ws:\/\/192\.0\.2\.1\/v1\/realtime$/m);
    assert.equal(log.includes(CANARY), false, "the log names requests, never what they carried");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JARHEAD_TEST_NET=strict (CI): an off-Mac fetch throws, naming the request, so the test that made it fails by name", () => {
  const { root, env } = canaryHome();
  try {
    const script = `
      let error = null;
      try { await fetch("http://192.0.2.1/v1/models", { method: "POST", signal: AbortSignal.timeout(3000) }); } catch (e) { error = { name: e.name, message: e.message }; }
      console.log(JSON.stringify({ error }));
      process.exit(0);
    `;
    const r = out<{ error: { name: string; message: string } | null }>(child(script, { ...env, JARHEAD_TEST_NET: "strict" }));
    assert.deepEqual(r.error, { name: "TypeError", message: "fetch failed (JARHEAD_TEST_NET=strict: POST http://192.0.2.1/v1/models is off this Mac)" });
    assert.match(readFileSync(join(root, "net.log"), "utf8"), /^\d+ refused POST http:\/\/192\.0\.2\.1\/v1\/models$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("world() builds on testConfig (no key but the fake one, the state under its own dir) and its dirs are gone when the process exits, with no preload to sweep them (BL-14)", () => {
  const { root, home } = canaryHome();
  try {
    // No preload here: world()'s own cleanup is what is pinned. The env is made hermetic by hand.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, JARHEAD_STATE_DIR: join(root, "state"), JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1" };
    for (const k of [...SECRET_KEYS, "JARHEAD_SOCKET"]) delete env[k];
    const script = `
      import { existsSync } from "node:fs";
      import { tempDir, testConfig, world } from "./packages/engine/src/__tests__/world.ts";
      const a = world();
      const b = world({}, { dir: a.dir });
      const t = tempDir("jh-hermetic-temp-");
      const c = a.engine.config;
      console.log(JSON.stringify({ dirs: [a.dir, t], alive: [existsSync(a.dir), existsSync(t)], shared: b.dir === a.dir, key: c.openaiApiKey, keys: [c.anthropicApiKey ?? null, c.brainApiKey ?? null], stateDir: c.stateDir, bare: testConfig(t) }));
      process.exit(0);
    `;
    const r = out<{ dirs: string[]; alive: boolean[]; shared: boolean; key: string; keys: (string | null)[]; stateDir: string; bare: Record<string, unknown> }>(child(script, env, true));
    assert.deepEqual(r.alive, [true, true], "alive while the process runs");
    assert.equal(r.shared, true);
    assert.equal(r.key, "sk-test-not-used");
    assert.deepEqual(r.keys, [null, null]);
    assert.equal(r.stateDir, join(r.dirs[0]!, "state"));
    assert.equal(r.bare["openaiApiKey"], undefined);
    assert.equal(r.bare["brain"], "auto");
    assert.equal(r.bare["stateDir"], join(r.dirs[1]!, "state"));
    for (const d of r.dirs) assert.equal(existsSync(d), false, `${d} is gone after exit`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
