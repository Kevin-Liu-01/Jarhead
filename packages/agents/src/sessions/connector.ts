import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { logger } from "@jarhead/core";
import type { AgentHint, AgentInfo, AgentStatus, ConnectorHealth } from "@jarhead/protocol";
import { defaultCanUseTool } from "../claude-code/connector.ts";
import type { ClaudeSession, PermissionDecision, SdkLike } from "../claude-code/session.ts";
import { agentId, splitAgentId, type AgentConnector, type ReadOptions, type SendResult, type StartOptions, type TranscriptDelta, type TranscriptOptions, type TranscriptPage } from "../types.ts";
import { defaultClaudeSessionsDir, readClaudeRegistry, type SessionOwner } from "./claude-registry.ts";
import { ClaudeStore, defaultClaudeProjectsRoot } from "./claude-store.ts";
import { CodexStore, defaultCodexRoot } from "./codex-store.ts";
import { ClaudeTranscriptParser } from "./claude-transcript.ts";
import { CodexTranscriptParser } from "./codex-transcript.ts";
import { ACTIVE_WINDOW_MS, DEFAULT_LEASES, POLL_ACTIVE_MS, POLL_QUIET_MS, POLL_STUCK_MS, deriveStatus, type Evidence, type Leases } from "./liveness.ts";
import { TranscriptSource } from "./transcript.ts";
import { detectOthers } from "./others.ts";
import { listAgentProcesses, type AgentProcess, type ExecFn, type ProcessSnapshot } from "./processes.ts";
import { ClaudeCodeRunner } from "./runners/claude-code.ts";
import { CodexRunner } from "./runners/codex.ts";
import type { ContinueOutcome, OwnershipSnapshot, RunHandle, RunSink, SessionRunner } from "./runners/types.ts";
import { ago, truncate, type DiscoveredSession, type SessionTool } from "./store.ts";

const log = logger("agents.sessions");

/**
 * The agent sessions Kevin already has on this Mac, as agents.
 *
 * Claude Code and Codex each keep a JSONL transcript per session; this connector
 * reads those (never writes) and pairs them with the agent CLIs `ps` shows
 * running, so the Console can say which project each session is in, what it was
 * asked, what it last said, and whether it is alive right now. Continuing a session
 * is the job of a per-tool runner (runners/): Claude Code through the Agent SDK's
 * `resume`, Codex through `codex queue` into the open desktop thread or `codex exec
 * resume` headlessly. New threads start the same way (`start()`), in a folder.
 *
 * Ids: `sessions:claude:<sessionId>`, `sessions:codex:<threadId>`.
 *
 * Stepping into a session is `transcript()` (a page of its conversation, newest first) and
 * `watch()` (new turns as the file grows) over the same files, whoever is writing them: a
 * Claude Desktop pane, Codex Desktop, or a runner of ours — the Agent SDK's resume and
 * `codex exec resume` both append to the very file the listing found.
 *
 * Resuming appends to a transcript another process may still be writing, so send()
 * only spawns when ownership is settled: the Claude Code registry, argv and the rollout
 * files Codex holds open say who owns what, and a snapshot that could not be taken in
 * full refuses rather than guesses, for Codex as for Claude Code (`codex queue` files a
 * message whether or not anyone will run it, so it cannot stand in for the answer).
 *
 * Status is derived, never latched (liveness.ts): `working` is a 30 s lease renewed by
 * turn-bearing writes, a session whose process is gone is `ended` at the next poll, and
 * `detail` carries no clock — the "last active 12m ago" text used to change once a
 * minute per session and push a snapshot to the app for each. The poll itself runs at
 * 5 s while anything is active and 20 s when nothing is, and a list() that never
 * settles is abandoned after 60 s rather than freezing every status.
 */

export interface SessionsConnectorOptions {
  /** Base for the default roots; tests point this at a temp dir. */
  readonly home?: string;
  readonly claudeRoot?: string;
  readonly codexRoot?: string;
  /** ~/.claude/sessions, Claude Code's pid → session registry. */
  readonly registryDir?: string;
  readonly maxAgeDays?: number;
  readonly limit?: number;
  /** Injected Agent SDK; tests pass a fake so nothing spawns Claude. */
  readonly sdk?: SdkLike;
  /** Runs ps/lsof. */
  readonly exec?: ExecFn;
  /** Full override of process discovery (tests); such a snapshot is never degraded. */
  readonly processes?: () => Promise<AgentProcess[]>;
  readonly now?: () => number;
  /** subscribe() poll interval while a session is active (default 5 s), when nothing is (default 20 s; 4× pollMs when only that is given), and how long one list() may hang before it is abandoned (default 60 s). */
  readonly pollMs?: number;
  readonly pollQuietMs?: number;
  readonly pollStuckMs?: number;
  /** waitSettled() mtime poll interval and quiet window. Defaults 1 s / 5 s. */
  readonly settlePollMs?: number;
  readonly settleQuietMs?: number;
  /** The status leases (liveness.ts): working 30 s, finishing 30 s, run stall 5 min. */
  readonly leases?: Partial<Leases>;
  /** How long a ps/lsof snapshot is reused across list()/health() calls. Default 5 s. */
  readonly processCacheMs?: number;
  /** How long a resumed session waits for Kevin's yes/no before the tool is denied. Default 5 min. */
  readonly permissionTimeoutMs?: number;
  readonly permissionMode?: string;
  /** Full override of the permission policy; the default allows read-only tools and asks Kevin for the rest. */
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>, session: ClaudeSession) => Promise<PermissionDecision>;
  /** Keep Jarhead's own API keys away from the CLIs so they use Kevin's logins. Default true. */
  readonly dropApiKey?: boolean;
  readonly onChange?: (agent: AgentInfo) => void;
  /** Environment for CLI discovery (PATH, JARHEAD_*_BIN) and the children. Default process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit codex binary; same as JARHEAD_CODEX_BIN. */
  readonly codexBin?: string;
  /** Where .app bundles live. Default /Applications. */
  readonly applicationsDir?: string;
  /** System bin dirs CLI discovery searches last (default homebrew, /usr/local/bin); tests pass []. */
  readonly cliSystemDirs?: readonly string[];
  /** Codex: wall clock per headless turn (default 15 min), time to report a new thread's id (30 s), `codex queue` cap (15 s), SIGINT→SIGKILL grace (3 s), how long a completed turn's child may keep flushing before the run reads idle (30 s). */
  readonly codexTurnBudgetMs?: number;
  readonly codexStartTimeoutMs?: number;
  readonly codexQueueTimeoutMs?: number;
  readonly codexKillGraceMs?: number;
  readonly codexFinishingMaxMs?: number;
  /** watch(): stat interval when fs.watch cannot be used (default 1 s), the burst window (default 50 ms), and how long a followed file may be missing before the tail ends (default 10 s). */
  readonly tailPollMs?: number;
  readonly tailCoalesceMs?: number;
  readonly tailGoneAfterMs?: number;
}

