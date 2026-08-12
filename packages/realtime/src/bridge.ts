import { EventEmitter } from "node:events";
import { detect, RecentSpeech } from "@jarvis/ears";
import { PcmPlayer } from "./playback.ts";
import { RealtimeSession, SAMPLE_RATE, type RealtimeTool, type ToolCall } from "./session.ts";

/**
 * Mic in, voice out, tools in between.
 *
 * The whole conversation now lives inside one model, so this file is mostly
 * plumbing and policy: who is allowed to make it speak, when to stop it, and how
 * tool results get back in. That is a much smaller job than the previous
 * pipeline, where this layer had to own the transcript, the answer and the
 * speech separately and keep their timing coherent.
 */

/**
 * `awake` is separate from `listening` on purpose: the microphone is always open,
 * so "listening" is the resting state and says nothing about whether Jarhead is
 * paying attention to Kevin specifically. Waking is what earns the brighter blue.
 */
export type Phase = "idle" | "listening" | "awake" | "thinking" | "speaking";

export interface BridgeOptions {
  readonly apiKey: string;
  readonly instructions: string;
  readonly voice?: string;
  readonly tools?: readonly RealtimeTool[];
  /** Executes a tool call. Never throws — a failure is a result the model reads. */
  readonly runTool?: (call: ToolCall) => Promise<unknown>;
  /**
   * How long after JARHEAD FINISHES SPEAKING a bare utterance counts as a reply.
   *
   * An earlier version opened this window on waking, and a podcast in the room
   * got answered twice. Opening it only after Jarhead has spoken is a much
   * narrower claim — it just said something to Kevin, so the next thing it hears
   * is probably his answer — and it is what makes a two-turn exchange possible
   * without saying the name into every sentence.
   */
  readonly followUpMs?: number;
  /** VAD sensitivity, 0..1. Higher ignores more room noise. */
  readonly threshold?: number;
  readonly silenceMs?: number;
  readonly noiseReduction?: "near_field" | "far_field" | "off";
  readonly log?: (line: string) => void;
}

export interface TurnTiming {
  readonly transcript: string;
  /** Endpoint to first audible syllable — what Kevin experiences. */
  readonly toSpeechMs: number | undefined;
  readonly interrupted: boolean;
}

/**
 * How long a conversation stays open with no wake phrase.
 *
 * Reset every time Jarhead finishes speaking, so a back-and-forth keeps itself
 * alive and the name is only needed to START one. Long enough to think before
 * replying; short enough that walking away ends it.
 */
const DEFAULT_FOLLOW_UP_MS = 45_000;

export class RealtimeBridge extends EventEmitter {
  private readonly session: RealtimeSession;
  private readonly player = new PcmPlayer(SAMPLE_RATE);
  private readonly log: (line: string) => void;

  private phase: Phase = "idle";
  private awakeUntil = 0;
  private endpointAt = 0;
  private saying = "";
  private interrupted = false;
  /** A rolling minute of the room, for requests that point at something already said. */
  private readonly recent = new RecentSpeech();

  constructor(private readonly opts: BridgeOptions) {
    super();
    this.log = opts.log ?? ((): void => undefined);
    this.session = new RealtimeSession({
      apiKey: opts.apiKey,
      instructions: opts.instructions,
      ...(opts.voice ? { voice: opts.voice } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.silenceMs !== undefined ? { silenceMs: opts.silenceMs } : {}),
      ...(opts.noiseReduction ? { noiseReduction: opts.noiseReduction } : {}),
    });
    this.wire();
  }

  private setPhase(next: Phase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.emit("phase", next);
  }

  private wire(): void {
    this.session.on("error", (e: Error) => this.emit("error", e));

    this.session.on("speech-start", () => {
      // Kevin talking while Jarhead talks is an interruption. The server
      // truncates its own reply, but audio already in the player keeps going —
      // so it has to be killed here as well.
      if (this.phase === "speaking") {
        this.interrupted = true;
        this.player.stop();
        this.session.cancel();
        this.log("interrupted");
        this.emit("interrupted");
      }
      this.setPhase("listening");
    });

    this.session.on("endpoint", () => {
      this.endpointAt = Date.now();
    });

    this.session.on("heard", (transcript: string) => {
      // Everything is remembered, addressed or not — that is the point. Nothing
      // leaves the machine unless a turn actually wakes.
      this.recent.add(transcript);
      this.emit("heard", transcript);
      this.gate(transcript);
    });

    this.session.on("audio", (pcm: Buffer) => {
      if (this.phase !== "speaking") this.setPhase("speaking");
      this.player.write(pcm);
    });

    this.session.on("saying", (delta: string) => {
      this.saying += delta;
    });

    this.session.on("said", (text: string) => {
      this.saying = "";
      this.emit("answer", text);
    });

    this.session.on("audio-done", () => {
      this.player.end();
    });

    this.session.on("tool", (call: ToolCall) => void this.handleTool(call));

    this.session.on("response-done", () => {
      this.emit("timing", {
        transcript: this.saying,
        toSpeechMs:
          this.player.audibleAt === undefined || this.endpointAt === 0
            ? undefined
            : this.player.audibleAt - this.endpointAt,
        interrupted: this.interrupted,
      } satisfies TurnTiming);
      this.interrupted = false;
      // Deliberately NOT setPhase("listening") here. The model has stopped
      // generating but the speaker is still going for seconds; flipping the
      // phase now made speech during playback stop counting as an interruption,
      // which is exactly the barge-in failure Kevin hit. onDrained owns it.
      if (!this.player.isPlaying) this.finishSpeaking();
    });

    // The real end of a turn: the last sample has played.
    this.player.onDrained = () => this.finishSpeaking();
  }

