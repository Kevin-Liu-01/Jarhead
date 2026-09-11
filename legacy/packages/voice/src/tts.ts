import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

/**
 * Streaming text to speech.
 *
 * Two things make this fast, and both are deliberate:
 *
 * 1. Sentences are synthesized as soon as the model finishes them, not when
 *    the whole answer is done. Fetch for sentence N+1 starts while N is still
 *    playing, so only the first sentence is ever on the critical path.
 * 2. Audio bytes are piped into ffplay as they arrive rather than written to a
 *    file and handed to afplay. The Clicky teardown found buffering the whole
 *    mp3 to be its single biggest latency mistake; this avoids it.
 */

export interface TtsOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId: string;
  /** Lower sample rates return first bytes sooner. 22050/32 is the free-tier-safe default. */
  readonly outputFormat: string;
  /** ElevenLabs `optimize_streaming_latency`, 0–4. Higher is faster and slightly flatter. */
  readonly latencyTier: number;
}

/**
 * Open a TLS connection to ElevenLabs before it is needed.
 *
 * Node's fetch pools connections per origin, so paying for the handshake
 * during startup means the first real synthesis request skips it. Measured
 * worth several hundred ms on a cold process.
 */
export async function prewarm(apiKey: string): Promise<number> {
  const startedAt = Date.now();
  try {
    await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // A failed warmup is not an error; the real request will just be slower.
  }
  return Date.now() - startedAt;
}

export interface SpokenSentence {
  readonly text: string;
  /** ms from request start to first audio byte received. */
  readonly ttfbMs: number;
  readonly bytes: number;
}

interface QueueEntry {
  readonly text: string;
  readonly requestedAt: number;
  readonly response: Promise<Response>;
}

export class Speaker {
  private queue: QueueEntry[] = [];
  private draining = false;
  private stopped = false;
  private current: ChildProcess | undefined;
  private drainPromise: Promise<void> = Promise.resolve();

  readonly spoken: SpokenSentence[] = [];
  /** ms from Speaker construction to the first audio byte of the first sentence. */
  firstAudioMs: number | undefined;
  /**
   * Absolute epoch ms of the first audio byte. The caller measures from mic-open,
   * which happened before this Speaker existed, so a relative number is not enough.
   */
  firstAudioAt: number | undefined;

  private readonly createdAt = Date.now();

  constructor(private readonly opts: TtsOptions) {}

  /**
   * Enqueue a sentence. Returns immediately; the network request starts now so
   * generation overlaps whatever is currently playing.
   */
  say(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.stopped) return;

