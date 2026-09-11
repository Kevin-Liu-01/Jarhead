import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import type { AgentMessage, AgentRole, AgentToolCall } from "@jarhead/protocol";
import type { TranscriptDelta, TranscriptOptions, TranscriptPage } from "../types.ts";
import { isRecord, str } from "./store.ts";
import { FileTail, READ_CHUNK_BYTES, splitLines, type Line } from "./tail.ts";

/**
 * Conversations out of session files, for both Claude Code JSONL and Codex rollouts.
 *
 * A `TranscriptParser` turns lines into `AgentMessage`s: one per human turn, one per
 * assistant reply (its text blocks merged), one per reasoning block, one per tool call
 * whose output is patched in when the matching result line arrives. Messages keep the
 * tool's own ids (message id, tool_use id, call_id) so a page read from the tail and a
 * page read from the whole file agree on what is what; a line with no id of its own is
 * named for its byte offset, which is the same however the file was read.
 *
 * Reading is bounded like the stores: every page comes from the end of the file, read
 * in growing slices until it holds what was asked for — the newest `limit` messages, or
 * the `limit` before a given id; nothing reads a file whole. `TranscriptSource` remembers
 * where a read ended so the live tail that follows starts exactly there, with the parser
 * that knows the open tool calls.
 */

export const DEFAULT_PAGE = 60;
export const MAX_TOOL_CHARS = 4_000;
/** First slice read from the end of the file; doubled until the page is full. */
const FIRST_TAIL_BYTES = 256 * 1024;

/** Cut to `max` chars with a note of what was left out. */
export function clip(text: string, max = MAX_TOOL_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

/**
 * A tool's input as one readable string: a shell command as itself (its description
 * as a comment), an argv list joined, anything else pretty-printed JSON.
 */
export function prettyInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") {
    const t = input.trim();
    return t ? clip(t) : undefined;
  }
  if (isRecord(input)) {
    const command = input["command"] ?? input["cmd"];
    if (typeof command === "string") {
      const description = str(input["description"]);
      return clip(description ? `${command}\n# ${description}` : command);
    }
    if (Array.isArray(command) && command.every((c) => typeof c === "string")) return clip(command.join(" "));
    if (Object.keys(input).length === 0) return undefined;
  }
  try {
    return clip(JSON.stringify(input, null, 2));
  } catch {
    return clip(String(input));
  }
}

/**
 * A tool result's body as text: strings as they are, content blocks joined (an image
 * block reads "[image]"), anything else as JSON.
 */
