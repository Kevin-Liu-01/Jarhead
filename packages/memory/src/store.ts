import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId as coreNewId } from "@jarhead/core";
import type { MemoryItem, MemoryKind, MemoryOrigin, MemorySource, MemoryState } from "@jarhead/protocol";
import { EmbeddingCache } from "./embed/cache.ts";
import type { Embedder } from "./embed/embedder.ts";
import { MAX_SUBJECTS, MAX_TEXT_CHARS } from "./limits.ts";
import { MemoryLog, applyRow, emptyState, replay, type ReplayState } from "./log.ts";
import type { Exclusion, ExtractorKind, ItemPatch, MemoryBy, MemoryRow, RunCounts, Watermark } from "./types.ts";

export interface StoreOptions {
  readonly dir: string;
  readonly now: () => number;
  readonly newId?: () => string;
}

export interface AddDraft {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly subjects?: readonly string[];
  readonly confidence: number;
  readonly importance: number;
  readonly origin: MemoryOrigin;
  readonly supersedes?: readonly string[];
}

interface IndexFile {
  readonly version: 1;
  readonly lines: number;
  readonly items: readonly MemoryItem[];
  readonly watermarks: readonly (readonly [string, Watermark])[];
  readonly exclusions: readonly Exclusion[];
  readonly consolidatedAt: number;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function cleanSubjects(subjects: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const s of subjects ?? []) {
    const t = s.toLowerCase().trim().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_SUBJECTS) break;
  }
  return out;
}

/**
 * The materialised view over memory.jsonl. Every verb appends its row first and
 * applies it second (a crash between the two is healed by replay); index.json is
 * a cache written atomically (tmp + rename) and trusted only while its line
 * count matches the log's — otherwise the log is replayed. The log is never
 * rewritten or truncated: Forget, Restore, Archive and Merge are states.
 */
export class MemoryStore {
  readonly dir: string;
  readonly log: MemoryLog;
  readonly cache: EmbeddingCache;
  private state: ReplayState = emptyState();
  private lines = 0;
  /** Malformed log lines skipped at the last load. */
  skipped = 0;
  /** True when the last load rebuilt the index from the log (missing, stale or corrupt index.json). */
  replayed = false;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(opts: StoreOptions) {
    this.dir = opts.dir;
    this.log = new MemoryLog(join(opts.dir, "memory.jsonl"));
    this.cache = new EmbeddingCache(opts.dir);
    this.now = opts.now;
    this.newId = opts.newId ?? (() => coreNewId("m"));
  }

  private get indexPath(): string {
    return join(this.dir, "index.json");
  }

  load(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const read = this.log.read();
    this.lines = read.lines;
    this.skipped = read.skipped;
    const cached = this.readIndex();
    if (cached && cached.lines === read.lines) {
      const state = emptyState();
      for (const it of cached.items) state.items.set(it.id, it);
      for (const [sid, wm] of cached.watermarks) state.watermarks.set(sid, wm);
      state.exclusions.push(...cached.exclusions);
      state.consolidatedAt = cached.consolidatedAt;
      this.state = state;
      this.replayed = false;
    } else {
      this.state = replay(read.rows);
      this.replayed = true;
      this.flush();
    }
    this.cache.load();
  }

  private readIndex(): IndexFile | undefined {
    try {
      if (!existsSync(this.indexPath)) return undefined;
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as Partial<IndexFile>;
      if (parsed.version !== 1 || typeof parsed.lines !== "number" || !Array.isArray(parsed.items) || !Array.isArray(parsed.watermarks)) return undefined;
      return { version: 1, lines: parsed.lines, items: parsed.items, watermarks: parsed.watermarks, exclusions: Array.isArray(parsed.exclusions) ? parsed.exclusions : [], consolidatedAt: typeof parsed.consolidatedAt === "number" ? parsed.consolidatedAt : 0 };
    } catch {
      return undefined; // a corrupt index is never an error: the log is the record
    }
  }

