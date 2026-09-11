import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySilence, INITIAL_ENDPOINT, parseSilence, type EndpointState } from "./vad.ts";

/**
 * Always-on listening: a continuous ffmpeg capture that emits one file per
 * utterance instead of one file per session.
 *
 * `recordUntilSilence` in @jarvis/voice spawns a fresh ffmpeg for every turn,
 * which costs process startup on the critical path and cannot hear a wake word
 * because nothing is listening between turns. This keeps one process alive and
 * uses ffmpeg's own segmenter, so an utterance is already on disk by the time
 * the endpointer decides it ended.
 */

export interface ListenOptions {
  readonly device: number;
  readonly silenceSeconds: number;
  readonly thresholdDb: number;
  /** Rotate the capture file every N seconds so no single file grows unbounded. */
  readonly segmentSeconds: number;
  /** Abort if no audio flows within this long — a missing mic grant hangs forever. */
  readonly startupTimeoutMs: number;
}

export const DEFAULT_LISTEN: ListenOptions = {
  device: 1,
  silenceSeconds: 1.0,
  thresholdDb: -34,
  segmentSeconds: 30,
  startupTimeoutMs: 4000,
};

export interface UtteranceEvent {
  /** Path to the segment file containing this utterance. */
  readonly path: string;
  /** Seconds into the stream when speech ended. */
  readonly endedAt: number;
}

export class MicUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Microphone unavailable. System Settings → Privacy & Security → Microphone, ` +
        `enable your terminal, then restart. (${detail})`,
    );
    this.name = "MicUnavailableError";
  }
}

export interface Listener extends EventEmitter {
  on(event: "utterance", listener: (u: UtteranceEvent) => void): this;
  on(event: "speech-start", listener: () => void): this;
  on(event: "error", listener: (e: Error) => void): this;
}

/**
 * Start listening. Emits `utterance` each time a stretch of speech ends.
 *
 * The caller decides what to do with each utterance — typically transcribe it
 * and check for the wake word. Nothing here touches the network.
 */
export function startListening(opts: ListenOptions = DEFAULT_LISTEN): {
  listener: Listener;
  stop: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-listen-"));
  const pattern = join(dir, "seg-%03d.wav");
  const emitter = new EventEmitter() as Listener;

  const ff: ChildProcess = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "info",
    "-f", "avfoundation",
    "-i", `:${opts.device}`,
    "-ac", "1",
    "-ar", "16000",
    "-af", `silencedetect=noise=${opts.thresholdDb}dB:d=${opts.silenceSeconds}`,
    "-f", "segment",
    "-segment_time", String(opts.segmentSeconds),
    "-reset_timestamps", "1",
    pattern,
  ]);

  let state: EndpointState = INITIAL_ENDPOINT;
  let segment = 0;
  let sawAudio = false;
  let stopped = false;

  const guard = setTimeout(() => {
    if (sawAudio || stopped) return;
    stopped = true;
    ff.kill("SIGKILL");
    emitter.emit("error", new MicUnavailableError(`no audio after ${opts.startupTimeoutMs}ms`));
  }, opts.startupTimeoutMs);

  ff.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();

    if (!sawAudio && /size=\s*\d+/.test(text)) {
      sawAudio = true;
      clearTimeout(guard);
    }

    // ffmpeg logs each new segment file as it opens it.
    const opened = /Opening '([^']+seg-\d+\.wav)' for writing/.exec(text);
    if (opened?.[1]) segment = Number(/seg-(\d+)\.wav/.exec(opened[1])?.[1] ?? segment);

    for (const event of parseSilence(text)) {
      const before = state;
      state = applySilence(state, event);

      if (!before.heardSpeech && state.heardSpeech) emitter.emit("speech-start");

      if (state.shouldCut && !before.shouldCut) {
        emitter.emit("utterance", {
          path: join(dir, `seg-${String(segment).padStart(3, "0")}.wav`),
          endedAt: event.at,
        });
        // Reset for the next utterance within the same stream.
        state = { heardSpeech: false, silenceSince: undefined, shouldCut: false };
      }
    }
  });

  ff.on("error", (e) => {
    clearTimeout(guard);
    emitter.emit("error", new Error(`ffmpeg failed to spawn: ${e.message}`));
  });

  ff.on("close", () => {
    clearTimeout(guard);
    if (!stopped && !sawAudio) {
      emitter.emit("error", new MicUnavailableError("ffmpeg exited before producing audio"));
    }
  });

  return {
    listener: emitter,
    stop: () => {
      stopped = true;
      clearTimeout(guard);
      ff.kill("SIGINT");
    },
  };
}
