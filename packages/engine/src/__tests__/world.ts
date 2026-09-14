import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession, SessionConfig } from "@jarhead/live";
import type { Brain, BrainResult, BrainSink, BrainTask, ToolRunner } from "@jarhead/brain";
import { FAKE_ACTING_OPS, HANDS_BUSY_PREFIX, KEVIN_QUIET_MS, NativeRequestError, USER_IDLE_NONE_MS, type NativeHands, type UserIdle } from "@jarhead/hands";
import type { AgentConnector, SendResult, TranscriptDelta, TranscriptOptions, TranscriptPage } from "@jarhead/agents";
import type { AgentInfo, AgentMessage, ConnectorHealth, EngineEvent, LedgerRow, LocalModel, LocalServerStatus, MemoryItem, MemoryKind, MemoryOrigin, MemoryState, MemorySummary, OverlayCommand } from "@jarhead/protocol";
import type { Exec } from "@jarhead/cli/install";
import type { IngestOptions, IngestResult, RememberResult, Rendered } from "@jarhead/memory";
import { Engine, type EngineOptions } from "../engine.ts";
import type { MemoryServiceLike } from "../memory-bridge.ts";
import type { ThreadBrainFactory } from "../threads/index.ts";

/**
 * A stand-in world for engine tests: a fake Live session per wake (records the
 * config it was opened with, instructions, mutes; emits what a real one would;
 * closes once, or hangs on close when told to), two sets of hands — the acting
 * helper and the reading one — that answer every op with a canned result and
 * record the ops (a held op can be released later; Kevin's own key or click makes
 * an acting op answer `busy`, as the helper does), a main brain that attaches the
 * runner and holds its task until the abort signal or the test resolves it, a
 * thread-brain factory (`makeThreadBrain`) whose brains a test scripts — one per
 * spawned thread, the spares included — and a clock the test moves by hand.
 */

export class FakeLive extends EventEmitter {
  instructions: string[] = [];
  commentary: string[] = [];
  mutes: string[] = [];
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  /** The config the engine opened this session with (instructions, voice, delegation). */
  config: SessionConfig | undefined;
  nowMs = 1000;
  audioIn = 0;
  /** What the server has billed so far (a `usage` emit updates it; the closed event carries it). */
  usage = 0;
  closes = 0;
  terminates = 0;
  closedEmitted = false;
  /** The server never answers `session.close`: close() leaves the session closing. The engine's deadline / watchdog must end it. */
  hangOnClose = false;
  /** The server refuses the socket: start() reports `closed("connection_lost")` and rejects, as the real session does when the socket closes before `session.started`. */
  failStart = false;
  constructor(readonly id = "sess_1") {
    super();
  }
  async start(): Promise<{ id: string; expires_at: number }> {
    if (this.failStart) {
      // Same order as LiveSession's onclose: state closed, `closed` emitted, then the start rejects.
      this.finish("connection_lost");
      throw new Error("live socket closed before start (code 1000)");
    }
    this.currentState = "started";
    this.session = { id: this.id, expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
  }
  get billedSeconds(): number {
    return this.usage;
  }
  /** `session.usage.updated`: the meter moved. */
  reportUsage(seconds: number): void {
    this.usage = seconds;
    this.emit("usage", seconds, undefined);
  }
  appendInstructions(_id: string | null, content: string): string {
    this.instructions.push(content);
    return "i";
  }
  appendThinking(): string {
    return "t";
  }
  appendCommentary(_id: string | null, content: string): string {
    this.commentary.push(content);
    return "c";
  }
  appendAudio(): void {
    this.audioIn++;
  }
  mute(): string {
    this.mutes.push("mute");
    return "m";
  }
  unmute(): string {
    this.mutes.push("unmute");
    return "u";
  }
  createResponseItem(): void {}
  createResponse(): void {}
  /** A graceful close: the server answers at once (unless `hangOnClose`). */
  close(): void {
    this.closes++;
    if (this.currentState === "closed") return;
    if (this.hangOnClose) {
      this.currentState = "closing";
      return;
    }
    this.finish("client_closed");
  }
  /** The socket dropped now; `closed` fires once whatever came before. */
  terminate(): void {
    this.terminates++;
    this.finish("client_closed");
  }
  /** The server ended the session (expired, connection_lost, …) with a final usage figure. */
  serverClosed(reason: string, usage = this.usage): void {
    this.usage = usage;
    this.finish(reason);
  }
  private finish(reason: string): void {
    this.currentState = "closed";
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit("closed", reason, this.usage);
  }
}

/**
 * Hands with canned answers; `hold` names an op to keep in flight until `release()`.
 * Kevin's hands win here as in the helper: after `kevinActed()` every acting op within
 * KEVIN_QUIET_MS answers `busy` (nothing posted) unless the op says `ownDriver`;
 * `user_idle` reports the same clock. `focus_app` / `open_app` change `frontApp`.
 */
/** The one screen both helpers look at: the front app, the focused field, the front window's labels. */
interface FakeScreen {
  frontApp: string;
  secure: boolean;
  focusedRole: string;
  labels: string[];
}

export class RecordingHands implements NativeHands {
  ready = true;
  ops: { op: string; params: Record<string, unknown>; at: number }[] = [];
  /** The acting ops that landed (a `busy` refusal is in `ops`, never here). */
  posted: { op: string; params: Record<string, unknown>; at: number }[] = [];
  hold: string | undefined;
  private release_: (() => void) | undefined;
  /**
   * What the helper sees. Two helpers share ONE screen (`shareScreenWith`, as the real ones share the
   * Mac): a front app set on the acting helper is what a read routed to the reading helper answers
   * (SplitHands sends the gate's `frontmost`, `find_element`, `focused_text` there), and an `open_app`
   * on either fronts the app for both.
   */
  private screen: FakeScreen = { frontApp: "Notes", secure: false, focusedRole: "AXTextField", labels: ["Save", "Cancel", "Send", "Add Folder"] };
  get frontApp(): string {
    return this.screen.frontApp;
  }
  set frontApp(app: string) {
    this.screen.frontApp = app;
  }
  get secure(): boolean {
    return this.screen.secure;
  }
  set secure(v: boolean) {
    this.screen.secure = v;
  }
  /** What focused_text says the focus is (a text field by default; "AXGroup" for a terminal or a canvas). */
  get focusedRole(): string {
    return this.screen.focusedRole;
  }
  set focusedRole(role: string) {
    this.screen.focusedRole = role;
  }
  /** What find_element answers: the labels on the "front window". */
  get labels(): string[] {
    return this.screen.labels;
  }
  set labels(labels: string[]) {
    this.screen.labels = labels;
  }
  /** Look at the same screen as `other` (the world links the acting and the reading helper). */
  shareScreenWith(other: RecordingHands): void {
    this.screen = other.screen;
  }
  now: () => number = Date.now;
  /** When Kevin last pressed a key, clicked or scrolled (never Jarhead's own posts); undefined = never. */
  kevinAt: number | undefined;
  /** The helper's busy check on acting ops (off to play a helper built before it). */
  busyCheck = true;

