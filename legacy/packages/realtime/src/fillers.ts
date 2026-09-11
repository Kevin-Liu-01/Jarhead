/**
 * Things to say while a tool runs.
 *
 * Screen work is slow in a way that cannot be engineered away: a vision lookup
 * is ~1.5s and a window walk ~0.5s, and a request that chains two of them is
 * several seconds of dead air. Filling that with a short acknowledgement does
 * not make it faster, it makes it not feel broken — which is most of the
 * complaint. The model already improvises these; a curated set stops it
 * inventing long ones and stops it repeating the same three.
 *
 * Rules the list follows, because they are what make a filler work:
 *  - short enough to finish before the tool does (under about a second)
 *  - no promise about the answer, since the tool may find nothing
 *  - no question, which would invite Kevin to talk over the reply
 *  - varied in shape, not just wording, so ten in a row do not sound canned
 */

export const FILLERS: readonly string[] = [
  // Acknowledging
  "yeah, on it.",
  "sure thing.",
  "got it.",
  "yep, one sec.",
  "alright.",
  "okay, hopping on it.",
  "sounds good, working on it.",
  "on it now.",
  "sure, hang on.",
  "yep, doing that.",

  // Looking
  "let me look.",
  "taking a look.",
  "having a look now.",
  "checking the screen.",
  "let me see what's up there.",
  "scanning for it.",
  "looking for that now.",
  "let me find it.",
  "hunting it down.",
  "let me spot that.",

  // Working
  "working on it.",
  "give me a second.",
  "one moment.",
  "just a sec.",
  "hang tight.",
  "gimme a beat.",
  "two seconds.",
  "almost there.",
  "pulling that up.",
  "getting that now.",

  // Thinking
  "let me think.",
  "figuring that out.",
  "sorting that out.",
  "working through it.",
  "let me work that out.",

  // Casual
  "yeah, sure.",
  "no problem.",
  "easy.",
  "can do.",
  "you got it.",
  "right, let's see.",
  "okay then.",
  "cool, checking.",
  "alright, looking.",
  "yep, checking now.",

  // Slightly warmer, for variety in a long session
  "sure, let me grab that.",
  "happy to, one sec.",
  "yeah, let me check that for you.",
  "of course, looking now.",
  "no worries, checking.",
];

/**
 * A filler that is not the one just used.
 *
 * Avoiding immediate repeats matters more than true randomness: hearing the
 * same phrase twice in a row is the thing that reveals a canned list, while
 * hearing it again five turns later is invisible.
 */
export function pickFiller(
  last: string | undefined,
  random: () => number = Math.random,
): string {
  const pool = last === undefined ? FILLERS : FILLERS.filter((f) => f !== last);
  const choice = pool[Math.floor(random() * pool.length)];
  return choice ?? FILLERS[0] ?? "one sec.";
}

/**
 * Rendered for the system prompt.
 *
 * Handed to the model rather than played as pre-recorded audio: a realtime
 * session speaks in its own voice with its own prosody, so a spliced clip would
 * be audibly a different recording. The model picking from a list keeps one
 * voice and costs nothing extra, because the words ride the response already
 * being generated.
 */
export function fillerInstruction(): string {
  return (
    `When you are about to call a tool, FIRST say one short acknowledgement out loud so Kevin ` +
    `knows you heard him — screen tools take a few seconds and silence reads as broken. ` +
    `Pick one, vary it, never repeat the one you just used, and never say more than a few words:\n` +
    FILLERS.map((f) => `  "${f}"`).join("\n") +
    `\n\nSay nothing else before the tool call. Do not promise a result you have not got yet.`
  );
}
