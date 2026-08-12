import { EventEmitter } from "node:events";
import type { JarvisConfig } from "@jarvis/core";
import { buildPrompt, classify, route } from "@jarvis/answers";
import { Brain, SentenceSplitter, Speaker } from "@jarvis/voice";
import { AckBank, playFile, shouldAck, type PlaybackHandle } from "@jarvis/ack";
import { judgeEcho, isRealInterruption } from "./echo.ts";
import { openMicStream, DEFAULT_MIC_STREAM, type MicStreamOptions } from "./micstream.ts";
import { RealtimeTranscriber } from "./transcribe.ts";

/**
 * Full-duplex conversation: always listening, answers the moment you stop, and
 * can be cut off mid-sentence.
 *
 * Timeline, measured on this machine rather than assumed:
 *
 *   speech ends ──► 140ms  server VAD endpoint  ──► ack audio plays (on disk, no network)
 *               ──► 700ms  transcript ready     ──► answer generation starts
 *
 * The original design fired the answer at the endpoint using the partial
 * transcript, on the assumption that transcription streams *during* speech. It
 * does not: `gpt-4o-mini-transcribe` emits every delta AFTER speech_stopped, so
 * the partial is empty at the endpoint and that version would have answered
 * nothing at all. The endpoint is still valuable — it is what triggers the ack,
 * ~550ms before there is any text to work with — but the answer has to wait for
 * the transcript.
 *
 * Interruption is the mirror image: the microphone never stops, so speech during
 * playback aborts the model stream and kills the audio immediately. The hard part
 * is not the abort, it is knowing whether the microphone heard Kevin or heard
 * Jarvis — see echo.ts.
 */

export type TurnPhase = "idle" | "listening" | "thinking" | "speaking";

export interface ConversationOptions {
  readonly config: JarvisConfig;
  readonly openAiKey: string;
  readonly mic?: MicStreamOptions;
  /** Injected in tests so no audio device or network is required. */
  readonly makeSpeaker?: () => Speaker;
  readonly log?: (line: string) => void;
}

export interface Conversation extends EventEmitter {
  on(event: "phase", listener: (phase: TurnPhase) => void): this;
  on(event: "heard", listener: (text: string, kind: "partial" | "final") => void): this;
  on(event: "answer", listener: (text: string) => void): this;
  on(event: "interrupted", listener: (by: string) => void): this;
  on(event: "metrics", listener: (m: TurnMetrics) => void): this;
  on(event: "error", listener: (e: Error) => void): this;
}

export interface TurnMetrics {
  readonly transcript: string;
  /** Endpoint to first audible syllable — the number Kevin experiences. */
  readonly toFirstAudioMs: number | undefined;
  readonly toAckMs: number | undefined;
  readonly ttftMs: number | undefined;
  readonly interrupted: boolean;
}

const MIN_TURN_WORDS = 1;

export class LiveConversation extends EventEmitter {
  private readonly brain: Brain;
  private readonly ackBank: AckBank | undefined;
  private readonly log: (line: string) => void;

  private transcriber: RealtimeTranscriber | undefined;
  private stopMic: (() => void) | undefined;

  private phase: TurnPhase = "idle";
  private speaker: Speaker | undefined;
  private ack: PlaybackHandle | undefined;
  private abort: AbortController | undefined;

  /** What Jarvis is currently saying, for echo rejection. */
  private speaking: string | undefined;
  /** When the utterance ended — everything Kevin perceives is measured from here. */
  private endpointAt = 0;
  private ackAt: number | undefined;
  /** Guards against two turns running at once. */
  private turnId = 0;

  constructor(private readonly opts: ConversationOptions) {
    super();
    const cfg = opts.config;
    if (!cfg.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.brain = new Brain(cfg.anthropicApiKey);
    this.log = opts.log ?? (() => undefined);
    this.ackBank = cfg.elevenLabsVoiceId
      ? new AckBank({ stateDir: cfg.stateDir, voiceId: cfg.elevenLabsVoiceId, modelId: cfg.elevenLabsModelId })
      : undefined;
  }

  private setPhase(next: TurnPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.emit("phase", next);
  }

  async start(): Promise<void> {
    const transcriber = new RealtimeTranscriber({ apiKey: this.opts.openAiKey });
    this.transcriber = transcriber;

    transcriber.on("error", (e: Error) => this.emit("error", e));
    transcriber.on("partial", (text: string) => this.onPartial(text));
    transcriber.on("speech-start", () => this.onSpeechStart());
    transcriber.on("endpoint", () => this.onEndpoint());
    transcriber.on("final", (text: string) => this.onFinal(text));

    await new Promise<void>((resolve, reject) => {
      transcriber.once("open", resolve);
      transcriber.once("error", reject);
      transcriber.connect();
    });

    const { stream, stop } = openMicStream(this.opts.mic ?? DEFAULT_MIC_STREAM);
    this.stopMic = stop;
    stream.on("data", (pcm: Buffer) => transcriber.send(pcm));
    stream.on("error", (e: Error) => this.emit("error", e));

    this.setPhase("listening");
  }

  private onPartial(text: string): void {
    this.emit("heard", text, "partial");
    // Interruption is decided on the partial, because waiting for a final would
    // mean talking over Kevin for another half second.
    if (this.phase === "speaking") this.considerInterruption(text);
  }

  private onSpeechStart(): void {
    if (this.phase === "listening") this.setPhase("listening");
  }

  /**
   * Cut playback off — but only for Kevin, not for Jarvis's own voice coming
   * back through the speakers.
   */
  private considerInterruption(partial: string): void {
    if (!isRealInterruption(partial)) return;

    const verdict = judgeEcho(partial, this.speaking);
    if (verdict.isEcho) {
      this.log(`ignored own voice: ${verdict.reason}`);
      return;
    }

    this.log(`interrupted: "${partial}"`);
    this.emit("interrupted", partial);
    this.stopSpeaking();
    this.setPhase("listening");
  }

  private stopSpeaking(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.ack?.stop();
    this.ack = undefined;
    this.speaker?.stop();
    this.speaker = undefined;
    this.speaking = undefined;
  }

  /**
   * The transcript landed. This is the earliest moment an answer can exist.
   */
  private onFinal(text: string): void {
    this.emit("heard", text, "final");
    if (this.phase === "speaking") return;

    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < MIN_TURN_WORDS) {
      this.ack?.stop();
      this.ack = undefined;
      this.setPhase("listening");
      return;
    }
    void this.answer(text.trim());
  }