  /** Kevin used the keyboard or mouse (now, or at `at`). */
  kevinActed(at?: number): void {
    this.kevinAt = at ?? this.now();
  }

  /** What `user_idle` answers right now. */
  get userIdle(): UserIdle {
    const foreignMs = this.kevinAt === undefined ? USER_IDLE_NONE_MS : Math.max(0, this.now() - this.kevinAt);
    return { keyMs: foreignMs, clickMs: foreignMs, scrollMs: USER_IDLE_NONE_MS, moveMs: foreignMs, foreignMs };
  }

  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const at = this.now();
    this.ops.push({ op, params, at });
    if (this.hold === op && this.release_ === undefined) await new Promise<void>((r) => (this.release_ = r));
    if (FAKE_ACTING_OPS.has(op)) {
      // As the helper does, before its first CGEvent.post: Kevin's hands on the machine → nothing is posted.
      if (this.busyCheck && params["ownDriver"] !== true && this.kevinAt !== undefined) {
        const ms = this.now() - this.kevinAt;
        if (ms < KEVIN_QUIET_MS) throw new NativeRequestError({ code: "busy", message: `${HANDS_BUSY_PREFIX} ${Math.max(0, Math.round(ms))} ms ago; nothing was posted` });
      }
      this.posted.push({ op, params, at });
    }
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "user_idle":
        return this.userIdle as T;
      case "frontmost":
        return { app: this.frontApp, pid: 1, window: { title: "Untitled", x: 100, y: 100, w: 800, h: 600, windowId: 1 } } as T;
      case "focus_app":
      case "open_app": {
        const name = String(params["name"] ?? params["app"] ?? "");
        if (name && (op === "focus_app" || params["activate"] !== false)) this.frontApp = name;
        return { pid: 1, app: name || this.frontApp } as T;
      }
      case "cursor":
        return { x: 400, y: 300 } as T;
      case "element_at": {
        // A small element around the point asked (the Save button's label at the cursor, or inside the control click_element found).
        const x = Number(params["x"] ?? 400);
        const y = Number(params["y"] ?? 300);
        return { role: "AXButton", title: "Save", frame: { x: x - 20, y: y - 10, w: 40, h: 20 }, app: this.frontApp } as T;
      }
      case "focused_text":
        return { role: this.focusedRole, secure: this.secure, app: this.frontApp, frame: { x: 200, y: 200, w: 300, h: 24 } } as T;
      case "screenshot":
        return { displayId: 1, pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", width: 1280, height: 828, points: { x: 0, y: 0, w: 1728, h: 1117 }, scale: 1280 / 1728 } as T;
      case "ax_tree":
        return { app: this.frontApp, pid: 1, window: "Untitled", count: this.labels.length, cached: true, ageMs: 1, treeMs: 3, truncated: false } as T;
      case "find_element": {
        const name = String(params["name"] ?? "").toLowerCase();
        const hits = this.labels.filter((l) => l.toLowerCase() === name);
        const el = hits[0] ? { i: 1, depth: 2, role: "AXButton", title: hits[0], app: this.frontApp, score: 1, label: hits[0], x: 500, y: 400, w: 60, h: 24, center: { x: 530, y: 412 }, pressable: true } : undefined;
        return { app: this.frontApp, window: "Untitled", found: hits.length > 0, unique: hits.length === 1, candidates: hits.length, tier: hits.length ? "exact" : "none", ...(el ? { element: el } : {}), cached: true, treeMs: 3, nodes: 10, truncated: false, ms: 1 } as T;
      }
      case "windows":
        return { windows: [] } as T;
      default:
        return {} as T;
    }
  }
  release(): void {
    this.release_?.();
    this.release_ = undefined;
  }
  named(op: string): { op: string; params: Record<string, unknown>; at: number }[] {
    return this.ops.filter((o) => o.op === op);
  }
}

