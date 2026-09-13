import { logger, type Ledger } from "@jarhead/core";
import { MAIN_THREAD_ID, THREADS_MAX, THREAD_LINGER_MS, THREAD_STATUSES, THREAD_TERMINAL, type LedgerRow, type Point, type Thread, type ThreadEvent, type ThreadStatus } from "@jarhead/protocol";
import { cutLine, overviewLine, threadLine, unknownNameLine } from "./lines.ts";

/**
 * The task table: one writer, O(1) reads, bounded memory.
 *
 * Kevin: "keep track of those using extremely performant data structure
 * representations". Every question the voice, the Console or the blobs ask —
 * what is Spotify doing, is anything waiting on me, which threads are live, what
 * happened since event 412 — is answered from Maps and a ring here, never by a
 * walk over delegations and never by a model. Every write appends ONE ThreadEvent
 * with a monotonic `seq`; the scheduler's coalescer decides what reaches the wire.
 * Records evict from MEMORY only (the oldest finished one past THREAD_TABLE_MAX; a
 * live record never); their rows stay on the ledger, and `rebuild` reads them back
 * at daemon start. ≤ 64 records × ~600 B + 512 events × ~150 B ≈ 100 KB.
 */

const log = logger("engine.threads.table");

/** Records kept in memory, live ones never evicted. */
export const THREAD_TABLE_MAX = 64;
/** Events kept for late joiners (`since(seq)`). */
export const THREAD_EVENTS_RING = 512;
/** An acting thread with no step for this long is thinking (the blob's own rule, engine.ts recomputePhase). */
export const ACTING_HOLD_MS = 4_000;
/** Apps a thread may claim; the newest is where its blob parks. */
export const THREAD_APPS_MAX = 4;
/** Per-thread window in which status / step / at events are merged (newest wins). */
export const THREAD_EVENT_COALESCE_MS = 50;
/** A status event's detail on the wire (the record keeps 200): a status event with a 14-char id and this much detail is ≤ 191 B. */
export const EVENT_DETAIL_CHARS = 80;
/** What a daemon that restarted says about a thread it found live. */
export const RESTART_REASON = "the daemon restarted";

const ORDINAL: ReadonlyMap<ThreadStatus, number> = new Map(THREAD_STATUSES.map((s, i) => [s, i]));

/** Omit over a union, member by member (a plain Omit collapses the ThreadEvent union to its common keys). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A ThreadEvent before the table stamps `seq` and `at`. */
type EventBody = DistributiveOmit<ThreadEvent, "seq" | "at">;

interface Rec {
  thread: Thread;
  /** When its last tool / screenshot step landed (for the acting→thinking flip). */
  lastStepAt: number;
  /** What it last said it was doing ("playing Focus"), for the status line. */
  phrase: string | undefined;
}

export interface ThreadTableOptions {
  readonly now: () => number;
  /** Records in memory (default THREAD_TABLE_MAX). */
  readonly max?: number | undefined;
  /** Events in the ring (default THREAD_EVENTS_RING). */
  readonly ring?: number | undefined;
}

export interface StepPatch {
  readonly tool?: string | undefined;
  readonly ok?: boolean | undefined;
  /** A `screenshot` step: counts and stamps `lastStepAt` like a tool. */
  readonly screenshot?: boolean | undefined;
  /** What the step says the thread is doing, for the status line. */
  readonly phrase?: string | undefined;
  /** A `detail` for the record (last tool + outcome), redacted and cut by the caller. */
  readonly detail?: string | undefined;
  readonly screenshotPath?: string | undefined;
}

export interface RebuildResult {
  readonly table: ThreadTable;
  /** Threads found live from a previous process, already ended `failed` in the table. */
  readonly orphans: readonly Thread[];
  /** The `thread.ended` rows the caller appends for them (one each). */
  readonly rows: readonly Extract<LedgerRow, { type: "thread.ended" }>[];
}

