import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSplitter, REPO_ROOT, logger } from "@jarhead/core";
import { DaemonClient, DaemonServer, type EngineLike } from "@jarhead/daemon";
import { SECRET_KEYS, type Effort } from "@jarhead/protocol";
import type { Brain, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { brainSystemPrompt } from "./brain.ts";
import { delegationPrompt } from "./anthropic.ts";
import { progressLine } from "./responses.ts";
import type { ToolRunner } from "./runner.ts";

/**
 * The Codex brain: the Codex CLI (`codex exec`) on Kevin's ChatGPT login, with
 * Jarhead's tools mounted as an MCP server.
 *
 * Kevin uses Codex Desktop, which ships inside ChatGPT.app; the CLI binary sits
 * in its Resources folder and is not on PATH, so the finder below looks there
 * after JARHEAD_CODEX_BIN and PATH. Auth is whatever ~/.codex/auth.json holds
 * (a ChatGPT login, or an API key from `codex login --with-api-key`).
 *
 * Each delegation is one `codex exec --json --ephemeral` run: the prompt goes in
 * on stdin, JSONL events come out, the run leaves no session files behind. Codex
 * runs in its read-only sandbox with the user config ignored — Kevin's
 * config.toml enables Codex's own computer-use, browser and REPL servers, which
 * would let it act on the Mac around Jarhead's policy — so the only way it can
 * act is through the `jarhead` MCP server (`mcp-bridge.ts`), whose calls land in
 * the same ToolRunner as every other brain: policy, ledger, screenshot archive,
 * confirmation handshake included. The bridge reaches the runner over the
 * daemon socket when the daemon is this process; otherwise (`jarhead live` /
 * `probe`, or another Jarhead on the default path) the brain serves a socket
 * of its own. Jarhead's secrets never enter Codex's environment.
 *
 * No persistent session: like the API brains, the last few request/answer pairs
 * ride along as text so a "yes" still knows what it is confirming.
 */

const log = logger("brain.codex");

export const CODEX_MCP_SERVER = "jarhead";

// ----------------------------------------------------------------- finding it

export interface CodexBinary {
  readonly path: string;
  readonly source: "env" | "path" | "bundle";
  /** Where it came from, for humans: "ChatGPT.app", "Codex.app", "PATH", "JARHEAD_CODEX_BIN". */
  readonly label: string;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function labelFor(p: string, fallback: string): string {
  if (/ChatGPT\.app\//.test(p)) return "ChatGPT.app";
  if (/Codex\.app\//.test(p)) return "Codex.app";
  return fallback;
}

/** The desktop apps that bundle the CLI, system-wide and per-user. */
export function codexBundleCandidates(home: string): string[] {
  return ["/Applications", join(home, "Applications")].flatMap((apps) => [join(apps, "ChatGPT.app/Contents/Resources/codex"), join(apps, "Codex.app/Contents/Resources/codex")]);
}

export interface FindCodexOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The bundled copies to look for after PATH; tests pass their own so the real /Applications stays out. */
  readonly bundles?: readonly string[] | undefined;
}

/**
 * JARHEAD_CODEX_BIN → PATH → the ChatGPT.app / Codex.app bundles. An explicit
 * override that is not executable is a definite answer, not a reason to search.
 */
export function findCodexBinary(explicit?: string | undefined, opts: FindCodexOptions = {}): CodexBinary | undefined {
  const env = opts.env ?? process.env;
  if (explicit) return isExecutable(explicit) ? { path: explicit, source: "env", label: labelFor(explicit, "JARHEAD_CODEX_BIN") } : undefined;
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "codex");
    if (isExecutable(p)) return { path: p, source: "path", label: labelFor(p, "PATH") };
  }
  const bundles = opts.bundles ?? codexBundleCandidates(env["HOME"] || homedir());
  for (const p of bundles) if (isExecutable(p)) return { path: p, source: "bundle", label: labelFor(p, "app bundle") };
  return undefined;
}

/** Codex's own convention: $CODEX_HOME, else ~/.codex. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["CODEX_HOME"] || join(env["HOME"] || homedir(), ".codex");
}

interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { access_token?: string; refresh_token?: string } | null;
}

function readAuth(codexHome: string): AuthFile | undefined {
  try {
    return JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as AuthFile;
  } catch {
    return undefined;
  }
}

/** auth.json says yes/no; undefined when there is no readable file (then `codex login status` decides). Never returns a token. */
export function codexSignedIn(codexHome: string = codexHomeDir()): boolean | undefined {
  const auth = readAuth(codexHome);
  if (!auth) return undefined;
  return Boolean(auth.tokens?.access_token || auth.tokens?.refresh_token || auth.OPENAI_API_KEY);
}

/** The `model = "…"` at the top of ~/.codex/config.toml, if any: what Codex itself would run. */
export function codexConfigModel(codexHome: string = codexHomeDir()): string | undefined {
  try {
    const text = readFileSync(join(codexHome, "config.toml"), "utf8");
    const top = text.split(/^\s*\[/m)[0] ?? "";
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The environment Codex runs in. Jarhead's secrets (SECRET_KEYS: the voice's
 * OPENAI_API_KEY, ANTHROPIC_API_KEY, JARHEAD_BRAIN_API_KEY) sit in the daemon's
 * environment and would otherwise reach Codex's sandboxed shell (`env` works in
 * read-only) and, through Codex, the bridge. None of them is Codex's business:
 * this brain runs on Kevin's ChatGPT login, and an OPENAI_API_KEY is one of the
 * ways Codex authenticates, so the voice key in particular must not be there (a
 * key he gave Codex itself via `codex login --with-api-key` lives in auth.json
 * and still counts). CODEX_HOME is pinned so probe and run agree.
 */
export function codexEnv(env: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const rest: NodeJS.ProcessEnv = { ...env };
  for (const key of SECRET_KEYS) delete rest[key];
  return { ...rest, CODEX_HOME: codexHome };
}

function run(cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 8000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), ...(err ? { error: err.message } : {}) });
    });
  });
}

