import type { AgentInfo, AgentKind, ConnectorHealth } from "@jarhead/protocol";

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

  /** Deliver text to an agent as if Kevin typed it and pressed Enter. */
  send(agentId: string, text: string): Promise<SendResult>;

  /** Recent output: the last assistant message, or the last N terminal lines. */
  read(agentId: string, opts?: ReadOptions): Promise<string>;

  /** Start a new agent/thread. Not every connector can. */
  start?(opts: StartOptions): Promise<AgentInfo>;

  /** Resolve when the agent settles (idle/blocked/done) or the timeout passes. */
  waitSettled?(agentId: string, timeoutMs: number): Promise<AgentInfo>;

  /** Interrupt whatever the agent is doing. */
  interrupt?(agentId: string): Promise<void>;

  /** Push-based status changes when the backend offers them. Returns unsubscribe. */
  subscribe?(onChange: (agent: AgentInfo) => void): () => void;
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
