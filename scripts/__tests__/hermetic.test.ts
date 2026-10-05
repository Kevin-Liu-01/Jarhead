import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_KEYS } from "@jarhead/protocol";

/**
 * W1-11, a hermetic suite. `pnpm test` runs every file behind scripts/test-preload.mjs, so a test
 * never runs on Kevin's state dir, his shell's keys or his Jarhead settings, never reaches past this
 * Mac, and leaves no temp dir behind. Each case runs a child process, so the claims hold whatever
 * this process was started with. Nothing here opens a socket off the Mac: the off-Mac address is
 * TEST-NET-1 (192.0.2.1, never routed), and api.openai.com is asked only after that one answered
 * offline.
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

/** A secret-named value in ~/.jarhead/env with no secret shape: only a redactor that read the file would strike it. */
const PLAIN_SECRET = `plain-${CANARY}-word`;

/**
 * A HOME whose ~/.jarhead/env holds a canary for every secret key, Jarhead settings and a plain
 * secret-named value, and a shell env that exports more keys and settings: what a self-edit's
 * `pnpm run test` inherits from the daemon, which loaded that file.
 */
function canaryHome(): { root: string; home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "jh-hermetic-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".jarhead"), { recursive: true });
  const file = [...SECRET_KEYS.map((k) => `${k}=sk-${CANARY}-file-${k}`), "JARHEAD_BRAIN=claude-code", `JARHEAD_BRAIN_MODEL=model-${CANARY}`, `SERVICE_TOKEN=${PLAIN_SECRET}`];
  writeFileSync(join(home, ".jarhead", "env"), file.join("\n") + "\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    JARHEAD_STATE_DIR: join(home, ".jarhead"),
    JARHEAD_SOCKET: join(home, ".jarhead", "jarhead.sock"),
    JARHEAD_AUTO_WAKE: "1",
    JARHEAD_BRAIN: "codex",
    JARHEAD_CODEX_BIN: `/${CANARY}/codex`,
    JARHEAD_CLAUDE_BIN: `/${CANARY}/claude`,
    JARHEAD_HANDS_BIN: `/${CANARY}/jarhead-hands`,
    JARHEAD_BRAIN_BASE_URL: `http://${CANARY}.invalid/v1`,
    JARHEAD_IDLE_SLEEP_MINUTES: "1",
    JARHEAD_LOG_LEVEL: "debug",
    JARHEAD_BRAIN_EFFORT: "max",
    JARHEAD_CODEX_SERVICE_TIER: `tier-${CANARY}`,
    JARHEAD_TEST_NET: "",
    JARHEAD_TEST_NET_LOG: join(root, "net.log"),
  };
  for (const k of SECRET_KEYS) env[k] = `sk-${CANARY}-shell-${k}`;
  return { root, home, env };
}