export interface CodexProbe {
  readonly bin: CodexBinary | undefined;
  /** "0.153.4" */
  readonly version: string | undefined;
  readonly signedIn: boolean;
  /** "chatgpt" | "apikey" | … from auth.json, when known. */
  readonly authMode: string | undefined;
  /** The desktop app's app-server has its IPC socket up. */
  readonly desktopRunning: boolean;
  /** The model Codex's own config names, when brainModel is empty. */
  readonly configModel: string | undefined;
  /** One human line: what was found, or what is missing. */
  readonly detail: string;
}

export interface CodexProbeOptions extends FindCodexOptions {
  /** JARHEAD_CODEX_BIN. */
  readonly bin?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Binary, version, login, desktop app: the facts the engine's `auto`, the
 * brain's start() and the doctor all need, gathered once (about 40 ms).
 */
export async function probeCodex(opts: CodexProbeOptions = {}): Promise<CodexProbe> {
  const env = opts.env ?? process.env;
  const codexHome = opts.codexHome ?? codexHomeDir(env);
  const childEnv = codexEnv(env, codexHome);
  const desktopRunning = existsSync(join(codexHome, "ipc", "ipc.sock"));
  const configModel = codexConfigModel(codexHome);
  const bin = findCodexBinary(opts.bin, { env, bundles: opts.bundles });
  const base = { version: undefined, signedIn: false, authMode: undefined, desktopRunning, configModel };
  if (!bin) {
    return {
      ...base,
      bin: undefined,
      detail: opts.bin ? `JARHEAD_CODEX_BIN=${opts.bin} is not an executable file` : "no codex binary on PATH or in ChatGPT.app / Codex.app (install Codex Desktop, or set JARHEAD_CODEX_BIN)",
    };
  }
  const v = await run(bin.path, ["--version"], { env: childEnv, timeoutMs: opts.timeoutMs ?? 8000 });
  const version = v.ok ? v.stdout.trim().replace(/^codex(?:-cli)?\s+/i, "") || undefined : undefined;
  if (!version) return { ...base, bin, detail: `${bin.path} did not answer --version${v.error ? ` (${v.error.split("\n")[0]})` : ""}` };
  const auth = readAuth(codexHome);
  let signedIn = codexSignedIn(codexHome);
  if (signedIn === undefined) {
    const st = await run(bin.path, ["login", "status"], { env: childEnv, timeoutMs: opts.timeoutMs ?? 8000 });
    const out = `${st.stdout}\n${st.stderr}`;
    signedIn = st.ok && /logged in/i.test(out) && !/not logged in/i.test(out);
  }
  const authMode = auth?.auth_mode;
  const where = `Codex ${version} via ${bin.label}`;
  const detail = signedIn
    ? `${where}, signed in${authMode === "chatgpt" ? " with ChatGPT" : authMode ? ` (${authMode})` : ""}${desktopRunning ? ", desktop app running" : ""}`
    : `${where} is not signed in; sign in to Codex in ChatGPT or run \`codex login\``;
  return { ...base, bin, version, signedIn, authMode, detail };
}

// --------------------------------------------------------------- the command

/** Jarhead's effort scale → Codex's `model_reasoning_effort` values. */
export function codexEffort(effort: Effort): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}

