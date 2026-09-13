import { Marks, logger, newId, type Ledger } from "@jarhead/core";
import type { BrainResult } from "@jarhead/brain";
import { THREAD_PAGE, type Delegation, type DelegationStatus, type DelegationStep, type DelegationTimings, type ThreadEntry, type TranscriptItem } from "@jarhead/protocol";
// Pure and shared with the Delegator (B3 switches `addStep` to it); imported by path until @jarhead/brain's index exports it.
import { stampStep, type TimingsExtra } from "@jarhead/brain";

/**
 * A spawned thread's conversation: its turns are Delegation records of its own
 * (`threadId` set, never the parent's), each with the same latency marks the main
 * conversation stamps, a bounded step window in memory (the ledger keeps every
 * step), and a seq-numbered entry log the Console pages by number. Nothing here
 * touches the snapshot: a step costs one ledger row and one log entry.
 */

const log = logger("engine.threads.turns");

/** Steps kept on a turn in memory (p50 9 / max 49 on a real day); the ledger keeps all. */
export const STEPS_IN_MEMORY = 120;
/** Turn records kept per thread in memory; older ids are on the ledger. */
export const THREAD_TURNS_MAX = 20;
/** Entries kept per live thread; a finished thread keeps the last page. */
export const THREAD_LOG_RING = 2000;

/** One brain turn on a thread. `abort` is THIS turn's signal; the job's own signal means stop. */
export interface ThreadTurn {
  delegation: Delegation;
  readonly abort: AbortController;
  readonly marks: Marks;
  readonly startedAt: number;
  /** Tool / screenshot / confirm / error steps this turn (the budget counts these). */
  steps: number;
  /** A follow-up or a pause ended this turn early; the thread lives on and the next turn follows. */
  superseded: string | undefined;
  /** The eyes' pre-warm shot is in flight: its screenshot stamps no mark. */
  looking: boolean;
  /** `brain.cancel()` was called for this turn (once, whichever verb). */
  brainCancelled: boolean;
  /** The record is closed; late steps are dropped. */
  closed: boolean;
  /** Resolves once the brain's `handle` for this turn has returned and the record is closed. */
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export interface ThreadPage {
  readonly entries: readonly ThreadEntry[];
  /** The oldest entry in memory is in this page (older ones are on the ledger). */
  readonly complete: boolean;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly total: number;
}

/**
 * The entries of one thread's pane, numbered by `seq` so a step patches its card in
 * O(1) and "load earlier" pages by number. A ring: THREAD_LOG_RING for a live thread;
 * `trim` keeps a finished thread's last page.
 */
export class ThreadLog {
  private ring: (ThreadEntry | undefined)[];
  private next = 0;
  private fill = 0;
  private seq = 0;
  private readonly listeners = new Set<(e: ThreadEntry) => void>();

  constructor(size = THREAD_LOG_RING) {
    this.ring = new Array<ThreadEntry | undefined>(Math.max(1, size)).fill(undefined);
  }

