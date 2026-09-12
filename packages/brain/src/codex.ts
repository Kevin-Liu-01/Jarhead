import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineSplitter, REPO_ROOT, logger } from "@jarhead/core";
import { DaemonClient, DaemonServer, type EngineLike } from "@jarhead/daemon";
import { SECRET_KEYS, type Effort } from "@jarhead/protocol";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { SYSTEM_PROMPT_VERSION, brainSystemPrompt } from "./brain.ts";
import { delegationPrompt } from "./anthropic.ts";
import { progressLine } from "./responses.ts";
import type { ToolRunner } from "./runner.ts";
import { CODEX_MCP_SERVER, codexMcpConfigArgs, toml } from "./codex-config.ts";
import { CodexAppServer, type AppServerItem, type TurnResult, type UserInput } from "./codex-app-server.ts";

export { CODEX_MCP_SERVER } from "./codex-config.ts";

/**
 * The Codex brain: the Codex CLI (`codex exec`) on Kevin's ChatGPT login, with
 * Jarhead's tools mounted as an MCP server.
 *
 * Kevin uses Codex Desktop, which ships inside ChatGPT.app; the CLI binary sits
 * in its Resources folder and is not on PATH, so the finder below looks there
 * after JARHEAD_CODEX_BIN and PATH. Auth is whatever ~/.codex/auth.json holds
 * (a ChatGPT login, or an API key from `codex login --with-api-key`).
 *
 * Two transports, one brain. The warm one is a resident `codex app-server`
 * (`codex-app-server.ts`): started with the brain, one ephemeral thread that
 * lives across delegations — so "do it again" means something and the MCP bridge
 * is already up when a task arrives — each delegation one `turn/start`, a stop
 * one `turn/interrupt`, and a fresh thread once the context grows past its
 * rollover point (the last exchanges carried over as text). When the app-server
 * cannot start or dies, each delegation is one `codex exec --json --ephemeral`
 * run instead: the prompt on stdin, JSONL events on stdout, nothing left on
 * disk. The app-server's start never sits on a task's path: start() waits a
 * short patience window for it and reports "still starting" otherwise, a task
 * that arrives before it is up runs on exec, and a failed start is retried in
 * the background a minute later. `detail` says which transport is live and why.
 *
 * Either way Codex runs in its read-only sandbox with Kevin's own MCP servers off
 * (`--ignore-user-config` for exec; per-server `enabled=false` plus
 * `--disable apps` for the app-server, which has no such flag) — his config.toml
 * enables Codex's own computer-use, browser and REPL servers, and the plugin
 * runtime binds his ChatGPT connectors, which would let it act on the Mac and on
 * his accounts around Jarhead's policy — so the only way it can act is through
 * the `jarhead` MCP server (`mcp-bridge.ts`), whose calls land in the same
 * ToolRunner as every other brain: policy, ledger, screenshot archive,
 * confirmation handshake included. A call to any other MCP server fails the turn
 * outright. The bridge reaches the runner over the daemon socket when the daemon
 * is this process; otherwise (`jarhead live` / `probe`, or another Jarhead on the
 * default path) the brain serves a socket of its own. Jarhead's secrets never
 * enter Codex's environment.
 */

const log = logger("brain.codex");

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
  /** PNGs attached to the prompt with `-i` (the regions Kevin circled). */
  readonly images?: readonly string[] | undefined;
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
    // `-i <FILE>...` is variadic; one flag per file, and a flag always follows, so it never swallows the `-`.
    ...(o.images ?? []).flatMap((p) => ["-i", p]),
    ...(o.model ? ["-m", o.model] : []),
    ...(o.effort ? ["-c", `model_reasoning_effort=${toml(codexEffort(o.effort))}`] : []),
    ...codexMcpConfigArgs(o),
    "-C",
    o.cwd,
    "-",
  ];
}