export class ThreadTable {
  private readonly byId = new Map<string, Rec>();
  /** lower(name) → id, live threads only; a name is released at end. */
  private readonly liveByName = new Map<string, string>();
  /** lower(name) → id of the newest ended thread by that name ("what did Spotify do"). */
  private readonly recentByName = new Map<string, string>();
  /** lower(app) → live ids that claimed it. */
  private readonly appIndex = new Map<string, Set<string>>();
  /** Non-terminal ids, insertion order = age (the scheduler's priority order). */
  private readonly live = new Set<string>();
  /** The status count vector, by THREAD_STATUSES ordinal. */
  private readonly counts = new Uint16Array(THREAD_STATUSES.length);
  private readonly ring: (ThreadEvent | undefined)[];
  private ringNext = 0;
  private ringFill = 0;
  private seq = 0;
  private readonly now: () => number;
  private readonly max: number;
  private evictions = 0;

  constructor(opts: ThreadTableOptions) {
    this.now = opts.now;
    this.max = Math.max(1, opts.max ?? THREAD_TABLE_MAX);
    this.ring = new Array<ThreadEvent | undefined>(Math.max(1, opts.ring ?? THREAD_EVENTS_RING)).fill(undefined);
  }

  // ------------------------------------------------------------------ reads

  get(id: string): Thread | undefined {
    return this.byId.get(id)?.thread;
  }

  /** The live thread by that name, case-insensitive. */
  byNameLive(name: string): Thread | undefined {
    const id = this.liveByName.get(key(name));
    return id ? this.byId.get(id)?.thread : undefined;
  }

  /** The newest ended thread by that name, while it lingers (THREAD_LINGER_MS). */
  byNameRecent(name: string): Thread | undefined {
    const id = this.recentByName.get(key(name));
    const t = id ? this.byId.get(id)?.thread : undefined;
    if (!t || t.doneAt === undefined || this.now() - t.doneAt > THREAD_LINGER_MS) return undefined;
    return t;
  }

  /** Live threads that claimed this app (≤ THREAD_MAX_LIVE). */
  byApp(app: string): readonly Thread[] {
    const ids = this.appIndex.get(key(app));
    if (!ids) return [];
    const out: Thread[] = [];
    for (const id of ids) {
      const t = this.byId.get(id)?.thread;
      if (t) out.push(t);
    }
    return out;
  }

  count(status: ThreadStatus): number {
    return this.counts[ORDINAL.get(status) ?? 0] ?? 0;
  }

  /** The whole vector, by THREAD_STATUSES ordinal (a copy). */
  countVector(): readonly number[] {
    return Array.from(this.counts);
  }

  /** Live threads, the main thread included when it is registered. */
  liveCount(): number {
    return this.live.size;
  }

  /** Live spawned threads (not main). */
  spawnedLiveCount(): number {
    return this.live.size - (this.live.has(MAIN_THREAD_ID) ? 1 : 0);
  }

  /** Live ids, oldest first. */
  liveIds(): readonly string[] {
    return [...this.live];
  }

  /** Live spawned threads' names, oldest first (the reflex grammar's `threadNames`). */
  liveNames(): readonly string[] {
    const out: string[] = [];
    for (const id of this.live) {
      if (id === MAIN_THREAD_ID) continue;
      const t = this.byId.get(id)?.thread;
      if (t) out.push(t.name);
    }
    return out;
  }

  /** Every record in memory, oldest first (tests, the CLI). */
  all(): readonly Thread[] {
    const out: Thread[] = [];
    for (const r of this.byId.values()) out.push(r.thread);
    return out;
  }

  /** How many records were evicted from memory so far. */
  get evicted(): number {
    return this.evictions;
  }

