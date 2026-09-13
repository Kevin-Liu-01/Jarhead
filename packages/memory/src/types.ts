import type { MemoryItem, MemoryKind, MemorySource } from "@jarhead/protocol";
import type { Space } from "./embed/embedder.ts";

/**
 * Internal vocabulary of the memory package. The wire types (MemoryItem,
 * MemorySummary, …) live in @jarhead/protocol; these are the rows of the
 * append-only log and the shapes the pipeline passes between its stages.
 */

/** How similar two texts must be, per embedder: openai cosines and keyword overlaps live on different scales. */
export interface Thresholds {
  /** At or above: the same thing said again (touch when the words match, else the decider / newest wins). */
  readonly update: number;
  /** Between band and update: ask the decider. Below band: a new item. */
  readonly band: number;
  /** Consolidation folds two live items of one kind at or above this. */
  readonly dup: number;
}

export type MemoryBy = "kevin" | "reflex" | "cli";
export type ExtractorKind = "responses" | "rules";

export interface RunCounts {
  readonly added: number;
  readonly updated: number;
  readonly noop: number;
  readonly refused: number;
}

export interface ItemPatch {
  readonly text?: string;
  readonly kind?: MemoryKind;
  readonly subjects?: readonly string[];
  readonly confidence?: number;
  readonly importance?: number;
}

/**
 * One line of <stateDir>/memory/memory.jsonl. Rows are appended before the index
 * applies them and never rewritten; replaying every row in order rebuilds the
 * index exactly. Forget, restore, merge and archive are state changes on an item
 * that stays in the log — nothing is ever deleted.
 */
export type MemoryRow =
  | { readonly at: number; readonly op: "add"; readonly item: MemoryItem }
  /**
   * A text change keeps `prev` so the log shows what was said before (a reversal is never silent).
   * `replaces`: the new words replace the old meaning (a reversal), so evidence starts over —
   * seenCount 1, the candidate's confidence — instead of folding onto words nobody said.
   */
  | { readonly at: number; readonly op: "update"; readonly id: string; readonly patch: ItemPatch; readonly prev?: { readonly text: string }; readonly source?: MemorySource; readonly replaces?: boolean }
  /** Evidence of the same thing again: seenCount+1, lastSeenAt, and the confidence/importance/subjects the patch carries. */
  | { readonly at: number; readonly op: "touch"; readonly id: string; readonly source: MemorySource; readonly patch?: ItemPatch }
  | { readonly at: number; readonly op: "forget"; readonly id: string; readonly by: MemoryBy; readonly reason?: string }
  | { readonly at: number; readonly op: "restore"; readonly id: string }
  /** `id` folds into `into`. `fold` true: the same fact twice, so evidence combines; false: a reversal, `into` supersedes and keeps its own count. */
  | { readonly at: number; readonly op: "merge"; readonly id: string; readonly into: string; readonly fold: boolean }
  | { readonly at: number; readonly op: "archive"; readonly id: string; readonly why: "decay" | "cap" }
  /** One extraction run over a session up to `upToAt`; the next run reads only later rows. */
  | { readonly at: number; readonly op: "watermark"; readonly sessionId: string; readonly upToAt: number; readonly extractor: ExtractorKind; readonly counts: RunCounts }
  /** A forget-reflex window: rows inside it never feed an extractor again. */
  | { readonly at: number; readonly op: "exclude"; readonly from: number; readonly to: number; readonly sessionId?: string }
  | { readonly at: number; readonly op: "consolidated"; readonly pairs: number; readonly merged: number; readonly archived: number; readonly embedded: number };

export interface Watermark {
  readonly at: number;
  readonly upToAt: number;
  readonly extractor: ExtractorKind;
  readonly counts: RunCounts;
}

export interface Exclusion {
  readonly from: number;
  readonly to: number;
  readonly sessionId?: string;
}

/** What one extractor run proposes; merge turns it into add/update/touch against the live items. */
export interface Candidate {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly subjects: readonly string[];
  /** 0..1 (the Responses schema's 1..5 is divided by 5 on the way in). */
  readonly importance: number;
  readonly confidence: number;
  /** Line numbers of the extract input this came from; at least one must be Kevin's. */
  readonly evidence: readonly number[];
  /** Where the words were said; set by the service from the first Kevin line cited. */
  readonly source?: MemorySource;
  readonly origin?: "extracted" | "kevin" | "tool";
}

export interface ExtractLine {
  readonly n: number;
  readonly speaker: "Kevin" | "Jarhead";
  readonly text: string;
  readonly at: number;
}

export interface ExtractRequest {
  readonly request: string;
  readonly status: string;
  readonly summary?: string;
  readonly at: number;
}

export interface ExtractInput {
  /** Kevin's local day, YYYY-MM-DD. */
  readonly day: string;
  readonly lines: readonly ExtractLine[];
  readonly requests: readonly ExtractRequest[];
  /** How many of `lines` are Kevin's. */
  readonly kevinLines: number;
  /** Kevin's lines in the whole pending delta, before the char cap — the MIN_NEW_KEVIN_LINES gate reads this once. */
  readonly pendingKevinLines: number;
  /** Where the watermark goes after this slice. */
  readonly upToAt: number;
  /** True when the char cap cut the slice short; later rows wait for the next run. */
  readonly truncated: boolean;
  /** Lines the redactor or a refusal shape dropped. */
  readonly dropped: number;
}

export interface Neighbour {
  readonly item: MemoryItem;
  readonly sim: number;
  /** Which scale `sim` is on; absent = the embedder's own (vector) space. Words are judged by the keyword table. */
  readonly space?: Space;
}

export interface Decision {
  readonly op: "ADD" | "UPDATE" | "NOOP";
  readonly target?: string;
  readonly text?: string;
  readonly contradicts?: boolean;
  /** UPDATE only: the candidate reverses the target (rules mode's antonym swap), so the item's evidence resets to the candidate's. */
  readonly replaces?: boolean;
}

export interface MergeResult extends RunCounts {
  readonly addedIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly touchedIds: readonly string[];
}
