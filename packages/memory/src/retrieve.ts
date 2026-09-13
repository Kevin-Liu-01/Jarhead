import type { MemoryItem, MemoryKind } from "@jarhead/protocol";
import { querySimilarityOf, similarityOf, type Embedded, type Embedder } from "./embed/embedder.ts";
import { tokenWeights, type TokenWeight } from "./embed/keyword.ts";
import { estimateTokens } from "./tokens.ts";

/** Recency half-lives in days; undefined = never decays (how Kevin likes things does not go stale). */
export const HALF_LIFE_DAYS: Readonly<Record<MemoryKind, number | undefined>> = {
  episode: 30,
  fact: 180,
  contact: 365,
  place: 365,
  preference: undefined,
  procedure: undefined,
};
export const SCORE_FLOOR = 0.12;
export const MMR_LAMBDA = 0.7;
/** The pinned lane (standing preferences and procedures) may take this share of the budget. */
export const PINNED_SHARE = 0.4;
const DAY_MS = 86_400_000;

export function recency(item: MemoryItem, now: number): number {
  const h = HALF_LIFE_DAYS[item.kind];
  if (h === undefined) return 1;
  const ageDays = Math.max(0, now - item.lastSeenAt) / DAY_MS;
  return Math.pow(0.5, ageDays / h);
}

/** Importance never zeroes an item: 0.5 + 0.5 · importance. */
export function importanceFactor(item: MemoryItem): number {
  return 0.5 + 0.5 * item.importance;
}

/** Repeated evidence, up to +50 %. */
export function seenFactor(item: MemoryItem): number {
  return 1 + 0.1 * Math.min(Math.max(item.seenCount - 1, 0), 5);
}

/** rec · imp · conf · seen — the query-free score. */
export function baseScore(item: MemoryItem, now: number): number {
  return recency(item, now) * importanceFactor(item) * item.confidence * seenFactor(item);
}

/** Always worth carrying: a strong preference or procedure seen twice, or one Kevin asked to remember. */
export function isPinned(item: MemoryItem): boolean {
  return item.state === "live" && (item.kind === "preference" || item.kind === "procedure") && item.importance >= 0.8 && (item.seenCount >= 2 || item.origin === "kevin");
}

/** One item's cost in the block: its text and a newline. */
export function itemTokens(item: MemoryItem): number {
  return estimateTokens(item.text) + 1;
}

export type Retrievable = MemoryItem & { readonly vec?: Float32Array | undefined };

export interface RetrieveOptions {
  /** The words Kevin just said (and their vector when it is already known); absent for the voice block. */
  readonly query?: { readonly text: string; readonly vec?: Float32Array | undefined };
  readonly embedder: Embedder;
  readonly now: number;
  readonly budgetTokens: number;
  readonly lambda?: number;
  readonly floor?: number;
  readonly pinnedShare?: number;
}

export interface Retrieved {
  readonly picked: MemoryItem[];
  /** Estimated tokens of the picked texts (the renderer measures the real block). */
  readonly tokens: number;
  readonly pinned: number;
}

const byId = (a: MemoryItem, b: MemoryItem): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function stripVec(r: Retrievable): MemoryItem {
  const { vec: _vec, ...item } = r;
  return item;
}

/**
 * What goes into a prompt, under a token budget: the pinned lane first (≤ 40 %
 * of the budget), then the query lane — score = sim · rec · imp · conf · seen,
 * floor 0.12, picked greedily by MMR (λ 0.7) so two near-duplicates do not both
 * spend budget. With no query the lane ranks by rec · imp · conf · seen.
 *
 * `sim` is the query vector against the item's when both exist. Otherwise —
 * keyword mode, an item never embedded, a lost embedding race — it is how much
 * of the item's words the query mentions, weighted so a word every item shares
 * counts for little: the query is a request plus Kevin's recent lines and an
 * item is one sentence, so a symmetric overlap would sit under the floor for
 * everything and the lane would be dead without a key. Item ↔ item (MMR) stays
 * symmetric. Ties break by id, so the output is deterministic. Only live items
 * are considered; the vectors never leave.
 */
export function retrieve(items: readonly Retrievable[], opts: RetrieveOptions): Retrieved {
  const lambda = opts.lambda ?? MMR_LAMBDA;
  const floor = opts.floor ?? SCORE_FLOOR;
  const share = opts.pinnedShare ?? PINNED_SHARE;
  const live = items.filter((i) => i.state === "live");
  const picked: Retrievable[] = [];
  const pickedIds = new Set<string>();
  let used = 0;

  const pinnedBudget = Math.floor(opts.budgetTokens * share);
  const pinned = live.filter(isPinned).sort((a, b) => importanceFactor(b) * b.confidence * seenFactor(b) - importanceFactor(a) * a.confidence * seenFactor(a) || byId(a, b));
  let pinnedTokens = 0;
  for (const p of pinned) {
    const cost = itemTokens(p);
    if (pinnedTokens + cost > pinnedBudget) continue;
    pinnedTokens += cost;
    used += cost;
    picked.push(p);
    pickedIds.add(p.id);
  }
  const pinnedCount = picked.length;

  const query: Embedded | undefined = opts.query ? { text: opts.query.text, vec: opts.query.vec } : undefined;
  // Word weights over the live set, built once and only if a word comparison happens.
  let weights: TokenWeight | undefined;
  const weight: TokenWeight = (t) => (weights ??= tokenWeights(live.map((i) => i.text)))(t);
  const scored = live
    .filter((i) => !pickedIds.has(i.id))
    .map((i) => {
      const sim = query ? Math.max(0, querySimilarityOf(opts.embedder, query, { text: i.text, vec: i.vec }, weight)) : 1;
      return { item: i, score: sim * baseScore(i, opts.now) };
    })
    .filter((s) => s.score >= floor);

  const simTo = (a: Retrievable, b: Retrievable): number => similarityOf(opts.embedder, { text: a.text, vec: a.vec }, { text: b.text, vec: b.vec });
  const remaining = [...scored];
  while (remaining.length > 0) {
    let bestIdx = -1;
    let best = -Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const { item, score } = remaining[k]!;
      if (used + itemTokens(item) > opts.budgetTokens) continue;
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, simTo(item, p));
      const mmr = lambda * score - (1 - lambda) * maxSim;
      if (mmr > best || (mmr === best && bestIdx >= 0 && byId(item, remaining[bestIdx]!.item) < 0)) {
        best = mmr;
        bestIdx = k;
      }
    }
    if (bestIdx < 0) break;
    const [chosen] = remaining.splice(bestIdx, 1);
    picked.push(chosen!.item);
    pickedIds.add(chosen!.item.id);
    used += itemTokens(chosen!.item);
  }

  return { picked: picked.map(stripVec), tokens: used, pinned: pinnedCount };
}