  /**
   * The snapshot's `threads`: live threads (main first, then by age) and those ended
   * within THREAD_LINGER_MS, at most THREADS_MAX — live ones are never dropped.
   */
  summaries(now = this.now()): readonly Thread[] {
    const live: Thread[] = [];
    const main = this.live.has(MAIN_THREAD_ID) ? this.byId.get(MAIN_THREAD_ID)?.thread : undefined;
    if (main) live.push(main);
    for (const id of this.live) {
      if (id === MAIN_THREAD_ID) continue;
      const t = this.byId.get(id)?.thread;
      if (t) live.push(t);
    }
    const ended: Thread[] = [];
    for (const r of this.byId.values()) {
      const t = r.thread;
      if (t.doneAt !== undefined && THREAD_TERMINAL.has(t.status) && now - t.doneAt <= THREAD_LINGER_MS) ended.push(t);
    }
    ended.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    return [...live, ...ended.slice(0, Math.max(0, THREADS_MAX - live.length))];
  }

  /** Events after `seq`, oldest first (a late joiner catches up; older than the ring is gone). */
  since(seq: number): readonly ThreadEvent[] {
    const out: ThreadEvent[] = [];
    const n = this.ring.length;
    const start = (this.ringNext - this.ringFill + n) % n;
    for (let i = 0; i < this.ringFill; i++) {
      const e = this.ring[(start + i) % n];
      if (e && e.seq > seq) out.push(e);
    }
    return out;
  }

  /** The newest event's seq (0 before the first). */
  get lastSeq(): number {
    return this.seq;
  }

  /** The phrase beside a record ("playing Focus"), for the status line. */
  phraseOf(id: string): string | undefined {
    return this.byId.get(id)?.phrase;
  }

  /** Deterministic English for the voice: one thread by name, or the overview. */
  statusLine(name?: string): string {
    const now = this.now();
    const live = this.liveThreads();
    if (name !== undefined && name.trim()) {
      const t = this.byNameLive(name) ?? this.byNameRecent(name);
      if (t) return threadLine(t, now, this.byId.get(t.id)?.phrase);
      return unknownNameLine(name.trim(), live);
    }
    return overviewLine(live, now, (id) => this.byId.get(id)?.phrase);
  }

  private liveThreads(): readonly Thread[] {
    const out: Thread[] = [];
    for (const id of this.live) {
      const t = this.byId.get(id)?.thread;
      if (t) out.push(t);
    }
    return out;
  }

  // ----------------------------------------------------------------- writes

  /** A new thread (or, on rebuild, one read back). Its record is indexed and one `started` event appended. */
  started(thread: Thread): ThreadEvent {
    const existing = this.byId.get(thread.id);
    if (existing) this.unindex(existing.thread);
    const rec: Rec = { thread, lastStepAt: thread.updatedAt, phrase: undefined };
    this.byId.set(thread.id, rec);
    this.index(thread);
    this.evict();
    return this.push({ threadId: thread.id, kind: "started", thread });
  }

