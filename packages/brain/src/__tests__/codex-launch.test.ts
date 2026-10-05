import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { CodexBrain, codexAddendum, codexExecArgs, probeCodex, type CodexProbe } from "../codex.ts";
import { CodexAppServer, appServerArgs } from "../codex-app-server.ts";
import { ResponsesBrain } from "../responses.ts";
import { runToolOverSocket } from "../mcp-bridge.ts";
import { resultText } from "../runner.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * Launch item W1-8 (scratchpad/launch/TRIAGE.md): the Codex and Responses brains.
 * The audit's reproductions (launch/brains/brains-findings.test.ts), adopted:
 *
 * - RAIL-4: Codex's own shell read every secret store. The read-only sandbox stops
 *   writes, not reads, and approval "never" asks nobody. The shell and the image
 *   reader are switched off in both argvs, and a command that runs anyway fails the turn.
 * - F-CODEX-AFTERSTOP: a stop lets go of the runner at once, so a bridge call Codex
 *   already sent is refused instead of acting with no delegation.
 * - F-APPSERVER-ZOMBIE: a turn given up locally never feeds its late items to the next.
 * - F-CODEX-SOCKET: two brains on private sockets keep a socket each.
 * - F-CODEX-CLOSED: a thread the server closed is replaced; tasks do not all fail.
 * - F-RESPONSES-ATTACHED: the Responses brain lets go of the runner when it finishes.
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
 * shell (Codex runs its own shell), auth401 (the login was refused), else one answer.
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
  if (mode === "shell") {
    out({ type: "item.started", item: { id: "c1", type: "command_execution", command: "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'", status: "in_progress" } });
    out({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'", aggregated_output: "-----BEGIN OPENSSH PRIVATE KEY----- canary", exit_code: 0, status: "completed" } });
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

test("RAIL-4: both Codex argvs switch off Codex's own shell and image reader; the sandbox stays read-only", () => {
  const configsOf = (args: readonly string[]): string[] => args.filter((_, i) => args[i - 1] === "-c");
  const exec = codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s" });
  const app = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", developerInstructions: "x", disableUserServers: false });
  for (const [name, args] of [["exec", exec], ["app-server", app]] as const) {
    const configs = configsOf(args);
    assert.ok(configs.includes("features.shell_tool=false"), `${name}: Codex's own shell is off (${configs.join(" ")})`);
    assert.ok(configs.includes("features.view_image=false"), `${name}: Codex's own image reader is off`);
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

test("RAIL-4 backstop (warm): a Codex that runs its own shell anyway is stopped, the turn fails, and the command's output never reaches the timeline", { timeout: 15_000 }, async (t) => {
  const child = new FakeAppServer(10, 10, false);
  child.onTurn = (turnId, threadId, _n, notif) => {
    const p = { threadId, turnId };
    notif("item/started", { ...p, item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'", status: "inProgress" } });
    setTimeout(() => {
      notif("item/completed", { ...p, item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'cat ~/.ssh/id_ed25519'", aggregatedOutput: "-----BEGIN OPENSSH PRIVATE KEY----- canary", exitCode: 0, status: "completed" } });
      if (child.interrupted.has(turnId)) return;
      notif("item/completed", { ...p, item: { type: "agentMessage", id: "m", text: "Here is the key.", phase: "final_answer" } });
      notif("turn/completed", { ...p, turn: { id: turnId, status: "completed", error: null } });
    }, 30);
  };
  const { brain } = codexBrain(t, { transport: "app-server", spawnImpl: () => child });
  assert.equal((await brain.start()).ready, true);
  const log = makeSink();
  const r = await brain.handle(makeTask("what is in my ssh folder"), log.sink);
  assert.equal(r.status, "failed", `the shell ran and the turn went on: ${JSON.stringify(r)}`);
  assert.match(r.error ?? "", /its own shell/);
  assert.ok(child.requests.some((q) => q.method === "turn/interrupt"), "the turn was interrupted at the command");
  assert.ok(!JSON.stringify(log).includes("canary"), `the command's output reached the sink: ${JSON.stringify(log.steps)}`);
});

test("RAIL-4 backstop (exec): the same on the exec transport", async (t) => {
  const { brain } = codexBrain(t, { transport: "exec", env: { FAKE_MODE: "shell" } });
  assert.equal((await brain.start()).ready, true);
  const log = makeSink();
  const r = await brain.handle(makeTask("what is in my ssh folder"), log.sink);
  assert.equal(r.status, "failed", `the shell ran and the run went on: ${JSON.stringify(r)}`);
  assert.match(r.error ?? "", /its own shell/);
  assert.ok(!JSON.stringify(log).includes("canary"), `the command's output reached the sink: ${JSON.stringify(log.steps)}`);
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
