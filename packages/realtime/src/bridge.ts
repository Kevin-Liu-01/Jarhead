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
  private session: RealtimeSession;
  private readonly player = new PcmPlayer(SAMPLE_RATE);
  private readonly log: (line: string) => void;

  private phase: Phase = "idle";
  private awakeUntil = 0;
  private endpointAt = 0;
  private saying = "";
  private interrupted = false;
  /** A rolling minute of the room, for requests that point at something already said. */
  private readonly recent = new RecentSpeech();

  /**
   * Tool calls still running for the current response.
   *
   * The API allows exactly one response in flight. Asking for a continuation
   * after EACH tool result meant a response with two tool calls sent two
   * response.create events, and the second came back "Conversation already has
   * an active response in progress" — which surfaced as Jarhead going silent
   * after thinking, with no clue why. The continuation must be requested once,
   * after the last result lands.
   */
  private outstandingTools = 0;
  private responseEnded = false;

  constructor(private readonly opts: BridgeOptions) {
    super();
    this.log = opts.log ?? ((): void => undefined);
    this.session = this.buildSession();
    this.wire();
  }

  private buildSession(): RealtimeSession {
    const opts = this.opts;
    return new RealtimeSession({
      apiKey: opts.apiKey,
      instructions: opts.instructions,
      ...(opts.voice ? { voice: opts.voice } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.silenceMs !== undefined ? { silenceMs: opts.silenceMs } : {}),
      ...(opts.noiseReduction ? { noiseReduction: opts.noiseReduction } : {}),
    });
  }

  private setPhase(next: Phase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.emit("phase", next);
  }

  /**
   * Sessions expire. Reconnect rather than die.
   *
   * A realtime session is capped at 60 minutes, and when it lapses the socket
   * closes with "Your session hit the maximum duration". Nothing reopened it, so
   * an always-on assistant went deaf after an hour while its microphone capture
   * kept running — a zombie holding the device, which then blocked the next
   * start. An hour is short enough that this is the normal case, not an edge one.
   */
  private reconnectMs = 500;
  private reconnecting = false;
  private stopped = false;

  private reconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;

    setTimeout(() => {
      if (this.stopped) return;
      this.log(`reconnecting the realtime session`);
      this.player.stop();
      this.outstandingTools = 0;
      this.responseEnded = false;

      const next = this.buildSession();
      this.session = next;
      this.wire();
      next.once("open", () => {
        this.reconnecting = false;
        this.reconnectMs = 500;
        this.log("realtime session back up");
        this.setPhase("listening");
      });
      next.connect();
      // Backoff for the failure that is not expiry — a revoked key would
      // otherwise reconnect in a tight loop forever.
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    }, this.reconnectMs);
  }

  private wire(): void {
    this.session.on("error", (e: Error) => {
      this.emit("error", e);
      // Expiry arrives as an error before the close, so catch it here too.
      if (/maximum duration|session expired/i.test(e.message)) this.reconnect();
    });
    this.session.on("close", () => {
      if (!this.stopped) {
        this.log("realtime session closed");
        this.reconnect();
      }
    });

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

    this.session.on("tool", (call: ToolCall) => {
      this.outstandingTools += 1;
      void this.handleTool(call);
    });

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
      this.responseEnded = true;

      // Tools still running means this turn is not over — the model asked for
      // something and is waiting on it. Continuing is the tool handler's job.
      if (this.outstandingTools > 0) return;

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
      this.outstandingTools = 0;
      this.responseEnded = false;

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
    this.outstandingTools -= 1;

    // Exactly one continuation, once every result is in and the response that
    // asked for them has finished. Any earlier and the API rejects it for
    // overlapping the response still in flight.
    if (this.outstandingTools === 0 && this.responseEnded) {
      this.responseEnded = false;
      this.session.respond();
    }
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
    this.stopped = true;
    this.player.stop();
    this.session.close();
    this.setPhase("idle");
  }
}
