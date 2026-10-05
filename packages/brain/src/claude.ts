import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "@jarhead/core";
import { ClaudeSession, claudeEnv, loadSdk, type PermissionDecision, type SdkLike, type SdkMessage } from "@jarhead/agents";
import type { Brain, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { SYSTEM_PROMPT_VERSION, brainSystemPrompt } from "./brain.ts";
import { toolSpecsFor, type ToolSpec } from "./tools.ts";
import { progressLine } from "./responses.ts";
import { delegationPrompt } from "./anthropic.ts";
import { loadAttachments } from "./attachments.ts";
import type { ToolRunner } from "./runner.ts";

/**
 * The Claude brain: one persistent headless Claude Code session (Agent SDK) with
 * Jarhead's tools mounted as an in-process MCP server, and no other tools.
 *
 * It runs on the Claude login on this Mac, in an empty folder Jarhead owns, with no
 * user, project or local settings: a stale key, allow rules, hooks or MCP servers in
 * ~/.claude never reach it. Its built-in tools are switched off, so every read,
 * write, command and fetch goes through the jarhead tools and the policy behind
 * them. Each delegation is one user turn on the same session, so context (what it
 * saw, what it did) carries across turns; each turn's result is matched to the
 * turn that asked for it.
 */

const log = logger("brain.claude");

/** How long `claude auth status` may take before the brain is declared unavailable. */
export const LOGIN_TIMEOUT_MS = 5000;
/** Tool calls per delegation before the brain gives up (the other brains' number). */
export const CLAUDE_MAX_STEPS = 40;
/** Wall clock per delegation. */
export const CLAUDE_MAX_WALL_MS = 5 * 60_000;
/** How long a new task waits for the result of the turn it superseded before it is sent anyway. */
const STALE_RESULT_MS = 5000;
/** A login one brain proved is reused by the brains started after it (the thread spares) for this long. */
const PROVEN_LOGIN_MS = 10 * 60_000;
/**
 * The CLI's built-ins. `tools: []` switches them all off; naming them here as well blocks any harness-internal call.
 * ToolSearch goes too: without it the CLI turns tool search off and puts the jarhead tools in every request as they are.
 */
const BUILTIN_TOOLS = ["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent", "Skill", "ToolSearch"];
/** A turn that failed on the login rather than on the task. */
const AUTH_FAILURE = /authenticat|\b401\b|oauth|invalid api key|\/login|not logged in|log in again|token (?:has )?expired/i;
const SIGNED_OUT = "Claude Code is not signed in. Run claude auth login.";
const SETTINGS_KEY_ONLY = "Claude Code has only an API key from its own settings, which Jarhead does not load. Run claude auth login.";

export interface ClaudeBrainOptions {
  readonly runner: ToolRunner;
  /** Jarhead's state folder: the session works in `<stateDir>/claude-cwd`. */
  readonly stateDir?: string;
  /** Test seam: how the login the session will use is checked. Default: probeClaudeLogin, no model call. */
  readonly authProbe?: () => Promise<AuthProbe | ClaudeLogin>;
  /** How long the login check may take (default LOGIN_TIMEOUT_MS). */
  readonly probeTimeoutMs?: number;
  readonly model?: string;
  readonly effort?: string;
  /** The session's working folder (default `<stateDir>/claude-cwd`). No settings are read from it either way. */
  readonly cwd?: string;
  readonly pathToClaudeCodeExecutable?: string;
  /** Keep ANTHROPIC_API_KEY out of the session so it runs on the Claude login (default true). */
  readonly dropApiKey?: boolean;
  /** Tool calls per delegation (default CLAUDE_MAX_STEPS). */
  readonly maxSteps?: number;
  /** Wall clock per delegation (default CLAUDE_MAX_WALL_MS). */
  readonly maxWallMs?: number;
  readonly sdk?: SdkLike;
  /** What the standing orders call the person Jarhead works for (release F1); the engine passes the effective name. */
  readonly userName?: string | undefined;
  /** Test seam: builds the MCP server config from tool specs (rendered in the user's name, which the server's instructions say too). */
  readonly mcpFactory?: (specs: readonly ToolSpec[], call: (name: string, args: unknown) => Promise<McpResult>, userName: string) => Promise<Record<string, unknown>>;
}

export interface McpResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}


