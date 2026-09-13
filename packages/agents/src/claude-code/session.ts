import { EventEmitter } from "node:events";
import { logger } from "@jarhead/core";
import type { AgentStatus } from "@jarhead/protocol";
import { AsyncQueue } from "./queue.ts";

/**
 * One headless Claude Code session driven through the Agent SDK.
 *
 * The SDK is loaded lazily and injected in tests, so this file compiles and its
 * state machine is testable without spawning Claude. Everything Jarhead needs
 * from a session is here: push a message, watch the turn, read the answer,
 * interrupt, and know when the session is blocked on a permission.
 */

const log = logger("agents.claude");

/**
 * A turn that is `working` with no SDK message for this long has stalled — the CLI is
 * stuck in API retries or hung — and reads `unknown` rather than `working` for ever.
 * The SDK has no per-turn timeout of its own; a resumed session whose stream died kept
 * its `working` face indefinitely before this.
 */
export const TURN_STALL_MS = 300_000;

/** The slice of the SDK this class uses; matches @anthropic-ai/claude-agent-sdk 0.3.x. */
export interface SdkLike {
  query(params: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery;
}

export interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
}

export interface SdkUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string | readonly unknown[] };
  readonly parent_tool_use_id: null;
  readonly session_id: string;
}

export type SdkMessage = {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly message?: { readonly content?: unknown; readonly role?: string };
  readonly result?: string;
  readonly is_error?: boolean;
  readonly api_error_status?: number | null;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly event?: { readonly type?: string; readonly delta?: { readonly type?: string; readonly text?: string } };
  readonly parent_tool_use_id?: string | null;
  readonly tool_name?: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly [key: string]: unknown;
};

export type PermissionDecision = { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string; interrupt?: boolean };

export interface ClaudeSessionOptions {
  readonly sdk: SdkLike;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly name?: string;
  readonly systemPromptAppend?: string;
  readonly mcpServers?: Record<string, unknown>;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly permissionMode?: string;
  readonly settingSources?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly pathToClaudeCodeExecutable?: string;
  readonly includePartialMessages?: boolean;
  readonly maxTurns?: number;
  /** Decide a permission request. Returning a Promise that stays pending marks the session "blocked". */
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>;
  readonly resume?: string;
  /** False keeps the session out of ~/.claude/projects (the brain and probes are not Kevin's transcripts). */
  readonly persistSession?: boolean;
  /** Working with no SDK message for this long reads `unknown`. Default `TURN_STALL_MS`. */
  readonly turnStallMs?: number;
}

export interface ToolUseEvent {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface SessionEvents {
  status: [status: AgentStatus, detail: string | undefined];
  init: [sessionId: string, model: string | undefined];
  text: [delta: string];
  assistant: [text: string];
  tool: [event: ToolUseEvent];
  toolResult: [toolUseId: string, content: unknown, isError: boolean];
  result: [message: SdkMessage];
  error: [error: Error];
  closed: [];
}

export class ClaudeSession extends EventEmitter<SessionEvents> {
  readonly queue = new AsyncQueue<SdkUserMessage>();
  private query: SdkQuery | undefined;
  private consuming: Promise<void> | undefined;
  /** Aborting kills the CLI child; the only reliable way to end a stuck session. */
  private readonly abort = new AbortController();
  status: AgentStatus = "unknown";
  statusDetail: string | undefined;
  sessionId: string | undefined;
  model: string | undefined;
  /** Text of the last completed assistant message in the current or last turn. */
  lastAssistantText = "";
  private currentText = "";
  private pendingPermission: { toolName: string; resolve: (d: PermissionDecision) => void } | undefined;
  readonly startedAt = Date.now();
  lastActivityAt = Date.now();
  costUsd = 0;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: ClaudeSessionOptions) {
    super();
  }

