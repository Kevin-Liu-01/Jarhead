import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import { REPO_ROOT } from "@jarhead/core";
import { CodexBrain, codexAddendum, codexExecArgs, probeCodex, type CodexProbe } from "../codex.ts";
import { CodexAppServer, appServerArgs } from "../codex-app-server.ts";
import { CODEX_MCP_SERVER, toml } from "../codex-config.ts";
import { REFUSED_NO_TASK, ResponsesBrain } from "../responses.ts";
import { runToolOverSocket } from "../mcp-bridge.ts";
import { resultText } from "../runner.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * Launch item W1-8 (scratchpad/launch/TRIAGE.md): the Codex and Responses brains.
 * The audit's reproductions (launch/brains/brains-findings.test.ts), adopted:
 *
 * - RAIL-4: Codex's own shell read every secret store. The read-only sandbox stops
 *   writes, not reads, and approval "never" asks nobody. The shell, the image reader
 *   and the connectors are switched off in both argvs. A command that runs anyway
 *   fails the turn: the runner lets go, nothing more of the turn reaches the sink,
 *   and the warm thread that saw the output is retired. The rendered tool list is an
 *   opt-in check at the end (one real `codex exec` turn, so only when asked).
 * - F-CODEX-AFTERSTOP: a stop lets go of the runner at once, so a bridge call Codex
 *   already sent is refused instead of acting with no delegation.
 * - F-APPSERVER-ZOMBIE: a turn given up locally never feeds its late items to the next.
 * - F-CODEX-SOCKET: two brains on private sockets keep a socket each.
 * - F-CODEX-CLOSED: a thread the server closed is replaced; tasks do not all fail.
 * - F-RESPONSES-ATTACHED: the Responses brain lets go of the runner when it finishes,
 *   carries the delegation still open when one of two ends, and runs no call for a
 *   delegation that is not open.
 * - E-SIGNEDOUT (codex half): an expired login is "not signed in" with the `codex login` remedy.
 *
 * No real Codex runs: the app-server is an in-process stand-in, `codex exec` a node script.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

/** Polls until `ok()` or the deadline; never a fixed settle before an assert. */
async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await sleep(10);
  }
  return ok();
}

// ------------------------------------------------------------------ stand-ins

type Notify = (method: string, params: unknown) => void;

/**
 * An in-process app-server. Turn 1 runs until interrupted when `firstTurnHangs`
 * (its first item a jarhead tool call in flight) and acknowledges the interrupt
 * `interruptLagMs` later (a loaded Mac); later turns answer "Chrome is open." after
 * `laterTurnMs`. `onTurn` replaces the turn's script entirely.
 */
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 4242;
  turns = 0;
  threads = 0;
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  readonly interrupted = new Set<string>();
  onTurn: ((turnId: string, threadId: string, n: number, notif: Notify) => void) | undefined;
  constructor(
    readonly interruptLagMs = 10,
    readonly laterTurnMs = 10,
    readonly firstTurnHangs = true,
  ) {
    super();
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        if (!msg.method) continue;
        this.requests.push({ method: msg.method, params: msg.params ?? {} });
        const reply = (result: unknown): void => void this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        const notif: Notify = (method, params) => void this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
        if (msg.method === "initialize") reply({ userAgent: "fake" });
        else if (msg.method === "thread/start") reply({ thread: { id: `thr_${++this.threads}` }, model: "fake", reasoningEffort: null });
        else if (msg.method === "turn/start") {
          const turnId = `turn_${++this.turns}`;
          const threadId = String(msg.params?.["threadId"] ?? "thr_1");
          const n = this.turns;
          reply({ turn: { id: turnId, status: "inProgress" } });
          if (this.onTurn) this.onTurn(turnId, threadId, n, notif);
          else if (n === 1 && this.firstTurnHangs) {
            notif("item/started", { threadId, turnId, item: { type: "mcpToolCall", server: "jarhead", tool: "left_click", status: "inProgress" } });
          } else {
            setTimeout(() => {
              notif("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `m${n}`, text: "Chrome is open.", phase: "final_answer" } });
              notif("turn/completed", { threadId, turnId, turn: { id: turnId, status: "completed", error: null } });
            }, this.laterTurnMs);
          }
        } else if (msg.method === "turn/interrupt") {
          const turnId = String(msg.params?.["turnId"]);
          const threadId = String(msg.params?.["threadId"] ?? "thr_1");
          this.interrupted.add(turnId);
          reply({});
          setTimeout(() => notif("turn/completed", { threadId, turnId, turn: { id: turnId, status: "interrupted", error: null } }), this.interruptLagMs);
        }
      }
    });
    // Closing stdin ends the app-server, as the real one does.
    this.stdin.on("finish", () => this.kill());
    setImmediate(() => this.emit("spawn"));
  }
  kill(): boolean {
    if (this.exitCode !== null) return true;
    this.exitCode = 0;
    setImmediate(() => this.emit("close", 0, null));
    return true;
  }
}

/**
 * A stand-in `codex` for the exec transport (and --version for the probe). FAKE_MODE:
 * slow (turn 1 sits in a tool call until SIGINT, then takes FAKE_LAG_MS to exit),
 * shell (Codex runs its own shell, then answers from its output), shellhang (Codex
 * starts its own shell and sits there until SIGINT, then takes FAKE_LAG_MS to exit),
 * auth401 (the login was refused), else one answer.
 */