export type AuthProbe = "valid" | "invalid" | "none";

/** What the login check found: whether the session can authenticate, how, and if not, why. */
export interface ClaudeLogin {
  readonly verdict: AuthProbe;
  /** How the session authenticates, for the ready line: "Claude login", "OAuth token", "api key", "bedrock". */
  readonly via?: string;
  /** Why it cannot, in words Kevin can act on. */
  readonly detail?: string;
}

/** One cheap request that tells a working key from a rejected one; "none" when the API could not be asked. */
export async function probeAnthropicKey(key: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<AuthProbe> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 200 ? "valid" : r.status === 401 || r.status === 403 ? "invalid" : "none";
  } catch {
    return "none";
  }
}

/** The CLI the Agent SDK spawns when it is given no path: its own native build. */
export function bundledClaudeBinary(): string | undefined {
  try {
    const sdk = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    return undefined;
  }
}

/**
 * The login a headless session will use, checked without a model call. A key the session is handed is asked of the
 * API once; otherwise `claude auth status` reports the login from the session's own environment and folder. A key
 * that only Claude Code's settings hold does not count: the session loads no settings, so it never sees that key.
 */
export async function probeClaudeLogin(o: { readonly env: Record<string, string | undefined>; readonly bin: string | undefined; readonly cwd: string; readonly timeoutMs?: number | undefined }): Promise<ClaudeLogin> {
  const timeoutMs = o.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const key = o.env["ANTHROPIC_API_KEY"];
  if (key) {
    const k = await probeAnthropicKey(key, timeoutMs);
    if (k === "valid") return { verdict: "valid", via: "api key" };
    if (k === "invalid") return { verdict: "invalid", detail: "ANTHROPIC_API_KEY is rejected by the API." };
  }
  if (!o.bin) return { verdict: "none", detail: "No Claude Code binary to ask about the login." };
  const status = await authStatus(o.bin, o.env, o.cwd, timeoutMs);
  if ("error" in status) return { verdict: "none", detail: status.error };
  if (!status.loggedIn) return { verdict: "none", detail: SIGNED_OUT };
  switch (status.authMethod) {
    case "claude.ai":
      return { verdict: "valid", via: "Claude login" };
    case "oauth_token":
      return { verdict: "valid", via: "OAuth token" };
    case "third_party":
      return { verdict: "valid", via: status.apiProvider ?? "a cloud provider" };
    case "api_key":
      // The key in the session's own environment, which the API could not be asked about; otherwise one from settings.
      return key ? { verdict: "valid", via: "api key" } : { verdict: "invalid", detail: SETTINGS_KEY_ONLY };
    case "api_key_helper":
      return { verdict: "invalid", detail: SETTINGS_KEY_ONLY };
    default:
      return { verdict: "valid", via: status.authMethod && status.authMethod !== "none" ? status.authMethod : "its own login" };
  }
}

/** `claude auth status --json`: what the CLI knows locally (exit 1 when signed out); no model request. */
function authStatus(bin: string, env: Record<string, string | undefined>, cwd: string, timeoutMs: number): Promise<{ loggedIn: boolean; authMethod?: string; apiProvider?: string } | { error: string }> {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  return new Promise((resolve) => {
    const child = execFile(bin, ["auth", "status", "--json"], { env: clean, cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err && (err as { killed?: boolean }).killed) {
        resolve({ error: `Claude Code did not report its login within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.` });
        return;
      }
      const text = String(stdout);
      try {
        const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown };
        if (typeof j.loggedIn !== "boolean") throw new Error("no loggedIn");
        resolve({ loggedIn: j.loggedIn, ...(typeof j.authMethod === "string" ? { authMethod: j.authMethod } : {}), ...(typeof j.apiProvider === "string" ? { apiProvider: j.apiProvider } : {}) });
      } catch {
        resolve({ error: `Claude Code could not report its login: ${err ? (err.message.split("\n")[0] ?? "it failed") : "its answer was unreadable"}.` });
      }
    });
    // It reads nothing: stdin closes at once, so the check never waits on input.
    child.stdin?.end();
  });
}

