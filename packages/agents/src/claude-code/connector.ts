import { logger } from "@jarhead/core";
import type { AgentInfo, ConnectorHealth } from "@jarhead/protocol";
import { ClaudeStore } from "../sessions/claude-store.ts";
import { ClaudeTranscriptParser } from "../sessions/claude-transcript.ts";
import { TranscriptSource } from "../sessions/transcript.ts";
import { agentId, splitAgentId, type AgentConnector, type ReadOptions, type SendResult, type StartOptions, type TranscriptDelta, type TranscriptOptions, type TranscriptPage } from "../types.ts";
import { ClaudeSession, claudeEnv, loadSdk, type PermissionDecision, type SdkLike } from "./session.ts";

const log = logger("agents.claude-code");

/**
 * Claude Code sessions Jarhead started, as agents.
 *
 * "Ask the claude in gt-cloud to run the tests" starts (or reuses) a headless
 * session with that cwd. Sessions live for the Jarhead run; `resume` ids are
 * kept so a session can be picked up again after a restart.
 *
 * The CLI behind the SDK writes each session to ~/.claude/projects/<slug>/<sessionId>.jsonl
 * like any other; `transcript()` and `watch()` read that file, so stepping into one of
 * these looks the same as stepping into a session Kevin opened himself.
 */

export interface ClaudeCodeConnectorOptions {
  readonly sdk?: SdkLike;
  readonly model?: string;
  readonly effort?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly permissionMode?: string;
  /** Called when a session asks for a permission; default allows read-only tools and asks for the rest. */
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>, session: ClaudeSession) => Promise<PermissionDecision>;
  readonly dropApiKey?: boolean;
  readonly onChange?: (agent: AgentInfo) => void;
  /** Where the CLI keeps its transcripts. Default ~/.claude/projects. */
  readonly claudeRoot?: string;
  /** watch(): stat interval when fs.watch cannot be used (default 1 s) and the burst window (default 50 ms). */
  readonly tailPollMs?: number;
  readonly tailCoalesceMs?: number;
}

export class ClaudeCodeConnector implements AgentConnector {
  readonly kind = "claude-code" as const;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly listeners = new Set<(agent: AgentInfo) => void>();
  private sdkPromise: Promise<SdkLike> | undefined;
  private seq = 0;
  private readonly store: ClaudeStore;
  /** Conversation sources by local id, once the session has a file. */
  private readonly sources = new Map<string, TranscriptSource>();

  constructor(private readonly opts: ClaudeCodeConnectorOptions = {}) {
    this.store = new ClaudeStore(opts.claudeRoot ? { root: opts.claudeRoot } : {});
  }

  private sdk(): Promise<SdkLike> {
    if (this.opts.sdk) return Promise.resolve(this.opts.sdk);
    this.sdkPromise ??= loadSdk();
    return this.sdkPromise;
  }

  async health(): Promise<ConnectorHealth> {
    try {
      await this.sdk();
      const n = this.sessions.size;
      return { kind: this.kind, ok: true, detail: n === 0 ? "ready; no sessions yet" : `${n} session(s)` };
    } catch (e) {
      return { kind: this.kind, ok: false, detail: `agent sdk unavailable: ${(e as Error).message}` };
    }
  }

  private info(localId: string, s: ClaudeSession): AgentInfo {
    return {
      id: agentId(this.kind, localId),
      kind: this.kind,
      tool: "claude",
      name: s.name,
      status: s.status,
      ...(s.statusDetail ? { detail: s.statusDetail } : {}),
      cwd: s.cwd,
      updatedAt: s.lastActivityAt,
    };
  }

  async list(): Promise<AgentInfo[]> {
    return [...this.sessions.entries()].map(([id, s]) => this.info(id, s));
  }

  private resolve(id: string): { localId: string; session: ClaudeSession } {
    const parts = splitAgentId(id);
    const localId = parts?.kind === this.kind ? parts.localId : id;
    const session = this.sessions.get(localId);
    if (!session) throw new Error(`no claude-code session ${id}`);
    return { localId, session };
  }