function fakeCodexBin(dir: string): string {
  const script = join(dir, "fake-codex.mjs");
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (args[0] === "--version") { console.log("codex-cli 0.159.2-fake"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] !== "exec") process.exit(2);
import { existsSync, writeFileSync } from "node:fs";
const marker = new URL("./first-run-done", import.meta.url);
const first = !existsSync(marker);
if (first) writeFileSync(marker, "1");
const mode = process.env.FAKE_MODE ?? "ok";
process.stdin.resume();
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => {
  out({ type: "thread.started", thread_id: "t" });
  out({ type: "turn.started" });
  if (mode === "slow" && first) {
    out({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "jarhead", tool: "left_click", arguments: {} } });
    process.on("SIGINT", () => setTimeout(() => process.exit(130), Number(process.env.FAKE_LAG_MS ?? 150)));
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "auth401") {
    out({ type: "error", message: "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again." });
    process.exit(1);
  }
  if (mode === "shellhang") {
    out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "/bin/zsh -lc 'ls ~/.ssh'", status: "in_progress" } });
    process.on("SIGINT", () => setTimeout(() => process.exit(130), Number(process.env.FAKE_LAG_MS ?? 150)));
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "shell") {
    out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'", status: "in_progress" } });
    out({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'", aggregated_output: "-----BEGIN OPENSSH PRIVATE KEY----- canary", exit_code: 0, status: "completed" } });
    // The model had already answered from the output before the stop landed.
    out({ type: "item.completed", item: { id: "r", type: "reasoning", text: "The key reads canary." } });
    out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "The key is canary." } });
    out({ type: "turn.completed" });
    process.exit(0);
  }
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: "Chrome is open." } });
  out({ type: "turn.completed" });
  process.exit(0);
});
`,
  );
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function probeFor(bin: string): CodexProbe {
  return { bin: { path: bin, source: "env", label: "JARHEAD_CODEX_BIN" }, version: "0.159.2-fake", signedIn: true, authMode: "chatgpt", desktopRunning: false, configModel: undefined, detail: "Codex 0.159.2-fake via JARHEAD_CODEX_BIN, signed in with ChatGPT" };
}

/** A JWT whose payload is `payload` (Codex's access and id tokens are JWTs; nothing here checks a signature). */
function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none", typ: "JWT" })}.${b(payload)}.sig`;
}

/** Kevin's ~/.codex stand-in: a ChatGPT auth.json with the given tokens. */
function codexHomeWith(dir: string, tokens: Record<string, unknown> | null): string {
  const home = join(dir, "kevin-codex");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, last_refresh: "2026-09-01T00:00:00Z" }));
  return home;
}

function codexBrain(t: TestContext, opts: { transport: "auto" | "app-server" | "exec"; spawnImpl?: () => FakeAppServer; stateDir?: string; thread?: string; env?: NodeJS.ProcessEnv; signedIn?: boolean; home?: string }): { brain: CodexBrain; dir: string; home: string; runner: ReturnType<typeof makeRunner>["runner"] } {
  const dir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "jh-w18-"));
  const bin = fakeCodexBin(mkdtempSync(join(tmpdir(), "jh-w18-bin-")));
  const { runner } = makeRunner();
  const home = opts.home ?? codexHomeWith(dir, { access_token: "a", refresh_token: "r" });
  const brain = new CodexBrain({
    runner,
    probe: probeFor(bin),
    bin,
    codexHome: home,
    stateDir: dir,
    socketPath: join(dir, "no-daemon.sock"),
    transport: opts.transport,
    primeThreads: false,
    killGraceMs: 2000,
    ...(opts.thread ? { thread: opts.thread } : {}),
    ...(opts.spawnImpl ? { spawnImpl: (() => opts.spawnImpl!() as unknown as ChildProcess) as never } : {}),
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  t.after(() => brain.stop());
  return { brain, dir, home, runner };
}

/** The private tool sockets in a state dir (whatever they are called). */
function toolSockets(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("codex-tools") && f.endsWith(".sock"))
    .map((f) => join(dir, f));
}

// ------------------------------------------------------------------ RAIL-4

test("RAIL-4: both Codex argvs switch off Codex's own shell, image reader and connectors; the sandbox stays read-only", () => {
  const configsOf = (args: readonly string[]): string[] => args.filter((_, i) => args[i - 1] === "-c");
  const exec = codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s" });
  const app = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", developerInstructions: "x", disableUserServers: false });
  for (const [name, args] of [["exec", exec], ["app-server", app]] as const) {
    const configs = configsOf(args);
    assert.ok(configs.includes("features.shell_tool=false"), `${name}: Codex's own shell is off (${configs.join(" ")})`);
    assert.ok(configs.includes("features.view_image=false"), `${name}: Codex's own image reader is off`);
    // --ignore-user-config skips config.toml, not a feature's default, and `apps` defaults on (0.159.2).
    assert.ok(configs.includes("features.apps=false"), `${name}: the plugin runtime (the ChatGPT connectors) is off`);
  }
  assert.equal(exec[exec.indexOf("-s") + 1], "read-only", "the sandbox stays: a belt under the switch");
  const trimmed = codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", trimPrompt: false });
  assert.ok(configsOf(trimmed).includes("features.shell_tool=false"), "the prompt-trim knob never brings the shell back");
});

test("RAIL-4: the addendum no longer admits the gap; it says the shell is off and every read goes through the jarhead tools", () => {
  const a = codexAddendum("Kevin");
  assert.doesNotMatch(a, /does not stop you reading/);
  assert.match(a, /your own shell and file tools are switched off/i);
  assert.match(a, /every read and every action on this Mac goes through/i);
  assert.match(a, /the same tool and exactly the same arguments/, "the confirmation rule stays");
});

