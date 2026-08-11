/**
 * Wake word matching.
 *
 * The plan called for openWakeWord, which is Python + ONNX — a third runtime for a
 * TypeScript-only project. Instead the wake word is matched against a transcript,
 * which means the cost is one STT call per utterance rather than a continuously
 * running model. That is a worse latency story than a real always-on detector and
 * it is stated plainly here rather than hidden: this is the M1-in-TypeScript
 * compromise, and swapping in a proper detector later only replaces `detect()`.
 *
 * The matching itself has to be forgiving. "hey jarvis" is reliably misheard, and
 * every one of the variants below was either observed or is a documented
 * confusion for this phrase. Rejecting them would make the assistant feel deaf.
 */

/** Phonetically-close mishearings that should still count as the wake word. */
const NAME_VARIANTS = [
  "jarvis",
  "jarvus",
  "jervis",
  "jarviss",
  "javis",
  "jaris",
  "travis",
  "charvis",
  "harvis",
  "garvis",
  "jarvi",
] as const;

const GREETING_PREFIX = /^\s*(hey|hi|hello|yo|ok|okay|hey there)\b[\s,]*/i;

export interface WakeMatch {
  readonly woke: boolean;
  /** Everything after the wake phrase — the actual command, if there was one. */
  readonly command: string;
  /** Which variant matched, for logging when Kevin says it was not heard. */
  readonly matched: string | undefined;
  /** True when the utterance was ONLY the wake word, with no command attached. */
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
 * Look for the wake word near the START of the utterance only.
 *
 * Scanning the whole string would fire on "I was telling Sarah about Jarvis
 * yesterday", which is exactly the false accept that makes an always-on
 * assistant intolerable.
 */
export function detect(transcript: string, leadingWords = 3): WakeMatch {
  const normalized = normalize(transcript);
  if (!normalized) return NO_MATCH;

  const words = normalized.split(" ");
  const head = words.slice(0, leadingWords);

  for (let i = 0; i < head.length; i++) {
    const word = head[i];
    if (word === undefined) continue;

    const variant = NAME_VARIANTS.find((v) => v === word);
    if (!variant) continue;

    // A bare name with no greeting and no command is ambiguous — someone talking
    // *about* Jarvis rather than *to* it. Require either a greeting before it or
    // a command after it.
    const before = words.slice(0, i).join(" ");
    const after = words.slice(i + 1).join(" ").trim();
    const hasGreeting = i > 0 && GREETING_PREFIX.test(`${before} `);

    if (!hasGreeting && after.length === 0) return NO_MATCH;

    return { woke: true, command: after, matched: variant, bare: after.length === 0 };
  }

  return NO_MATCH;
}

/** True when the transcript is a wake word with nothing else — greet and stop. */
export function isBareWake(transcript: string): boolean {
  return detect(transcript).bare;
}