/** A TOML basic string; JSON's escapes are a subset of TOML's. */
function toml(value: string): string {
  return JSON.stringify(value);
}

export interface CodexExecOptions {
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  /** The node that runs the bridge (the daemon's own, by default). */
  readonly node: string;
  readonly tsxCli: string;
  readonly bridgePath: string;
  /** Where the bridge's tool.run messages go. */
  readonly socketPath: string;
  /** MCP server start / per-tool budgets, in seconds. */
  readonly startupTimeoutSec?: number | undefined;
  readonly toolTimeoutSec?: number | undefined;
}

/** The argv of one delegation; the prompt itself arrives on stdin (`-`). */
export function codexExecArgs(o: CodexExecOptions): string[] {
  return [
    "exec",
    "--json",
    // Nothing on disk: these turns are Jarhead's, not entries in Kevin's Codex history.
    "--ephemeral",
    // Codex's own shell may look but never touch; acting is the jarhead tools' job.
    "-s",
    "read-only",
    "--skip-git-repo-check",
    // Kevin's config.toml wires Codex's own computer-use, browser and REPL servers;
    // loaded, they would act on the Mac around Jarhead's policy. Auth still comes from CODEX_HOME.
    "--ignore-user-config",
    ...(o.model ? ["-m", o.model] : []),
    ...(o.effort ? ["-c", `model_reasoning_effort=${toml(codexEffort(o.effort))}`] : []),
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.command=${toml(o.node)}`,
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.args=[${toml(o.tsxCli)}, ${toml(o.bridgePath)}]`,
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.env={JARHEAD_SOCKET=${toml(o.socketPath)}}`,
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.startup_timeout_sec=${o.startupTimeoutSec ?? 30}`,
    // agent_wait may take ten minutes.
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.tool_timeout_sec=${o.toolTimeoutSec ?? 660}`,
    // exec runs with approval policy "never"; without this every MCP call is refused
    // ("MCP tool call requires approval, but approval policy is never").
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.default_tools_approval_mode="approve"`,
    "-C",
    o.cwd,
    "-",
  ];
}

/** What the Codex brain adds to the shared standing orders. */
export function codexAddendum(userName = "Kevin"): string {
  return `You are running as the Codex CLI in a read-only sandbox with no project of ${userName}'s: your own shell and file tools cannot change anything on this Mac and must not be used to act on it. Every action goes through the tools of the "${CODEX_MCP_SERVER}" MCP server (screenshot, zoom, left_click, type, key, scroll, open_app, read_focused_text, run_shell, agents_list, speak_progress and the rest). When any of them returns needs_confirmation, do not retry it and do not work around it: make your final answer the one-sentence question it asked and stop; ${userName} will answer out loud and you will be asked again.`;
}

// ------------------------------------------------------------------ the brain

