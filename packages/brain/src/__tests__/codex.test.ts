import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonServer, type EngineLike } from "@jarhead/daemon";
import type { ToolResult } from "@jarhead/hands";
import { CARRY_MAX_CHARS, CARRY_RESULT_MAX_CHARS, CodexBrain, carriedResult, carriedResultLine, codexAddendum, codexBaseInstructions, codexBundleCandidates, codexConfigModel, codexEffort, codexEnv, codexExecArgs, codexSignedIn, daemonPidAt, findCodexBinary, isSimpleRequest, probeCodex, renderCarry, resultPlaceholder, socketAnswers } from "../codex.ts";
import { PRIMER_TEXT, appServerArgs } from "../codex-app-server.ts";
import { codexPromptTrimArgs, codexUserMcpServers, prepareCodexHome } from "../codex-config.ts";
import { MEMORY_PROMPT_LABEL } from "../anthropic.ts";
import { brainSystemPrompt } from "../brain.ts";
import { runToolOverSocket } from "../mcp-bridge.ts";
import { resultText } from "../runner.ts";
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
    // total = the thread's running bill (grows every turn); last = the last request, the context as it stands.
    notif("thread/tokenUsage/updated", { ...p, tokenUsage: { total: { totalTokens: Number(env.FAKE_CODEX_TOKENS ?? 20000) * turnN, inputTokens: Number(env.FAKE_CODEX_TOKENS ?? 20000) * turnN - 100 }, last: { totalTokens: Number(env.FAKE_CODEX_LAST_TOKENS ?? 20000), inputTokens: Number(env.FAKE_CODEX_LAST_TOKENS ?? 20000) - 100, cachedInputTokens: 0 }, modelContextWindow: 100000 } });
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

