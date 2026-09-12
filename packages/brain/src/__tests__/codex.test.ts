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
import { appServerArgs } from "../codex-app-server.ts";
import { codexUserMcpServers } from "../codex-config.ts";
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
if (args[0] === "app-server") {
  // The warm transport: JSON-RPC 2.0 over stdio, as 0.153.4 speaks it (see codex-app-server.ts).
  const mode = env.FAKE_CODEX_APPSERVER ?? "absent";
  if (mode === "absent") { console.error("fake codex: no app-server here"); process.exit(2); }
  if (mode === "hang") { setInterval(() => undefined, 1000); }
  // slow-start: thread/start answers only after FAKE_CODEX_APPSERVER_DELAY_MS (a loaded Mac); foreign: the tool calls come from codex_apps.
  const startDelay = mode === "slow-start" ? Number(env.FAKE_CODEX_APPSERVER_DELAY_MS ?? 600) : 0;
  const foreign = mode === "foreign";
  const leaked = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JARHEAD_BRAIN_API_KEY"].filter((k) => env[k] !== undefined);
  const requests = [];
  const record = () => { if (env.FAKE_CODEX_LOG) writeFileSync(env.FAKE_CODEX_LOG + ".appserver", JSON.stringify({ args, cwd: process.cwd(), codexHome: env.CODEX_HOME ?? null, leaked, requests })); };
  record();
  let threadN = 0, turnN = 0, interrupted = false, buf = "";
  const notif = (method, params) => out({ jsonrpc: "2.0", method, params });
  async function runTurn(turnId, threadId, params) {
    const p = { threadId, turnId };
    notif("turn/started", { ...p, turn: { id: turnId, status: "inProgress" } });
    if (mode === "hang-turn") { const wait = setInterval(() => { if (interrupted) { clearInterval(wait); notif("turn/completed", { ...p, turn: { id: turnId, status: "interrupted", error: null } }); } }, 20); return; }
    if (mode === "die-turn") { process.stderr.write("fake app-server: crashed mid-turn\\n"); process.exit(3); }
    for (const line of readFileSync(env.FAKE_CODEX_FIXTURE, "utf8").split("\\n").filter(Boolean)) {
      if (interrupted) { notif("turn/completed", { ...p, turn: { id: turnId, status: "interrupted", error: null } }); return; }
      const ev = JSON.parse(line);
      const it = ev.item ?? {};
      if (ev.type === "item.completed" && it.type === "agent_message") {
        notif("item/started", { ...p, item: { type: "agentMessage", id: it.id, text: "", phase: "final_answer" } });
        notif("item/agentMessage/delta", { ...p, itemId: it.id, delta: it.text });
        notif("item/completed", { ...p, item: { type: "agentMessage", id: it.id, text: it.text, phase: "final_answer" } });
      } else if (it.type === "mcp_tool_call") {
        const item = { type: "mcpToolCall", id: it.id, server: foreign ? "codex_apps" : it.server, tool: foreign ? "google_drive.delete_file" : it.tool, arguments: it.arguments, status: ev.type === "item.started" ? "inProgress" : it.status === "failed" ? "failed" : "completed", error: it.error ?? null, result: it.result ?? null };
        notif(ev.type === "item.started" ? "item/started" : "item/completed", { ...p, item });
      } else if (it.type === "error") notif("warning", { threadId, message: it.message });
      await sleep(Number(env.FAKE_CODEX_DELAY_MS ?? 5));
    }
    notif("thread/tokenUsage/updated", { ...p, tokenUsage: { total: { totalTokens: Number(env.FAKE_CODEX_TOKENS ?? 20000) * turnN }, last: { totalTokens: 20000 }, modelContextWindow: 100000 } });
    notif("turn/completed", { ...p, turn: { id: turnId, status: "completed", error: null } });
  }
  function handle(msg) {
    requests.push(msg); record();
    if (msg.method === "initialize") return mode === "hang" ? undefined : out({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake/0.153.4", codexHome: env.CODEX_HOME ?? null } });
    if (msg.method === "initialized") return;
    if (msg.method === "thread/start") { const id = "thread_" + (++threadN); const reply = () => out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id, ephemeral: true }, model: msg.params?.model ?? "gpt-6-astra", reasoningEffort: "low" } }); if (startDelay) setTimeout(reply, startDelay); else reply(); return; }
    if (msg.method === "turn/start") { const turnId = "turn_" + (++turnN); interrupted = false; out({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } }); void runTurn(turnId, msg.params.threadId, msg.params); return; }
    if (msg.method === "turn/interrupt") { interrupted = true; return out({ jsonrpc: "2.0", id: msg.id, result: {} }); }
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
  process.stdin.on("end", () => process.exit(0));
} else {
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
}
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
interface AppServerLog {
  args: string[];
  cwd: string;
  codexHome: string | null;
  leaked: string[];
  requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
}

