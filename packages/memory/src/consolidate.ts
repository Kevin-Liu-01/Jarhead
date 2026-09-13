import type { MemoryItem } from "@jarhead/protocol";
import { compare, thresholdsFor, type Embedder } from "./embed/embedder.ts";
import { LIVE_CAP } from "./limits.ts";
import { baseScore, isPinned } from "./retrieve.ts";
import type { MemoryStore } from "./store.ts";

export const CONSOLIDATE_MAX_PAIRS = 200;
/** An episode nobody mentioned again, of little importance, older than this: archived (still listed, restorable). */
export const DECAY_AGE_DAYS = 90;
export const DECAY_IMPORTANCE = 0.4;
/** How many vector-less items one pass may embed (one embedder batch). */
export const EMBED_MISSING_MAX = 96;
const DAY_MS = 86_400_000;

export interface ConsolidateOptions {
  /** Pair checks per call — the quiet tick's slice. */
  readonly maxPairs?: number;
  /** Where the previous call stopped; 0 starts a pass. */
  readonly cursor?: number;
  readonly signal?: AbortSignal;
  /** Give items that landed without a vector one now (a deferred run's leftovers). Default true. */
  readonly embedMissing?: boolean;
}

export interface ConsolidateResult {
  readonly merged: number;
  readonly archived: number;
  readonly embedded: number;
  /** Pair checks done in this call. */
  readonly pairs: number;
  /** True when the pass finished (decay and cap ran; a `consolidated` row written unless nothing at all happened). */
  readonly done: boolean;
  /** Pass to the next call; 0 when done. */
  readonly cursor: number;
  /** True when a row went into the log this call — the caller flushes the index only then. */
  readonly wrote: boolean;
}

const order = (a: MemoryItem, b: MemoryItem): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Housekeeping between conversations, never deletion:
 *   1. items that landed without a vector get one (so text-only matches become vector matches);
 *   2. near-duplicates of one kind at ≥ the `dup` threshold of the space they compare in fold
 *      older → newer (evidence combines: seenCount, confidence, sources);
 *   3. when the pass completes: low-importance, once-seen episodes older than 90 days are
 *      archived, and above LIVE_CAP the lowest-scored episodes go first.
 * Only items touched since the last pass are compared (against everything of their kind),
 * in slices of `maxPairs` pair checks per call so a large store never stalls the tick.
 * A pass that found nothing fresh, folded nothing, archived nothing and embedded nothing
 * writes nothing: the append-only record does not grow for a no-op.
 */
export async function consolidate(store: MemoryStore, embedder: Embedder, now: number, opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
  const maxPairs = opts.maxPairs ?? CONSOLIDATE_MAX_PAIRS;
  let embedded = 0;
  if (opts.embedMissing !== false && embedder.dims > 0) {
    const missing = store.items("live").filter((it) => !store.vectorFor(it.id, embedder)).slice(0, EMBED_MISSING_MAX);
    if (missing.length > 0) {
      try {
        await store.embed(embedder, missing.map((m) => m.text), opts.signal);
        embedded = missing.filter((it) => store.vectorFor(it.id, embedder)).length;
      } catch {
        // no key or no network: the words still match; try again next pass
      }
    }
  }

  // Pairs are enumerated lazily over per-kind grids (fresh × all of that kind) and the
  // cursor is a flat index into them, so one call costs its slice, not the whole store.
  // The grid is rebuilt from the live set each call; a merge between calls shifts it a
  // little (a pair may be checked twice — harmless — or missed until it is fresh again).
  const live = store.items("live").sort(order);
  const since = store.consolidatedAt;
  const fresh = new Set(live.filter((it) => it.createdAt > since || it.lastSeenAt > since).map((it) => it.id));
  const byKind = new Map<string, MemoryItem[]>();
  for (const it of live) {
    const g = byKind.get(it.kind);
    if (g) g.push(it);
    else byKind.set(it.kind, [it]);
  }
  const groups = [...byKind.keys()].sort().map((k) => {
    const all = byKind.get(k)!;
    return { all, fresh: all.filter((it) => fresh.has(it.id)) };
  });
  const total = groups.reduce((n, g) => n + g.fresh.length * g.all.length, 0);

  const vec = new Map<string, Float32Array | undefined>();
  const vecOf = (it: MemoryItem): Float32Array | undefined => {
    if (!vec.has(it.id)) vec.set(it.id, store.vectorFor(it.id, embedder));
    return vec.get(it.id);
  };
  let cursor = Math.max(0, opts.cursor ?? 0);
  let checked = 0;
  let merged = 0;
  let base = 0;
  let gi = 0;
  while (cursor < total && checked < maxPairs) {
    while (gi < groups.length && cursor >= base + groups[gi]!.fresh.length * groups[gi]!.all.length) {
      base += groups[gi]!.fresh.length * groups[gi]!.all.length;
      gi++;
    }
    const g = groups[gi];
    if (!g) break;
    const local = cursor - base;
    const f = g.fresh[Math.floor(local / g.all.length)]!;
    const o = g.all[local % g.all.length]!;
    cursor++;
    if (o.id === f.id) continue;
    if (fresh.has(o.id) && !(o.id < f.id)) continue; // each fresh–fresh pair once
    checked++;
    const ca = store.get(f.id);
    const cb = store.get(o.id);
    if (!ca || !cb || ca.state !== "live" || cb.state !== "live") continue;
    const { sim, space } = compare(embedder, { text: ca.text, vec: vecOf(ca) }, { text: cb.text, vec: vecOf(cb) });
    if (sim < thresholdsFor(embedder, space).dup) continue;
    const [older, newer] = order(ca, cb) <= 0 ? [ca, cb] : [cb, ca];
    store.merge(older.id, newer.id, true);
    merged++;
  }

  if (cursor < total) return { merged, archived: 0, embedded, pairs: checked, done: false, cursor, wrote: merged > 0 };

  let archived = 0;
  for (const it of store.items("live")) {
    if (it.kind !== "episode" || it.importance >= DECAY_IMPORTANCE || it.seenCount !== 1) continue;
    if ((now - it.lastSeenAt) / DAY_MS <= DECAY_AGE_DAYS) continue;
    store.archive(it.id, "decay");
    archived++;
  }
  const remaining = store.items("live");
  if (remaining.length > LIVE_CAP) {
    const rank = (it: MemoryItem): number => (it.kind === "episode" ? 0 : 1) * 10 + baseScore(it, now);
    const victims = remaining.filter((it) => !isPinned(it)).sort((a, b) => rank(a) - rank(b) || order(a, b));
    let over = remaining.length - LIVE_CAP;
    for (const v of victims) {
      if (over <= 0) break;
      store.archive(v.id, "cap");
      archived++;
      over--;
    }
  }
  if (checked + merged + archived + embedded === 0) return { merged: 0, archived: 0, embedded: 0, pairs: 0, done: true, cursor: 0, wrote: false };
  store.markConsolidated(checked, merged, archived, embedded);
  return { merged, archived, embedded, pairs: checked, done: true, cursor: 0, wrote: true };
}
