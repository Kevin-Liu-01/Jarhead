import type { MemoryItem, MemoryKind, MemorySource } from "@jarhead/protocol";
import { compare, thresholdsFor, type Embedded, type Embedder } from "./embed/embedder.ts";
import { EmbedError } from "./embed/openai.ts";
import type { Decider } from "./extract/extractor.ts";
import { MAX_SUBJECTS, MAX_TEXT_CHARS } from "./limits.ts";
import { normalizeText, refuseReason } from "./redact.ts";
import type { MemoryStore } from "./store.ts";
import type { Candidate, Decision, MergeResult, Neighbour } from "./types.ts";

const KINDS: ReadonlySet<string> = new Set<MemoryKind>(["preference", "fact", "episode", "procedure", "contact", "place"]);
/** Facts, preferences, contacts and places describe the same world and are matched across kinds; episodes and procedures only within their own. */
const CROSS_KIND: ReadonlySet<MemoryKind> = new Set<MemoryKind>(["fact", "preference", "contact", "place"]);
const NEIGHBOURS = 3;

/** Two independent pieces of evidence: 1 − (1−a)(1−b). */
export function combineConfidence(a: number, b: number): number {
  return 1 - (1 - a) * (1 - b);
}

/** Cut at the last sentence end inside `max` characters; undefined when there is none worth keeping. */
export function trimSentence(text: string, max = MAX_TEXT_CHARS): string | undefined {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) if (m.index !== undefined && m.index >= 20) cut = m.index;
  return cut > 0 ? head.slice(0, cut + 1) : undefined;
}

export function unionSubjects(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of [...a, ...b]) {
    const t = s.toLowerCase().trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_SUBJECTS) break;
  }
  return out;
}

export interface PostFilterOptions {
  /** Line numbers that are Kevin's; a candidate must cite one (extractor runs). */
  readonly kevinLines?: ReadonlySet<number>;
  /** False for an explicit "remember" or a Console add, which have no transcript. */
  readonly requireEvidence?: boolean;
}

/**
 * The gate every candidate passes before the store sees it: a valid kind, a
 * sentence of ≤ 200 chars (cut at a sentence end or refused), evidence that
 * cites a Kevin line, importance on 0..1 (the schema's 1..5 divided), and none
 * of memory's refusal shapes. Returns the clean candidate or why it was refused.
 */
export function postFilter(c: Candidate, opts: PostFilterOptions = {}): { readonly ok: Candidate } | { readonly refused: string } {
  if (!KINDS.has(c.kind)) return { refused: "unknown kind" };
  if (typeof c.text !== "string") return { refused: "no text" };
  const text = trimSentence(c.text);
  if (!text || text.length < 4) return { refused: text === undefined ? `over ${MAX_TEXT_CHARS} chars` : "too short" };
  if (opts.requireEvidence !== false) {
    const kevin = opts.kevinLines ?? new Set<number>();
    if (!Array.isArray(c.evidence) || !c.evidence.some((n) => kevin.has(n))) return { refused: "no Kevin line cited" };
  }
  const why = refuseReason(text, { kind: c.kind, ...(c.origin ? { origin: c.origin } : {}) });
  if (why) return { refused: why };
  const rawImportance = typeof c.importance === "number" && Number.isFinite(c.importance) ? c.importance : 0.5;
  const importance = Math.min(1, Math.max(0, rawImportance > 1 ? rawImportance / 5 : rawImportance));
  const confidence = Math.min(1, Math.max(0, typeof c.confidence === "number" && Number.isFinite(c.confidence) ? c.confidence : 0.5));
  const subjects = unionSubjects(Array.isArray(c.subjects) ? c.subjects.filter((s): s is string => typeof s === "string") : [], []);
  return { ok: { ...c, text, importance, confidence, subjects, evidence: Array.isArray(c.evidence) ? c.evidence : [] } };
}

export interface MergeOptions {
  readonly now: number;
  /** Where the words came from, for candidates that carry no source of their own. */
  readonly source: MemorySource;
  readonly signal?: AbortSignal;
  /** False after an embedding has failed three times: items land without a vector and match by words only. */
  readonly withVectors?: boolean;
}

interface Pooled {
  readonly item: MemoryItem;
  readonly vec: Float32Array | undefined;
}

function compatible(a: MemoryKind, b: MemoryKind): boolean {
  return a === b || (CROSS_KIND.has(a) && CROSS_KIND.has(b));
}

/** The closest live items, each tagged with the space its similarity is on (a vector-less item compares by words). */
function neighboursOf(pool: ReadonlyMap<string, Pooled>, c: Candidate, cand: Embedded, embedder: Embedder): Neighbour[] {
  const out: Neighbour[] = [];
  for (const p of pool.values()) {
    if (!compatible(c.kind, p.item.kind)) continue;
    const { sim, space } = compare(embedder, cand, { text: p.item.text, vec: p.vec });
    if (sim <= 0) continue;
    out.push({ item: p.item, sim, space });
  }
  out.sort((a, b) => b.sim - a.sim || (a.item.id < b.item.id ? -1 : 1));
  return out.slice(0, NEIGHBOURS);
}