/**
 * A sessions connector with scripted pages: what `transcript()` answers per agent (the
 * newest page, and the older page a `before` asks for), what `settle()` says the
 * process left running, and every tail it was asked for. A test drives it: `emitDelta`
 * appends turns, `endTail` ends a follow with a reason, `change` moves an agent's
 * status through the registry's subscription, `gone` retires it.
 */
export class FakeConnector implements AgentConnector {
  readonly kind = "sessions" as const;
  agents: AgentInfo[] = [];
  /** The newest page per agent (`transcript()` without `before`). */
  pages = new Map<string, TranscriptPage>();
  /** The older page per agent (`transcript({ before })`). */
  history = new Map<string, TranscriptPage>();
  /** What `settle()` answers: the calls left running, as interrupted. */
  interrupted = new Map<string, AgentMessage[]>();
  transcriptCalls: { agentId: string; opts: TranscriptOptions | undefined }[] = [];
  watches: { agentId: string; onDelta: (d: TranscriptDelta) => void; onEnd: ((reason: string) => void) | undefined; stopped: boolean }[] = [];
  /** Agents whose tail cannot start: `watch()` calls onEnd("gone") synchronously. */
  failWatch = new Set<string>();
  settles = 0;
  private onChange: ((agent: AgentInfo) => void) | undefined;
  private onGone: ((agentId: string) => void) | undefined;

  async health(): Promise<ConnectorHealth> {
    return { kind: "sessions", ok: true, detail: "fake" };
  }
  async list(): Promise<AgentInfo[]> {
    return this.agents;
  }
  async send(): Promise<SendResult> {
    return { accepted: false, detail: "fake" };
  }
  async read(): Promise<string> {
    return "";
  }
  subscribe(onChange: (agent: AgentInfo) => void, onGone?: (agentId: string) => void): () => void {
    this.onChange = onChange;
    this.onGone = onGone;
    return () => {
      this.onChange = undefined;
      this.onGone = undefined;
    };
  }
  async transcript(agentId: string, opts?: TranscriptOptions): Promise<TranscriptPage> {
    this.transcriptCalls.push({ agentId, opts });
    const page = opts?.before !== undefined ? this.history.get(agentId) : this.pages.get(agentId);
    if (!page) throw new Error(`no transcript for ${agentId}`);
    return page;
  }
  watch(agentId: string, onDelta: (delta: TranscriptDelta) => void, onEnd?: (reason: string) => void): () => void {
    const w = { agentId, onDelta, onEnd, stopped: false };
    this.watches.push(w);
    if (this.failWatch.has(agentId)) {
      w.stopped = true;
      onEnd?.("gone");
    }
    return () => {
      w.stopped = true;
    };
  }
  async settle(agentId: string): Promise<TranscriptDelta | undefined> {
    this.settles++;
    const messages = this.interrupted.get(agentId);
    return messages ? { messages, total: this.pages.get(agentId)?.total ?? messages.length } : undefined;
  }

  // ---- drivers
  liveTails(agentId?: string): typeof this.watches {
    return this.watches.filter((w) => !w.stopped && (agentId === undefined || w.agentId === agentId));
  }
  emitDelta(agentId: string, messages: AgentMessage[], total = messages.length): void {
    for (const w of this.liveTails(agentId)) w.onDelta({ messages, total });
  }
  endTail(agentId: string, reason: "gone" | "replaced" | "truncated" | string): void {
    for (const w of this.liveTails(agentId)) {
      w.stopped = true;
      w.onEnd?.(reason);
    }
  }
  /** An agent's status moved (the poll's word), through the registry's subscription. */
  change(agent: AgentInfo): void {
    this.agents = [...this.agents.filter((a) => a.id !== agent.id), agent];
    this.onChange?.(agent);
  }
  gone(agentId: string): void {
    this.agents = this.agents.filter((a) => a.id !== agentId);
    this.onGone?.(agentId);
  }
}

