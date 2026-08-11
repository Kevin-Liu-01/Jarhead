import type { AckCategory } from "./bank.ts";

/**
 * Whether to fire a canned ack while the real answer generates.
 *
 * Pure on purpose (same reasoning as turn.ts's injected deps): this runs on
 * the live voice path, so it must be instant, and the "reason" string goes
 * straight into the latency timeline so a weird-feeling turn can be explained
 * after the fact instead of argued about.
 */

export interface AckDecision {
  readonly ack: boolean;
  readonly category: AckCategory | undefined;
  /** Logged verbatim in the latency timeline. */
  readonly reason: string;
}

/**
 * Router intents that fetch or search before answering — memory (qmd/BM25),
 * live HN, the brief projection, and general knowledge all put network or the
 * model's full TTFT ahead of the first sentence. These get the "let me look"
 * flavor; anything else is assumed action-shaped (future automation and
 * computer-use intents) and gets "on it".
 */
const LOOKUP_INTENTS: ReadonlySet<string> = new Set(["memory", "hackernews", "brief", "general"]);

export function shouldAck(intent: string, expectedLatencyMs: number, threshold: number): AckDecision {
  // A greeting's whole answer ("hey Kevin") is shorter than any ack, so an
  // ack would delay the real thing it is meant to mask.
  if (intent === "greeting") {
    return {
      ack: false,
      category: undefined,
      reason: "greeting: the real answer is shorter than the ack itself",
    };
  }

  // A warm-cache answer beats the ack to the speaker; playing one anyway
  // would make the fast path *feel* slower.
  if (expectedLatencyMs <= threshold) {
    return {
      ack: false,
      category: undefined,
      reason: `warm path: expected ${expectedLatencyMs}ms is within the ${threshold}ms ack threshold`,
    };
  }

  const category: AckCategory = LOOKUP_INTENTS.has(intent) ? "thinking" : "working";
  return {
    ack: true,
    category,
    reason: `${intent}: expected ${expectedLatencyMs}ms exceeds ${threshold}ms, masking with a ${category} ack`,
  };
}
