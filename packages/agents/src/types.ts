import type { AgentInfo, AgentKind, AgentMessage, ConnectorHealth } from "@jarhead/protocol";

/**
 * One interface over every place Kevin's agents live.
 *
 * A connector never throws for "the thing is not running": that is a health
 * result and an empty list. It throws only for programmer errors (bad ids, bad
 * arguments). Ids are connector-scoped and stable across calls:
 *
 *   claude-code:<sessionId>   headless sessions Jarhead started
 *   sessions:<tool>:<id>      discovered sessions, e.g. sessions:claude:<uuid>, sessions:codex:<id>
 */
export interface AgentConnector {
  readonly kind: AgentKind;

  /** Is the backing service reachable right now? Cheap; called often. */
  health(): Promise<ConnectorHealth>;

  /** Every agent this connector knows about, offline ones included when known. */
  list(): Promise<AgentInfo[]>;

  /** Deliver text to an agent as if Kevin typed it and pressed Enter. An `ended` session is resumed by it. */
  send(agentId: string, text: string): Promise<SendResult>;

  /** Recent output: the last assistant message, or the last N terminal lines. */
  read(agentId: string, opts?: ReadOptions): Promise<string>;

  /** Start a new agent/thread. Not every connector can. */
  start?(opts: StartOptions): Promise<AgentInfo>;

  /** Resolve when the agent settles (idle/blocked/done/ended — nothing more will come on its own) or the timeout passes. */
  waitSettled?(agentId: string, timeoutMs: number): Promise<AgentInfo>;

  /** Interrupt whatever the agent is doing. */
  interrupt?(agentId: string): Promise<void>;

  /**
   * Push-based status changes when the backend offers them. `onGone` hears the id of
   * an agent that left the listing (aged out, capped out, its file gone), so a registry
   * can drop it rather than show its last status for ever. Returns unsubscribe.
   */
  subscribe?(onChange: (agent: AgentInfo) => void, onGone?: (agentId: string) => void): () => void;

  /**
   * A page of the agent's conversation: the newest `limit` messages, or the ones just
   * before message `before` (or byte `beforeOffset`). Connectors that keep no transcript leave this out.
   */
  transcript?(agentId: string, opts?: TranscriptOptions): Promise<TranscriptPage>;

  /**
   * New turns as they land, until the returned function is called. `onEnd` is called
   * (once, with the reason) when the tail cannot start or stops on its own — the session
   * is gone, its file replaced or truncated — so a surface can stop calling the
   * conversation live. A file that merely moved (Codex archiving a thread) is followed
   * on without a signal.
   */
  watch?(agentId: string, onDelta: (delta: TranscriptDelta) => void, onEnd?: (reason: string) => void): () => void;

  /**
   * The agent's process is gone: every tool call its open conversation still shows
   * running is `interrupted`. The changed messages as a delta, or undefined when there
   * is nothing open or nothing was running.
   */
  settle?(agentId: string): Promise<TranscriptDelta | undefined>;
}

export interface TranscriptOptions {
  /** Messages per page. Default 60. */
  readonly limit?: number;
  /** A message id: the page ends just before it. */
  readonly before?: string;
  /** A byte offset (a page's `cursor.startOffset`): the page ends just before it. Wins over `before`. */
  readonly beforeOffset?: number;
}

/** What a connector knows of a conversation window; the engine adds `agentId` and `live`. */
export interface TranscriptPage {
  readonly messages: readonly AgentMessage[];
  /** Messages in the whole session (exact when the whole file was read, the store's estimate otherwise). */
  readonly total: number;
  /** The first message of the session is included. */
  readonly complete: boolean;
  /** Byte range of the session file these messages came from; the page before starts at `startOffset`. */
  readonly cursor?: { readonly startOffset: number; readonly endOffset: number };
}

/** Messages created or changed since the last delta (a tool call comes again with its output). */
export interface TranscriptDelta {
  readonly messages: readonly AgentMessage[];
  readonly total: number;
}

export interface SendResult {
  readonly accepted: boolean;
  readonly detail?: string;
}

export interface ReadOptions {
  readonly lines?: number;
}

export interface StartOptions {
  /** Display name; connectors may need it unique. */
  readonly name?: string;
  readonly cwd?: string;
  /** Connector-specific: for claude-code, the model. */
  readonly kind?: string;
  /** sessions: which CLI starts the thread — "codex" or "claude". Falls back to `kind` when absent. */
  readonly tool?: string;
  /** Connector-specific project id; unused by the shipped connectors. */
  readonly projectId?: string;
  /** First message to send once started. */
  readonly prompt?: string;
}

/** Split "sessions:claude:<uuid>" into connector kind and the connector's own id. */
export function splitAgentId(agentId: string): { kind: AgentKind; localId: string } | undefined {
  const idx = agentId.indexOf(":");
  if (idx <= 0) return undefined;
  const kind = agentId.slice(0, idx);
  if (kind !== "claude-code" && kind !== "sessions") return undefined;
  return { kind, localId: agentId.slice(idx + 1) };
}

export function agentId(kind: AgentKind, localId: string): string {
  return `${kind}:${localId}`;
}
