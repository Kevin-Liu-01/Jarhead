import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentInfo, AgentStatus, ConnectorHealth } from "@jarhead/protocol";
import type { AgentConnector, ReadOptions, SendResult, StartOptions } from "../types.ts";
import { agentId, splitAgentId } from "../types.ts";
import { DEFAULT_T3_BASE_URL, T3Client } from "./client.ts";
import type { T3Failure } from "./client.ts";
import type { ModelSelection, OrchestrationProject, OrchestrationReadModel, OrchestrationThread } from "./model.ts";
import { FileT3TokenStore } from "./store.ts";
import type { T3TokenStore } from "./store.ts";

/**
 * T3 Code connector. Ids are `t3:<threadId>`.
 *
 * T3 has no push channel we use yet (its WebSocket speaks Effect RPC), so status
 * comes from polling the read model; the engine's refresh cadence decides how
 * fresh it is.
 */

export interface T3ConnectorOptions {
  readonly client?: T3Client;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly tokenStore?: T3TokenStore;
  /** Where t3.json lives when no tokenStore is given; default ~/.jarhead. */
  readonly stateDir?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
}

/** A turn that finished this recently still reads as "done" rather than "idle". */
export const DONE_WINDOW_MS = 10 * 60 * 1000;

const PENDING_INPUT = /approval|permission|user[-_ ]?input|question|ask[-_ ]?user|input[-_ ]?request|elicitation/i;
const RESOLVED_INPUT = /respond|response|resolved|approved|denied|rejected|answered|cancel/i;

export function parseT3AgentId(id: string): string | undefined {
  const split = splitAgentId(id);
  if (!split || split.kind !== "t3" || split.localId.length === 0) return undefined;
  return split.localId;
}

export interface T3StatusResult {
  readonly status: AgentStatus;
  readonly detail?: string;
}

export function t3ThreadStatus(thread: OrchestrationThread, now: number): T3StatusResult {
  const session = thread.session ?? undefined;
  const turn = thread.latestTurn ?? undefined;

  if (session?.status === "error" || turn?.state === "error") {
    return { status: "unknown", detail: session?.lastError ?? "turn ended in error" };
  }

  const turnRunning = turn?.state === "running";
  const sessionRunning = session?.status === "running" || session?.status === "starting";
  if (turnRunning || sessionRunning) {
    const pending = pendingInputActivity(thread);
    if (pending) return { status: "blocked", detail: pending };
    return { status: "working", ...(session?.status === "starting" ? { detail: "starting" } : {}) };
  }

  if (turn?.state === "completed") {
    const completedAt = turn.completedAt ? Date.parse(turn.completedAt) : Number.NaN;
    if (Number.isFinite(completedAt) && now - completedAt <= DONE_WINDOW_MS) return { status: "done" };
  }
  if (turn?.state === "interrupted") return { status: "idle", detail: "interrupted" };
  return { status: "idle" };
}

/** The newest activity of the current turn, when its kind reads like a question to Kevin. */
function pendingInputActivity(thread: OrchestrationThread): string | undefined {
  const activities = thread.activities ?? [];
  const turnId = thread.latestTurn?.turnId;
  const relevant = activities.filter((a) => turnId === undefined || a.turnId === undefined || a.turnId === null || a.turnId === turnId);
  const latest = relevant[relevant.length - 1];
  if (!latest) return undefined;
  if (!PENDING_INPUT.test(latest.kind) || RESOLVED_INPUT.test(latest.kind)) return undefined;
  return latest.summary?.trim() || `waiting: ${latest.kind}`;
}

export function threadToAgentInfo(thread: OrchestrationThread, project: OrchestrationProject | undefined, now: number): AgentInfo {
  const { status, detail } = t3ThreadStatus(thread, now);
  const title = thread.title.trim() || "untitled";
  const name = project ? `${project.title} / ${title}` : title;
  const cwd = thread.worktreePath ?? project?.workspaceRoot ?? undefined;
  const updated = thread.updatedAt ? Date.parse(thread.updatedAt) : Number.NaN;
  return {
    id: agentId("t3", thread.id),
    kind: "t3",
    name,
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    updatedAt: Number.isFinite(updated) ? updated : now,
  };
}