/**
 * The write path (Mem0/Letta-style ADD / UPDATE / NOOP), one candidate at a time
 * against the live items, with the thresholds of the space the top neighbour
 * was compared in — the embedder's table for vectors, the keyword table when
 * either side has only words (a deferred run's leftovers, keyword mode):
 *   ≥ update  same words → touch (seen again); different words → the decider
 *             (rules mode: newest wins, the old text kept as `prev`)
 *   ≥ band    the decider
 *   below     a new item
 * A decider that says the candidate reverses an item adds the new one with
 * `supersedes` and marks the old one merged; an UPDATE it marks `replaces`
 * takes the candidate's confidence and restarts the count instead of folding
 * evidence onto words nobody said. Items added during the run join the pool,
 * so two near-identical candidates in one batch collapse to one add and one
 * touch. Embedding runs first and its failure throws before anything is
 * written — the service defers the run rather than mixing vector spaces.
 */
export async function mergeCandidates(store: MemoryStore, candidates: readonly Candidate[], embedder: Embedder, decider: Decider, opts: MergeOptions): Promise<MergeResult> {
  const texts = candidates.map((c) => c.text);
  let vecs: (Float32Array | undefined)[];
  if (opts.withVectors === false || embedder.dims === 0) vecs = texts.map(() => undefined);
  else {
    try {
      vecs = await store.embed(embedder, texts, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted || e instanceof EmbedError) throw e;
      throw new EmbedError("http", (e as Error).message);
    }
  }

  const pool = new Map<string, Pooled>();
  for (const it of store.items("live")) pool.set(it.id, { item: it, vec: store.vectorFor(it.id, embedder) });
  const refresh = (id: string): void => {
    const it = store.get(id);
    if (it && it.state === "live") pool.set(id, { item: it, vec: store.vectorFor(id, embedder) });
    else pool.delete(id);
  };
  let added = 0;
  let updated = 0;
  let noop = 0;
  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  const touchedIds: string[] = [];

  const touch = (target: MemoryItem, c: Candidate, source: MemorySource): void => {
    store.touch(target.id, source, { confidence: combineConfidence(target.confidence, c.confidence), importance: Math.max(target.importance, c.importance), subjects: unionSubjects(target.subjects, c.subjects) });
    noop++;
    touchedIds.push(target.id);
    refresh(target.id);
  };
  const add = (c: Candidate, source: MemorySource, vec: Float32Array | undefined, supersedes?: string): void => {
    const item = store.add({ kind: c.kind, text: c.text, subjects: c.subjects, confidence: c.confidence, importance: c.importance, origin: c.origin ?? "extracted", ...(supersedes ? { supersedes: [supersedes] } : {}) }, source);
    if (supersedes) {
      store.merge(supersedes, item.id, false);
      pool.delete(supersedes);
    }
    pool.set(item.id, { item, vec });
    added++;
    addedIds.push(item.id);
  };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const v = vecs[i];
    const cand: Embedded = { text: c.text, vec: v && v.length === embedder.dims && embedder.dims > 0 ? v : undefined };
    const source = c.source ?? opts.source;
    const N = neighboursOf(pool, c, cand, embedder);
    const top = N[0];
    const s = top?.sim ?? 0;
    const T = thresholdsFor(embedder, top?.space);

    if (top && s >= T.update && normalizeText(top.item.text) === normalizeText(c.text)) {
      touch(top.item, c, source);
      continue;
    }
    let d: Decision = { op: "ADD" };
    if (top && s >= T.band) d = await decider.decide(c, N, { thresholds: T, now: opts.now, ...(opts.signal ? { signal: opts.signal } : {}) });
    const target = d.target && pool.has(d.target) ? d.target : top?.item.id;
    const targetItem = target ? pool.get(target)?.item : undefined;

    if (d.op === "NOOP" && targetItem) {
      touch(targetItem, c, source);
    } else if (d.op === "UPDATE" && targetItem) {
      const proposed = d.text?.trim().replace(/\s+/g, " ");
      const text = proposed && proposed.length >= 4 && proposed.length <= MAX_TEXT_CHARS && !refuseReason(proposed, { kind: targetItem.kind }) ? proposed : c.text;
      // A reversal keeps the item (and its history) but not its evidence: one utterance supports the new words.
      const replaces = d.replaces === true && normalizeText(text) !== normalizeText(targetItem.text);
      store.update(
        targetItem.id,
        { text, confidence: replaces ? c.confidence : combineConfidence(targetItem.confidence, c.confidence), importance: Math.max(targetItem.importance, c.importance), subjects: unionSubjects(targetItem.subjects, c.subjects) },
        source,
        replaces ? { replaces: true } : undefined,
      );
      updated++;
      updatedIds.push(targetItem.id);
      refresh(targetItem.id);
    } else {
      add(c, source, cand.vec, d.contradicts && targetItem ? targetItem.id : undefined);
    }
  }

  return { added, updated, noop, refused: 0, addedIds, updatedIds, touchedIds };
}