export function outputText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (typeof block === "string") parts.push(block);
      else if (isRecord(block)) {
        const t = block["type"];
        if ((t === "text" || t === "input_text" || t === "output_text") && typeof block["text"] === "string") parts.push(block["text"]);
        else if (t === "image") parts.push("[image]");
        else parts.push(JSON.stringify(block));
      }
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Whether a message shows in a page: "turn" always; "event" (Codex's 0.145–0.147 echo) only in files with nothing else. */
export type DraftKind = "turn" | "event";

/** A message under construction; the parser mutates it, callers get frozen copies. */
export interface Draft {
  readonly id: string;
  readonly role: AgentRole;
  text: string;
  at: number;
  tool: { name: string; input: string | undefined; output: string | undefined; status: AgentToolCall["status"] } | undefined;
  readonly thinking: boolean;
  readonly kind: DraftKind;
}

export interface NewDraft {
  readonly id: string;
  readonly role: AgentRole;
  readonly text?: string;
  readonly at: number;
  readonly tool?: Draft["tool"];
  readonly thinking?: boolean;
  readonly kind?: DraftKind;
}

/**
 * Lines in, messages out. Subclasses know one file format; this keeps the messages in
 * order of first appearance, indexed by id, and remembers which changed since the last
 * `take()` so a live tail emits only what moved.
 */
export abstract class TranscriptParser {
  protected readonly drafts: Draft[] = [];
  protected readonly byId = new Map<string, Draft>();
  /** Tool calls by the id their result will carry (Claude's tool_use id, Codex's call_id). */
  protected readonly calls = new Map<string, Draft>();
  private readonly dirty = new Set<Draft>();
  /** Timestamp of the last line that carried one; lines without inherit it. */
  protected lastAt = 0;

  abstract push(line: Line): void;

  /** Does this draft belong in a page right now? Codex hides event echoes once real turns exist. */
  protected visible(_draft: Draft): boolean {
    return true;
  }

  /** Every visible message so far, in order. */
  all(): AgentMessage[] {
    return this.drafts.filter((d) => this.visible(d)).map(freeze);
  }

  /** Messages created or changed since the last take, in order; clears the mark. */
  take(): AgentMessage[] {
    if (this.dirty.size === 0) return [];
    const out = this.drafts.filter((d) => this.dirty.has(d) && this.visible(d)).map(freeze);
    this.dirty.clear();
    return out;
  }

  /** Visible messages so far. */
  get count(): number {
    let n = 0;
    for (const d of this.drafts) if (this.visible(d)) n += 1;
    return n;
  }

  protected add(n: NewDraft): Draft {
    const existing = this.byId.get(n.id);
    if (existing) return existing;
    const draft: Draft = { id: n.id, role: n.role, text: n.text ?? "", at: n.at, tool: n.tool, thinking: n.thinking ?? false, kind: n.kind ?? "turn" };
    this.drafts.push(draft);
    this.byId.set(n.id, draft);
    this.dirty.add(draft);
    return draft;
  }

  /** Append text to the message with this id, creating it on first sight. */
  protected mergeText(n: NewDraft & { readonly text: string }): void {
    const text = n.text.trim();
    if (!text) return;
    const existing = this.byId.get(n.id);
    if (!existing) {
      this.add({ ...n, text });
      return;
    }
    existing.text = existing.text ? `${existing.text}\n${text}` : text;
    this.dirty.add(existing);
  }

  /** A tool call; `callId` is what its result will name. */
  protected addCall(n: NewDraft, callId: string | undefined): void {
    const draft = this.add({ ...n, role: "tool" });
    if (callId) this.calls.set(callId, draft);
  }

  /** A tool result for an earlier call; results whose call is out of view (before the page) are dropped. */
  protected result(callId: string | undefined, output: string | undefined, error: boolean): void {
    if (!callId) return;
    const draft = this.calls.get(callId);
    if (!draft?.tool) return;
    draft.tool.output = output === undefined ? undefined : clip(output);
    draft.tool.status = error ? "error" : "done";
    this.dirty.add(draft);
  }

  protected timestamp(v: unknown): number {
    const ts = parseIso(v);
    if (ts !== undefined) this.lastAt = ts;
    return this.lastAt;
  }
}

function parseIso(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function freeze(d: Draft): AgentMessage {
  return {
    id: d.id,
    role: d.role,
    text: d.text,
    at: d.at,
    ...(d.tool ? { tool: { name: d.tool.name, ...(d.tool.input !== undefined ? { input: d.tool.input } : {}), ...(d.tool.output !== undefined ? { output: d.tool.output } : {}), status: d.tool.status } } : {}),
    ...(d.thinking ? { thinking: true } : {}),
  };
}

// ---------------------------------------------------------------- reading ---

export interface PageRead {
  readonly messages: AgentMessage[];
  /** The first message of the file is included. */
  readonly complete: boolean;
  /** Exact count of messages in the file, known only when the read reached its start. */
  readonly total: number | undefined;
  /** Where parsing stopped: the file size, or the start of a torn last line still being written. */
  readonly endOffset: number;
  /** The parser after this read; a tail continues from it (and from `endOffset`). */
  readonly parser: TranscriptParser;
}

/**
 * What a page picker sees after each slice: the messages parsed so far (suspect first
 * one dropped), whether the slice began at byte 0, and whether it is the last slice that
 * will be tried (it began at byte 0, or it is `MAX_PAGE_BYTES` long) — a picker that is
 * still unsatisfied then returns what it has, or throws a plain Error.
 */
interface Slice {
  readonly all: AgentMessage[];
  readonly atStart: boolean;
  readonly last: boolean;
  readonly endOffset: number;
  readonly parser: TranscriptParser;
  /** Bytes of the file this slice covers. */
  readonly bytes: number;
}
type Pick = (slice: Slice) => PageRead | undefined;

/**
 * The most a page read goes back from the end of the file. Kevin has rollouts of 2 to
 * 164 GB (single lines of 48 MB); past this the page is whatever the slice holds and a
 * `before` that is further back is an Error the caller can show, not a daemon that reads
 * the file whole — or dies: fs.read() aborts the process on a length of 2^31 or more.
 */
export const MAX_PAGE_BYTES = 256 * 1024 * 1024;

/** Knobs for the page readers; production uses the defaults, tests shrink them. */
export interface ReadLimits {
  /** Furthest a page read goes back from the end of the file. Default `MAX_PAGE_BYTES`. */
  readonly maxBytes?: number;
  /** Bytes per read() call. Default `READ_CHUNK_BYTES` (16 MiB). */
  readonly chunkBytes?: number;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * Hand every complete line of `[from, to)` to `onLine`, reading `READ_CHUNK_BYTES` at a
 * time and carrying a torn line across chunks, so a slice costs one chunk of memory
 * however long it is. Returns where the torn last line starts (or `to`).
 */
export async function scanLines(fh: FileHandle, from: number, to: number, onLine: (line: Line) => void, chunkBytes = READ_CHUNK_BYTES): Promise<number> {
  let carry: Buffer | undefined;
  let pos = from;
  while (pos < to) {
    const want = Math.min(chunkBytes, to - pos);
    const chunk = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(chunk, 0, want, pos);
    if (bytesRead === 0) break; // truncated under us: whatever is left is not there
    const body = bytesRead < want ? chunk.subarray(0, bytesRead) : chunk;
    const base = pos - (carry?.length ?? 0);
    const { lines, rest } = splitLines(carry ? Buffer.concat([carry, body]) : body, base);
    for (const line of lines) onLine(line);
    // A copy, so the chunk it points into can go.
    carry = rest ? Buffer.from(rest.bytes) : undefined;
    pos += bytesRead;
  }
  return pos - (carry?.length ?? 0);
}

/**
 * Read the file from its end in growing slices until `pick` is satisfied. A slice that
 * starts inside the file may open in the middle of a message (an assistant reply split
 * over lines, a result whose call is earlier), so its first message is dropped as
 * suspect; the next, larger slice has it whole. Kevin's files run to hundreds of MB and
 * more, so nothing here reads a file whole: the cost is bounded by twice the distance
 * from the end to what was asked for, and never exceeds `MAX_PAGE_BYTES` back.
 */
async function readFromEnd(path: string, makeParser: () => TranscriptParser, pick: Pick, limits: ReadLimits = {}): Promise<PageRead> {
  const size = (await stat(path)).size;
  const fh = await open(path, "r");
  try {
    const cap = Math.min(size, Math.max(1, limits.maxBytes ?? MAX_PAGE_BYTES));
    let want = Math.min(cap, FIRST_TAIL_BYTES);
    for (;;) {
      const start = size - want;
      const last = want >= cap;
      // One byte before the slice says whether it begins a line; the slice itself cannot know.
      const from = start > 0 ? start - 1 : 0;
      const parser = makeParser();
      const endOffset = await scanLines(
        fh,
        from,
        size,
        (line) => {
          if (line.offset === from && start > 0) return; // torn by the cut (a line that begins at `start` starts at from + 1)
          parser.push(line);
        },
        limits.chunkBytes,
      );
      const all = start > 0 ? parser.all().slice(1) : parser.all();
      const page = pick({ all, atStart: start === 0, last, endOffset, parser, bytes: want });
      if (page) return page;
      if (last) throw new Error(start === 0 ? `no page in ${path}` : `no page in the last ${formatBytes(want)} of ${path}`);
      want = Math.min(cap, want * 2);
    }
  } finally {
    await fh.close();
  }
}

/** The newest `limit` messages; fewer when the last `MAX_PAGE_BYTES` of the file hold fewer (then `complete` is false). */
export function readTailPage(path: string, makeParser: () => TranscriptParser, limit: number, limits?: ReadLimits): Promise<PageRead> {
  return readFromEnd(
    path,
    makeParser,
    ({ all, atStart, last, endOffset, parser }) => {
      if (atStart) return { messages: all.slice(-limit), complete: all.length <= limit, total: all.length, endOffset, parser };
      if (all.length >= limit || last) return { messages: all.slice(-limit), complete: false, total: undefined, endOffset, parser };
      return undefined;
    },
    limits,
  );
}

/**
 * The `limit` messages just before message `before`; throws when no such message exists
 * (or none within the last `MAX_PAGE_BYTES` of the file, which the message says).
 */
export function readBeforePage(path: string, makeParser: () => TranscriptParser, limit: number, before: string, limits?: ReadLimits): Promise<PageRead> {
  return readFromEnd(
    path,
    makeParser,
    ({ all, atStart, last, endOffset, parser, bytes }) => {
      const idx = all.findIndex((m) => m.id === before);
      if (idx === -1) {
        if (atStart) throw new Error(`no message ${before} in ${path}`);
        if (last) throw new Error(`no message ${before} in the last ${formatBytes(bytes)} of ${path}`);
        return undefined;
      }
      if (atStart) {
        const from = Math.max(0, idx - limit);
        return { messages: all.slice(from, idx), complete: from === 0, total: all.length, endOffset, parser };
      }
      if (idx >= limit || last) {
        // At the bound with nothing before `before` in reach: say so, rather than an empty page the Console would ask for again.
        if (idx === 0) throw new Error(`nothing before ${before} within the last ${formatBytes(bytes)} of ${path}`);
        return { messages: all.slice(Math.max(0, idx - limit), idx), complete: false, total: undefined, endOffset, parser };
      }
      return undefined;
    },
    limits,
  );
}

/** Every message in the file, with the parser that holds them. Tests and small files; pages never read a file whole. */
export async function readWhole(path: string, makeParser: () => TranscriptParser): Promise<PageRead> {
  const buf = await readFile(path);
  const { lines, rest } = splitLines(buf, 0);
  const parser = makeParser();
  for (const line of lines) parser.push(line);
  const all = parser.all();
  return { messages: all, complete: true, total: all.length, endOffset: rest ? rest.offset : buf.length, parser };
}

/** One page: the newest `limit` messages, or the `limit` messages ending just before message `before`. */
export function readTranscriptPage(path: string, makeParser: () => TranscriptParser, opts: TranscriptOptions = {}, limits?: ReadLimits): Promise<PageRead> {
  const limit = Math.max(1, opts.limit ?? DEFAULT_PAGE);
  return opts.before === undefined ? readTailPage(path, makeParser, limit, limits) : readBeforePage(path, makeParser, limit, opts.before, limits);
}

// ----------------------------------------------------------------- source ---

export interface TranscriptSourceOptions {
  readonly path: string;
  readonly makeParser: () => TranscriptParser;
  /** The store's message count, for `total` when the whole file was not parsed. */
  readonly storeCount?: () => number;
  /** Tail knobs (tests). */
  readonly pollMs?: number;
  readonly coalesceMs?: number;
  /** Page-read bounds (tests). */
  readonly limits?: ReadLimits;
}

interface ReadState {
  readonly parser: TranscriptParser;
  readonly endOffset: number;
  readonly total: number;
}

/**
 * One session file's conversation: pages on demand and a live tail. The tail continues
 * from the last page read — same parser, same byte — so nothing between the page and the
 * first delta is missed or repeated, and a result for a call shown in the page finds it.
 */
export class TranscriptSource {
  private last: ReadState | undefined;
  private readonly tails = new Set<FileTail>();

  constructor(private readonly opts: TranscriptSourceOptions) {}

  get path(): string {
    return this.opts.path;
  }

  /** A page has been served from this source (the empty page of a file not written yet counts). */
  get served(): boolean {
    return this.last !== undefined;
  }

  async page(opts: TranscriptOptions = {}): Promise<TranscriptPage> {
    let read: PageRead;
    try {
      read = await readTranscriptPage(this.opts.path, this.opts.makeParser, opts, this.opts.limits);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // Not written yet (a thread started seconds ago): an empty, complete page; the tail waits for the file.
      this.last = { parser: this.opts.makeParser(), endOffset: 0, total: 0 };
      return { messages: [], total: 0, complete: true };
    }
    // Exact when the read reached the start of the file. Otherwise the store's estimate
    // (turns, not tool calls: often low for Codex), never less than a page that is not the
    // whole story plus one, nor less than what an earlier read of this file established.
    const total = read.total ?? Math.max(this.opts.storeCount?.() ?? 0, read.messages.length + (read.complete ? 0 : 1), this.last?.total ?? 0);
    this.last = { parser: read.parser, endOffset: read.endOffset, total };
    return { messages: read.messages, total, complete: read.complete };
  }

  /**
   * New messages as the file grows, until the returned function is called. Without a
   * page read first, a small tail is parsed silently to seed the open tool calls;
   * `fromStart` instead replays the whole file as deltas (a file that did not exist when
   * the empty page was shown).
   */
  follow(onDelta: (delta: TranscriptDelta) => void, opts: { readonly fromStart?: boolean } = {}): () => void {
    let tail: FileTail | undefined;
    let closed = false;
    void (async () => {
      let state = opts.fromStart ? { parser: this.opts.makeParser(), endOffset: 0, total: 0 } : this.last;
      if (!state) {
        try {
          const seed = await readTailPage(this.opts.path, this.opts.makeParser, 1, this.opts.limits);
          state = { parser: seed.parser, endOffset: seed.endOffset, total: Math.max(this.opts.storeCount?.() ?? 0, seed.total ?? 0) };
        } catch {
          state = { parser: this.opts.makeParser(), endOffset: 0, total: 0 };
        }
      }
      if (closed) return;
      const { parser } = state;
      parser.take(); // whatever the seed produced is already on screen (or never was asked for)
      let total = state.total;
      let known = parser.count;
      tail = new FileTail({
        path: this.opts.path,
        offset: state.endOffset,
        ...(this.opts.pollMs !== undefined ? { pollMs: this.opts.pollMs } : {}),
        ...(this.opts.coalesceMs !== undefined ? { coalesceMs: this.opts.coalesceMs } : {}),
        ...(this.opts.limits?.chunkBytes !== undefined ? { chunkBytes: this.opts.limits.chunkBytes } : {}),
        onLines: (lines) => {
          for (const line of lines) parser.push(line);
          const messages = parser.take();
          if (messages.length === 0) return;
          const now = parser.count;
          total += Math.max(0, now - known);
          known = now;
          onDelta({ messages, total });
        },
      });
      this.tails.add(tail);
    })();
    return () => {
      closed = true;
      if (tail) {
        tail.close();
        this.tails.delete(tail);
      }
    };
  }

  /** Stop every tail. */
  close(): void {
    for (const t of this.tails) t.close();
    this.tails.clear();
  }
}
