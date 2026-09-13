import type { Thresholds } from "./types.ts";

/**
 * Caps every stage agrees on. One sentence per item, a few tags, a short trail
 * of where it was said; the store refuses more, so a runaway extractor cannot
 * turn memory.jsonl into a transcript.
 */
export const MAX_TEXT_CHARS = 200;
export const MAX_SUBJECTS = 5;
export const MAX_SOURCES = 8;
/** Live items above this are archived (lowest-scored episodes first); nothing is deleted. */
export const LIVE_CAP = 2000;
/** "forget that" tombstones what was learned in this window and excludes it from later runs. */
export const FORGET_RECENT_MS = 600_000;
/** A run needs this many new Kevin lines since the watermark; a pause-heavy day stays at a few runs. */
export const MIN_NEW_KEVIN_LINES = 4;
/** An embedding failure defers a run this many times before it lands without vectors. */
export const DEFER_MAX_TRIES = 3;

/** Cosine thresholds for text-embedding-3-small: antonym pairs land above 0.90, so the update lane still asks when the words differ. */
export const OPENAI_THRESHOLDS: Thresholds = { update: 0.9, band: 0.75, dup: 0.93 };
/** Jaccard thresholds for the keyword fallback: a paraphrase scores ~0.5–0.75 here. */
export const KEYWORD_THRESHOLDS: Thresholds = { update: 0.6, band: 0.4, dup: 0.7 };
export const THRESH_UPDATE = OPENAI_THRESHOLDS.update;
export const THRESH_BAND = OPENAI_THRESHOLDS.band;
