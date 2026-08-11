/**
 * Deciding when to ask "want me to make that recurring?" and what counts as yes.
 *
 * Offering after every turn would be exhausting, so this is deliberately
 * conservative: only for answers that are genuinely about recurring state, and
 * never twice for the same thing in a session.
 */

const RECURRING_WORTHY = new Set(["brief", "hackernews"]);

export function shouldOffer(intent: string, alreadyOffered: ReadonlySet<string>): boolean {
  return RECURRING_WORTHY.has(intent) && !alreadyOffered.has(intent);
}

const CONSENT = /^\s*(go for it|yes|yeah|yep|sure|do it|please do|make it|set it up|ok|okay|sounds good)\b/i;
const REFUSAL = /^\s*(no|nope|nah|don'?t|skip it|not now|later|cancel)\b/i;

/**
 * Consent must be affirmative and explicit. Silence, ambiguity, and anything
 * unrecognized all count as "not yet" — the wiki's governance rules treat a
 * standing or implied yes as no approval at all.
 */
export function isConsent(utterance: string): boolean {
  return CONSENT.test(utterance) && !REFUSAL.test(utterance);
}

export function isRefusal(utterance: string): boolean {
  return REFUSAL.test(utterance);
}
