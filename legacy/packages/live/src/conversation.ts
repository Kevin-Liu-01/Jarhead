import { EventEmitter } from "node:events";
import type { JarvisConfig } from "@jarvis/core";
import { buildPrompt, classify, route } from "@jarvis/answers";
import { Brain, SentenceSplitter, Speaker } from "@jarvis/voice";
import { AckBank, playFile, shouldAck, type PlaybackHandle } from "@jarvis/ack";
import { judgeEcho, isRealInterruption } from "./echo.ts";
import { openMicStream, DEFAULT_MIC_STREAM, type MicStreamOptions } from "./micstream.ts";
import { RealtimeTranscriber } from "./transcribe.ts";
import { wantsAction } from "./intent.ts";
import { detect } from "@jarvis/ears";

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
  /**
   * Runs an on-screen action, narrating as it goes.
   *
   * Injected rather than imported because the implementation lives in
   * @jarvis/agent, which already depends on this package — importing it back
   * would be a cycle. Absent, everything falls through to a spoken answer.
   */
  readonly act?: (request: string, io: ActIO) => Promise<void>;
  /**
   * How long after waking a bare utterance still counts as a follow-up.
   *
   * DEFAULT IS ZERO: every turn needs "hey jarhead". That is what Kevin asked
   * for, and testing showed why he was right — with a 20s window open, a podcast
   * playing in the room woke it once and then got answered twice more, because
   * ambient speech inside the window is indistinguishable from a follow-up.
   *
   * Set JARVIS_FOLLOW_UP_MS to opt into conversational mode in a quiet room.
   */
  readonly followUpMs?: number;
  readonly log?: (line: string) => void;
}

export interface ActIO {
  /** Speaks one sentence and resolves when its audio finishes. */
  readonly speak: (sentence: string) => Promise<void>;
  readonly signal: AbortSignal;
}

export interface Conversation extends EventEmitter {
  on(event: "phase", listener: (phase: TurnPhase) => void): this;
  on(event: "heard", listener: (text: string, kind: "partial" | "final") => void): this;
  on(event: "answer", listener: (text: string) => void): this;
  on(event: "interrupted", listener: (by: string) => void): this;
  /** Fired when the wake phrase is heard, with whatever followed it. */
  on(event: "woke", listener: (command: string) => void): this;
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

/** Strict by default; see ConversationOptions.followUpMs for why. */
const DEFAULT_FOLLOW_UP_MS = Number(process.env["JARVIS_FOLLOW_UP_MS"] ?? 0);

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
  /** Until when a bare utterance counts as a follow-up rather than background talk. */
  private awakeUntil = 0;

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
   * The transcript landed. This is the earliest moment an answer can exist —
   * but only if Kevin was talking to Jarhead at all.
   */
  private onFinal(text: string): void {
    this.emit("heard", text, "final");
    if (this.phase === "speaking") return;

    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length < MIN_TURN_WORDS) {
      this.sleep();
      return;
    }

    const request = this.gateOnWakePhrase(text.trim());
    if (request === undefined) return;
    void this.answer(request);
  }

  /**
   * Everything the microphone hears is transcribed; almost none of it is meant
   * for Jarhead. This is the gate.
   *
   * Returns the command to answer, or undefined to stay quiet. A bare "hey
   * jarhead" with no command still counts as a wake — it opens the follow-up
   * window and gets a greeting — because that is how Kevin actually starts.
   */
  private gateOnWakePhrase(text: string): string | undefined {
    const match = detect(text);

    if (match.woke) {
      this.awakeUntil = Date.now() + (this.opts.followUpMs ?? DEFAULT_FOLLOW_UP_MS);
      this.log(`woke on "${match.matched}"`);
      this.emit("woke", match.command);
      // A bare wake gets a greeting rather than silence, so Kevin can tell it
      // heard him before he commits to a sentence.
      return match.bare ? "hey" : match.command;
    }

    if (Date.now() < this.awakeUntil) {
      this.log("follow-up within the wake window");
      this.awakeUntil = Date.now() + (this.opts.followUpMs ?? DEFAULT_FOLLOW_UP_MS);
      return text;
    }

    // Overheard, not addressed. This is the common case in a room with people
    // in it, and answering here is what makes an always-on assistant unbearable.
    this.log(`ignored (no wake phrase): "${text.slice(0, 48)}"`);
    this.sleep();
    return undefined;
  }

  private sleep(): void {
    this.ack?.stop();
    this.ack = undefined;
    this.setPhase("listening");
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

    // Only acknowledge if we are already awake. At the endpoint the transcript
    // does not exist yet, so there is no way to know whether this utterance was
    // addressed to Jarhead — and chirping at every overheard sentence is exactly
    // the behaviour the wake phrase is meant to prevent. The cost is that the
    // very first turn after waking has no ack to hide its latency behind.
    if (Date.now() >= this.awakeUntil) return;

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

  /**
   * Show something on screen instead of talking about it.
   *
   * Shares the turn machinery so an interruption cuts a demonstration off the
   * same way it cuts a sentence off — the abort signal is the same one.
   */
  private async performAction(utterance: string, id: number, abort: AbortController): Promise<void> {
    const speaker = this.opts.makeSpeaker ? this.opts.makeSpeaker() : this.defaultSpeaker();
    this.speaker = speaker;
    this.setPhase("speaking");
    this.ack?.stop();

    try {
      await this.opts.act?.(utterance, {
        speak: async (sentence: string) => {
          if (abort.signal.aborted) return;
          // Kept current so echo rejection can tell Kevin's voice from this one.
          this.speaking = sentence;
          const s = this.opts.makeSpeaker ? this.opts.makeSpeaker() : this.defaultSpeaker();
          this.speaker = s;
          s.say(sentence);
          await s.idle();
        },
        signal: abort.signal,
      });
    } finally {
      if (id === this.turnId) {
        this.speaking = undefined;
        this.speaker = undefined;
        this.abort = undefined;
        this.setPhase("listening");
      }
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

    // Route to the act loop before doing any answer work: gathering wiki context
    // for "point at the send button" would be wasted effort.
    const verdict = wantsAction(utterance);
    if (verdict.act && this.opts.act) {
      this.log(`acting: ${verdict.reason}`);
      const abort = new AbortController();
      this.abort = abort;
      await this.performAction(utterance, id, abort);
      return;
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