  /**
   * Only answer when spoken to.
   *
   * The server is configured with create_response off precisely so this decision
   * is ours: everything the microphone hears is transcribed, and almost none of
   * it is addressed to Jarhead.
   */
  private gate(transcript: string): void {
    if (!transcript) return;

    // An explicit dismissal ends the conversation immediately, so Kevin has a
    // way out that does not involve waiting 45 seconds in silence.
    if (this.awakeUntil > Date.now() && /^\s*(never ?mind|forget it|that'?s all|we'?re done|go to sleep|stop listening)\b/i.test(transcript)) {
      this.awakeUntil = 0;
      this.log("conversation closed");
      this.emit("slept");
      this.setPhase("listening");
      return;
    }

    const match = detect(transcript);
    if (match.woke) {
      this.log(`woke on "${match.matched}"`);
      this.emit("woke", match.command);
      // Brighten the moment the name lands, before any model work starts. This
      // is the acknowledgement Kevin was missing when he said the name and
      // nothing happened.
      this.setPhase("awake");
      this.setPhase("thinking");

      // "you got that jarhead?" — the thing he means was said before he said the
      // name, possibly to someone else. Attach the window only when the request
      // actually leans on it, so a self-contained question stays cheap and does
      // not drag unrelated room chatter into the answer.
      if (RecentSpeech.needsContext(match.command)) {
        const heardBefore = this.recent.context();
        if (heardBefore) {
          this.session.sendText(
            `Recently overheard in the room (for reference only — Kevin may be pointing at one of these):\n${heardBefore}`,
          );
          this.log("attached recent speech as context");
        }
      }

      this.session.respond();
      return;
    }

    if (Date.now() < this.awakeUntil) {
      // Mid-conversation. Kevin does not re-introduce himself between sentences
      // and should not have to here either — the name starts a conversation, it
      // does not punctuate one.
      this.log("in conversation");
      this.setPhase("thinking");
      this.session.respond();
      return;
    }

    this.log(`ignored: "${transcript.slice(0, 48)}"`);
  }

  /**
   * A reply has finished being heard.
   *
   * This is where the follow-up window opens, not when the wake phrase lands.
   * Kevin said "hello jarhead", got an answer, then asked his actual question —
   * and it was ignored, because a strict gate wants the name on every single
   * utterance. Having just spoken TO him is the one moment where a bare reply is
   * obviously addressed back, so that is the only moment the gate relaxes.
   */
  private finishSpeaking(): void {
    if (this.phase === "speaking" || this.phase === "thinking") {
      // Every reply re-opens the window, so the conversation lasts as long as it
      // is actually a conversation.
      this.awakeUntil = Date.now() + (this.opts.followUpMs ?? DEFAULT_FOLLOW_UP_MS);
    }
    this.setPhase("listening");
  }

  private async handleTool(call: ToolCall): Promise<void> {
    this.emit("tool", call.name, call.args);
    let output: unknown;
    try {
      output = this.opts.runTool
        ? await this.opts.runTool(call)
        : { error: `no tool runner wired for "${call.name}"` };
    } catch (e) {
      // A thrown tool would otherwise leave the model waiting forever for a
      // result that is never coming, which reads as Jarhead freezing mid-sentence.
      output = { error: (e as Error).message };
    }
    this.session.sendToolResult(call.callId, output);
    // The model needs a nudge to continue after a tool result, because
    // create_response is off for the whole session.
    this.session.respond();
  }

  /** Hand the model a screenshot as part of the conversation. */
  showImage(base64Png: string, note: string): void {
    this.session.sendImage(base64Png, note);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.session.once("open", resolve);
      this.session.once("error", reject);
      this.session.connect();
    });
    this.setPhase("listening");
  }

  /** Feed mic PCM16 mono at 24kHz. */
  feed(pcm: Buffer): void {
    this.session.appendAudio(pcm);
  }

  stop(): void {
    this.player.stop();
    this.session.close();
    this.setPhase("idle");
  }
}
