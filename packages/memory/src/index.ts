/**
 * @jarhead/memory — a durable, editable, token-budgeted memory of Kevin.
 *
 * Append-only record (memory.jsonl + embeddings.jsonl, a rebuildable
 * index.json), write-time extraction from closed conversations, ADD / UPDATE /
 * NOOP merging by embedding similarity with per-embedder thresholds, recency ×
 * importance × confidence × use scoring with MMR under two hard token budgets,
 * consolidation and decay to `archived`. Forget is a state; nothing is deleted.
 * Costs: the OpenAI key for embeddings and extraction (dollars, bounded by the
 * input caps) — or, under the local brain, a model on this Mac for both, so item
 * text and closed conversations never leave it; never a Codex turn, never a
 * Live session.
 */
export { MemoryService, MAX_SLICES } from "./service.ts";
export type { MemoryServiceOptions, IngestOptions, IngestResult, RememberResult } from "./service.ts";
export { MemoryStore } from "./store.ts";
export { MemoryLog, replay, applyRow } from "./log.ts";
export type { ReplayState } from "./log.ts";
export { EmbeddingCache } from "./embed/cache.ts";
export { FakeEmbedder, similarityOf, compare, querySimilarityOf, thresholdsFor, hashVector } from "./embed/embedder.ts";
export type { Embedder, Embedded, Space } from "./embed/embedder.ts";
export { OpenAIEmbedder } from "./embed/openai.ts";
export { EmbedError } from "./embed/errors.ts";
export type { EmbedErrorCode } from "./embed/errors.ts";
export { LocalEmbedder, LOCAL_THRESHOLDS, localThresholdsFor, LOCAL_EMBED_BATCH, LOCAL_EMBED_TIMEOUT_MS, LOCAL_EMBED_KEEP_ALIVE } from "./embed/local.ts";
export type { LocalEmbedderOptions } from "./embed/local.ts";
export { KeywordEmbedder, keywordSimilarity, keywordQuerySimilarity, tokenWeights, tokens, stem } from "./embed/keyword.ts";
export type { TokenWeight } from "./embed/keyword.ts";
export { ExtractUnavailableError } from "./extract/extractor.ts";
export type { Extractor, Decider, DecideContext } from "./extract/extractor.ts";
export { ResponsesExtractor, DEFAULT_MEMORY_MODEL, pickMemoryModel } from "./extract/responses.ts";
export { ChatExtractor, stripThinking, CHAT_EXTRACT_TIMEOUT_MS, CHAT_DECIDE_TIMEOUT_MS, CHAT_MAX_CHARS_LARGE, CHAT_MAX_CHARS_SMALL } from "./extract/chat.ts";
export type { ChatExtractorOptions } from "./extract/chat.ts";
export { parseCandidates, parseDecision } from "./extract/parse.ts";
export { RulesExtractor, RulesDecider, isReversal, subjectsOf } from "./extract/rules.ts";
export { buildExtractInput, localDay } from "./extract/input.ts";
export { EXTRACT_INSTRUCTIONS, extractInstructions, DECIDE_INSTRUCTIONS, EXTRACT_SCHEMA, DECIDE_SCHEMA, EXTRACT_MAX_ITEMS, stripBounds, renderExtractUser, renderDecideUser } from "./extract/prompt.ts";
export { mergeCandidates, postFilter, trimSentence, combineConfidence } from "./merge.ts";
export { retrieve, recency, importanceFactor, seenFactor, baseScore, isPinned, SCORE_FLOOR } from "./retrieve.ts";
export type { Retrievable } from "./retrieve.ts";
export { renderBrainBlock, renderVoiceBlock, BRAIN_MEMORY_LABEL, brainMemoryLabel, VOICE_HEADER, voiceHeader, VOICE_FOOTER } from "./render.ts";
export type { Rendered } from "./render.ts";
export { consolidate } from "./consolidate.ts";
export type { ConsolidateOptions, ConsolidateResult } from "./consolidate.ts";
export { estimateTokens } from "./tokens.ts";
export { refuseReason, redactThenDrop, normalizeText, luhnValid } from "./redact.ts";
export type { Redact } from "./redact.ts";
export { cosine, l2normalize, toBase64, fromBase64 } from "./vec.ts";
export { MAX_TEXT_CHARS, MAX_SUBJECTS, MAX_SOURCES, LIVE_CAP, FORGET_RECENT_MS, MIN_NEW_KEVIN_LINES, DEFER_MAX_TRIES } from "./limits.ts";
export type { Thresholds, MemoryRow, MemoryBy, ExtractorKind, RunCounts, ItemPatch, Watermark, Exclusion, Candidate, ExtractLine, ExtractRequest, ExtractInput, Neighbour, Decision, MergeResult } from "./types.ts";