export interface CodexBrainOptions {
  readonly runner: ToolRunner;
  /** The daemon socket the bridge should call — used only when the daemon there is this very process; otherwise the brain serves its own. */
  readonly socketPath: string;
  readonly stateDir: string;
  /** The pid a daemon must report to be trusted with tool.run (default: this process). Tests pass another to stand in for a foreign daemon. */
  readonly ownPid?: number | undefined;
  /** From the engine, so the install is examined once; otherwise start() probes. */
  readonly probe?: CodexProbe | undefined;
  /** JARHEAD_CODEX_BIN. */
  readonly bin?: string | undefined;
  readonly codexHome?: string | undefined;
  /** Model override; empty = Codex's own default (config.toml's model, else the CLI's). */
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  readonly userName?: string | undefined;
  /** Tool calls (MCP and Codex's own shell) per delegation before the brain gives up (default 40). */
  readonly maxSteps?: number | undefined;
  /** Wall clock per delegation (default 5 min). */
  readonly maxWallMs?: number | undefined;
  /** Request/answer pairs carried into the next delegation (default 3). */
  readonly historyTurns?: number | undefined;
  /** SIGINT → SIGKILL grace (default 3 s). */
  readonly killGraceMs?: number | undefined;
  readonly node?: string | undefined;
  readonly tsxCli?: string | undefined;
  readonly bridgePath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** One `codex exec --json` event, as far as this brain reads it. */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string | null;
  item?: CodexItem;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string;
  message?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  status?: string;
  error?: { message?: string } | string | null;
  command?: string | string[];
  exit_code?: number;
  aggregated_output?: string;
}

interface RunState {
  readonly task: BrainTask;
  readonly sink: BrainSink;
  readonly child: ChildProcess;
  readonly started: number;
  /** The most recent agent_message; becomes the summary at turn.completed. */
  candidate: string | undefined;
  steps: number;
  completed: boolean;
  failed: string | undefined;
  cancelled: boolean;
  stderr: string;
  resolve: (r: BrainResult) => void;
  timer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
}

function errorMessage(e: CodexItem["error"] | undefined, fallback: string): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return fallback;
}

export class CodexBrain implements Brain {
  readonly kind = "codex";
  private probe: CodexProbe | undefined;
  private ready = false;
  private readyDetail = "not started";
  private started = false;
  private current: RunState | undefined;
  private history: Array<{ request: string; answer: string }> = [];
  private toolSocket: string | undefined;
  private privateServer: DaemonServer | undefined;
  private readonly model: string | undefined;