/** Each package's own `test` script, the one `pnpm -C packages/<name> test` runs. */
function packageTestScripts(): { where: string; script: string }[] {
  return readdirSync(join(REPO, "packages"))
    .filter((d) => existsSync(join(REPO, "packages", d, "package.json")))
    .map((d) => {
      const pkg = JSON.parse(readFileSync(join(REPO, "packages", d, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      return { where: `packages/${d}`, script: pkg.scripts?.["test"] ?? "" };
    });
}

test("pnpm test, and each package's own test script, runs every file behind the preload, imported after tsx; the root asks for pnpm 10 or newer (INS-5)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string>; engines: Record<string, string>; packageManager: string };
  assert.match(pkg.scripts["test"] ?? "", /^node --import tsx --import \.\/scripts\/test-preload\.mjs --test /);
  assert.ok(existsSync(PRELOAD));
  const scripts = packageTestScripts();
  assert.ok(scripts.length >= 11, `every package: ${scripts.map((s) => s.where).join(", ")}`);
  for (const { where, script } of scripts) {
    assert.match(script, /^node --import tsx --import \.\.\/\.\.\/scripts\/test-preload\.mjs --test /, `${where}: \`pnpm -C ${where} test\` runs behind the preload`);
    assert.equal(resolve(REPO, where, "../../scripts/test-preload.mjs"), PRELOAD);
  }
  assert.equal(pkg.engines["pnpm"], ">=10");
  assert.ok(Number(/^pnpm@(\d+)\./.exec(pkg.packageManager)?.[1]) >= 10, pkg.packageManager);
});

test("the preload: a canary in ~/.jarhead/env and in the shell never reaches a test, nor a Jarhead setting the shell exports; the state dir is a temp dir; off the Mac fetch answers 401 and a WebSocket is refused; loopback goes through; every temp dir is gone at exit", () => {
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
        jarheadEnv: Object.keys(process.env).filter((k) => k.startsWith("JARHEAD_")).sort(),
        brain: config.brain,
        present: secretsPresent(), socket: process.env.JARHEAD_SOCKET ?? null, autoWake: process.env.JARHEAD_AUTO_WAKE, noAudio: process.env.JARHEAD_NO_AUDIO,
        probe: probe.status, offline, openai: openai?.status ?? null, openaiBody: openai ? await openai.json() : null, local, ws,
      }));
      process.exit(0);
    `;
    const r = out<{ stateDir: string; stateExists: boolean; made: string; madeExists: boolean; configCanary: boolean; envCanary: string[]; jarheadEnv: string[]; brain: string; present: Record<string, boolean>; socket: string | null; autoWake: string; noAudio: string; probe: number; offline: boolean; openai: number | null; openaiBody: { error: { message: string } } | null; local: string; ws: string }>(child(script, env));
    assert.equal(r.configCanary, false, "readConfig() carries no canary: no key, no bin override, no base URL");
    assert.deepEqual(r.envCanary, [], "no canary in the test's env, from the shell or from ~/.jarhead/env");
    assert.deepEqual(r.jarheadEnv, ["JARHEAD_AUTO_WAKE", "JARHEAD_NO_AUDIO", "JARHEAD_STATE_DIR", "JARHEAD_TEST_NET", "JARHEAD_TEST_NET_LOG"], "every other JARHEAD_* the shell exported is unset");
    assert.equal(r.brain, "auto", "JARHEAD_BRAIN=codex in the shell does not pick a test's brain");
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

test("world() builds on testConfig (no key but the fake one, the state under its own dir) and its dirs are gone when the process exits, with no preload to sweep them (BL-14); a dir that cannot be removed stays, and the process still exits 0", () => {
  const { root, home } = canaryHome();
  let stuck: string | undefined;
  try {
    // No preload here: world()'s own cleanup is what is pinned. The env is made hermetic by hand.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, JARHEAD_STATE_DIR: join(root, "state"), JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1" };
    for (const k of [...SECRET_KEYS, "JARHEAD_SOCKET"]) delete env[k];
    const script = `
      import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { tempDir, testConfig, world } from "./packages/engine/src/__tests__/world.ts";
      // First in the sweep: a dir whose inner folder is read-only, as a child still writing into it can leave one. Its rm throws EACCES.
      const stuck = tempDir("jh-hermetic-stuck-");
      mkdirSync(join(stuck, "locked"));
      writeFileSync(join(stuck, "locked", "f"), "x");
      chmodSync(join(stuck, "locked"), 0o500);
      console.log(stuck);
      const a = world();
      const b = world({}, { dir: a.dir });
      const t = tempDir("jh-hermetic-temp-");
      const c = a.engine.config;
      console.log(JSON.stringify({ stuck, dirs: [a.dir, t], alive: [existsSync(a.dir), existsSync(t)], shared: b.dir === a.dir, key: c.openaiApiKey, keys: [c.anthropicApiKey ?? null, c.brainApiKey ?? null], stateDir: c.stateDir, bare: testConfig(t) }));
      // No process.exit(): the process ends on its own, as a test file's does, where a throw in an exit handler exits 1.
    `;
    const res = child(script, env, true);
    stuck = res.stdout.split("\n")[0] || undefined;
    // out() asserts the child exited 0: a throw inside the exit sweep would have made it 1.
    const r = out<{ stuck: string; dirs: string[]; alive: boolean[]; shared: boolean; key: string; keys: (string | null)[]; stateDir: string; bare: Record<string, unknown> }>(res);
    assert.deepEqual(r.alive, [true, true], "alive while the process runs");
    assert.equal(r.shared, true);
    assert.equal(r.key, "sk-test-not-used");
    assert.deepEqual(r.keys, [null, null]);
    assert.equal(r.stateDir, join(r.dirs[0]!, "state"));
    assert.equal(r.bare["openaiApiKey"], undefined);
    assert.equal(r.bare["brain"], "auto");
    assert.equal(r.bare["stateDir"], join(r.dirs[1]!, "state"));
    for (const d of r.dirs) assert.equal(existsSync(d), false, `${d} is gone after exit, though the sweep met a dir it could not remove first`);
    assert.equal(existsSync(join(r.stuck, "locked", "f")), true, "the dir that could not be removed stays");
  } finally {
    if (stuck && existsSync(join(stuck, "locked"))) {
      chmodSync(join(stuck, "locked"), 0o700);
      rmSync(stuck, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("testConfig() is what readConfig() gives with nothing set, but for the socket and the hands helper, which it points into the test's dir on purpose", () => {
  const root = mkdtempSync(join(tmpdir(), "jh-hermetic-"));
  try {
    // No preload: readConfig() over a clean env, nothing JARHEAD_* but the state dir, no key.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), JARHEAD_STATE_DIR: join(root, "state") };
    for (const k of Object.keys(env)) if (k.startsWith("JARHEAD_") && k !== "JARHEAD_STATE_DIR") delete env[k];
    for (const k of SECRET_KEYS) delete env[k];
    const script = `
      import { readConfig } from "@jarhead/core";
      import { testConfig } from "./packages/engine/src/__tests__/world.ts";
      // undefined kept as a value, so a field one side leaves out still shows.
      const keep = (_k, v) => (v === undefined ? "(undefined)" : v);
      console.log(JSON.stringify({ read: JSON.parse(JSON.stringify(readConfig(), keep)), test: JSON.parse(JSON.stringify(testConfig(${JSON.stringify(root)}), keep)) }));
      process.exit(0);
    `;
    const r = out<{ read: Record<string, unknown>; test: Record<string, unknown> }>(child(script, env, true));
    const { socketPath: readSocket, handsBin: readHands, ...read } = r.read;
    const { socketPath: testSocket, handsBin: testHands, ...made } = r.test;
    assert.deepEqual(made, read, "a default in packages/core/src/env.ts changed: testConfig() in packages/engine/src/__tests__/world.ts follows it");
    assert.equal(readSocket, join(root, "state", "jarhead.sock"));
    assert.equal(testSocket, join(root, "state", "j.sock"));
    assert.match(String(readHands), /\/build\/jarhead-hands$/);
    assert.equal(testHands, join(root, "no-hands"), "a test engine never finds the real helper");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the brain runner's redactor reads the state dir's env file, never $HOME/.jarhead/env (W2-9)", () => {
  const { root, env } = canaryHome();
  try {
    const script = `
      import { readConfig } from "@jarhead/core";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { world } from "./packages/engine/src/__tests__/world.ts";
      // The preload's state dir holds an env file of its own, as ~/.jarhead does on a Mac.
      writeFileSync(join(readConfig().stateDir, "env"), "JARHEAD_WAKE_PASSPHRASE=state-dir-${CANARY}\\n", { mode: 0o600 });
      const w = world();
      const redact = (s) => w.engine.runner.redactor.redact(s);
      console.log(JSON.stringify({ home: redact(${JSON.stringify(PLAIN_SECRET)}), state: redact("state-dir-${CANARY}") }));
      process.exit(0);
    `;
    const r = out<{ home: string; state: string }>(child(script, env));
    assert.equal(r.home, PLAIN_SECRET, "a value only $HOME/.jarhead/env names is left alone: the redactor never read that file");
    assert.equal(r.state, "[redacted secret]", "the state dir's env file is the one it reads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
