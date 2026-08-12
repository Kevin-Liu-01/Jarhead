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
   * How long after a reply a bare utterance still counts as a follow-up.
   *
   * Zero means every turn needs the wake phrase, which is the default for the
   * reason recorded in @jarvis/live: with a window open, a podcast playing in
   * the room got answered twice.
   */
  readonly followUpMs?: number;
  readonly log?: (line: string) => void;
}

export interface TurnTiming {
  readonly transcript: string;
  /** Endpoint to first audible syllable — what Kevin experiences. */
  readonly toSpeechMs: number | undefined;
  readonly interrupted: boolean;
}

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
      this.setPhase("listening");
    });
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

    const match = detect(transcript);
    if (match.woke) {
      this.awakeUntil = Date.now() + (this.opts.followUpMs ?? 0);
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
      this.awakeUntil = Date.now() + (this.opts.followUpMs ?? 0);
      this.setPhase("thinking");
      this.session.respond();
      return;
    }

    this.log(`ignored: "${transcript.slice(0, 48)}"`);
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
