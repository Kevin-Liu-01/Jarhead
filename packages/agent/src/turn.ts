import { readConfig, type JarvisConfig } from "@jarvis/core";
import { buildPrompt, route, useCacheDir } from "@jarvis/answers";
import { Brain, SentenceSplitter, Speaker, type Transcriber } from "@jarvis/voice";
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
  readonly verbose: boolean;
}

export interface TurnOutcome {
  readonly transcript: string;
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
    }
    speaker.say(tail);
  }
  timeline.mark("llm_done", `${result.outputTokens} tokens out`);

  await speaker.idle();
  timeline.mark("audio_done", `${speaker.spoken.length} sentence(s)`);

  return {
    transcript: utterance,
    intent: routed.intent,
    answer: result.text,
    // Measured from turn start (mic-open), not from when the Speaker was built.
    firstAudioMs: speaker.firstAudioAt === undefined ? undefined : timeline.since(speaker.firstAudioAt),
    timeline,
    charactersSpoken: speaker.charactersSpoken,
  };
}
