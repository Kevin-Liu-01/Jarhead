import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";

/**
 * One complete line of a file and the byte offset it starts at. A line longer than
 * `MAX_LINE_BYTES` is never assembled: it comes back with `text: ""`, `skippedBytes`
 * (its length) and `head` (its first `LINE_HEAD_BYTES`), so a parser can still tell a
 * tool output from anything else and say what was left out.
 */
export interface Line {
  readonly text: string;
  readonly offset: number;
  readonly skippedBytes?: number;
  readonly head?: Buffer;
}

const NEWLINE = 0x0a;
/** Bytes per read() call, here and in the page reader (transcript.ts re-exports it). */
export const READ_CHUNK_BYTES = 16 * 1024 * 1024;
/**
 * Longest line assembled and parsed. Kevin's 164 GB rollout carries single lines of 48
 * MB (base64 screenshots in tool outputs); concatenating and JSON.parsing one took 4.7 s
 * on the loop that runs the voice. Past this a line is skipped, head kept.
 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** How much of a skipped line is kept: enough for its type, ids and timestamp, which sit at the front. */
export const LINE_HEAD_BYTES = 4 * 1024;

/**
 * Split a buffer that starts at byte `base` into complete lines with absolute offsets.
 * A trailing fragment with no newline comes back apart, with its offset, so a reader
 * can leave it for later rather than parse half a line. A complete line over
 * `maxLineBytes` is returned skipped (see `Line`).
 */
export function splitLines(buf: Buffer, base: number, maxLineBytes = MAX_LINE_BYTES): { lines: Line[]; rest: { offset: number; bytes: Buffer } | undefined } {
  const lines: Line[] = [];
  let start = 0;
  for (let i = buf.indexOf(NEWLINE, 0); i !== -1; i = buf.indexOf(NEWLINE, start)) {
    if (i > start) {
      if (i - start > maxLineBytes) lines.push(skippedLine(base + start, i - start, buf.subarray(start, start + LINE_HEAD_BYTES)));
      else {
        const text = buf.subarray(start, i).toString("utf8");
        if (text !== "\r") lines.push({ text: text.endsWith("\r") ? text.slice(0, -1) : text, offset: base + start });
      }
    }
    start = i + 1;
  }
  const rest = start < buf.length ? { offset: base + start, bytes: buf.subarray(start) } : undefined;
  return { lines, rest };
}

function skippedLine(offset: number, skippedBytes: number, head: Buffer): Line {
  return { text: "", offset, skippedBytes, head: Buffer.from(head) };
}

/**
 * Lines out of chunks that arrive in order: carries a torn line across chunks, and
 * once the carried fragment passes `maxLineBytes` stops carrying and skips to the next
 * newline — so a 48 MB line costs one 4 KB head, never a 48 MB concat. Shared by the
 * page reader and the live tail so both bound the same way.
 */
export class LineAssembler {
  private carry: Buffer | undefined;
  private carryOffset = 0;
  private skip: { readonly offset: number; readonly head: Buffer; bytes: number } | undefined;

  constructor(private readonly maxLineBytes = MAX_LINE_BYTES) {}

  /** Where the unfinished line (torn or being skipped) starts; undefined when the last chunk ended on a newline. */
  get pendingOffset(): number | undefined {
    if (this.skip) return this.skip.offset;
    return this.carry ? this.carryOffset : undefined;
  }

  /** The complete lines in `buf` (which starts at byte `base`), with the fragment carried from before. */
  push(buf: Buffer, base: number): Line[] {
    let out: Line[] = [];
    if (this.skip) {
      const nl = buf.indexOf(NEWLINE);
      if (nl === -1) {
        this.skip.bytes += buf.length;
        return out;
      }
      out.push(skippedLine(this.skip.offset, this.skip.bytes + nl, this.skip.head));
      this.skip = undefined;
      buf = buf.subarray(nl + 1);
      base += nl + 1;
      if (buf.length === 0) return out;
    }
    const joined = this.carry ? Buffer.concat([this.carry, buf]) : buf;
    const joinedBase = this.carry ? this.carryOffset : base;
    const { lines, rest } = splitLines(joined, joinedBase, this.maxLineBytes);
    out = out.length ? out.concat(lines) : lines;
    if (!rest) {
      this.carry = undefined;
      return out;
    }
    if (rest.bytes.length > this.maxLineBytes) {
      // Too long already and still no newline: keep the head, forget the rest.
      this.skip = { offset: rest.offset, head: Buffer.from(rest.bytes.subarray(0, LINE_HEAD_BYTES)), bytes: rest.bytes.length };
      this.carry = undefined;
    } else {
      // A copy, so the chunk it points into can go.
      this.carry = Buffer.from(rest.bytes);
      this.carryOffset = rest.offset;
    }
    return out;
  }
}

export type TailEnd = "gone" | "replaced" | "truncated";

export interface FileTailOptions {
  readonly path: string;
  /** Byte to start from: the end of what was already read. */
  readonly offset: number;
  /** Complete lines appended since the last call, coalesced into bursts. */
  readonly onLines: (lines: Line[]) => void;
  readonly onError?: (e: Error) => void;
  /**
   * Called once when the tail stops on its own: the file it had seen is `gone` for
   * `goneAfterMs` (deleted, or moved — Codex archives by moving the rollout), another
   * file took its place (`replaced`: the inode changed), or it was `truncated` below
   * what was read. The tail is closed by then; nothing more arrives.
   */
  readonly onEnd?: (reason: TailEnd) => void;
  /** Stat interval when fs.watch is unavailable (and a safety net beside it). Default 1 s. */
  readonly pollMs?: number;
  /** Quiet time before a burst of lines is delivered. Default 50 ms. */
  readonly coalesceMs?: number;
  /** Bytes per read() call (tests). Default `READ_CHUNK_BYTES`. */
  readonly chunkBytes?: number;
  /** How long a file that was there may be missing before the tail ends `gone`. Default 10 s. */
  readonly goneAfterMs?: number;
  readonly now?: () => number;
}

