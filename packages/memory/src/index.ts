/**
 * @jarhead/memory — a durable, editable, token-budgeted memory of Kevin.
 *
 * Append-only record (memory.jsonl + embeddings.jsonl, a rebuildable
 * index.json), write-time extraction from closed conversations, ADD / UPDATE /
 * NOOP merging by embedding similarity with per-embedder thresholds, recency ×
 * importance × confidence × use scoring with MMR under two hard token budgets,
 * consolidation and decay to `archived`. Forget is a state; nothing is deleted.
 * Costs: the OpenAI key for embeddings and extraction (dollars, bounded by the
 * input caps); never a Codex turn, never a Live session.
 */
export { MemoryService, RETRIEVE_TIMEOUT_MS, QUERY_LRU, MAX_SLICES } from "./service.ts";
export type { MemoryServiceOptions, IngestOptions, IngestResult, IngestReason, RememberResult } from "./service.ts";
export { MemoryStore } from "./store.ts";
export type { StoreOptions, AddDraft } from "./store.ts";
export { MemoryLog, replay, applyRow, capSources } from "./log.ts";
export type { ReplayState } from "./log.ts";
export { EmbeddingCache } from "./embed/cache.ts";
export { FakeEmbedder, similarityOf, compare, querySimilarityOf, thresholdsFor, hashVector, OPENAI_THRESHOLDS, KEYWORD_THRESHOLDS, THRESH_UPDATE, THRESH_BAND } from "./embed/embedder.ts";
export type { Embedder, Embedded, Space, Compared, FakeEmbedderOptions } from "./embed/embedder.ts";
export { OpenAIEmbedder, EmbedError, EMBED_MODEL, EMBED_DIMS, EMBED_BATCH } from "./embed/openai.ts";
export type { OpenAIEmbedderOptions, EmbedErrorCode } from "./embed/openai.ts";
export { KeywordEmbedder, keywordSimilarity, keywordQuerySimilarity, tokenWeights, tokens, stem } from "./embed/keyword.ts";
export type { TokenWeight } from "./embed/keyword.ts";
export { ExtractUnavailableError } from "./extract/extractor.ts";
export type { Extractor, Decider, DecideContext, ExtractUnavailableCode } from "./extract/extractor.ts";
export { ResponsesExtractor, DEFAULT_MEMORY_MODEL, pickMemoryModel } from "./extract/responses.ts";
export type { ResponsesExtractorOptions } from "./extract/responses.ts";
export { RulesExtractor, RulesDecider, isReversal, subjectsOf } from "./extract/rules.ts";
export { buildExtractInput, localDay, EXTRACT_INPUT_CHARS } from "./extract/input.ts";
export type { BuildExtractInputOptions } from "./extract/input.ts";
export { EXTRACT_INSTRUCTIONS, DECIDE_INSTRUCTIONS, EXTRACT_SCHEMA, DECIDE_SCHEMA, EXTRACT_MAX_ITEMS, stripBounds, renderExtractUser, renderDecideUser } from "./extract/prompt.ts";
export { mergeCandidates, postFilter, trimSentence, combineConfidence, unionSubjects } from "./merge.ts";
export type { MergeOptions, PostFilterOptions } from "./merge.ts";
export { retrieve, recency, importanceFactor, seenFactor, baseScore, isPinned, itemTokens, HALF_LIFE_DAYS, SCORE_FLOOR, MMR_LAMBDA, PINNED_SHARE } from "./retrieve.ts";
export type { RetrieveOptions, Retrieved, Retrievable } from "./retrieve.ts";
export { renderBrainBlock, renderVoiceBlock, brainLine, BRAIN_MEMORY_LABEL, VOICE_HEADER, VOICE_FOOTER } from "./render.ts";
export type { Rendered } from "./render.ts";
export { consolidate, CONSOLIDATE_MAX_PAIRS, DECAY_AGE_DAYS, DECAY_IMPORTANCE, EMBED_MISSING_MAX } from "./consolidate.ts";
export type { ConsolidateOptions, ConsolidateResult } from "./consolidate.ts";
export { estimateTokens } from "./tokens.ts";
export { refuseReason, redactThenDrop, normalizeText, luhnValid, REDACTED_MARK } from "./redact.ts";
export type { Redact, RefuseContext } from "./redact.ts";
export { cosine, l2normalize, toBase64, fromBase64 } from "./vec.ts";
export { MAX_TEXT_CHARS, MAX_SUBJECTS, MAX_SOURCES, LIVE_CAP, FORGET_RECENT_MS, MIN_NEW_KEVIN_LINES, DEFER_MAX_TRIES } from "./limits.ts";
export type { Thresholds, MemoryRow, MemoryBy, ExtractorKind, RunCounts, ItemPatch, Watermark, Exclusion, Candidate, ExtractLine, ExtractRequest, ExtractInput, Neighbour, Decision, MergeResult } from "./types.ts";