test("RAIL-4 backstop (warm): a Codex that runs its own shell anyway is stopped, nothing more of that turn reaches the timeline, and the next task runs on a fresh thread", { timeout: 15_000 }, async (t) => {
  // The interrupted turn ends 200 ms after the interrupt: room for late items, as on a loaded Mac.
  const child = new FakeAppServer(200, 10, false);
  const shell = "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'";
  child.onTurn = (turnId, threadId, n, notif) => {
    const p = { threadId, turnId };
    if (n === 1) {
      notif("item/started", { ...p, item: { type: "commandExecution", id: "c1", command: shell, status: "inProgress" } });
      notif("item/completed", { ...p, item: { type: "commandExecution", id: "c1", command: shell, aggregatedOutput: "-----BEGIN OPENSSH PRIVATE KEY----- canary", exitCode: 0, status: "completed" } });
      // The model had already answered from the output before the interrupt landed.
      notif("item/completed", { ...p, item: { type: "reasoning", id: "r", summary: ["The key reads canary."], content: [] } });
      notif("item/completed", { ...p, item: { type: "agentMessage", id: "m", text: "The key is canary.", phase: "final_answer" } });
      return; // turn/completed follows the interrupt
    }
    setTimeout(() => {
      notif("item/completed", { ...p, item: { type: "agentMessage", id: `m${n}`, text: "Chrome is open.", phase: "final_answer" } });
      notif("turn/completed", { ...p, turn: { id: turnId, status: "completed", error: null } });
    }, 10);
  };
  const { brain } = codexBrain(t, { transport: "app-server", spawnImpl: () => child });
  assert.equal((await brain.start()).ready, true);
  const log = makeSink();
  const r = await brain.handle(makeTask("what is in my ssh folder"), log.sink);
  assert.equal(r.status, "failed", `the shell ran and the turn went on: ${JSON.stringify(r)}`);
  assert.match(r.error ?? "", /its own shell/);
  assert.ok(child.requests.some((q) => q.method === "turn/interrupt"), "the turn was interrupted at the command");
  assert.doesNotMatch(JSON.stringify(log), /canary/i, `turn 1 reached the sink after the shell ran: ${JSON.stringify(log)}`);
  assert.deepEqual(log.thinking, [], "nothing of the turn was shown or spoken");

  const r2 = await brain.handle(makeTask("open chrome"), makeSink().sink);
  assert.equal(r2.status, "done", JSON.stringify(r2));
  const turnStarts = child.requests.filter((q) => q.method === "turn/start");
  assert.equal(turnStarts.length, 2);
  assert.notEqual(turnStarts[1]!.params["threadId"], turnStarts[0]!.params["threadId"], "the thread whose history holds the shell's output was retired");
  assert.doesNotMatch(JSON.stringify(turnStarts[1]!.params["input"]), /ssh|canary/i, "the failed exchange is not carried to the fresh thread");
});

test("RAIL-4 backstop (exec): the same on the exec transport", async (t) => {
  const { brain } = codexBrain(t, { transport: "exec", env: { FAKE_MODE: "shell" } });
  assert.equal((await brain.start()).ready, true);
  const log = makeSink();
  const r = await brain.handle(makeTask("what is in my ssh folder"), log.sink);
  assert.equal(r.status, "failed", `the shell ran and the run went on: ${JSON.stringify(r)}`);
  assert.match(r.error ?? "", /its own shell/);
  assert.doesNotMatch(JSON.stringify(log), /canary/i, `the run reached the sink after the shell ran: ${JSON.stringify(log)}`);
  assert.deepEqual(log.thinking, [], "nothing of the run was shown or spoken");
});

test("RAIL-4 backstop (warm): once the brain has failed the turn itself, a bridge call still in flight is refused, before the server ends the turn", { timeout: 15_000 }, async (t) => {
  const child = new FakeAppServer(600, 10, false); // the server takes 600 ms to end the interrupted turn
  child.onTurn = (turnId, threadId, _n, notif) => notif("item/started", { threadId, turnId, item: { type: "commandExecution", id: "c1", command: "ls ~/.ssh", status: "inProgress" } });
  const { brain, runner } = codexBrain(t, { transport: "app-server", spawnImpl: () => child });
  assert.equal((await brain.start()).ready, true);
  const sock = brain.toolSocketPath!;
  let settled = false;
  const r = brain.handle(makeTask("what is open"), makeSink().sink).finally(() => {
    settled = true;
  });
  assert.ok(await until(() => child.requests.some((q) => q.method === "turn/interrupt")), "the brain failed the turn and interrupted it");
  assert.equal(runner.attached, false, "the runner let go when the brain failed the turn, not at turn/completed");
  const late = await runToolOverSocket(sock, "frontmost_app", {}, 3000);
  assert.equal(settled, false, "the server had not ended the turn yet");
  assert.equal(late.kind, "error", `a bridge call acted for a turn Jarhead had failed: ${resultText(late)}`);
  assert.match(resultText(late), /no task is running/);
  assert.match((await r).error ?? "", /its own shell/);
});

test("RAIL-4 backstop (exec): the same while the stopped child is still exiting", async (t) => {
  const { brain, dir, runner } = codexBrain(t, { transport: "exec", env: { FAKE_MODE: "shellhang", FAKE_LAG_MS: "600" } });
  assert.equal((await brain.start()).ready, true);
  const [sock] = toolSockets(dir);
  assert.ok(sock);
  const sink = makeSink();
  const r = brain.handle(makeTask("what is open"), sink.sink);
  assert.ok(await until(() => sink.steps.some((s) => /its own shell/.test(s)), 10_000), "the run reached the command");
  assert.equal(runner.attached, false, "the runner let go when the brain failed the run, not when the child exited");
  const late = await runToolOverSocket(sock, "frontmost_app", {}, 3000);
  assert.equal(late.kind, "error", `a bridge call acted for a run Jarhead had failed: ${resultText(late)}`);
  assert.match(resultText(late), /no task is running/);
  assert.equal((await r).status, "failed");
});

// ------------------------------------------------------------------ F-CODEX-AFTERSTOP

test("F-CODEX-AFTERSTOP (warm): once Kevin says stop, a tool call the Codex turn still sends is refused ('nothing acts without a delegation')", async (t) => {
  const child = new FakeAppServer(150); // the interrupt is acknowledged at once; turn/completed follows 150 ms later
  const { brain, dir, runner } = codexBrain(t, { transport: "app-server", spawnImpl: () => child });
  assert.match((await brain.start()).detail, /tools over a private socket/);
  const [sock] = toolSockets(dir);
  assert.ok(sock, "the brain serves a private socket");
  const stop = new AbortController();
  const r1 = brain.handle(makeTask("click save", stop.signal), makeSink().sink);
  assert.ok(await until(() => child.turns === 1), "the turn is running");
  // Kevin: "stop". The Delegator aborts the task and awaits brain.cancel().
  stop.abort();
  await brain.cancel();
  assert.equal(runner.attached, false, "the runner let go at the stop, not when the server's turn/completed arrives");
  // A key press (Return: the Send) Codex had already sent through its MCP bridge reaches the daemon a few ms later.
  const late = await runToolOverSocket(sock, "key", { text: "Return" }, 3000);
  assert.equal(late.kind, "error", `the key ran after the stop: ${resultText(late)}`);
  assert.match(resultText(late), /no task is running/);
  assert.equal((await r1).status, "cancelled");
});