  async send(id: string, text: string): Promise<SendResult> {
    const { session } = this.resolve(id);
    if (session.status === "offline") return { accepted: false, detail: "session has ended" };
    if (session.pendingPermissionTool) {
      // A yes/no while blocked answers the permission rather than starting a turn.
      if (/^\s*(yes|y|allow|go ahead|ok|approve)/i.test(text)) {
        session.resolvePermission(true);
        return { accepted: true, detail: `allowed ${session.pendingPermissionTool}` };
      }
      if (/^\s*(no|n|deny|stop|don'?t)/i.test(text)) {
        session.resolvePermission(false);
        return { accepted: true, detail: "denied" };
      }
    }
    session.send(text);
    return { accepted: true };
  }

  async read(id: string, _opts: ReadOptions = {}): Promise<string> {
    const { session } = this.resolve(id);
    return session.lastAssistantText || (session.status === "working" ? "(still working)" : "(no reply yet)");
  }

  async start(opts: StartOptions): Promise<AgentInfo> {
    const sdk = await this.sdk();
    const cwd = opts.cwd ?? process.cwd();
    const localId = `s${++this.seq}`;
    const handler = this.opts.canUseTool ?? defaultCanUseTool;
    const session: ClaudeSession = new ClaudeSession({
      sdk,
      cwd,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.kind ?? this.opts.model ? { model: opts.kind ?? this.opts.model } : {}),
      ...(this.opts.effort ? { effort: this.opts.effort } : {}),
      ...(this.opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable } : {}),
      permissionMode: this.opts.permissionMode ?? "acceptEdits",
      env: claudeEnv(process.env, { dropApiKey: this.opts.dropApiKey ?? false }),
      includePartialMessages: false,
      canUseTool: (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => handler(toolName, input, session),
    });
    this.sessions.set(localId, session);
    session.on("status", () => this.notify(localId, session));
    session.on("closed", () => this.notify(localId, session));
    session.start();
    if (opts.prompt) session.send(opts.prompt);
    return this.info(localId, session);
  }

