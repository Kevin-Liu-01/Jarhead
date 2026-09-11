import type { AgentStatus } from "@jarhead/protocol";
import type { PermissionDecision } from "../../claude-code/session.ts";
import type { ClaudeSession } from "../../claude-code/session.ts";
import type { SessionOwner } from "../claude-registry.ts";
import type { AgentProcess } from "../processes.ts";
import type { DiscoveredSession, SessionTool } from "../store.ts";

/**
 * One shape over every way a discovered session can be driven headlessly.
 *
 * The connector knows sessions (files on disk, processes that own them); a runner knows
 * one tool's CLI or SDK: how to continue a session, how to start a new one in a folder,
 * and what its events mean. Codex and Claude Code each get one; the connector never
 * branches on the tool for anything a runner can answer.
 */

/** What the connector saw of the machine when it decided whether a session may be continued. */
export interface OwnershipSnapshot {
  /** Processes that own this session, this connector's own drivers excluded. */
  readonly live: readonly AgentProcess[];
  readonly processes: readonly AgentProcess[];
  readonly owners: readonly SessionOwner[];
  /** Why the snapshot cannot be trusted (ps or lsof failed); undefined when complete. */
  readonly degraded: string | undefined;
}

export type RunEvent =
  | { readonly type: "status"; readonly status: AgentStatus; readonly detail: string | undefined }
  /** A completed assistant message. */
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "error"; readonly message: string }
  /** The run is over; the handle is offline and will not accept more turns. */
  | { readonly type: "closed" };

/** Events carry their handle so a listener registered before the first event can file it. */
export type RunSink = (event: RunEvent, handle: RunHandle) => void;

/** A session this process is driving: a Claude Code SDK session or a Codex thread run through `codex exec`. */
export interface RunHandle {
  readonly tool: SessionTool;
  /** The tool's own id; for a freshly started thread, known once the tool reports it. */
  readonly sessionId: string | undefined;
  readonly cwd: string;
  readonly status: AgentStatus;
  readonly statusDetail: string | undefined;
  /** Text of the last completed assistant message. */
  readonly lastReply: string;
  readonly lastActivityAt: number;
  /** OS pids this run owns right now, so ownership checks do not take them for another owner. */
  readonly pids: readonly number[];
  /** Resolves once the run is up (Codex: thread id known; Claude: session started). Rejects when it never got there. */
  readonly ready: Promise<void>;
  /** Tool the run is waiting on Kevin for, when the driver itself asks (Claude Code's canUseTool). */
  readonly pendingPermissionTool: string | undefined;
  /** Push another turn. Throws when the handle is closed. */
  send(text: string): void;
  /** Answer the driver's open permission question. False when there is none. */
  resolvePermission(allow: boolean): boolean;
  /** Stop the current turn without ending the run. */
  interrupt(): Promise<void>;
  /** End the run; whatever does not stop on its own is killed. */
  close(): Promise<void>;
}

export type Continuation = { readonly ok: true; readonly mode: ContinueMode } | { readonly ok: false; readonly reason: string };

/**
 * How a session gets continued: `resume` spawns a driver of our own; `queue` hands the
 * text to the process that was seen holding the session. There is no in-between: when
 * ownership cannot be told, canContinue() refuses rather than picking a mode.
 */
export type ContinueMode = "resume" | "queue";

export type ContinueOutcome =
  /** A driver of ours is running the turn. */
  | { readonly kind: "run"; readonly handle: RunHandle; readonly detail: string }
  /** The text reached the process that owns the session; nothing of ours is running. */
  | { readonly kind: "delivered"; readonly detail: string }
  | { readonly kind: "refused"; readonly reason: string };

export interface ContinueOptions {
  /** Claude Code: decide a permission request. Ignored by tools whose sandbox does the gating. */
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>, session: ClaudeSession) => Promise<PermissionDecision>;
}

export interface SessionRunner {
  readonly tool: SessionTool;
  /** Cheap and side-effect free: binary, login, ownership. */
  canContinue(session: DiscoveredSession, snapshot: OwnershipSnapshot): Promise<Continuation>;
  /** Deliver `text` to the session the way `mode` says. */
  continue(session: DiscoveredSession, text: string, mode: ContinueMode, sink: RunSink, opts?: ContinueOptions): Promise<ContinueOutcome>;
  /** A new persisted session in `cwd` with `prompt` as its first turn. */
  start(cwd: string, prompt: string, sink: RunSink, opts?: ContinueOptions): Promise<RunHandle>;
  /** One truthful line for health: version, where the binary came from, login, what is running. */
  describe(ctx: DescribeContext): Promise<string>;
  /** Can this tool start or continue anything right now? False with the reason when not. */
  usable(): Promise<{ ok: boolean; reason?: string }>;
}

export interface DescribeContext {
  readonly processes: readonly AgentProcess[];
  /** Sessions of this tool the connector listed. */
  readonly listed: number;
  /** The tool's session store exists on disk. */
  readonly storePresent: boolean;
}