function makeBrain(t: TestContext, opts: { mode?: string; model?: string; socketPath?: string; ownPid?: number; maxSteps?: number; maxWallMs?: number; killGraceMs?: number; configModel?: string; signedIn?: boolean; appServer?: string; appServerStartTimeoutMs?: number; appServerPatienceMs?: number; appServerDelayMs?: number; tokens?: number; transport?: "auto" | "app-server" | "exec" }) {
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
    appServerStartTimeoutMs: opts.appServerStartTimeoutMs,
    appServerPatienceMs: opts.appServerPatienceMs,
    transport: opts.transport,
    // Jarhead's secrets are in the daemon's environment; none of them may reach Codex.
    env: { ...process.env, OPENAI_API_KEY: "sk-the-voice-key-must-not-leak", ANTHROPIC_API_KEY: "sk-ant-must-not-leak", JARHEAD_BRAIN_API_KEY: "brain-key-must-not-leak", FAKE_CODEX_FIXTURE: FIXTURE, FAKE_CODEX_LOG: logFile, ...(opts.mode ? { FAKE_CODEX_MODE: opts.mode } : {}), ...(opts.appServer ? { FAKE_CODEX_APPSERVER: opts.appServer } : {}), ...(opts.appServerDelayMs ? { FAKE_CODEX_APPSERVER_DELAY_MS: String(opts.appServerDelayMs) } : {}), ...(opts.tokens ? { FAKE_CODEX_TOKENS: String(opts.tokens) } : {}) },
  });
  t.after(() => brain.stop());
  const execLog = (): ExecLog => JSON.parse(readFileSync(logFile, "utf8")) as ExecLog;
  const appServerLog = (): AppServerLog => JSON.parse(readFileSync(`${logFile}.appserver`, "utf8")) as AppServerLog;
  return { brain, dir, bin, codexHome, execLog, appServerLog };
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
  assert.match(codexAddendum(), /must not be used to act on it or to read from it/, "the read-only sandbox does not stop reads; the orders do");
  assert.match(codexAddendum(), /does not stop you reading ~\/\.jarhead\/env, ~\/\.ssh/);
  assert.match(codexAddendum(), /the same tool and exactly the same arguments/);
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
  ledger = { read: () => [], days: () => [], sessions: () => [], readSession: () => [] };
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
  ear(): void {}
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

test("codex brain: circled regions are attached with -i and named in the prompt; a file already gone is left out of both", async (t) => {
  const { brain, dir, execLog } = makeBrain(t, {});
  assert.equal((await brain.start()).ready, true);
  const png = join(dir, "mark_1.png");
  writeFileSync(png, "PNG");
  const task = {
    ...makeTask("what is this"),
    attachments: [
      { path: png, mediaType: "image/png" as const, note: "Kevin circled this region of his screen: 10,20 100×50 (global points)" },
      { path: join(dir, "gone.png"), mediaType: "image/png" as const, note: "Kevin circled this region of his screen: 0,0 5×5 (global points)" },
    ],
  };
  const result = await brain.handle(task, makeSink().sink);
  assert.equal(result.status, "done");
  const exec = execLog();
  assert.deepEqual(exec.args.filter((_, i) => exec.args[i - 1] === "-i"), [png], "one -i per image that exists");
  assert.ok(exec.args.indexOf("-i") < exec.args.indexOf("-c"), "images come before the -c flags, so the variadic -i never swallows the stdin marker");
  assert.equal(exec.args[exec.args.length - 1], "-");
  assert.ok(exec.prompt.includes('Kevin said: "what is this"\n\nAttached image 1: Kevin circled this region of his screen: 10,20 100×50 (global points)\nTreat the circled region'), exec.prompt.slice(-600));
  assert.ok(!exec.prompt.includes("Attached image 2"), "the prompt numbers only the images that went in with -i");
  assert.ok(!exec.prompt.includes("0,0 5×5"), exec.prompt.slice(-600));

  // The argv builder alone: every image gets its own flag, none by default.
  const args = codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", images: ["/a.png", "/b.png"] });
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "-i"), ["/a.png", "/b.png"]);
  assert.ok(!codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s" }).includes("-i"));
});


