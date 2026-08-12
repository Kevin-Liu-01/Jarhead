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
 * Words that may precede a leading vocative without making it a mention.
 *
 * "hey jarhead" and "so, jarhead" are address; "the thing about jarhead" is not.
 * What separates them is that everything before a real vocative is filler.
 */
const LEAD_IN = new Set([...GREETINGS, "so", "um", "uh", "well", "alright", "right", "and", "but"]);

/** Tags that may trail a vocative without making it a mention. */
const TRAIL_TAG = new Set(["please", "thanks", "thank", "you", "buddy", "man", "dude", "ok", "okay", "yeah"]);

/**
 * Is Kevin talking TO Jarhead, or ABOUT it?
 *
 * English marks direct address by position: a vocative sits at a clause
 * boundary, at the start ("jarhead, what's up") or the end ("what's up
 * jarhead", "you got that jarhead?"). A name buried mid-sentence is a mention —
 * "I was telling Sarah about jarhead yesterday and she laughed".
 *
 * The previous rule demanded the name in the first four words AND either a
 * recognised greeting before it or a command after it. That missed every
 * trailing vocative Kevin actually used: "whats up jarhead" has no greeting
 * ("whats up" is not in the list) and nothing after the name, so it scored as a
 * mention and was ignored. Three separate attempts of his went unanswered.
 *
 * Position is a cheaper and truer signal than a greeting whitelist, and it
 * needs no model call.
 */
export function detect(transcript: string): WakeMatch {
  const normalized = normalize(transcript);
  if (!normalized) return NO_MATCH;

  const words = normalized.split(" ");

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;

    const single = NAME_VARIANTS.find((v) => v === word);
    const next = words[i + 1];
    const pair = next === undefined ? undefined : NAME_PAIRS.find(([a, b]) => a === word && b === next);
    if (!single && !pair) continue;

    const consumed = pair ? i + 2 : i + 1;
    const before = words.slice(0, i);
    const after = words.slice(consumed);

    // A vocative sits at a clause edge: everything before it is filler, or
    // everything after it is a tag. Anything else is the name being discussed.
    // Distance-from-the-edge was too loose — "the thing about jarhead is..."
    // put the name at index 3 and read as address.
    const leadingVocative = before.every((w) => LEAD_IN.has(w));
    const trailingVocative = after.every((w) => TRAIL_TAG.has(w));
    if (!leadingVocative && !trailingVocative) return NO_MATCH;

    // A name on its own, with nothing either side, is someone saying the word —
    // unless a greeting precedes it, which makes it a hail.
    const hasGreeting = before.length > 0 && before.every((w) => GREETINGS.has(w));
    if (before.length === 0 && after.length === 0 && !hasGreeting) return NO_MATCH;

    // What Kevin actually asked for. A trailing vocative leaves the request in
    // front of the name ("whats up jarhead" -> "whats up"), so the command is
    // whichever side is not empty.
    const trailing = after.filter((w) => !TRAIL_TAG.has(w)).join(" ").trim();
    const leading = before.filter((w) => !LEAD_IN.has(w)).join(" ").trim();
    // A trailing vocative leaves the request in FRONT of the name
    // ("whats up jarhead" -> "whats up"), so take whichever side has content.
    const command = trailing || leading;

    return {
      woke: true,
      command,
      matched: pair ? pair.join(" ") : single,
      bare: command.length === 0,
    };
  }

  return NO_MATCH;
}

/** True when the transcript is a wake phrase with nothing else — greet and stop. */
export function isBareWake(transcript: string): boolean {
  return detect(transcript).bare;
}
