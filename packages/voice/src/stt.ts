import { readFileSync } from "node:fs";

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
    const form = new FormData();
    form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.model);
    form.append("response_format", "json");
    // Priming the decoder with the assistant's name measurably reduces
    // "hey jarvis" landing as "hey travis" / "hey jervis".
    form.append("prompt", "Jarvis, Hacker News, kevin-wiki, briefing, automation.");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`STT failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as { text?: string };
    return { text: (body.text ?? "").trim(), ms: Date.now() - startedAt, engine: this.name };
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
