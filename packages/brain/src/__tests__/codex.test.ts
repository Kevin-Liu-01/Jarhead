import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonServer, type EngineLike } from "@jarhead/daemon";
import type { ToolResult } from "@jarhead/hands";
import { CodexBrain, codexAddendum, codexBundleCandidates, codexConfigModel, codexEffort, codexEnv, codexExecArgs, codexSignedIn, daemonPidAt, findCodexBinary, probeCodex, socketAnswers } from "../codex.ts";
import { brainSystemPrompt } from "../brain.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/codex-exec.jsonl", import.meta.url));

/**
 * A stand-in for the Codex CLI: answers --version and `login status`, and on
 * `exec` replays the recorded `codex exec --json` events (fixtures/codex-exec.jsonl,
 * a real run on Kevin's Mac with the bridge attached) or misbehaves per
 * FAKE_CODEX_MODE: hang | fail | turn-failed | crash | signed-out.
 */
function fakeCodex(dir: string): string {
  const script = join(dir, "fake-codex.mjs");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const env = process.env;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args[0] === "--version") { console.log("codex-cli 0.153.4-fake"); process.exit(0); }
if (args[0] === "login") {
  if (env.FAKE_CODEX_MODE === "signed-out") { console.log("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT"); process.exit(0);
}
if (args[0] !== "exec") { console.error("fake codex: unexpected " + args.join(" ")); process.exit(2); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const leaked = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JARHEAD_BRAIN_API_KEY"].filter((k) => env[k] !== undefined);
  if (env.FAKE_CODEX_LOG) writeFileSync(env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), codexHome: env.CODEX_HOME ?? null, leaked }));
  const mode = env.FAKE_CODEX_MODE ?? "ok";
  out({ type: "thread.started", thread_id: "01a0ffff-0000-7000-8000-00000000c0de" });
  out({ type: "turn.started" });
  if (mode === "hang") { process.on("SIGINT", () => { process.stderr.write("fake codex: SIGINT\\n"); process.exit(130); }); setInterval(() => undefined, 1000); return; }
  if (mode === "fail") { out({ type: "error", message: "Codex exploded" }); process.exit(1); }
  if (mode === "turn-failed") { out({ type: "turn.failed", error: { message: "model unavailable" } }); process.exit(0); }
  if (mode === "crash") { out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "half" } }); process.stderr.write("fake codex: segfault\\n"); process.exit(3); }
  for (const line of readFileSync(env.FAKE_CODEX_FIXTURE, "utf8").split("\\n").filter(Boolean)) {
    if (line.includes('"thread.started"') || line.includes('"turn.started"')) continue;
    process.stdout.write(line + "\\n");
    await sleep(Number(env.FAKE_CODEX_DELAY_MS ?? 5));
  }
  process.exit(0);
});
`,
  );
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A CODEX_HOME with auth.json (fake tokens) and optionally a config.toml naming a model. */
function fakeCodexHome(dir: string, opts: { signedIn?: boolean; authFile?: boolean; model?: string } = {}): string {
  const home = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  if (opts.authFile !== false) {
    const auth = opts.signedIn === false ? { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: null } : { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id", access_token: "acc", refresh_token: "ref", account_id: "acct" }, last_refresh: "2026-09-10T00:00:00Z" };
    writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
  }
  if (opts.model) writeFileSync(join(home, "config.toml"), `notify = ["x"]\nmodel = "${opts.model}"\nmodel_reasoning_effort = "xhigh"\n\n[mcp_servers.node_repl]\ncommand = "y"\n`);
  return home;
}

interface ExecLog {
  args: string[];
  prompt: string;
  cwd: string;
  codexHome: string | null;
  /** Jarhead secrets that reached the CLI's environment (must stay empty). */
  leaked: string[];
}

/** A brain over the fake CLI in its own state dir; `t.after` stops it so a failed assertion never leaves a socket open. */
function makeBrain(t: TestContext, opts: { mode?: string; model?: string; socketPath?: string; ownPid?: number; maxSteps?: number; maxWallMs?: number; killGraceMs?: number; configModel?: string; signedIn?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-"));
  const bin = fakeCodex(dir);
  const codexHome = fakeCodexHome(dir, { ...(opts.configModel ? { model: opts.configModel } : {}), ...(opts.signedIn !== undefined ? { signedIn: opts.signedIn } : {}) });
  const logFile = join(dir, "exec.json");
  const { runner } = makeRunner();
  const brain = new CodexBrain({
    runner,
    bin,
    codexHome,
    stateDir: dir,
    socketPath: opts.socketPath ?? join(dir, "no-daemon.sock"),
    ownPid: opts.ownPid,
    model: opts.model,
    effort: "low",
    maxSteps: opts.maxSteps,
    maxWallMs: opts.maxWallMs,
    killGraceMs: opts.killGraceMs ?? 500,
    // Jarhead's secrets are in the daemon's environment; none of them may reach Codex.
    env: { ...process.env, OPENAI_API_KEY: "sk-the-voice-key-must-not-leak", ANTHROPIC_API_KEY: "sk-ant-must-not-leak", JARHEAD_BRAIN_API_KEY: "brain-key-must-not-leak", FAKE_CODEX_FIXTURE: FIXTURE, FAKE_CODEX_LOG: logFile, ...(opts.mode ? { FAKE_CODEX_MODE: opts.mode } : {}) },
  });
  t.after(() => brain.stop());
  const execLog = (): ExecLog => JSON.parse(readFileSync(logFile, "utf8")) as ExecLog;
  return { brain, dir, bin, codexHome, execLog };
}

test("codex: the finder walks JARHEAD_CODEX_BIN, PATH, then the app bundles; auth.json and config.toml are read without a subprocess", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-find-"));
  const bin = fakeCodex(dir);
  assert.deepEqual(findCodexBinary(bin), { path: bin, source: "env", label: "JARHEAD_CODEX_BIN" });
  assert.equal(findCodexBinary(join(dir, "missing")), undefined, "an explicit override that is not there is a definite no");
  assert.deepEqual(findCodexBinary(undefined, { env: { PATH: `/nowhere:${dir}`, HOME: dir }, bundles: [] }), { path: bin, source: "path", label: "PATH" });
  const home = join(dir, "home");
  const bundled = join(home, "Applications", "ChatGPT.app", "Contents", "Resources");
  mkdirSync(bundled, { recursive: true });
  writeFileSync(join(bundled, "codex"), "#!/bin/sh\necho codex-cli 9.9.9\n");
  chmodSync(join(bundled, "codex"), 0o755);
  assert.deepEqual(codexBundleCandidates("/Users/k").slice(0, 2), ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"]);
  const found = findCodexBinary(undefined, { env: { PATH: "/nowhere", HOME: home }, bundles: codexBundleCandidates(home).filter((p) => p.startsWith(home)) });
  assert.equal(found?.path, join(bundled, "codex"));
  assert.equal(found?.source, "bundle");
  assert.equal(found?.label, "ChatGPT.app");
  assert.equal(findCodexBinary(undefined, { env: { PATH: "/nowhere", HOME: join(dir, "empty") }, bundles: [] }), undefined);

  assert.equal(codexSignedIn(fakeCodexHome(join(dir, "a"))), true);
  assert.equal(codexSignedIn(fakeCodexHome(join(dir, "b"), { signedIn: false })), false);
  assert.equal(codexSignedIn(fakeCodexHome(join(dir, "c"), { authFile: false })), undefined);
  assert.equal(codexConfigModel(fakeCodexHome(join(dir, "d"), { model: "gpt-6-astra" })), "gpt-6-astra");
  assert.equal(codexConfigModel(fakeCodexHome(join(dir, "e"))), undefined);

  const probe = await probeCodex({ bin, codexHome: fakeCodexHome(join(dir, "f"), { model: "gpt-6-astra" }) });
  assert.equal(probe.version, "0.153.4-fake");
  assert.equal(probe.signedIn, true);
  assert.equal(probe.authMode, "chatgpt");
  assert.equal(probe.configModel, "gpt-6-astra");
  assert.match(probe.detail, /^Codex 0\.153\.4-fake via JARHEAD_CODEX_BIN, signed in with ChatGPT$/);
  // No auth.json: `codex login status` decides.
  const viaStatus = await probeCodex({ bin, codexHome: fakeCodexHome(join(dir, "g"), { authFile: false }) });
  assert.equal(viaStatus.signedIn, true);
  const out = await probeCodex({ bin, codexHome: fakeCodexHome(join(dir, "h"), { authFile: false }), env: { ...process.env, FAKE_CODEX_MODE: "signed-out" } });
  assert.equal(out.signedIn, false);
  assert.match(out.detail, /not signed in/);
  const none = await probeCodex({ bin: join(dir, "missing") });
  assert.equal(none.bin, undefined);
  assert.match(none.detail, /JARHEAD_CODEX_BIN=.*not an executable/);
  const nothing = await probeCodex({ env: { PATH: "/nowhere", HOME: join(dir, "empty") }, bundles: [], codexHome: join(dir, "empty") });
  assert.equal(nothing.bin, undefined);
  assert.match(nothing.detail, /no codex binary on PATH or in ChatGPT\.app \/ Codex\.app/);
});

test("codex: the exec argv is read-only, ephemeral, user-config-free, and mounts the bridge with approval on", () => {
  const args = codexExecArgs({ cwd: "/tmp/cwd", model: "gpt-6-astra", effort: "max", node: "/usr/local/bin/node", tsxCli: "/repo/node_modules/tsx/dist/cli.mjs", bridgePath: '/repo/pa"th/mcp-bridge.ts', socketPath: "/Users/k/.jarhead/jarhead.sock" });
  assert.equal(args[0], "exec");
  for (const flag of ["--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("-s") + 1], "read-only");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-astra");
  assert.equal(args[args.indexOf("-C") + 1], "/tmp/cwd");
  assert.equal(args[args.length - 1], "-", "the prompt arrives on stdin");
  const configs = args.filter((_, i) => args[i - 1] === "-c");
  assert.ok(configs.includes('model_reasoning_effort="xhigh"'), "max maps to xhigh");
  assert.ok(configs.includes('mcp_servers.jarhead.command="/usr/local/bin/node"'));
  assert.ok(configs.includes('mcp_servers.jarhead.args=["/repo/node_modules/tsx/dist/cli.mjs", "/repo/pa\\"th/mcp-bridge.ts"]'), "TOML basic-string escaping");
  assert.ok(configs.includes('mcp_servers.jarhead.env={JARHEAD_SOCKET="/Users/k/.jarhead/jarhead.sock"}'));
  assert.ok(configs.includes('mcp_servers.jarhead.default_tools_approval_mode="approve"'), "exec's approval policy is never; MCP calls need this");
  assert.ok(configs.includes("mcp_servers.jarhead.tool_timeout_sec=660"));
  assert.equal(codexEffort("medium"), "medium");
  const plain = codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s" });
  assert.ok(!plain.includes("-m") && !plain.some((a) => a.startsWith("model_reasoning_effort")), "no model or effort → Codex's own defaults");
});

test("codex brain: one delegation replays a recorded run through the sink and the summary is the last message", async (t) => {
  const { brain, dir, codexHome, execLog } = makeBrain(t, { configModel: "gpt-6-astra" });
  const started = await brain.start();
  assert.equal(started.ready, true, started.detail);
  assert.match(started.detail, /Codex 0\.153\.4-fake via JARHEAD_CODEX_BIN, signed in with ChatGPT; model gpt-6-astra \(from ~\/\.codex\/config\.toml\), effort low; tools over a private socket/);
  // No daemon answered, so the brain serves the tool socket itself.
  assert.ok(existsSync(join(dir, "codex-tools.sock")));
  assert.equal(await socketAnswers(join(dir, "codex-tools.sock")), true);

  const log = makeSink();
  const result = await brain.handle(makeTask("what app is open"), log.sink);
  assert.equal(result.status, "done");
  assert.equal(result.summary, "Finder is in front.");
  // The narration before the first tool call is relayed as thinking too — the only thing that can break Codex's start-up silence — and the tool calls as usual.
  assert.deepEqual(log.thinking, ["I’ll check the frontmost app and take a screenshot.", "Checking which app is in front.", "Taking a screenshot."]);
  assert.ok(log.steps.some((s) => s.startsWith("note:I’ll check the frontmost app")), `narration before the tools is also a note once superseded: ${log.steps.join(" | ")}`);
  assert.equal(log.commentary.length, 0, "the delegator speaks the summary, not the brain");

  const exec = execLog();
  assert.equal(exec.args[0], "exec");
  assert.equal(exec.args[exec.args.indexOf("-m") + 1], "gpt-6-astra", "brainModel empty → the model from Codex's own config");
  assert.ok(exec.args.includes('model_reasoning_effort="low"'));
  assert.ok(exec.args.includes(`mcp_servers.jarhead.env={JARHEAD_SOCKET=${JSON.stringify(join(dir, "codex-tools.sock"))}}`));
  assert.ok(exec.args.some((a) => a.startsWith("mcp_servers.jarhead.args=[") && a.includes("mcp-bridge.ts")));
  // process.cwd() reports the real path (/private/var…) for a /var temp dir.
  assert.equal(exec.cwd, realpathSync(join(dir, "codex-cwd")), "Codex works in an empty directory of its own");
  assert.equal(exec.codexHome, codexHome);
  assert.deepEqual(exec.leaked, [], "none of Jarhead's secrets reaches Codex; the ChatGPT login does the work");
  const scrubbed = codexEnv({ OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b", JARHEAD_BRAIN_API_KEY: "c", PATH: "/bin" }, "/ch");
  assert.deepEqual(scrubbed, { PATH: "/bin", CODEX_HOME: "/ch" });
  assert.ok(exec.prompt.startsWith(brainSystemPrompt().slice(0, 60)), "the shared standing orders come first");
  assert.ok(exec.prompt.includes(codexAddendum()));
  assert.ok(exec.prompt.includes('Kevin said: "what app is open"'));
  assert.ok(!exec.prompt.includes("Earlier in this session"));

  // The next delegation carries the last exchange as text.
  const again = await brain.handle(makeTask("and now?"), makeSink().sink);
  assert.equal(again.status, "done");
  const second = execLog();
  assert.ok(second.prompt.includes('Earlier in this session:\nKevin said: "what app is open"\nYou answered: Finder is in front.'));
  assert.ok(second.prompt.endsWith('Kevin said: "and now?"'));

  await brain.stop();
  assert.equal(existsSync(join(dir, "codex-tools.sock")), false, "the private socket goes with the brain");
});

test("codex brain: a step budget, an error event, turn.failed, a crash, a cancel and the wall clock all end the task honestly", async (t) => {
  const budget = makeBrain(t, { maxSteps: 1 });
  assert.equal((await budget.brain.start()).ready, true);
  const over = await budget.brain.handle(makeTask("do it"), makeSink().sink);
  assert.equal(over.status, "failed");
  assert.match(over.error ?? "", /stopped after 1 tool calls/);

  for (const [mode, pattern] of [["fail", /Codex exploded/], ["turn-failed", /model unavailable/], ["crash", /exited with code 3 before finishing: fake codex: segfault/]] as const) {
    const b = makeBrain(t, { mode });
    assert.equal((await b.brain.start()).ready, true);
    const r = await b.brain.handle(makeTask("x"), makeSink().sink);
    assert.equal(r.status, "failed", mode);
    assert.match(r.error ?? "", pattern);
  }

  const hang = makeBrain(t, { mode: "hang" });
  assert.equal((await hang.brain.start()).ready, true);
  const abort = new AbortController();
  const pending = hang.brain.handle(makeTask("wait forever", abort.signal), makeSink().sink);
  await new Promise((r) => setTimeout(r, 150));
  abort.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
  // cancel() works the same way, and a brain is free again afterwards.
  const pending2 = hang.brain.handle(makeTask("again"), makeSink().sink);
  await new Promise((r) => setTimeout(r, 150));
  await hang.brain.cancel();
  assert.deepEqual(await pending2, { status: "cancelled" });

  const slow = makeBrain(t, { mode: "hang", maxWallMs: 300 });
  assert.equal((await slow.brain.start()).ready, true);
  const late = await slow.brain.handle(makeTask("x"), makeSink().sink);
  assert.equal(late.status, "failed");
  assert.match(late.error ?? "", /ran out of time after 0 seconds/);
});

test("codex brain: not ready without a login or a binary, and reports why", async (t) => {
  const out = makeBrain(t, { signedIn: false });
  const r = await out.brain.start();
  assert.equal(r.ready, false);
  assert.match(r.detail, /not signed in; sign in to Codex in ChatGPT or run `codex login`/);
  assert.equal((await out.brain.handle(makeTask("x"), makeSink().sink)).status, "failed");

  const dir = mkdtempSync(join(tmpdir(), "jh-codex-nobin-"));
  const none = new CodexBrain({ runner: makeRunner().runner, bin: join(dir, "missing"), stateDir: dir, socketPath: join(dir, "x.sock") });
  t.after(() => none.stop());
  const r2 = await none.start();
  assert.equal(r2.ready, false);
  assert.match(r2.detail, /not an executable/);
});

class ToolOnlyEngine extends EventEmitter implements EngineLike {
  calls: string[] = [];
  ledger = { read: () => [], days: () => [] };
  config = { stateDir: "/tmp/jh-test" };
  runner = { run: async (name: string): Promise<{ result: ToolResult }> => (this.calls.push(name), { result: { kind: "text", text: `${name} ok` } }) };
  snapshot(): unknown {
    return {};
  }
  async command(): Promise<void> {}
  feedMic(): void {}
  reportInputLevel(): void {}
  setMicrophonePermission(): void {}
  registerOwnPid(): void {}
  problem(): void {}
}

test("codex brain: when this process's daemon answers on the socket, the bridge is pointed there and no private socket is opened", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-daemon-"));
  const socketPath = join(dir, "d.sock");
  const server = new DaemonServer(new ToolOnlyEngine(), socketPath);
  await server.listen();
  t.after(() => server.close());
  assert.equal(await daemonPidAt(socketPath), process.pid, "the daemon's hello names its pid");
  assert.equal(await daemonPidAt(join(dir, "none.sock")), undefined);
  const { brain, dir: stateDir, execLog } = makeBrain(t, { socketPath });
  const started = await brain.start();
  assert.equal(started.ready, true, started.detail);
  assert.match(started.detail, /tools over the daemon socket/);
  assert.equal(existsSync(join(stateDir, "codex-tools.sock")), false);
  assert.equal((await brain.handle(makeTask("x"), makeSink().sink)).status, "done");
  assert.ok(execLog().args.includes(`mcp_servers.jarhead.env={JARHEAD_SOCKET=${JSON.stringify(socketPath)}}`));
});

test("codex brain: a daemon that belongs to another process is not trusted with tool.run; the brain serves its own socket", async (t) => {
  // Jarhead.app's daemon on the default path while `jarhead live` hosts this engine, or
  // `jarheadd --socket X` with the default path still busy: same path, foreign runner.
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-foreign-"));
  const socketPath = join(dir, "d.sock");
  const foreign = new ToolOnlyEngine();
  const server = new DaemonServer(foreign, socketPath);
  await server.listen();
  t.after(() => server.close());
  const { brain, dir: stateDir, execLog } = makeBrain(t, { socketPath, ownPid: process.pid + 1 });
  const started = await brain.start();
  assert.equal(started.ready, true, started.detail);
  assert.match(started.detail, /tools over a private socket/);
  assert.ok(existsSync(join(stateDir, "codex-tools.sock")));
  assert.equal((await brain.handle(makeTask("x"), makeSink().sink)).status, "done");
  assert.ok(execLog().args.includes(`mcp_servers.jarhead.env={JARHEAD_SOCKET=${JSON.stringify(join(stateDir, "codex-tools.sock"))}}`));
  assert.deepEqual(foreign.calls, [], "nothing was routed into the other daemon");
});