  /** Write index.json atomically. */
  flush(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file: IndexFile = {
      version: 1,
      lines: this.lines,
      items: [...this.state.items.values()],
      watermarks: [...this.state.watermarks.entries()],
      exclusions: this.state.exclusions,
      consolidatedAt: this.state.consolidatedAt,
    };
    const tmp = `${this.indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, this.indexPath);
  }

  private write(row: MemoryRow): void {
    this.log.append(row);
    this.lines++;
    applyRow(this.state, row);
  }

  // ------------------------------------------------------------------ reads ---

  /** Items in one state (default live), oldest first, ties by id — a stable order for every consumer. */
  items(state: MemoryState | "all" = "live"): MemoryItem[] {
    const out: MemoryItem[] = [];
    for (const it of this.state.items.values()) if (state === "all" || it.state === state) out.push(it);
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(id: string): MemoryItem | undefined {
    return this.state.items.get(id);
  }

  counts(): { live: number; forgotten: number; archived: number; merged: number } {
    const c = { live: 0, forgotten: 0, archived: 0, merged: 0 };
    for (const it of this.state.items.values()) c[it.state]++;
    return c;
  }

  watermark(sessionId: string): Watermark | undefined {
    return this.state.watermarks.get(sessionId);
  }

  /**
   * Forget-reflex windows. They apply by time to every session — the words Kevin
   * asked to forget were said in that window, whichever session id carries them;
   * `sessionId` on a window is a record of where he said it, not a filter.
   */
  exclusions(): readonly Exclusion[] {
    return this.state.exclusions;
  }

  get consolidatedAt(): number {
    return this.state.consolidatedAt;
  }

  get lineCount(): number {
    return this.lines;
  }

  bytes(): { log: number; embeddings: number } {
    return { log: this.log.bytes(), embeddings: this.cache.bytes() };
  }

  // ---------------------------------------------------------------- vectors ---

  /** The item's vector in this embedder's space, or undefined when it was never embedded there. */
  vectorFor(id: string, embedder: Embedder): Float32Array | undefined {
    const it = this.state.items.get(id);
    if (!it || embedder.dims === 0) return undefined;
    return this.cache.get(embedder.model, embedder.dims, EmbeddingCache.sha(it.text));
  }

  /** Embed through the cache: only misses reach the embedder (one call), and every result is kept. Throws what the embedder throws, before anything is written. */
  async embed(embedder: Embedder, texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (embedder.dims === 0) return texts.map(() => new Float32Array(0));
    const shas = texts.map((t) => EmbeddingCache.sha(t));
    const out: (Float32Array | undefined)[] = shas.map((s) => this.cache.get(embedder.model, embedder.dims, s));
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    const seen = new Set<string>();
    out.forEach((v, i) => {
      if (v || seen.has(shas[i]!)) return;
      seen.add(shas[i]!);
      missIdx.push(i);
      missTexts.push(texts[i]!);
    });
    if (missTexts.length > 0) {
      const vecs = await embedder.embed(missTexts, signal);
      missIdx.forEach((i, k) => {
        const v = vecs[k];
        if (v) this.cache.put(embedder.model, embedder.dims, shas[i]!, v);
      });
    }
    return shas.map((s) => this.cache.get(embedder.model, embedder.dims, s) ?? new Float32Array(0));
  }

  // ------------------------------------------------------------------ verbs ---

  add(draft: AddDraft, source: MemorySource): MemoryItem {
    const text = draft.text.trim().replace(/\s+/g, " ");
    if (text.length === 0) throw new RangeError("memory: empty text");
    if (text.length > MAX_TEXT_CHARS) throw new RangeError(`memory: text over ${MAX_TEXT_CHARS} chars`);
    const at = this.now();
    const item: MemoryItem = {
      id: this.newId(),
      kind: draft.kind,
      text,
      subjects: cleanSubjects(draft.subjects),
      confidence: clamp01(draft.confidence),
      importance: clamp01(draft.importance),
      createdAt: at,
      lastSeenAt: at,
      seenCount: 1,
      sources: [source],
      state: "live",
      ...(draft.supersedes && draft.supersedes.length > 0 ? { supersedes: [...draft.supersedes] } : {}),
      origin: draft.origin,
    };
    this.write({ at, op: "add", item });
    return this.state.items.get(item.id)!;
  }

  /**
   * Change an item; a text change keeps the previous words in the row. With a
   * source it also counts as seen again — unless `replaces` says the new words
   * reverse the old ones, when the evidence starts over (seenCount 1).
   */
  update(id: string, patch: ItemPatch, source?: MemorySource, opts?: { readonly replaces?: boolean }): MemoryItem | undefined {
    const it = this.state.items.get(id);
    if (!it) return undefined;
    const clean: ItemPatch = {
      ...(patch.text !== undefined ? { text: patch.text.trim().replace(/\s+/g, " ") } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.subjects !== undefined ? { subjects: cleanSubjects(patch.subjects) } : {}),
      ...(patch.confidence !== undefined ? { confidence: clamp01(patch.confidence) } : {}),
      ...(patch.importance !== undefined ? { importance: clamp01(patch.importance) } : {}),
    };
    if (clean.text !== undefined && (clean.text.length === 0 || clean.text.length > MAX_TEXT_CHARS)) throw new RangeError(`memory: text must be 1..${MAX_TEXT_CHARS} chars`);
    const textChanged = clean.text !== undefined && clean.text !== it.text;
    this.write({ at: this.now(), op: "update", id, patch: clean, ...(textChanged ? { prev: { text: it.text } } : {}), ...(source ? { source } : {}), ...(opts?.replaces && source ? { replaces: true } : {}) });
    return this.state.items.get(id);
  }

  touch(id: string, source: MemorySource, patch?: ItemPatch): MemoryItem | undefined {
    const it = this.state.items.get(id);
    if (!it) return undefined;
    const clean: ItemPatch | undefined = patch
      ? {
          ...(patch.confidence !== undefined ? { confidence: clamp01(patch.confidence) } : {}),
          ...(patch.importance !== undefined ? { importance: clamp01(patch.importance) } : {}),
          ...(patch.subjects !== undefined ? { subjects: cleanSubjects(patch.subjects) } : {}),
        }
      : undefined;
    this.write({ at: this.now(), op: "touch", id, source, ...(clean && Object.keys(clean).length > 0 ? { patch: clean } : {}) });
    return this.state.items.get(id);
  }

  /** Tombstone: hidden from Jarhead, kept in the record. */
  forget(id: string, by: MemoryBy, reason?: string): MemoryItem | undefined {
    const it = this.state.items.get(id);
    if (!it || it.state === "forgotten" || it.state === "merged") return undefined;
    this.write({ at: this.now(), op: "forget", id, by, ...(reason ? { reason } : {}) });
    return this.state.items.get(id);
  }

  restore(id: string): MemoryItem | undefined {
    const it = this.state.items.get(id);
    if (!it || (it.state !== "forgotten" && it.state !== "archived")) return undefined;
    this.write({ at: this.now(), op: "restore", id });
    return this.state.items.get(id);
  }

  /** Fold `id` into `into` (fold: same fact, evidence combines) or mark it superseded (fold false). */
  merge(id: string, into: string, fold: boolean): void {
    if (id === into || !this.state.items.has(id) || !this.state.items.has(into)) return;
    this.write({ at: this.now(), op: "merge", id, into, fold });
  }

  archive(id: string, why: "decay" | "cap"): void {
    const it = this.state.items.get(id);
    if (!it || it.state !== "live") return;
    this.write({ at: this.now(), op: "archive", id, why });
  }

  setWatermark(sessionId: string, upToAt: number, extractor: ExtractorKind, counts: RunCounts): void {
    this.write({ at: this.now(), op: "watermark", sessionId, upToAt, extractor, counts });
  }

  exclude(from: number, to: number, sessionId?: string): void {
    this.write({ at: this.now(), op: "exclude", from, to, ...(sessionId ? { sessionId } : {}) });
  }

  markConsolidated(pairs: number, merged: number, archived: number, embedded: number): void {
    this.write({ at: this.now(), op: "consolidated", pairs, merged, archived, embedded });
  }
}

