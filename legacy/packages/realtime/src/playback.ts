import { spawn, type ChildProcess } from "node:child_process";

/**
 * Plays the model's PCM as it arrives.
 *
 * One long-lived ffplay per reply, fed incrementally, rather than a process per
 * chunk: the deltas arrive every few tens of milliseconds and process startup
 * would dominate. Raw PCM needs the format declared up front since there is no
 * container to describe it.
 *
 * `stop()` is barge-in. It has to kill the player rather than just stop feeding
 * it, because whatever is already buffered would otherwise keep talking over
 * Kevin — the server truncating its side does nothing about audio that has
 * already left it.
 */
export class PcmPlayer {
  private ff: ChildProcess | undefined;
  private startedAt = 0;
  private firstAudioAt: number | undefined;

  /**
   * Called when the last sample is actually audible-through, not when the model
   * stopped generating.
   *
   * These are seconds apart, and conflating them broke barge-in: the phase went
   * back to "listening" while Jarhead was still talking, so speech during
   * playback no longer counted as an interruption.
   */
  onDrained: (() => void) | undefined;

  constructor(private readonly sampleRate: number) {}

  get isPlaying(): boolean {
    return this.ff !== undefined;
  }

  /** ms from the first chunk written to now; undefined if nothing played. */
  get audibleAt(): number | undefined {
    return this.firstAudioAt;
  }

  write(pcm: Buffer): void {
    if (!this.ff) this.spawnPlayer();
    const stdin = this.ff?.stdin;
    if (stdin && !stdin.destroyed) {
      if (this.firstAudioAt === undefined) this.firstAudioAt = Date.now();
      stdin.write(pcm);
    }
  }

  private spawnPlayer(): void {
    this.startedAt = Date.now();
    this.ff = spawn(
      "ffplay",
      [
        "-nodisp", "-autoexit", "-loglevel", "quiet",
        "-f", "s16le", "-ar", String(this.sampleRate), "-ch_layout", "mono",
        // Without these ffplay buffers ahead before starting, which shows up as
        // a fixed delay on every single reply.
        "-probesize", "32", "-analyzeduration", "0",
        "-i", "pipe:0",
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    // A player that dies mid-reply must not take the process with it.
    this.ff.stdin?.on("error", () => undefined);
    this.ff.on("error", () => undefined);
    this.ff.on("close", () => {
      this.ff = undefined;
      this.firstAudioAt = undefined;
      this.onDrained?.();
    });
  }

  /**
   * Stop feeding and let the buffer drain.
   *
   * The handle is deliberately NOT cleared here: the process is still playing,
   * and forgetting it would make isPlaying lie and leave nothing to kill on a
   * barge-in. The close handler clears it once the audio is genuinely done.
   */
  end(): void {
    const stdin = this.ff?.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
  }

  /** Barge-in: cut it off now. */
  stop(): void {
    const ff = this.ff;
    this.ff = undefined;
    this.firstAudioAt = undefined;
    ff?.kill("SIGKILL");
  }

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }
}
