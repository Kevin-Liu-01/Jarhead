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

  constructor(private readonly sampleRate: number) {}

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
  }

  /** Let the current audio finish naturally. */
  end(): void {
    const stdin = this.ff?.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
    this.ff = undefined;
    this.firstAudioAt = undefined;
  }

  /** Barge-in: cut it off now. */
  stop(): void {
    this.ff?.kill("SIGKILL");
    this.ff = undefined;
    this.firstAudioAt = undefined;
  }

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }
}
