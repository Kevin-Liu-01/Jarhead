/**
 * Does this utterance want Jarvis to DO something on screen, or just to answer?
 *
 * Deterministic keyword matching, not a model call. Classifying with an LLM would
 * put a whole round trip in front of the round trip that produces the answer, on
 * every single turn, to decide something a regex gets right — and the failure
 * mode is mild either way: a misrouted action still speaks, it just does not
 * point.
 *
 * The bias is toward ANSWERING. Acting takes seconds and moves the cursor, so a
 * false positive is far more annoying than a false negative.
 */

/** Verbs that only make sense if something on screen is involved. */
const ACTION_VERBS =
  /\b(show me|point (at|to)|find|locate|highlight|circle|click|press|open|where('s| is)|look at|walk me through|guide me|help me (find|use|do)|take me to|navigate)\b/i;

/** Nouns that anchor a request to the screen rather than to knowledge. */
const SCREEN_NOUNS =
  /\b(screen|cursor|mouse|pointer|button|window|tab|menu|icon|toolbar|sidebar|dialog|field|box|link|app|application|this|that|here|it)\b/i;

/**
 * Phrases that look like actions but are questions about the world.
 *
 * "where is Berlin" and "find me a good restaurant" both trip ACTION_VERBS, and
 * pointing at the screen would be nonsense.
 */
const NOT_ON_SCREEN =
  /\b(hacker\s*news|hackernews|\bhn\b|briefing|weather|news|recipe|definition|meaning of|who (is|was)|what (is|are) (a|an|the)?\s*(?!.*\b(button|window|tab|menu|icon|cursor|screen)\b))/i;

export interface IntentVerdict {
  readonly act: boolean;
  readonly reason: string;
}

export function wantsAction(utterance: string): IntentVerdict {
  const text = utterance.trim();
  if (text.length === 0) return { act: false, reason: "empty" };

  if (NOT_ON_SCREEN.test(text)) {
    return { act: false, reason: "asks about the world, not the screen" };
  }

  const verb = ACTION_VERBS.test(text);
  const noun = SCREEN_NOUNS.test(text);

  if (verb && noun) return { act: true, reason: "action verb plus something on screen" };
  if (verb && /\b(my|the)\b/i.test(text)) return { act: true, reason: "action verb aimed at something of Kevin's" };

  return { act: false, reason: verb ? "action verb with no on-screen target" : "no action verb" };
}