  constructor(private readonly opts: CodexBrainOptions) {
    this.probe = opts.probe;
    this.model = opts.model?.trim() || undefined;
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.started) return { ready: this.ready, detail: this.readyDetail };
    this.started = true;
    try {
      const probe = this.probe ?? (await probeCodex({ bin: this.opts.bin, codexHome: this.opts.codexHome, env: this.opts.env }));
      this.probe = probe;
      if (!probe.bin || !probe.version || !probe.signedIn) {
        this.readyDetail = probe.detail;
        return { ready: false, detail: this.readyDetail };
      }
      for (const [what, p] of [["node", this.node()], ["tsx", this.tsxCli()], ["the MCP bridge", this.bridgePath()]] as const) {
        if (!existsSync(p)) {
          this.readyDetail = `${what} is missing at ${p}`;
          return { ready: false, detail: this.readyDetail };
        }
      }
      mkdirSync(this.cwd(), { recursive: true });
      const socket = await this.ensureToolSocket();
      const model = this.model ?? probe.configModel;
      this.ready = true;
      this.readyDetail = `${probe.detail}; ${model ? `model ${model}` : "default model"}${this.model ? "" : model ? " (from ~/.codex/config.toml)" : ""}${this.opts.effort ? `, effort ${codexEffort(this.opts.effort)}` : ""}; tools over ${socket === this.opts.socketPath ? "the daemon socket" : "a private socket"}`;
      return { ready: true, detail: this.readyDetail };
    } catch (e) {
      this.ready = false;
      this.readyDetail = (e as Error).message;
      return { ready: false, detail: this.readyDetail };
    }
  }

  private node(): string {
    return this.opts.node ?? process.execPath;
  }

  private tsxCli(): string {
    return this.opts.tsxCli ?? join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  }

  private bridgePath(): string {
    return this.opts.bridgePath ?? fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url));
  }

  /** Codex gets an empty directory of its own, not Kevin's home, as its working root. */
  private cwd(): string {
    return join(this.opts.stateDir, "codex-cwd");
  }

  /**
   * The bridge needs a socket that answers `tool.run` with THIS brain's runner.
   * Under jarheadd / the app that is the daemon's own socket — but only when the
   * daemon there is this process (its hello carries its pid). Another Jarhead on
   * the same path (the app's daemon while `jarhead live` hosts an engine, or
   * `jarheadd --socket X` with the default path still busy) would take the steps,
   * the screenshots and the pending confirmation into a runner that a "yes"
   * heard here can never reach. In every other case the brain serves the same
   * DaemonServer itself, with a runner-only engine.
   */
  private async ensureToolSocket(): Promise<string> {
    if (this.toolSocket) return this.toolSocket;
    const ownPid = this.opts.ownPid ?? process.pid;
    const pid = await daemonPidAt(this.opts.socketPath);
    if (pid === ownPid) {
      this.toolSocket = this.opts.socketPath;
      return this.toolSocket;
    }
    const path = join(this.opts.stateDir, "codex-tools.sock");
    const server = new DaemonServer(runnerOnlyEngine(this.opts.runner, this.opts.stateDir), path);
    await server.listen();
    this.privateServer = server;
    this.toolSocket = path;
    log.info(`${pid === undefined ? `no daemon at ${this.opts.socketPath}` : `the daemon at ${this.opts.socketPath} is pid ${pid}, not this process`}; serving tools at ${path}`);
    return path;
  }

  private prompt(task: BrainTask): string {
    const parts = [brainSystemPrompt(this.opts.userName), codexAddendum(this.opts.userName)];
    if (this.history.length > 0) {
      parts.push(["Earlier in this session:", ...this.history.flatMap((h) => [`${this.opts.userName ?? "Kevin"} said: "${h.request}"`, `You answered: ${h.answer}`])].join("\n"));
    }
    parts.push(delegationPrompt(task, this.opts.userName));
    return parts.join("\n\n");
  }

  handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const probe = this.probe;
    if (!this.ready || !probe?.bin || !this.toolSocket) return Promise.resolve({ status: "failed", error: this.readyDetail });
    if (this.current) return Promise.resolve({ status: "failed", error: "already handling a task" });
    if (task.signal.aborted) return Promise.resolve({ status: "cancelled" });
    const args = codexExecArgs({
      cwd: this.cwd(),
      model: this.model ?? probe.configModel,
      effort: this.opts.effort,
      node: this.node(),
      tsxCli: this.tsxCli(),
      bridgePath: this.bridgePath(),
      socketPath: this.toolSocket,
    });
    const base = this.opts.env ?? process.env;
    const env = codexEnv(base, this.opts.codexHome ?? codexHomeDir(base));
    this.opts.runner.attach(sink);
    return new Promise<BrainResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(probe.bin!.path, args, { cwd: this.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        this.opts.runner.attach(undefined);
        resolve({ status: "failed", error: `could not start Codex: ${(e as Error).message}` });
        return;
      }
      const state: RunState = { task, sink, child, started: Date.now(), candidate: undefined, steps: 0, completed: false, failed: undefined, cancelled: false, stderr: "", resolve, timer: undefined, killTimer: undefined };
      this.current = state;
      const maxWallMs = this.opts.maxWallMs ?? 5 * 60_000;
      state.timer = setTimeout(() => this.fail(state, `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds`), maxWallMs);
      const onAbort = (): void => {
        state.cancelled = true;
        this.kill(state);
      };
      task.signal.addEventListener("abort", onAbort, { once: true });

      const lines = new LineSplitter(64 * 1024 * 1024);
      child.stdout?.on("data", (chunk: Buffer) => {
        let out: string[];
        try {
          out = lines.push(chunk);
        } catch (e) {
          log.warn((e as Error).message);
          return;
        }
        for (const line of out) this.onLine(state, line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        state.stderr = (state.stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", (e) => this.fail(state, `could not start Codex: ${e.message}`));
      child.on("close", (code, signal) => {
        task.signal.removeEventListener("abort", onAbort);
        this.settle(state, code, signal);
      });
      child.stdin?.on("error", (e) => log.debug(`stdin: ${e.message}`));
      child.stdin?.end(this.prompt(task));
    });
  }

  private onLine(state: RunState, line: string): void {
    let ev: CodexEvent;
    try {
      ev = JSON.parse(line) as CodexEvent;
    } catch {
      log.debug(`non-JSON line from codex: ${line.slice(0, 200)}`);
      return;
    }
    const { sink } = state;
    switch (ev.type) {
      case "thread.started":
        log.debug(`thread ${ev.thread_id ?? "?"} started`);
        return;
      case "turn.started":
        return;
      case "item.started":
        this.onItemStarted(state, ev.item ?? {});
        return;
      case "item.updated":
        return;
      case "item.completed":
        this.onItemCompleted(state, ev.item ?? {});
        return;
      case "turn.completed":
        state.completed = true;
        return;
      case "turn.failed":
        this.fail(state, errorMessage(ev.error, ev.message ?? "the Codex turn failed"));
        return;
      case "error":
        this.fail(state, errorMessage(ev.error, ev.message ?? "Codex reported an error"));
        return;
      default:
        if (ev.type) sink.step({ kind: "note", text: `codex: ${ev.type}` });
    }
  }

  private countStep(state: RunState): boolean {
    const maxSteps = this.opts.maxSteps ?? 40;
    if (++state.steps > maxSteps) {
      this.fail(state, `I stopped after ${maxSteps} tool calls without finishing`);
      return false;
    }
    return true;
  }

  private onItemStarted(state: RunState, item: CodexItem): void {
    const { sink } = state;
    switch (item.type) {
      case "mcp_tool_call": {
        if (!this.countStep(state)) return;
        const tool = item.tool ?? "?";
        // Our own tools report through the runner (the bridge lands there); this is the
        // "about to" line the in-process brains emit before each call.
        if (item.server === CODEX_MCP_SERVER) sink.thinking(progressLine(tool, item.arguments));
        else sink.step({ kind: "note", text: `codex is calling ${item.server ?? "?"}.${tool}` });
        return;
      }
      case "command_execution": {
        if (!this.countStep(state)) return;
        const cmd = Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
        sink.thinking(`Codex is looking with ${cmd.slice(0, 60) || "a command"}.`);
        return;
      }
      default:
        return;
    }
  }

  private onItemCompleted(state: RunState, item: CodexItem): void {
    const { sink } = state;
    switch (item.type) {
      case "agent_message": {
        const text = (item.text ?? "").trim();
        if (!text) return;
        // Only the last message is the answer; earlier ones were narration between tool calls.
        if (state.candidate) sink.step({ kind: "note", text: state.candidate.slice(0, 1000) });
        state.candidate = text;
        // Before the first tool call nothing else has reached the voice, and
        // Codex's start-up (auth, the skills catalog, the first model turn) is
        // several seconds of silence otherwise. The "I'll check…" line is
        // speakable, so it goes out as thinking too and Live can say "still on
        // it"; when it turns out to be the whole answer, the delegator speaks it
        // as the summary anyway.
        if (state.steps === 0) sink.thinking(text.slice(0, 200));
        return;
      }
      case "reasoning": {
        const text = (item.text ?? item.summary ?? "").trim();
        if (text) sink.thinking(text.slice(0, 300));
        return;
      }
      case "mcp_tool_call": {
        const tool = item.tool ?? "?";
        if (item.status === "failed" || item.error) {
          const why = errorMessage(item.error, "failed");
          sink.step({ kind: "error", text: `${tool}: ${why}` });
          if (/approval/i.test(why)) log.warn(`${tool}: ${why}`);
        } else if (item.server !== CODEX_MCP_SERVER) {
          sink.step({ kind: "note", text: `codex finished ${item.server ?? "?"}.${tool}` });
        }
        return;
      }
      case "command_execution": {
        const cmd = Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
        const out = (item.aggregated_output ?? "").trim();
        sink.step({ kind: "note", text: `codex ran ${cmd.slice(0, 120)}${item.exit_code !== undefined ? ` (exit ${item.exit_code})` : ""}${out ? `: ${out.slice(0, 300)}` : ""}` });
        return;
      }
      case "error":
        // Not fatal (the turn goes on): e.g. "Exceeded skills context budget…" on every run.
        log.debug(`codex item error: ${item.message ?? "?"}`);
        return;
      default:
        return;
    }
  }

  private fail(state: RunState, error: string): void {
    if (state.failed || state.cancelled) return;
    state.failed = error;
    this.kill(state);
  }

  /** SIGINT first so Codex can tidy up, SIGKILL if it lingers. */
  private kill(state: RunState): void {
    const { child } = state;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGINT");
    } catch {
      // already gone
    }
    if (!state.killTimer) {
      state.killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, this.opts.killGraceMs ?? 3000);
    }
  }

  private settle(state: RunState, code: number | null, signal: NodeJS.Signals | null): void {
    if (state.timer) clearTimeout(state.timer);
    if (state.killTimer) clearTimeout(state.killTimer);
    if (this.current === state) {
      this.current = undefined;
      this.opts.runner.attach(undefined);
    }
    const ms = Date.now() - state.started;
    let result: BrainResult;
    if (state.cancelled) result = { status: "cancelled" };
    else if (state.failed) result = { status: "failed", error: state.failed };
    else if (state.completed || (code === 0 && state.candidate)) {
      const summary = state.candidate || "done.";
      this.remember(state.task.request, summary);
      result = { status: "done", summary };
    } else {
      const tail = state.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      result = { status: "failed", error: `Codex exited ${signal ? `on ${signal}` : `with code ${code ?? "?"}`} before finishing${tail ? `: ${tail}` : ""}` };
    }
    log.debug(`${result.status} in ${ms}ms after ${state.steps} step(s)`);
    state.resolve(result);
  }

  private remember(request: string, answer: string): void {
    const turns = this.opts.historyTurns ?? 3;
    if (turns <= 0) return;
    this.history.push({ request, answer });
    if (this.history.length > turns) this.history.splice(0, this.history.length - turns);
  }

  async cancel(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    cur.cancelled = true;
    this.kill(cur);
  }

  async stop(): Promise<void> {
    await this.cancel();
    const server = this.privateServer;
    this.privateServer = undefined;
    this.toolSocket = undefined;
    await server?.close();
    this.ready = false;
    this.readyDetail = "stopped";
    this.started = false; // a later start() probes again
    this.history = [];
  }
}