/** Kevin's CODEX_HOME stand-in (auth.json with fake tokens, optionally a config.toml naming a model); the brain builds its own `<stateDir>/codex-home` beside it. */
function fakeCodexHome(dir: string, opts: { signedIn?: boolean; authFile?: boolean; model?: string } = {}): string {
  const home = join(dir, "kevin-codex");
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

function makeBrain(t: TestContext, opts: { mode?: string; model?: string; socketPath?: string; ownPid?: number; maxSteps?: number; maxWallMs?: number; killGraceMs?: number; configModel?: string; signedIn?: boolean; authFile?: boolean; appServer?: string; appServerStartTimeoutMs?: number; appServerPatienceMs?: number; appServerDelayMs?: number; tokens?: number; lastTokens?: number; transport?: "auto" | "app-server" | "exec"; prime?: boolean; worker?: string; effort?: "low" | "medium"; simpleEffort?: "low"; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-"));
  const bin = fakeCodex(dir);
  const codexHome = fakeCodexHome(dir, { ...(opts.configModel ? { model: opts.configModel } : {}), ...(opts.signedIn !== undefined ? { signedIn: opts.signedIn } : {}), ...(opts.authFile !== undefined ? { authFile: opts.authFile } : {}) });
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
    effort: opts.effort ?? "low",
    simpleEffort: opts.simpleEffort,
    maxSteps: opts.maxSteps,
    maxWallMs: opts.maxWallMs,
    killGraceMs: opts.killGraceMs ?? 500,
    appServerStartTimeoutMs: opts.appServerStartTimeoutMs,
    appServerPatienceMs: opts.appServerPatienceMs,
    transport: opts.transport,
    worker: opts.worker,
    // The primer is one more turn on the fake; the tests that want it say so.
    primeThreads: opts.prime ?? false,
    // Jarhead's secrets are in the daemon's environment; none of them may reach Codex.
    env: { ...process.env, OPENAI_API_KEY: "sk-the-voice-key-must-not-leak", ANTHROPIC_API_KEY: "sk-ant-must-not-leak", JARHEAD_BRAIN_API_KEY: "brain-key-must-not-leak", FAKE_CODEX_FIXTURE: FIXTURE, FAKE_CODEX_LOG: logFile, ...(opts.mode ? { FAKE_CODEX_MODE: opts.mode } : {}), ...(opts.appServer ? { FAKE_CODEX_APPSERVER: opts.appServer } : {}), ...(opts.appServerDelayMs ? { FAKE_CODEX_APPSERVER_DELAY_MS: String(opts.appServerDelayMs) } : {}), ...(opts.tokens ? { FAKE_CODEX_TOKENS: String(opts.tokens) } : {}), ...(opts.lastTokens ? { FAKE_CODEX_LAST_TOKENS: String(opts.lastTokens) } : {}), ...(opts.env ?? {}) },
  });
  t.after(() => brain.stop());
  const execLog = (): ExecLog => JSON.parse(readFileSync(logFile, "utf8")) as ExecLog;
  const appServerLog = (): AppServerLog => JSON.parse(readFileSync(`${logFile}.appserver`, "utf8")) as AppServerLog;
  /** The home the brain builds for Codex: `<stateDir>/codex-home`. */
  const privateHome = join(dir, "codex-home");
  return { brain, dir, bin, codexHome, privateHome, execLog, appServerLog, runner };
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
  // The exec fallback runs from Jarhead's own CODEX_HOME too: the login linked in from Kevin's, nothing else of his.
  assert.equal(exec.codexHome, join(dir, "codex-home"));
  assert.equal(readlinkSync(join(dir, "codex-home", "auth.json")), join(codexHome, "auth.json"));
  assert.ok(exec.args.includes("skills.include_instructions=false") && exec.args.includes("features.plugins=false"), "the prompt trims ride exec's argv (--ignore-user-config skips the config.toml)");
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
  // Compacted (renderCarry): Kevin's words whole, a short result as it was, the screenshot (280 bytes with its image) as a size line.
  assert.ok(second.prompt.includes('Earlier in this session:\nKevin said: "what app is open"\n  frontmost_app → Finder — window: Desktop\n  screenshot → [tool result, 0.3 KB]\nYou answered: Finder is in front.'), second.prompt.slice(-600));
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

test("codex brain: a worker's brain on its private socket still serves its own worker's tool.run — the server there knows exactly that lane; another id is refused; nothing reaches the foreign daemon", async (t) => {
  // The pid check failed (a foreign daemon, or the 1 s self-ping timed out under wake load): the
  // worker's brain serves its own socket. Its bridge stamps every call with the worker id, and
  // the daemon routes a stamped call through `runnerFor` only — without a lane for that id the
  // worker would be refused every tool for its whole life.
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-worker-private-"));
  const socketPath = join(dir, "d.sock");
  const foreign = new ToolOnlyEngine();
  const server = new DaemonServer(foreign, socketPath);
  await server.listen();
  t.after(() => server.close());
  const { brain, dir: stateDir, runner } = makeBrain(t, { socketPath, ownPid: process.pid + 1, worker: "w_spotify" });
  const started = await brain.start();
  assert.equal(started.ready, true, started.detail);
  assert.match(started.detail, /tools over a private socket/);
  const sock = join(stateDir, "codex-tools.sock");
  // The worker's turn is running: its lane runner has the task.
  runner.attach(makeSink().sink, makeTask("play Focus on Spotify"));
  try {
    const mine = await runToolOverSocket(sock, "frontmost_app", {}, 3000, "w_spotify");
    assert.equal(mine.kind, "text", `the worker's own call runs on its lane: ${resultText(mine)}`);
    const other = await runToolOverSocket(sock, "frontmost_app", {}, 3000, "w_other");
    assert.match(resultText(other), /^error: refused: no worker w_other is running in Jarhead; frontmost_app was not run/);
  } finally {
    runner.attach(undefined);
  }
  const after = await runToolOverSocket(sock, "frontmost_app", {}, 3000, "w_spotify");
  assert.match(resultText(after), /^error: refused: no task is running in Jarhead/, "the turn is over: the same refusal the main runner gives");
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

test("codex brain: with an app-server the brain is warm — one thread, developer instructions once, a turn per task, from Jarhead's own CODEX_HOME with the coding-session prompt blocks off", async (t) => {
  const { brain, dir, codexHome, privateHome, appServerLog } = makeBrain(t, { appServer: "ok", configModel: "gpt-6-astra" });
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
  // Kevin's config.toml never loads: CODEX_HOME is Jarhead's, whose config.toml declares no servers — so there is nothing to switch off.
  assert.ok(!configs.some((c) => c.startsWith("mcp_servers.node_repl")), `no server of Kevin's to disable: ${configs.join(" | ")}`);
  for (const trim of codexPromptTrimArgs().filter((a) => a !== "-c")) assert.ok(configs.includes(trim), `${trim} rides the argv`);
  assert.ok(configs.includes('model_reasoning_effort="low"'));
  assert.equal(log.cwd, realpathSync(join(dir, "codex-cwd")));
  assert.equal(log.codexHome, privateHome, "CODEX_HOME is <stateDir>/codex-home");
  assert.equal(brain.codexHome?.isolated, true);
  assert.equal(readlinkSync(join(privateHome, "auth.json")), join(codexHome, "auth.json"), "the login is Kevin's, linked");
  const written = readFileSync(join(privateHome, "config.toml"), "utf8");
  assert.match(written, /^model = "gpt-6-astra"$/m, "his model line, copied");
  assert.match(written, /^model_reasoning_effort = "xhigh"$/m);
  const settings = written.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  assert.deepEqual(settings, ['model = "gpt-6-astra"', 'model_reasoning_effort = "xhigh"'], `nothing else of his (no notify, servers, plugins, marketplaces): ${written}`);
  assert.equal(existsSync(join(privateHome, "AGENTS.md")), false, "no AGENTS.md");
  assert.deepEqual(readdirSync(join(privateHome, "skills")), [], "an empty skills dir");
  assert.deepEqual(log.leaked, [], "no Jarhead secret reaches the app-server");
  assert.deepEqual(log.requests.map((r) => r.method), ["initialize", "initialized", "thread/start"], "no primer unless asked");
  const threadStart = log.requests[2]!.params!;
  assert.equal(threadStart["approvalPolicy"], "never");
  assert.equal(threadStart["sandbox"], "read-only");
  assert.equal(threadStart["ephemeral"], true);
  assert.equal(threadStart["model"], "gpt-6-astra");
  assert.ok(String(threadStart["developerInstructions"]).startsWith(brainSystemPrompt().slice(0, 60)), "the standing orders are set once, per thread");
  assert.ok(String(threadStart["developerInstructions"]).includes(codexAddendum()));
  assert.equal(threadStart["baseInstructions"], codexBaseInstructions(), "Jarhead's base prompt replaces Codex's coding-agent one (and its preamble rule)");
  assert.match(codexBaseInstructions(), /your very first output is the tool call — no commentary message before it/);

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

test("codex brain: circled regions ride a warm turn as localImage inputs; a full context rolls over to a fresh thread with the recent exchanges as text", async (t) => {
  // last.totalTokens 80000 against a 100k window: after the first turn the context stands past 70 %.
  const { brain, dir, appServerLog } = makeBrain(t, { appServer: "ok", lastTokens: 80_000 });
  assert.equal((await brain.start()).ready, true);
  const png = join(dir, "mark_1.png");
  writeFileSync(png, "PNG");
  const task = { ...makeTask("what is this"), memory: "- Kevin prefers short answers.", attachments: [{ path: png, mediaType: "image/png" as const, note: "Kevin circled this region of his screen: 10,20 100×50 (global points)" }, { path: join(dir, "gone.png"), mediaType: "image/png" as const, note: "gone" }] };
  assert.equal((await brain.handle(task, makeSink().sink)).status, "done");
  let log = appServerLog();
  const input = log.requests.find((r) => r.method === "turn/start")!.params!["input"] as Array<{ type: string; text?: string; path?: string }>;
  assert.deepEqual(input.map((i) => i.type), ["text", "localImage"], "one localImage per file that exists");
  assert.equal(input[1]!.path, png);
  assert.ok(input[0]!.text!.includes("Attached image 1: Kevin circled"));
  assert.ok(!input[0]!.text!.includes("Attached image 2"));
  // The durable-memory part rides the warm turn's text (behaviourally, not by a source pin): the label, then the rendered items.
  assert.ok(input[0]!.text!.includes(`${MEMORY_PROMPT_LABEL}\n- Kevin prefers short answers.`), "the labelled memory part is in the warm turn the app-server got");

  // The context stands past the rollover point: thread_2 was started right after that turn (in the
  // background, not at the next task), and the next task rides it with the exchange as text.
  await new Promise((r) => setTimeout(r, 80));
  log = appServerLog();
  assert.deepEqual(log.requests.filter((r) => r.method === "thread/start").map((r) => r.params!["ephemeral"]), [true, true], "the replacement thread is up before the next task arrives");
  assert.equal((await brain.handle(makeTask("do it again"), makeSink().sink)).status, "done");
  log = appServerLog();
  const turns = log.requests.filter((r) => r.method === "turn/start");
  assert.equal(turns[1]!.params!["threadId"], "thread_2", "the task rode the replacement thread (this fake reports a full context after every turn, so a third thread may already be starting)");
  const text = (turns[1]!.params!["input"] as Array<{ text?: string }>)[0]!.text!;
  assert.ok(text.includes('Earlier in this session:\nKevin said: "what is this"\n  frontmost_app → Finder — window: Desktop\n  screenshot → [tool result, 0.3 KB]\nYou answered: Finder is in front.'), text.slice(0, 400));
  assert.ok(text.endsWith('Kevin said: "do it again"'));

  // Three trivial turns whose bill grows 25k each while the context stays at 23k never roll over (the bug: total was judged).
  const steady = makeBrain(t, { appServer: "ok", tokens: 25_000, lastTokens: 23_000 });
  assert.equal((await steady.brain.start()).ready, true);
  for (const req of ["a", "b", "c"]) assert.equal((await steady.brain.handle(makeTask(req), makeSink().sink)).status, "done");
  await new Promise((r) => setTimeout(r, 50));
  const steadyLog = steady.appServerLog();
  assert.equal(steadyLog.requests.filter((r) => r.method === "thread/start").length, 1, "one thread across three turns: total 25k → 50k → 75k of a 100k window is the bill, not the context");
  assert.equal(steadyLog.requests.filter((r) => r.method === "turn/start").length, 3);
  assert.ok(!(steadyLog.requests.filter((r) => r.method === "turn/start")[2]!.params!["input"] as Array<{ text?: string }>)[0]!.text!.includes("Earlier in this session"), "no history text: the thread itself remembers");
});

test("codex brain: Jarhead's CODEX_HOME — built and refreshed at start, links the login, copies only the model lines, falls back to ~/.codex without an auth.json, never links a home onto itself", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jh-codex-home-"));
  const source = join(dir, "kevin-codex");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "acc" } }));
  writeFileSync(join(source, "config.toml"), `notify = ["/x/SkyComputerUseClient", "turn-ended"]\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "high"\nservice_tier = "default"\n\n[marketplaces.openai-bundled]\nsource = "x"\n\n[plugins."chrome@openai-bundled"]\nenabled = true\n\n[mcp_servers.node_repl]\ncommand = "y"\n`);
  writeFileSync(join(source, "AGENTS.md"), "# Kevin Codex Preset");
  mkdirSync(join(source, "skills", "one"), { recursive: true });
  const stateDir = join(dir, "state");
  const home = prepareCodexHome({ stateDir, sourceHome: source });
  assert.equal(home.isolated, true, home.detail);
  assert.equal(home.path, join(stateDir, "codex-home"));
  assert.ok(lstatSync(join(home.path, "auth.json")).isSymbolicLink());
  assert.equal(readlinkSync(join(home.path, "auth.json")), join(source, "auth.json"));
  assert.equal(JSON.parse(readFileSync(join(home.path, "auth.json"), "utf8")).tokens.access_token, "acc", "reads through to Kevin's login");
  const config = readFileSync(join(home.path, "config.toml"), "utf8");
  assert.equal(config.split("\n").filter((l) => l && !l.startsWith("#")).join("\n"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\nservice_tier = "default"', `only the model lines: ${config}`);
  assert.equal(existsSync(join(home.path, "AGENTS.md")), false);
  assert.deepEqual(readdirSync(join(home.path, "skills")), []);
  assert.match(home.detail, /private CODEX_HOME .*codex-home: auth\.json → .*kevin-codex\/auth\.json, model gpt-6-astra from .*kevin-codex, no AGENTS\.md, no skills/);
  assert.equal(codexUserMcpServers(home.path).names.length, 0, "nothing of his to disable in the app-server argv");

  // Refresh: an AGENTS.md that appeared is removed, a changed model line is copied, a regular auth.json (a Codex that renamed over the link) is moved aside and re-linked.
  writeFileSync(join(home.path, "AGENTS.md"), "stray");
  writeFileSync(join(source, "config.toml"), 'model = "gpt-7"\n');
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(home.path, "auth.json"));
  writeFileSync(join(home.path, "auth.json"), JSON.stringify({ tokens: { access_token: "newer" } }));
  const again = prepareCodexHome({ stateDir, sourceHome: source });
  assert.equal(again.isolated, true);
  assert.equal(existsSync(join(home.path, "AGENTS.md")), false);
  assert.match(readFileSync(join(home.path, "config.toml"), "utf8"), /^model = "gpt-7"$/m);
  assert.ok(!/model_reasoning_effort/.test(readFileSync(join(home.path, "config.toml"), "utf8")), "a line his config no longer has is not invented");
  assert.equal(readlinkSync(join(home.path, "auth.json")), join(source, "auth.json"), "re-linked");
  const strays = readdirSync(home.path).filter((f) => f.startsWith("auth.json.stray-"));
  assert.equal(strays.length, 1, "the regular file was kept aside, not deleted");
  assert.equal(JSON.parse(readFileSync(join(home.path, strays[0]!), "utf8")).tokens.access_token, "newer");

  // No auth.json to link: the source home is used as is, with the reason.
  const bare = join(dir, "bare");
  mkdirSync(bare);
  const fallback = prepareCodexHome({ stateDir: join(dir, "state2"), sourceHome: bare });
  assert.equal(fallback.isolated, false);
  assert.equal(fallback.path, bare);
  assert.match(fallback.detail, /no auth\.json at .*bare to link/);
  assert.equal(existsSync(join(dir, "state2", "codex-home")), false, "nothing built");

  // CODEX_HOME already pointing at <stateDir>/codex-home: never link auth.json onto itself.
  const self = prepareCodexHome({ stateDir, sourceHome: home.path });
  assert.equal(self.isolated, false);
  assert.equal(self.path, home.path);
  assert.ok(lstatSync(join(home.path, "auth.json")).isSymbolicLink() && readlinkSync(join(home.path, "auth.json")) === join(source, "auth.json"), "the link is untouched");

  // Through the brain: without an auth.json the fallback home is Kevin's, so his servers are switched off in the argv as before.
  const viaStatus = makeBrain(t, { appServer: "ok", authFile: false, configModel: "gpt-6-astra" });
  assert.equal((await viaStatus.brain.start()).ready, true);
  assert.equal(viaStatus.brain.codexHome?.isolated, false);
  const log = viaStatus.appServerLog();
  assert.equal(log.codexHome, viaStatus.codexHome, "CODEX_HOME is the source home");
  assert.ok(log.args.includes("mcp_servers.node_repl.enabled=false"), "the belt for the fallback: his config.toml loads, so its servers are disabled");
});

test("codex brain: a primed thread — one tiny background turn after thread/start; a task that lands mid-primer interrupts it and runs at once", async (t) => {
  const primed = makeBrain(t, { appServer: "ok", prime: true });
  assert.equal((await primed.brain.start()).ready, true);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !primed.appServerLog().requests.some((r) => r.method === "turn/completed" || (r.method === "turn/start" && primed.appServerLog().requests.length > 4))) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 150));
  let log = primed.appServerLog();
  const primer = log.requests.find((r) => r.method === "turn/start")!;
  assert.equal((primer.params!["input"] as Array<{ text: string }>)[0]!.text, PRIMER_TEXT, "the primer is the thread's first turn");
  assert.equal((await primed.brain.handle(makeTask("what app is open"), makeSink().sink)).status, "done");
  log = primed.appServerLog();
  const turns = log.requests.filter((r) => r.method === "turn/start");
  assert.equal(turns.length, 2, "primer, then the task");
  assert.ok((turns[1]!.params!["input"] as Array<{ text: string }>)[0]!.text.includes('Kevin said: "what app is open"'));
  assert.ok(!log.requests.some((r) => r.method === "turn/interrupt"), "a primer that had finished is not interrupted");

  // A task during the primer: the primer is interrupted first, then the task's turn starts.
  const busy = makeBrain(t, { appServer: "hang-turn", prime: true });
  assert.equal((await busy.brain.start()).ready, true);
  await new Promise((r) => setTimeout(r, 100));
  const abort = new AbortController();
  const pending = busy.brain.handle(makeTask("wait", abort.signal), makeSink().sink);
  await new Promise((r) => setTimeout(r, 200));
  const methods = busy.appServerLog().requests.map((r) => r.method).filter((m) => m.startsWith("turn/"));
  assert.deepEqual(methods.slice(0, 3), ["turn/start", "turn/interrupt", "turn/start"], `primer, its interrupt, the task: ${methods.join(" ")}`);
  abort.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
});

