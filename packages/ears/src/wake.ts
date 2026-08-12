/**
 * Wake word matching for "hey jarhead".
 *
 * The plan called for openWakeWord, which is Python + ONNX — a third runtime for a
 * TypeScript-only project. Instead the wake phrase is matched against a transcript,
 * which means the cost is one STT call per utterance rather than a continuously
 * running model. That is a worse latency story than a real always-on detector and
 * it is stated plainly here rather than hidden: swapping in a proper detector
 * later only replaces `detect()`.
 *
 * The matching has to be forgiving, because "jarhead" is not in any dictation
 * vocabulary and comes back mangled. Two failure modes matter most:
 *
 *   1. It is transcribed as TWO words — "jar head", "jar bed" — which a
 *      single-token match would miss entirely.
 *   2. It is transcribed as a real name the model prefers — "Jared", "Jarhad".
 *
 * Being deaf to the wake word is the worst possible failure here, since there is
 * no other way in. Being slightly over-eager only costs a spurious greeting.
 */

/** Single-token mishearings. */
const NAME_VARIANTS = [
  "jarhead",
  "jarhed",
  "jarhad",
  "jarheard",
  "jarhet",
  "jarheads",
  "jared",
  "jarred",
  "garhead",
  "charhead",
  "jorhead",
  "jarhede",
] as const;

/**
 * Two-token mishearings, matched as adjacent pairs.
 *
 * "jar head" is the single most likely transcription of an unfamiliar compound,
 * and it was invisible to a matcher that only compared one word at a time.
 */
const NAME_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["jar", "head"],
  ["jar", "hed"],
  ["jar", "bed"],
  ["jar", "had"],
  ["jarr", "head"],
  ["char", "head"],
  ["jaw", "head"],
  ["gar", "head"],
];

const GREETINGS = new Set(["hey", "hi", "hello", "yo", "ok", "okay", "hay", "ay", "a"]);

export interface WakeMatch {
  readonly woke: boolean;
  /** Everything after the wake phrase — the actual command, if there was one. */
  readonly command: string;
  /** Which variant matched, for logging when Kevin says it was not heard. */
  readonly matched: string | undefined;
  /** True when the utterance was ONLY the wake phrase, with no command attached. */
  readonly bare: boolean;
}

const NO_MATCH: WakeMatch = { woke: false, command: "", matched: undefined, bare: false };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Look for the wake phrase near the START of the utterance only.
 *
 * Scanning the whole string would fire on "I was telling Sarah about jarhead
 * yesterday", which is exactly the false accept that makes an always-on
 * assistant intolerable.
 */
export function detect(transcript: string, leadingWords = 4): WakeMatch {
  const normalized = normalize(transcript);
  if (!normalized) return NO_MATCH;

  const words = normalized.split(" ");
  const limit = Math.min(words.length, leadingWords);

  for (let i = 0; i < limit; i++) {
    const word = words[i];
    if (word === undefined) continue;

    const single = NAME_VARIANTS.find((v) => v === word);
    const next = words[i + 1];
    const pair = next === undefined ? undefined : NAME_PAIRS.find(([a, b]) => a === word && b === next);
    if (!single && !pair) continue;

    const consumed = pair ? i + 2 : i + 1;
    const before = words.slice(0, i);
    const after = words.slice(consumed).join(" ").trim();

    // A bare name with no greeting and no command is ambiguous — someone talking
    // ABOUT it rather than TO it. Require a greeting before or a command after.
    const hasGreeting = before.length > 0 && before.every((w) => GREETINGS.has(w));
    if (!hasGreeting && after.length === 0) return NO_MATCH;

    return {
      woke: true,
      command: after,
      matched: pair ? pair.join(" ") : single,
      bare: after.length === 0,
    };
  }

  return NO_MATCH;
}

/** True when the transcript is a wake phrase with nothing else — greet and stop. */
export function isBareWake(transcript: string): boolean {
  return detect(transcript).bare;
}
