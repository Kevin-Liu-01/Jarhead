import type { Thresholds } from "../types.ts";
import { cosine, l2normalize } from "../vec.ts";
import { normalizeText } from "../redact.ts";
import { KEYWORD_THRESHOLDS, OPENAI_THRESHOLDS } from "../limits.ts";
import { keywordQuerySimilarity, keywordSimilarity, tokens, type TokenWeight } from "./keyword.ts";

export { OPENAI_THRESHOLDS, KEYWORD_THRESHOLDS, THRESH_UPDATE, THRESH_BAND } from "../limits.ts";

/**
 * How items are compared. `embed` may throw (no key, network); the caller
 * decides whether to defer. `similarity` compares two vectors of this
 * embedder's space; `similarityText` compares the words of two ITEMS when one
 * side has no vector — never two spaces at once; `similarityQuery` compares a
 * long query's words against one item's (asymmetric: coverage of the item).
 */
export interface Embedder {
  readonly kind: "openai" | "keyword" | "fake";
  /** Names the vector space in the cache (text-embedding-3-small, keyword, fake). */
  readonly model: string;
  /** 0 = no vectors are stored (keyword). */
  readonly dims: number;
  readonly thresholds: Thresholds;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
  similarity(a: Float32Array, b: Float32Array): number;
  similarityText(a: string, b: string): number;
  similarityQuery(query: string, item: string, weight?: TokenWeight): number;
}

export interface Embedded {
  readonly text: string;
  readonly vec?: Float32Array | undefined;
}

/** Which scale a comparison happened on: cosines in the embedder's space, or word overlap. */
export type Space = "vector" | "text";

export interface Compared {
  readonly sim: number;
  readonly space: Space;
}

function bothVectors(e: Embedder, a: Embedded, b: Embedded): boolean {
  return e.dims > 0 && !!a.vec && !!b.vec && a.vec.length === e.dims && b.vec.length === e.dims;
}

/**
 * Item ↔ item: vector similarity when both sides have one in this space, else
 * the words — and WHICH, because the two live on different scales: a cosine of
 * 0.75 is the openai band, a Jaccard of 0.75 is well above the keyword update
 * threshold. Decisions read the thresholds of the space the comparison used.
 */
export function compare(e: Embedder, a: Embedded, b: Embedded): Compared {
  if (bothVectors(e, a, b)) return { sim: e.similarity(a.vec!, b.vec!), space: "vector" };
  return { sim: e.similarityText(a.text, b.text), space: "text" };
}

/** `compare` without the space, for callers that only rank. */
export function similarityOf(e: Embedder, a: Embedded, b: Embedded): number {
  return compare(e, a, b).sim;
}

/** The threshold table a comparison in `space` is judged by: words always use the keyword table. */
export function thresholdsFor(e: Embedder, space: Space | undefined): Thresholds {
  return space === "text" ? KEYWORD_THRESHOLDS : e.thresholds;
}

/** Query → item: the query vector against the item's when both exist, else coverage of the item's words. */
export function querySimilarityOf(e: Embedder, query: Embedded, item: Embedded, weight?: TokenWeight): number {
  if (bothVectors(e, query, item)) return e.similarity(query.vec!, item.vec!);
  return e.similarityQuery(query.text, item.text, weight);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic token-hash vector: shared tokens give a cosine of |A∩B| / sqrt(|A||B|). */
export function hashVector(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (const t of tokens(text)) {
    const h = fnv1a(t);
    const i = h % dims;
    v[i] = (v[i] ?? 0) + ((h & 0x10000) ? -1 : 1);
  }
  return l2normalize(v);
}

export interface FakeEmbedderOptions {
  /** Exact vectors by text (normalised on lookup); anything missing falls back to the token hash. */
  readonly table?: Record<string, readonly number[]> | ReadonlyMap<string, readonly number[]>;
  readonly dims?: number;
  readonly thresholds?: Thresholds;
  /** Return an Error to make the next embed() throw it (a 429, a dead network). */
  readonly fail?: () => Error | undefined;
}

/**
 * The test embedder: no network, deterministic. A table pins exact cosines
 * (a = [1,0], b = [cos θ, sin θ]); texts outside the table hash their tokens
 * so tests of the pipeline's shape need no table at all.
 */
export class FakeEmbedder implements Embedder {
  readonly kind = "fake" as const;
  readonly model = "fake";
  readonly dims: number;
  readonly thresholds: Thresholds;
  readonly calls: string[][] = [];
  private readonly table = new Map<string, Float32Array>();
  private readonly fail: (() => Error | undefined) | undefined;

  constructor(opts: FakeEmbedderOptions = {}) {
    const entries = opts.table instanceof Map ? [...opts.table.entries()] : Object.entries(opts.table ?? {});
    let dims = opts.dims;
    for (const [text, vec] of entries) {
      dims ??= vec.length;
      this.table.set(normalizeText(text), l2normalize(Float32Array.from(vec)));
    }
    this.dims = dims ?? 512;
    this.thresholds = opts.thresholds ?? OPENAI_THRESHOLDS;
    this.fail = opts.fail;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    const err = this.fail?.();
    if (err) throw err;
    return texts.map((t) => {
      const hit = this.table.get(normalizeText(t));
      if (hit) {
        if (hit.length === this.dims) return hit;
        const padded = new Float32Array(this.dims);
        padded.set(hit.subarray(0, this.dims));
        return padded;
      }
      return hashVector(t, this.dims);
    });
  }

  similarity(a: Float32Array, b: Float32Array): number {
    return cosine(a, b);
  }

  similarityText(a: string, b: string): number {
    return keywordSimilarity(a, b);
  }

  similarityQuery(query: string, item: string, weight?: TokenWeight): number {
    return keywordQuerySimilarity(query, item, weight);
  }
}
