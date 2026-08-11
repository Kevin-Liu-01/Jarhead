/**
 * Contracts for one voice turn. Types only — no implementation lives here.
 *
 * The hot loop's single hard rule: nothing on this path may await a tool call,
 * a file read, or a subprocess. Cache reads under ~20ms are the only exception.
 * See DECISION.md §4 for the latency budget these stages are measured against.
 */

/** Ordered stages of a turn, mic-open to first spoken syllable. */
export const TURN_STAGES = [
  "wake", // wake word fired
  "endpoint", // VAD decided the user stopped talking
  "stt", // final transcript flushed
  "route", // intent classified, cache consulted
  "llm_ttft", // first token from the model
  "tts_ttfb", // first audio byte from ElevenLabs
  "audio_out", // first syllable actually audible
] as const;

export type TurnStage = (typeof TURN_STAGES)[number];

/** Per-stage budget in ms. Targets, not guarantees — M1 replaces these with measurements. */
export const STAGE_BUDGET_MS: Readonly<Record<TurnStage, number>> = Object.freeze({
  wake: 90,
  endpoint: 150,
  stt: 50,
  route: 5,
  llm_ttft: 400,
  tts_ttfb: 200,
  audio_out: 40,
});

export interface StageTiming {
  readonly stage: TurnStage;
  /** ms since turn start. */
  readonly at: number;
  /** ms spent in this stage. */
  readonly took: number;
}

/** How the answer was produced — drives whether the latency was acceptable. */
export type AnswerPath =
  | "ack_bank" // pre-synthesized audio, no model call
  | "cache" // prefetched brief / HN / memory
  | "live" // full model round trip
  | "deferred"; // acknowledged now, background agent reports back later

export interface TurnRecord {
  readonly turnId: string;
  readonly startedAt: number;
  readonly transcript: string;
  readonly answerPath: AnswerPath;
  readonly timings: readonly StageTiming[];
  /** mic-open to first audible syllable. The number that matters. */
  readonly firstAudioMs: number | undefined;
  readonly bargedIn: boolean;
}