/** One agent for the fake connector's listing. */
export function fakeAgent(id: string, status: AgentInfo["status"], extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, kind: "sessions", tool: "codex", name: id.split(":").pop() ?? id, status, updatedAt: 1, ...extra };
}

/** One message for a scripted page. */
export function fakeMessage(id: string, role: AgentMessage["role"], text: string, tool?: AgentMessage["tool"]): AgentMessage {
  return { id, role, text, at: 1, ...(tool ? { tool } : {}) };
}

/**
 * The memory module as the engine's bridge sees it (`MemoryServiceLike` in
 * memory-bridge.ts — the public surface of packages/memory's MemoryService), in memory
 * and scripted: what the blocks say, whether retrieval hangs, how often a run defers; and
 * every call recorded — `ingested` (with the rows it was handed, how many were Kevin's
 * lines, and whether it was forced), `retrievals`, `primed`, `embeds` (a retrieval, a run
 * or a remember each count as one embedding call, so "memory off → 0 embedding calls" is
 * a number). `onRow` lands the audit rows in the world's ledger, as the real service's
 * does through the bridge. No world test ever builds the real service: with the package
 * linked it would embed and extract over Kevin's key.
 */
export class FakeMemoryService implements MemoryServiceLike {
  items: MemoryItem[] = [];
  ingested: string[] = [];
  ingestCalls: { sessionId: string; rows: number; kevinLines: number; opts: IngestOptions }[] = [];
  retrievals: string[] = [];
  voiceRetrievals = 0;
  primed: string[] = [];
  embeds = 0;
  consolidations = 0;
  forgets: { ms: number | undefined; sessionId: string | undefined }[] = [];
  /** What the brain block says; undefined = render from `items` (undefined text when empty). */
  brainText: string | undefined;
  /** What the voice block says; undefined = render from `items`. */
  voiceText: string | undefined;
  /** `retrieveForBrain` never answers (the race must bound it). */
  hangRetrieve = false;
  /** A run answers `deferred` this many times before it lands (the real service's DEFER_MAX_TRIES then lands by words). */
  deferTries = 0;
  ingestResult: Omit<IngestResult, "status"> = { extractor: "rules", added: 1, updated: 0, noop: 0, refused: 0, ms: 3 };
  watermarks = new Map<string, number>();
  onRow: ((row: LedgerRow) => void) | undefined;
  readonly store = { watermark: (sessionId: string): { upToAt: number } | undefined => (this.watermarks.has(sessionId) ? { upToAt: this.watermarks.get(sessionId)! } : undefined) };
  private readonly deferred = new Map<string, number>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private row(row: LedgerRow): void {
    this.onRow?.(row);
  }
  private live(): MemoryItem[] {
    return this.items.filter((i) => i.state === "live");
  }
  private static tokens(text: string): number {
    return Math.ceil(text.length / 3.2);
  }

