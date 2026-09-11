export { ensureBank, planBank, cacheKey, phrasePath, ackDir, AckBank, DEFAULT_PHRASES } from "./bank.ts";
export type {
  AckCategory,
  BankPhrases,
  PlanOptions,
  SpendPlan,
  EnsureBankOptions,
  EnsureBankResult,
  AckBankOptions,
} from "./bank.ts";

export { playFile } from "./play.ts";
export type { PlaybackHandle, PlaybackResult } from "./play.ts";

export { ensureEarcon, earconPath } from "./earcon.ts";
export type { EarconVariant } from "./earcon.ts";

export { shouldAck } from "./speculative.ts";
export type { AckDecision } from "./speculative.ts";
