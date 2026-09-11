import type { AgentInfo, ConnectorHealth } from "@jarhead/protocol";
import { agentId, splitAgentId, type AgentConnector, type ReadOptions, type SendResult, type StartOptions } from "../types.ts";
import { ClaudeSession, claudeEnv, loadSdk, type PermissionDecision, type SdkLike } from "./session.ts";

/**
 * Claude Code sessions Jarhead started, as agents.
 *
 * "Ask the claude in gt-cloud to run the tests" starts (or reuses) a headless
 * session with that cwd. Sessions live for the Jarhead run; `resume` ids are
 * kept so a session can be picked up again after a restart.
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
}

export class ClaudeCodeConnector implements AgentConnector {
  readonly kind = "claude-code" as const;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly listeners = new Set<(agent: AgentInfo) => void>();
  private sdkPromise: Promise<SdkLike> | undefined;
  private seq = 0;

  constructor(private readonly opts: ClaudeCodeConnectorOptions = {}) {}

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

  async closeAll(): Promise<void> {
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