test("codex brain: per-turn effort A/B — a few imperative words run at the simple effort, everything else at the brain's, logged per turn; off unless the knob is set", async (t) => {
  for (const [text, simple] of [
    ["open Safari", true],
    ["jarhead, search the wiki for design", true],
    ["Hey Jarhead click send please", true],
    ["yes", true],
    ["go ahead", true],
    ["what app is open", false],
    ["what's on my screen?", false],
    ["can you find the invoice from last march and tell me the total", false],
    ["open the file I was editing yesterday and summarize its second section", false],
    ["the weather", false],
  ] as const) assert.equal(isSimpleRequest(text), simple, text);

  const ab = makeBrain(t, { appServer: "ok", effort: "medium", simpleEffort: "low" });
  assert.equal((await ab.brain.start()).ready, true);
  assert.equal((await ab.brain.handle(makeTask("open Safari"), makeSink().sink)).status, "done");
  assert.equal((await ab.brain.handle(makeTask("what app is open"), makeSink().sink)).status, "done");
  const efforts = ab.appServerLog().requests.filter((r) => r.method === "turn/start").map((r) => r.params!["effort"]);
  assert.deepEqual(efforts, ["low", "medium"], "Codex keeps a turn's effort for the following turns, so the brain sets it every turn");

  const off = makeBrain(t, { appServer: "ok", effort: "medium" });
  assert.equal((await off.brain.start()).ready, true);
  assert.equal((await off.brain.handle(makeTask("open Safari"), makeSink().sink)).status, "done");
  assert.deepEqual(off.appServerLog().requests.filter((r) => r.method === "turn/start").map((r) => r.params!["effort"]), ["medium"], "no knob, no A/B");

  // The knob from the environment (JARHEAD_CODEX_SIMPLE_EFFORT=low), the way the daemon gets it.
  const viaEnv = makeBrain(t, { appServer: "ok", effort: "medium", env: { JARHEAD_CODEX_SIMPLE_EFFORT: "low" } });
  assert.equal((await viaEnv.brain.start()).ready, true);
  assert.equal((await viaEnv.brain.handle(makeTask("click send"), makeSink().sink)).status, "done");
  assert.deepEqual(viaEnv.appServerLog().requests.filter((r) => r.method === "turn/start").map((r) => r.params!["effort"]), ["low"]);
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
  const args = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", effort: "max", serviceTier: "priority", developerInstructions: "x", disableUserServers: false });
  assert.deepEqual(args.slice(0, 5), ["app-server", "--listen", "stdio://", "--disable", "apps"]);
  assert.ok(args.includes("notify=[]"));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('service_tier="priority"'), "the tier knob, when set");
  assert.ok(args.includes("skills.include_instructions=false") && args.includes("include_permissions_instructions=false") && args.includes("include_collaboration_mode_instructions=false") && args.includes("features.plugins=false"), "the coding-session prompt blocks are off");
  assert.ok(!appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", developerInstructions: "x", disableUserServers: false, trimPrompt: false }).includes("skills.include_instructions=false"), "trimPrompt: false keeps them");
  assert.ok(!args.some((a) => a.startsWith("service_tier=") && !a.includes("priority")), "no tier unless set");
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

test("codex brain: a worker's brain — the worker id rides to the bridge as JARHEAD_WORKER on both transports, and its thread is never primed even when asked", async (t) => {
  // exec argv: the bridge env names the worker; the main brain's line is byte-identical to before.
  const base = { cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "/s.sock" };
  const main = codexExecArgs(base).filter((_, i, a) => a[i - 1] === "-c");
  const worker = codexExecArgs({ ...base, worker: "w_spotify" }).filter((_, i, a) => a[i - 1] === "-c");
  assert.ok(main.includes('mcp_servers.jarhead.env={JARHEAD_SOCKET="/s.sock"}'), main.join(" | "));
  assert.ok(worker.includes('mcp_servers.jarhead.env={JARHEAD_SOCKET="/s.sock", JARHEAD_WORKER="w_spotify"}'), worker.join(" | "));
  assert.equal(main.length, worker.length, "the same -c pairs, only the env differs");

  // The warm transport: the app-server's argv carries it too, and thread/start is not followed by a primer turn.
  const { brain, dir, appServerLog } = makeBrain(t, { appServer: "ok", worker: "w_spotify", prime: true });
  assert.equal((await brain.start()).ready, true);
  await new Promise((r) => setTimeout(r, 150));
  const log = appServerLog();
  const configs = log.args.filter((_, i) => log.args[i - 1] === "-c");
  assert.ok(configs.includes(`mcp_servers.jarhead.env={JARHEAD_SOCKET=${JSON.stringify(join(dir, "codex-tools.sock"))}, JARHEAD_WORKER="w_spotify"}`), configs.join(" | "));
  assert.deepEqual(log.requests.map((r) => r.method), ["initialize", "initialized", "thread/start"], "no primer: a worker's thread runs one task and costs nothing more");
  // One task, one turn, as for the main brain; still no primer after it.
  const result = await brain.handle(makeTask("play Focus on Spotify"), makeSink().sink);
  assert.equal(result.status, "done");
  const turns = appServerLog().requests.filter((r) => r.method === "turn/start");
  assert.equal(turns.length, 1);
  assert.ok(!(turns[0]!.params!["input"] as Array<{ text: string }>)[0]!.text.includes(PRIMER_TEXT));
  await brain.stop();
});

test("carried history is compacted: a tool result over 200 chars (or bytes, images included) becomes one size line, Kevin's words stay verbatim, the block is capped near 2 KB with the oldest exchanges dropped first and the newest request never cut", () => {
  // The result lines: short ones as they were (one line), long ones as their size.
  const short = carriedResult("frontmost_app", { content: [{ type: "text", text: "Finder — window: Desktop" }] });
  assert.equal(short.bytes, 65);
  assert.equal(carriedResultLine(short), "  frontmost_app → Finder — window: Desktop");
  const multiline = carriedResult("read_focused_text", { content: [{ type: "text", text: "line one\n  line two\nline three" }] });
  assert.equal(carriedResultLine(multiline), "  read_focused_text → line one line two line three", "never a newline inside a result line");
  const page = carriedResult("web_fetch", "x".repeat(3174));
  assert.equal(page.text.length, 1200, "kept in memory bounded");
  assert.equal(page.bytes, 3174, "…but the placeholder names the true size");
  assert.equal(resultPlaceholder(page.bytes), "[tool result, 3.1 KB]");
  assert.equal(carriedResultLine(page), "  web_fetch → [tool result, 3.1 KB]");
  assert.equal(resultPlaceholder(48 * 1024), "[tool result, 48 KB]");
  // A 1x1 screenshot: 73 chars of text but 280 bytes with its image — over the line, so a placeholder.
  const shot = carriedResult("screenshot", { content: [{ type: "image", data: "A".repeat(100), mimeType: "image/png" }, { type: "text", text: "1x1 px; scratch display." }] });
  assert.ok(shot.bytes > CARRY_RESULT_MAX_CHARS && shot.text.length < CARRY_RESULT_MAX_CHARS);
  assert.match(carriedResultLine(shot), /^ {2}screenshot → \[tool result, 0\.\d KB\]$/);
  const exactly = carriedResult("clipboard_read", "y".repeat(CARRY_RESULT_MAX_CHARS));
  assert.equal(carriedResultLine(exactly), `  clipboard_read → ${"y".repeat(200)}`, "200 is still verbatim; 201 is not");
  assert.equal(carriedResultLine(carriedResult("clipboard_read", "y".repeat(201))), "  clipboard_read → [tool result, 0.2 KB]");
  assert.equal(carriedResultLine(carriedResult("wait", null)), "  wait → (empty)");

  // The block: oldest first, newest last; every request verbatim; nothing when there is nothing.
  assert.equal(renderCarry([]), undefined);
  const block = renderCarry([
    { request: "what app is open", answer: "Finder is in front.", results: [short, shot] },
    { request: "send the invoice to dana", answer: "Send the invoice to dana@example.com? Say yes to send it.", results: [page] },
  ]);
  assert.equal(block, ['Earlier in this session:', 'Kevin said: "what app is open"', "  frontmost_app → Finder — window: Desktop", carriedResultLine(shot), "You answered: Finder is in front.", 'Kevin said: "send the invoice to dana"', "  web_fetch → [tool result, 3.1 KB]", "You answered: Send the invoice to dana@example.com? Say yes to send it."].join("\n"));
  assert.ok(block!.length < CARRY_MAX_CHARS);

  // The cap: 3 exchanges of ~900 chars each do not fit in 2 KB — the oldest goes first, whole.
  const big = (i: number) => ({ request: `request ${i}`, answer: `answer ${i} ${"a".repeat(880)}`, results: [] });
  const capped = renderCarry([big(1), big(2), big(3)])!;
  assert.ok(capped.length <= CARRY_MAX_CHARS, `${capped.length} chars`);
  assert.ok(!capped.includes('Kevin said: "request 1"'), "the oldest exchange was dropped whole");
  assert.ok(capped.includes('Kevin said: "request 2"') && capped.includes('Kevin said: "request 3"'));
  assert.ok(capped.endsWith("a".repeat(880)), "the newest answer is intact when it fits");
  // The newest exchange alone over the cap: its results go first (as placeholders, then gone), then its answer is cut; Kevin's words never are.
  const words = "please file the invoice from dana under april and tell me the total ".repeat(6).trim();
  const huge = renderCarry([{ request: words, answer: "b".repeat(5000), results: [short, page] }], "Kevin", 1024)!;
  assert.ok(huge.length <= 1024, `${huge.length} chars`);
  assert.ok(huge.includes(`Kevin said: "${words}"`), "Kevin's words, whole");
  assert.ok(!huge.includes("frontmost_app") && !huge.includes("web_fetch"), "no room for result lines");
  assert.match(huge, /You answered: b+…$/, "the answer cut to what is left");
  // Over budget by a few chars: the results become placeholders, each naming its TRUE size — never inflated to force the swap.
  assert.equal(carriedResultLine(short, true), "  frontmost_app → [tool result, 0.1 KB]");
  const nearly = renderCarry([{ request: "what app is open", answer: "c".repeat(100), results: [short] }], "Kevin", 211)!;
  assert.ok(nearly.length <= 211, `${nearly.length} chars`);
  assert.ok(nearly.includes("  frontmost_app → [tool result, 0.1 KB]"), "a 65-byte result is told as 0.1 KB, not 0.2");
  assert.ok(nearly.includes(`You answered: ${"c".repeat(100)}`), "the answer intact once the placeholder made room");
  // A request longer than the whole budget still rides whole: the block runs over rather than cut his words.
  const long = renderCarry([{ request: "w".repeat(1500), answer: "ok.", results: [] }], "Kevin", 1024)!;
  assert.ok(long.includes(`Kevin said: "${"w".repeat(1500)}"`));
  assert.match(long, /You answered: …$/);
});
