import { basename } from "node:path";
import type { AgentInfo, AgentStatus, ConnectorHealth } from "@jarhead/protocol";
import { logger, newId } from "@jarhead/core";
import type { AgentConnector, ReadOptions, SendResult, StartOptions } from "../types.ts";
import { agentId, splitAgentId } from "../types.ts";
import { defaultHerdrBin, defaultHerdrSocketPath, runHerdr } from "./cli.ts";
import type { HerdrExec, HerdrRun } from "./cli.ts";
import { HerdrSocket } from "./socket.ts";
import type { HerdrEventEnvelope, HerdrSubscription, HerdrSubscriptionSpec } from "./socket.ts";

const log = logger("agents.herdr");

/**
 * herdr connector (herdr 0.7.4, protocol 16).
 *
 * Agent ids are `herdr:<pane_id>` (e.g. `herdr:w1:p2`). herdr's own targets also
 * accept agent names and terminal ids, but pane ids are the only handle that every
 * pane has, agentless shells included.
 *
 * Why `pane run` for send(): herdr's help is explicit that `agent send` "writes
 * literal text; use pane run when you want command text plus Enter", and a probe
 * against a `cat` pane confirmed it (the text sat on the line until Enter). `pane
 * run` delivers the text and submits it in one server-side operation, so the TUI
 * never sees a racing Enter keypress.
 */

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** The fields shared by herdr's PaneInfo (pane list) and AgentInfo (agent list). */
export interface HerdrPane {
  readonly pane_id: string;
  readonly workspace_id?: string;
  readonly tab_id?: string;
  readonly terminal_id?: string;
  readonly agent_status?: string;
  /** Detected/reported agent label ("claude", "codex"). */
  readonly agent?: string | null;
  readonly display_agent?: string | null;
  /** Name given via `agent start <name>` / `agent rename`; only on agent list entries. */
  readonly name?: string | null;
  /** Label given via `pane rename`. */
  readonly label?: string | null;
  readonly title?: string | null;
  readonly cwd?: string | null;
  readonly foreground_cwd?: string | null;
  readonly state_labels?: Readonly<Record<string, string>>;
}

export interface HerdrConnectorOptions {
  readonly bin?: string;
  readonly session?: string;
  readonly socketPath?: string;
  readonly exec?: HerdrExec;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** waitSettled poll interval. */
  readonly pollMs?: number;
  /** How long start() waits for a fresh agent to go idle before sending its prompt. */
  readonly startSettleMs?: number;
  readonly reconnect?: { readonly minMs: number; readonly maxMs: number };
}

const SETTLED: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["idle", "blocked", "done"]);

const HERDR_STATUSES: ReadonlySet<string> = new Set<HerdrAgentStatus>(["idle", "working", "blocked", "done", "unknown"]);

export function mapHerdrStatus(status: string | null | undefined): AgentStatus {
  return status !== null && status !== undefined && HERDR_STATUSES.has(status) ? (status as AgentStatus) : "unknown";
}

/** "herdr:w1:p2" → "w1:p2"; anything else → undefined. */
export function parseHerdrAgentId(id: string): string | undefined {
  const split = splitAgentId(id);
  if (!split || split.kind !== "herdr" || split.localId.length === 0) return undefined;
  return split.localId;
}

function agentLabel(pane: HerdrPane): string | undefined {
  return pane.display_agent ?? pane.agent ?? undefined;
}

export function paneToAgentInfo(pane: HerdrPane, now: number, source: "agent" | "pane" = "agent"): AgentInfo {
  const cwd = pane.foreground_cwd ?? pane.cwd ?? undefined;
  const dir = cwd ? basename(cwd) : undefined;
  const label = agentLabel(pane);
  const hasAgent = source === "agent" || label !== undefined;
  const name =
    pane.name ??
    pane.label ??
    (label ? (dir ? `${label} · ${dir}` : label) : undefined) ??
    dir ??
    pane.pane_id;
  const status: AgentStatus = hasAgent ? mapHerdrStatus(pane.agent_status) : "unknown";
  const stateLabel = pane.state_labels?.[status];
  const detail = hasAgent ? (stateLabel ?? pane.title ?? label) : "no agent detected";
  return {
    id: agentId("herdr", pane.pane_id),
    kind: "herdr",
    name,
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    updatedAt: now,
  };
}

