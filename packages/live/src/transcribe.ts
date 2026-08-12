import { EventEmitter } from "node:events";

/**
 * Streaming transcription over OpenAI's realtime WebSocket.
 *
 * This replaces record-then-upload, which cost ~2.6s before a single token of
 * the answer existed: 1.2s waiting out the silence timeout plus ~1.4s uploading
 * and transcribing. Here the audio is transcribed *while* Kevin talks, so by the
 * time he stops the text already exists.
 *
 * Measured against synthesized speech on this machine:
 *   speech_stopped     140ms after the last syllable
 *   final transcript   700ms after the last syllable
 *
 * The 140ms mark is the one that matters — the answer can start generating from
 * the accumulated partials without waiting for the final, which is what makes it
 * feel like the assistant was already listening rather than processing.
 *
 * Protocol note: the Beta shape (`OpenAI-Beta: realtime=v1`,
 * `transcription_session.update`) is rejected outright now —
 * "The Realtime Beta API is no longer supported" — so this speaks the GA shape,
 * confirmed by reading back a live `session.created`.
 */

export const TRANSCRIBE_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const SAMPLE_RATE = 24000;
export const STT_MODEL = "gpt-4o-mini-transcribe";

export interface TranscriberOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Lower is more eager to hear speech. 0.5 is the server default. */
  readonly threshold?: number;
  /** Trailing silence before the turn is considered over. */
  readonly silenceMs?: number;
}

export interface Transcriber extends EventEmitter {
  /** Partial text, growing as Kevin speaks. */
  on(event: "partial", listener: (text: string) => void): this;
  /** Server VAD heard speech begin — the barge-in trigger. */
  on(event: "speech-start", listener: () => void): this;
  /** Server VAD decided the utterance ended. Fire the answer here. */
  on(event: "endpoint", listener: (partial: string) => void): this;
  /** Authoritative transcript, later and more accurate than the partials. */
  on(event: "final", listener: (text: string) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "error", listener: (e: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

export class RealtimeTranscriber extends EventEmitter {
  private ws: WebSocket | undefined;
  private partial = "";
  private ready = false;
  private closed = false;

  constructor(private readonly opts: TranscriberOptions) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    const ws = new WebSocket(TRANSCRIBE_URL, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    } as unknown as string[]);
    this.ws = ws;

    ws.onmessage = (event: MessageEvent) => this.onMessage(String(event.data));
    ws.onerror = () => this.emit("error", new Error("transcription socket error"));
    ws.onclose = () => {
      this.ready = false;
      if (!this.closed) this.emit("close");
    };
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; transcript?: string; delta?: string; error?: { message?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }

    const type = msg.type ?? "";

    if (type === "session.created") {
      this.ws?.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: SAMPLE_RATE },
                transcription: { model: this.opts.model ?? STT_MODEL },
                turn_detection: {
                  type: "server_vad",
                  threshold: this.opts.threshold ?? 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: this.opts.silenceMs ?? 200,
                },
              },
            },
          },
        }),
      );
      return;
    }

    if (type === "session.updated") {
      this.ready = true;
      this.emit("open");
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.partial = "";
      this.emit("speech-start");
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.emit("endpoint", this.partial.trim());
      return;
    }

    if (type.endsWith("transcription.delta")) {
      this.partial += msg.delta ?? "";
      this.emit("partial", this.partial.trim());
      return;
    }

    if (type.endsWith("transcription.completed")) {
      const text = (msg.transcript ?? this.partial).trim();
      this.partial = "";
      this.emit("final", text);
      return;
    }

    if (type === "error") {
      this.emit("error", new Error(msg.error?.message ?? "transcription error"));
    }
  }

  /** Feed raw PCM16 mono at SAMPLE_RATE. Dropped silently until the session is ready. */
  send(pcm: Buffer): void {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      // Already gone.
    }
  }
}