  async waitSettled(id: string, timeoutMs: number): Promise<AgentInfo> {
    const { localId, session } = this.resolve(id);
    if (session.status !== "working") return this.info(localId, session);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        session.off("status", onStatus);
        resolve();
      }
      function onStatus(status: string): void {
        if (status !== "working") done();
      }
      session.on("status", onStatus);
    });
    return this.info(localId, session);
  }

  async interrupt(id: string): Promise<void> {
    const { session } = this.resolve(id);
    await session.interrupt();
  }

  subscribe(onChange: (agent: AgentInfo) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  private notify(localId: string, session: ClaudeSession): void {
    const info = this.info(localId, session);
    for (const l of this.listeners) l(info);
    this.opts.onChange?.(info);
  }

  /** Answer a blocked session's permission prompt by voice. */
  resolvePermission(id: string, allow: boolean): boolean {
    return this.resolve(id).session.resolvePermission(allow);
  }

  // ---------------------------------------------------------- conversations ---

  /**
   * The session's transcript file, once the CLI has reported its id and written it;
   * undefined before that. The file is looked for where the CLI puts a session started
   * in this cwd (one stat); `walk` allows the full walk of ~/.claude/projects as the
   * fallback, which watch() rations while it waits for the file to appear.
   */
  private async sourceFor(id: string, walk = true): Promise<TranscriptSource | undefined> {
    const { localId, session } = this.resolve(id);
    const sessionId = session.sessionId;
    if (!sessionId) return undefined;
    const existing = this.sources.get(localId);
    if (existing) return existing;
    const found = (await this.store.findAt(session.cwd, sessionId)) ?? (walk ? await this.store.find(sessionId) : undefined);
    if (!found) return undefined;
    const source = new TranscriptSource({
      path: found.path,
      makeParser: () => new ClaudeTranscriptParser(),
      storeCount: () => found.messageCount,
      ...(this.opts.tailPollMs !== undefined ? { pollMs: this.opts.tailPollMs } : {}),
      ...(this.opts.tailCoalesceMs !== undefined ? { coalesceMs: this.opts.tailCoalesceMs } : {}),
    });
    this.sources.set(localId, source);
    return source;
  }

  /** A page of the session's conversation from its file; empty and complete while the file does not exist yet. */
  async transcript(id: string, opts: TranscriptOptions = {}): Promise<TranscriptPage> {
    const source = await this.sourceFor(id);
    if (!source) return { messages: [], total: 0, complete: true };
    return source.page(opts);
  }

  /** Waiting for a session's file: how often to look (the direct path every time, the walk on the first look and every fifth after). */
  private static readonly WALK_EVERY = 5;
  private static readonly WAIT_BACKOFF_AFTER = 5;

  /**
   * New turns as the file grows. A session that has no file yet is checked again every
   * second (every 5 s after the first few looks) until it does, then followed from its
   * first line — nothing of it was ever shown, whether the file appeared before this call
   * or during the wait. `onEnd` hears when there is no such session, or when its file
   * is gone for 10 s, replaced, or truncated (the tail closed itself).
   */
  watch(id: string, onDelta: (delta: TranscriptDelta) => void, onEnd?: (reason: string) => void): () => void {
    let stop: (() => void) | undefined;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let looks = 0;
    const end = (reason: string): void => {
      if (closed) return;
      closed = true;
      log.info(`watch ${id}: ended (${reason})`);
      onEnd?.(reason);
    };
    const attempt = (): void => {
      looks += 1;
      this.sourceFor(id, looks % ClaudeCodeConnector.WALK_EVERY === 1)
        .then((source) => {
          if (closed) return;
          if (source) {
            // A source that has served a page continues from it; one that has not (the
            // Console saw the "no file yet" page) is replayed from its first line.
            stop = source.follow(onDelta, { fromStart: !source.served, onEnd: end });
            return;
          }
          const base = this.opts.tailPollMs ?? 1_000;
          timer = setTimeout(attempt, looks < ClaudeCodeConnector.WAIT_BACKOFF_AFTER ? base : base * 5);
          timer.unref?.();
        })
        .catch((e: unknown) => end((e as Error).message));
    };
    attempt();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      stop?.();
    };
  }

  /**
   * The session's process is gone: whatever its open conversation still shows as a
   * running tool call was cut off. The changed messages, for the pane that is open;
   * undefined when no conversation was read for it or nothing was running.
   */
  async settle(id: string): Promise<TranscriptDelta | undefined> {
    const { localId } = this.resolve(id);
    const source = this.sources.get(localId);
    if (!source) return undefined;
    const messages = source.interruptOpenCalls();
    return messages.length ? { messages, total: source.total } : undefined;
  }

  async closeAll(): Promise<void> {
    for (const source of this.sources.values()) source.close();
    this.sources.clear();
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
  }
}

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "ToolSearch", "Skill", "LS"]);
const SAFE_BASH = /^\s*(ls|cat|head|tail|wc|pwd|echo|git (status|log|diff|branch|show)|rg|grep|find|pnpm (test|run (test|typecheck|lint|check))|npm (test|run (test|typecheck|lint))|node --test|cargo (test|check)|go test)\b/;

/**
 * Coding agents started by voice get a tight default: read anything, run tests and
 * git queries, and stop for everything else so Kevin can say yes or no.
 */
export async function defaultCanUseTool(toolName: string, input: Record<string, unknown>, _session: ClaudeSession): Promise<PermissionDecision> {
  if (toolName.startsWith("mcp__jarhead__")) return { behavior: "allow" };
  if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow" };
  if (toolName === "Bash" && typeof input["command"] === "string" && SAFE_BASH.test(input["command"])) return { behavior: "allow" };
  // Edits within the working tree are what a coding agent is for.
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit") return { behavior: "allow" };
  return { behavior: "deny", message: `Jarhead needs Kevin's spoken yes before ${toolName}${typeof input["command"] === "string" ? `: ${String(input["command"]).slice(0, 80)}` : ""}` };
}