test("F-CODEX-AFTERSTOP (exec): the same on the exec transport, while the SIGINT'd child is still exiting", async (t) => {
  const { brain, dir, runner } = codexBrain(t, { transport: "exec", env: { FAKE_MODE: "slow", FAKE_LAG_MS: "300" } });
  assert.equal((await brain.start()).ready, true);
  const [sock] = toolSockets(dir);
  assert.ok(sock);
  const stop = new AbortController();
  const sink = makeSink();
  const r1 = brain.handle(makeTask("click save", stop.signal), sink.sink);
  assert.ok(await until(() => sink.thinking.some((l) => /Clicking/.test(l)), 10_000), "the run reached its tool call");
  stop.abort();
  await brain.cancel();
  assert.equal(runner.attached, false, "the runner let go at the stop, not when the child exited");
  const late = await runToolOverSocket(sock, "key", { text: "Return" }, 3000);
  assert.equal(late.kind, "error", `the key ran after the stop: ${resultText(late)}`);
  assert.equal((await r1).status, "cancelled");
});

// ------------------------------------------------------------------ F-APPSERVER-ZOMBIE

/** An app-server that ignores turn 1's interrupt, then (after the client gave it up) emits turn 1's final message late. */
class ZombieAppServer extends FakeAppServer {
  constructor() {
    super(10_000, 300); // turn 2 takes 300 ms, so it is still running when turn 1's late items land
    this.stdin.on("data", (c: Buffer) => {
      for (const line of c.toString().split("\n")) {
        if (!line.includes('"turn/interrupt"')) continue;
        setTimeout(() => {
          const p = { threadId: "thr_1", turnId: "turn_1" };
          this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/started", params: { ...p, item: { type: "mcpToolCall", server: "jarhead", tool: "key", status: "inProgress" } } })}\n`);
          this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { ...p, item: { type: "agentMessage", id: "stale", text: "Safari is open.", phase: "final_answer" } } })}\n`);
          this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "error", params: { ...p, error: { message: "turn 1 blew up late" }, willRetry: false } })}\n`);
        }, 160);
      }
    });
  }
}

test("F-APPSERVER-ZOMBIE: a turn given up locally after the interrupt grace never feeds its late items (or its late error) into the next turn", async () => {
  const child = new ZombieAppServer();
  const s = new CodexAppServer({ bin: "codex", cwd: "/tmp", env: {}, codexHome: "/tmp/none", node: "node", tsxCli: "tsx", bridgePath: "bridge", socketPath: "/tmp/x.sock", developerInstructions: "x", disableUserServers: false, spawnImpl: (() => child as unknown as ChildProcess) as never, killGraceMs: 10, interruptGraceMs: 100 });
  await s.start();
  const t1 = s.turn([{ type: "text", text: "open safari", text_elements: [] }], {});
  assert.ok(await until(() => child.turns === 1));
  await s.interrupt();
  assert.equal((await t1).status, "interrupted"); // given up locally at 100 ms
  const seen: string[] = [];
  const t2 = s.turn([{ type: "text", text: "what is open?", text_elements: [] }], {
    onItemStarted: (i) => seen.push(`started:${i.tool ?? i.type}`),
    onItemCompleted: (i) => seen.push(`${i.id}:${i.text}`),
    onError: (m) => seen.push(`error:${m}`),
  });
  const r2 = await t2;
  await s.stop();
  assert.equal(r2.status, "completed");
  assert.deepEqual(seen, ["m2:Chrome is open."], `turn 1's late items reached turn 2: ${JSON.stringify(seen)}`);
});

// ------------------------------------------------------------------ F-CODEX-SOCKET

test("F-CODEX-SOCKET: two Codex brains that both fall back to a private tool socket keep their own sockets", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-w18s-"));
  const main = codexBrain(t, { transport: "exec", stateDir });
  const spare = codexBrain(t, { transport: "exec", stateDir, thread: "t_spare1" });
  assert.match((await main.brain.start()).detail, /tools over a private socket/);
  assert.match((await spare.brain.start()).detail, /tools over a private socket/);
  const mainSock = main.brain.toolSocketPath;
  const spareSock = spare.brain.toolSocketPath;
  assert.ok(mainSock && spareSock, "each brain names its socket");
  assert.notEqual(mainSock, spareSock, "one socket per brain");
  assert.equal(toolSockets(stateDir).length, 2);
  // Main's delegation is running: its runner has the task. Its bridge calls with no thread id.
  main.runner.attach(makeSink().sink, makeTask("open safari"));
  try {
    const call = await runToolOverSocket(mainSock, "frontmost_app", {}, 3000);
    assert.equal(call.kind, "text", `main's tool call landed in the spare's host and was refused: ${resultText(call)}`);
    await spare.brain.stop();
    assert.ok(existsSync(mainSock), "stopping the spare left main's socket alone");
    assert.equal(existsSync(spareSock), false, "the spare's socket went with it");
    assert.equal((await runToolOverSocket(mainSock, "frontmost_app", {}, 3000)).kind, "text");
  } finally {
    main.runner.attach(undefined);
  }
});

