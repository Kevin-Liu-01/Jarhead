/**
 * Endpointing from ffmpeg's `silencedetect` output.
 *
 * The parsing lives here as pure functions rather than inline in the capture
 * code so it can be tested without a microphone — which matters a lot on this
 * machine, where the Microphone TCC grant is missing and ffmpeg hangs rather
 * than erroring.
 */

export interface SilenceEvent {
  readonly kind: "start" | "end";
  /** Seconds into the stream. */
  readonly at: number;
  /** Only present on `end` events. */
  readonly duration: number | undefined;
}

const SILENCE_START = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END = /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/;

/** Extract every silence event from a chunk of ffmpeg stderr. */
export function parseSilence(stderr: string): SilenceEvent[] {
  const events: SilenceEvent[] = [];

  for (const line of stderr.split("\n")) {
    const end = SILENCE_END.exec(line);
    if (end?.[1] !== undefined && end[2] !== undefined) {
      events.push({ kind: "end", at: Number(end[1]), duration: Number(end[2]) });
      continue;
    }
    const start = SILENCE_START.exec(line);
    if (start?.[1] !== undefined) {
      events.push({ kind: "start", at: Number(start[1]), duration: undefined });
    }
  }

  return events;
}

export interface EndpointState {
  readonly heardSpeech: boolean;
  readonly silenceSince: number | undefined;
  readonly shouldCut: boolean;
}

export const INITIAL_ENDPOINT: EndpointState = {
  heardSpeech: false,
  silenceSince: undefined,
  shouldCut: false,
};

/**
 * Fold a silence event into the endpoint decision.
 *
 * The ordering rule that matters: a `silence_start` before any speech is the
 * pause while the user gets around to talking, and must NOT end the recording.
 * Only silence *after* speech is an endpoint. Getting this backwards produces
 * an assistant that hangs up before you open your mouth.
 */
export function applySilence(state: EndpointState, event: SilenceEvent): EndpointState {
  if (event.kind === "end") {
    // Silence ended, so someone is talking.
    return { heardSpeech: true, silenceSince: undefined, shouldCut: false };
  }

  if (!state.heardSpeech) return state;

  return { heardSpeech: true, silenceSince: event.at, shouldCut: true };
}

/** Fold a whole stderr buffer at once. Used by tests and by replay. */
export function endpointFrom(stderr: string, initial: EndpointState = INITIAL_ENDPOINT): EndpointState {
  return parseSilence(stderr).reduce(applySilence, initial);
}

/**
 * Barge-in: did the user start talking while Jarvis was speaking?
 *
 * Deliberately stricter than normal endpointing. Echo cancellation is not
 * available in this pure-TypeScript path, so Jarvis can hear its own voice
 * through the speakers; a low bar would make it interrupt itself constantly.
 * Requiring sustained speech is the cheap defence until AEC exists.
 */
export function isBargeIn(events: readonly SilenceEvent[], minSpeechSeconds: number): boolean {
  let speechStartedAt: number | undefined;

  for (const event of events) {
    if (event.kind === "end") {
      speechStartedAt ??= event.at;
      continue;
    }
    if (speechStartedAt !== undefined && event.at - speechStartedAt >= minSpeechSeconds) {
      return true;
    }
    speechStartedAt = undefined;
  }

  return false;
}