export function liveThreads(model: OrchestrationReadModel): OrchestrationThread[] {
  return model.threads.filter((t) => !t.deletedAt && !t.archivedAt);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function describe(error: T3Failure): string {
  return error.detail;
}

function firstLine(text: string, max = 60): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export class T3Connector implements AgentConnector {
  readonly kind = "t3" as const;
  readonly client: T3Client;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;

  constructor(opts: T3ConnectorOptions = {}) {
    this.client =
      opts.client ??
      new T3Client({
        baseUrl: opts.baseUrl ?? DEFAULT_T3_BASE_URL,
        tokenStore: opts.tokenStore ?? FileT3TokenStore.inStateDir(opts.stateDir ?? join(homedir(), ".jarhead")),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? 1_500;
  }

  private threadId(id: string): string {
    const threadId = parseT3AgentId(id);
    if (!threadId) throw new TypeError(`not a T3 agent id: ${id}`);
    return threadId;
  }

  async health(): Promise<ConnectorHealth> {
    const host = hostOf(this.client.baseUrl);
    const env = await this.client.environment();
    if (!env.ok) return { kind: "t3", ok: false, detail: `T3 Code not reachable at ${host} (${describe(env.error)})` };

    const notPaired = `running at ${host} but not paired — run \`jarhead t3 pair <url>\``;
    const token = await this.client.tokenStore.load();
    if (!token) return { kind: "t3", ok: false, detail: notPaired };

    const session = await this.client.sessionState();
    if (!session.ok) {
      if (session.error.kind === "unauthenticated") return { kind: "t3", ok: false, detail: notPaired };
      return { kind: "t3", ok: false, detail: `T3 Code at ${host}: ${describe(session.error)}` };
    }
    if (!session.value.authenticated) return { kind: "t3", ok: false, detail: `${notPaired} (token no longer accepted)` };

    const shell = await this.client.shellSnapshot();
    const count = shell.ok ? `, ${liveThreads(shell.value).length} threads` : "";
    return { kind: "t3", ok: true, detail: `paired as ${token.label ?? "Jarhead"}${count} (${env.value.label}, v${env.value.serverVersion})` };
  }

  async list(): Promise<AgentInfo[]> {
    const snapshot = await this.client.snapshot();
    if (!snapshot.ok) return [];
    const now = this.now();
    const projects = new Map(snapshot.value.projects.map((p) => [p.id, p] as const));
    return liveThreads(snapshot.value)
      .map((thread) => threadToAgentInfo(thread, projects.get(thread.projectId), now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** A turn inherits the thread's own mode and model so voice never silently escalates permissions. */
  async send(id: string, text: string): Promise<SendResult> {
    const threadId = this.threadId(id);
    const thread = await this.client.thread(threadId, { turnLimit: 1 });
    if (!thread.ok) return { accepted: false, detail: describe(thread.error) };
    const t = thread.value;
    const res = await this.client.startTurn({
      threadId,
      text,
      ...(t.runtimeMode ? { runtimeMode: t.runtimeMode } : {}),
      ...(t.interactionMode ? { interactionMode: t.interactionMode } : {}),
      ...(t.modelSelection ? { modelSelection: t.modelSelection } : {}),
    });
    if (!res.ok) return { accepted: false, detail: describe(res.error) };
    return { accepted: true, detail: `turn started (sequence ${res.value.sequence})` };
  }

  async read(id: string, _opts?: ReadOptions): Promise<string> {
    const threadId = this.threadId(id);
    const thread = await this.client.thread(threadId);
    if (!thread.ok) {
      if (thread.error.kind === "http" && thread.error.status === 404) throw new Error(`T3 thread not found: ${threadId}`);
      return "";
    }
    const messages = thread.value.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "assistant" && m.text.trim().length > 0) return m.text.trimEnd();
    }
    return "";
  }

  async start(opts: StartOptions): Promise<AgentInfo> {
    const shell = await this.client.shellSnapshot();
    if (!shell.ok) return this.unavailable(describe(shell.error));
    const projects = shell.value.projects.filter((p) => !p.deletedAt);
    const project = opts.projectId ? projects.find((p) => p.id === opts.projectId) : projects[0];
    if (!project) {
      throw new Error(opts.projectId ? `T3 project not found: ${opts.projectId}` : "T3 Code has no projects to start a thread in");
    }

    const title = opts.name?.trim() || (opts.prompt ? firstLine(opts.prompt) : "") || "Jarhead thread";
    const modelSelection = pickModel(project, shell.value.threads);
    const created = await this.client.createThread({ projectId: project.id, title, modelSelection, runtimeMode: "approval-required" });
    if (!created.ok) return this.unavailable(describe(created.error));

    const id = agentId("t3", created.value.threadId);
    const cwd = project.workspaceRoot;
    let status: AgentStatus = "idle";
    let detail: string | undefined;
    if (opts.prompt) {
      const turn = await this.client.startTurn({ threadId: created.value.threadId, text: opts.prompt, runtimeMode: "approval-required", modelSelection });
      if (turn.ok) status = "working";
      else detail = `prompt not sent: ${describe(turn.error)}`;
    }
    return { id, kind: "t3", name: `${project.title} / ${title}`, status, ...(detail ? { detail } : {}), cwd, updatedAt: this.now() };
  }

  async waitSettled(id: string, timeoutMs: number): Promise<AgentInfo> {
    const threadId = this.threadId(id);
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const thread = await this.client.thread(threadId, { turnLimit: 1 });
      if (!thread.ok) return this.unavailable(describe(thread.error), threadId);
      const info = threadToAgentInfo(thread.value, undefined, this.now());
      const remaining = deadline - this.now();
      if (info.status !== "working" || remaining <= 0) return info;
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }

  async interrupt(id: string): Promise<void> {
    const threadId = this.threadId(id);
    const thread = await this.client.thread(threadId, { turnLimit: 1 });
    const turn = thread.ok ? thread.value.latestTurn : undefined;
    const turnId = turn && turn.state === "running" ? turn.turnId : undefined;
    const res = await this.client.interrupt(threadId, turnId);
    if (!res.ok && res.error.kind === "http") throw new Error(`T3 interrupt failed: ${res.error.detail}`);
  }

  private unavailable(detail: string, threadId = "unavailable"): AgentInfo {
    return { id: agentId("t3", threadId), kind: "t3", name: "T3 Code", status: "offline", detail, updatedAt: this.now() };
  }
}

/** Project default, else whatever its existing threads use, else T3's Claude provider. */
function pickModel(project: OrchestrationProject, threads: readonly OrchestrationThread[]): ModelSelection {
  if (project.defaultModelSelection) return project.defaultModelSelection;
  const sibling = [...threads]
    .filter((t) => t.projectId === project.id && t.modelSelection && !t.deletedAt)
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))[0];
  if (sibling?.modelSelection) return sibling.modelSelection;
  return { instanceId: "claudeAgent", model: "claude-fable-5" };
}
