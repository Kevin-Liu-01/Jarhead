import type { Embedder } from "./embedder.ts";
import { KEYWORD_THRESHOLDS } from "../limits.ts";

/**
 * No key, no vectors: items are matched by the words in them. Tokens are
 * lowercased, stop words dropped, lightly stemmed and a few preference verbs
 * folded ("prefers" ≈ "likes"). Two ITEMS compare by Jaccard (symmetric — a
 * paraphrase lands around 0.5–0.75, so this embedder's thresholds are
 * {0.60, 0.40, 0.70}, not the cosine table). A QUERY against an item compares
 * by coverage — what share of the item's words the query mentions — because
 * the delegator's query is a request plus Kevin's recent lines (25+ tokens)
 * while an item has 3–8: Jaccard would punish that length asymmetry to ~0.1
 * and nothing would ever clear the score floor.
 */

const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by", "from", "as", "is", "are", "was", "were", "be", "been",
  "it", "its", "his", "her", "their", "he", "she", "they", "them", "this", "that", "these", "those", "than", "then", "so", "very", "really",
  "just", "also", "too", "not", "no", "do", "does", "did", "have", "has", "had", "will", "would", "should", "can", "could", "up", "out",
  "about", "into", "over", "when", "how", "what", "which", "who", "s", "t",
]);

const SYNONYMS: Record<string, string> = {
  prefer: "like", love: "like", enjoy: "like", favour: "like", favor: "like",
  hate: "dislike", detest: "dislike",
  brief: "short", concise: "short", terse: "short", quick: "short",
  lengthy: "long", verbose: "long", detailed: "long",
  colleague: "coworker",
};

export function stem(word: string): string {
  let w = word;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && /(?:x|ch|sh|ss|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/**
 * The content tokens of a text, stemmed and folded. "kevin" is dropped: every
 * item carries it, and a shared constant token inflates the overlap of two
 * unrelated four-word facts to the update lane (a lost fact is worse than a
 * twin). Reversals that share every word but one are the rules decider's job.
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (!raw || raw.length < 2 || STOP.has(raw)) continue;
    let t = stem(raw);
    t = SYNONYMS[t] ?? t;
    if (t === "kevin" || t.length < 2) continue;
    out.add(t);
  }
  return out;
}

/** Jaccard over stemmed content tokens; 1 for identical texts, 0 when either side is empty. Item ↔ item. */
export function keywordSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** A token's weight in a query match; 1 when nothing is known about the corpus. */
export type TokenWeight = (token: string) => number;

/**
 * Inverse-frequency weights over a corpus of item texts: a word most items
 * carry ("like", folded from every "prefers") counts for little, a word one
 * item carries counts fully — weight = 1 / (1 + ln df). Computed once per
 * retrieval over the live set; cheap at Kevin's volume.
 */
export function tokenWeights(texts: readonly string[]): TokenWeight {
  const df = new Map<string, number>();
  for (const text of texts) for (const t of tokens(text)) df.set(t, (df.get(t) ?? 0) + 1);
  return (token) => {
    const n = df.get(token);
    return n === undefined || n <= 1 ? 1 : 1 / (1 + Math.log(n));
  };
}

/**
 * Query → item: the (weighted) share of the item's content tokens the query
 * mentions. Asymmetric on purpose — a long query that mentions three of an
 * item's eight words scores 0.375 here where Jaccard gives ~0.1 — and 1 when
 * the query says everything the item says, however long the query is.
 */
export function keywordQuerySimilarity(query: string, item: string, weight: TokenWeight = () => 1): number {
  const tq = tokens(query);
  const ti = tokens(item);
  if (tq.size === 0 || ti.size === 0) return 0;
  let hit = 0;
  let all = 0;
  for (const t of ti) {
    const w = weight(t);
    all += w;
    if (tq.has(t)) hit += w;
  }
  return all === 0 ? 0 : hit / all;
}

export class KeywordEmbedder implements Embedder {
  readonly kind = "keyword" as const;
  readonly model = "keyword";
  /** No vectors: nothing is stored, nothing is sent anywhere. */
  readonly dims = 0;
  readonly thresholds = KEYWORD_THRESHOLDS;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(0));
  }

  similarity(): number {
    return 0;
  }

  similarityText(a: string, b: string): number {
    return keywordSimilarity(a, b);
  }

  similarityQuery(query: string, item: string, weight?: TokenWeight): number {
    return keywordQuerySimilarity(query, item, weight);
  }
}