test("F-CODEX-SOCKET: a private socket left by a process that is gone is swept at the next start; a live process's and an older name are left alone", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-w18w-"));
  // 2147483646 is past every pid range (macOS stops at 99998, Linux at 4194304): never a live process. The parent of this test is alive.
  const dead = join(stateDir, "codex-tools-main-2147483646-1.sock");
  const live = join(stateDir, `codex-tools-thread-${process.ppid}-4.sock`);
  const legacy = join(stateDir, "codex-tools.sock");
  for (const f of [dead, live, legacy]) writeFileSync(f, "");
  const { brain } = codexBrain(t, { transport: "exec", stateDir });
  assert.match((await brain.start()).detail, /tools over a private socket/);
  assert.equal(existsSync(dead), false, "a crashed process's socket is swept");
  assert.ok(existsSync(live), "a live process's socket stays");
  assert.ok(existsSync(legacy), "the old shared name may belong to an older Jarhead still running: not ours to remove");
  assert.ok(existsSync(brain.toolSocketPath!));
});

// ------------------------------------------------------------------ F-CODEX-CLOSED

/** An app-server that closes the thread 60 ms after every turn/start (the way an unloaded or failed thread is reported). */
class ClosingAppServer extends FakeAppServer {
  constructor() {
    super(10, 10, false);
    this.stdin.on("data", (c: Buffer) => {
      if (!c.toString().includes('"turn/start"')) return;
      const thread = `thr_${this.threads}`;
      setTimeout(() => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/closed", params: { threadId: thread } })}\n`), 60);
    });
  }
}

test("F-CODEX-CLOSED: a thread the server closed is replaced, with the history carried; the next tasks do not all fail while the process lives", async (t) => {
  const child = new ClosingAppServer();
  const { brain } = codexBrain(t, { transport: "auto", spawnImpl: () => child });
  assert.equal((await brain.start()).ready, true);
  const results = [];
  for (const words of ["open safari", "open chrome", "open notes"]) {
    results.push(await brain.handle(makeTask(words), makeSink().sink));
    await sleep(100);
  }
  assert.ok(results.every((r) => r.status === "done"), `a task after the close failed: ${JSON.stringify(results)}`);
  assert.ok(child.threads >= 2, `the closed thread was replaced (thread/start × ${child.threads})`);
  const turnStarts = child.requests.filter((r) => r.method === "turn/start");
  const lastInput = JSON.stringify(turnStarts.at(-1)?.params["input"] ?? "");
  assert.match(lastInput, /Earlier in this session/, "the fresh thread hears the recent exchanges");
});

test("F-CODEX-CLOSED: a turn running when its thread is closed fails at once, and a task with no thread runs on exec while the thread comes back", { timeout: 15_000 }, async (t) => {
  const child = new FakeAppServer(10, 10, false);
  let closeNext = true;
  child.onTurn = (turnId, threadId, n, notif) => {
    if (closeNext) {
      closeNext = false;
      // The server closes the thread mid-turn and never completes the turn.
      setTimeout(() => notif("thread/closed", { threadId }), 30);
      return;
    }
    setTimeout(() => {
      notif("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `m${n}`, text: "Chrome is open.", phase: "final_answer" } });
      notif("turn/completed", { threadId, turnId, turn: { id: turnId, status: "completed", error: null } });
    }, 10);
  };
  const { brain } = codexBrain(t, { transport: "auto", spawnImpl: () => child });
  assert.equal((await brain.start()).ready, true);
  const t0 = Date.now();
  const r1 = await brain.handle(makeTask("open safari"), makeSink().sink);
  assert.equal(r1.status, "failed");
  assert.match(r1.error ?? "", /closed the thread/);
  assert.ok(Date.now() - t0 < 2000 * RUNNER_SLACK, `failed at the close, not at the wall clock: under ${2000 * RUNNER_SLACK} ms (${Date.now() - t0} ms)`);
  const r2 = await brain.handle(makeTask("open chrome"), makeSink().sink);
  assert.equal(r2.status, "done", JSON.stringify(r2));
});

// ------------------------------------------------------------------ F-RESPONSES-ATTACHED

test("F-RESPONSES-ATTACHED: after a Responses delegation finishes (done or cancelled), the runner is detached", async () => {
  const { runner } = makeRunner();
  const live = Object.assign(new EventEmitter(), { createResponseItem: () => undefined, createResponse: () => undefined });
  const brain = new ResponsesBrain({ runner });
  brain.bind(live as never);
  const task = makeTask("what time is it in tokyo");
  const result = brain.handle(task, makeSink().sink);
  assert.equal(runner.attached, true, "attached while the delegation runs");
  live.emit("responseEvent", task.delegationId, { type: "response.completed" });
  assert.equal((await result).status, "done");
  assert.equal(runner.attached, false, "the runner still carries the finished task: the daemon's tool.run gate stays open");

  const stop = new AbortController();
  const again = brain.handle({ ...makeTask("and in paris", stop.signal), delegationId: "item_2" }, makeSink().sink);
  stop.abort();
  assert.equal((await again).status, "cancelled");
  assert.equal(runner.attached, false, "a cancel lets go too");
  // A late completion for the cancelled delegation runs nothing and re-attaches nothing.
  live.emit("responseEvent", "item_2", { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "key", arguments: '{"text":"Return"}' } });
  live.emit("responseEvent", "item_2", { type: "response.completed" });
  await sleep(20);
  assert.equal(runner.attached, false);
});

test("F-RESPONSES-ATTACHED: while another delegation is still open, finishing one does not detach the runner", async () => {
  const { runner } = makeRunner();
  const live = Object.assign(new EventEmitter(), { createResponseItem: () => undefined, createResponse: () => undefined });
  const brain = new ResponsesBrain({ runner });
  brain.bind(live as never);
  const a = brain.handle({ ...makeTask("first"), delegationId: "item_a" }, makeSink().sink);
  const b = brain.handle({ ...makeTask("second"), delegationId: "item_b" }, makeSink().sink);
  live.emit("responseEvent", "item_a", { type: "response.completed" });
  assert.equal((await a).status, "done");
  assert.equal(runner.attached, true, "item_b is still open");
  live.emit("responseEvent", "item_b", { type: "response.completed" });
  assert.equal((await b).status, "done");
  assert.equal(runner.attached, false);
});

/** A Live stand-in that records what the brain sends back and how often it continues the backend. */
function fakeLive(): { live: EventEmitter & { createResponseItem: (i: unknown) => void; createResponse: () => void }; items: Record<string, unknown>[]; continued: () => number } {
  const items: Record<string, unknown>[] = [];
  let continued = 0;
  const live = Object.assign(new EventEmitter(), {
    createResponseItem: (i: unknown) => void items.push(i as Record<string, unknown>),
    createResponse: () => void continued++,
  });
  return { live, items, continued: () => continued };
}

test("F-RESPONSES-ATTACHED: tool calls for a delegation that is not open (finished, never opened, or none named) run nothing; each is answered refused and the backend is not continued", async () => {
  const { runner } = makeRunner();
  const { live, items, continued } = fakeLive();
  const brain = new ResponsesBrain({ runner });
  brain.bind(live as never);
  const task = makeTask("what time is it");
  const done = brain.handle(task, makeSink().sink);
  live.emit("responseEvent", task.delegationId, { type: "response.completed" });
  assert.equal((await done).status, "done");
  for (const id of [task.delegationId, null, "item_never"]) {
    live.emit("responseEvent", id, { type: "response.output_item.done", item: { type: "function_call", call_id: `c-${String(id)}`, name: "frontmost_app", arguments: "{}" } });
    live.emit("responseEvent", id, { type: "response.completed" });
  }
  await sleep(50);
  assert.doesNotMatch(JSON.stringify(items), /Finder/, `a tool ran with no delegation open: ${JSON.stringify(items)}`);
  assert.deepEqual(
    items.map((i) => [i["type"], i["call_id"], i["output"]]),
    [task.delegationId, null, "item_never"].map((id) => ["function_call_output", `c-${String(id)}`, REFUSED_NO_TASK]),
    "every call is answered, as refused",
  );
  assert.equal(continued(), 0, "the backend is not continued for a delegation that is over");
  assert.equal(runner.attached, false);
});

test("F-RESPONSES-ATTACHED: when one of two open delegations finishes, the runner carries the one still open, not the one that ended", async () => {
  const { runner } = makeRunner();
  const { live } = fakeLive();
  const brain = new ResponsesBrain({ runner });
  brain.bind(live as never);
  const a = makeSink();
  const b = makeSink();
  const ra = brain.handle({ ...makeTask("first"), delegationId: "item_a" }, a.sink);
  const rb = brain.handle({ ...makeTask("second"), delegationId: "item_b" }, b.sink);
  live.emit("responseEvent", "item_b", { type: "response.completed" });
  assert.equal((await rb).status, "done");
  // A tool the daemon's gate lets through now (a bridge call, the eyes) reports to the delegation still open.
  await runner.run("frontmost_app", {});
  assert.ok(a.steps.some((s) => s === "tool:frontmost_app"), `item_a's sink: ${JSON.stringify(a.steps)}`);
  assert.ok(!b.steps.some((s) => s === "tool:frontmost_app"), "the finished delegation still carried the runner");
  live.emit("responseEvent", "item_a", { type: "response.completed" });
  assert.equal((await ra).status, "done");
  assert.equal(runner.attached, false);
});

test("F-RESPONSES-ATTACHED: a task stopped before it reached the brain is cancelled at once and never attaches the runner", async () => {
  const { runner } = makeRunner();
  const { live, items } = fakeLive();
  const brain = new ResponsesBrain({ runner });
  brain.bind(live as never);
  const stop = new AbortController();
  stop.abort();
  const r = brain.handle({ ...makeTask("too late", stop.signal), delegationId: "item_x" }, makeSink().sink);
  const status = await Promise.race([r.then((x) => x.status), sleep(1000).then(() => "still pending")]);
  assert.equal(status, "cancelled");
  assert.equal(runner.attached, false);
  live.emit("responseEvent", "item_x", { type: "response.output_item.done", item: { type: "function_call", call_id: "cx", name: "key", arguments: '{"text":"Return"}' } });
  live.emit("responseEvent", "item_x", { type: "response.completed" });
  await sleep(20);
  assert.deepEqual(items.map((i) => i["output"]), [REFUSED_NO_TASK], "its late call runs nothing");
});

// ------------------------------------------------------------------ E-SIGNEDOUT

test("E-SIGNEDOUT: an auth.json whose access token has expired with no refresh token is not signed in, and the detail names `codex login`", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-w18a-"));
  const bin = fakeCodexBin(dir);
  const fakeHome = join(dir, "home");
  mkdirSync(fakeHome);
  const env = { PATH: "/usr/bin:/bin", HOME: fakeHome };
  const past = Math.floor(Date.now() / 1000) - 3600;
  const future = Math.floor(Date.now() / 1000) + 86_400;

  const expired = codexHomeWith(join(dir, "a"), { id_token: jwt({ exp: past }), access_token: jwt({ exp: past }), refresh_token: null, account_id: "acct" });
  const p1 = await probeCodex({ bin, codexHome: expired, env });
  assert.equal(p1.signedIn, false, `an expired login with nothing to refresh it is not signed in: ${p1.detail}`);
  assert.match(p1.detail, /expired/);
  assert.match(p1.detail, /codex login/);

  // An expired access token beside a refresh token is Codex's to renew: still signed in.
  const renewable = codexHomeWith(join(dir, "b"), { id_token: jwt({ exp: past }), access_token: jwt({ exp: past }), refresh_token: "rt", account_id: "acct" });
  assert.equal((await probeCodex({ bin, codexHome: renewable, env })).signedIn, true);
  const fresh = codexHomeWith(join(dir, "c"), { id_token: jwt({ exp: future }), access_token: jwt({ exp: future }), refresh_token: null, account_id: "acct" });
  assert.equal((await probeCodex({ bin, codexHome: fresh, env })).signedIn, true);
  // Tokens that are not JWTs say nothing about expiry.
  const opaque = codexHomeWith(join(dir, "d"), { access_token: "acc", refresh_token: null });
  assert.equal((await probeCodex({ bin, codexHome: opaque, env })).signedIn, true);
});