// ------------------------------------------------------------- the warm path

test("codex brain: with an app-server the brain is warm — one thread, developer instructions once, a turn per task, the user's own MCP servers off, no --ignore-user-config needed", async (t) => {
  const { brain, dir, codexHome, appServerLog } = makeBrain(t, { appServer: "ok", configModel: "gpt-6-astra" });
  const started = await brain.start();
  assert.equal(started.ready, true, started.detail);
  assert.match(started.detail, /tools over a private socket; warm app-server \(thread thread_1, initialize \d+ ms, thread\/start \d+ ms\)$/);
  assert.equal(brain.activeTransport, "app-server");
  let log = appServerLog();
  assert.deepEqual(log.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.ok(!log.args.includes("--ignore-user-config"), "the app-server has no such flag");
  assert.equal(log.args[log.args.indexOf("--disable") + 1], "apps", "the plugin runtime (Kevin's ChatGPT connectors: Drive, Sites, agents — 134 tools) is a feature and is switched off");
  const configs = log.args.filter((_, i) => log.args[i - 1] === "-c");
  assert.ok(configs.includes("notify=[]"), "Kevin's turn-ended notify hook does not fire for Jarhead's turns");
  assert.ok(configs.some((c) => c.startsWith("mcp_servers.jarhead.command=")));
  assert.ok(configs.includes(`mcp_servers.jarhead.env={JARHEAD_SOCKET=${JSON.stringify(join(dir, "codex-tools.sock"))}}`));
  assert.ok(configs.includes('mcp_servers.jarhead.default_tools_approval_mode="approve"'));
  assert.ok(configs.includes("mcp_servers.node_repl.enabled=false"), `the server in config.toml is switched off: ${configs.join(" | ")}`);
  assert.ok(configs.includes('model_reasoning_effort="low"'));
  assert.equal(log.cwd, realpathSync(join(dir, "codex-cwd")));
  assert.equal(log.codexHome, codexHome);
  assert.deepEqual(log.leaked, [], "no Jarhead secret reaches the app-server");
  assert.deepEqual(log.requests.map((r) => r.method), ["initialize", "initialized", "thread/start"]);
  const threadStart = log.requests[2]!.params!;
  assert.equal(threadStart["approvalPolicy"], "never");
  assert.equal(threadStart["sandbox"], "read-only");
  assert.equal(threadStart["ephemeral"], true);
  assert.equal(threadStart["model"], "gpt-6-astra");
  assert.ok(String(threadStart["developerInstructions"]).startsWith(brainSystemPrompt().slice(0, 60)), "the standing orders are set once, per thread");
  assert.ok(String(threadStart["developerInstructions"]).includes(codexAddendum()));

  // A task is one turn: the same events as exec, mapped from the v2 item shapes.
  const sinkLog = makeSink();
  const result = await brain.handle(makeTask("what app is open"), sinkLog.sink);
  assert.equal(result.status, "done");
  assert.equal(result.summary, "Finder is in front.");
  assert.deepEqual(sinkLog.thinking, ["I’ll check the frontmost app and take a screenshot.", "Checking which app is in front.", "Taking a screenshot."]);
  log = appServerLog();
  const turn = log.requests.find((r) => r.method === "turn/start")!.params!;
  assert.equal(turn["threadId"], "thread_1");
  assert.equal(turn["effort"], "low");
  const input = turn["input"] as Array<{ type: string; text?: string }>;
  assert.equal(input.length, 1);
  assert.ok(input[0]!.text!.includes('Kevin said: "what app is open"'));
  assert.ok(!input[0]!.text!.includes(brainSystemPrompt().slice(0, 60)), "the orders are not repeated per turn");
  assert.ok(!input[0]!.text!.includes("Earlier in this session"), "the thread itself is the context");

  // The next task rides the same thread: no thread/start, no history text.
  const again = await brain.handle(makeTask("and now?"), makeSink().sink);
  assert.equal(again.status, "done");
  log = appServerLog();
  assert.equal(log.requests.filter((r) => r.method === "thread/start").length, 1, "one thread across delegations");
  assert.equal(log.requests.filter((r) => r.method === "turn/start").length, 2);
  const second = log.requests.filter((r) => r.method === "turn/start")[1]!.params!;
  assert.ok(!(second["input"] as Array<{ text?: string }>)[0]!.text!.includes("Earlier in this session"));

  await brain.stop();
  assert.equal(brain.activeTransport, "exec", "stopped: nothing warm");
});

test("codex brain: circled regions ride a warm turn as localImage inputs; a grown context rolls over to a fresh thread with the recent exchanges as text", async (t) => {
  // FAKE_CODEX_TOKENS 80000 × turns against a 100k window: after the first turn the thread is past 70 %.
  const { brain, dir, appServerLog } = makeBrain(t, { appServer: "ok", tokens: 80_000 });
  assert.equal((await brain.start()).ready, true);
  const png = join(dir, "mark_1.png");
  writeFileSync(png, "PNG");
  const task = { ...makeTask("what is this"), attachments: [{ path: png, mediaType: "image/png" as const, note: "Kevin circled this region of his screen: 10,20 100×50 (global points)" }, { path: join(dir, "gone.png"), mediaType: "image/png" as const, note: "gone" }] };
  assert.equal((await brain.handle(task, makeSink().sink)).status, "done");
  let log = appServerLog();
  const input = log.requests.find((r) => r.method === "turn/start")!.params!["input"] as Array<{ type: string; text?: string; path?: string }>;
  assert.deepEqual(input.map((i) => i.type), ["text", "localImage"], "one localImage per file that exists");
  assert.equal(input[1]!.path, png);
  assert.ok(input[0]!.text!.includes("Attached image 1: Kevin circled"));
  assert.ok(!input[0]!.text!.includes("Attached image 2"));

  // The context grew past the rollover point: the next task starts thread_2 and carries the exchange as text.
  assert.equal((await brain.handle(makeTask("do it again"), makeSink().sink)).status, "done");
  log = appServerLog();
  assert.deepEqual(log.requests.filter((r) => r.method === "thread/start").map((r) => r.params!["ephemeral"]), [true, true], "a second thread");
  const turns = log.requests.filter((r) => r.method === "turn/start");
  assert.equal(turns[1]!.params!["threadId"], "thread_2");
  const text = (turns[1]!.params!["input"] as Array<{ text?: string }>)[0]!.text!;
  assert.ok(text.includes('Earlier in this session:\nKevin said: "what is this"\nYou answered: Finder is in front.'), text.slice(0, 300));
  assert.ok(text.endsWith('Kevin said: "do it again"'));
});

test("codex brain: a stop interrupts the warm turn; a crashed app-server fails the turn and the next task runs on exec until the retry window passes", async (t) => {
  const hang = makeBrain(t, { appServer: "hang-turn" });
  assert.equal((await hang.brain.start()).ready, true);
  const abort = new AbortController();
  const pending = hang.brain.handle(makeTask("wait forever", abort.signal), makeSink().sink);
  await new Promise((r) => setTimeout(r, 120));
  abort.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.ok(hang.appServerLog().requests.some((r) => r.method === "turn/interrupt"), "turn/interrupt was sent");
  // cancel() does the same, and the thread is free again.
  const pending2 = hang.brain.handle(makeTask("again"), makeSink().sink);
  await new Promise((r) => setTimeout(r, 120));
  await hang.brain.cancel();
  assert.deepEqual(await pending2, { status: "cancelled" });
  assert.equal(hang.brain.activeTransport, "app-server", "an interrupt does not cost the warm transport");

  const die = makeBrain(t, { appServer: "die-turn" });
  assert.equal((await die.brain.start()).ready, true);
  const crashed = await die.brain.handle(makeTask("x"), makeSink().sink);
  assert.equal(crashed.status, "failed");
  assert.match(crashed.error ?? "", /exited with code 3.*crashed mid-turn/);
  assert.equal(die.brain.activeTransport, "exec", "fallen back");
  const viaExec = await die.brain.handle(makeTask("y"), makeSink().sink);
  assert.equal(viaExec.status, "done", viaExec.error);
  assert.equal(die.execLog().args[0], "exec", "the next task ran on exec");
});

test("codex brain: an app-server that never answers initialize is given up within the start budget and exec carries the tasks; `transport: exec` never tries", async (t) => {
  const slow = makeBrain(t, { appServer: "hang", appServerStartTimeoutMs: 300 });
  const started = await slow.brain.start();
  assert.equal(started.ready, true);
  assert.match(started.detail, /codex exec per task \(app-server: codex app-server did not start within \ds\)$/);
  assert.equal(slow.brain.activeTransport, "exec");
  assert.equal((await slow.brain.handle(makeTask("x"), makeSink().sink)).status, "done");
  assert.equal(slow.execLog().args[0], "exec");

  const exec = makeBrain(t, { appServer: "ok", transport: "exec" });
  assert.match((await exec.brain.start()).detail, /; codex exec per task$/);
  assert.throws(() => exec.appServerLog(), "never spawned");

  // The argv builder alone.
  const args = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", effort: "max", developerInstructions: "x", disableUserServers: false });
  assert.deepEqual(args.slice(0, 5), ["app-server", "--listen", "stdio://", "--disable", "apps"]);
  assert.ok(args.includes("notify=[]"));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('mcp_servers.jarhead.default_tools_approval_mode="approve"'));
  const { names, unaddressable } = codexUserMcpServers(fakeCodexHome(mkdtempSync(join(tmpdir(), "jh-codex-cfg-")), { model: "m" }));
  assert.deepEqual(names, ["node_repl"], "[mcp_servers.node_repl] is a server; its [mcp_servers.node_repl.env] sub-table is not another");
  assert.deepEqual(unaddressable, []);
});