  async ingestSession(sessionId: string, rows: readonly LedgerRow[], opts: IngestOptions = {}): Promise<IngestResult> {
    this.ingested.push(sessionId);
    this.ingestCalls.push({ sessionId, rows: rows.length, kevinLines: rows.filter((r) => r.type === "heard").length, opts });
    this.embeds++;
    const tries = (this.deferred.get(sessionId) ?? 0) + 1;
    if (tries <= this.deferTries) {
      this.deferred.set(sessionId, tries);
      return { ...this.ingestResult, status: "deferred", reason: "embedding-failed", tries };
    }
    this.deferred.delete(sessionId);
    this.watermarks.set(sessionId, this.now());
    const r = this.ingestResult;
    this.row({ at: this.now(), type: "memory.run", sessionId, extractor: r.extractor ?? "rules", added: r.added, updated: r.updated, noop: r.noop, refused: r.refused, ms: r.ms });
    return { ...r, status: "ran" };
  }
  async prime(text: string): Promise<void> {
    this.primed.push(text);
  }
  async remember(text: string, kind: MemoryKind = "preference", origin: MemoryOrigin = "kevin"): Promise<RememberResult | undefined> {
    this.embeds++;
    // The refusal shapes the real store applies: a secret shape, a password, the redactor's mark.
    if (/\[redacted secret\]|password|\b\d{3}-\d{2}-\d{4}\b/i.test(text) || text.trim().length < 3) return undefined;
    const at = this.now();
    const sentence = text
      .trim()
      .replace(/^i prefer\b/i, "Kevin prefers")
      .replace(/^i like\b/i, "Kevin likes")
      .replace(/^my\b/i, "Kevin's")
      .replace(/[.!?]+$/, "");
    const twin = this.live().find((i) => i.text === sentence);
    if (twin) return { item: twin, op: "noop" };
    const item: MemoryItem = { id: `m_${++this.seq}`, kind, text: sentence, subjects: [], confidence: 0.9, importance: 0.9, createdAt: at, lastSeenAt: at, seenCount: 1, sources: [{ at, type: origin === "kevin" ? "kevin" : "heard" }], state: "live", origin };
    this.items.push(item);
    this.row({ at, type: "memory.added", id: item.id, kind, origin });
    return { item, op: "added" };
  }
  forgetRecent(ms: number = 600_000, sessionId?: string): number {
    this.forgets.push({ ms, sessionId });
    const since = this.now() - ms;
    let n = 0;
    this.items = this.items.map((i) => {
      if (i.state !== "live" || !i.sources.some((s) => s.at >= since)) return i;
      n++;
      this.row({ at: this.now(), type: "memory.forgotten", id: i.id, by: "reflex" });
      return { ...i, state: "forgotten" as const };
    });
    return n;
  }
  forget(id: string, by: "kevin" | "reflex" | "cli"): boolean {
    const i = this.items.findIndex((x) => x.id === id && x.state === "live");
    if (i < 0) return false;
    this.items[i] = { ...this.items[i]!, state: "forgotten" };
    this.row({ at: this.now(), type: "memory.forgotten", id, by });
    return true;
  }
  restore(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id && x.state !== "live");
    if (i < 0) return false;
    this.items[i] = { ...this.items[i]!, state: "live" };
    this.row({ at: this.now(), type: "memory.restored", id });
    return true;
  }
  edit(id: string, text: string, kind?: MemoryKind): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items[i] = { ...this.items[i]!, text, ...(kind ? { kind } : {}) };
    this.row({ at: this.now(), type: "memory.updated", id });
    return true;
  }
  retrieveForBrain(query: string): Promise<Rendered> {
    this.retrievals.push(query);
    this.embeds++;
    if (this.hangRetrieve) return new Promise(() => undefined);
    const picked = this.live();
    const text = this.brainText ?? (picked.length ? picked.map((i) => `- ${i.text}`).join("\n") : undefined);
    return Promise.resolve({ ...(text ? { text } : {}), tokens: text ? FakeMemoryService.tokens(text) : 0, ids: picked.map((i) => i.id) });
  }
  retrieveForVoice(): Rendered {
    this.voiceRetrievals++;
    const picked = this.live();
    const text = this.voiceText ?? (picked.length ? `# Kevin, in brief\n${picked.map((i) => `${i.text}.`).join(" ")}\nUse this quietly; never announce that you remember it.` : undefined);
    return { ...(text ? { text } : {}), tokens: text ? FakeMemoryService.tokens(text) : 0, ids: picked.map((i) => i.id) };
  }
  list(state: MemoryState | "all" = "live", limit = 50): MemoryItem[] {
    return this.items.filter((i) => state === "all" || i.state === state).slice(0, limit);
  }
  async search(query: string, limit = 30): Promise<MemoryItem[]> {
    const q = query.toLowerCase();
    return this.items.filter((i) => i.text.toLowerCase().includes(q)).slice(0, limit);
  }
  summary(): Omit<MemorySummary, "enabled" | "pending"> {
    return {
      count: this.live().length,
      forgotten: this.items.filter((i) => i.state === "forgotten").length,
      archived: this.items.filter((i) => i.state === "archived").length,
      embeddings: "keyword",
    };
  }
  async consolidateStep(): Promise<{ merged: number; archived: number; done: boolean }> {
    this.consolidations++;
    return { merged: 0, archived: 0, done: true };
  }
  /** Keywords only: nothing to re-embed, ever. */
  async reembed(): Promise<number> {
    this.reembeds++;
    return 0;
  }
  reembeds = 0;
  flush(): void {}
}

// ---- the local model server, faked ----------------------------------------------------------
// `EngineOptions.discoverLocal` answers discovery from a scripted status; the brain and memory
// still talk to a server, so a tiny HTTP stand-in answers the reads the daemon makes of Ollama
// (/v1/models for the compatible probe, /api/generate for warm-up and cool, /api/chat is never
// reached in these tests, /api/embed and /v1/chat/completions for memory). Anything else is
// recorded as a violation — the never-writes pin, as the brain's own tests keep it.

const GIB = 1024 ** 3;

/** One tool-capable, vision-capable Ollama model as discovery would list it (17 GB, 256k trained). */
export function localModel(id: string, over: Partial<LocalModel> = {}): LocalModel {
  return { id, capabilities: ["completion", "tools", "vision", "thinking"], sizeBytes: 17e9, contextLength: 262_144, family: "qwen35", parameterSize: "27B", modifiedAt: 1_757_000_000_000, fit: "good", loaded: false, cloud: false, ...over };
}