/** lstart has one-second resolution; allow that much slack when matching a process to a file. */
const START_SLACK_MS = 5_000;

/**
 * Processes that own this session, most exact signal first:
 *
 *  1. Claude Code's registry (~/.claude/sessions/<pid>.json) names the pid for a session
 *     id. `owners` are the entries whose pid is alive; one is an owner even when ps missed
 *     the process or lsof hid its cwd. A registered pid that names a different session is
 *     never an owner of this one, whatever its cwd.
 *  2. The process itself names its sessions: argv (`claude --resume=<id>`, `codex resume
 *     <id>`) or, for Codex, the rollout files and writer locks it holds open — Codex
 *     Desktop's app-server has cwd `/` and drives every open thread from one pid, so its
 *     open files are the only thing that says which. A process that names sessions and
 *     does not name this one is never its owner, whatever its cwd.
 *  3. For processes neither signal covers: same tool, same cwd, and started before the
 *     session's last write (a process cannot have written a file that stopped changing
 *     before it existed). Many sessions share a cwd, so this alone makes every old
 *     transcript in a busy folder look alive; it is the fallback, not the rule.
 */
export function liveProcessesFor(s: DiscoveredSession, procs: readonly AgentProcess[], owners: readonly SessionOwner[] = []): AgentProcess[] {
  if (s.archived) return [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Map<number, AgentProcess>();
  const registered = new Set<number>();
  if (s.tool === "claude") {
    for (const o of owners) {
      registered.add(o.pid);
      if (o.sessionId === s.id) out.set(o.pid, byPid.get(o.pid) ?? processFromOwner(o));
    }
  }
  for (const p of procs) {
    if (p.tool !== s.tool || out.has(p.pid) || registered.has(p.pid)) continue;
    if (p.sessionId !== undefined || p.heldSessionIds.length > 0) {
      if (p.sessionId === s.id || p.heldSessionIds.includes(s.id)) out.set(p.pid, p);
      continue;
    }
    if (s.cwd && p.cwd === s.cwd && (p.startedAt === undefined || p.startedAt <= s.lastActivityAt + START_SLACK_MS)) out.set(p.pid, p);
  }
  return [...out.values()];
}

/** A registry entry as a process row, for owners ps did not classify. */
function processFromOwner(o: SessionOwner): AgentProcess {
  return {
    pid: o.pid,
    ppid: 0,
    startedAt: o.startedAt,
    tool: "claude",
    command: `claude (registry: ${o.entrypoint ?? o.kind ?? "unknown"})`,
    cwd: o.cwd,
    interactive: o.kind === "interactive" && o.entrypoint !== "claude-desktop",
    sessionId: o.sessionId,
    heldSessionIds: [],
  };
}

/**
 * Status of a discovered session (no run of ours on it): the evidence — owners, the
 * snapshot's health, the file's last turn-bearing write — handed to `deriveStatus`.
 * Shared by list() and tests.
 */
export function statusFor(s: DiscoveredSession, procs: readonly AgentProcess[], now: number, leases: Leases = DEFAULT_LEASES, owners: readonly SessionOwner[] = [], degraded?: string): { status: AgentStatus; hint: AgentHint; live: AgentProcess[] } {
  const live = liveProcessesFor(s, procs, owners);
  const evidence: Evidence = { archived: s.archived, owners: live.length, degraded, mtimeMs: s.mtimeMs, lastTurn: s.lastTurn, run: undefined, ask: false };
  return { ...deriveStatus(evidence, now, leases), live };
}

export function sessionName(s: DiscoveredSession): string {
  const base = s.title ?? s.firstPrompt;
  if (base) return truncate(base, 60);
  return s.cwd ? `${s.tool} · ${basename(s.cwd)}` : `${s.tool} · ${s.id.slice(0, 8)}`;
}

/** "12 msgs" when the whole file was read; "~2.3k msgs" when extrapolated from head+tail. */
export function formatMessageCount(count: number, exact: boolean): string {
  if (exact) return `${count} msg${count === 1 ? "" : "s"}`;
  if (count >= 10_000) return `~${Math.round(count / 1000)}k msgs`;
  if (count >= 1_000) return `~${(count / 1000).toFixed(1)}k msgs`;
  if (count >= 100) return `~${Math.round(count / 10) * 10} msgs`;
  return `~${count} msgs`;
}

/**
 * "codex · 2.3k msgs · gt-cloud", plus what a run of ours is doing when there is one.
 * Never a relative time: the rail formats that from `updatedAt` itself, so a detail
 * only changes when the session does (the `hint` word says why the status is what it is).
 */
export function sessionDetail(s: DiscoveredSession, extra?: string): string {
  const msgs = formatMessageCount(s.messageCount, s.messageCountExact);
  const dir = s.cwd ? basename(s.cwd) : undefined;
  return [s.tool, msgs, dir, extra].filter((x): x is string => Boolean(x)).join(" · ");
}

/** "sessions:claude:<id>" → { tool, localId }; undefined for anything else. */
export function parseSessionsAgentId(id: string): { tool: SessionTool; localId: string } | undefined {
  const split = splitAgentId(id);
  const local = split?.kind === "sessions" ? split.localId : id;
  const idx = local.indexOf(":");
  if (idx <= 0) return undefined;
  const tool = local.slice(0, idx);
  const localId = local.slice(idx + 1);
  if ((tool !== "claude" && tool !== "codex") || localId.length === 0) return undefined;
  return { tool, localId };
}

/** "codex" | "claude" from what a caller might say: "codex", "claude", "claude-code", "claude code". */
export function normalizeSessionTool(value: string | undefined): SessionTool | undefined {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "codex") return "codex";
  if (v === "claude" || v === "claude-code" || v === "claude code" || v === "claudecode") return "claude";
  return undefined;
}

