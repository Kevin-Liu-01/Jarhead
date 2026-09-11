import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The priming prompt below measurably helps "hey jarvis" survive transcription,
 * but it has a nasty failure mode: fed near-silence, the model echoes the prompt
 * back as if it were speech. Observed on a 3-second room-tone recording, which
 * came back as the literal prompt text.
 *
 * Two guards, because either alone leaks. The energy gate avoids spending an API
 * call on silence at all; the echo check catches the case where there is some
 * noise but no speech.
 */
const PRIMING_PROMPT = "Jarvis, Hacker News, kevin-wiki, briefing, automation.";

/** Below this mean dBFS there is no speech worth sending. Room tone sits near -39. */
export const SILENCE_FLOOR_DB = -45;

export async function meanVolumeDb(wavPath: string): Promise<number | undefined> {
  try {
    const { stderr } = await run(
      "ffmpeg",
      ["-hide_banner", "-i", wavPath, "-af", "volumedetect", "-f", "null", "-"],
      { timeout: 8000 },
    );
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    return m?.[1] === undefined ? undefined : Number(m[1]);
  } catch {
    return undefined;
  }
}

/**
 * True when the transcript is just the priming prompt coming back, or one of
 * the stock phrases these models emit for silence.
 */
export function isHallucinatedSilence(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return true;

  const prompt = PRIMING_PROMPT.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized === prompt) return true;

  // Substantial overlap with the prompt and nothing else is also an echo.
  const promptWords = new Set(prompt.split(" "));
  const words = normalized.split(" ");
  const fromPrompt = words.filter((w) => promptWords.has(w)).length;
  if (words.length > 0 && fromPrompt / words.length > 0.8) return true;

  return /^(you|thank you|thanks for watching|bye|okay|silence|\.)$/.test(normalized);
}

/**
 * Speech to text.
 *
 * M0 uses OpenAI's `gpt-4o-mini-transcribe` because it is the only STT this
 * machine has a key for, and the DECISION doc explicitly allows cloud STT for
 * M0. This is a network hop on the hot path and therefore temporary.
 *
 * The M1 target is on-device: macOS 26 ships `SpeechAnalyzer`/`SpeechTranscriber`,
 * which needs a small Swift helper. The `Transcriber` interface below exists so
 * that swap is a one-line change at the call site, not a refactor.
 */

export interface TranscriptionResult {
  readonly text: string;
  readonly ms: number;
  readonly engine: string;
}

export interface Transcriber {
  readonly name: string;
  transcribe(wavPath: string): Promise<TranscriptionResult>;
}

export class OpenAiTranscriber implements Transcriber {
  readonly name = "openai:gpt-4o-mini-transcribe";

  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-mini-transcribe",
  ) {}

  async transcribe(wavPath: string): Promise<TranscriptionResult> {
    const startedAt = Date.now();

    // Don't spend a network round trip on room tone.
    const db = await meanVolumeDb(wavPath);
    if (db !== undefined && db < SILENCE_FLOOR_DB) {
      return { text: "", ms: Date.now() - startedAt, engine: `${this.name} (silent, ${db}dB)` };
    }

    const form = new FormData();
    form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.model);
    form.append("response_format", "json");
    // Priming the decoder with the assistant's name measurably reduces
    // "hey jarvis" landing as "hey travis" / "hey jervis".
    form.append("prompt", PRIMING_PROMPT);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`STT failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as { text?: string };
    const text = (body.text ?? "").trim();

    if (isHallucinatedSilence(text)) {
      return { text: "", ms: Date.now() - startedAt, engine: `${this.name} (echo rejected)` };
    }

    return { text, ms: Date.now() - startedAt, engine: this.name };
  }
}

/** Used by `--text` mode so the turn loop is identical with or without a mic. */
export class TypedTranscriber implements Transcriber {
  readonly name = "typed";
  constructor(private readonly text: string) {}
  async transcribe(): Promise<TranscriptionResult> {
    return { text: this.text, ms: 0, engine: this.name };
  }
}
