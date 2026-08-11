import { readBrief } from "./brief.ts";
import { storiesAsContext, topStories, cachedStories } from "./hn.ts";
import { memoryAsContext, searchMemory } from "./memory.ts";

/**
 * Intent routing.
 *
 * Deliberately keyword-based, not a model call. Classifying with an LLM would
 * add a whole round trip in front of the round trip that produces the answer,
 * which is exactly the mistake the latency budget exists to prevent. A wrong
 * route here costs one slightly-off answer; a classification hop costs every
 * turn ~400ms.
 */

export type Intent = "greeting" | "brief" | "hackernews" | "memory" | "general";

export interface RoutedTurn {
  readonly intent: Intent;
  /** Context handed to the model, already trimmed. Empty for pure-chat turns. */
  readonly context: string;
  /** Where the answer came from — drives whether the latency was acceptable. */
  readonly source: "none" | "cache" | "live" | "wiki";
  readonly gatherMs: number;
  /** Set when the source was degraded and the model must say so. */
  readonly caveat: string | undefined;
}

const GREETING = /^\s*(hey|hi|hello|yo|good\s+(morning|afternoon|evening))\b[\s,]*(jarvis)?\s*[.!?]?\s*$/i;
const BRIEF = /\b(brief|briefing|debrief|my day|daily|what'?s? on (my )?(plate|agenda)|agenda)\b/i;
const HN = /\b(hacker\s*news|hackernews|hn|orange site|what'?s? on hn)\b/i;
const MEMORY = /\b(what do i know|do i know|my (notes?|wiki|brain)|remind me|did i (write|note)|look ?up|search (my|the) )\b/i;

export function classify(utterance: string): Intent {
  const u = utterance.trim();
  if (GREETING.test(u)) return "greeting";
  if (HN.test(u)) return "hackernews";
  if (BRIEF.test(u)) return "brief";
  if (MEMORY.test(u)) return "memory";
  return "general";
}

export interface RouteDeps {
  readonly wikiRoot: string;
}

export async function route(utterance: string, deps: RouteDeps): Promise<RoutedTurn> {
  const intent = classify(utterance);
  const startedAt = Date.now();
  const ms = (): number => Date.now() - startedAt;

  switch (intent) {
    case "greeting":
      return { intent, context: "", source: "none", gatherMs: ms(), caveat: undefined };

    case "hackernews": {
      const warm = cachedStories();
      try {
        const stories = await topStories({ count: 8 });
        return {
          intent,
          context: `Top Hacker News stories right now:\n${storiesAsContext(stories)}`,
          source: warm ? "cache" : "live",
          gatherMs: ms(),
          caveat: undefined,
        };
      } catch (e) {
        return {
          intent,
          context: "Hacker News could not be reached.",
          source: "live",
          gatherMs: ms(),
          caveat: `HN fetch failed: ${(e as Error).message}`,
        };
      }
    }

    case "brief": {
      const brief = readBrief(deps.wikiRoot);
      return {
        intent,
        context: brief.context,
        source: "wiki",
        gatherMs: ms(),
        caveat: brief.found
          ? brief.ageDays !== undefined && brief.ageDays > 1
            ? `The brief is ${brief.ageDays} days old.`
            : undefined
          : "No compiled brief exists yet.",
      };
    }

    case "memory": {
      const result = searchMemory(utterance, deps.wikiRoot);
      return {
        intent,
        context: memoryAsContext(result),
        source: "wiki",
        gatherMs: ms(),
        caveat: result.degraded,
      };
    }

    case "general":
      return { intent, context: "", source: "none", gatherMs: ms(), caveat: undefined };
  }
}

/** Builds the user turn. Context first, question last — recency helps the model obey it. */
export function buildPrompt(utterance: string, routed: RoutedTurn): string {
  const parts: string[] = [];
  if (routed.context) parts.push(`Context:\n${routed.context}`);
  if (routed.caveat) parts.push(`Important caveat you must mention: ${routed.caveat}`);
  parts.push(`Kevin asked, out loud: "${utterance}"`);
  if (routed.intent === "greeting") {
    parts.push("Greet him back in one short sentence. Do not offer a menu of what you can do.");
  }
  return parts.join("\n\n");
}
