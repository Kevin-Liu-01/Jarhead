import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { SAMPLE_RATE } from "./transcribe.ts";

/**
 * One continuous microphone stream, raw PCM to stdout.
 *
 * Deliberately different from `recordUntilSilence`: that spawns a fresh ffmpeg
 * per turn, which means process startup on the critical path and a mic that is
 * deaf between turns — so barge-in is impossible by construction. This process
 * stays up for the whole conversation and nothing owns the endpointing except
 * the server VAD.
 *
 * PCM straight to stdout rather than a file, because a file means a filesystem
 * round trip per chunk for audio that is only ever going to a socket.
 */

export interface MicStreamOptions {
  /**
   * avfoundation device spec, WITHOUT the leading colon.
   *
   * "default" rather than an index on purpose. Indices are positional and shift
   * whenever an audio device appears or disappears — when Kevin's AirPods
   * disconnected, the built-in microphone moved from 1 to 0 and every capture
   * started failing with a bare "Input/output error". "default" follows whatever
   * macOS considers the current input, which is what Kevin means anyway.
   */
  readonly device: string;
  /** A missing Microphone grant makes ffmpeg hang rather than fail. */
  readonly startupTimeoutMs: number;
}

export const DEFAULT_MIC_STREAM: MicStreamOptions = {
  device: process.env["JARVIS_MIC_DEVICE"] ?? "default",
  startupTimeoutMs: 4000,
};

export class MicUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Microphone unavailable: ${detail}. Check System Settings → Privacy & Security → ` +
        `Microphone, and that no other process is holding the device.`,
    );
    this.name = "MicUnavailableError";
  }
}

export interface MicStream extends EventEmitter {
  on(event: "data", listener: (pcm: Buffer) => void): this;
  on(event: "error", listener: (e: Error) => void): this;
}

export function openMicStream(opts: MicStreamOptions = DEFAULT_MIC_STREAM): {
  stream: MicStream;
  stop: () => void;
} {
  const emitter = new EventEmitter() as MicStream;

  const ff: ChildProcess = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "avfoundation",
    "-i", `:${opts.device}`,
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-acodec", "pcm_s16le",
    "-f", "s16le",
    "pipe:1",
  ]);

  let flowing = false;
  let stopped = false;

  const guard = setTimeout(() => {
    if (flowing || stopped) return;
    stopped = true;
    ff.kill("SIGKILL");
    emitter.emit("error", new MicUnavailableError(`no audio within ${opts.startupTimeoutMs}ms`));
  }, opts.startupTimeoutMs);

  ff.stdout?.on("data", (chunk: Buffer) => {
    if (!flowing) {
      flowing = true;
      clearTimeout(guard);
    }
    emitter.emit("data", chunk);
  });

  ff.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/Operation not permitted|Input\/output error/i.test(text)) {
      emitter.emit("error", new MicUnavailableError(text.trim().slice(0, 120)));
    }
  });

  ff.on("error", (e) => {
    clearTimeout(guard);
    emitter.emit("error", new Error(`ffmpeg failed to spawn: ${e.message}`));
  });

  ff.on("close", () => {
    clearTimeout(guard);
    if (!stopped && !flowing) emitter.emit("error", new MicUnavailableError("ffmpeg exited without producing audio"));
  });

  return {
    stream: emitter,
    stop: () => {
      stopped = true;
      clearTimeout(guard);
      ff.kill("SIGINT");
    },
  };
}