/**
 * The pid of the Jarhead daemon at the path (from its `hello`), or undefined
 * when nothing there answers like one within the timeout.
 */
export function daemonPidAt(socketPath: string, timeoutMs = 1000): Promise<number | undefined> {
  if (!existsSync(socketPath)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const client = new DaemonClient(socketPath);
    let done = false;
    const finish = (pid: number | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      resolve(pid);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    client.on("error", () => finish(undefined));
    client.on("close", () => finish(undefined));
    client.on("message", (m) => {
      if (m.type === "hello") finish(Number.isInteger(m.pid) ? m.pid : undefined);
    });
    client.connect({ pid: process.pid, audio: false }).catch(() => finish(undefined));
  });
}

/** True when a Jarhead daemon (any process) answers at the path within the timeout. */
export async function socketAnswers(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return (await daemonPidAt(socketPath, timeoutMs)) !== undefined;
}

/** An EngineLike that only has a runner: enough for `tool.run`, nothing else answers. */
function runnerOnlyEngine(runner: ToolRunner, stateDir: string): EngineLike {
  return {
    on: () => undefined,
    snapshot: () => ({ phase: "asleep", note: "codex tool socket" }),
    command: async () => undefined,
    feedMic: () => undefined,
    reportInputLevel: () => undefined,
    setMicrophonePermission: () => undefined,
    registerOwnPid: () => undefined,
    problem: (text) => log.warn(text),
    ledger: { read: () => [], days: () => [] },
    config: { stateDir },
    runner,
  };
}