/** A reachable Ollama at `baseUrl` with these models (checkedAt now, so the brain reuses the engine's look instead of discovering again). */
export function localStatus(baseUrl: string, models: readonly LocalModel[], over: Partial<LocalServerStatus> = {}): LocalServerStatus {
  return { reachable: true, flavor: "ollama", version: "0.34.0", baseUrl, models, ramBytes: 128 * GIB, checkedAt: Date.now(), ...over };
}

/** Nothing answering on this Mac. */
export function localNone(over: Partial<LocalServerStatus> = {}): LocalServerStatus {
  return { reachable: false, baseUrl: "", models: [], ramBytes: 128 * GIB, checkedAt: Date.now(), ...over };
}

export interface FakeLocalRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeLocalServer {
  url: string;
  /** Every request, in order. */
  seen: FakeLocalRequest[];
  /** Requests outside the never-writes allowlist (pull, delete, create, copy, push, download, load). */
  violations: string[];
  /** The model ids /v1/models lists. */
  models: string[];
  /** What POST /api/embed answers: a unit vector of `dims` per input (0 = answer 404, "not pulled"). */
  embedDims: number;
  /** What POST /v1/chat/completions answers as `choices[0].message.content` (an extractor's JSON), or a status. */
  chat: { status: number; content: string };
  close(): Promise<void>;
}

const LOCAL_READS: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/api/version" },
  { method: "GET", path: "/api/tags" },
  { method: "POST", path: "/api/show" },
  { method: "GET", path: "/api/ps" },
  { method: "GET", path: "/v1/models" },
  { method: "POST", path: "/api/chat" },
  { method: "POST", path: "/api/generate" },
  { method: "POST", path: "/api/embed" },
  { method: "POST", path: "/v1/chat/completions" },
  { method: "POST", path: "/v1/embeddings" },
  { method: "GET", path: "/api/v0/models" },
  { method: "GET", path: "/health" },
  { method: "GET", path: "/props" },
];