/** One line of a tool's input for the Console: the command, the file, or the first string. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const pick = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? truncate(v, 80) : undefined);
  if (toolName === "Bash") return pick(input["command"]) ?? "";
  const path = pick(input["file_path"]) ?? pick(input["path"]) ?? pick(input["notebook_path"]);
  if (path) return path;
  for (const v of Object.values(input)) {
    const s = pick(v);
    if (s) return s;
  }
  return "";
}

const YES = /^\s*(yes|y|yeah|yep|allow|go ahead|ok|okay|approve|do it)\b/i;
const NO = /^\s*(no|n|nope|deny|stop|don'?t|cancel)\b/i;

interface Listed {
  readonly session: DiscoveredSession;
  readonly info: AgentInfo;
}

interface Snapshot {
  readonly at: number;
  readonly processes: AgentProcess[];
  /** Registry entries whose pid is alive. */
  readonly owners: SessionOwner[];
  readonly degraded: string | undefined;
}

/** A resumed session's question for Kevin, held until send("yes"/"no"), resolvePermission(), or the timeout. */
export interface PendingAsk {
  readonly toolName: string;
  readonly summary: string;
  readonly askedAt: number;
}

interface Ask extends PendingAsk {
  readonly settle: (decision: PermissionDecision) => void;
  /** Start the answer timeout: called once, when the ask becomes the one Kevin is shown. */
  readonly show: () => void;
}

/** Runs and in-flight continuations are keyed by tool and the tool's own id. */
function runKey(tool: SessionTool, id: string): string {
  return `${tool}:${id}`;
}

export class SessionsConnector implements AgentConnector {
  readonly kind = "sessions" as const;
  readonly claude: ClaudeStore;
  readonly codex: CodexStore;
  readonly runners: { readonly claude: ClaudeCodeRunner; readonly codex: CodexRunner };
  private readonly home: string;
  private readonly registryDir: string;
  private readonly now: () => number;
  private readonly leases: Leases;
  private readonly pollMs: number;
  private readonly pollQuietMs: number;
  private readonly pollStuckMs: number;
  private readonly settlePollMs: number;
  private readonly settleQuietMs: number;
  private readonly processCacheMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly listeners = new Set<(agent: AgentInfo) => void>();
  /** Sessions this connector is driving, by runKey. */
  private readonly runs = new Map<string, RunHandle>();
  /** Continuations in flight, by runKey: a second send() for the same session waits and reuses what the first made. */
  private readonly starting = new Map<string, Promise<SendResult>>();
  /** Threads started here whose file the store has not listed yet, by runKey. */
  private readonly pendingStarts = new Map<string, DiscoveredSession>();
  /**
   * Permission questions waiting on Kevin, by Claude session id, oldest first. Claude
   * routinely issues several tool calls in one message, so a session can have more than
   * one open; the first is the one shown and answered, the rest wait their turn.
   */
  private readonly asks = new Map<string, Ask[]>();
  /** Fires the Claude session id whenever its ask queue changes; waitSettled() listens. */
  private readonly askChanges = new EventEmitter();
  /** Fires a runKey on every event of that run; waitSettled() listens. */
  private readonly runChanges = new EventEmitter();
  /** Conversations opened through transcript()/watch(), by runKey; each knows its file and where the last read ended. */
  private readonly sources = new Map<string, TranscriptSource>();
  private snapshotCache: Snapshot | undefined;
  private lastListed = new Map<string, Listed>();
  private lastListedAt = 0;
  private othersCache: { at: number; names: string[] } | undefined;

  constructor(private readonly opts: SessionsConnectorOptions = {}) {
    this.home = opts.home ?? homedir();
    this.registryDir = opts.registryDir ?? defaultClaudeSessionsDir(this.home);
    this.now = opts.now ?? Date.now;
    const storeOpts = {
      ...(opts.maxAgeDays !== undefined ? { maxAgeDays: opts.maxAgeDays } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      now: this.now,
    };
    this.claude = new ClaudeStore({ ...storeOpts, root: opts.claudeRoot ?? defaultClaudeProjectsRoot(this.home) });
    this.codex = new CodexStore({ ...storeOpts, root: opts.codexRoot ?? defaultCodexRoot(this.home) });
    this.leases = { ...DEFAULT_LEASES, ...opts.leases };
    this.pollMs = opts.pollMs ?? POLL_ACTIVE_MS;
    this.pollQuietMs = opts.pollQuietMs ?? (opts.pollMs !== undefined ? opts.pollMs * 4 : POLL_QUIET_MS);
    this.pollStuckMs = opts.pollStuckMs ?? POLL_STUCK_MS;
    this.settlePollMs = opts.settlePollMs ?? 1_000;
    this.settleQuietMs = opts.settleQuietMs ?? 5_000;
    this.processCacheMs = opts.processCacheMs ?? 5_000;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 5 * 60_000;
    this.askChanges.setMaxListeners(0);
    this.runChanges.setMaxListeners(0);
    const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), ...(opts.codexBin ? { JARHEAD_CODEX_BIN: opts.codexBin } : {}) };
    const discovery = { env, home: this.home, ...(opts.applicationsDir ? { applicationsDir: opts.applicationsDir } : {}), ...(opts.cliSystemDirs ? { systemDirs: opts.cliSystemDirs } : {}) };
    const dropApiKey = opts.dropApiKey ?? true;
    this.runners = {
      claude: new ClaudeCodeRunner({
        ...discovery,
        ...(opts.sdk ? { sdk: opts.sdk } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        dropApiKey,
        nameOf: sessionName,
      }),
      codex: new CodexRunner({
        ...discovery,
        codexRoot: this.codex.root,
        dropApiKey,
        now: this.now,
        ...(opts.codexTurnBudgetMs !== undefined ? { turnBudgetMs: opts.codexTurnBudgetMs } : {}),
        ...(opts.codexStartTimeoutMs !== undefined ? { startTimeoutMs: opts.codexStartTimeoutMs } : {}),
        ...(opts.codexQueueTimeoutMs !== undefined ? { queueTimeoutMs: opts.codexQueueTimeoutMs } : {}),
        ...(opts.codexKillGraceMs !== undefined ? { killGraceMs: opts.codexKillGraceMs } : {}),
        ...(opts.codexFinishingMaxMs !== undefined ? { finishingMaxMs: opts.codexFinishingMaxMs } : {}),
      }),
    };
  }

  private runnerFor(tool: SessionTool): SessionRunner {
    return this.runners[tool];
  }