  /** Arm the stall clock while working; every SDK message re-arms it, any other status clears it. */
  private watchStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    if (this.status !== "working") return;
    const ms = this.opts.turnStallMs ?? TURN_STALL_MS;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (this.status === "working") this.setStatus("unknown", `no output for ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${ms} ms`}`);
    }, ms);
    this.stallTimer.unref?.();
  }

  get name(): string {
    return this.opts.name ?? this.opts.cwd.split("/").pop() ?? "claude";
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    this.lastActivityAt = Date.now();
    if (this.status === status && this.statusDetail === detail) {
      this.watchStall();
      return;
    }
    this.status = status;
    this.statusDetail = detail;
    this.watchStall();
    this.emit("status", status, detail);
  }

  start(): void {
    if (this.query) return;
    const o = this.opts;
    const options: Record<string, unknown> = {
      cwd: o.cwd,
      abortController: this.abort,
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.mcpServers ? { mcpServers: o.mcpServers } : {}),
      ...(o.allowedTools ? { allowedTools: [...o.allowedTools] } : {}),
      ...(o.disallowedTools ? { disallowedTools: [...o.disallowedTools] } : {}),
      ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}),
      ...(o.settingSources ? { settingSources: [...o.settingSources] } : {}),
      ...(o.env ? { env: o.env } : {}),
      ...(o.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: o.pathToClaudeCodeExecutable } : {}),
      ...(o.includePartialMessages !== undefined ? { includePartialMessages: o.includePartialMessages } : {}),
      ...(o.maxTurns !== undefined ? { maxTurns: o.maxTurns } : {}),
      ...(o.resume ? { resume: o.resume } : {}),
      ...(o.persistSession !== undefined ? { persistSession: o.persistSession } : {}),
      ...(o.systemPromptAppend ? { systemPrompt: { type: "preset", preset: "claude_code", append: o.systemPromptAppend } } : {}),
      ...(o.canUseTool
        ? {
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              this.setStatus("blocked", `permission: ${toolName}`);
              try {
                const decision = await new Promise<PermissionDecision>((resolve) => {
                  this.pendingPermission = { toolName, resolve };
                  o.canUseTool?.(toolName, input).then(resolve, () => resolve({ behavior: "deny", message: "permission handler failed" }));
                });
                return decision;
              } finally {
                this.pendingPermission = undefined;
                if (this.status === "blocked") this.setStatus("working");
              }
            },
          }
        : {}),
    };
    this.setStatus("idle", "starting");
    this.query = o.sdk.query({ prompt: this.queue, options });
    this.consuming = this.consume(this.query).catch((e: unknown) => {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      this.setStatus("offline", (e as Error).message);
    });
  }

  private async consume(q: SdkQuery): Promise<void> {
    for await (const msg of q) this.handle(msg);
    this.setStatus("offline", "session ended");
    this.emit("closed");
  }

  private handle(msg: SdkMessage): void {
    this.lastActivityAt = Date.now();
    this.watchStall();
    if (msg.type === "system" && msg.subtype === "init") {
      this.sessionId = msg.session_id;
      this.model = msg.model;
      this.emit("init", msg.session_id ?? "", msg.model);
      // init can arrive after the first message was already queued; a queued turn
      // is still a working session, not an idle one.
      if (this.status !== "working") this.setStatus("idle", "ready");
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string" && msg.parent_tool_use_id == null) {
        this.emit("text", ev.delta.text);
      }
      return;
    }
    if (msg.type === "assistant" && msg.parent_tool_use_id == null) {
      const content = Array.isArray(msg.message?.content) ? (msg.message?.content as { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]) : [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          this.currentText += (this.currentText ? "\n" : "") + block.text;
          this.emit("assistant", block.text);
        } else if (block.type === "tool_use") {
          this.setStatus("working", `using ${block.name ?? "tool"}`);
          this.emit("tool", { id: block.id ?? "", name: block.name ?? "", input: block.input });
        }
      }
      return;
    }
    if (msg.type === "user" && msg.parent_tool_use_id == null) {
      const content = Array.isArray(msg.message?.content) ? (msg.message?.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) : [];
      for (const block of content) {
        if (block.type === "tool_result") this.emit("toolResult", block.tool_use_id ?? "", block.content, block.is_error === true);
      }
      return;
    }
    if (msg.type === "result") {
      if (this.currentText) this.lastAssistantText = this.currentText;
      this.currentText = "";
      if (typeof msg.total_cost_usd === "number") this.costUsd = msg.total_cost_usd;
      if (msg.is_error) {
        const detail = msg.result ?? "turn failed";
        this.setStatus("unknown", detail);
        this.emit("error", new Error(detail));
      } else {
        this.setStatus("idle");
      }
      this.emit("result", msg);
      return;
    }
  }

  /** Push a user turn. Images are Anthropic-shaped image blocks. */
  send(text: string, images: readonly { pngBase64: string }[] = []): void {
    if (this.queue.isClosed) throw new Error("session is closed");
    const content: unknown[] = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: img.pngBase64 } });
    content.push({ type: "text", text });
    this.currentText = "";
    this.setStatus("working", "thinking");
    this.queue.push({ type: "user", message: { role: "user", content: images.length ? content : text }, parent_tool_use_id: null, session_id: this.sessionId ?? "" });
  }

  /** Answer a pending permission request. */
  resolvePermission(allow: boolean, message = "denied by Kevin"): boolean {
    const p = this.pendingPermission;
    if (!p) return false;
    p.resolve(allow ? { behavior: "allow" } : { behavior: "deny", message });
    return true;
  }

  get pendingPermissionTool(): string | undefined {
    return this.pendingPermission?.toolName;
  }

  /** Bounded: a CLI stuck in API retries never acknowledges an interrupt. */
  async interrupt(timeoutMs = 3000): Promise<void> {
    const q = this.query;
    if (!q) return;
    try {
      await Promise.race([q.interrupt(), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    } catch (e) {
      log.debug(`interrupt failed: ${(e as Error).message}`);
    }
  }

  async close(): Promise<void> {
    this.queue.close();
    await this.interrupt(1500);
    const ended = this.consuming ? Promise.race([this.consuming.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]) : Promise.resolve(true);
    if (!(await ended)) {
      log.warn("claude session did not end on its own; aborting the process");
      this.abort.abort();
      if (this.consuming) await Promise.race([this.consuming, new Promise((r) => setTimeout(r, 1500))]);
    }
    this.setStatus("offline", "closed");
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }
}

/** Load the real SDK. Kept separate so tests never touch it. */
export async function loadSdk(): Promise<SdkLike> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkLike;
  return mod;
}

/**
 * The environment a headless Claude should see.
 *
 * Two things are removed: the nested-session guards this process may carry when
 * Jarhead itself was launched from inside Claude Code, and — when asked — the
 * ANTHROPIC_API_KEY, so the CLI falls back to Kevin's OAuth login.
 */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env, opts: { readonly dropApiKey?: boolean } = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env["CLAUDECODE"];
  delete env["CLAUDE_CODE_ENTRYPOINT"];
  delete env["CLAUDE_CODE_CHILD_SESSION"];
  if (opts.dropApiKey) delete env["ANTHROPIC_API_KEY"];
  return env;
}
