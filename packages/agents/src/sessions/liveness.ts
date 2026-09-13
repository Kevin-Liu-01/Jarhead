import type { AgentHint, AgentStatus } from "@jarhead/protocol";

/**
 * Status that cannot stick.
 *
 * Before this file, `working` was "a live owner and a file mtime within 90 s", and a
 * session with no owner was `done` for six hours and `unknown` after. Codex Desktop
 * holds a dozen rollouts open and writes token counts into them, so held threads read
 * `working` for nothing; a killed process left its thread `working` until the mtime
 * aged out; 55 of Kevin's 65 sessions read `unknown` because they were old, not because
 * anything was unknown about them.
 *
 * Here `working` is a lease: a live owner AND a turn-bearing write inside
 * `WORKING_LEASE_MS` AND no closing marker after it. Nothing renews the lease but
 * conversation — Claude's user/assistant/tool_result lines, Codex's task_started,
 * messages, tool calls and outputs; token counts and item_completed echoes do not
 * (see `lastTurn` in the parsers and stores). Owners gone means `ended`, however old
 * the file: the process that could have written it is not there. `unknown` is kept
 * for the one case where the evidence itself is missing — ps or lsof failed — because
 * acting on "nobody owns it" then would be a guess.
 *
 * Pure, so the rule is one table test; the connector only builds `Evidence`.
 */

/** The last turn-bearing line of a session file: `open` while a turn is underway, `closed` once the tool wrote its end-of-turn marker. */
export interface TurnMark {
  readonly kind: "open" | "closed";
  /** Wall clock of that line (the file's own timestamp; the mtime when it had none). */
  readonly at: number;
}

export interface Evidence {
  /** Codex: the rollout sits in archived_sessions. */
  readonly archived: boolean;
  /** Live processes that own the session (this connector's own drivers excluded when a run is on). */
  readonly owners: number;
  /** Why the process snapshot cannot be trusted; undefined when ps and lsof both ran. */
  readonly degraded: string | undefined;
  readonly mtimeMs: number;
  /** From the tail slice the store parsed; undefined for files that carry no markers. */
  readonly lastTurn: TurnMark | undefined;
  /** A run this process drives (Codex `exec resume`, the Claude Agent SDK), when one is on. `since` is its last event. */
  readonly run: { readonly status: AgentStatus; readonly detail: string | undefined; readonly since: number } | undefined;
  /** A permission question is open for Kevin. */
  readonly ask: boolean;
}

export interface Leases {
  /** `working` lasts this long past the last turn-bearing write. */
  readonly workingLeaseMs: number;
  /** A run that said "finishing" (Codex turn.completed, child still flushing) is idle after this. */
  readonly finishingMaxMs: number;
  /** A run that is `working` with no event for this long is `unknown`: the stream stalled, nothing more will come on its own. */
  readonly runStallMs: number;
}

export const WORKING_LEASE_MS = 30_000;
export const FINISHING_MAX_MS = 30_000;
export const RUN_STALL_MS = 300_000;
/** subscribe() cadence: while something is active, when nothing is, and when one list() never settles. */
export const POLL_ACTIVE_MS = 5_000;
export const POLL_QUIET_MS = 20_000;
export const POLL_STUCK_MS = 60_000;
/** A session written within this long keeps the poll on its active cadence. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;

export const DEFAULT_LEASES: Leases = { workingLeaseMs: WORKING_LEASE_MS, finishingMaxMs: FINISHING_MAX_MS, runStallMs: RUN_STALL_MS };

/** First match wins; see the file comment for why each rule sits where it does. */
export function deriveStatus(e: Evidence, now: number, l: Leases = DEFAULT_LEASES): { status: AgentStatus; hint: AgentHint } {
  if (e.archived) return { status: "done", hint: "archived" };
  if (e.ask) return { status: "blocked", hint: "blocked" };
  if (e.run && e.run.status !== "offline") {
    if (e.run.status === "working") {
      const quiet = now - e.run.since;
      if (e.run.detail === "finishing" && quiet > l.finishingMaxMs) return { status: "idle", hint: "resumed" };
      if (quiet > l.runStallMs) return { status: "unknown", hint: "resumed" };
    }
    return { status: e.run.status, hint: "resumed" };
  }
  if (e.owners === 0) return e.degraded ? { status: "unknown", hint: "unseen" } : { status: "ended", hint: "ended" };
  // Noise lines move the mtime but never `lastTurn`; with a marker in hand the mtime says nothing more.
  const lastWrite = e.lastTurn?.at ?? e.mtimeMs;
  const working = now - lastWrite <= l.workingLeaseMs && e.lastTurn?.kind !== "closed";
  return working ? { status: "working", hint: "running" } : { status: "idle", hint: "quiet" };
}

/** Statuses `waitSettled` and the brain's agent_wait treat as settled: nothing more will come without a nudge. */
export const SETTLED_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["idle", "blocked", "done", "ended", "offline"]);