  /** ps/lsof plus the Claude Code registry, taken together so both describe the same instant. */
  private async snapshot(): Promise<Snapshot> {
    const now = this.now();
    if (this.snapshotCache && now - this.snapshotCache.at < this.processCacheMs) return this.snapshotCache;
    const [procs, registry] = await Promise.all([
      this.opts.processes
        ? this.opts.processes().then((processes): ProcessSnapshot => ({ processes, pids: new Set(processes.map((p) => p.pid)), degraded: undefined }))
        : listAgentProcesses(this.opts.exec ? { exec: this.opts.exec } : {}),
      readClaudeRegistry(this.registryDir),
    ]);
    // A registry file outlives its process; only entries ps still sees are owners. With ps
    // itself down there is no pid list, so nothing counts and the snapshot is degraded anyway.
    const owners = registry.filter((o) => procs.pids.has(o.pid));
    const snap: Snapshot = { at: now, processes: procs.processes, owners, degraded: procs.degraded };
    this.snapshotCache = snap;
    return snap;
  }

  /** Pids of the children this connector is running; they own their sessions on our behalf, not on someone else's. */
  private ownPids(): Set<number> {
    const out = new Set<number>();
    for (const run of this.runs.values()) for (const pid of run.pids) out.add(pid);
    return out;
  }

  /** Who owns `s` right now, our own drivers left out. */
  private async ownership(s: DiscoveredSession): Promise<OwnershipSnapshot> {
    const snap = await this.snapshot();
    const own = this.ownPids();
    const processes = own.size ? snap.processes.filter((p) => !own.has(p.pid)) : snap.processes;
    return { live: liveProcessesFor(s, processes, snap.owners), processes, owners: snap.owners, degraded: snap.degraded };
  }

  private async others(): Promise<string[]> {
    const now = this.now();
    if (this.othersCache && now - this.othersCache.at < 60_000) return this.othersCache.names;
    const names = await detectOthers(this.home);
    this.othersCache = { at: now, names };
    return names;
  }

  // ------------------------------------------------------------------ info ---

  private info(s: DiscoveredSession, snap: Snapshot): AgentInfo {
    const id = agentId(this.kind, `${s.tool}:${s.id}`);
    const run = this.runs.get(runKey(s.tool, s.id));
    const now = this.now();
    if (run && run.status !== "offline") {
      // An open question is "blocked" whatever the driver says: its own flag clears when
      // the first of several parallel asks is answered, while the next is still waiting.
      const ask = s.tool === "claude" ? this.headAsk(s.id) : undefined;
      const extra = ask
        ? `needs Kevin's yes or no: ${ask.toolName}${ask.summary ? ` — ${ask.summary}` : ""}`
        : run.statusDetail
          ? `resumed: ${run.statusDetail}`
          : "resumed by Jarhead";
      const { status, hint } = deriveStatus(this.runEvidence(s, run, snap.degraded), now, this.leases);
      return { id, kind: this.kind, tool: s.tool, name: sessionName(s), status, detail: sessionDetail(s, extra), ...(s.cwd ? { cwd: s.cwd } : {}), updatedAt: Math.max(s.lastActivityAt, run.lastActivityAt), messageCount: s.messageCount, hint };
    }
    const { status, hint } = statusFor(s, snap.processes, now, this.leases, snap.owners, snap.degraded);
    return { id, kind: this.kind, tool: s.tool, name: sessionName(s), status, detail: sessionDetail(s), ...(s.cwd ? { cwd: s.cwd } : {}), updatedAt: s.lastActivityAt, messageCount: s.messageCount, hint };
  }

  /**
   * Evidence for a session this process drives: the run's own status and last event, and
   * whether a question is open for Kevin. One place, so the rail (`info`) and `waitSettled`
   * read the same rule — a run whose stream went silent past `runStallMs` is `unknown` to both.
   */
  private runEvidence(s: DiscoveredSession, run: RunHandle, degraded: string | undefined): Evidence {
    const ask = s.tool === "claude" ? this.headAsk(s.id) !== undefined : false;
    return { archived: s.archived, owners: 1, degraded, mtimeMs: s.mtimeMs, lastTurn: s.lastTurn, run: { status: run.status, detail: run.statusDetail, since: run.lastActivityAt }, ask };
  }

  /**
   * Health that tells the truth, one line per tool: "Codex 0.153.4 (ChatGPT.app) · signed in ·
   * desktop app running · 39 threads | Claude Code 2.1.263 (~/.local/bin) · 12 sessions · 1
   * running", or exactly why not ("codex not found: looked in …", "not signed in (~/.codex/
   * auth.json missing)"). ok when there is a session store to list or a Codex to start threads with.
   */
  async health(): Promise<ConnectorHealth> {
    const [hasClaude, hasCodex, others, codexUsable] = await Promise.all([this.claude.exists(), this.codex.exists(), this.others(), this.runners.codex.usable()]);
    if ((hasClaude || hasCodex) && this.now() - this.lastListedAt > 10_000) await this.list();
    let claude = 0;
    let codex = 0;
    for (const { session } of this.lastListed.values()) {
      if (session.tool === "claude") claude += 1;
      else codex += 1;
    }
    const snap = await this.snapshot();
    const [codexLine, claudeLine] = await Promise.all([
      this.runners.codex.describe({ processes: snap.processes, listed: codex, storePresent: hasCodex }),
      this.runners.claude.describe({ processes: snap.processes, listed: claude, storePresent: hasClaude }),
    ]);
    const ok = hasClaude || hasCodex || codexUsable.ok;
    const parts: string[] = [];
    if (!hasClaude && !hasCodex) parts.push(`no Claude Code or Codex session store under ${this.home}`);
    parts.push(codexLine, claudeLine);
    if (snap.degraded) parts.push(`process detection degraded (${snap.degraded})`);
    if (others.length) parts.push(`also found: ${others.join(", ")}`);
    return { kind: this.kind, ok, detail: parts.join(" | ") };
  }