/** What the Codex brain adds to the shared standing orders. */
export function codexAddendum(userName = "Kevin"): string {
  return `You are running as the Codex CLI in a read-only sandbox with no project of ${userName}'s: your own shell and file tools cannot change anything on this Mac and must not be used to act on it or to read from it. The sandbox does not stop you reading ~/.jarhead/env, ~/.ssh or the other secret stores; the standing orders do, and every read goes through read_file, list_dir, search_files and web_fetch of the "${CODEX_MCP_SERVER}" MCP server so those stores stay refused. Every action goes through that server's tools too (screenshot, zoom, left_click, type, key, scroll, open_app, read_focused_text, run_shell, read_file, edit_file, write_file, search_files, web_fetch, applescript, agents_list, self_edit, speak_progress and the rest) — use those, not your own shell, to read and change files on this Mac. When any of them returns needs_confirmation, do not retry it and do not work around it: make your final answer the one-sentence question it asked and stop; ${userName} will answer out loud and you will be asked again with the same tool and exactly the same arguments.`;
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
  /**
   * Which Codex to drive: `auto` (default) tries the resident app-server and falls
   * back to `exec` per task when it cannot start; `app-server` / `exec` force one.
   */
  readonly transport?: "auto" | "app-server" | "exec" | undefined;
  /** initialize + thread/start budget for the app-server (default 25 s). */
  readonly appServerStartTimeoutMs?: number | undefined;
  /** How long start() waits for the app-server before reporting ready on exec with the warm start continuing in the background (default 4 s). */
  readonly appServerPatienceMs?: number | undefined;
  /** After a failed start or a crash, the warm transport is tried again this much later (default 60 s). */
  readonly appServerRetryMs?: number | undefined;
  /** Test seam for the app-server process. */
  readonly spawnImpl?: typeof spawn | undefined;
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

/** A turn on the resident app-server, as this brain tracks it. */
interface WarmTurn {
  readonly task: BrainTask;
  readonly sink: BrainSink;
  readonly started: number;
  candidate: string | undefined;
  steps: number;
  /** Set when this brain asked for the interrupt itself (budget), so the result reads as failed, not cancelled. */
  failed: string | undefined;
  cancelled: boolean;
  timer: NodeJS.Timeout | undefined;
}

export class CodexBrain implements Brain {
  readonly kind = "codex";
  private probe: CodexProbe | undefined;
  private ready = false;
  private readyDetail = "not started";
  private started = false;
  private current: RunState | undefined;
  private warm: WarmTurn | undefined;
  private history: Array<{ request: string; answer: string }> = [];
  private toolSocket: string | undefined;
  private privateServer: DaemonServer | undefined;
  private readonly model: string | undefined;
  private appServer: CodexAppServer | undefined;
  /** Which transport the next task takes. */
  private transport: "app-server" | "exec" = "exec";
  /** Why the app-server is not in use, for the detail line and the log. */
  private appServerFailure: string | undefined;
  private appServerRetryAt = 0;
  /** The warm start in flight, if any: never awaited by a task, only by start()'s patience window. */
  private appServerStarting: Promise<string> | undefined;
  /** The detail line up to the transport fragment; `detail` completes it with the transport's current state. */
  private baseDetail = "";
  /** The next warm turn carries the recent exchanges as text (a fresh thread knows nothing). */
  private carryHistory = false;

  constructor(private readonly opts: CodexBrainOptions) {
    this.probe = opts.probe;
    this.model = opts.model?.trim() || undefined;
  }

  /** "app-server" (warm) or "exec" (per task): what the next delegation will use. */
  get activeTransport(): "app-server" | "exec" {
    return this.transport;
  }

  /** The one-line status as of now: the transport fragment follows the warm start as it lands, fails or falls. */
  get detail(): string {
    return this.ready && this.baseDetail ? `${this.baseDetail}; ${this.transportDetail()}` : this.readyDetail;
  }

  private transportDetail(): string {
    if (this.appServer?.running && this.transport === "app-server") return `warm app-server (thread ${this.appServer.thread?.slice(0, 8) ?? "?"})`;
    const transport = this.opts.transport ?? "auto";
    if (transport === "exec") return "codex exec per task";
    if (this.appServerStarting) return "codex exec per task until the app-server is up (still starting)";
    return this.appServerFailure ? `codex exec per task (app-server: ${this.appServerFailure})` : "codex exec per task";
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.started) return { ready: this.ready, detail: this.detail };
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
      // The warm transport gets a short patience window; past it the brain is ready
      // on exec and the app-server keeps starting in the background (an explicit
      // `transport: "app-server"` still waits for it, since there is no fallback).
      const starting = this.startAppServer(probe);
      const patience = this.opts.appServerPatienceMs ?? 4000;
      const warm = (this.opts.transport ?? "auto") === "app-server" ? await starting : await Promise.race([starting, new Promise<string>((r) => setTimeout(() => r("codex exec per task until the app-server is up (still starting)"), patience).unref?.())]);
      this.ready = true;
      this.baseDetail = `${probe.detail}; ${model ? `model ${model}` : "default model"}${this.model ? "" : model ? " (from ~/.codex/config.toml)" : ""}${this.opts.effort ? `, effort ${codexEffort(this.opts.effort)}` : ""}; tools over ${socket === this.opts.socketPath ? "the daemon socket" : "a private socket"}`;
      this.readyDetail = `${this.baseDetail}; ${warm}`;
      log.info(`ready; standing orders v${SYSTEM_PROMPT_VERSION}; transport ${this.transport}${this.appServerStarting ? " (app-server still starting)" : ""}`);
      return { ready: true, detail: this.readyDetail };
    } catch (e) {
      this.ready = false;
      this.readyDetail = (e as Error).message;
      return { ready: false, detail: this.readyDetail };
    }
  }

  /**
   * The warm transport: spawn the app-server and open its thread. Never throws
   * under `auto`; on any failure the brain runs `exec` per task and says so, and
   * tries again after the retry window. Returns the detail fragment for the ready
   * line. One start at a time: a second call while one is in flight joins it.
   */
  private startAppServer(probe: CodexProbe): Promise<string> {
    if (this.appServerStarting) return this.appServerStarting;
    const transport = this.opts.transport ?? "auto";
    if (transport === "exec" || !probe.bin || !this.toolSocket) {
      this.transport = "exec";
      return Promise.resolve("codex exec per task");
    }
    const bin = probe.bin;
    const base = this.opts.env ?? process.env;
    const codexHome = this.opts.codexHome ?? codexHomeDir(base);
    const server = new CodexAppServer({
      bin: bin.path,
      cwd: this.cwd(),
      env: codexEnv(base, codexHome),
      codexHome,
      model: this.model ?? probe.configModel,
      effort: this.opts.effort,
      node: this.node(),
      tsxCli: this.tsxCli(),
      bridgePath: this.bridgePath(),
      socketPath: this.toolSocket,
      developerInstructions: `${brainSystemPrompt(this.opts.userName)}\n\n${codexAddendum(this.opts.userName)}`,
      startTimeoutMs: this.opts.appServerStartTimeoutMs,
      killGraceMs: this.opts.killGraceMs,
      spawnImpl: this.opts.spawnImpl,
    });
    const t0 = Date.now();
    const starting = (async (): Promise<string> => {
      try {
        const r = await server.start();
        if (!this.started) {
          // stop() ran while we were starting: nothing may stay warm.
          await server.stop();
          return "codex exec per task";
        }
        this.appServer = server;
        this.transport = "app-server";
        this.appServerFailure = undefined;
        this.carryHistory = this.history.length > 0;
        server.on("exit", (reason) => {
          if (this.appServer !== server) return;
          this.appServer = undefined;
          this.transport = "exec";
          this.appServerFailure = reason;
          // Try the warm path again a minute later; until then exec carries the tasks.
          this.appServerRetryAt = Date.now() + (this.opts.appServerRetryMs ?? 60_000);
          log.warn(`falling back to codex exec per task: ${reason}`);
        });
        log.info(`warm app-server up after ${Date.now() - t0} ms (thread ${r.threadId.slice(0, 8)}, initialize ${r.initMs} ms, thread/start ${r.threadMs} ms)`);
        return `warm app-server (thread ${r.threadId.slice(0, 8)}, initialize ${r.initMs} ms, thread/start ${r.threadMs} ms)`;
      } catch (e) {
        this.transport = "exec";
        this.appServerFailure = (e as Error).message;
        this.appServerRetryAt = Date.now() + (this.opts.appServerRetryMs ?? 60_000);
        log.warn(`app-server unavailable after ${Date.now() - t0} ms (${this.appServerFailure}); codex exec per task`);
        if (transport === "app-server") throw new Error(`codex app-server: ${this.appServerFailure}`);
        return `codex exec per task (app-server: ${this.appServerFailure})`;
      } finally {
        this.appServerStarting = undefined;
      }
    })();
    this.appServerStarting = starting;
    return starting;
  }

  /**
   * Before a task: the warm transport if it is up; else exec — now, without
   * waiting. A warm start that is due (first time, or the retry window has passed)
   * is kicked off in the background for the tasks that follow.
   */
  private ensureTransport(): "app-server" | "exec" {
    if (this.appServer?.running) return "app-server";
    const transport = this.opts.transport ?? "auto";
    if (transport === "exec" || !this.probe || !this.started) return "exec";
    if (!this.appServerStarting && Date.now() >= this.appServerRetryAt) {
      const probe = this.probe;
      log.info("warm app-server is not up; this task runs on exec while it starts");
      this.startAppServer(probe).catch((e: Error) => log.warn(`app-server start failed: ${e.message}`));
    }
    return "exec";
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

  /** The whole prompt; `attached` are the images going in with `-i`, so the preamble numbers exactly those. */
  private prompt(task: BrainTask, attached: readonly BrainAttachment[]): string {
    const parts = [brainSystemPrompt(this.opts.userName), codexAddendum(this.opts.userName)];
    if (this.history.length > 0) {
      parts.push(["Earlier in this session:", ...this.history.flatMap((h) => [`${this.opts.userName ?? "Kevin"} said: "${h.request}"`, `You answered: ${h.answer}`])].join("\n"));
    }
    parts.push(delegationPrompt(task, this.opts.userName, attached));
    return parts.join("\n\n");
  }

  /**
   * At wake: the resident app-server and its thread, started now if it is not up
   * (or its retry is due), never awaited by a task. Reuses the thread across
   * delegations; a fresh one is opened only when the context rolls over.
   */
  async warmUp(): Promise<{ warm: boolean; detail: string }> {
    if (!this.ready || !this.probe?.bin) return { warm: false, detail: this.readyDetail };
    const transport = this.ensureTransport();
    if (transport === "app-server" && this.appServer) return { warm: true, detail: `warm app-server, thread ${this.appServer.thread?.slice(0, 8) ?? "?"} reused across tasks` };
    return { warm: false, detail: this.appServerStarting ? "app-server starting in the background; the next task runs on exec if it lands first" : this.detail };
  }

  async handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const probe = this.probe;
    if (!this.ready || !probe?.bin || !this.toolSocket) return { status: "failed", error: this.readyDetail };
    if (this.current || this.warm) return { status: "failed", error: "already handling a task" };
    if (task.signal.aborted) return { status: "cancelled" };
    if (this.ensureTransport() === "app-server" && this.appServer) return this.handleWarm(task, sink, this.appServer);
    return this.handleExec(task, sink, probe);
  }

  // ------------------------------------------------------------ warm turns

  private async handleWarm(task: BrainTask, sink: BrainSink, server: CodexAppServer): Promise<BrainResult> {
    const attached = existingAttachments(task);
    // A thread that grew past its rollover point is replaced before this task; the
    // recent exchanges ride along as text so a "yes" still knows what it confirms.
    if (server.needsFreshThread()) {
      try {
        const id = await server.freshThread();
        this.carryHistory = true;
        log.info(`context rolled over to a fresh thread ${id.slice(0, 8)} (${server.tokenUsage?.totalTokens ?? "?"} tokens used)`);
      } catch (e) {
        log.warn(`could not start a fresh thread (${(e as Error).message}); staying on the old one`);
      }
    }
    const parts: string[] = [];
    if (this.carryHistory && this.history.length > 0) {
      parts.push(["Earlier in this session:", ...this.history.flatMap((h) => [`${this.opts.userName ?? "Kevin"} said: "${h.request}"`, `You answered: ${h.answer}`])].join("\n"));
    }
    this.carryHistory = false;
    parts.push(delegationPrompt(task, this.opts.userName, attached));
    const input: UserInput[] = [{ type: "text", text: parts.join("\n\n"), text_elements: [] }, ...attached.map((a): UserInput => ({ type: "localImage", path: a.path, detail: "high" }))];

    const warm: WarmTurn = { task, sink, started: Date.now(), candidate: undefined, steps: 0, failed: undefined, cancelled: false, timer: undefined };
    this.warm = warm;
    this.opts.runner.attach(sink, task);
    const maxWallMs = this.opts.maxWallMs ?? 5 * 60_000;
    warm.timer = setTimeout(() => this.failWarm(warm, server, `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds`), maxWallMs);
    const onAbort = (): void => {
      warm.cancelled = true;
      void server.interrupt();
    };
    task.signal.addEventListener("abort", onAbort, { once: true });
    let result: TurnResult;
    try {
      result = await server.turn(input, {
        onItemStarted: (item) => this.onWarmItemStarted(warm, server, item),
        onItemCompleted: (item) => this.onWarmItemCompleted(warm, item),
        onWarning: (m) => log.debug(`codex warning: ${m}`),
        onError: (m, willRetry) => {
          if (willRetry) sink.step({ kind: "note", text: `codex: ${m.slice(0, 200)} (retrying)` });
          else this.failWarm(warm, server, m);
        },
      });
    } catch (e) {
      result = { status: "failed", error: (e as Error).message, turnId: "" };
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      if (warm.timer) clearTimeout(warm.timer);
      if (this.warm === warm) {
        this.warm = undefined;
        this.opts.runner.attach(undefined);
      }
    }
    const ms = Date.now() - warm.started;
    let out: BrainResult;
    if (warm.cancelled || (result.status === "interrupted" && !warm.failed)) out = { status: "cancelled" };
    else if (warm.failed) out = { status: "failed", error: warm.failed };
    else if (result.status === "failed") out = { status: "failed", error: result.error ?? "the Codex turn failed" };
    else {
      const summary = warm.candidate || "done.";
      this.remember(task.request, summary);
      out = { status: "done", summary };
    }
    log.debug(`${out.status} in ${ms}ms after ${warm.steps} step(s) (app-server)`);
    return out;
  }

  private failWarm(warm: WarmTurn, server: CodexAppServer, error: string): void {
    if (warm.failed || warm.cancelled) return;
    warm.failed = error;
    void server.interrupt();
  }

  private onWarmItemStarted(warm: WarmTurn, server: CodexAppServer, item: AppServerItem): void {
    const { sink } = warm;
    switch (item.type) {
      case "mcpToolCall": {
        if (!this.countWarmStep(warm, server)) return;
        const tool = item.tool ?? "?";
        if (item.server === CODEX_MCP_SERVER) {
          sink.thinking(progressLine(tool, item.arguments));
          return;
        }
        // Every other MCP server is switched off in the argv; a call to one means Codex
        // found a way around Jarhead's policy, and the turn ends there.
        sink.step({ kind: "error", text: `codex tried to act around Jarhead through ${item.server ?? "?"}.${tool}; the turn was stopped` });
        this.failWarm(warm, server, aroundJarhead(item.server, tool));
        return;
      }
      case "commandExecution": {
        if (!this.countWarmStep(warm, server)) return;
        sink.thinking(`Codex is looking with ${(item.command ?? "").slice(0, 60) || "a command"}.`);
        return;
      }
      default:
        return;
    }
  }

  private countWarmStep(warm: WarmTurn, server: CodexAppServer): boolean {
    const maxSteps = this.opts.maxSteps ?? 40;
    if (++warm.steps > maxSteps) {
      this.failWarm(warm, server, `I stopped after ${maxSteps} tool calls without finishing`);
      return false;
    }
    return true;
  }

  private onWarmItemCompleted(warm: WarmTurn, item: AppServerItem): void {
    const { sink } = warm;
    switch (item.type) {
      case "agentMessage": {
        const text = (item.text ?? "").trim();
        if (!text) return;
        if (warm.candidate) sink.step({ kind: "note", text: warm.candidate.slice(0, 1000) });
        warm.candidate = text;
        // Before the first tool call this is the only speakable thing; see the exec path.
        if (warm.steps === 0) sink.thinking(text.slice(0, 200));
        return;
      }
      case "reasoning": {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join(" ").trim();
        if (text) sink.thinking(text.slice(0, 300));
        return;
      }
      case "mcpToolCall": {
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
      case "commandExecution": {
        const out = (item.aggregatedOutput ?? "").trim();
        sink.step({ kind: "note", text: `codex ran ${(item.command ?? "").slice(0, 120)}${item.exitCode !== undefined && item.exitCode !== null ? ` (exit ${item.exitCode})` : ""}${out ? `: ${out.slice(0, 300)}` : ""}` });
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------- exec runs

  private handleExec(task: BrainTask, sink: BrainSink, probe: CodexProbe): Promise<BrainResult> {
    const bin = probe.bin;
    if (!bin || !this.toolSocket) return Promise.resolve({ status: "failed", error: this.readyDetail });
    const attached = existingAttachments(task);
    const args = codexExecArgs({
      cwd: this.cwd(),
      model: this.model ?? probe.configModel,
      effort: this.opts.effort,
      node: this.node(),
      tsxCli: this.tsxCli(),
      bridgePath: this.bridgePath(),
      socketPath: this.toolSocket,
      images: attached.map((a) => a.path),
    });
    const base = this.opts.env ?? process.env;
    const env = codexEnv(base, this.opts.codexHome ?? codexHomeDir(base));
    this.opts.runner.attach(sink, task);
    return new Promise<BrainResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin.path, args, { cwd: this.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
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
      child.stdin?.end(this.prompt(task, attached));
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
        if (item.server === CODEX_MCP_SERVER) {
          sink.thinking(progressLine(tool, item.arguments));
          return;
        }
        // exec runs with --ignore-user-config, so no other server should exist; one that does is a way around the policy.
        sink.step({ kind: "error", text: `codex tried to act around Jarhead through ${item.server ?? "?"}.${tool}; the run was stopped` });
        this.fail(state, aroundJarhead(item.server, tool));
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
    const warm = this.warm;
    if (warm) {
      warm.cancelled = true;
      await this.appServer?.interrupt();
    }
    const cur = this.current;
    if (!cur) return;
    cur.cancelled = true;
    this.kill(cur);
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.started = false; // a later start() probes again; a warm start still in flight sees this and stops its server
    const app = this.appServer;
    this.appServer = undefined;
    await app?.stop();
    const server = this.privateServer;
    this.privateServer = undefined;
    this.toolSocket = undefined;
    await server?.close();
    this.ready = false;
    this.readyDetail = "stopped";
    this.baseDetail = "";
    this.transport = "exec";
    this.appServerRetryAt = 0;
    this.history = [];
  }
}

/** The error a turn ends with when Codex calls an MCP server other than Jarhead's. */
function aroundJarhead(server: string | undefined, tool: string): string {
  return `Codex tried to act around Jarhead (an MCP call to ${server ?? "?"}.${tool}); the turn was stopped`;
}

/** The circled regions Codex gets with `-i`; a file already gone is left out rather than failing the run, and the prompt names only these. */
function existingAttachments(task: BrainTask): BrainAttachment[] {
  return (task.attachments ?? []).filter((a) => existsSync(a.path));
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
    ear: () => undefined,
    feedMic: () => undefined,
    reportInputLevel: () => undefined,
    setMicrophonePermission: () => undefined,
    registerOwnPid: () => undefined,
    problem: (text) => log.warn(text),
    ledger: { read: () => [], days: () => [], sessions: () => [], readSession: () => [] },
    config: { stateDir },
    runner,
  };
}
