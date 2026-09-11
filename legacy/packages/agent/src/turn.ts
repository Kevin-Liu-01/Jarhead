import { readConfig, type JarvisConfig } from "@jarvis/core";
import { buildPrompt, classify, route, useCacheDir } from "@jarvis/answers";
import { Brain, SentenceSplitter, Speaker, type Transcriber } from "@jarvis/voice";
import { AckBank, playFile, shouldAck, type PlaybackHandle } from "@jarvis/ack";
import { Timeline } from "./timeline.ts";

/**
 * One voice turn, start to finish.
 *
 * The hard rule from DECISION.md: nothing here may block the audio path on
 * work that isn't needed to produce the first sentence. Context gathering runs
 * before the model call because the model needs it, but the moment the first
 * sentence exists it goes to TTS — we never wait for the full answer.
 */

export interface TurnDeps {
  readonly config: JarvisConfig;
  readonly brain: Brain;
  readonly transcriber: Transcriber;
  /** Where the audio goes. Injected so tests can run silent. */
  readonly makeSpeaker: () => Speaker;
  /** Pre-synthesized acks. Undefined disables them (silent runs, tests). */
  readonly ackBank: AckBank | undefined;
  readonly verbose: boolean;
}

/**
 * What we expect the turn to cost, keyed on INTENT rather than route source.
 *
 * Intent comes from a pure keyword match, so it is free; route source is only
 * known after the context gathering that is itself part of the latency. Keying
 * on the route meant the ack fired at 1153ms — after a 1143ms qmd search had
 * already elapsed — which masked almost nothing. Keying on intent lets the ack
 * play first, which is the entire point of having one.
 *
 * Numbers are from the measured bench and only decide whether an ack is worth
 * playing at all, so rough is fine.
 */
const EXPECTED_MS: Readonly<Record<string, number>> = {
  greeting: 300,
  hackernews: 900,
  brief: 1200,
  memory: 1800,
  general: 1100,
};

/** Below this, an ack would arrive after the answer and just add noise. */
export const ACK_THRESHOLD_MS = 700;

export interface TurnOutcome {
  readonly transcript: string;
  /** ms to the ack, when one played — what Kevin actually perceives. */
  readonly perceivedMs: number | undefined;
  readonly intent: string;
  readonly answer: string;
  readonly firstAudioMs: number | undefined;
  readonly timeline: Timeline;
  readonly charactersSpoken: number;
}

export function makeDeps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  const config = overrides.config ?? readConfig();
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set. Run `pnpm run doctor`.");

  // Survives across processes, so `jarvis warm` actually helps the next turn.
  useCacheDir(config.stateDir);

  return {
    config,
    brain: overrides.brain ?? new Brain(config.anthropicApiKey),
    transcriber: overrides.transcriber ?? { name: "none", transcribe: async () => ({ text: "", ms: 0, engine: "none" }) },
    ackBank:
      overrides.ackBank ??
      (config.elevenLabsVoiceId
        ? new AckBank({
            stateDir: config.stateDir,
            voiceId: config.elevenLabsVoiceId,
            modelId: config.elevenLabsModelId,
          })
        : undefined),
    makeSpeaker:
      overrides.makeSpeaker ??
      (() => {
        if (!config.elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY is not set.");
        if (!config.elevenLabsVoiceId) throw new Error("ELEVENLABS_VOICE_ID is not set. Run `pnpm jarvis voices`.");
        return new Speaker({
          apiKey: config.elevenLabsApiKey,
          voiceId: config.elevenLabsVoiceId,
          modelId: config.elevenLabsModelId,
          outputFormat: "mp3_22050_32",
          latencyTier: 4,
        });
      }),
    verbose: overrides.verbose ?? true,
  };
}

/** Runs a turn from an already-captured utterance (or typed text). */
export async function runTurn(
  utterance: string,
  deps: TurnDeps,
  timeline = new Timeline(),
): Promise<TurnOutcome> {
  // Classify BEFORE gathering context: this is a pure keyword match with no
  // I/O, so the ack can start playing while retrieval and the model round trip
  // are still ahead of us.
  const intent = classify(utterance);
  const decision = shouldAck(intent, EXPECTED_MS[intent] ?? 1100, ACK_THRESHOLD_MS);

  let ack: PlaybackHandle | undefined;
  if (decision.ack && decision.category && deps.ackBank) {
    const path = deps.ackBank.pickAck(decision.category);
    if (path) {
      try {
        ack = playFile(path);
        timeline.mark("ack", `${decision.category}: ${decision.reason}`);
      } catch {
        // A missing bank file is not a reason to lose the turn.
      }
    }
  }

  const routed = await route(utterance, { wikiRoot: deps.config.kevinWikiRoot });
  timeline.mark("route", `${routed.intent} via ${routed.source}${routed.caveat ? " (degraded)" : ""}`);

  const speaker = deps.makeSpeaker();
  const splitter = new SentenceSplitter();
  let spokeFirst = false;

  const result = await deps.brain.stream(buildPrompt(utterance, routed), {
    onFirstToken: () => timeline.mark("llm_ttft"),
    onToken: (token) => {
      for (const sentence of splitter.push(token)) {
        if (!spokeFirst) {
          spokeFirst = true;
          timeline.mark("first_sentence", `"${sentence.slice(0, 48)}${sentence.length > 48 ? "…" : ""}"`);
          // By now the ack has had the whole TTFT window to play, and the real
          // audio needs ~200ms more for its own first byte. Stopping here keeps
          // the two from overlapping without clipping a short ack.
          ack?.stop();
        }
        speaker.say(sentence);
      }
    },
  });

  const tail = splitter.flush();
  if (tail) {
    // A short answer can finish without ever crossing a boundary, so the tail
    // IS the first chunk. Without this the benchmark silently drops those turns
    // and reports a first-chunk time better than reality.
    if (!spokeFirst) {
      spokeFirst = true;
      timeline.mark("first_sentence", `"${tail.slice(0, 48)}${tail.length > 48 ? "…" : ""}" (tail)`);
      ack?.stop();
    }
    speaker.say(tail);
  }
  timeline.mark("llm_done", `${result.outputTokens} tokens out`);

  ack?.stop();
  await speaker.idle();
  timeline.mark("audio_done", `${speaker.spoken.length} sentence(s)`);

  return {
    transcript: utterance,
    perceivedMs: timeline.at("ack") ?? undefined,
    intent: routed.intent,
    answer: result.text,
    // Measured from turn start (mic-open), not from when the Speaker was built.
    firstAudioMs: speaker.firstAudioAt === undefined ? undefined : timeline.since(speaker.firstAudioAt),
    timeline,
    charactersSpoken: speaker.charactersSpoken,
  };
}