  /** Entries appended over the thread's life (the pane's `total`). */
  get total(): number {
    return this.seq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Entries in memory. */
  get size(): number {
    return this.fill;
  }

  append(entry: DistributiveOmit<ThreadEntry, "seq">): ThreadEntry {
    const full = { ...entry, seq: ++this.seq } as ThreadEntry;
    this.ring[this.next] = full;
    this.next = (this.next + 1) % this.ring.length;
    if (this.fill < this.ring.length) this.fill++;
    for (const l of this.listeners) {
      try {
        l(full);
      } catch (e) {
        log.warn(`thread log listener threw: ${(e as Error).message}`);
      }
    }
    return full;
  }

  /** New entries as they land (the pane's live tail). */
  onEntry(listener: (e: ThreadEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The newest `limit` entries before `beforeSeq` (exclusive; absent = the newest page). */
  page(beforeSeq?: number, limit = THREAD_PAGE): ThreadPage {
    const all = this.entries();
    const upto = beforeSeq === undefined ? all.length : all.findIndex((e) => e.seq >= beforeSeq);
    const end = upto < 0 ? all.length : upto;
    const start = Math.max(0, end - Math.max(1, limit));
    const entries = all.slice(start, end);
    return { entries, complete: start === 0, startSeq: entries[0]?.seq ?? beforeSeq ?? this.seq + 1, endSeq: entries[entries.length - 1]?.seq ?? beforeSeq ?? this.seq, total: this.seq };
  }

  /** Entries after `seq`, oldest first. */
  since(seq: number): readonly ThreadEntry[] {
    return this.entries().filter((e) => e.seq > seq);
  }

  /** Keep the newest `keep` entries (a finished thread's last page); the rest is on the ledger. */
  trim(keep = THREAD_PAGE): void {
    const kept = this.entries().slice(-Math.max(1, keep));
    this.ring = new Array<ThreadEntry | undefined>(Math.max(1, keep)).fill(undefined);
    this.next = 0;
    this.fill = 0;
    for (const e of kept) {
      this.ring[this.next] = e;
      this.next = (this.next + 1) % this.ring.length;
      this.fill++;
    }
  }

  private entries(): ThreadEntry[] {
    const out: ThreadEntry[] = [];
    const n = this.ring.length;
    const start = (this.next - this.fill + n) % n;
    for (let i = 0; i < this.fill; i++) {
      const e = this.ring[(start + i) % n];
      if (e) out.push(e);
    }
    return out;
  }
}

/** Omit over a union, member by member. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export interface ThreadTurnsOptions {
  readonly threadId: string;
  readonly now: () => number;
  readonly ledger?: Ledger | undefined;
  readonly log: ThreadLog;
  readonly stepsInMemory?: number | undefined;
  /** A record changed (a viewer's stream, never the snapshot). */
  readonly onChange?: ((d: Delegation) => void) | undefined;
}

/** The turn records of one thread: created, stepped, closed — each on the ledger and in the log. */
export class ThreadTurns {
  /** Recent turns, oldest first, ≤ THREAD_TURNS_MAX. */
  private readonly recent: Delegation[] = [];
  private readonly now: () => number;
  private readonly stepsInMemory: number;

  constructor(private readonly opts: ThreadTurnsOptions) {
    this.now = opts.now;
    this.stepsInMemory = Math.max(1, opts.stepsInMemory ?? STEPS_IN_MEMORY);
  }

  /** Recent turns, oldest first. */
  all(): readonly Delegation[] {
    return this.recent;
  }

  current(delegationId: string): Delegation | undefined {
    return this.recent.find((d) => d.id === delegationId);
  }

  /** A new turn: its Delegation (threadId set), the created row, the log entry. */
  open(request: string, liveId: string, offsetMs: number, speechEndAt?: number): ThreadTurn {
    const marks = new Marks(this.now);
    const at = marks.startedAt;
    const timings: DelegationTimings = { delegatedAt: at, ...(speechEndAt !== undefined ? { speechEndAt } : {}) };
    const delegation: Delegation = { id: newId("dlg"), liveId, createdAt: at, offsetMs, request, status: "running", steps: [], timings, threadId: this.opts.threadId, stepCount: 0 };
    this.recent.push(delegation);
    if (this.recent.length > THREAD_TURNS_MAX) this.recent.splice(0, this.recent.length - THREAD_TURNS_MAX);
    this.append({ at, type: "delegation.created", delegation });
    this.opts.log.append({ kind: "delegation", delegation });
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const turn: ThreadTurn = { delegation, abort: new AbortController(), marks, startedAt: at, steps: 0, superseded: undefined, looking: false, brainCancelled: false, closed: false, settled, settle };
    this.opts.onChange?.(delegation);
    return turn;
  }

  /**
   * A step on the turn: the marks stamped as the main conversation stamps them (a
   * look while the eyes were out stamps nothing), the memory window kept, one
   * `delegation.step` row, one log entry. Dropped once the turn is closed.
   */
  step(turn: ThreadTurn, step: Omit<DelegationStep, "id" | "at">): DelegationStep | undefined {
    if (turn.closed) return undefined;
    const full: DelegationStep = { id: newId("step"), at: this.now(), ...step };
    const d = turn.delegation;
    const timings = stampStep(d.timings as TimingsExtra, step, { at: full.at, looking: turn.looking });
    const steps = d.steps.length >= this.stepsInMemory ? [...d.steps.slice(d.steps.length - this.stepsInMemory + 1), full] : [...d.steps, full];
    this.replace(turn, { ...d, steps, stepCount: (d.stepCount ?? d.steps.length) + 1, timings: timings as DelegationTimings });
    this.append({ at: full.at, type: "delegation.step", delegationId: d.id, step: full });
    this.opts.log.append({ kind: "step", delegationId: d.id, step: full });
    return full;
  }

  /** A timings mark from outside a step (the eyes' duration, first thinking). */
  stamp(turn: ThreadTurn, patch: Partial<TimingsExtra>): void {
    if (turn.closed) return;
    this.replace(turn, { ...turn.delegation, timings: { ...turn.delegation.timings, ...patch } as DelegationTimings });
  }

  /** The turn is over: status, summary, doneAt, the finished row, the log's status entry. */
  close(turn: ThreadTurn, result: BrainResult | { readonly status: DelegationStatus; readonly summary?: string | undefined }): Delegation {
    if (turn.closed) return turn.delegation;
    turn.closed = true;
    const doneAt = this.now();
    const status: DelegationStatus = result.status === "running" ? "done" : result.status;
    const summary = "summary" in result && result.summary ? result.summary : "error" in result && result.error ? result.error : undefined;
    const d: Delegation = { ...turn.delegation, status, ...(summary !== undefined ? { summary } : {}), timings: { ...turn.delegation.timings, doneAt } };
    this.replace(turn, d);
    this.append({ at: doneAt, type: "delegation.finished", delegationId: d.id, status, timings: d.timings, ...(summary !== undefined ? { summary } : {}) });
    this.opts.log.append({ kind: "status", delegationId: d.id, status, ...(summary !== undefined ? { summary } : {}), timings: d.timings });
    turn.settle();
    return d;
  }

  /** Kevin's words to this thread, on its record. */
  utterance(item: TranscriptItem): void {
    this.opts.log.append({ kind: "utterance", item });
  }

  /** A line of Jarhead's own about this thread (spoken, or a status change), on its record. */
  system(symbol: string, text: string, mono?: string): void {
    this.opts.log.append({ kind: "system", at: this.now(), symbol, text, ...(mono !== undefined ? { mono } : {}) });
  }

  private replace(turn: ThreadTurn, next: Delegation): void {
    turn.delegation = next;
    const i = this.recent.findIndex((d) => d.id === next.id);
    if (i >= 0) this.recent[i] = next;
    this.opts.onChange?.(next);
  }

  private append(row: Parameters<Ledger["append"]>[0]): void {
    try {
      this.opts.ledger?.append(row);
    } catch (e) {
      log.warn(`row not written: ${(e as Error).message}`);
    }
  }
}