/** Logins checked by the default probe, by binary, config folder and key presence: a valid one is shared, a failed one forgotten. */
const logins = new Map<string, { at: number; login: Promise<ClaudeLogin> }>();

function asLogin(p: AuthProbe | ClaudeLogin): ClaudeLogin {
  if (typeof p !== "string") return p;
  if (p === "valid") return { verdict: "valid", via: "signed in" };
  return p === "invalid" ? { verdict: "invalid", detail: "Claude Code's login was rejected. Run claude auth login." } : { verdict: "none", detail: SIGNED_OUT };
}

function resultError(msg: SdkMessage): string {
  if (typeof msg.result === "string" && msg.result) return msg.result;
  const errors = Array.isArray(msg["errors"]) ? (msg["errors"] as unknown[]).filter((e): e is string => typeof e === "string") : [];
  return errors.join("; ") || "turn failed";
}

const refusal = (text: string): McpResult => ({ content: [{ type: "text", text }], isError: true });

/** One delegation on the session: its user message's turn number once sent, and what that turn has said and done. */
interface Job {
  readonly task: BrainTask;
  readonly sink: BrainSink;
  readonly resolve: (r: BrainResult) => void;
  turn?: number;
  steps: number;
  readonly texts: string[];
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export class ClaudeBrain implements Brain {
  readonly kind = "claude-code";
  private session: ClaudeSession | undefined;
  private current: Job | undefined;
  private ready = false;
  private readyDetail = "not started";

  constructor(private readonly opts: ClaudeBrainOptions) {}

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.session) return { ready: this.ready, detail: this.readyDetail };
    let session: ClaudeSession | undefined;
    try {
      const sdk = this.opts.sdk ?? (await loadSdk());
      const who = this.opts.userName ?? "Kevin";
      const mcp = await (this.opts.mcpFactory ?? defaultMcpFactory)(toolSpecsFor(who), (name, args) => this.callTool(name, args), who);
      const cwd = this.workDir();
      const env = claudeEnv(process.env, { dropApiKey: this.opts.dropApiKey ?? true });
      session = new ClaudeSession({
        sdk,
        cwd,
        name: "jarhead-brain",
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        ...(this.opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable } : {}),
        systemPromptAppend: brainSystemPrompt(this.opts.userName),
        // The brain's transcript is Jarhead's, not Kevin's: keep it out of his resume list.
        persistSession: false,
        mcpServers: { jarhead: mcp },
        strictMcpConfig: true,
        tools: [],
        disallowedTools: BUILTIN_TOOLS,
        permissionMode: "default",
        // No user, project or local settings: ~/.claude/settings.json's env key and allow rules stay out.
        settingSources: [],
        // The CLI's own backstop under the step cap: one round trip per step, and the answer.
        maxTurns: (this.opts.maxSteps ?? CLAUDE_MAX_STEPS) + 1,
        env,
        includePartialMessages: true,
        canUseTool: (toolName, input) => this.permission(toolName, input),
      });
      this.wire(session);
      this.session = session;
      // The CLI boots while its login is checked; a login that does not hold closes it again.
      session.start();
      const login = await this.checkLogin(env, cwd);
      if (login.verdict !== "valid") {
        this.session = undefined;
        await session.close();
        this.ready = false;
        this.readyDetail = login.detail ?? SIGNED_OUT;
        return { ready: false, detail: this.readyDetail };
      }
      // Stopped, or the CLI exited, while the login was checked.
      if (this.session !== session || session.status === "offline") return { ready: false, detail: this.readyDetail };
      this.ready = true;
      this.readyDetail = `headless Claude Code (${this.opts.model || "default model"}, ${login.via ?? "signed in"})`;
      log.info(`ready; standing orders v${SYSTEM_PROMPT_VERSION}`);
      return { ready: true, detail: this.readyDetail };
    } catch (e) {
      if (session && this.session === session) {
        this.session = undefined;
        void session.close().catch(() => undefined);
      }
      this.ready = false;
      this.readyDetail = (e as Error).message;
      return { ready: false, detail: this.readyDetail };
    }
  }

  /** The Agent SDK session is the warm thread: one process, one `send` per task; there is nothing more to start. */
  async warmUp(): Promise<{ warm: boolean; detail: string }> {
    return { warm: this.ready && this.session !== undefined, detail: this.ready ? `${this.readyDetail}; one session reused across tasks` : this.readyDetail };
  }

  /** An empty folder Jarhead owns. The session loads no settings, CLAUDE.md or .mcp.json from any folder; this one has none to load. */
  private workDir(): string {
    const dir = this.opts.cwd ?? join(this.opts.stateDir ?? join(tmpdir(), "jarhead"), "claude-cwd");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The login the session will use. A spare started after the main brain reuses the login main proved: no second check, no model request. */
  private checkLogin(env: Record<string, string | undefined>, cwd: string): Promise<ClaudeLogin> {
    if (this.opts.authProbe) return this.opts.authProbe().then(asLogin);
    const bin = this.opts.pathToClaudeCodeExecutable ?? bundledClaudeBinary();
    const key = [bin ?? "", env["CLAUDE_CONFIG_DIR"] ?? "", env["ANTHROPIC_API_KEY"] ? "key" : "login"].join("\0");
    const hit = logins.get(key);
    if (hit && Date.now() - hit.at < PROVEN_LOGIN_MS) return hit.login;
    const login: Promise<ClaudeLogin> = probeClaudeLogin({ env, bin, cwd, timeoutMs: this.opts.probeTimeoutMs }).then((l) => {
      if (l.verdict !== "valid" && logins.get(key)?.login === login) logins.delete(key);
      return l;
    });
    logins.set(key, { at: Date.now(), login });
    return login;
  }

  private wire(session: ClaudeSession): void {
    const mine = (): boolean => this.session === session;
    session.on("tool", (t) => {
      // Our own MCP tools report and count in callTool; anything else only gets a line here, and counts as a step.
      if (!mine() || t.name.startsWith("mcp__jarhead__")) return;
      const job = this.live();
      if (!job) return;
      job.sink.thinking(progressLine(t.name, t.input));
      this.countStep(job);
    });
    session.on("assistant", (text) => {
      const job = mine() ? this.live() : undefined;
      if (!job) return;
      job.texts.push(text);
      job.sink.step({ kind: "note", text: text.slice(0, 1000) });
    });
    session.on("result", (msg, turn) => {
      if (!mine()) return;
      const job = this.current;
      if (!job || job.turn !== turn) {
        // The result of a turn its task already gave up on (an interrupt, the wall clock), or one nobody asked for.
        log.debug(`dropped the result of turn ${turn} (${msg.subtype ?? "result"})`);
        return;
      }
      if (msg.is_error) {
        this.finish(job, { status: "failed", error: resultError(msg) });
        return;
      }
      const answer = job.texts.join("\n").trim() || (typeof msg.result === "string" ? msg.result.trim() : "") || "done.";
      this.finish(job, { status: "done", summary: answer });
    });
    session.on("error", (e) => {
      if (!mine()) return;
      log.warn(`session error: ${e.message}`);
      if (AUTH_FAILURE.test(e.message)) {
        this.ready = false;
        this.readyDetail = `Claude Code is not authenticated: ${e.message}`;
        logins.clear();
      }
    });
    session.on("closed", () => {
      if (!mine()) return;
      this.ready = false;
      this.readyDetail = "session closed";
      if (this.current) this.finish(this.current, { status: "failed", error: "Claude session closed" });
    });
  }

  /** The current task, while the CLI is on that task's own turn (not on the one it superseded). */
  private live(): Job | undefined {
    const job = this.current;
    return job?.turn !== undefined && this.session?.runningTurn === job.turn ? job : undefined;
  }

  /** Counts one tool call; past the cap the task fails and its turn is interrupted. */
  private countStep(job: Job): boolean {
    const maxSteps = this.opts.maxSteps ?? CLAUDE_MAX_STEPS;
    if (++job.steps <= maxSteps) return true;
    void this.abandon(job, { status: "failed", error: `I stopped after ${maxSteps} tool calls without finishing` });
    return false;
  }

  private finish(job: Job, result: BrainResult): void {
    if (this.current !== job) return;
    this.current = undefined;
    if (job.timer) clearTimeout(job.timer);
    if (job.onAbort) job.task.signal.removeEventListener("abort", job.onAbort);
    this.opts.runner.attach(undefined);
    job.resolve(result);
  }

  /** Answers the task now and interrupts its turn if the CLI is still on it or has it queued; that turn's result is dropped when it comes. */
  private abandon(job: Job, result: BrainResult): Promise<void> {
    if (this.current !== job) return Promise.resolve();
    const session = this.session;
    const running = session?.runningTurn;
    this.finish(job, result);
    return session && job.turn !== undefined && running !== undefined && job.turn >= running ? session.interrupt() : Promise.resolve();
  }

  private async permission(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    if (toolName.startsWith("mcp__jarhead__")) return { behavior: "allow" };
    if (toolName === "TodoWrite") return { behavior: "allow" };
    // The SDK's own Read/Glob/Grep/WebFetch/WebSearch would bypass classifyPath and
    // classifyUrl (a Read of ~/.jarhead/env, a WebFetch of 10.0.0.1). Every read goes
    // through the jarhead tools so the secret stores and private hosts stay gated.
    const redirect: Record<string, string> = { Read: "read_file", Glob: "list_dir or search_files", Grep: "search_files", LS: "list_dir", WebFetch: "web_fetch", WebSearch: "web_search", Edit: "edit_file", Write: "write_file", MultiEdit: "edit_file", NotebookEdit: "edit_file" };
    if (redirect[toolName]) return { behavior: "deny", message: `${toolName} is not available to the desktop brain; use the jarhead tool ${redirect[toolName]} so the path and URL gates apply` };
    if (toolName === "Bash") {
      // Route shell through the same policy as run_shell so the confirmation
      // handshake is one mechanism, not two.
      const command = String(input["command"] ?? "");
      const outcome = await this.opts.runner.run("run_shell", { command });
      if (outcome.result.kind === "text") return { behavior: "deny", message: `already ran via Jarhead's run_shell; output:\n${outcome.result.text.slice(0, 4000)}` };
      if (outcome.result.kind === "needs-confirmation") return { behavior: "deny", message: outcome.result.question };
      return { behavior: "deny", message: outcome.result.kind === "error" ? outcome.result.message : "denied" };
    }
    return { behavior: "deny", message: `${toolName} is not available to the desktop brain; use the jarhead tools` };
  }

  private async callTool(name: string, args: unknown): Promise<McpResult> {
    // Nothing acts without a delegation: a call from a turn its task gave up on (a stop, a supersede) never runs.
    const job = this.live();
    if (!job) return refusal(`refused: no task is running in Jarhead; ${name} was not run (${this.opts.userName || "Kevin"} stopped the task, or it finished)`);
    if (!this.countStep(job)) return refusal(`refused: I stopped after ${this.opts.maxSteps ?? CLAUDE_MAX_STEPS} tool calls without finishing; ${name} was not run`);
    job.sink.thinking(progressLine(name, args));
    const outcome = await this.opts.runner.run(name, args);
    const r = outcome.result;
    switch (r.kind) {
      case "image":
        return { content: [{ type: "image", data: r.pngBase64, mimeType: "image/png" }, { type: "text", text: `${r.width}x${r.height} px${r.note ? `; ${r.note}` : ""}` }] };
      case "text":
        return { content: [{ type: "text", text: r.text }] };
      case "needs-confirmation":
        return { content: [{ type: "text", text: `needs_confirmation: ${r.question}` }] };
      case "error":
        return { content: [{ type: "text", text: `error: ${r.message}` }], isError: true };
    }
  }

  handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const session = this.session;
    if (!session || !this.ready) return Promise.resolve({ status: "failed", error: this.readyDetail });
    if (this.current) return Promise.resolve({ status: "failed", error: "already handling a task" });
    if (task.signal.aborted) return Promise.resolve({ status: "cancelled" });
    return new Promise<BrainResult>((resolve) => {
      const job: Job = { task, sink, resolve, steps: 0, texts: [] };
      this.current = job;
      job.onAbort = () => void this.abandon(job, { status: "cancelled" });
      task.signal.addEventListener("abort", job.onAbort, { once: true });
      const maxWallMs = this.opts.maxWallMs ?? CLAUDE_MAX_WALL_MS;
      job.timer = setTimeout(() => void this.abandon(job, { status: "failed", error: `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds` }), maxWallMs);
      job.timer.unref?.();
      void this.send(session, job);
    });
  }

  /**
   * Sends the task's turn. A turn this task superseded may not have its result yet; the brain stays busy until it
   * does (≤ 5 s), so that result can never be taken for this task's answer. Past that it sends anyway, and the late
   * result is still told apart by its turn number.
   */
  private async send(session: ClaudeSession, job: Job): Promise<void> {
    if (session.turnsInFlight > 0 && !(await session.settled(STALE_RESULT_MS))) log.warn(`the superseded turn had no result after ${STALE_RESULT_MS} ms; sending the next task anyway`);
    if (this.current !== job || this.session !== session) return;
    // The same words as the API brains; the circled regions ride as image blocks of
    // this user turn (ClaudeSession builds Anthropic-shaped content), and the prompt
    // says what each one is.
    const attachments = loadAttachments(job.task);
    const prompt = delegationPrompt(job.task, this.opts.userName, attachments);
    this.opts.runner.attach(job.sink, job.task);
    try {
      job.turn = session.send(prompt, attachments.map((a) => ({ pngBase64: a.pngBase64 })));
    } catch (e) {
      this.finish(job, { status: "failed", error: (e as Error).message });
    }
  }

  async cancel(): Promise<void> {
    if (this.current) await this.abandon(this.current, { status: "cancelled" });
  }

  async stop(): Promise<void> {
    await this.cancel();
    const session = this.session;
    this.session = undefined;
    this.ready = false;
    this.readyDetail = "stopped";
    await session?.close();
  }
}

