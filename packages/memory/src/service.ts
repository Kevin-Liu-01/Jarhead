import { logger, type Logger } from "@jarhead/core";
import { BRAIN_MEMORY_TOKENS, VOICE_MEMORY_TOKENS, type LedgerRow, type MemoryItem, type MemoryKind, type MemoryOrigin, type MemorySource, type MemoryState, type MemorySummary } from "@jarhead/protocol";
import { consolidate, type ConsolidateOptions, type ConsolidateResult } from "./consolidate.ts";
import { EmbeddingCache } from "./embed/cache.ts";
import { querySimilarityOf, type Embedder } from "./embed/embedder.ts";
import { tokenWeights } from "./embed/keyword.ts";
import { EmbedError } from "./embed/errors.ts";
import { ExtractUnavailableError, type Decider, type Extractor } from "./extract/extractor.ts";
import { buildExtractInput } from "./extract/input.ts";
import { RulesDecider, RulesExtractor, subjectsOf } from "./extract/rules.ts";
import { DEFER_MAX_TRIES, FORGET_RECENT_MS, MIN_NEW_KEVIN_LINES } from "./limits.ts";
import { mergeCandidates, postFilter } from "./merge.ts";
import { refuseReason, type Redact } from "./redact.ts";
import { renderBrainBlock, renderVoiceBlock, type Rendered } from "./render.ts";
import { retrieve, type Retrievable } from "./retrieve.ts";
import { MemoryStore } from "./store.ts";
import type { Candidate, ExtractInput, ExtractorKind, MemoryBy, MergeResult, RunCounts } from "./types.ts";
import { l2normalize } from "./vec.ts";

/** The delegation-time race: past this the block is built from words alone and the vector lands in the cache for next time. */
export const RETRIEVE_TIMEOUT_MS = 250;
/** Query vectors kept in memory by sha (Kevin's last heard lines are primed here as they land). */
export const QUERY_LRU = 64;
/** A long delta is read in this many slices per call; `more` on the result says the rest waits for another call. */
export const MAX_SLICES = 4;
const SEARCH_TIMEOUT_MS = 1000;

export interface MemoryServiceOptions {
  /** <stateDir>/memory */
  readonly dir: string;
  readonly now: () => number;
  readonly embedder: Embedder;
  readonly extractor: Extractor;
  /** Default: the rules decider (the Responses extractor is also a decider). */
  readonly decider?: Decider;
  /** The runner's redactor: `(s) => runner.redactor.redact(s)`. */
  readonly redact: Redact;
  /** The engine appends these to the ledger: ids only, never text. */
  readonly onRow?: (row: LedgerRow) => void;
  readonly newId?: () => string;
  readonly log?: Pick<Logger, "info" | "warn">;
  /** Runs when the primary extractor is unavailable for a run; default RulesExtractor. */
  readonly fallbackExtractor?: Extractor;
  readonly maxChars?: number;
  readonly retrieveTimeoutMs?: number;
}

export type IngestReason = "nothing-new" | "too-few-lines" | "trashed" | "embedding-failed";

export interface IngestOptions {
  readonly signal?: AbortSignal;
  /** Skip the MIN_NEW_KEVIN_LINES gate (Kevin pressed "Learn now"). */
  readonly force?: boolean;
  /** The chain is trashed: nothing is read. */
  readonly trashed?: boolean;
  readonly day?: string;
}

export interface IngestResult extends RunCounts {
  readonly status: "ran" | "skipped" | "deferred";
  readonly reason?: IngestReason;
  readonly extractor?: ExtractorKind;
  readonly ms: number;
  readonly upToAt?: number;
  /** Deferred: how many embedding attempts so far. */
  readonly tries?: number;
  /**
   * Rows past the watermark remain unread — the slice cap was hit, or a
   * deferral stopped the run mid-way. Call again (the bridge re-queues); the
   * four-line gate does not apply to the continuation of an approved run.
   */
  readonly more?: boolean;
}

export interface RememberResult {
  readonly item: MemoryItem;
  readonly op: "added" | "updated" | "noop";
}