export async function fakeLocalServer(models: readonly string[] = ["qwen3.5:27b"]): Promise<FakeLocalServer> {
  const fake: FakeLocalServer = { url: "", seen: [], violations: [], models: [...models], embedDims: 768, chat: { status: 200, content: JSON.stringify({ items: [] }) }, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const method = req.method ?? "";
      const path = (req.url ?? "").split("?")[0] ?? "";
      fake.seen.push({ method, path, body });
      const answer = (status: number, json: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (!LOCAL_READS.some((a) => a.method === method && a.path === path) || (path === "/api/generate" && (typeof body !== "object" || body === null || !("keep_alive" in body) || "prompt" in body))) {
        fake.violations.push(`${method} ${path}`);
        return answer(500, { error: `never-writes: ${method} ${path}` });
      }
      if (path === "/api/version") return answer(200, { version: "0.34.0" });
      if (path === "/v1/models") return answer(200, { object: "list", data: fake.models.map((id) => ({ id, object: "model", owned_by: "library" })) });
      if (path === "/api/generate") return answer(200, { model: (body as { model?: string }).model, done: true, done_reason: (body as { keep_alive?: unknown }).keep_alive === 0 ? "unload" : "load" });
      if (path === "/api/embed") {
        if (fake.embedDims === 0) return answer(404, { error: `model '${(body as { model?: string }).model}' not found` });
        const input = (body as { input: string[] }).input;
        return answer(200, { model: (body as { model?: string }).model, embeddings: input.map((_, i) => Array.from({ length: fake.embedDims }, (_x, k) => (k === i % fake.embedDims ? 1 : 0.0001 * (i + 1)))) });
      }
      if (path === "/v1/chat/completions") {
        if (fake.chat.status !== 200) return answer(fake.chat.status, { error: { message: "no" } });
        return answer(200, { id: "c1", object: "chat.completion", model: (body as { model?: string }).model, choices: [{ index: 0, message: { role: "assistant", content: fake.chat.content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      return answer(404, { error: `no fake for ${method} ${path}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}

export interface BrainState {
  cancels: number;
  /** ms the brain's cancel takes to settle. */
  cancelDelayMs: number;
  resolve: ((r: BrainResult) => void) | undefined;
  tasks: BrainTask[];
}

/** One thread's fake brain: what it was asked, what it was told, how often it was cancelled and stopped. */
export interface FakeThreadBrain {
  readonly id: string;
  /** The thread's name, read from the brief in its first task's dialogue ("Jarhead (to its thread Spotify): …"). */
  name: string;
  readonly runner: ToolRunner;
  tasks: BrainTask[];
  sink: BrainSink | undefined;
  started: number;
  cancels: number;
  stops: number;
  /** Settle the current turn (the runner is detached first, as a real brain does at the end of a turn). */
  resolve: ((r: BrainResult) => void) | undefined;
}

/** What a scripted thread turn sees. Return a result to finish the turn; return undefined to hold it for `brain.resolve`. */
export interface ThreadJob {
  readonly brain: FakeThreadBrain;
  readonly task: BrainTask;
  readonly sink: BrainSink;
  /** The thread's own lane runner: `runner.run("type", …)` goes through its lane's rules. */
  readonly runner: ToolRunner;
}

export interface ThreadWorld {
  /** Every thread brain the engine built, in order (the spares included). */
  brains: FakeThreadBrain[];
  /** What a thread does when a turn starts; absent, the turn holds until the test resolves it. Called for every turn (a follow-up, a confirmation, a continuation). */
  script: ((job: ThreadJob) => Promise<BrainResult | undefined>) | undefined;
  /** What a thread brain's `start()` answers (default: ready at once); a test makes a spare's boot hang or fail. Set before the wake that warms the spares. */
  startResult: ((brain: FakeThreadBrain) => Promise<{ ready: boolean; detail: string }>) | undefined;
  /** The brain of the thread named `name` (the first task tells a brain its name). */
  byName(name: string): FakeThreadBrain | undefined;
}

/** The thread's name from the brief a task carries (`threadBrief` opens with it); a test that names the delegation `<liveId>/<name>` is read too. */
export function threadNameOf(task: BrainTask): string | undefined {
  const m = /^Jarhead \(to its thread ([^)]+)\)/.exec(task.dialogue);
  if (m?.[1]) return m[1];
  const tail = task.delegationId.split("/").pop();
  return tail && !/^dlg_/.test(tail) ? tail : undefined;
}

export interface World {
  engine: Engine;
  /** The first session's Live (the one a single-wake test talks to). */
  live: FakeLive;
  /** Every session the engine opened, in order; a resume or a re-wake appends one. `lives.at(-1)` is the current. */
  lives: FakeLive[];
  /** The acting helper: the main brain's, dictation's and screen-lane threads' ops. */
  hands: RecordingHands;
  /** The reading helper: the AX warm tick, ear hints, the wake shot, `user_idle`, background threads' ops. */
  handsBg: RecordingHands;
  events: EngineEvent[];
  overlays: OverlayCommand[];
  audio: Buffer[];
  brain: BrainState;
  /** The spawned threads' fake brains. */
  threads: ThreadWorld;
  /** The memory module's stand-in the engine was built over (undefined when a test injected its own seams). */
  memory: FakeMemoryService | undefined;
  clock: { t: number };
  dir: string;
}

/**
 * `where.dir` reuses another world's state dir (its ledger, its settings) — a second engine
 * over the same day. `where.firstSessionId` names that engine's first FakeLive (default
 * `sess_1`), so two engines over one ledger do not write the same session id twice.
 * `where.oneHands` gives both helpers the same RecordingHands (a test that patches
 * `hands.request` and does not care which helper answered).
 */
/** No shell: the engine's own shell-outs (the Dock read) answer "not found" unless a test scripts `exec`, so no test ever reads Kevin's Dock. Every `new Engine` in a test passes it. */
export const noShell: Exec = () => ({ code: 127, stdout: "", stderr: "no shell in tests" });

export function world(extra: Partial<EngineOptions> = {}, where: { readonly dir?: string; readonly firstSessionId?: string; readonly noHands?: boolean; readonly oneHands?: boolean } = {}): World {
  const dir = where.dir ?? mkdtempSync(join(tmpdir(), "jh-engine-"));
  const config: JarheadConfig = {
    ...readConfig(),
    openaiApiKey: "sk-test-not-used",
    brain: "auto",
    brainModel: "",
    brainBaseUrl: undefined,
    anthropicApiKey: undefined,
    claudeBin: undefined,
    codexBin: undefined,
    handsBin: join(dir, "no-hands"),
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  let engine!: Engine;
  const brainState: BrainState = { cancels: 0, cancelDelayMs: 0, resolve: undefined, tasks: [] };
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: (task, sink) =>
      new Promise<BrainResult>((resolve) => {
        brainState.tasks.push(task);
        // As every real brain does: the runner carries this task for the turn (the daemon's `attached` check, the lease's turn end).
        engine.runner.attach(sink, task);
        const done = (r: BrainResult): void => {
          engine.runner.attach(undefined);
          resolve(r);
        };
        brainState.resolve = done;
        task.signal.addEventListener("abort", () => done({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      brainState.cancels++;
      if (brainState.cancelDelayMs > 0) await new Promise((r) => setTimeout(r, brainState.cancelDelayMs));
    },
    stop: async () => undefined,
  };
  // Thread brains: one fake per spawned thread, scripted by the test.
  const threads: ThreadWorld = {
    brains: [],
    script: undefined,
    startResult: undefined,
    byName: (name) => threads.brains.find((b) => b.name === name),
  };
  const makeThreadBrain: ThreadBrainFactory = (spec) => {
    const fb: FakeThreadBrain = { id: spec.threadId, name: "", runner: spec.runner, tasks: [], sink: undefined, started: 0, cancels: 0, stops: 0, resolve: undefined };
    threads.brains.push(fb);
    return {
      kind: "fake-thread",
      start: async () => {
        fb.started++;
        return threads.startResult ? threads.startResult(fb) : { ready: true, detail: "fake thread" };
      },
      handle: (task, sink) =>
        new Promise<BrainResult>((resolve) => {
          fb.name = threadNameOf(task) ?? fb.name;
          fb.tasks.push(task);
          fb.sink = sink;
          fb.runner.attach(sink, task);
          let settled = false;
          const done = (r: BrainResult): void => {
            if (settled) return;
            settled = true;
            fb.runner.attach(undefined);
            fb.resolve = undefined;
            resolve(r);
          };
          fb.resolve = done;
          task.signal.addEventListener("abort", () => done({ status: "cancelled" }), { once: true });
          const script = threads.script;
          if (script) {
            void script({ brain: fb, task, sink, runner: fb.runner })
              .then((r) => {
                if (r) done(r);
              })
              .catch((e: unknown) => done({ status: "failed", error: (e as Error).message }));
          }
        }),
      cancel: async () => {
        fb.cancels++;
      },
      stop: async () => {
        fb.stops++;
      },
    };
  };
  // One FakeLive per session: the first exists before the wake (tests hold it as `live`);
  // every wake after that — a resume, a re-wake — gets a fresh one, as the engine does.
  const first = where.firstSessionId ?? "sess_1";
  const live = new FakeLive(first);
  const lives: FakeLive[] = [live];
  let opened = 0;
  const makeLive = (config: SessionConfig): LiveSession => {
    const l = lives[opened] ?? new FakeLive(where.firstSessionId ? `${first}_${opened + 1}` : `sess_${opened + 1}`);
    if (!lives.includes(l)) lives.push(l);
    opened++;
    l.config = config;
    return l as unknown as LiveSession;
  };
  const hands = new RecordingHands();
  const handsBg = where.oneHands ? hands : new RecordingHands();
  // One Mac, one screen: what the acting helper fronts is what the reading helper reads.
  if (handsBg !== hands) handsBg.shareScreenWith(hands);
  const clock = { t: 1_757_500_000_000 };
  hands.now = () => clock.t;
  handsBg.now = () => clock.t;
  // The memory module never loads by name in a test (no store on disk, no network from an extractor or an
  // embedder): every world runs over a FakeMemoryService unless the test hands its own seams.
  const fakeMemory = extra.memory ? undefined : new FakeMemoryService(() => clock.t);
  // Short ear windows (120 / 450 ms in production): 40 ms for the prefire kinds, 70 ms for the careful ones.
  // `where.noHands`: no stand-in helper — the binary at config.handsBin does not exist, so the engine sees a helper that is not built.
  // `observeSettleMs: 0`: the observer's 150 ms settle before it reads the screen after an acting tool is real time
  // (an app's reaction), pointless against a fake helper that answers at once; the `now:` line itself still lands.
  engine = new Engine({ config, connectors: [], brain, ...(where.noHands ? {} : { hands, backgroundHands: handsBg }), makeLive, now: () => clock.t, earStableMs: 40, earCarefulMs: 70, observeSettleMs: 0, makeThreadBrain, exec: noShell, ...(fakeMemory ? { memory: { service: fakeMemory } } : {}), ...extra });
  // The real service's audit rows reach the ledger through the bridge's onRow; the fake's do the same here.
  if (fakeMemory) fakeMemory.onRow = (row) => engine.ledger.append(row);
  const events: EngineEvent[] = [];
  const overlays: OverlayCommand[] = [];
  const audio: Buffer[] = [];
  engine.on("event", (e) => events.push(e));
  engine.on("overlay", (c) => overlays.push(c));
  engine.on("audio", (pcm) => audio.push(pcm));
  return { engine, live, lives, hands, handsBg, events, overlays, audio, brain: brainState, threads, memory: fakeMemory, clock, dir };
}

export const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const frame = (): Buffer => Buffer.alloc(480, 7);

/** The session the engine is talking to now (the latest opened). */
export function current(w: World): FakeLive {
  return w.lives[w.lives.length - 1] ?? w.live;
}

/** Live heard Kevin and delegated: one fragment, then the delegation for it — on the current session. */
export function delegate(w: World, text: string, liveId: string): void {
  const live = current(w);
  const s = live.nowMs;
  live.nowMs += 900;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  live.emit("delegation", liveId, "client", live.nowMs);
}

/** Spaced well past the transcript's merge gap so the next words are a new utterance. */
export function nextUtterance(w: World): void {
  current(w).nowMs += 3000;
}

/** Ledger rows of one type for the world's day, in order. */
export function rows<T extends { type: string }>(w: World, type: string): T[] {
  return (w.engine.ledger.read(w.clock.t) as unknown as T[]).filter((r) => r.type === type);
}

/** Wait until `cond` holds (polled every 10 ms) or `ms` pass; returns whether it held. */
export async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await settle(10);
  }
  return cond();
}