test("E-SIGNEDOUT: a login the server refused at run time reads as signed out to the next probe, until auth.json changes (a new sign-in)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jh-w18r-"));
  const home = codexHomeWith(dir, { access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }), refresh_token: "rt-revoked" });
  const { brain } = codexBrain(t, { transport: "exec", stateDir: dir, home, env: { FAKE_MODE: "auth401" } });
  assert.equal((await brain.start()).ready, true);
  const bin = fakeCodexBin(mkdtempSync(join(tmpdir(), "jh-w18r-bin-")));
  const env = { PATH: "/usr/bin:/bin", HOME: join(dir, "home") };
  assert.equal((await probeCodex({ bin, codexHome: home, env })).signedIn, true, "before the refusal: Codex would refresh");
  const r = await brain.handle(makeTask("open safari"), makeSink().sink);
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /401/, "the error stays as Codex said it (the engine types it)");
  const after = await probeCodex({ bin, codexHome: home, env });
  assert.equal(after.signedIn, false, `the refused login still reads as signed in: ${after.detail}`);
  assert.match(after.detail, /codex login/);
  // Kevin signs in again: Codex rewrites auth.json.
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 86_400 }), refresh_token: "rt-new" } }));
  const later = new Date(Date.now() + 5000);
  utimesSync(join(home, "auth.json"), later, later);
  assert.equal((await probeCodex({ bin, codexHome: home, env })).signedIn, true, "a new sign-in clears it");
});