/** Build the in-process MCP server with the real Agent SDK. */
async function defaultMcpFactory(specs: readonly ToolSpec[], call: (name: string, args: unknown) => Promise<McpResult>, userName: string): Promise<Record<string, unknown>> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
    createSdkMcpServer: (o: { name: string; version?: string; instructions?: string; tools: unknown[] }) => unknown;
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<McpResult>) => unknown;
  };
  const tools = specs.map((spec) => sdk.tool(spec.name, spec.description, zodShape(spec), (args) => call(spec.name, args)));
  return sdk.createSdkMcpServer({ name: "jarhead", version: "2.0.0", instructions: `Jarhead's eyes, hands, and agents on ${userName}'s Mac.`, tools }) as Record<string, unknown>;
}

/** Our tool schemas use a small vocabulary; map it to zod for the SDK. */
export function zodShape(spec: ToolSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(spec.parameters.required ?? []);
  for (const [key, raw] of Object.entries(spec.parameters.properties)) {
    const prop = raw as { type?: string | string[]; enum?: string[]; items?: { type?: string }; description?: string; minimum?: number; maximum?: number };
    let t: z.ZodTypeAny;
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    if (prop.enum) t = z.enum(prop.enum as [string, ...string[]]);
    else if (type === "number" || type === "integer") t = z.number();
    else if (type === "boolean") t = z.boolean();
    // Arrays of numbers (coordinates), of [x, y] pairs (show_stroke), of objects (automation_set's `then`), or of strings.
    else if (type === "array") t = z.array(prop.items?.type === "number" ? z.number() : prop.items?.type === "array" ? z.array(z.number()) : prop.items?.type === "object" ? z.object({}).passthrough() : z.string());
    else if (Array.isArray(prop.type)) t = z.union([z.string(), z.number()]);
    // A nested object (thread_start's `budget`): its own shape, extra keys allowed — the bridge and the
    // Responses/Anthropic brains pass the JSON schema through untouched; only this SDK path needs zod.
    else if (type === "object") {
      const nested = raw as { properties?: Record<string, unknown>; required?: readonly string[] };
      t = z.object(zodShape({ name: `${spec.name}.${key}`, description: "", parameters: { type: "object", properties: nested.properties ?? {}, ...(nested.required ? { required: nested.required } : {}) } })).passthrough();
    }
    else t = z.string();
    if (prop.description) t = t.describe(prop.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}
