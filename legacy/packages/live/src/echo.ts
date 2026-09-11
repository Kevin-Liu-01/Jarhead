/**
 * Telling Kevin's voice apart from Jarvis's own.
 *
 * There is no acoustic echo cancellation in this pipeline — that needs
 * `setVoiceProcessingEnabled` on an AVAudioEngine, which is native-only. So when
 * Jarvis speaks through laptop speakers, the microphone hears it, the
 * transcriber faithfully transcribes it, and without a guard Jarvis interrupts
 * itself and then answers its own sentence.
 *
 * The guard is textual rather than acoustic: if what just came back closely
 * matches what Jarvis is currently saying, it is echo. This works regardless of
 * speakers or headphones, needs no calibration, and fails in the safe direction —
 * a false "echo" verdict drops one interruption, while a false "Kevin" verdict
 * would have Jarvis talking to itself.
 */

/** Words too common to count as evidence of anything. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "at", "for", "with", "it", "its", "that", "this",
  "i", "you", "your", "my", "me", "so", "as", "if", "then", "there", "here",
]);

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function contentWords(text: string): string[] {
  return normalizeWords(text).filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

/**
 * Fraction of the heard content words that appear in what Jarvis said.
 *
 * Asymmetric on purpose: Jarvis's utterance is usually much longer than the
 * fragment the mic picks up, so comparing in the other direction would score
 * almost everything as different.
 */
export function echoOverlap(heard: string, spoken: string): number {
  const h = contentWords(heard);
  if (h.length === 0) return 0;
  const s = new Set(contentWords(spoken));
  if (s.size === 0) return 0;
  return h.filter((w) => s.has(w)).length / h.length;
}

export interface EchoVerdict {
  readonly isEcho: boolean;
  readonly overlap: number;
  readonly reason: string;
}

/**
 * Was `heard` just Jarvis hearing itself?
 *
 * A short fragment needs a high overlap to be dismissed, because "hacker news"
 * could plausibly be Kevin repeating the topic. A long fragment that mostly
 * matches is almost certainly the speakers.
 */
export function judgeEcho(heard: string, spoken: string | undefined): EchoVerdict {
  if (!spoken) return { isEcho: false, overlap: 0, reason: "jarvis is not speaking" };

  const words = contentWords(heard);
  const overlap = echoOverlap(heard, spoken);

  if (words.length === 0) {
    return { isEcho: true, overlap, reason: "no content words — not a real interruption" };
  }

  const threshold = words.length <= 2 ? 1 : words.length <= 5 ? 0.8 : 0.6;
  return {
    isEcho: overlap >= threshold,
    overlap,
    reason: `${words.length} content word(s), ${(overlap * 100).toFixed(0)}% matched what jarvis is saying (threshold ${(threshold * 100).toFixed(0)}%)`,
  };
}

/**
 * How people actually interrupt: short, sharp, and mostly stopwords.
 *
 * A pure word-count rule rejected "no wait" — which is the single most likely
 * thing Kevin will say to cut Jarvis off. These cues fire immediately, because
 * the whole point of an interruption is that waiting for more evidence defeats it.
 */
const CUES = new Set([
  "stop", "wait", "no", "nope", "hold", "actually", "hey", "shut", "quiet",
  "cancel", "nevermind", "forget", "enough", "pause", "hush",
]);

/**
 * Is this worth interrupting a sentence for?
 *
 * Server VAD fires on a cough, a chair, a door. Two content words is decent
 * evidence of intent — but an interruption cue on its own beats any count, since
 * that is exactly the case where hesitating would be worst.
 */
export function isRealInterruption(partial: string): boolean {
  const words = normalizeWords(partial);
  if (words.some((w) => CUES.has(w))) return true;
  return contentWords(partial).length >= 2 || words.length >= 3;
}