// ------------------------------------------------------------------ RAIL-4, rendered (opt-in)

/**
 * Codex builds its tool list per turn, and no `codex debug` command renders it (0.159.2:
 * `prompt-input` carries no tools), so the argv tests above prove the switches are passed,
 * not that the model is offered no shell. This renders it: one `codex exec` turn with the
 * brain's exact argv against a localhost stand-in for the Responses API, whose first
 * request is captured before Codex is stopped. An empty CODEX_HOME (no login), a provider
 * that needs no OpenAI auth and never retries, outbound network denied but for localhost
 * (sandbox-exec), the bridge pointed at a socket nothing serves: no model runs, nothing is
 * billed, no tool can act. It is still a Codex turn, so it runs only when asked:
 *
 *   JARHEAD_CODEX_TOOLS_CHECK=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
 *     node --import tsx --test packages/brain/src/__tests__/codex-launch.test.ts
 *
 * (JARHEAD_CODEX_TOOLS_MODEL picks the model whose tool metadata Codex uses; default gpt-6-astra.)
 */

/** Codex's own tools that must never reach the model: its shells and its image reader. */
const CODEX_OWN_TOOLS = new Set(["exec_command", "write_stdin", "shell", "local_shell", "shell_command", "view_image"]);

/** The tool names a Responses request carries: a tool's name, else its built-in type (`local_shell`); a namespace's tools are walked too. */
function requestToolNames(tools: readonly unknown[]): string[] {
  return tools.flatMap((t): string[] => {
    const o = (t ?? {}) as { name?: unknown; type?: unknown; tools?: unknown };
    const own = typeof o.name === "string" ? o.name : String(o.type ?? "?");
    return [own, ...(Array.isArray(o.tools) ? requestToolNames(o.tools) : [])];
  });
}

/** What RAIL-4 needs of a rendered tool list: none of Codex's own reading tools, and the jarhead tools reachable. Empty when it holds. */
function rail4Problems(tools: readonly unknown[]): string[] {
  const names = requestToolNames(tools);
  const problems = names.filter((n) => CODEX_OWN_TOOLS.has(n)).map((n) => `Codex's own ${n} is offered to the model`);
  // W3-4: the hosted search (a `web_search` tool type, no name) runs on OpenAI's side, past classifyUrl and the redactor.
  for (const t of tools) if (/^web_search/.test(String((t as { type?: unknown } | null)?.type ?? ""))) problems.push(`Codex's own hosted ${String((t as { type: unknown }).type)} is offered to the model`);
  if (!JSON.stringify(tools).includes(`mcp__${CODEX_MCP_SERVER}__`)) problems.push(`no mcp__${CODEX_MCP_SERVER}__ tool reaches the model (tools: ${names.join(", ") || "none"})`);
  return problems;
}

/** Outbound network denied except to this Mac itself. */
const LOCALHOST_ONLY = '(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))';

function decodeBody(buf: Buffer, encoding: string | string[] | undefined): string {
  switch (String(encoding ?? "").toLowerCase()) {
    case "gzip":
      return gunzipSync(buf).toString("utf8");
    case "br":
      return brotliDecompressSync(buf).toString("utf8");
    case "deflate":
      return inflateSync(buf).toString("utf8");
    case "zstd":
      return zstdDecompressSync(buf).toString("utf8");
    default:
      return buf.toString("utf8");
  }
}