  /**
   * Server VAD says the utterance ended.
   *
   * There is no usable text yet, so this only starts the clock and plays the
   * acknowledgement — which is the entire reason perceived latency is ~150ms
   * while the transcript is still ~550ms away.
   */
  private onEndpoint(): void {
    if (this.phase === "speaking") return; // interruption already handled it
    this.endpointAt = Date.now();
    this.setPhase("thinking");
    this.playAck();
  }

  private playAck(): void {
    if (!this.ackBank || this.ack) return;
    const path = this.ackBank.pickAck("thinking");
    if (!path) return;
    try {
      this.ack = playFile(path);
      this.ackAt = Date.now();
    } catch {
      // A missing bank file is not worth losing the turn over.
    }
  }

  private async answer(utterance: string): Promise<void> {
    const id = ++this.turnId;
    // Measured from the endpoint, not from now: the endpoint is when Kevin
    // stopped talking and started waiting.
    const startedAt = this.endpointAt || Date.now();
    this.setPhase("thinking");

    // A greeting's whole answer is shorter than an ack, so drop it if one is
    // already playing and the turn turns out to be trivial.
    const intent = classify(utterance);
    if (!shouldAck(intent, 1200, 500).ack) {
      this.ack?.stop();
      this.ack = undefined;
    }

    const routed = await route(utterance, { wikiRoot: this.opts.config.kevinWikiRoot });
    if (id !== this.turnId) return; // interrupted while gathering context

    const speaker = this.opts.makeSpeaker ? this.opts.makeSpeaker() : this.defaultSpeaker();
    this.speaker = speaker;
    const splitter = new SentenceSplitter();
    const abort = new AbortController();
    this.abort = abort;

    let ttftMs: number | undefined;
    let spoke = false;
    let answer = "";

    try {
      const result = await this.brain.stream(buildPrompt(utterance, routed), {
        signal: abort.signal,
        maxTokens: 350,
        onFirstToken: (ms) => {
          ttftMs = ms;
        },
        onToken: (token) => {
          answer += token;
          // Kept current so echo rejection can compare against what is actually
          // being said, not against the finished answer.
          this.speaking = answer;
          for (const sentence of splitter.push(token)) {
            if (!spoke) {
              spoke = true;
              this.setPhase("speaking");
              this.ack?.stop();
            }
            speaker.say(sentence);
          }
        },
      });

      const tail = splitter.flush();
      if (tail) {
        if (!spoke) {
          spoke = true;
          this.setPhase("speaking");
          this.ack?.stop();
        }
        speaker.say(tail);
      }
      answer = result.text;
      this.emit("answer", answer);

      await speaker.idle();
    } catch (e) {
      if (abort.signal.aborted) {
        this.emit("metrics", {
          transcript: utterance,
          toFirstAudioMs: undefined,
          toAckMs: this.ackAt === undefined ? undefined : this.ackAt - startedAt,
          ttftMs,
          interrupted: true,
        });
        return;
      }
      this.emit("error", e as Error);
      return;
    } finally {
      if (id === this.turnId) {
        this.speaking = undefined;
        this.speaker = undefined;
        this.abort = undefined;
        this.ack?.stop();
        this.ack = undefined;
        this.setPhase("listening");
      }
    }

    this.emit("metrics", {
      transcript: utterance,
      toFirstAudioMs: speaker.firstAudioAt === undefined ? undefined : speaker.firstAudioAt - startedAt,
      toAckMs: this.ackAt === undefined ? undefined : this.ackAt - startedAt,
      ttftMs,
      interrupted: false,
    });
    this.ackAt = undefined;
  }

  private defaultSpeaker(): Speaker {
    const cfg = this.opts.config;
    if (!cfg.elevenLabsApiKey || !cfg.elevenLabsVoiceId) {
      throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required to speak");
    }
    return new Speaker({
      apiKey: cfg.elevenLabsApiKey,
      voiceId: cfg.elevenLabsVoiceId,
      modelId: cfg.elevenLabsModelId,
      outputFormat: "mp3_22050_32",
      latencyTier: 4,
    });
  }

  stop(): void {
    this.stopSpeaking();
    this.stopMic?.();
    this.transcriber?.close();
    this.setPhase("idle");
  }
}