test("codex brain: a warm turn whose tool call reaches for an MCP server other than Jarhead's fails outright — Codex tried to act around the policy", async (t) => {
  const { brain } = makeBrain(t, { appServer: "foreign" });
  assert.equal((await brain.start()).ready, true);
  const log = makeSink();
  const r = await brain.handle(makeTask("clean up my drive"), log.sink);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /^Codex tried to act around Jarhead \(an MCP call to codex_apps\.google_drive\.delete_file\); the turn was stopped$/);
  assert.ok(log.steps.some((s) => s.startsWith("error:codex tried to act around Jarhead")), log.steps.join(" | "));
  assert.equal(brain.activeTransport, "app-server", "the transport is kept; the turn was interrupted, not the server");
});

test("codex brain: a slow app-server never sits on a task's path — start() reports ready on exec after its patience window, the first task runs on exec, and the warm transport takes over once it is up", async (t) => {
  const { brain, execLog, appServerLog } = makeBrain(t, { appServer: "slow-start", appServerDelayMs: 700, appServerPatienceMs: 150, appServerStartTimeoutMs: 5000 });
  const t0 = Date.now();
  const started = await brain.start();
  const startMs = Date.now() - t0;
  assert.equal(started.ready, true, started.detail);
  // The detail is the proof: had start() waited for thread/start it would read "warm app-server". (The probe subprocesses before it take a few hundred ms under load, so the wall time is only sanity-checked.)
  assert.match(started.detail, /; codex exec per task until the app-server is up \(still starting\)$/);
  assert.ok(startMs < 3000, `start() returned in ${startMs} ms`);
  assert.match(brain.detail, /still starting/);
  assert.equal(brain.activeTransport, "exec");
  // A task now runs on exec at once, not after the warm start.
  const a = Date.now();
  const r1 = await brain.handle(makeTask("what app is open"), makeSink().sink);
  assert.equal(r1.status, "done");
  assert.equal(execLog().args[0], "exec", "the task ran on exec while the app-server was still starting");
  assert.ok(Date.now() - a < 2000);
  // The warm start lands in the background; the next task is a turn on the thread, and the detail line follows.
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(brain.activeTransport, "app-server", "warm now");
  assert.match(brain.detail, /warm app-server \(thread thread_1\)$/);
  const r2 = await brain.handle(makeTask("and now?"), makeSink().sink);
  assert.equal(r2.status, "done");
  assert.equal(appServerLog().requests.filter((r) => r.method === "turn/start").length, 1);
  assert.match(brain.detail, /warm app-server/);
});
