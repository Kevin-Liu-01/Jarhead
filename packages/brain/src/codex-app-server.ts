import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { LineSplitter, logger } from "@jarhead/core";
import type { Effort } from "@jarhead/protocol";
import { codexDisableUserServersArgs, codexMcpConfigArgs, toml, type CodexMcpConfig } from "./codex-config.ts";

/**
 * A warm Codex: one `codex app-server` process, one thread, many turns.
 *
 * The protocol (0.153.4, discovered with `codex app-server generate-ts` and by
 * running one) is JSON-RPC 2.0, newline-delimited, over stdio:
 *
 *   → initialize {clientInfo, capabilities}      ← {userAgent, codexHome, …}      (~70 ms)
 *   → initialized (notification)
 *   → thread/start {cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, developerInstructions, model?}
 *                                                  ← {thread: {id, model, reasoningEffort, …}}   (~2.5 s)
 *   → turn/start {threadId, input: [{type: "text", text, text_elements: []}, {type: "localImage", path}], effort?}
 *                                                  ← {turn: {id, status: "inProgress"}}
 *   ← notifications: thread/started, mcpServer/startupStatus/updated (per thread, first turn only:
 *      the bridge is "ready" ~1.3 s in), turn/started, item/started, item/agentMessage/delta,
 *      item/completed, thread/tokenUsage/updated {total, last, modelContextWindow}, turn/completed
 *      {turn: {id, status: completed | interrupted | failed, error}}, warning, error {willRetry}
 *   → turn/interrupt {threadId, turnId}            ← {}  then turn/completed with status "interrupted" (~35 ms)
 *   ← server requests (they carry an id and must be answered): item/commandExecution/requestApproval,
 *      item/fileChange/requestApproval, item/permissions/requestApproval, item/tool/requestUserInput,
 *      mcpServer/elicitation/request, item/tool/call — every one is declined here; the only way
 *      Codex acts is the `jarhead` MCP server, which the runner gates.
 *
 * Items: {type: "agentMessage", text, phase}, {type: "reasoning", summary[], content[]},
 * {type: "mcpToolCall", server, tool, status, arguments, result, error, durationMs},
 * {type: "commandExecution", command, status, aggregatedOutput, exitCode}, {type: "userMessage"}.
 *
 * `-c mcp_servers={…}` does NOT replace the user's table (their servers still
 * start alongside); `-c mcp_servers.<name>.enabled=false` per server does switch
 * them off. The plugin runtime (`codex_apps`: Kevin's ChatGPT connectors — Drive,
 * Sites, agents; 134 tools, deletes and shares among them) is a *feature*, not a
 * server: `--disable apps` (= `-c features.apps=false`) switches it off, and the
 * argv below always does. His `notify` hook is silenced too (`-c notify=[]`), so
 * Jarhead's turns never fire it. Closing stdin ends the process cleanly.
 *
 * A stop while `turn/start` is still unanswered is remembered (`interruptRequested`)
 * and `turn/interrupt` goes out the moment the turn id is known; the turn resolves
 * on the server's `turn/completed{interrupted}`, or locally after a grace period
 * when the server never says so. Resolving locally at once would leave a zombie
 * turn acting through the bridge with no delegation attached.
 */

const log = logger("brain.codex.app-server");

export interface AppServerOptions extends CodexMcpConfig {
  readonly bin: string;
  /** Codex's working root: an empty directory of Jarhead's, not Kevin's home. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly codexHome: string;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  /** The standing orders, set once per thread. */
  readonly developerInstructions: string;
  /** initialize + thread/start must finish within this (default 25 s). */
  readonly startTimeoutMs?: number | undefined;
  /** Kill grace after stdin is closed (default 3 s). */
  readonly killGraceMs?: number | undefined;
  /** After an interrupt, how long to wait for the server's turn/completed before the turn is given up locally (default 5 s). */
  readonly interruptGraceMs?: number | undefined;
  /** Start a fresh thread once the thread's tokens pass this share of the model's context window (default 0.7). */
  readonly contextRolloverRatio?: number | undefined;
  /** Without a known context window, roll over past this many total tokens (default 240k). */
  readonly contextRolloverTokens?: number | undefined;
  /** Test seam. */
  readonly spawnImpl?: typeof spawn | undefined;
  /** Test seam: skip disabling the user's servers (no config.toml to read). */
  readonly disableUserServers?: boolean | undefined;
}