interface Deferred {
  tries: number;
  readonly candidates: Candidate[];
  readonly upToAt: number;
  readonly extractor: ExtractorKind;
  readonly refused: number;
}

const zero: RunCounts = { added: 0, updated: 0, noop: 0, refused: 0 };
const byRecent = (a: MemoryItem, b: MemoryItem): number => b.lastSeenAt - a.lastSeenAt || (a.id < b.id ? -1 : 1);

/**
 * The façade the engine's MemoryBridge calls. Owns the store, runs extraction
 * (one closed conversation at a time, idempotent by watermark, deferred when the
 * embedder fails so vector spaces never mix), answers the two retrieval budgets,
 * and carries the Console's verbs. Nothing here opens a Live session, spends a
 * Codex turn or deletes a row; the ledger rows it emits carry ids only.
 *
 * Writers run one at a time (ingestSession, remember, consolidateStep queue
 * behind each other): a merge snapshots the live pool and then awaits the
 * decider, so a concurrent add would land as a twin it never saw. The sync
 * verbs (forget, restore, edit, forgetRecent) apply at once; a merge in flight
 * refreshes an item it touches from the store, so a forget between its awaits
 * is not undone.
 */
export class MemoryService {
  readonly store: MemoryStore;
  private readonly embedder: Embedder;
  private readonly extractor: Extractor;
  private readonly fallback: Extractor;
  private readonly decider: Decider;
  private readonly redact: Redact;
  private readonly onRow: ((row: LedgerRow) => void) | undefined;
  private readonly now: () => number;
  private readonly log: Pick<Logger, "info" | "warn">;
  private readonly maxChars: number | undefined;
  private readonly retrieveTimeoutMs: number;
  private readonly deferred = new Map<string, Deferred>();
  /** Sessions whose approved run has rows left to read (`more`): the gate does not judge them again. */
  private readonly continuing = new Set<string>();
  private readonly queryLru = new Map<string, Float32Array>();
  private readonly warned = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRunAt: number | undefined;
  private lastRun: MemorySummary["lastRun"];
  private budgetUsed = { brain: 0, voice: 0 };
  private lastUsedIds: string[] = [];
  private consolidateCursor = 0;

  constructor(opts: MemoryServiceOptions) {
    this.store = new MemoryStore({ dir: opts.dir, now: opts.now, ...(opts.newId ? { newId: opts.newId } : {}) });
    this.store.load();
    this.embedder = opts.embedder;
    this.extractor = opts.extractor;
    this.fallback = opts.fallbackExtractor ?? new RulesExtractor();
    this.decider = opts.decider ?? new RulesDecider();
    this.redact = opts.redact;
    this.onRow = opts.onRow;
    this.now = opts.now;
    this.log = opts.log ?? logger("memory");
    this.maxChars = opts.maxChars;
    this.retrieveTimeoutMs = opts.retrieveTimeoutMs ?? RETRIEVE_TIMEOUT_MS;
  }

  /** How items are matched, for the Console: the embedder's kind — OpenAI vectors, a local model's, or words. The test embedder reports `openai` (it pins OpenAI-scale cosines). */
  embeddings(): "openai" | "local" | "keyword" {
    if (this.embedder.dims === 0) return "keyword";
    return this.embedder.kind === "local" ? "local" : "openai";
  }