/** One `codex exec` turn with the brain's argv against a localhost provider; resolves with its first request's tools, then stops Codex. */
async function renderCodexTools(bin: string, o: { dir: string; model?: string; sandbox: boolean; timeoutMs?: number }): Promise<{ tools: unknown[]; names: string[]; argv: string[] }> {
  let capture!: (body: Record<string, unknown>) => void;
  const captured = new Promise<Record<string, unknown>>((r) => (capture = r));
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !/\/responses$/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      try {
        capture(JSON.parse(decodeBody(Buffer.concat(chunks), req.headers["content-encoding"])) as Record<string, unknown>);
      } catch {
        // not a JSON body: keep waiting for one
      }
      const ev = (e: { type: string }): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(ev({ type: "response.created", response: { id: "resp_check" } } as never) + ev({ type: "response.completed", response: { id: "resp_check", output: [] } } as never));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const [home, codexHome, cwd] = ["home", "codex-home", "cwd"].map((d) => join(o.dir, d)) as [string, string, string];
  for (const d of [home, codexHome, cwd]) mkdirSync(d, { recursive: true });
  const args = codexExecArgs({
    cwd,
    model: o.model,
    node: process.execPath,
    tsxCli: join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    bridgePath: fileURLToPath(new URL("../mcp-bridge.ts", import.meta.url)),
    socketPath: join(o.dir, "nobody.sock"),
  });
  const provider = `model_providers.jhcheck={name="jarhead-check", base_url=${toml(`http://127.0.0.1:${port}/v1`)}, wire_api="responses", requires_openai_auth=false, supports_websockets=false, request_max_retries=0, stream_max_retries=0}`;
  args.splice(args.indexOf("-C"), 0, "-c", 'model_provider="jhcheck"', "-c", provider);
  const [cmd, argv] = o.sandbox ? ["/usr/bin/sandbox-exec", ["-p", LOCALHOST_ONLY, bin, ...args]] : [bin, args];
  const child = spawn(cmd, argv, { cwd, env: { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-2000)));
  child.stdout.resume();
  child.stdin.on("error", () => undefined);
  child.stdin.end("Say ok.");
  const exited = new Promise<void>((r) => child.once("close", () => r()));
  try {
    const timeoutMs = o.timeoutMs ?? 60_000;
    const body = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no request within ${timeoutMs} ms: ${stderr.trim().slice(-600)}`)), timeoutMs);
      void captured.then((b) => {
        clearTimeout(timer);
        resolve(b);
      });
      child.once("error", (e) => reject(e));
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`codex exited ${code} before its first request: ${stderr.trim().slice(-600)}`));
      });
    });
    const tools = Array.isArray(body["tools"]) ? (body["tools"] as unknown[]) : [];
    return { tools, names: requestToolNames(tools), argv: args };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(kill);
    }
    server.close();
  }
}

/** A `codex` stand-in that does what the real one does first: POST one request, gzipped, to the provider the argv names; then waits for SIGINT. */
function fakeProviderCodex(dir: string, tools: unknown[]): string {
  const script = join(dir, "fake-codex-provider.mjs");
  writeFileSync(
    script,
    `import { request } from "node:http";
import { gzipSync } from "node:zlib";
const argv = process.argv.slice(2);
const base = /base_url="([^"]+)"/.exec(argv.find((a) => a.startsWith("model_providers.jhcheck=")) ?? "")?.[1];
if (!base) { console.error("no provider in the argv"); process.exit(3); }
const body = gzipSync(JSON.stringify({ model: argv[argv.indexOf("-m") + 1], tools: ${JSON.stringify(tools)}, input: [] }));
const req = request(base + "/responses", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" } }, (res) => res.resume());
req.on("error", (e) => { console.error(e.message); process.exit(4); });
req.end(body);
process.on("SIGINT", () => process.exit(130));
setInterval(() => undefined, 1000);
`,
  );
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("RAIL-4 rendered: the check names Codex's own shells and image reader, and finds the jarhead route in code mode or as plain tools", () => {
  const codeMode = [{ type: "function", name: "exec", description: "Run JavaScript. Available: tools.mcp__jarhead__screenshot(args), tools.mcp__jarhead__left_click(args)" }];
  assert.deepEqual(rail4Problems(codeMode), []);
  assert.deepEqual(rail4Problems([{ type: "function", name: "mcp__jarhead__screenshot" }]), []);
  const leaky = rail4Problems([{ type: "function", name: "exec_command" }, { type: "function", name: "write_stdin" }, { type: "local_shell" }, { type: "namespace", name: "codex", tools: [{ type: "function", name: "view_image" }] }]);
  assert.deepEqual(leaky, ["Codex's own exec_command is offered to the model", "Codex's own write_stdin is offered to the model", "Codex's own local_shell is offered to the model", "Codex's own view_image is offered to the model", "no mcp__jarhead__ tool reaches the model (tools: exec_command, write_stdin, local_shell, codex, view_image)"]);
});

test("RAIL-4 rendered: the harness hands a codex stand-in the brain's argv with the localhost provider, captures its first request, and stops it", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-w18p-"));
  const tools = [{ type: "function", name: "exec", description: "tools.mcp__jarhead__screenshot" }];
  const r = await renderCodexTools(fakeProviderCodex(dir, tools), { dir, model: "gpt-6-astra", sandbox: false, timeoutMs: 15_000 });
  assert.deepEqual(r.names, ["exec"]);
  assert.deepEqual(rail4Problems(r.tools), []);
  const configs = r.argv.filter((_, i) => r.argv[i - 1] === "-c");
  for (const c of ["features.shell_tool=false", "features.view_image=false", "features.apps=false", 'model_provider="jhcheck"']) assert.ok(configs.includes(c), `the argv carries ${c}`);
  assert.ok(r.argv.includes("--ignore-user-config") && r.argv.at(-1) === "-", "the brain's exec argv, the prompt on stdin");
});

const TOOLS_CHECK_BIN = process.env["JARHEAD_CODEX_TOOLS_CHECK"];

test(
  "RAIL-4 rendered (opt-in, one codex exec turn): the installed Codex offers the model no shell and no image reader of its own, and the jarhead tools are there",
  { skip: TOOLS_CHECK_BIN ? false : "set JARHEAD_CODEX_TOOLS_CHECK=<codex binary> to run it: one codex exec turn against a localhost stand-in, no login, no cost; ask Kevin first", timeout: 120_000 },
  async () => {
    assert.ok(existsSync("/usr/bin/sandbox-exec"), "the check denies outbound network with sandbox-exec (macOS)");
    const dir = mkdtempSync(join(tmpdir(), "jh-w18t-"));
    const r = await renderCodexTools(TOOLS_CHECK_BIN!, { dir, sandbox: true, model: process.env["JARHEAD_CODEX_TOOLS_MODEL"] || "gpt-6-astra" });
    console.log(`[RAIL-4] tools offered to the model: ${r.names.join(", ")}`);
    assert.deepEqual(rail4Problems(r.tools), []);
  },
);