/** The parts of a ThreadItem this brain reads; unknown item types pass through with their `type`. */
export interface AppServerItem {
  readonly type?: string;
  readonly id?: string;
  readonly text?: string;
  readonly phase?: string | null;
  readonly summary?: readonly string[];
  readonly content?: readonly string[];
  readonly server?: string;
  readonly tool?: string;
  readonly status?: string;
  readonly arguments?: unknown;
  readonly error?: { message?: string } | string | null;
  readonly result?: unknown;
  readonly command?: string;
  readonly aggregatedOutput?: string | null;
  readonly exitCode?: number | null;
  readonly durationMs?: number | null;
}

export interface TurnHandlers {
  onItemStarted?(item: AppServerItem): void;
  onItemCompleted?(item: AppServerItem): void;
  onAgentDelta?(delta: string): void;
  onWarning?(message: string): void;
  onError?(message: string, willRetry: boolean): void;
}

export interface TurnResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly error?: string;
  readonly turnId: string;
}

export interface TokenUsage {
  readonly totalTokens: number;
  readonly lastTurnTokens: number;
  readonly contextWindow: number | undefined;
}

export type UserInput = { readonly type: "text"; readonly text: string; readonly text_elements: readonly never[] } | { readonly type: "localImage"; readonly path: string; readonly detail?: "auto" | "low" | "high" | "original" };

interface Pending {
  readonly method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface ActiveTurn {
  /** Empty until turn/start has answered. */
  turnId: string;
  readonly handlers: TurnHandlers;
  resolve: (r: TurnResult) => void;
  /** A stop arrived: turn/interrupt is sent as soon as the turn id is known (and only once). */
  interruptRequested: boolean;
  graceTimer: NodeJS.Timeout | undefined;
}

export interface AppServerEvents {
  /** The process ended (reason for the log); a running turn has already failed. */
  exit: [reason: string];
}

/** Jarhead's effort scale → Codex's `model_reasoning_effort` values. */
export function appServerEffort(effort: Effort): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}

/**
 * The argv of the resident process: the bridge mounted, the user's own servers
 * off, the plugin runtime (`codex_apps`, his ChatGPT connectors) off, his
 * `notify` hook off, the effort set. Without `--disable apps` the brain could
 * call Drive/Sites/agent tools under approvalPolicy "never" with nothing in
 * Jarhead judging them.
 */
export function appServerArgs(o: AppServerOptions): string[] {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "--disable",
    "apps",
    "-c",
    "notify=[]",
    ...codexMcpConfigArgs(o),
    ...(o.disableUserServers === false ? [] : codexDisableUserServersArgs(o.codexHome)),
    ...(o.effort ? ["-c", `model_reasoning_effort=${toml(appServerEffort(o.effort))}`] : []),
  ];
}

export class CodexAppServer extends EventEmitter<AppServerEvents> {
  private child: ChildProcess | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private threadId: string | undefined;
  private active: ActiveTurn | undefined;
  private usage: TokenUsage | undefined;
  private stopped = false;
  private startedAt = 0;
  private stderrTail = "";

  constructor(private readonly opts: AppServerOptions) {
    super();
  }

  get thread(): string | undefined {
    return this.threadId;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.stopped;
  }

  get tokenUsage(): TokenUsage | undefined {
    return this.usage;
  }