  async list(): Promise<AgentInfo[]> {
    const [claude, codex, snap] = await Promise.all([this.claude.scan(), this.codex.scan(), this.snapshot()]);
    const listed = new Map<string, Listed>();
    // Stores are newest-first and already one-per-id; should two files ever share an id, the newest stays.
    for (const s of [...claude, ...codex]) {
      const info = this.info(s, snap);
      if (!listed.has(info.id)) listed.set(info.id, { session: s, info });
    }
    // Threads started here are agents from the first second, file or no file yet.
    for (const [key, s] of [...this.pendingStarts]) {
      const id = agentId(this.kind, `${s.tool}:${s.id}`);
      if (listed.has(id) || !this.runs.has(key)) {
        this.pendingStarts.delete(key);
        continue;
      }
      listed.set(id, { session: s, info: this.info(s, snap) });
    }
    this.lastListed = listed;
    this.lastListedAt = this.now();
    return [...listed.values()].map((l) => l.info).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The session behind an id: from the last listing, else straight from disk (age/cap ignored), else a thread started here. */
  private async resolve(id: string): Promise<DiscoveredSession> {
    const parsed = parseSessionsAgentId(id);
    if (!parsed) throw new TypeError(`not a sessions agent id: ${id}`);
    const full = agentId(this.kind, `${parsed.tool}:${parsed.localId}`);
    const listed = this.lastListed.get(full);
    if (listed) return listed.session;
    const found = parsed.tool === "claude" ? await this.claude.find(parsed.localId) : await this.codex.find(parsed.localId);
    if (found) return found;
    const pending = this.pendingStarts.get(runKey(parsed.tool, parsed.localId));
    if (pending) return pending;
    throw new Error(`no ${parsed.tool} session ${parsed.localId}`);
  }

  async read(id: string, _opts: ReadOptions = {}): Promise<string> {
    const s = await this.resolve(id);
    const run = this.runs.get(runKey(s.tool, s.id));
    const when = ago(Math.max(s.lastActivityAt, run?.lastActivityAt ?? 0), this.now());
    const context = [sessionName(s), s.cwd, when].filter((x): x is string => Boolean(x)).join(" — ");
    const ask = s.tool === "claude" ? this.headAsk(s.id) : undefined;
    if (ask) return `${context}\nwaiting for Kevin's yes or no before ${ask.toolName}${ask.summary ? `: ${ask.summary}` : ""}`;
    const text = run?.lastReply || s.lastAssistantText || (run?.status === "working" ? "(still working)" : "(no assistant reply recorded)");
    return `${context}\n${text}`;
  }

  // ---------------------------------------------------------- conversations ---

  /**
   * The session behind an id, freshest first: straight from disk (the file may have grown
   * since the listing, and a thread started here has a real rollout by now), then the
   * listing, then a start still waiting for its file.
   */
  private async resolveFromDisk(id: string): Promise<DiscoveredSession> {
    const parsed = parseSessionsAgentId(id);
    if (!parsed) throw new TypeError(`not a sessions agent id: ${id}`);
    const found = parsed.tool === "claude" ? await this.claude.find(parsed.localId) : await this.codex.find(parsed.localId);
    if (found) {
      const full = agentId(this.kind, `${parsed.tool}:${parsed.localId}`);
      const listed = this.lastListed.get(full);
      if (listed) this.lastListed.set(full, { session: found, info: listed.info });
      return found;
    }
    return this.resolve(id);
  }

  /**
   * The conversation source for a session; replaced when its file moved (a pending start
   * got its rollout). `replaced` says a source for another path stood here before, so
   * whatever the new file holds was never shown from it.
   */
  private async sourceFor(id: string): Promise<{ session: DiscoveredSession; source: TranscriptSource; replaced: boolean }> {
    const s = await this.resolveFromDisk(id);
    const key = runKey(s.tool, s.id);
    let source = this.sources.get(key);
    let replaced = false;
    if (!source || source.path !== s.path) {
      replaced = source !== undefined;
      source?.close();
      source = new TranscriptSource({
        path: s.path,
        makeParser: s.tool === "claude" ? () => new ClaudeTranscriptParser() : () => new CodexTranscriptParser(),
        storeCount: () => this.lastListed.get(agentId(this.kind, `${s.tool}:${s.id}`))?.session.messageCount ?? s.messageCount,
        ...(this.opts.tailPollMs !== undefined ? { pollMs: this.opts.tailPollMs } : {}),
        ...(this.opts.tailCoalesceMs !== undefined ? { coalesceMs: this.opts.tailCoalesceMs } : {}),
        ...(this.opts.tailGoneAfterMs !== undefined ? { goneAfterMs: this.opts.tailGoneAfterMs } : {}),
      });
      this.sources.set(key, source);
    }
    return { session: s, source, replaced };
  }

  /** A thread started here whose file the tool has not written yet: its path is the placeholder nothing will ever write. */
  private isPlaceholder(s: DiscoveredSession): boolean {
    return this.pendingStarts.get(runKey(s.tool, s.id))?.path === s.path;
  }

  /** A page of the session's conversation: the newest `limit` turns, or those before message `before`. */
  async transcript(id: string, opts: TranscriptOptions = {}): Promise<TranscriptPage> {
    const { source } = await this.sourceFor(id);
    return source.page(opts);
  }

  /**
   * New turns as the session file grows — whoever writes them — until the returned
   * function is called. Deltas carry messages created or changed: a tool call appears
   * first as running and again, same id, with its output. A thread started here whose
   * file is not on disk yet is looked for again every second, then followed from its
   * first line. `onEnd` hears when there is no such session (any more), or when the
   * tail stopped: the file was replaced, truncated, or gone for 10 s. Gone is looked
   * into once first — Codex archives a thread by moving its rollout, and a moved file
   * is followed on from the same byte with no gap and no signal.
   */
  watch(id: string, onDelta: (delta: TranscriptDelta) => void, onEnd?: (reason: string) => void): () => void {
    let stop: (() => void) | undefined;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let looks = 0;
    let moved = false;
    const end = (reason: string): void => {
      if (closed) return;
      closed = true;
      log.info(`watch ${id}: ended (${reason})`);
      onEnd?.(reason);
    };
    const follow = (source: TranscriptSource, fromStart: boolean): void => {
      stop = source.follow(onDelta, {
        fromStart,
        onEnd: (reason) => {
          if (closed) return;
          if (reason !== "gone" || moved) {
            end(reason);
            return;
          }
          moved = true;
          this.sourceFor(id)
            .then(({ source: next, replaced }) => {
              if (closed) return;
              if (!replaced || next.path === source.path) {
                end("gone");
                return;
              }
              log.info(`watch ${id}: file moved to ${basename(next.path)}; following on`);
              next.continueFrom(source);
              follow(next, false);
            })
            .catch(() => end("gone"));
        },
      });
    };
    const attempt = (): void => {
      looks += 1;
      this.sourceFor(id)
        .then(({ session, source, replaced }) => {
          if (closed) return;
          if (this.isPlaceholder(session)) {
            // Each look walks the store for the file; after the first few, look five times less often.
            const base = this.opts.tailPollMs ?? 1_000;
            timer = setTimeout(attempt, looks < 5 ? base : base * 5);
            timer.unref?.();
            return;
          }
          // A file that took the place of the placeholder was never shown: replay it from
          // its first line (unless a page of it was served meanwhile, e.g. by a reload).
          follow(source, replaced && !source.served);
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
   * undefined when no conversation is open for it or nothing was running.
   */
  async settle(id: string): Promise<TranscriptDelta | undefined> {
    const parsed = parseSessionsAgentId(id);
    if (!parsed) throw new TypeError(`not a sessions agent id: ${id}`);
    const source = this.sources.get(runKey(parsed.tool, parsed.localId));
    if (!source) return undefined;
    const messages = source.interruptOpenCalls();
    return messages.length ? { messages, total: source.total } : undefined;
  }

  async send(id: string, text: string): Promise<SendResult> {
    const s = await this.resolve(id);
    const key = runKey(s.tool, s.id);
    // Another send() may be mid-continuation for this very session: wait for it, then reuse what it made.
    const inflight = this.starting.get(key);
    if (inflight) await inflight;
    const existing = this.runs.get(key);
    if (existing && existing.status !== "offline") {
      if (s.tool === "claude") {
        const tool = this.pendingPermission(id)?.toolName;
        if (tool) {
          // A yes/no while blocked answers the question rather than starting a turn.
          if (YES.test(text)) {
            this.answer(s.id, existing, true);
            return { accepted: true, detail: `allowed ${tool}` };
          }
          if (NO.test(text)) {
            this.answer(s.id, existing, false);
            return { accepted: true, detail: `denied ${tool}` };
          }
        }
        existing.send(text);
        return { accepted: true, detail: "sent to the resumed session" };
      }
      // Our own turn is running: the next one waits behind it in the same run.
      if (existing.status === "working") {
        existing.send(text);
        return { accepted: true, detail: "sent to the resumed session" };
      }
      // Idle between turns. Kevin may have opened the thread in Codex since; ask again who owns it.
      const can = await this.runnerFor(s.tool).canContinue(s, await this.ownership(s));
      if (!can.ok) return { accepted: false, detail: can.reason };
      if (can.mode === "resume") {
        existing.send(text);
        return { accepted: true, detail: "sent to the resumed session" };
      }
      return this.fileOutcome(key, await this.runnerFor(s.tool).continue(s, text, can.mode, this.sinkFor(id, s)));
    }
    // Reserve the key before the first await below; concurrent callers see `inflight` and wait.
    const attempt = this.continueSession(id, s, text);
    this.starting.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (this.starting.get(key) === attempt) this.starting.delete(key);
    }
  }

  /** Continue `s` with `text` the way its runner says; refuses when ownership is unclear. */
  private async continueSession(id: string, s: DiscoveredSession, text: string): Promise<SendResult> {
    const runner = this.runnerFor(s.tool);
    const can = await runner.canContinue(s, await this.ownership(s));
    if (!can.ok) return { accepted: false, detail: can.reason };
    const handler = this.opts.canUseTool ?? ((toolName: string, input: Record<string, unknown>, session: ClaudeSession) => this.askKevin(id, s.id, toolName, input, session));
    const outcome = await runner.continue(s, text, can.mode, this.sinkFor(id, s), { canUseTool: handler });
    return this.fileOutcome(runKey(s.tool, s.id), outcome);
  }

  /** Record a run the runner handed back and turn the outcome into a SendResult. */
  private fileOutcome(key: string, outcome: ContinueOutcome): SendResult {
    if (outcome.kind === "refused") return { accepted: false, detail: outcome.reason };
    if (outcome.kind === "delivered") return { accepted: true, detail: outcome.detail };
    const old = this.runs.get(key);
    if (old && old !== outcome.handle) void old.close();
    this.runs.set(key, outcome.handle);
    return { accepted: true, detail: outcome.detail };
  }

  /** The sink a runner reports through: files the handle, forwards changes, cleans up when it ends. */
  private sinkFor(id: string, s: Pick<DiscoveredSession, "tool" | "id">): RunSink {
    const key = runKey(s.tool, s.id);
    return (e, handle) => {
      if (e.type === "closed") {
        if (this.runs.get(key) === handle) this.runs.delete(key);
        if (s.tool === "claude") for (const ask of [...(this.asks.get(s.id) ?? [])]) ask.settle({ behavior: "deny", message: "session ended" });
      } else if (!this.runs.has(key) && handle.status !== "offline") {
        this.runs.set(key, handle);
      }
      if (e.type === "error") log.debug(`${s.tool} ${s.id.slice(0, 8)}: ${e.message}`);
      // A Codex turn just ended: the cached ps/lsof snapshot may still list the child that ran it.
      if (s.tool === "codex" && e.type === "status" && e.status !== "working") this.snapshotCache = undefined;
      this.runChanges.emit(key);
      void this.notify(id);
    };
  }

  // ------------------------------------------------------------------ start ---

  /**
   * A new thread in a folder: `tool` (or `kind`) is "codex" or "claude"; `cwd` and `prompt` are its first turn.
   * The thread is persisted by the tool itself and listed here from the first second.
   */
  async start(opts: StartOptions): Promise<AgentInfo> {
    const tool = normalizeSessionTool(opts.tool ?? opts.kind);
    if (!tool) throw new Error(`sessions can start "codex" or "claude" threads, not "${opts.tool ?? opts.kind ?? ""}"`);
    const cwd = opts.cwd ?? process.cwd();
    const prompt = opts.prompt ?? "";
    const runner = this.runnerFor(tool);
    let filed: { key: string; id: string } | undefined;
    const sink: RunSink = (e, handle) => {
      // The thread id arrives with the first events; from then on this run is an ordinary session.
      if (!filed && handle.sessionId) {
        filed = { key: runKey(tool, handle.sessionId), id: agentId(this.kind, `${tool}:${handle.sessionId}`) };
        if (handle.status !== "offline") {
          this.runs.set(filed.key, handle);
          this.pendingStarts.set(filed.key, this.syntheticSession(tool, handle.sessionId, cwd, prompt, opts.name));
        }
      }
      if (!filed) return;
      this.sinkFor(filed.id, { tool, id: handle.sessionId ?? "" })(e, handle);
    };
    // Claude asks permissions only inside a turn, after init has named the session; the id is known by then.
    const handler =
      this.opts.canUseTool ??
      ((toolName: string, input: Record<string, unknown>, session: ClaudeSession) => {
        const sid = session.sessionId ?? "";
        return this.askKevin(filed?.id ?? agentId(this.kind, `${tool}:${sid}`), sid, toolName, input, session);
      });
    const handle = await runner.start(cwd, prompt, sink, { canUseTool: handler });
    try {
      await handle.ready;
    } catch (e) {
      await handle.close().catch(() => undefined);
      throw new Error(`${tool} did not start a thread in ${cwd}: ${(e as Error).message}`);
    }
    const threadId = handle.sessionId;
    if (!threadId) {
      await handle.close().catch(() => undefined);
      throw new Error(`${tool} started but never reported a thread id`);
    }
    const key = runKey(tool, threadId);
    if (!this.runs.has(key) && handle.status !== "offline") this.runs.set(key, handle);
    if (!this.pendingStarts.has(key)) this.pendingStarts.set(key, this.syntheticSession(tool, threadId, cwd, prompt, opts.name));
    const s = (tool === "claude" ? await this.claude.find(threadId) : await this.codex.find(threadId)) ?? this.pendingStarts.get(key)!;
    const info = this.info(s, await this.snapshot());
    this.lastListed.set(info.id, { session: s, info });
    this.notifyAll(info);
    return info;
  }

  /** What a just-started thread looks like before its file is on disk: the prompt is its name, the cwd its place. */
  private syntheticSession(tool: SessionTool, id: string, cwd: string, prompt: string, name: string | undefined): DiscoveredSession {
    const now = this.now();
    return {
      tool,
      id,
      source: "user",
      parentId: undefined,
      path: join(cwd, `.jarhead-${tool}-${id}.pending`),
      cwd,
      title: name?.trim() ? truncate(name, 80) : undefined,
      firstPrompt: prompt.trim() ? truncate(prompt, 80) : undefined,
      lastAssistantText: undefined,
      startedAt: now,
      lastActivityAt: now,
      mtimeMs: now,
      sizeBytes: 0,
      messageCount: prompt.trim() ? 1 : 0,
      messageCountExact: true,
      archived: false,
      lastTurn: prompt.trim() ? { kind: "open", at: now } : undefined,
    };
  }

  // ------------------------------------------------------------ permissions ---

  /**
   * The default permission policy for resumed sessions. Read-only tools, safe shell and
   * edits pass at once, as in the primary Claude Code connector; anything else becomes a
   * question the Console and the voice loop can see (status "blocked", detail names the
   * tool and its input) and stays open until Kevin answers through send("yes"/"no") or
   * resolvePermission(). Parallel tool calls queue up and reach him one at a time, each
   * with its own clock. No answer within the timeout denies the tool: closed, not open.
   */
  private async askKevin(id: string, sid: string, toolName: string, input: Record<string, unknown>, session: ClaudeSession): Promise<PermissionDecision> {
    const quick = await defaultCanUseTool(toolName, input, session);
    if (quick.behavior === "allow") return quick;
    return new Promise<PermissionDecision>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ask: Ask = {
        toolName,
        summary: summarizeToolInput(toolName, input),
        askedAt: this.now(),
        settle: (decision) => {
          if (timer) clearTimeout(timer);
          const queue = this.asks.get(sid) ?? [];
          const at = queue.indexOf(ask);
          if (at !== -1) {
            queue.splice(at, 1);
            if (queue.length === 0) this.asks.delete(sid);
            else if (at === 0) queue[0]?.show();
            this.askChanges.emit(sid);
          }
          resolve(decision);
          // The Console's detail changes here even when the session's own status does not.
          void this.notify(id);
        },
        show: () => {
          timer ??= setTimeout(() => ask.settle({ behavior: "deny", message: `Kevin did not answer within ${Math.round(this.permissionTimeoutMs / 1000)} s; ${toolName} was not run` }), this.permissionTimeoutMs);
          timer.unref?.();
        },
      };
      const queue = this.asks.get(sid) ?? [];
      queue.push(ask);
      this.asks.set(sid, queue);
      if (queue.length === 1) ask.show();
      this.askChanges.emit(sid);
      // The session already reported "blocked" before calling us; report again now that the detail is known.
      void this.notify(id);
    });
  }

  /** The question Kevin is shown for a session: the oldest open one. */
  private headAsk(sid: string): Ask | undefined {
    return this.asks.get(sid)?.[0];
  }

  /**
   * With the default policy the ask queue is the one source of truth: the ClaudeSession's own
   * pending flag is set a few microtasks before the ask is registered and cleared a few after
   * it is answered, so consulting both would report questions that no longer exist. A custom
   * canUseTool never registers asks, so there the session's flag is all there is.
   */
  private answer(sid: string, run: RunHandle, allow: boolean): boolean {
    if (this.opts.canUseTool) return run.resolvePermission(allow);
    const ask = this.headAsk(sid);
    if (!ask) return false;
    ask.settle(allow ? { behavior: "allow" } : { behavior: "deny", message: "denied by Kevin" });
    return true;
  }

  /** What a resumed session is waiting on Kevin for, if anything: the first of its open questions. */
  pendingPermission(id: string): PendingAsk | undefined {
    const parsed = parseSessionsAgentId(id);
    if (!parsed || parsed.tool !== "claude") return undefined;
    if (this.opts.canUseTool) {
      const tool = this.runs.get(runKey("claude", parsed.localId))?.pendingPermissionTool;
      return tool ? { toolName: tool, summary: "", askedAt: 0 } : undefined;
    }
    const ask = this.headAsk(parsed.localId);
    return ask ? { toolName: ask.toolName, summary: ask.summary, askedAt: ask.askedAt } : undefined;
  }

  /** Answer a resumed session's permission question. True when there was one to answer. */
  resolvePermission(id: string, allow: boolean): boolean {
    const parsed = parseSessionsAgentId(id);
    if (!parsed || parsed.tool !== "claude") return false;
    const run = this.runs.get(runKey("claude", parsed.localId));
    if (!run) return false;
    return this.answer(parsed.localId, run, allow);
  }

  // --------------------------------------------------------------- waiting ---

  async waitSettled(id: string, timeoutMs: number): Promise<AgentInfo> {
    const s = await this.resolve(id);
    const key = runKey(s.tool, s.id);
    const run = this.runs.get(key);
    if (run && run.status !== "offline") {
      // Busy means the run reads `working` by the rail's own rule (liveness.ts): an open
      // question is settled ("blocked") even while the driver still says "working", and a
      // run whose stream went silent past `runStallMs` (or a "finishing" child past its
      // grace) is `unknown` — agent_wait must not sit out the whole turn budget on a child
      // that stopped talking while the rail already shows it stalled.
      const busy = (): boolean => deriveStatus(this.runEvidence(s, run, undefined), this.now(), this.leases).status === "working";
      if (busy()) {
        await new Promise<void>((resolve) => {
          const { runChanges, askChanges, leases } = this;
          let recheck: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => done(), timeoutMs);
          const done = (): void => {
            clearTimeout(timer);
            if (recheck) clearTimeout(recheck);
            runChanges.off(key, check);
            askChanges.off(s.id, check);
            resolve();
          };
          const check = (): void => {
            if (!busy()) {
              done();
              return;
            }
            // The stall bounds are clocks, not events: look again when the nearest one runs out.
            const bound = run.statusDetail === "finishing" ? leases.finishingMaxMs : leases.runStallMs;
            if (recheck) clearTimeout(recheck);
            recheck = setTimeout(check, Math.max(1, bound - (this.now() - run.lastActivityAt) + 1));
            recheck.unref?.();
          };
          runChanges.on(key, check);
          askChanges.on(s.id, check);
          check();
        });
      }
      return this.info(s, await this.snapshot());
    }
    // No driver of our own: the file is the only signal. A session nobody owns is settled
    // already — no process can write it — and so is one that is quiet for a while.
    const first = this.info(s, await this.snapshot());
    if (first.status === "ended" || first.status === "done") return first;
    const deadline = this.now() + timeoutMs;
    let lastMtime = await mtimeOf(s.path);
    let lastChange = this.now();
    while (this.now() < deadline) {
      const remaining = deadline - this.now();
      if (this.now() - lastChange >= this.settleQuietMs) break;
      await sleep(Math.min(this.settlePollMs, remaining));
      const m = await mtimeOf(s.path);
      if (m !== lastMtime) {
        lastMtime = m;
        lastChange = this.now();
      }
    }
    return this.refresh(s);
  }

  /** Re-read one session from disk (cache makes this free when unchanged). */
  private async refresh(s: DiscoveredSession): Promise<AgentInfo> {
    const fresh = (s.tool === "claude" ? await this.claude.find(s.id) : await this.codex.find(s.id)) ?? s;
    this.snapshotCache = undefined;
    const info = this.info(fresh, await this.snapshot());
    this.lastListed.set(info.id, { session: fresh, info });
    return info;
  }

  /**
   * Whether anything listed could change on its own soon: a run of ours, or a session
   * written within the last five minutes. Otherwise ps and lsof every 20 s is plenty —
   * the worst case for a dead process to read `ended` stays inside the 30 s lease.
   */
  private active(): boolean {
    if (this.runs.size > 0) return true;
    const now = this.now();
    for (const { session, info } of this.lastListed.values()) {
      if (info.status === "working" || now - session.lastActivityAt <= ACTIVE_WINDOW_MS) return true;
    }
    return false;
  }

  subscribe(onChange: (agent: AgentInfo) => void, onGone?: (agentId: string) => void): () => void {
    this.listeners.add(onChange);
    let previous = new Map<string, AgentInfo>(this.lastListed.size ? [...this.lastListed.entries()].map(([k, v]) => [k, v.info]) : []);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped for every tick and on unsubscribe; a tick whose number is stale keeps its results to itself. */
    let generation = 0;
    let busySince: number | undefined;
    const arm = (delay: number): void => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), delay);
      timer.unref?.();
    };
    const schedule = (): void => arm(this.active() ? this.pollMs : this.pollQuietMs);
    const tick = async (): Promise<void> => {
      if (busySince !== undefined) {
        const stuckFor = this.now() - busySince;
        if (stuckFor < this.pollStuckMs) {
          arm(this.pollStuckMs - stuckFor);
          return;
        }
        // One list() that never settles must not freeze every status; the late result is dropped.
        log.info(`poll stuck for ${Math.round(stuckFor / 1000)} s; abandoning it`);
      }
      const gen = ++generation;
      busySince = this.now();
      // The watchdog: a tick that never returns cannot schedule its successor, so its successor is scheduled now.
      arm(this.pollStuckMs);
      try {
        this.snapshotCache = undefined;
        const current = await this.list();
        if (gen !== generation) return;
        const next = new Map<string, AgentInfo>();
        for (const info of current) {
          next.set(info.id, info);
          const prev = previous.get(info.id);
          if (!prev || prev.status !== info.status || prev.hint !== info.hint || prev.updatedAt !== info.updatedAt || prev.detail !== info.detail || prev.name !== info.name || prev.messageCount !== info.messageCount) onChange(info);
        }
        for (const id of previous.keys()) if (!next.has(id)) onGone?.(id);
        previous = next;
      } catch (e) {
        if (gen === generation) log.info(`poll failed: ${(e as Error).message}`);
      } finally {
        if (gen === generation) {
          busySince = undefined;
          schedule();
        }
      }
    };
    schedule();
    return () => {
      stopped = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      this.listeners.delete(onChange);
    };
  }

  private async notify(id: string): Promise<void> {
    try {
      // A run-driven session's status comes from the run, not from ps: report it right now,
      // in the order the events came, rather than after a process snapshot that the next
      // event could overtake. (Nothing before this line awaits, so this part is synchronous.)
      const parsed = parseSessionsAgentId(id);
      const listed = parsed ? this.lastListed.get(agentId(this.kind, `${parsed.tool}:${parsed.localId}`)) : undefined;
      const run = parsed ? this.runs.get(runKey(parsed.tool, parsed.localId)) : undefined;
      // Claude reports "blocked" a few microtasks before the permission policy decides; a
      // tool the policy allows at once never becomes a question. That report takes the slow
      // path below, so the Console sees "blocked" only for questions that are still open.
      const provisionalBlock = run?.status === "blocked" && parsed?.tool === "claude" && this.headAsk(parsed.localId) === undefined;
      if (listed && run && run.status !== "offline" && !provisionalBlock) {
        const info = this.info(listed.session, this.snapshotCache ?? { at: 0, processes: [], owners: [], degraded: undefined });
        this.lastListed.set(info.id, { session: listed.session, info });
        this.notifyAll(info);
        return;
      }
      const s = await this.resolve(id);
      const info = this.info(s, await this.snapshot());
      this.lastListed.set(info.id, { session: s, info });
      this.notifyAll(info);
    } catch (e) {
      log.info(`notify ${id}: ${(e as Error).message}`);
    }
  }

  private notifyAll(info: AgentInfo): void {
    for (const l of this.listeners) l(info);
    this.opts.onChange?.(info);
  }

  async interrupt(id: string): Promise<void> {
    const parsed = parseSessionsAgentId(id);
    if (!parsed) throw new TypeError(`not a sessions agent id: ${id}`);
    await this.runs.get(runKey(parsed.tool, parsed.localId))?.interrupt();
  }

  async closeAll(): Promise<void> {
    for (const queue of [...this.asks.values()]) for (const ask of [...queue]) ask.settle({ behavior: "deny", message: "Jarhead is shutting down" });
    for (const source of this.sources.values()) source.close();
    this.sources.clear();
    await Promise.all([...this.runs.values()].map((r) => r.close()));
    this.runs.clear();
    this.pendingStarts.clear();
  }
}

async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
