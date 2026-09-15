import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@jarhead/core";
import { AUTOMATIONS_MAX, AUTOMATION_TERMINAL, automationKind, type Automation, type AutomationEvent, type AutomationKind, type AutomationState, type RingLine } from "@jarhead/protocol";

/**
 * The automations table: every row by id and by name, a min-heap over the rows that
 * wait for a clock (`armed` / `snoozed` / `deferred` with a `nextAt`), an event ring
 * with a monotonic `seq`, a 50 ms coalescer per row for the chatty kinds, the journal
 * under `<stateDir>/automations/jobs.ndjson` (one full row per change, appendFileSync,
 * newest row per id wins — never rewritten in place; past JOURNAL_COMPACT_BYTES the
 * live rows are written to a fresh file and the old one MOVES to trash/automations/),
 * and the snapshot projection (`automations`, `ringing`, `nextFire`).
 *
 * Nothing here fires, judges or asks: the table is the schedule's memory. `trashed` is a
 * state — a trashed row stays in the map (Restore) and out of every rail.
 */

const log = logger("engine.automations.table");

/** The journal is compacted once it passes this many bytes. */
export const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;
/** How many events the ring keeps for `since(seq)`. */
export const AUTOMATION_EVENT_RING = 256;
/** `tick` and `state` events for one row within this window go out as one. */
export const AUTOMATION_EVENT_COALESCE_MS = 50;
/** The states a row with a `nextAt` waits in: the heap's members. */
export const SCHEDULED: ReadonlySet<AutomationState> = new Set<AutomationState>(["armed", "snoozed", "deferred"]);

type Sink = (e: AutomationEvent) => void;
/** An event without the envelope the table stamps (`seq`, `at`, `id`). */
type EventBody = AutomationEvent extends infer E ? (E extends { readonly seq: number; readonly at: number; readonly id: string } ? Omit<E, "seq" | "at" | "id"> : never) : never;

interface HeapEntry {
  readonly at: number;
  readonly id: string;
}

interface Slot {
  timer: NodeJS.Timeout | undefined;
  pending: Map<string, AutomationEvent>;
}

export interface AutomationTableOptions {
  /** The state dir; the journal lives at `<stateDir>/automations/jobs.ndjson`. */
  readonly stateDir: string;
  readonly now: () => number;
  /** Every event, after coalescing (the engine emits `automation.event`). */
  readonly sink?: Sink | undefined;
  readonly coalesceMs?: number | undefined;
  /** Tests: a smaller compaction threshold. */
  readonly compactBytes?: number | undefined;
}

export class AutomationTable {
  private readonly byId = new Map<string, Automation>();
  /** Lower-cased name → id, non-trashed rows only (a trashed row frees its name). */
  private readonly byName = new Map<string, string>();
  private heap: HeapEntry[] = [];
  private readonly ring: (AutomationEvent | undefined)[] = new Array<AutomationEvent | undefined>(AUTOMATION_EVENT_RING);
  private ringNext = 0;
  private ringFill = 0;
  private seq = 0;
  private readonly slots = new Map<string, Slot>();
  private readonly dir: string;
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly compactBytes: number;
  /** Events handed to the sink (tests). */
  sent = 0;
  /** Journal rows appended over this table's life (tests: "the file only grows"). */
  appended = 0;

  constructor(private readonly opts: AutomationTableOptions) {
    this.dir = join(opts.stateDir, "automations");
    this.now = opts.now;
    this.coalesceMs = opts.coalesceMs ?? AUTOMATION_EVENT_COALESCE_MS;
    this.compactBytes = opts.compactBytes ?? JOURNAL_COMPACT_BYTES;
  }

  /** The journal's path. */
  get journalPath(): string {
    return join(this.dir, "jobs.ndjson");
  }

  // ------------------------------------------------------------- journal

