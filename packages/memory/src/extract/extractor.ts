import type { Candidate, Decision, ExtractInput, ExtractorKind, Neighbour, Thresholds } from "../types.ts";

/**
 * Turns one conversation into candidates. The Responses extractor talks to
 * OpenAI (Kevin's key, dollars); the rules extractor is regexes and costs
 * nothing. Both return raw candidates; the merge step filters and applies them.
 */
export interface Extractor {
  readonly kind: ExtractorKind;
  extract(input: ExtractInput, signal?: AbortSignal): Promise<Candidate[]>;
}

export interface DecideContext {
  readonly thresholds: Thresholds;
  readonly now: number;
  readonly signal?: AbortSignal;
}

/**
 * Asked when a candidate sits close to live items: the same thing (UPDATE or
 * NOOP), a different thing (ADD), or a reversal (contradicts → ADD that
 * supersedes the target). Rules mode answers newest-wins above the update
 * threshold and ADD in the band; it never marks a contradiction.
 */
export interface Decider {
  readonly kind: ExtractorKind;
  decide(candidate: Candidate, neighbours: readonly Neighbour[], ctx: DecideContext): Promise<Decision>;
}

export type ExtractUnavailableCode = "no-key" | "http" | "bad-json" | "timeout" | "refused";

/**
 * The Responses extractor could not answer for this run. The service warns once
 * and runs the rules extractor over the same input instead — extraction never
 * blocks forever on a wrong model id or a missing key.
 */
export class ExtractUnavailableError extends Error {
  constructor(readonly code: ExtractUnavailableCode, message: string, readonly status?: number) {
    super(message);
    this.name = "ExtractUnavailableError";
  }
}