    const requestedAt = Date.now();
    const response = fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.opts.voiceId}/stream` +
        `?output_format=${this.opts.outputFormat}` +
        // Trades a little prosody quality for first-byte time. The whole point
        // of this path is that Kevin hears something fast.
        `&optimize_streaming_latency=${this.opts.latencyTier}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.opts.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: this.opts.modelId,
          voice_settings: { stability: 0.4, similarity_boost: 0.75, speed: 1.05 },
        }),
      },
    );

    this.queue.push({ text: trimmed, requestedAt, response });
    this.kick();
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainPromise = this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const entry = this.queue.shift();
      if (!entry) break;
      try {
        await this.play(entry);
      } catch (e) {
        if (!this.stopped) console.error(`  tts error: ${(e as Error).message}`);
      }
    }
  }

  private async play(entry: QueueEntry): Promise<void> {
    // Spawn the player BEFORE awaiting the response, so process startup
    // overlaps the network wait instead of stacking on top of it.
    const ff = spawn(
      "ffplay",
      ["-nodisp", "-autoexit", "-loglevel", "quiet", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    this.current = ff;
    // ffplay dies if the producer errors before writing; don't crash the process.
    ff.stdin.on("error", () => undefined);

    let res: Response;
    try {
      res = await entry.response;
    } catch (e) {
      ff.kill("SIGKILL");
      this.current = undefined;
      throw e;
    }

    if (!res.ok || !res.body) {
      ff.kill("SIGKILL");
      this.current = undefined;
      throw new Error(
        res.ok ? "elevenlabs returned no body" : `elevenlabs ${res.status}: ${(await res.text()).slice(0, 160)}`,
      );
    }

    let ttfbMs = 0;
    let bytes = 0;
    let first = true;

    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

    await new Promise<void>((resolve, reject) => {
      const finish = (): void => resolve();
      ff.on("close", finish);
      ff.on("error", reject);

      source.on("data", (chunk: Buffer) => {
        if (first) {
          first = false;
          ttfbMs = Date.now() - entry.requestedAt;
          this.firstAudioMs ??= Date.now() - this.createdAt;
          this.firstAudioAt ??= Date.now();
        }
        bytes += chunk.length;
        if (!ff.stdin.destroyed) ff.stdin.write(chunk);
      });
      source.on("end", () => {
        if (!ff.stdin.destroyed) ff.stdin.end();
      });
      source.on("error", (e) => {
        if (!ff.stdin.destroyed) ff.stdin.end();
        reject(e);
      });
    });

    this.current = undefined;
    this.spoken.push({ text: entry.text, ttfbMs, bytes });
  }

  /** Barge-in. Kills playback and drops anything still queued. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.current?.kill("SIGKILL");
    this.current = undefined;
  }

  /** Resolves once everything enqueued so far has finished playing. */
  async idle(): Promise<void> {
    // The queue can grow while draining, so loop until it's genuinely empty.
    while (this.queue.length > 0 || this.draining) {
      await this.drainPromise;
    }
  }

  get charactersSpoken(): number {
    return this.spoken.reduce((n, s) => n + s.text.length, 0);
  }
}

/**
 * Splits a token stream into speakable sentences.
 *
 * Speaking on sentence boundaries rather than the full answer is what lets
 * audio start while the model is still generating. Abbreviations are the
 * failure mode — "e.g." must not trigger a flush mid-clause.
 */
export class SentenceSplitter {
  private buffer = "";
  private flushed = 0;

  private static readonly ABBREVIATIONS = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|no|fig)\.$/i;

  /**
   * `eagerFirst` lets the FIRST chunk break at a clause boundary (comma, dash)
   * instead of waiting for a full stop.
   *
   * This matters more than it looks. A 168-character opening sentence took
   * 639ms to generate after first token — all of it dead air, because TTS
   * cannot start until the chunk is complete. Breaking the first chunk at a
   * clause cuts straight into the number Kevin actually perceives. Later
   * chunks are generated while earlier audio plays, so they can stay whole
   * sentences and keep their prosody.
   */
  constructor(private readonly eagerFirst = true) {}

  /** Feed a token. Returns any chunks that are now speakable. */
  push(token: string): string[] {
    this.buffer += token;
    const out: string[] = [];

    for (;;) {
      const eager = this.eagerFirst && this.flushed === 0;
      const pattern = eager
        ? /[.!?](?=\s)|[\n]{2,}|[:;](?=\s)|,(?=\s)|\s—\s/
        : /[.!?](?=\s)|[\n]{2,}|[:;](?=\s)/;

      const match = pattern.exec(this.buffer);
      if (!match) break;

      const end = match.index + match[0].length;
      const candidate = this.buffer.slice(0, end);

      if (SentenceSplitter.ABBREVIATIONS.test(candidate.trimEnd())) break;

      // Too short and it sounds clipped; for the eager first chunk we accept
      // less, because a slightly abrupt opener beats a second of silence.
      const floor = eager ? 24 : 12;
      if (candidate.trim().length < floor) break;

      out.push(candidate.trim());
      this.buffer = this.buffer.slice(end);
      this.flushed++;
    }

    return out;
  }

  /** Whatever is left when the stream ends. */
  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) this.flushed++;
    return rest.length > 0 ? rest : undefined;
  }
}