  /**
   * Rebuild from the journal: every row, newest per id wins. Returns the rows in the
   * order they were last written; the caller decides what a `firing` row left behind
   * means and recomputes `nextAt`. Reading appends nothing.
   */
  load(): Automation[] {
    this.byId.clear();
    this.byName.clear();
    this.heap = [];
    if (!existsSync(this.journalPath)) return [];
    let text: string;
    try {
      text = readFileSync(this.journalPath, "utf8");
    } catch (e) {
      log.warn(`journal unreadable: ${(e as Error).message}`);
      return [];
    }
    const last = new Map<string, Automation>();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as Automation;
        if (typeof row.id === "string" && row.id && typeof row.name === "string" && row.when && Array.isArray(row.then)) {
          last.delete(row.id);
          last.set(row.id, row);
        }
      } catch {
        // A torn last line (the daemon died mid-write): skipped, never fatal.
      }
    }
    const rows = [...last.values()];
    for (const a of rows) this.place(a);
    return rows;
  }

  /** Write a row: the maps, the heap and one journal line. The row as stored is returned. */
  put(a: Automation): Automation {
    this.place(a);
    this.journal(a);
    return a;
  }

  private place(a: Automation): void {
    const before = this.byId.get(a.id);
    if (before) this.byName.delete(before.name.toLowerCase());
    this.byId.set(a.id, a);
    if (a.state !== "trashed") this.byName.set(a.name.toLowerCase(), a.id);
    // The heap holds one live entry per scheduled row; stale entries are skipped at pop (lazy deletion).
    if (SCHEDULED.has(a.state) && a.nextAt !== undefined) this.heapPush({ at: a.nextAt, id: a.id });
  }

  private journal(a: Automation): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.journalPath, `${JSON.stringify(a)}\n`);
      this.appended++;
    } catch (e) {
      log.warn(`journal append failed: ${(e as Error).message}`);
      return;
    }
    this.compactIfNeeded();
  }

  /**
   * Past the threshold the live rows (one per id, trashed included — Restore needs them)
   * are written to `jobs.<ts>.ndjson`, the old journal MOVES to trash/automations/ by
   * rename(2), and the fresh file takes the journal's name. Nothing is unlinked.
   */
  private compactIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.journalPath).size;
    } catch {
      return;
    }
    if (size < this.compactBytes) return;
    const ts = this.now();
    const fresh = join(this.dir, `jobs.${ts}.ndjson`);
    const trashDir = join(this.opts.stateDir, "trash", "automations");
    try {
      writeFileSync(fresh, [...this.byId.values()].map((a) => JSON.stringify(a)).join("\n") + "\n");
      mkdirSync(trashDir, { recursive: true });
      renameSync(this.journalPath, join(trashDir, `jobs.${ts}.ndjson`));
      renameSync(fresh, this.journalPath);
      log.info(`automations journal compacted: ${size} bytes moved to ${trashDir} (${this.byId.size} rows kept)`);
    } catch (e) {
      log.warn(`journal compaction failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- reads

  get(id: string): Automation | undefined {
    return this.byId.get(id);
  }

  /** A row by id, or by name (case-insensitive) among the non-trashed rows. */
  find(nameOrId: string): Automation | undefined {
    const key = nameOrId.trim();
    if (!key) return undefined;
    return this.byId.get(key) ?? this.byId.get(this.byName.get(key.toLowerCase()) ?? "");
  }

  /** Whether a non-trashed row already wears this name (case-insensitive), other than `exceptId`. */
  nameTaken(name: string, exceptId?: string): boolean {
    const id = this.byName.get(name.trim().toLowerCase());
    return id !== undefined && id !== exceptId;
  }

  /** Every row, trashed included. */
  all(): readonly Automation[] {
    return [...this.byId.values()];
  }

  /** Rows in a state (or every non-trashed row). */
  inState(state?: AutomationState | "all"): readonly Automation[] {
    const rows = this.all();
    if (state === undefined || state === "all") return rows.filter((a) => a.state !== "trashed");
    return rows.filter((a) => a.state === state);
  }

  /** How many non-trashed rows watch a folder (the set-up gate's cap). */
  folderWatchers(): number {
    return this.all().filter((a) => a.state !== "trashed" && a.when.kind === "on" && (a.when.on.kind === "folder.file" || a.when.on.kind === "download.done")).length;
  }

  // ----------------------------------------------------------------- heap

  private heapPush(e: HeapEntry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.at <= h[i]!.at) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  private heapPop(): HeapEntry | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (top === undefined) return undefined;
    if (h.length > 0 && last !== undefined) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l]!.at < h[m]!.at) m = l;
        if (r < h.length && h[r]!.at < h[m]!.at) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }

  /** An entry is live when its row still waits at exactly that instant. */
  private live(e: HeapEntry): boolean {
    const a = this.byId.get(e.id);
    return a !== undefined && SCHEDULED.has(a.state) && a.nextAt === e.at;
  }

  /** The soonest waiting row, or undefined. Stale entries are dropped on the way. */
  top(): Automation | undefined {
    while (this.heap.length > 0) {
      const e = this.heap[0]!;
      if (this.live(e)) return this.byId.get(e.id);
      this.heapPop();
    }
    return undefined;
  }

  /** Pop the soonest waiting row when it is due at or before `now`. */
  popDue(now: number): Automation | undefined {
    const a = this.top();
    if (!a || a.nextAt === undefined || a.nextAt > now) return undefined;
    this.heapPop();
    return a;
  }

  /** Every waiting row due at or before `now`, soonest first, without popping (resync reads then rewrites them). */
  due(now: number): Automation[] {
    return this.all()
      .filter((a) => SCHEDULED.has(a.state) && a.nextAt !== undefined && a.nextAt <= now)
      .sort((x, y) => (x.nextAt ?? 0) - (y.nextAt ?? 0));
  }

  // --------------------------------------------------------------- events

  /**
   * One event on one row: `set`, `fired` and `missed` go out at once (a pending `tick` or
   * `state` for the row goes first); `tick` and `state` are held per row for the window
   * and the newest of each kind goes out when it closes.
   */
  push(id: string, body: EventBody): AutomationEvent {
    const e = { seq: ++this.seq, at: this.now(), id, ...body } as AutomationEvent;
    this.remember(e);
    const slot = this.slots.get(id);
    if (e.kind === "tick" || e.kind === "state") {
      if (slot?.timer) {
        slot.pending.set(e.kind, e);
        return e;
      }
      this.emit(e);
      this.arm(id, slot ?? this.slot(id));
      return e;
    }
    if (slot) this.drain(slot);
    this.emit(e);
    return e;
  }

  /** Events after `seq`, oldest first (a late joiner; older than the ring is gone). */
  since(seq: number): readonly AutomationEvent[] {
    const out: AutomationEvent[] = [];
    const n = this.ring.length;
    const start = (this.ringNext - this.ringFill + n) % n;
    for (let i = 0; i < this.ringFill; i++) {
      const e = this.ring[(start + i) % n];
      if (e && e.seq > seq) out.push(e);
    }
    return out;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Everything pending goes out now (a shutdown, a test). */
  flush(): void {
    for (const slot of this.slots.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = undefined;
      this.drain(slot);
    }
    this.slots.clear();
  }

  dispose(): void {
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.slots.clear();
  }

  private remember(e: AutomationEvent): void {
    this.ring[this.ringNext] = e;
    this.ringNext = (this.ringNext + 1) % this.ring.length;
    if (this.ringFill < this.ring.length) this.ringFill++;
  }

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { timer: undefined, pending: new Map() };
      this.slots.set(id, s);
    }
    return s;
  }

  private arm(id: string, slot: Slot): void {
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      const had = slot.pending.size > 0;
      this.drain(slot);
      if (had && this.slots.get(id) === slot) this.arm(id, slot);
      else if (!had) this.slots.delete(id);
    }, this.coalesceMs);
    slot.timer.unref?.();
  }

  private drain(slot: Slot): void {
    if (slot.pending.size === 0) return;
    const out = [...slot.pending.values()].sort((a, b) => a.seq - b.seq);
    slot.pending.clear();
    for (const e of out) this.emit(e);
  }

  private emit(e: AutomationEvent): void {
    this.sent++;
    try {
      this.opts.sink?.(e);
    } catch (err) {
      log.warn(`automation event sink threw: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------- snapshot

  /**
   * The snapshot's rows: non-trashed, ≤ AUTOMATIONS_MAX — the waiting rows by `nextAt`
   * (watchers, with no clock, after the clocked ones in that group by name), then the rest
   * by `updatedAt`, newest first.
   */
  rows(): readonly Automation[] {
    const waiting: Automation[] = [];
    const rest: Automation[] = [];
    for (const a of this.byId.values()) {
      if (a.state === "trashed") continue;
      (SCHEDULED.has(a.state) ? waiting : rest).push(a);
    }
    waiting.sort((x, y) => (x.nextAt ?? Number.MAX_SAFE_INTEGER) - (y.nextAt ?? Number.MAX_SAFE_INTEGER) || x.name.localeCompare(y.name));
    rest.sort((x, y) => y.updatedAt - x.updatedAt);
    return [...waiting, ...rest].slice(0, AUTOMATIONS_MAX);
  }

  /** The foot's next fire: the soonest waiting clocked row. */
  nextFire(): { readonly id: string; readonly kind: AutomationKind; readonly name: string; readonly at: number } | undefined {
    const a = this.top();
    return a && a.nextAt !== undefined ? { id: a.id, kind: automationKind(a), name: a.name, at: a.nextAt } : undefined;
  }

  /** The newest `fired` row with a line as the island's ring; `more` counts the others. */
  ringing(lines: ReadonlyMap<string, Omit<RingLine, "more">>): RingLine | undefined {
    const fired = this.all().filter((a) => a.state === "fired" && lines.has(a.id));
    if (fired.length === 0) return undefined;
    fired.sort((x, y) => (y.lastFiredAt ?? 0) - (x.lastFiredAt ?? 0));
    const head = lines.get(fired[0]!.id)!;
    return { ...head, more: fired.length - 1 };
  }

  /** Whether a state ends a row for good (done, trashed). */
  static terminal(state: AutomationState): boolean {
    return AUTOMATION_TERMINAL.has(state);
  }
}