/** Agent-list entries win; every other pane is listed as an agentless terminal. */
export function mergeAgentsAndPanes(agents: readonly HerdrPane[], panes: readonly HerdrPane[], now: number): AgentInfo[] {
  const byPane = new Map<string, AgentInfo>();
  for (const agent of agents) byPane.set(agent.pane_id, paneToAgentInfo(agent, now, "agent"));
  for (const pane of panes) {
    if (byPane.has(pane.pane_id)) continue;
    byPane.set(pane.pane_id, paneToAgentInfo(pane, now, "pane"));
  }
  return [...byPane.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function offlineInfo(paneId: string, detail: string, now: number): AgentInfo {
  return { id: agentId("herdr", paneId), kind: "herdr", name: paneId, status: "offline", detail, updatedAt: now };
}

function tailLines(text: string, lines: number): string {
  // herdr terminates the read with a newline; that is not an extra line.
  const all = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function readText(run: HerdrRun): string | undefined {
  const read = (run.result as { read?: { text?: unknown } } | undefined)?.read;
  return typeof read?.text === "string" ? read.text : undefined;
}

interface SubscriptionState {
  active: boolean;
  attempt: number;
  resubscribe: boolean;
  sub: HerdrSubscription | undefined;
  timer: NodeJS.Timeout | undefined;
  wake: (() => void) | undefined;
  readonly panes: Map<string, HerdrPane>;
}

type MutablePane = { -readonly [K in keyof HerdrPane]?: HerdrPane[K] };

export class HerdrConnector implements AgentConnector {
  readonly kind = "herdr" as const;

  private readonly bin: string;
  private readonly socketPath: string;
  private readonly socket: HerdrSocket;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly startSettleMs: number;
  private readonly reconnect: { readonly minMs: number; readonly maxMs: number };

  constructor(private readonly opts: HerdrConnectorOptions = {}) {
    this.bin = opts.bin ?? defaultHerdrBin();
    this.socketPath = opts.socketPath ?? defaultHerdrSocketPath(opts.session);
    this.socket = new HerdrSocket({ socketPath: this.socketPath });
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? 1_000;
    this.startSettleMs = opts.startSettleMs ?? 20_000;
    this.reconnect = opts.reconnect ?? { minMs: 500, maxMs: 15_000 };
  }

  private run(args: readonly string[]): Promise<HerdrRun> {
    return runHerdr(args, {
      bin: this.bin,
      socketPath: this.socketPath,
      ...(this.opts.session !== undefined ? { session: this.opts.session } : {}),
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      ...(this.opts.exec !== undefined ? { exec: this.opts.exec } : {}),
    });
  }

  private paneId(id: string): string {
    const paneId = parseHerdrAgentId(id);
    if (!paneId) throw new TypeError(`not a herdr agent id: ${id}`);
    return paneId;
  }

  async health(): Promise<ConnectorHealth> {
    const r = await this.run(["api", "snapshot"]);
    if (r.offline) return { kind: "herdr", ok: false, detail: r.offline.message };
    if (r.error) return { kind: "herdr", ok: false, detail: `herdr: ${r.error.code}: ${r.error.message}` };
    const snapshot = (r.result as { snapshot?: { version?: unknown; panes?: unknown[]; agents?: unknown[] } } | undefined)
      ?.snapshot;
    if (!snapshot) {
      const why = r.stderr.trim() || r.stdout.trim().slice(0, 200) || `exit ${r.code}`;
      return { kind: "herdr", ok: false, detail: `unexpected herdr response: ${why}` };
    }
    const version = typeof snapshot.version === "string" ? snapshot.version : "?";
    const agents = snapshot.agents?.length ?? 0;
    const panes = snapshot.panes?.length ?? 0;
    return { kind: "herdr", ok: true, detail: `herdr ${version}: ${agents} agents, ${panes} panes` };
  }

  async list(): Promise<AgentInfo[]> {
    const [agentsRun, panesRun] = await Promise.all([this.run(["agent", "list"]), this.run(["pane", "list"])]);
    if (agentsRun.offline || panesRun.offline) return [];
    const agents = (agentsRun.result as { agents?: HerdrPane[] } | undefined)?.agents ?? [];
    const panes = (panesRun.result as { panes?: HerdrPane[] } | undefined)?.panes ?? [];
    return mergeAgentsAndPanes(agents, panes, this.now());
  }

  async send(id: string, text: string): Promise<SendResult> {
    const paneId = this.paneId(id);
    const r = await this.run(["pane", "run", paneId, text]);
    if (r.offline) return { accepted: false, detail: r.offline.message };
    if (r.error) return { accepted: false, detail: `herdr: ${r.error.code}: ${r.error.message}` };
    if (r.code !== 0) return { accepted: false, detail: r.stderr.trim() || `herdr exited with ${r.code}` };
    return { accepted: true, detail: `submitted to ${paneId} via pane run` };
  }

  /**
   * `agent read` accepts pane ids for agentless panes too and returns JSON, so it is
   * the primary path. `recent-unwrapped` can be empty when herdr has no attached
   * client (its output revision never advances), hence the `visible` retry; raw
   * `pane read` is the last resort.
   */
  async read(id: string, opts?: ReadOptions): Promise<string> {
    const paneId = this.paneId(id);
    const lines = Math.max(1, Math.floor(opts?.lines ?? 40));
    const args = (source: string): string[] => [paneId, "--source", source, "--lines", String(lines), "--format", "text"];

    const primary = await this.run(["agent", "read", ...args("recent-unwrapped")]);
    if (primary.offline) return "";
    let text = readText(primary);
    if (text !== undefined && text.trim() === "") {
      const visible = await this.run(["agent", "read", ...args("visible")]);
      const v = readText(visible);
      if (v !== undefined && v.trim() !== "") text = v;
    }
    if (text === undefined) {
      const fallback = await this.run(["pane", "read", ...args("recent-unwrapped")]);
      if (fallback.offline) return "";
      if (fallback.error) throw new Error(`herdr: ${fallback.error.code}: ${fallback.error.message}`);
      if (fallback.code !== 0) throw new Error(`herdr pane read failed: ${fallback.stderr.trim() || `exit ${fallback.code}`}`);
      text = fallback.stdout;
    }
    return tailLines(text, lines).trimEnd();
  }

  /**
   * `agent start <name> [--cwd] -- <argv>`; 0.7.4 has no `--kind`, the argv is the
   * kind. `opts.kind` may be a bare command ("claude") or a command line.
   */
  async start(opts: StartOptions): Promise<AgentInfo> {
    const argv = (opts.kind?.trim() || "claude").split(/\s+/);
    const command = argv[0] ?? "claude";
    const name = opts.name?.trim() || `${command}-${newId("h").slice(-5)}`;
    const args = ["agent", "start", name];
    if (opts.cwd) args.push("--cwd", opts.cwd);
    args.push("--no-focus", "--", ...argv);

    const r = await this.run(args);
    if (r.offline) return offlineInfo(name, r.offline.message, this.now());
    if (r.error) throw new Error(`herdr agent start failed: ${r.error.code}: ${r.error.message}`);
    const started = (r.result as { agent?: HerdrPane } | undefined)?.agent;
    if (!started) throw new Error(`herdr agent start returned no agent: ${r.stderr.trim() || r.stdout.trim()}`);

    let info = paneToAgentInfo(started, this.now(), "agent");
    if (opts.prompt) {
      // A TUI agent needs a moment to boot before it accepts input; idle is the
      // first status herdr's detection reports once the prompt is up.
      const settled = await this.waitSettled(info.id, this.startSettleMs);
      const sent = await this.send(info.id, opts.prompt);
      info = { ...settled, detail: sent.accepted ? "prompt sent" : `prompt not sent: ${sent.detail ?? "unknown"}` };
    }
    return info;
  }

  async waitSettled(id: string, timeoutMs: number): Promise<AgentInfo> {
    const paneId = this.paneId(id);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const { pane, run } = await this.fetchPane(paneId);
      if (run.offline) return offlineInfo(paneId, run.offline.message, this.now());
      if (!pane) return offlineInfo(paneId, run.error?.message ?? "pane not found", this.now());
      const info = paneToAgentInfo(pane, this.now(), pane.name || pane.agent ? "agent" : "pane");
      const remaining = deadline - this.now();
      if (SETTLED.has(info.status) || remaining <= 0) return info;
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }

  /** Esc interrupts a coding agent's turn; Ctrl+C is right for a plain shell. */
  async interrupt(id: string): Promise<void> {
    const paneId = this.paneId(id);
    const { pane, run } = await this.fetchPane(paneId);
    if (run.offline) return;
    const key = pane?.agent || pane?.name ? "escape" : "ctrl+c";
    const r = await this.run(["pane", "send-keys", paneId, key]);
    if (r.error) throw new Error(`herdr: ${r.error.code}: ${r.error.message}`);
  }

  /** `agent get` knows the agent's name; `pane get` covers agentless panes. */
  private async fetchPane(paneId: string): Promise<{ pane?: HerdrPane; run: HerdrRun }> {
    const agent = await this.run(["agent", "get", paneId]);
    const found = (agent.result as { agent?: HerdrPane } | undefined)?.agent;
    if (found) return { pane: found, run: agent };
    if (agent.offline) return { run: agent };
    const pane = await this.run(["pane", "get", paneId]);
    const info = (pane.result as { pane?: HerdrPane } | undefined)?.pane;
    return info ? { pane: info, run: pane } : { run: pane };
  }

  // ------------------------------------------------------------ subscribe ---

  subscribe(onChange: (agent: AgentInfo) => void): () => void {
    const state: SubscriptionState = {
      active: true,
      attempt: 0,
      resubscribe: false,
      sub: undefined,
      timer: undefined,
      wake: undefined,
      panes: new Map(),
    };
    void this.subscriptionLoop(state, onChange);
    return () => {
      state.active = false;
      if (state.timer) clearTimeout(state.timer);
      state.wake?.();
      state.sub?.close();
    };
  }

  private async subscriptionLoop(state: SubscriptionState, onChange: (agent: AgentInfo) => void): Promise<void> {
    while (state.active) {
      try {
        await this.seedPanes(state);
        state.resubscribe = false;
        const sub = await this.socket.subscribe(this.subscriptionSpecs(state), (event) => {
          if (!state.active) return;
          const outcome = this.applyEvent(state, event, onChange);
          // Per-pane status subscriptions must name the pane, so a new pane means
          // a fresh subscription; debounce so a burst of splits costs one reconnect.
          if (outcome === "new-pane" && !state.resubscribe) {
            state.resubscribe = true;
            setTimeout(() => state.sub?.close(), 250);
          }
        });
        if (!state.active) {
          sub.close();
          return;
        }
        state.sub = sub;
        state.attempt = 0;
        await sub.closed;
        state.sub = undefined;
        if (state.resubscribe && state.active) continue;
      } catch (err) {
        log.debug(`subscription attempt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!state.active) return;
      const delay = Math.min(this.reconnect.minMs * 2 ** state.attempt, this.reconnect.maxMs);
      state.attempt += 1;
      await new Promise<void>((resolve) => {
        state.wake = resolve;
        state.timer = setTimeout(resolve, delay);
      });
      state.wake = undefined;
      state.timer = undefined;
    }
  }

  private async seedPanes(state: SubscriptionState): Promise<void> {
    const response = await this.socket.request("session.snapshot", {});
    if (!response.ok) return;
    const snapshot = (response.result as { snapshot?: { panes?: HerdrPane[]; agents?: HerdrPane[] } } | undefined)?.snapshot;
    for (const pane of snapshot?.panes ?? []) state.panes.set(pane.pane_id, { ...state.panes.get(pane.pane_id), ...pane });
    for (const agent of snapshot?.agents ?? []) state.panes.set(agent.pane_id, { ...state.panes.get(agent.pane_id), ...agent });
  }

  private subscriptionSpecs(state: SubscriptionState): HerdrSubscriptionSpec[] {
    const specs: HerdrSubscriptionSpec[] = [
      { type: "pane.created" },
      { type: "pane.updated" },
      { type: "pane.closed" },
      { type: "pane.exited" },
      { type: "pane.agent_detected" },
    ];
    for (const paneId of state.panes.keys()) specs.push({ type: "pane.agent_status_changed", pane_id: paneId });
    return specs;
  }

  private applyEvent(
    state: SubscriptionState,
    { event, data }: HerdrEventEnvelope,
    onChange: (agent: AgentInfo) => void,
  ): "new-pane" | "changed" | "ignored" {
    const now = this.now();
    const emit = (pane: HerdrPane): void => onChange(paneToAgentInfo(pane, now, pane.name || pane.agent ? "agent" : "pane"));
    const paneId = typeof data["pane_id"] === "string" ? data["pane_id"] : undefined;
    const full = data["pane"] as HerdrPane | undefined;

    switch (event) {
      case "pane_created":
      case "pane_updated": {
        if (!full || typeof full.pane_id !== "string") return "ignored";
        const known = state.panes.has(full.pane_id);
        const merged = { ...state.panes.get(full.pane_id), ...full };
        state.panes.set(full.pane_id, merged);
        emit(merged);
        return known ? "changed" : "new-pane";
      }
      case "pane_closed":
      case "pane_exited": {
        if (!paneId) return "ignored";
        const cached = state.panes.get(paneId);
        const name = cached ? paneToAgentInfo(cached, now).name : paneId;
        onChange({
          ...offlineInfo(paneId, event === "pane_closed" ? "pane closed" : "process exited", now),
          name,
          ...(cached?.foreground_cwd ?? cached?.cwd ? { cwd: (cached?.foreground_cwd ?? cached?.cwd) as string } : {}),
        });
        if (event === "pane_closed") state.panes.delete(paneId);
        return "changed";
      }
      case "pane_agent_detected":
      case "pane.agent_status_changed":
      case "pane_agent_status_changed": {
        if (!paneId) return "ignored";
        const cached = state.panes.get(paneId) ?? { pane_id: paneId };
        const patch: MutablePane = {};
        if ("agent" in data) patch.agent = typeof data["agent"] === "string" ? data["agent"] : null;
        if (typeof data["agent_status"] === "string") patch.agent_status = data["agent_status"];
        if (typeof data["display_agent"] === "string") patch.display_agent = data["display_agent"];
        if (typeof data["title"] === "string") patch.title = data["title"];
        if (typeof data["state_labels"] === "object" && data["state_labels"] !== null) {
          patch.state_labels = data["state_labels"] as Record<string, string>;
        }
        const merged: HerdrPane = { ...cached, ...patch, pane_id: paneId };
        state.panes.set(paneId, merged);
        emit(merged);
        return "changed";
      }
      default:
        return "ignored";
    }
  }
}