export const GONE_AFTER_MS = 10_000;

/**
 * Follow a growing file. fs.watch says when it changes; a stat poll stands in when
 * watching is not possible (the file is not there yet, or the platform refuses) and
 * runs slowly beside the watcher regardless, because kqueue has missed appends before.
 * Only the bytes appended since the last read are read, a torn last line waits for its
 * end, and lines are handed over in bursts so a message written as several lines
 * arrives whole.
 *
 * A tail also ends. Before, ENOENT was swallowed and the poll went on for ever, so a
 * Console pane kept its "live" dot on a file Codex had moved to archived_sessions hours
 * earlier. Now a file that was seen and is missing for `goneAfterMs` ends the tail with
 * `gone`; a new inode at the path ends it `replaced`; a shrink ends it `truncated`. A
 * file that has not appeared yet (a thread started seconds ago) is still waited for.
 */
export class FileTail {
  private offset: number;
  private readonly lines: LineAssembler;
  private watcher: FSWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private goneTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: Line[] = [];
  private reading = false;
  private again = false;
  private closed = false;
  private ended = false;
  /** Inode of the file once seen; a different one at the same path is another file. */
  private ino: bigint | number | undefined;
  private missingSince: number | undefined;
  /** Read buffer kept only while catching up a backlog; a fresh 16 MB per look would pile up on the heap. */
  private scratch: Buffer | undefined;
  private readonly pollMs: number;
  private readonly coalesceMs: number;
  private readonly goneAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: FileTailOptions) {
    this.offset = opts.offset;
    this.lines = new LineAssembler();
    this.pollMs = opts.pollMs ?? 1_000;
    this.coalesceMs = opts.coalesceMs ?? 50;
    this.goneAfterMs = opts.goneAfterMs ?? GONE_AFTER_MS;
    this.now = opts.now ?? Date.now;
    this.startWatching();
    // Lines written between the caller's read and the watcher's start are caught by this first look.
    void this.check();
  }

  /** Where the next read starts: everything before it has been handed over or is being carried. */
  get position(): number {
    return this.offset;
  }

  /** Where parsing stopped: the start of a torn (or skipped) last line, else `position`. */
  get endOffset(): number {
    return this.lines.pendingOffset ?? this.offset;
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
      if (err.code !== "ENOENT") {
        this.opts.onError?.(err);
        return;
      }
      this.missing();
    } finally {
      this.reading = false;
    }
  }

  /** The path is not there. Never seen: keep waiting for it. Seen before: it is on its way to `gone`. */
  private missing(): void {
    if (this.ino === undefined) {
      // A watcher on a missing path would have thrown at start; poll for its arrival.
      if (!this.watcher && !this.pollTimer) this.poll(this.pollMs);
      return;
    }
    if (this.missingSince === undefined) {
      this.missingSince = this.now();
      // The old watcher follows the moved inode, not the path: drop it and look at the path often.
      this.watcher?.close();
      this.watcher = undefined;
      this.poll(this.pollMs);
      this.goneTimer = setTimeout(() => void this.check(), this.goneAfterMs + 5);
      this.goneTimer.unref?.();
      return;
    }
    if (this.now() - this.missingSince >= this.goneAfterMs) this.end("gone");
  }

  private async readNew(): Promise<void> {
    const st = await stat(this.opts.path);
    if (this.missingSince !== undefined) {
      // Back, under the same name. The same inode is the same file (a move and a move
      // back, or a slow rename); a different one is a replacement.
      this.missingSince = undefined;
      if (this.goneTimer) clearTimeout(this.goneTimer);
      this.goneTimer = undefined;
    }
    if (this.ino === undefined) this.ino = st.ino;
    else if (st.ino !== this.ino) {
      this.end("replaced");
      return;
    }
    if (!this.watcher && !this.closed) {
      // The file appeared (or came back) after we started: watch it from now on.
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
      this.end("truncated");
      return;
    }
    if (st.size === this.offset) return;
    // One chunk per look, never the whole growth at once: a file that grew by gigabytes
    // while nobody watched (or a read of 2^31 bytes, which aborts the process) is caught
    // up chunk by chunk, each handed over before the next is read.
    const chunkBytes = Math.max(1, this.opts.chunkBytes ?? READ_CHUNK_BYTES);
    const want = Math.min(chunkBytes, st.size - this.offset);
    if (!this.scratch || this.scratch.length < want) this.scratch = Buffer.allocUnsafe(want < chunkBytes && want < 64 * 1024 ? want : chunkBytes);
    const fh = await open(this.opts.path, "r");
    let buf: Buffer;
    try {
      const { bytesRead } = await fh.read(this.scratch, 0, want, this.offset);
      buf = this.scratch.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    if (buf.length === 0) return;
    const lines = this.lines.push(buf, this.offset);
    this.offset += buf.length;
    const more = this.offset < st.size;
    if (!more) this.scratch = undefined; // caught up: give the buffer back
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

  /** Deliver what is pending, close, and tell the owner once. */
  private end(reason: TailEnd): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.flush();
    this.close();
    this.opts.onEnd?.(reason);
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.goneTimer) clearTimeout(this.goneTimer);
    this.goneTimer = undefined;
    this.pending = [];
  }
}