  private emit(row: LedgerRow): void {
    try {
      this.onRow?.(row);
    } catch {
      // the audit row is best effort; the store is the record
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(message);
  }

  /** One writer at a time; a failure in one never blocks the next. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ------------------------------------------------------------- extraction ---

  /**
   * Read one session's ledger rows past its watermark and learn from them.
   * Idempotent: a second call over the same rows finds nothing new. Runs only
   * when ≥ MIN_NEW_KEVIN_LINES of Kevin's are new (unless forced, or the call
   * continues an approved run). An embedding failure defers the run — the
   * candidates are kept in memory and retried on the next call (≤
   * DEFER_MAX_TRIES), then land without vectors; slices committed before the
   * failure get their run row at once, and the rows after it are read when the
   * deferred slice lands. `more` says rows remain: call again.
   */
  ingestSession(sessionId: string, rows: readonly LedgerRow[], opts: IngestOptions = {}): Promise<IngestResult> {
    return this.serial(() => this.ingest(sessionId, rows, opts));
  }

  private async ingest(sessionId: string, rows: readonly LedgerRow[], opts: IngestOptions): Promise<IngestResult> {
    const t0 = this.now();
    if (opts.trashed) return { ...zero, status: "skipped", reason: "trashed", ms: 0 };

    let totals: RunCounts = zero;
    let kind: ExtractorKind | undefined;
    let upToAt: number | undefined;
    let slice = 0;
    const pending = this.deferred.get(sessionId);
    if (pending) {
      const landed = await this.land(sessionId, pending, opts.signal);
      if ("deferred" in landed) return { ...zero, status: "deferred", reason: "embedding-failed", extractor: pending.extractor, ms: this.now() - t0, tries: pending.tries, more: true };
      totals = landed.counts;
      kind = pending.extractor;
      upToAt = pending.upToAt;
      slice = 1;
    }

    let more = false;
    for (; slice < MAX_SLICES; slice++) {
      const wm = this.store.watermark(sessionId)?.upToAt;
      const input = buildExtractInput(rows, {
        ...(opts.day ? { day: opts.day } : {}),
        ...(wm !== undefined ? { sinceAt: wm } : {}),
        exclusions: this.store.exclusions(),
        redact: this.redact,
        refuse: (s) => refuseReason(s),
        ...(this.maxChars !== undefined ? { maxChars: this.maxChars } : {}),
      });
      if (input.lines.length === 0 && input.requests.length === 0) {
        more = false;
        break;
      }
      // The gate judges the whole pending delta once, at the first slice of a fresh run; the rest of an
      // approved run — later slices, a continuation after `more`, a landed deferral — is never gated.
      if (slice === 0 && !opts.force && !this.continuing.has(sessionId) && input.pendingKevinLines < MIN_NEW_KEVIN_LINES) {
        return { ...zero, status: "skipped", reason: "too-few-lines", ms: this.now() - t0 };
      }

      let raw: Candidate[];
      let used: ExtractorKind = this.extractor.kind;
      try {
        raw = await this.extractor.extract(input, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (!(e instanceof ExtractUnavailableError)) throw e;
        const message = `${this.extractor.kind} extractor unavailable (${e.code}: ${e.message}); using rules for this run`;
        // A 400 is a configuration fault (the model id, the schema), not a transient: say so every run until it is fixed.
        if (e.code === "http" && e.status === 400) this.log.warn(`${message} — HTTP 400 is a configuration fault, not a transient; check JARHEAD_MEMORY_MODEL and the doctor`);
        else this.warnOnce(`extract:${e.code}`, message);
        raw = await this.fallback.extract(input, opts.signal);
        used = this.fallback.kind;
      }

      const { candidates, refused } = this.filter(sessionId, input, raw);
      let merged: MergeResult;
      try {
        merged = await this.merge(sessionId, candidates, input.upToAt, opts.signal);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (!(e instanceof EmbedError)) throw e;
        this.deferred.set(sessionId, { tries: 1, candidates, upToAt: input.upToAt, extractor: used, refused });
        this.continuing.add(sessionId);
        const ms = this.now() - t0;
        // The slices already committed are a run of their own: their row lands now, not when the tail does.
        if (kind !== undefined) this.finishRun(sessionId, kind, totals, ms);
        this.log.info(`memory: embedding failed (${e.code}); run over ${sessionId} deferred (try 1 of ${DEFER_MAX_TRIES})`);
        return { ...totals, status: "deferred", reason: "embedding-failed", extractor: used, ms, tries: 1, more: true };
      }
      totals = sum(totals, this.commit(sessionId, input.upToAt, used, merged, refused));
      kind = used;
      upToAt = input.upToAt;
      if (!input.truncated) {
        more = false;
        break;
      }
      more = true;
    }

    if (kind === undefined) {
      this.continuing.delete(sessionId);
      return { ...zero, status: "skipped", reason: "nothing-new", ms: this.now() - t0 };
    }
    if (more) this.continuing.add(sessionId);
    else this.continuing.delete(sessionId);
    const ms = this.now() - t0;
    this.finishRun(sessionId, kind, totals, ms);
    return { ...totals, status: "ran", extractor: kind, ms, ...(upToAt !== undefined ? { upToAt } : {}), ...(more ? { more: true } : {}) };
  }

  /** The post-filter over one slice's raw candidates; each keeps the Kevin line it cites as its source. */
  private filter(sessionId: string, input: ExtractInput, raw: readonly Candidate[]): { candidates: Candidate[]; refused: number } {
    const kevinLines = new Set(input.lines.filter((l) => l.speaker === "Kevin").map((l) => l.n));
    const lineAt = new Map(input.lines.map((l) => [l.n, l.at] as const));
    const candidates: Candidate[] = [];
    let refused = 0;
    for (const c of raw) {
      const f = postFilter(c, { kevinLines });
      if ("refused" in f) {
        refused++;
        continue;
      }
      const firstKevin = f.ok.evidence.find((n) => kevinLines.has(n));
      const at = firstKevin !== undefined ? (lineAt.get(firstKevin) ?? input.upToAt) : input.upToAt;
      candidates.push({ ...f.ok, source: { sessionId, at, type: "heard" }, origin: f.ok.origin ?? "extracted" });
    }
    return { candidates, refused };
  }

  private async merge(sessionId: string, candidates: Candidate[], upToAt: number, signal: AbortSignal | undefined, withVectors = true): Promise<MergeResult> {
    const source: MemorySource = { sessionId, at: upToAt, type: "heard" };
    return mergeCandidates(this.store, candidates, this.embedder, this.decider, { now: this.now(), source, ...(signal ? { signal } : {}), withVectors });
  }

  /** Apply a merge result: watermark, audit rows, index. */
  private commit(sessionId: string, upToAt: number, kind: ExtractorKind, merged: MergeResult, refused: number): RunCounts {
    const counts: RunCounts = { added: merged.added, updated: merged.updated, noop: merged.noop, refused };
    this.store.setWatermark(sessionId, upToAt, kind, counts);
    const at = this.now();
    for (const id of merged.addedIds) {
      const it = this.store.get(id);
      if (it) this.emit({ at, type: "memory.added", id, kind: it.kind, origin: it.origin });
    }
    for (const id of merged.updatedIds) this.emit({ at, type: "memory.updated", id });
    this.store.flush();
    return counts;
  }

  private finishRun(sessionId: string, kind: ExtractorKind, counts: RunCounts, ms: number): void {
    const at = this.now();
    this.lastRunAt = at;
    this.lastRun = { extractor: kind, ...counts, ms };
    this.emit({ at, type: "memory.run", sessionId, extractor: kind, ...counts, ms });
    this.log.info(`learned ${counts.added} · updated ${counts.updated} · noop ${counts.noop} · refused ${counts.refused} · ${(ms / 1000).toFixed(1)} s · ${kind}`);
  }

  /** Retry a deferred slice's embedding; after DEFER_MAX_TRIES it lands by words alone. The caller reads on from there. */
  private async land(sessionId: string, d: Deferred, signal?: AbortSignal): Promise<{ readonly counts: RunCounts } | { readonly deferred: true }> {
    d.tries++;
    let merged: MergeResult;
    try {
      merged = await this.merge(sessionId, d.candidates, d.upToAt, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (!(e instanceof EmbedError)) throw e;
      if (d.tries < DEFER_MAX_TRIES) {
        this.log.info(`memory: embedding failed again (${e.code}); run over ${sessionId} deferred (try ${d.tries} of ${DEFER_MAX_TRIES})`);
        return { deferred: true };
      }
      this.warnOnce("embed:gave-up", `memory: embeddings failed ${d.tries} times; landing ${d.candidates.length} items without vectors (matched by words until the next consolidation)`);
      merged = await this.merge(sessionId, d.candidates, d.upToAt, signal, false);
    }
    this.deferred.delete(sessionId);
    return { counts: this.commit(sessionId, d.upToAt, d.extractor, merged, d.refused) };
  }

  /** Sessions whose run waits for a working embedder. */
  deferredSessions(): string[] {
    return [...this.deferred.keys()];
  }

  /** Sessions with rows left to read after `more` (or a deferral); the gate skips them. */
  continuingSessions(): string[] {
    return [...this.continuing];
  }

  // -------------------------------------------------------------- retrieval ---

  private lruSet(sha: string, vec: Float32Array): void {
    this.queryLru.delete(sha);
    this.queryLru.set(sha, vec);
    if (this.queryLru.size > QUERY_LRU) {
      const first = this.queryLru.keys().next().value;
      if (first !== undefined) this.queryLru.delete(first);
    }
  }

  /** Embed a line Kevin just said so the delegation-time query is a cache hit; never throws. */
  async prime(text: string): Promise<void> {
    const q = text.trim();
    if (!q || this.embedder.dims === 0) return;
    const sha = EmbeddingCache.sha(q);
    if (this.queryLru.has(sha)) return;
    try {
      const [v] = await this.embedder.embed([q]);
      if (v && v.length === this.embedder.dims) this.lruSet(sha, v);
    } catch {
      // no key or no network: retrieval falls back to words
    }
  }

  private retrievable(): Retrievable[] {
    return this.store.items("live").map((it) => {
      const vec = this.store.vectorFor(it.id, this.embedder);
      return vec ? { ...it, vec } : it;
    });
  }

  /**
   * The delegator asks with `${request}\n${kevinRecent}` — the request (often
   * one heard line, sometimes several joined) above Kevin's recent lines, one
   * per line — and the bridge primed every heard line as it landed. The primed
   * lines compose the query's vector (the normalised sum), so the delegation
   * path touches no network; only a query with no primed line races the embedder.
   */
  private composeFromLines(q: string): Float32Array | undefined {
    const lines = [...new Set(q.split("\n").map((s) => s.trim()).filter(Boolean))];
    if (lines.length < 2) return undefined;
    const parts: Float32Array[] = [];
    for (const line of lines) {
      const v = this.queryLru.get(EmbeddingCache.sha(line));
      if (v) parts.push(v);
    }
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    const sum = new Float32Array(this.embedder.dims);
    for (const p of parts) for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! + (p[i] ?? 0);
    return l2normalize(sum);
  }

  private async queryVector(q: string, timeoutMs: number, signal?: AbortSignal): Promise<Float32Array | undefined> {
    if (this.embedder.dims === 0) return undefined;
    const sha = EmbeddingCache.sha(q);
    const hit = this.queryLru.get(sha);
    if (hit) return hit;
    const composed = this.composeFromLines(q);
    if (composed) {
      this.lruSet(sha, composed);
      return composed;
    }
    const embed = this.embedder
      .embed([q], signal)
      .then((v) => {
        const x = v[0];
        if (x && x.length === this.embedder.dims) this.lruSet(sha, x);
        return x;
      })
      .catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((r) => {
      timer = setTimeout(() => r(undefined), timeoutMs);
    });
    try {
      return await Promise.race([embed, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The per-delegation block (≤ BRAIN_MEMORY_TOKENS) for `query` = Kevin's
   * request and recent lines. Bounded: the query vector comes from the LRU (a
   * primed line, or the lines' composition) or a race against
   * `retrieveTimeoutMs`; past it the block is ranked by words and the vector
   * lands for the next turn. Records what was used for the Now rail.
   */
  async retrieveForBrain(query: string, opts: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<Rendered> {
    const items = this.retrievable();
    if (items.length === 0) return { tokens: 0, ids: [] };
    const q = query.trim();
    const vec = q ? await this.queryVector(q, opts.timeoutMs ?? this.retrieveTimeoutMs, opts.signal) : undefined;
    const r = retrieve(items, { ...(q ? { query: { text: q, vec } } : {}), embedder: this.embedder, now: this.now(), budgetTokens: BRAIN_MEMORY_TOKENS });
    const block = renderBrainBlock(r.picked, BRAIN_MEMORY_TOKENS);
    this.lastUsedIds = block.ids.slice(0, 8);
    this.budgetUsed = { ...this.budgetUsed, brain: block.tokens };
    return block;
  }

  /** The once-per-session voice block (≤ VOICE_MEMORY_TOKENS); synchronous, from the index. */
  retrieveForVoice(): Rendered {
    const items = this.retrievable();
    if (items.length === 0) return { tokens: 0, ids: [] };
    const r = retrieve(items, { embedder: this.embedder, now: this.now(), budgetTokens: VOICE_MEMORY_TOKENS });
    const block = renderVoiceBlock(r.picked, VOICE_MEMORY_TOKENS);
    this.budgetUsed = { ...this.budgetUsed, voice: block.tokens };
    return block;
  }

  // ------------------------------------------------------------------ verbs ---

  /**
   * "Remember that …" (spoken, origin kevin) or a Console/CLI add: classified
   * by the rules, redacted and refused like every candidate, then merged so a
   * repeat is a touch, not a twin. Undefined = refused (a secret shape, or the
   * redactor changed it).
   */
  remember(text: string, kind?: MemoryKind, origin: MemoryOrigin = "kevin"): Promise<RememberResult | undefined> {
    return this.serial(() => this.rememberNow(text, kind, origin));
  }

  private async rememberNow(text: string, kind: MemoryKind | undefined, origin: MemoryOrigin): Promise<RememberResult | undefined> {
    const line = text.trim().replace(/\s+/g, " ");
    if (!line || this.redact(line) !== line) return undefined;
    const classified = RulesExtractor.classify(line);
    const c: Candidate = classified
      ? { ...classified, ...(kind ? { kind } : {}), origin }
      : { kind: kind ?? "fact", text: line, subjects: subjectsOf(line), importance: 0.9, confidence: 0.9, evidence: [], origin };
    const f = postFilter(c, { requireEvidence: false });
    if ("refused" in f) return undefined;
    const at = this.now();
    const source: MemorySource = { at, type: origin === "kevin" ? "kevin" : "tool" };
    let merged: MergeResult;
    try {
      merged = await mergeCandidates(this.store, [{ ...f.ok, source }], this.embedder, this.decider, { now: at, source });
    } catch (e) {
      if (!(e instanceof EmbedError)) throw e;
      merged = await mergeCandidates(this.store, [{ ...f.ok, source }], this.embedder, this.decider, { now: at, source, withVectors: false });
    }
    const id = merged.addedIds[0] ?? merged.updatedIds[0] ?? merged.touchedIds[0];
    const item = id ? this.store.get(id) : undefined;
    if (!item) return undefined;
    if (merged.addedIds[0]) this.emit({ at, type: "memory.added", id: item.id, kind: item.kind, origin: item.origin });
    else if (merged.updatedIds[0]) this.emit({ at, type: "memory.updated", id: item.id });
    this.store.flush();
    return { item, op: merged.addedIds[0] ? "added" : merged.updatedIds[0] ? "updated" : "noop" };
  }

  /**
   * "Forget that": tombstone every live item said in the last `ms` (a source in
   * the window; or, for `sessionId`, added from it in the window) and write the
   * window so the next run cannot re-learn it. Returns how many.
   */
  forgetRecent(ms: number = FORGET_RECENT_MS, sessionId?: string): number {
    const to = this.now();
    const from = to - ms;
    let n = 0;
    for (const it of this.store.items("live")) {
      const said = it.sources.some((s) => s.at >= from && s.at <= to);
      const learned = sessionId !== undefined && it.createdAt >= from && it.sources.some((s) => s.sessionId === sessionId);
      if (!said && !learned) continue;
      if (!this.store.forget(it.id, "reflex", "forget that")) continue;
      this.emit({ at: to, type: "memory.forgotten", id: it.id, by: "reflex" });
      n++;
    }
    this.store.exclude(from, to, sessionId);
    this.store.flush();
    return n;
  }

  forget(id: string, by: MemoryBy): boolean {
    const it = this.store.forget(id, by);
    if (!it) return false;
    this.emit({ at: this.now(), type: "memory.forgotten", id, by });
    this.store.flush();
    return true;
  }

  restore(id: string): boolean {
    const it = this.store.restore(id);
    if (!it) return false;
    this.emit({ at: this.now(), type: "memory.restored", id });
    this.store.flush();
    return true;
  }

  /** Kevin's own words for an item; the same redaction and refusal as an add. */
  edit(id: string, text: string, kind?: MemoryKind): boolean {
    const it = this.store.get(id);
    if (!it) return false;
    const line = text.trim().replace(/\s+/g, " ");
    if (!line || line.length > 200 || this.redact(line) !== line) return false;
    if (refuseReason(line, { kind: kind ?? it.kind, origin: it.origin })) return false;
    this.store.update(id, { text: line, ...(kind ? { kind } : {}) });
    this.emit({ at: this.now(), type: "memory.updated", id });
    this.store.flush();
    return true;
  }

  /** Newest first; never carries a vector. */
  list(state: MemoryState | "all" = "live", limit = 50): MemoryItem[] {
    return this.store.items(state).sort(byRecent).slice(0, Math.max(0, limit));
  }

  /** Ranked by similarity (vector when the query embeds in time, else the query's coverage of the item's words) plus an exact-substring bonus. */
  async search(query: string, limit = 30, state: MemoryState | "all" = "live"): Promise<MemoryItem[]> {
    const q = query.trim();
    if (!q) return this.list(state, limit);
    const vec = await this.queryVector(q, SEARCH_TIMEOUT_MS);
    const needle = q.toLowerCase();
    const pool = this.store.items(state);
    const weight = tokenWeights(pool.map((it) => it.text));
    const scored = pool.map((it) => {
      const sim = querySimilarityOf(this.embedder, { text: q, vec }, { text: it.text, vec: this.store.vectorFor(it.id, this.embedder) }, weight);
      const sub = it.text.toLowerCase().includes(needle) ? 1 : 0;
      return { it, score: Math.max(0, sim) + sub };
    });
    return scored
      .filter((s) => s.score >= 0.1)
      .sort((a, b) => b.score - a.score || byRecent(a.it, b.it))
      .slice(0, Math.max(0, limit))
      .map((s) => s.it);
  }

  summary(): Omit<MemorySummary, "enabled" | "pending"> {
    const c = this.store.counts();
    return {
      count: c.live,
      forgotten: c.forgotten,
      archived: c.archived,
      embeddings: this.embeddings(),
      ...(this.embedder.dims > 0 ? { embeddingModel: this.embedder.model, embeddingDims: this.embedder.dims } : {}),
      ...(this.lastRunAt !== undefined ? { lastRunAt: this.lastRunAt } : {}),
      ...(this.lastRun ? { lastRun: this.lastRun } : {}),
      budgetUsed: { ...this.budgetUsed },
      lastUsedIds: [...this.lastUsedIds],
    };
  }

  /** One slice of housekeeping (a quiet tick's worth); the cursor carries across calls. A no-op writes nothing — not a row, not the index. */
  consolidateStep(opts: Omit<ConsolidateOptions, "cursor"> = {}): Promise<ConsolidateResult> {
    return this.serial(async () => {
      const r = await consolidate(this.store, this.embedder, this.now(), { ...opts, cursor: this.consolidateCursor });
      this.consolidateCursor = r.done ? 0 : r.cursor;
      if (r.wrote) this.store.flush();
      return r;
    });
  }

  /**
   * After an embedder change: live items with no vector in the current space
   * are embedded through the cache, `limit` at a time (only the misses reach
   * the model; every hit is kept). Returns how many were embedded, 0 when every
   * live item has a vector — the bridge calls this at quiet ticks until then, so
   * a switch of brain heals in minutes. Throws what the embedder throws.
   */
  reembed(limit = 96): Promise<number> {
    return this.serial(async () => {
      if (this.embedder.dims === 0) return 0;
      const missing = this.store.items("live").filter((it) => !this.store.vectorFor(it.id, this.embedder)).slice(0, Math.max(0, limit));
      if (missing.length === 0) return 0;
      await this.store.embed(this.embedder, missing.map((it) => it.text));
      return missing.filter((it) => this.store.vectorFor(it.id, this.embedder)).length;
    });
  }

  flush(): void {
    this.store.flush();
  }
}

function sum(a: RunCounts, b: RunCounts): RunCounts {
  return { added: a.added + b.added, updated: a.updated + b.updated, noop: a.noop + b.noop, refused: a.refused + b.refused };
}