  /**
   * A status change (never to a terminal status: `ended` does that). The same
   * status with the same detail is not a change and appends nothing; the same
   * status with a new detail is.
   */
  status(id: string, status: ThreadStatus, detail?: string): ThreadEvent | undefined {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(status) || THREAD_TERMINAL.has(rec.thread.status)) return undefined;
    const before = rec.thread;
    if (before.status === status && (detail === undefined || detail === before.detail)) return undefined;
    // A question is the thread's while it waits on Kevin or is paused over it; any other move clears it.
    this.move(rec, status, { ...(detail !== undefined ? { detail: cutLine(detail, 200) } : {}) }, status !== "waiting-kevin" && status !== "paused" && before.question !== undefined ? ["question"] : []);
    return this.push({ threadId: id, kind: "status", status, ...(rec.thread.detail !== undefined ? { detail: cutLine(rec.thread.detail, EVENT_DETAIL_CHARS) } : {}) });
  }

  /**
   * A step landed: the counter, `lastStepAt`, the phrase; an ok tool or screenshot
   * while thinking makes the thread `acting`. One `step` event.
   */
  step(id: string, patch: StepPatch = {}): ThreadEvent | undefined {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(rec.thread.status)) return undefined;
    const now = this.now();
    const acted = patch.ok !== false && (patch.tool !== undefined || patch.screenshot === true);
    if (acted) rec.lastStepAt = now;
    if (patch.phrase) rec.phrase = patch.phrase;
    const status = acted && rec.thread.status === "thinking" ? "acting" : rec.thread.status;
    const extra: Partial<Thread> = {
      steps: rec.thread.steps + 1,
      ...(patch.detail !== undefined ? { detail: cutLine(patch.detail, 200) } : {}),
      ...(patch.screenshotPath !== undefined ? { lastScreenshotPath: patch.screenshotPath } : {}),
    };
    this.move(rec, status, extra);
    return this.push({ threadId: id, kind: "step", steps: rec.thread.steps, ...(patch.tool !== undefined ? { tool: patch.tool } : {}), ...(patch.ok !== undefined ? { ok: patch.ok } : {}) });
  }

  /** A new turn on this thread (its own Delegation record). */
  turn(id: string, delegationId: string, request: string): ThreadEvent | undefined {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(rec.thread.status)) return undefined;
    this.move(rec, rec.thread.status, { turns: rec.thread.turns + 1, currentDelegationId: delegationId });
    return this.push({ threadId: id, kind: "turn", delegationId, request: cutLine(request, 120) });
  }

  /**
   * The thread asks Kevin: status `waiting-kevin` (one event) and the question (a
   * second). Two writes, two events — every consumer that keys a face by status sees
   * the status; the pane sees the words.
   */
  question(id: string, question: string): readonly ThreadEvent[] {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(rec.thread.status)) return [];
    const q = cutLine(question, 160);
    // The same question again (a promotion re-asking what the record already says): nothing changed, nothing appended.
    if (rec.thread.status === "waiting-kevin" && rec.thread.question === q) return [];
    const out: ThreadEvent[] = [];
    this.move(rec, "waiting-kevin", { question: q, detail: q });
    out.push(this.push({ threadId: id, kind: "status", status: "waiting-kevin", detail: cutLine(q, EVENT_DETAIL_CHARS) }));
    out.push(this.push({ threadId: id, kind: "question", question: q }));
    return out;
  }

  /** Jarhead spoke for the thread (a finish line, a question, budgeted progress). */
  said(id: string, text: string, phrase?: string): ThreadEvent | undefined {
    const rec = this.byId.get(id);
    if (!rec) return undefined;
    if (phrase) rec.phrase = phrase;
    this.touch(rec);
    return this.push({ threadId: id, kind: "said", text: cutLine(text, 80) });
  }

  /** One more wait for the screen on the record (the status event carries the state; three strikes fail the thread). */
  waited(id: string): void {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(rec.thread.status)) return;
    this.move(rec, rec.thread.status, { waits: rec.thread.waits + 1 });
  }

  /** What the thread says it is doing, for the status line; no event (the words themselves are on its record). */
  phrase(id: string, phrase: string): void {
    const rec = this.byId.get(id);
    if (rec) rec.phrase = phrase;
  }

  /** The thread acted at this point (a tagged orb.fly); the blob follows. */
  at(id: string, p: Point, app?: string): ThreadEvent | undefined {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(rec.thread.status)) return undefined;
    if (app) this.claimApp(id, app);
    this.move(rec, rec.thread.status, { at: { x: Math.round(p.x), y: Math.round(p.y) } });
    return this.push({ threadId: id, kind: "at", x: Math.round(p.x), y: Math.round(p.y), ...(rec.thread.app !== undefined ? { app: rec.thread.app } : {}) });
  }

  /**
   * The thread works in this app (open_app / focus_app / `tell application "X"` / a
   * browser host): ≤ THREAD_APPS_MAX, newest last, and `app` for the blob. Indexed
   * while live. No event of its own — the next `at` / snapshot carries it.
   */
  claimApp(id: string, app: string): void {
    const rec = this.byId.get(id);
    const name = app.replace(/\s+/g, " ").trim().slice(0, 32);
    if (!rec || !name || THREAD_TERMINAL.has(rec.thread.status)) return;
    const k = key(name);
    const apps = rec.thread.apps.filter((a) => key(a) !== k);
    apps.push(name);
    while (apps.length > THREAD_APPS_MAX) {
      const dropped = apps.shift()!;
      this.appIndex.get(key(dropped))?.delete(id);
    }
    let set = this.appIndex.get(k);
    if (!set) {
      set = new Set();
      this.appIndex.set(k, set);
    }
    set.add(id);
    this.move(rec, rec.thread.status, { apps, app: name });
  }

  /** The thread is over: terminal status, `doneAt`, the name released, the app index cleared; one `ended` event. */
  ended(id: string, status: "done" | "failed" | "stopped", summary?: string): ThreadEvent | undefined {
    const rec = this.byId.get(id);
    if (!rec || THREAD_TERMINAL.has(rec.thread.status)) return undefined;
    const now = this.now();
    this.move(rec, status, { doneAt: now, canSay: false, canStop: false, ...(summary !== undefined ? { detail: cutLine(summary, 200) } : {}) }, ["question"]);
    this.live.delete(id);
    const k = key(rec.thread.name);
    if (this.liveByName.get(k) === id) this.liveByName.delete(k);
    this.recentByName.set(k, id);
    for (const a of rec.thread.apps) this.appIndex.get(key(a))?.delete(id);
    return this.push({ threadId: id, kind: "ended", status, ...(summary !== undefined ? { summary: cutLine(summary, 120) } : {}) });
  }

  /** The clock: an acting thread with no step for ACTING_HOLD_MS is thinking again. */
  tick(now = this.now()): readonly ThreadEvent[] {
    const out: ThreadEvent[] = [];
    for (const id of this.live) {
      const rec = this.byId.get(id);
      if (!rec || rec.thread.status !== "acting" || now - rec.lastStepAt < ACTING_HOLD_MS) continue;
      this.move(rec, "thinking", {});
      out.push(this.push({ threadId: id, kind: "status", status: "thinking", ...(rec.thread.detail !== undefined ? { detail: cutLine(rec.thread.detail, EVENT_DETAIL_CHARS) } : {}) }));
    }
    return out;
  }

  // ---------------------------------------------------------------- rebuild

  /**
   * The table a previous process left, from its ledger rows (today's and yesterday's
   * day file: a thread may cross midnight). A thread still live when the rows end
   * belonged to a daemon that is gone — its brain process died with it — so it is
   * ended `failed` with RESTART_REASON here and NOTHING acts; the caller appends the
   * rows returned. The main thread, when registered, comes back `idle`.
   */
  static rebuild(rows: readonly LedgerRow[], opts: ThreadTableOptions & { readonly reason?: string | undefined }): RebuildResult {
    // While the rows replay, the table's clock is each row's own `at`: doneAt / updatedAt read as they were written.
    let replayAt: number | undefined;
    const table = new ThreadTable({ ...opts, now: () => replayAt ?? opts.now() });
    const delegationThread = new Map<string, string>();
    for (const row of rows) {
      replayAt = row.at;
      switch (row.type) {
        case "thread.started":
          table.started(row.thread);
          break;
        case "thread.status":
          table.status(row.threadId, row.status, row.detail);
          break;
        case "thread.said":
          table.said(row.threadId, row.text);
          break;
        case "thread.ended": {
          const rec = table.byId.get(row.threadId);
          if (rec && row.steps > rec.thread.steps) rec.thread = { ...rec.thread, steps: row.steps };
          table.ended(row.threadId, row.status, row.summary);
          break;
        }
        case "delegation.created":
          if (row.delegation.threadId && row.delegation.threadId !== MAIN_THREAD_ID) {
            delegationThread.set(row.delegation.id, row.delegation.threadId);
            table.turn(row.delegation.threadId, row.delegation.id, row.delegation.request);
          }
          break;
        case "delegation.step": {
          const threadId = delegationThread.get(row.delegationId);
          if (threadId && (row.step.kind === "tool" || row.step.kind === "screenshot" || row.step.kind === "confirm" || row.step.kind === "error")) {
            table.step(threadId, { ...(row.step.tool ? { tool: row.step.tool.name, ok: row.step.tool.ok } : {}), ...(row.step.kind === "screenshot" ? { screenshot: true } : {}) });
          }
          break;
        }
        default:
          break;
      }
    }
    replayAt = undefined;
    const reason = opts.reason ?? RESTART_REASON;
    const orphans: Thread[] = [];
    const out: Extract<LedgerRow, { type: "thread.ended" }>[] = [];
    for (const id of [...table.live]) {
      const rec = table.byId.get(id);
      if (!rec) continue;
      if (id === MAIN_THREAD_ID) {
        table.move(rec, "idle", {}, ["question", "currentDelegationId"]);
        continue;
      }
      const at = opts.now();
      table.ended(id, "failed", reason);
      const t = table.byId.get(id)!.thread;
      orphans.push(t);
      out.push({ at, type: "thread.ended", threadId: id, status: "failed", threadStatus: "failed", summary: reason, steps: t.steps, seconds: Math.max(0, Math.round((at - t.startedAt) / 1000)) });
    }
    if (orphans.length) log.warn(`${orphans.length} thread(s) were live when the last daemon ended: ${orphans.map((t) => t.name).join(", ")} — marked failed (${reason}); nothing acts`);
    return { table, orphans, rows: out };
  }

  /**
   * Rebuild from the ledger's day files around `now` (yesterday's and today's) and
   * APPEND the orphan rows — the one write a restart makes about threads. Reading is
   * milliseconds for a ~2k-row day.
   */
  static rebuildFrom(ledger: Ledger, opts: ThreadTableOptions & { readonly reason?: string | undefined }): RebuildResult {
    const now = opts.now();
    const rows = [...ledger.read(now - 86_400_000), ...ledger.read(now)];
    const result = ThreadTable.rebuild(rows, opts);
    for (const row of result.rows) {
      try {
        ledger.append(row);
      } catch (e) {
        log.warn(`thread.ended row for ${row.threadId} not written: ${(e as Error).message}`);
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ inner

  private push(e: EventBody): ThreadEvent {
    const full = { seq: ++this.seq, at: this.now(), ...e } as ThreadEvent;
    this.ring[this.ringNext] = full;
    this.ringNext = (this.ringNext + 1) % this.ring.length;
    if (this.ringFill < this.ring.length) this.ringFill++;
    return full;
  }

  /** The record moves to `status` with `patch` (and without `drop`); the count vector follows. */
  private move(rec: Rec, status: ThreadStatus, patch: Partial<Thread>, drop: readonly (keyof Thread)[] = []): void {
    const before = rec.thread;
    if (before.status !== status) {
      this.counts[ORDINAL.get(before.status)!]!--;
      this.counts[ORDINAL.get(status)!]!++;
    }
    const next: Record<string, unknown> = { ...before, ...patch, status, updatedAt: this.now() };
    for (const k of drop) delete next[k];
    rec.thread = next as unknown as Thread;
  }

  private touch(rec: Rec): void {
    rec.thread = { ...rec.thread, updatedAt: this.now() };
  }

  private index(t: Thread): void {
    this.counts[ORDINAL.get(t.status)!]!++;
    if (!THREAD_TERMINAL.has(t.status)) {
      this.live.add(t.id);
      this.liveByName.set(key(t.name), t.id);
      for (const a of t.apps) {
        let set = this.appIndex.get(key(a));
        if (!set) {
          set = new Set();
          this.appIndex.set(key(a), set);
        }
        set.add(t.id);
      }
    } else {
      this.recentByName.set(key(t.name), t.id);
    }
  }

  private unindex(t: Thread): void {
    this.counts[ORDINAL.get(t.status)!]!--;
    this.live.delete(t.id);
    const k = key(t.name);
    if (this.liveByName.get(k) === t.id) this.liveByName.delete(k);
    if (this.recentByName.get(k) === t.id) this.recentByName.delete(k);
    for (const a of t.apps) this.appIndex.get(key(a))?.delete(t.id);
  }

  /** Past the cap the oldest TERMINAL record goes (its rows stay on the ledger); a live one never. */
  private evict(): void {
    while (this.byId.size > this.max) {
      let victim: Rec | undefined;
      for (const rec of this.byId.values()) {
        if (THREAD_TERMINAL.has(rec.thread.status)) {
          victim = rec;
          break;
        }
      }
      if (!victim) return;
      this.byId.delete(victim.thread.id);
      this.unindex(victim.thread);
      this.evictions++;
    }
  }
}

function key(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * What reaches the wire: every `started` / `ended` / `question` / `said` / `turn`
 * event at once (whatever was pending for that thread goes first, in order), and
 * for `status` / `step` / `at` the first of a quiet moment at once, then the newest
 * of each kind when the thread's THREAD_EVENT_COALESCE_MS window closes — so a
 * thread stepping ten times in 50 ms costs the wire two events, never ten, and a
 * status is never lost behind a step. ≤ 20 events/s/thread. A slot exists only for a
 * thread that coalesced something and goes with its `ended`; an event about a finished
 * thread (its finish line, a rebuild's) makes none — the map is bounded by the live threads.
 */
export class ThreadEventCoalescer {
  private readonly perThread = new Map<string, { timer: NodeJS.Timeout | undefined; pending: Map<string, ThreadEvent> }>();
  /** Events handed to the sink (tests, the log). */
  sent = 0;

  constructor(
    private readonly sink: (e: ThreadEvent) => void,
    private readonly windowMs = THREAD_EVENT_COALESCE_MS,
  ) {}

  /** Threads holding a coalescing slot right now (≤ the live threads; a finished one holds none). */
  get slots(): number {
    return this.perThread.size;
  }

  push(e: ThreadEvent): void {
    const slot = this.perThread.get(e.threadId);
    if (e.kind === "status" || e.kind === "step" || e.kind === "at") {
      if (slot?.timer) {
        slot.pending.set(e.kind, e);
        return;
      }
      this.emit(e);
      this.arm(e.threadId, slot ?? this.slot(e.threadId));
      return;
    }
    if (slot) this.drain(slot);
    this.emit(e);
    if (e.kind === "ended" && slot) {
      if (slot.timer) clearTimeout(slot.timer);
      this.perThread.delete(e.threadId);
    }
  }

  /** Everything pending goes out now (a sleep, a shutdown, a test). */
  flush(threadId?: string): void {
    for (const [id, slot] of this.perThread) {
      if (threadId !== undefined && id !== threadId) continue;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = undefined;
      this.drain(slot);
    }
  }

  dispose(): void {
    for (const slot of this.perThread.values()) if (slot.timer) clearTimeout(slot.timer);
    this.perThread.clear();
  }

  private slot(threadId: string): { timer: NodeJS.Timeout | undefined; pending: Map<string, ThreadEvent> } {
    let s = this.perThread.get(threadId);
    if (!s) {
      s = { timer: undefined, pending: new Map() };
      this.perThread.set(threadId, s);
    }
    return s;
  }

  private arm(threadId: string, slot: { timer: NodeJS.Timeout | undefined; pending: Map<string, ThreadEvent> }): void {
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      const had = slot.pending.size > 0;
      this.drain(slot);
      // Something was merged: the window rolls on, so a steady stream stays at ≤ 1/window.
      if (had && this.perThread.get(threadId) === slot) this.arm(threadId, slot);
    }, this.windowMs);
    slot.timer.unref?.();
  }

  private drain(slot: { pending: Map<string, ThreadEvent> }): void {
    if (slot.pending.size === 0) return;
    const out = [...slot.pending.values()].sort((a, b) => a.seq - b.seq);
    slot.pending.clear();
    for (const e of out) this.emit(e);
  }

  private emit(e: ThreadEvent): void {
    this.sent++;
    try {
      this.sink(e);
    } catch (err) {
      log.warn(`thread event sink threw: ${(err as Error).message}`);
    }
  }
}