  /** ms since the process was spawned. */
  get uptimeMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /** Spawn, initialize, start the thread. Throws when any of that fails within the start timeout; the caller falls back to exec. */
  async start(): Promise<{ threadId: string; model: string; effort: string | null; initMs: number; threadMs: number }> {
    const spawnFn = this.opts.spawnImpl ?? spawn;
    const t0 = Date.now();
    this.startedAt = t0;
    const child = spawnFn(this.opts.bin, appServerArgs(this.opts), { cwd: this.opts.cwd, env: this.opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const lines = new LineSplitter(64 * 1024 * 1024);
    child.stdout?.on("data", (chunk: Buffer) => {
      let out: string[];
      try {
        out = lines.push(chunk);
      } catch (e) {
        log.warn((e as Error).message);
        return;
      }
      for (const line of out) this.onLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
      log.debug(`stderr: ${chunk.toString("utf8").trim().slice(0, 300)}`);
    });
    child.stdin?.on("error", (e) => log.debug(`stdin: ${e.message}`));
    child.on("error", (e) => this.died(`could not start codex app-server: ${e.message}`));
    child.on("close", (code, signal) => this.died(`codex app-server exited ${signal ? `on ${signal}` : `with code ${code ?? "?"}`}${this.stderrTail.trim() ? `: ${this.stderrTail.trim().split("\n").slice(-2).join(" ").slice(0, 300)}` : ""}`));

    const timeoutMs = this.opts.startTimeoutMs ?? 25_000;
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`codex app-server did not start within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref?.());
    // Each request gets the boot budget that is left, not request()'s own default:
    // a thread/start slower than 60 s used to fail whatever startTimeoutMs said.
    const remaining = (): number => Math.max(1000, timeoutMs - (Date.now() - t0) + 500);
    const boot = (async () => {
      await this.request("initialize", { clientInfo: { name: "jarhead", title: "Jarhead", version: "2.0.0" }, capabilities: { experimentalApi: false, requestAttestation: false } }, remaining());
      this.notify("initialized", {});
      const initMs = Date.now() - t0;
      const t1 = Date.now();
      const started = await this.startThread(remaining());
      return { ...started, initMs, threadMs: Date.now() - t1 };
    })();
    try {
      return await Promise.race([boot, deadline]);
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  private async startThread(timeoutMs?: number): Promise<{ threadId: string; model: string; effort: string | null }> {
    const r = (await this.request(
      "thread/start",
      {
        cwd: this.opts.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: this.opts.developerInstructions,
        sessionStartSource: "startup",
        ...(this.opts.model ? { model: this.opts.model } : {}),
      },
      timeoutMs,
    )) as { thread?: { id?: string }; model?: string; reasoningEffort?: string | null };
    const threadId = r.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    this.threadId = threadId;
    this.usage = undefined;
    log.info(`thread ${threadId} (${r.model ?? "default model"}${r.reasoningEffort ? `, effort ${r.reasoningEffort}` : ""})`);
    return { threadId, model: r.model ?? "", effort: r.reasoningEffort ?? null };
  }

  /**
   * Whether the thread has grown past the rollover point: the context is Codex's
   * (a compaction would cost a model call anyway), so the next task starts a new
   * thread and the brain carries the last exchanges over as text.
   */
  needsFreshThread(): boolean {
    const u = this.usage;
    if (!u) return false;
    const ratio = this.opts.contextRolloverRatio ?? 0.7;
    if (u.contextWindow && u.contextWindow > 0) return u.totalTokens / u.contextWindow > ratio;
    return u.totalTokens > (this.opts.contextRolloverTokens ?? 240_000);
  }

  /** Start a fresh thread (the old, ephemeral one is simply left behind). */
  async freshThread(): Promise<string> {
    if (this.active) throw new Error("a turn is running");
    const { threadId } = await this.startThread();
    return threadId;
  }

  /** One turn on the thread. Resolves on turn/completed; rejects only when the request itself fails. */
  turn(input: readonly UserInput[], handlers: TurnHandlers): Promise<TurnResult> {
    if (!this.running || !this.threadId) return Promise.reject(new Error("codex app-server is not running"));
    if (this.active) return Promise.reject(new Error("a turn is already running"));
    const threadId = this.threadId;
    return new Promise<TurnResult>((resolve, reject) => {
      const active: ActiveTurn = { turnId: "", handlers, resolve, interruptRequested: false, graceTimer: undefined };
      this.active = active;
      this.request("turn/start", { threadId, input, ...(this.opts.effort ? { effort: appServerEffort(this.opts.effort) } : {}) })
        .then((r) => {
          const turnId = (r as { turn?: { id?: string } }).turn?.id;
          if (!turnId) throw new Error("turn/start returned no turn id");
          active.turnId = turnId;
          // A stop that arrived while turn/start was in flight goes out now — even when
          // the grace period has already settled the turn locally, the server must hear it.
          if (active.interruptRequested) void this.sendInterrupt(active, threadId);
        })
        .catch((e: Error) => {
          if (this.active === active) {
            this.clearGrace(active);
            this.active = undefined;
          }
          reject(e);
        });
    });
  }

  /**
   * Kevin said stop: interrupt the running turn; turn/completed follows with
   * status "interrupted". Before turn/start has answered the request is remembered
   * and sent the moment the turn id is known; the turn stays active meanwhile so a
   * zombie never runs unwatched. If the server never ends the turn, it is given up
   * locally after `interruptGraceMs`.
   */
  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active || !this.threadId || !this.running) return;
    if (active.interruptRequested) return;
    active.interruptRequested = true;
    active.graceTimer = setTimeout(() => {
      if (this.active !== active) return;
      log.warn(`the turn did not end within ${Math.round((this.opts.interruptGraceMs ?? 5000) / 1000)}s of the interrupt; giving it up locally${active.turnId ? "" : " (turn/start never answered)"}`);
      this.active = undefined;
      active.resolve({ status: "interrupted", turnId: active.turnId });
    }, this.opts.interruptGraceMs ?? 5000);
    active.graceTimer.unref?.();
    if (!active.turnId) return;
    await this.sendInterrupt(active, this.threadId);
  }

  private async sendInterrupt(active: ActiveTurn, threadId: string): Promise<void> {
    if (!this.running) return;
    try {
      await this.request("turn/interrupt", { threadId, turnId: active.turnId }, 3000);
    } catch (e) {
      log.warn(`turn/interrupt failed: ${(e as Error).message}`);
      if (this.active === active) {
        this.clearGrace(active);
        this.active = undefined;
        active.resolve({ status: "interrupted", turnId: active.turnId });
      }
    }
  }

  private clearGrace(active: ActiveTurn): void {
    if (active.graceTimer) clearTimeout(active.graceTimer);
    active.graceTimer = undefined;
  }

  /** Close stdin (the app-server exits on it), then SIGKILL if it lingers. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // already gone
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, this.opts.killGraceMs ?? 3000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ------------------------------------------------------------- JSON-RPC

  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || !this.running) return Promise.reject(new Error("codex app-server is not running"));
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private answer(id: unknown, result: unknown, error?: { code: number; message: string }): void {
    this.child?.stdin?.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`);
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      log.debug(`non-JSON from app-server: ${line.slice(0, 200)}`);
      return;
    }
    // A reply to one of ours.
    if (typeof msg.id === "number" && msg.method === undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    // A request from the server: every approval is declined; Jarhead's policy is the runner's.
    if (msg.id !== undefined && msg.method) {
      this.onServerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (msg.method) this.onNotification(msg.method, msg.params ?? {});
  }

  private onServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
    log.info(`declining server request ${method}`);
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.answer(id, { decision: "decline" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        this.answer(id, { decision: "denied" });
        return;
      case "item/tool/requestUserInput":
        this.answer(id, { answers: {} });
        return;
      case "mcpServer/elicitation/request":
        this.answer(id, { action: "decline", content: null, _meta: null });
        return;
      default:
        this.answer(id, undefined, { code: -32000, message: `${method} is not available to Jarhead's brain (${Object.keys(params).length} params)` });
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const active = this.active;
    switch (method) {
      case "item/started":
        active?.handlers.onItemStarted?.((params["item"] ?? {}) as AppServerItem);
        return;
      case "item/completed":
        active?.handlers.onItemCompleted?.((params["item"] ?? {}) as AppServerItem);
        return;
      case "item/agentMessage/delta": {
        const delta = params["delta"];
        if (typeof delta === "string") active?.handlers.onAgentDelta?.(delta);
        return;
      }
      case "thread/tokenUsage/updated": {
        const u = params["tokenUsage"] as { total?: { totalTokens?: number }; last?: { totalTokens?: number }; modelContextWindow?: number | null } | undefined;
        if (u) this.usage = { totalTokens: u.total?.totalTokens ?? 0, lastTurnTokens: u.last?.totalTokens ?? 0, contextWindow: u.modelContextWindow ?? undefined };
        return;
      }
      case "turn/completed": {
        const turn = params["turn"] as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
        if (!active || !turn?.id || turn.id !== active.turnId) return;
        this.clearGrace(active);
        this.active = undefined;
        const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
        active.resolve({ status, turnId: turn.id, ...(turn.error?.message ? { error: turn.error.message } : {}) });
        return;
      }
      case "warning":
        active?.handlers.onWarning?.(String(params["message"] ?? ""));
        return;
      case "error": {
        const err = params["error"] as { message?: string } | undefined;
        active?.handlers.onError?.(err?.message ?? "Codex reported an error", params["willRetry"] === true);
        return;
      }
      case "thread/closed":
        if (params["threadId"] === this.threadId) {
          log.warn("the thread was closed by the server");
          this.threadId = undefined;
        }
        return;
      default:
        return;
    }
  }

  private died(reason: string): void {
    if (this.child === undefined && this.stopped) {
      // A stop() we asked for.
      this.failPending(reason);
      return;
    }
    this.child = undefined;
    log.warn(reason);
    this.failPending(reason);
    this.emit("exit", reason);
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
    const active = this.active;
    if (active) {
      this.clearGrace(active);
      this.active = undefined;
      active.resolve({ status: "failed", error: reason, turnId: active.turnId });
    }
  }
}
