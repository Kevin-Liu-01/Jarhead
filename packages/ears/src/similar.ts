/**
 * Fuzzy matching for a name no transcriber has ever seen.
 *
 * "jarhead" is not in any dictation vocabulary, so it comes back as whatever
 * real word the model prefers. Observed live, all for the same clear utterance:
 * jawhead, chathead, jar head, jared. An enumerated list of variants loses this
 * race — every session produced a spelling the list did not have, and each miss
 * looks to Kevin like being ignored.
 *
 * Two rules instead, both cheap and deterministic:
 *
 * 1. STRUCTURE. The name is a short J-ish syllable followed by "head", and the
 *    "head" half survives transcription almost intact because it is a common
 *    word. So: anything ending in a head-like suffix, prefixed by a short
 *    syllable that starts with the sounds J tends to become, is a match. This
 *    covers the variants nobody thought to enumerate.
 *
 * 2. EDIT DISTANCE, for the ones that lose "head" entirely — "jared", "jarhad" —
 *    where structure cannot help but the whole word is still close.
 */

/** What "head" survives as. Vowel and final consonant are the unstable parts. */
const HEAD_SUFFIXES = [
  "head", "hed", "heads", "had", "heart", "hood", "het", "haid", "ead",
  // "bed" and "bad" only ever appear as the SECOND token of a pair, where a
  // J-ish first token already had to match — "jar bed" is a real transcription,
  // while the words alone are too common to trust.
  "bed", "bad",
] as const;

/**
 * What the initial J becomes.
 *
 * Affricates and velars, because that is the confusion space: J is voiced
 * postalveolar and STT slides it toward ch/sh/g/c/z, or drops it to a vowel.
 */
const PREFIX_STARTS = ["j", "ch", "sh", "g", "c", "z", "y", "d", "k", "t"] as const;

/**
 * A one-letter prefix is not a syllable.
 *
 * Without this, "ahead" matched — prefix "a", suffix "head" — and "go ahead and
 * do that" woke it. Every real variant has at least two prefix letters (ja, jar,
 * jaw, chat, gar).
 */
const MIN_PREFIX = 2;

/** Levenshtein, iterative, two rows. Names are short so this costs nothing. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/**
 * Does this word look like the name, structurally?
 *
 * Deliberately generous on the prefix and strict on the suffix: "head" is the
 * part that survives, so it carries the burden of proof. A bare "head" is
 * rejected — the prefix has to exist, or every mention of the word "forehead"
 * would wake it.
 */
const PAIR_ONLY_SUFFIXES = new Set(["bed", "bad"]);

export function looksStructural(word: string): boolean {
  for (const suffix of HEAD_SUFFIXES) {
    if (PAIR_ONLY_SUFFIXES.has(suffix)) continue;
    if (!word.endsWith(suffix) || word.length === suffix.length) continue;
    const prefix = word.slice(0, word.length - suffix.length);
    // A long prefix means a different compound word entirely: "arrowhead",
    // "letterhead", "figurehead" all end in head and none of them are the name.
    // Five, not four: "chart head" is a real transcription and "chart" is five
    // letters. Longer compounds are still excluded by the initial-sound guard —
    // letterhead, arrowhead, forehead and overhead all fail on their first letter.
    if (prefix.length < MIN_PREFIX || prefix.length > 5) continue;
    if (PREFIX_STARTS.some((p) => prefix.startsWith(p))) return true;
  }
  return false;
}

/** Close enough to "jarhead" to be a mangling of it. */
export function looksLikeName(word: string): boolean {
  if (word.length < 4) return false;
  if (looksStructural(word)) return true;

  // The edit-distance path needs the same initial-sound guard the structural one
  // has. Without it "ahead" is two edits from "jarhead" and "go ahead and do
  // that" woke him. A mishearing of a J does not start with a vowel.
  const first = word[0];
  if (first === undefined || !PREFIX_STARTS.some((p) => p[0] === first)) return false;

  // Two edits from five letters up: "jared" is distance 2 from "jarhead" (insert
  // h, insert a) and is one of the transcriptions actually observed, so a budget
  // of one silently dropped it.
  const budget = word.length <= 4 ? 1 : 2;
  return editDistance(word, "jarhead") <= budget;
}

/**
 * How many words the name occupies at `index`, or 0 if it is not there.
 *
 * Checks the two-word join first, because "jar head" is the single most common
 * transcription and matching only the first token would leave "head" behind as
 * a stray word in the command.
 */
export function nameLengthAt(words: readonly string[], index: number): number {
  const first = words[index];
  if (first === undefined) return 0;

  // The split, when it happens, lands on the syllable boundary: the second token
  // is the word "head" itself. Naively joining and re-testing was too loose —
  // "go ahead" became "goahead", which has a g prefix and a head suffix, and
  // woke him on an ordinary sentence.
  const second = words[index + 1];
  if (
    second !== undefined &&
    HEAD_SUFFIXES.some((suffix) => second === suffix) &&
    first.length >= MIN_PREFIX &&
    first.length <= 5 &&
    PREFIX_STARTS.some((p) => first.startsWith(p))
  ) {
    return 2;
  }

  if (looksLikeName(first)) return 1;
  return 0;
}
