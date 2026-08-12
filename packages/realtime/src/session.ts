import { EventEmitter } from "node:events";

/**
 * A speech-to-speech session with GPT Realtime.
 *
 * This replaces the three-service chain — OpenAI STT, then Claude, then
 * ElevenLabs — with one model that hears audio and answers in audio. The chain
 * cost a transcript round trip (~700ms after the endpoint) before generation
 * could even start; here the model is already listening to the audio.
 *
 * It is also multimodal and calls tools natively, which is what makes "look at
 * my screen and point at the thing" one conversation instead of an orchestration
 * layer bolted on top of a text model.
 *
 * Two configuration choices are load-bearing:
 *
 * `create_response: false` — the server would otherwise answer every utterance
 * it hears. Jarhead must only answer after the wake phrase, so responses are
 * triggered by hand once the input transcript passes the gate. This is the whole
 * reason input transcription stays enabled on a speech-to-speech session.
 *
 * `interrupt_response: true` — the server truncates its own reply when Kevin
 * starts talking. Local playback still has to be killed separately, because
 * audio already handed to the player keeps going regardless of what the server
 * decides.
 *
 * Protocol confirmed by reading back a live `session.created`, not from memory:
 * the Beta shape is rejected outright now.
 */

export const REALTIME_URL = "wss://api.openai.com/v1/realtime";
export const REALTIME_MODEL = "gpt-realtime-2.1";
export const SAMPLE_RATE = 24000;

export interface RealtimeTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface SessionOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly instructions: string;
  /** One of the realtime voices. "cedar" and "marin" are the current pair. */
  readonly voice?: string;
  readonly tools?: readonly RealtimeTool[];
  /** Trailing silence before the server calls the turn over. */
  readonly silenceMs?: number;
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export class RealtimeSession extends EventEmitter {
  private ws: WebSocket | undefined;
  private ready = false;
  private closed = false;

  constructor(private readonly opts: SessionOptions) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    const url = `${REALTIME_URL}?model=${encodeURIComponent(this.opts.model ?? REALTIME_MODEL)}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
    } as unknown as string[]);
    this.ws = ws;

    ws.onmessage = (e: MessageEvent) => this.onMessage(String(e.data));
    ws.onerror = () => this.emit("error", new Error("realtime socket error"));
    ws.onclose = () => {
      this.ready = false;
      if (!this.closed) this.emit("close");
    };
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(payload));
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(msg["type"] ?? "");

    if (type === "session.created") {
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: this.opts.instructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: SAMPLE_RATE },
              // Kept on despite this being speech-to-speech: the transcript is
              // the only way to gate on the wake phrase.
              transcription: { model: "gpt-4o-mini-transcribe" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: this.opts.silenceMs ?? 400,
                create_response: false,
                interrupt_response: true,
              },
            },
            output: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, voice: this.opts.voice ?? "cedar" },
          },
          tools: this.opts.tools ?? [],
        },
      });
      return;
    }

    if (type === "session.updated") {
      this.ready = true;
      this.emit("open");
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.emit("speech-start");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.emit("endpoint");
      return;
    }

    // What Kevin said. The gate reads this.
    if (type.endsWith("input_audio_transcription.completed")) {
      this.emit("heard", String(msg["transcript"] ?? "").trim());
      return;
    }

    // Audio the model is speaking, as base64 PCM16.
    if (type === "response.output_audio.delta") {
      const delta = msg["delta"];
      if (typeof delta === "string") this.emit("audio", Buffer.from(delta, "base64"));
      return;
    }
    if (type === "response.output_audio.done") {
      this.emit("audio-done");
      return;
    }

    // What it is saying, in text — used for echo rejection and for display.
    if (type === "response.output_audio_transcript.delta") {
      const delta = msg["delta"];
      if (typeof delta === "string") this.emit("saying", delta);
      return;
    }
    if (type === "response.output_audio_transcript.done") {
      this.emit("said", String(msg["transcript"] ?? ""));
      return;
    }

    if (type === "response.function_call_arguments.done") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(msg["arguments"] ?? "{}")) as Record<string, unknown>;
      } catch {
        // A model that emits malformed arguments should get a tool error back,
        // not crash the session.
      }
      this.emit("tool", {
        callId: String(msg["call_id"] ?? ""),
        name: String(msg["name"] ?? ""),
        args,
      } satisfies ToolCall);
      return;
    }

    if (type === "response.done") {
      this.emit("response-done");
      return;
    }

    if (type === "error") {
      const err = msg["error"] as { message?: string } | undefined;
      this.emit("error", new Error(err?.message ?? "realtime error"));
    }
  }

  /** Feed mic PCM16 mono at SAMPLE_RATE. */
  appendAudio(pcm: Buffer): void {
    if (!this.ready) return;
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  /** Ask for a reply. Manual because create_response is off — see the class doc. */
  respond(): void {
    this.send({ type: "response.create" });
  }

  /** Stop the current reply server-side. Local playback is killed separately. */
  cancel(): void {
    this.send({ type: "response.cancel" });
  }

  sendToolResult(callId: string, output: unknown): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
  }

  /**
   * Hand the model a screenshot.
   *
   * The reason this session type is worth the rewrite: vision is part of the same
   * conversation rather than a separate model call whose answer has to be
   * summarised back into text.
   */
  sendImage(base64Png: string, note: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${base64Png}` },
          { type: "input_text", text: note },
        ],
      },
    });
  }

  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
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
