import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";

/** One complete line of a file and the byte offset it starts at. */
export interface Line {
  readonly text: string;
  readonly offset: number;
}

const NEWLINE = 0x0a;
/** Bytes per read() call, here and in the page reader (transcript.ts re-exports it). */
export const READ_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Split a buffer that starts at byte `base` into complete lines with absolute offsets.
 * A trailing fragment with no newline comes back apart, with its offset, so a reader
 * can leave it for later rather than parse half a line.
 */
export function splitLines(buf: Buffer, base: number): { lines: Line[]; rest: { offset: number; bytes: Buffer } | undefined } {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== NEWLINE) continue;
    if (i > start) {
      const text = buf.subarray(start, i).toString("utf8");
      if (text !== "\r") lines.push({ text: text.endsWith("\r") ? text.slice(0, -1) : text, offset: base + start });
    }
    start = i + 1;
  }
  const rest = start < buf.length ? { offset: base + start, bytes: buf.subarray(start) } : undefined;
  return { lines, rest };
}

export interface FileTailOptions {
  readonly path: string;
  /** Byte to start from: the end of what was already read. */
  readonly offset: number;
  /** Complete lines appended since the last call, coalesced into bursts. */
  readonly onLines: (lines: Line[]) => void;
  readonly onError?: (e: Error) => void;
  /** Stat interval when fs.watch is unavailable (and a safety net beside it). Default 1 s. */
  readonly pollMs?: number;
  /** Quiet time before a burst of lines is delivered. Default 50 ms. */
  readonly coalesceMs?: number;
  /** Bytes per read() call (tests). Default `READ_CHUNK_BYTES`. */
  readonly chunkBytes?: number;
}

/**
 * Follow a growing file. fs.watch says when it changes; a stat poll stands in when
 * watching is not possible (the file is not there yet, or the platform refuses) and
 * runs slowly beside the watcher regardless, because kqueue has missed appends before.
 * Only the bytes appended since the last read are read, a torn last line waits for its
 * end, and lines are handed over in bursts so a message written as several lines
 * arrives whole.
 */
export class FileTail {
  private offset: number;
  private rest: Buffer | undefined;
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Line[] = [];
  private reading = false;
  private again = false;
  private closed = false;
  private readonly pollMs: number;
  private readonly coalesceMs: number;

  constructor(private readonly opts: FileTailOptions) {
    this.offset = opts.offset;
    this.pollMs = opts.pollMs ?? 1_000;
    this.coalesceMs = opts.coalesceMs ?? 50;
    this.startWatching();
    // Lines written between the caller's read and the watcher's start are caught by this first look.
    void this.check();
  }

  private startWatching(): void {
    let watching = false;
    try {
      this.watcher = watch(this.opts.path, { persistent: false }, () => void this.check());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.poll(this.pollMs);
      });
      watching = true;
    } catch {
      this.watcher = undefined;
    }
    // Without a watcher poll at the asked rate; with one, a slower look catches what it misses.
    this.poll(watching ? this.pollMs * 3 : this.pollMs);
  }

  private poll(ms: number): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.check(), ms);
    this.pollTimer.unref?.();
  }

  private async check(): Promise<void> {
    if (this.closed) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        await this.readNew();
      } while (this.again && !this.closed);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") this.opts.onError?.(err);
      // The file is not there (yet): keep polling; a watcher on a missing path would have thrown at start.
      if (err.code === "ENOENT" && !this.watcher && !this.pollTimer) this.poll(this.pollMs);
    } finally {
      this.reading = false;
    }
  }

  private async readNew(): Promise<void> {
    const st = await stat(this.opts.path);
    if (!this.watcher && !this.closed) {
      // The file appeared after we started: watch it from now on.
      try {
        this.watcher = watch(this.opts.path, { persistent: false }, () => void this.check());
        this.watcher.on("error", () => {
          this.watcher?.close();
          this.watcher = undefined;
        });
        this.poll(this.pollMs * 3);
      } catch {
        this.watcher = undefined;
      }
    }
    if (st.size < this.offset) {
      // Rewritten shorter than what we read: nothing we saw is still there to continue from.
      this.offset = st.size;
      this.rest = undefined;
      return;
    }
    if (st.size === this.offset) return;
    // One chunk per look, never the whole growth at once: a file that grew by gigabytes
    // while nobody watched (or a read of 2^31 bytes, which aborts the process) is caught
    // up chunk by chunk, each handed over before the next is read.
    const want = Math.min(Math.max(1, this.opts.chunkBytes ?? READ_CHUNK_BYTES), st.size - this.offset);
    const fh = await open(this.opts.path, "r");
    let buf: Buffer;
    try {
      buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, this.offset);
      buf = bytesRead < want ? buf.subarray(0, bytesRead) : buf;
    } finally {
      await fh.close();
    }
    if (buf.length === 0) return;
    const base = this.offset - (this.rest?.length ?? 0);
    const joined = this.rest ? Buffer.concat([this.rest, buf]) : buf;
    const { lines, rest } = splitLines(joined, base);
    this.offset += buf.length;
    this.rest = rest ? Buffer.from(rest.bytes) : undefined;
    const more = this.offset < st.size;
    if (lines.length) {
      this.pending.push(...lines);
      // Mid catch-up, deliver now rather than pile up every line of the backlog.
      if (more) this.flush();
      else this.scheduleFlush();
    }
    if (more) this.again = true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.coalesceMs);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.closed) return;
    const lines = this.pending;
    this.pending = [];
    if (lines.length) this.opts.onLines(lines);
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = [];
  }
}
