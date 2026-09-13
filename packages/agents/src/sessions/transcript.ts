import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import type { AgentMessage, AgentRole, AgentToolCall } from "@jarhead/protocol";
import type { TranscriptDelta, TranscriptOptions, TranscriptPage } from "../types.ts";
import type { TurnMark } from "./liveness.ts";
import { isRecord, str } from "./store.ts";
import { FileTail, LINE_HEAD_BYTES, LineAssembler, MAX_LINE_BYTES, READ_CHUNK_BYTES, type Line, type TailEnd } from "./tail.ts";

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
 * Reading is bounded like the stores: the newest page comes from the end of the file
 * in growing slices; every older page is read BACKWARD from the byte where the page
 * after it begins (`readBackward`), so "Load earlier" costs the span of the page, not
 * the distance from the end of the file — Kevin has rollouts of 2 to 164 GB and the old
 * re-read-from-the-end failed on them after five seconds. Nothing reads a file whole.
 * `TranscriptSource` remembers where each read ended so the live tail that follows
 * starts exactly there, with the parser that knows the open tool calls, and where each
 * message began so an older page can be asked for by id long after the app trimmed
 * its own copy.
 */

export const DEFAULT_PAGE = 60;
export const MAX_TOOL_CHARS = 4_000;
/** First slice read from the end of the file (or back from a cursor); doubled until the page is full. */
const FIRST_TAIL_BYTES = 256 * 1024;
/** Message ids whose byte offset a parser remembers: enough for the app's 400 kept messages several times over. */
export const OFFSETS_RETAINED = 8_192;
/** Results whose call this parser never saw, kept for the page that holds the call. */
export const ORPHANS_RETAINED = 256;
/** Results a source remembers across the older pages it served (a handful per page boundary), for the page before them. */
export const SOURCE_RESULTS_RETAINED = 1_024;
/** Drafts a parser that follows a file for hours keeps; older ones go (their offsets stay). */
export const RETAIN_DRAFTS = 4_096;
/** Cooperative parsing: hand the event loop back this often, so pongs and the voice keep their turn. */
export const YIELD_EVERY_LINES = 512;
export const YIELD_EVERY_MS = 20;

export { MAX_LINE_BYTES };

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
  /** Byte where the message's first line starts: where a page before it begins. */
  readonly offset: number;
}

export interface NewDraft {
  readonly id: string;
  readonly role: AgentRole;
  readonly text?: string;
  readonly at: number;
  readonly tool?: Draft["tool"];
  readonly thinking?: boolean;
  readonly kind?: DraftKind;
  readonly offset: number;
}

/** A result whose call this parser never saw: kept so the page that has the call can take it. */
export interface OrphanResult {
  readonly output: string | undefined;
  readonly error: boolean;
}

/** Anything that can answer "how did call X end?": a parser, or a source's memory of the pages it already served. */
export interface ResultLookup {
  resultFor(callId: string): OrphanResult | undefined;
}

export interface TranscriptParserOptions {
  /** Keep at most this many drafts (oldest go); default unbounded, for page reads. */
  readonly retain?: number;
}

const HEAD_TIMESTAMP = /"timestamp":"([^"]+)"/;

/**
 * Lines in, messages out. Subclasses know one file format; this keeps the messages in
 * order of first appearance, indexed by id, and remembers which changed since the last
 * `take()` so a live tail emits only what moved. It also remembers, past the drafts it
 * holds, where each message began (`offsetOf`, the last 8 192), the results whose call
 * it never saw (`orphans`, up to 256), and the last turn-bearing line (`lastTurn`).
 */
export abstract class TranscriptParser {
  protected readonly drafts: Draft[] = [];
  protected readonly byId = new Map<string, Draft>();
  /** Tool calls by the id their result will carry (Claude's tool_use id, Codex's call_id). */
  protected readonly calls = new Map<string, Draft>();
  private readonly dirty = new Set<Draft>();
  private readonly offsets = new Map<string, number>();
  private readonly orphanResults = new Map<string, OrphanResult>();
  private retainMax: number | undefined;
  private turn: TurnMark | undefined;
  private visibleAdded = 0;
  /** Timestamp of the last line that carried one; lines without inherit it. */
  protected lastAt = 0;

  constructor(opts: TranscriptParserOptions = {}) {
    this.retainMax = opts.retain;
  }

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

  /** Visible messages held right now (fewer than were added once `retain` trims). */
  get count(): number {
    let n = 0;
    for (const d of this.drafts) if (this.visible(d)) n += 1;
    return n;
  }

  /** Visible messages ever added by this parser; grows only, so a following tail can count. */
  get added(): number {
    return this.visibleAdded;
  }

  /** The last turn-bearing line seen (the lease in liveness.ts runs from it), if any. */
  get lastTurn(): TurnMark | undefined {
    return this.turn;
  }

  /** Byte where the message with this id begins, for the last `OFFSETS_RETAINED` ids seen. */
  offsetOf(id: string): number | undefined {
    return this.offsets.get(id);
  }

  /** Results seen for calls this parser never saw; a page holding the call takes them (`adoptResults`). */
  get orphans(): ReadonlyMap<string, OrphanResult> {
    return this.orphanResults;
  }

  /** Keep only the newest `retain` drafts from now on; offsets and orphans are unaffected. */
  bound(retain: number): void {
    this.retainMax = retain;
    this.trim();
  }

  /** What `from` knows about a call's result: an orphan, or a call of its own that finished. */
  resultFor(callId: string): OrphanResult | undefined {
    const orphan = this.orphanResults.get(callId);
    if (orphan) return orphan;
    const own = this.calls.get(callId)?.tool;
    if (own && (own.status === "done" || own.status === "error")) return { output: own.output, error: own.status === "error" };
    return undefined;
  }

  /**
   * What an older page may still need from this parser once it is thrown away: its
   * orphans, plus the results of calls it finished whose call is NOT among `shown`
   * (the slice's dropped suspect first message, the overflow past the page limit) — the
   * page before this one re-reads those calls and would otherwise show them running.
   * A handful per page in practice, so a source can keep hundreds of pages' worth.
   */
  spareResults(shown: ReadonlySet<string>): Map<string, OrphanResult> {
    const out = new Map<string, OrphanResult>(this.orphanResults);
    for (const [callId, d] of this.calls) {
      if (shown.has(d.id) || !d.tool || (d.tool.status !== "done" && d.tool.status !== "error")) continue;
      out.set(callId, { output: d.tool.output, error: d.tool.status === "error" });
    }
    return out;
  }

  /**
   * Patch this parser's running calls from results something else holds — a newer
   * page's parser, the live tail's, or the source's memory of pages already served —
   * so an older page never shows a call as running whose output landed in a range this
   * parser did not read. Returns how many were patched.
   */
  adoptResults(from: ResultLookup): number {
    let n = 0;
    for (const [callId, draft] of this.calls) {
      if (!draft.tool || draft.tool.status !== "running") continue;
      const r = from.resultFor(callId);
      if (!r) continue;
      draft.tool.output = r.output === undefined ? undefined : clip(r.output);
      draft.tool.status = r.error ? "error" : "done";
      this.dirty.add(draft);
      n += 1;
    }
    return n;
  }

  /** Every call still running is over: its session's process ended. Returns exactly the calls that flipped. */
  interruptOpenCalls(): AgentMessage[] {
    const flipped: AgentMessage[] = [];
    for (const draft of this.drafts) {
      if (draft.tool?.status !== "running") continue;
      draft.tool.status = "interrupted";
      this.dirty.delete(draft);
      flipped.push(freeze(draft));
    }
    return flipped;
  }

  protected add(n: NewDraft): Draft {
    const existing = this.byId.get(n.id);
    if (existing) return existing;
    const draft: Draft = { id: n.id, role: n.role, text: n.text ?? "", at: n.at, tool: n.tool, thinking: n.thinking ?? false, kind: n.kind ?? "turn", offset: n.offset };
    this.drafts.push(draft);
    this.byId.set(n.id, draft);
    this.dirty.add(draft);
    if (this.visible(draft)) this.visibleAdded += 1;
    this.offsets.set(n.id, n.offset);
    if (this.offsets.size > OFFSETS_RETAINED) this.offsets.delete(this.offsets.keys().next().value as string);
    this.trim();
    return draft;
  }

  private trim(): void {
    if (this.retainMax === undefined || this.drafts.length <= this.retainMax) return;
    const dropped = this.drafts.splice(0, this.drafts.length - this.retainMax);
    for (const d of dropped) {
      this.byId.delete(d.id);
      this.dirty.delete(d);
    }
    for (const [callId, d] of this.calls) if (this.byId.get(d.id) !== d) this.calls.delete(callId);
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

  /** A tool result for an earlier call; one whose call is out of view (before the page) is kept as an orphan. */
  protected result(callId: string | undefined, output: string | undefined, error: boolean): void {
    if (!callId) return;
    const draft = this.calls.get(callId);
    if (!draft?.tool) {
      this.orphanResults.set(callId, { output: output === undefined ? undefined : clip(output), error });
      if (this.orphanResults.size > ORPHANS_RETAINED) this.orphanResults.delete(this.orphanResults.keys().next().value as string);
      return;
    }
    draft.tool.output = output === undefined ? undefined : clip(output);
    draft.tool.status = error ? "error" : "done";
    this.dirty.add(draft);
  }

  /** A turn-bearing line: the lease runs from it. Noise lines (token counts, echoes) never call this. */
  protected mark(kind: TurnMark["kind"], at: number): void {
    this.turn = { kind, at };
  }

  /**
   * A line over `MAX_LINE_BYTES`, never assembled. Its head still says what it was: a
   * tool output (`callIdOf` reads the id) becomes the call's result — "[output of 48 MB
   * skipped]" rather than a call stuck running — and anything else one system row.
   */
  protected skipped(line: Line, callIdOf: (head: string) => string | undefined): void {
    const head = line.head ? line.head.toString("utf8", 0, Math.min(line.head.length, LINE_HEAD_BYTES)) : "";
    const at = this.timestamp(HEAD_TIMESTAMP.exec(head)?.[1]);
    const size = formatBytes(line.skippedBytes ?? 0);
    this.mark("open", at);
    const callId = callIdOf(head);
    if (callId) {
      this.result(callId, `[output of ${size} skipped]`, false);
      return;
    }
    this.add({ id: `L${line.offset}`, role: "system", text: `[one ${size} line skipped]`, at, offset: line.offset });
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
  /**
   * Exact count, known only when the read reached the start of the file: for a tail
   * page, every message in the file; for a backward page, every message before its
   * `endOffset` (the caller adds what it knows past that).
   */
  readonly total: number | undefined;
  /** Byte where the page's first message begins (`endOffset` when the page is empty); an older page is read back from here. */
  readonly startOffset: number;
  /** Where parsing stopped: the file size, the start of a torn last line still being written, or the cursor a backward read was asked for. */
  readonly endOffset: number;
  /** The parser after this read; a tail continues from it (and from `endOffset`). */
  readonly parser: TranscriptParser;
  /** Byte offset of any message in `messages` (they may come from several slices). */
  readonly offsetOf: (id: string) => number | undefined;
  /** Bytes of the file this read touched, slices summed: the cost of the page. */
  readonly bytesRead: number;
  /**
   * Results this read holds for calls that are not among `messages` — their calls sit in
   * an older range (a backward read spills every slice's, since its parsers are thrown
   * away). The page read before this one adopts them, so a call whose output landed
   * just past a page boundary is never shown running.
   */
  readonly orphans: ReadonlyMap<string, OrphanResult>;
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
  readonly start: number;
  readonly endOffset: number;
  readonly parser: TranscriptParser;
  /** Bytes of the file this slice covers. */
  readonly bytes: number;
  /** Bytes read so far, every slice counted. */
  readonly bytesRead: number;
}
type Pick<T> = (slice: Slice) => T | undefined;

/**
 * The most one page read goes back from its cursor. Kevin has rollouts of 2 to 164 GB
 * (single lines of 48 MB); past this the page is whatever the slice holds — never a
 * daemon that reads the file whole, or dies: fs.read() aborts the process on a length
 * of 2^31 or more. It bounds one page's reach from ITS cursor, never the distance from
 * the file's end, so "Load earlier" always moves.
 */
export const MAX_PAGE_BYTES = 256 * 1024 * 1024;

/** Knobs for the page readers; production uses the defaults, tests shrink them. */
export interface ReadLimits {
  /** Furthest a page read goes back from its cursor. Default `MAX_PAGE_BYTES`. */
  readonly maxBytes?: number;
  /** Bytes per read() call. Default `READ_CHUNK_BYTES` (16 MiB). */
  readonly chunkBytes?: number;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export interface ScanOptions {
  readonly chunkBytes?: number;
  /** Yield to the event loop after this many lines… */
  readonly yieldEvery?: number;
  /** …or this many milliseconds of parsing, whichever comes first. 0 disables yielding. */
  readonly yieldMs?: number;
  /** A read buffer to reuse across scans (a page's doubling slices share one); allocated per scan when absent. */
  readonly scratch?: Buffer;
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Hand every complete line of `[from, to)` to `onLine`, reading `READ_CHUNK_BYTES` at a
 * time and carrying a torn line across chunks, so a slice costs one chunk of memory
 * however long it is; a line over `MAX_LINE_BYTES` arrives skipped, head only. Parsing
 * is cooperative: every `yieldEvery` lines or `yieldMs` the loop gets a turn, because
 * this runs where the voice session and the daemon's liveness pongs run. Returns where
 * the torn last line starts (or `to`).
 */
export async function scanLines(fh: FileHandle, from: number, to: number, onLine: (line: Line) => void, opts: number | ScanOptions = {}): Promise<number> {
  const o: ScanOptions = typeof opts === "number" ? { chunkBytes: opts } : opts;
  const chunkBytes = o.chunkBytes ?? READ_CHUNK_BYTES;
  const yieldEvery = o.yieldEvery ?? YIELD_EVERY_LINES;
  const yieldMs = o.yieldMs ?? YIELD_EVERY_MS;
  const lines = new LineAssembler();
  // One scratch buffer for the whole scan (or for every slice of a page, when the caller
  // passes one): the assembler copies what it keeps (a torn fragment, a skipped line's
  // head) and lines become strings, so nothing points into it after push() returns. A
  // fresh 16 MB per read left RSS 80 MB higher after one page of a 48 MB file.
  const chunk = o.scratch && o.scratch.length >= Math.min(chunkBytes, to - from) ? o.scratch : Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, to - from)));
  let pos = from;
  let sinceYield = 0;
  let lastYield = performance.now();
  while (pos < to) {
    const want = Math.min(chunk.length, to - pos);
    const { bytesRead } = await fh.read(chunk, 0, want, pos);
    if (bytesRead === 0) break; // truncated under us: whatever is left is not there
    const body = chunk.subarray(0, bytesRead);
    for (const line of lines.push(body, pos)) {
      onLine(line);
      sinceYield += 1;
      if (yieldMs > 0 && (sinceYield >= yieldEvery || (sinceYield % 32 === 0 && performance.now() - lastYield >= yieldMs))) {
        await yieldNow();
        sinceYield = 0;
        lastYield = performance.now();
      }
    }
    pos += bytesRead;
  }
  return lines.pendingOffset ?? pos;
}

/**
 * Read `[.., end)` backward in growing slices until `pick` is satisfied. A slice that
 * starts inside the file may open in the middle of a message (an assistant reply split
 * over lines, a result whose call is earlier), so its first message is dropped as
 * suspect; the next, larger slice has it whole. The cost is bounded by twice the
 * distance from `end` to what was asked for, and never exceeds `maxBytes` back.
 */
async function readBackFrom<T>(path: string, end: number, makeParser: () => TranscriptParser, pick: Pick<T>, limits: ReadLimits = {}): Promise<T> {
  const fh = await open(path, "r");
  try {
    const cap = Math.min(end, Math.max(1, limits.maxBytes ?? MAX_PAGE_BYTES));
    let want = Math.min(cap, FIRST_TAIL_BYTES);
    let bytesRead = 0;
    const scratch = Buffer.allocUnsafe(Math.min(limits.chunkBytes ?? READ_CHUNK_BYTES, cap));
    for (;;) {
      const start = end - want;
      const last = want >= cap;
      bytesRead += want;
      // One byte before the slice says whether it begins a line; the slice itself cannot know.
      const from = start > 0 ? start - 1 : 0;
      const parser = makeParser();
      const endOffset = await scanLines(
        fh,
        from,
        end,
        (line) => {
          if (line.offset === from && start > 0) return; // torn by the cut (a line that begins at `start` starts at from + 1)
          parser.push(line);
        },
        { ...(limits.chunkBytes !== undefined ? { chunkBytes: limits.chunkBytes } : {}), scratch },
      );
      const all = start > 0 ? parser.all().slice(1) : parser.all();
      const page = pick({ all, atStart: start === 0, last, start, endOffset, parser, bytes: want, bytesRead });
      if (page !== undefined) return page;
      if (last) throw new Error(start === 0 ? `no page in ${path}` : `no page in the last ${formatBytes(want)} of ${path}`);
      want = Math.min(cap, want * 2);
    }
  } finally {
    await fh.close();
  }
}

function startOf(messages: readonly AgentMessage[], offsetOf: (id: string) => number | undefined, fallback: number): number {
  const first = messages[0];
  return first ? (offsetOf(first.id) ?? fallback) : fallback;
}

/** The newest `limit` messages; fewer when the last `MAX_PAGE_BYTES` of the file hold fewer (then `complete` is false). */
export async function readTailPage(path: string, makeParser: () => TranscriptParser, limit: number, limits?: ReadLimits): Promise<PageRead> {
  const size = (await stat(path)).size;
  const offsetOf = (p: TranscriptParser) => (id: string) => p.offsetOf(id);
  if (size === 0) {
    const parser = makeParser();
    return { messages: [], complete: true, total: 0, startOffset: 0, endOffset: 0, parser, offsetOf: offsetOf(parser), bytesRead: 0, orphans: parser.orphans };
  }
  return readBackFrom<PageRead>(
    path,
    size,
    makeParser,
    ({ all, atStart, last, start, endOffset, parser, bytesRead }) => {
      if (!atStart && all.length < limit && !last) return undefined;
      const messages = all.slice(-limit);
      const complete = atStart && all.length <= limit;
      // The parser stays alive as the tail's: results of calls before the page are still reachable through it.
      return { messages, complete, total: atStart ? all.length : undefined, startOffset: startOf(messages, offsetOf(parser), atStart ? 0 : start), endOffset, parser, offsetOf: offsetOf(parser), bytesRead, orphans: parser.orphans };
    },
    limits,
  );
}

/**
 * The `limit` messages just before byte `fromOffset` — the cursor of the page after
 * them — read backward in growing slices from that byte. Each slice is its own parser;
 * a slice's running calls take their results from the newer slices (and from `known`,
 * the parser that served the newer pages and the live tail), so an older page never
 * shows a call as running whose output sits in a range it did not read. `complete` when
 * the read reached byte 0; `total` is then the number of messages before `fromOffset`.
 * `maxBytes` bounds how far BACK from the cursor the read reaches (not the bytes the
 * doubling slices add up to — an unproductive slice is re-read inside the next, and
 * counting it twice halved the reach); past it the page is whatever was found —
 * possibly nothing, in which case `startOffset` is how far back the read got, so the
 * next ask moves on from there.
 */
export async function readBackward(path: string, makeParser: () => TranscriptParser, limit: number, fromOffset: number, limits: ReadLimits = {}, known?: ResultLookup): Promise<PageRead> {
  const size = (await stat(path)).size;
  const end = Math.max(0, Math.min(fromOffset, size));
  const cap = Math.max(1, limits.maxBytes ?? MAX_PAGE_BYTES);
  /** The furthest byte back this read may go. */
  const floor = Math.max(0, end - cap);
  const parsers: TranscriptParser[] = [];
  const offsets = new Map<string, number>();
  const offsetOf = (id: string): number | undefined => offsets.get(id);
  let kept: AgentMessage[] = [];
  let cursor = end;
  let lowest = end;
  let read = 0;
  let reachedStart = end === 0;
  let want = Math.min(FIRST_TAIL_BYTES, cap);
  const scratch = Buffer.allocUnsafe(Math.min(limits.chunkBytes ?? READ_CHUNK_BYTES, Math.max(1, Math.min(end, cap))));
  const fh = await open(path, "r");
  try {
    while (cursor > floor) {
      const start = Math.max(floor, cursor - want);
      if (start === 0) reachedStart = true;
      lowest = Math.min(lowest, start);
      const from = start > 0 ? start - 1 : 0;
      const parser = makeParser();
      await scanLines(
        fh,
        from,
        cursor,
        (line) => {
          if (line.offset === from && start > 0) return;
          parser.push(line);
        },
        { ...(limits.chunkBytes !== undefined ? { chunkBytes: limits.chunkBytes } : {}), scratch },
      );
      read += cursor - start;
      // Results for this slice's calls live in the newer slices and in what the source already served.
      for (const newer of parsers) parser.adoptResults(newer);
      if (known) parser.adoptResults(known);
      parsers.push(parser); // kept even when it holds no message: its orphan results answer older slices' calls
      const all = start > 0 ? parser.all().slice(1) : parser.all();
      if (all.length > 0) {
        for (const m of all) offsets.set(m.id, parser.offsetOf(m.id) ?? start);
        kept = all.concat(kept);
        // The next slice ends where this one's first whole message begins: its dropped suspect is re-read whole.
        cursor = start === 0 ? 0 : (offsets.get(all[0]!.id) ?? start);
      }
      // Otherwise the slice was nothing but a torn line (a 48 MB tool output, say) or one
      // suspect message: the cursor stays and the next, larger slice from the same edge
      // has it whole — moving the cursor back would leave that line between slices for ever.
      // At the floor there is no larger slice: the page is what was found.
      if (start === floor || kept.length >= limit) break;
      want *= 2;
    }
  } finally {
    await fh.close();
  }
  // A slice that began at byte 0 read everything before the cursor, whatever byte the first message sits at.
  const messages = kept.slice(-limit);
  const parser = parsers[0] ?? makeParser();
  // The slice parsers die with this call: spill what an older page could still need from them.
  const shown = new Set(messages.map((m) => m.id));
  const orphans = new Map<string, OrphanResult>();
  for (const p of parsers) for (const [callId, r] of p.spareResults(shown)) orphans.set(callId, r);
  return {
    messages,
    complete: reachedStart && kept.length <= limit,
    total: reachedStart ? kept.length : undefined,
    // Empty and not at the start: how far back the read got, so the next ask moves on from there.
    startOffset: messages.length ? (offsetOf(messages[0]!.id) ?? cursor) : reachedStart ? 0 : lowest,
    endOffset: end,
    parser,
    offsetOf,
    bytesRead: read,
    orphans,
  };
}

/** Every message in the file, with the parser that holds them. Tests and small files; pages never read a file whole. */
export async function readWhole(path: string, makeParser: () => TranscriptParser): Promise<PageRead> {
  const buf = await readFile(path);
  const lines = new LineAssembler();
  const parser = makeParser();
  for (const line of lines.push(buf, 0)) parser.push(line);
  const all = parser.all();
  return { messages: all, complete: true, total: all.length, startOffset: startOf(all, (id) => parser.offsetOf(id), 0), endOffset: lines.pendingOffset ?? buf.length, parser, offsetOf: (id) => parser.offsetOf(id), bytesRead: buf.length, orphans: parser.orphans };
}

/**
 * One page: the newest `limit` messages; or the `limit` messages ending just before
 * byte `beforeOffset`; or those before message `before`, located by reading from the
 * end (bounded by `maxBytes`: an id further back than that is an Error naming the
 * bound — a source that served the id knows its offset and never comes here for it).
 */
export async function readTranscriptPage(path: string, makeParser: () => TranscriptParser, opts: TranscriptOptions = {}, limits: ReadLimits = {}): Promise<PageRead> {
  const limit = Math.max(1, opts.limit ?? DEFAULT_PAGE);
  if (opts.beforeOffset !== undefined) return readBackward(path, makeParser, limit, opts.beforeOffset, limits);
  if (opts.before === undefined) return readTailPage(path, makeParser, limit, limits);
  const before = opts.before;
  const size = (await stat(path)).size;
  const located = await readBackFrom<{ offset: number; after: number; parser: TranscriptParser; bytesRead: number }>(
    path,
    size,
    makeParser,
    ({ all, atStart, last, parser, bytes, bytesRead }) => {
      const idx = all.findIndex((m) => m.id === before);
      if (idx !== -1) return { offset: parser.offsetOf(before) ?? 0, after: all.length - idx, parser, bytesRead };
      if (atStart) throw new Error(`no message ${before} in ${path}`);
      if (last) throw new Error(`no message ${before} in the last ${formatBytes(bytes)} of ${path}`);
      return undefined;
    },
    limits,
  );
  const page = await readBackward(path, makeParser, limit, located.offset, limits, located.parser);
  return { ...page, total: page.total === undefined ? undefined : page.total + located.after, bytesRead: page.bytesRead + located.bytesRead };
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
  readonly goneAfterMs?: number;
  /** Page-read bounds (tests). */
  readonly limits?: ReadLimits;
}

export interface FollowOptions {
  /** Replay the whole file as deltas (a file that did not exist when the empty page was shown). */
  readonly fromStart?: boolean;
  /** Start the tail at this byte with a fresh parser (a file that took over from another at that point). */
  readonly fromOffset?: number;
  /** The tail stopped on its own — see `FileTailOptions.onEnd`. */
  readonly onEnd?: (reason: TailEnd) => void;
}

interface ReadState {
  readonly parser: TranscriptParser;
  /** Where the served range ends: the file size at the last read, then wherever the tail has got to. */
  endOffset: number;
  total: number;
}

/**
 * One session file's conversation: pages on demand and a live tail. The tail continues
 * from the last page read — same parser, same byte — so nothing between the page and the
 * first delta is missed or repeated, and a result for a call shown in the page finds it.
 * Older pages are read backward from the byte the newest served page begins at, by
 * cursor (`offsetOf` an id the app still holds, or the byte range it was told).
 */
export class TranscriptSource {
  private last: ReadState | undefined;
  private readonly tails = new Set<FileTail>();
  /** Where every served message began, newest 8 192; how a `before` id becomes a byte. */
  private offsets = new Map<string, number>();
  /** Oldest byte a page has covered; an id nobody here has seen pages back from it. */
  private earliest: number | undefined;
  /** Messages served across the tail page, older pages and deltas — exact once a page reached byte 0. */
  private servedCount = 0;
  /** A backward read that found nothing before it hit its bound: where it got to, so the next ask goes on from there. */
  private readonly gaps = new Map<number, number>();
  /**
   * Results the older pages held for calls they did not show (each page's slice parsers
   * are gone once it is served): what the page before them adopts. Without this a group
   * of parallel calls split by a page boundary read `running` for ever on the older side.
   */
  private olderResults = new Map<string, OrphanResult>();

  constructor(private readonly opts: TranscriptSourceOptions) {}

  /** How a backward read asks "did this call finish somewhere I already served?": the tail's parser first, then the older pages' spill. */
  private lookup(): ResultLookup {
    return { resultFor: (callId) => this.last?.parser.resultFor(callId) ?? this.olderResults.get(callId) };
  }

  private spill(results: ReadonlyMap<string, OrphanResult>): void {
    for (const [callId, r] of results) {
      this.olderResults.delete(callId); // re-insert: the newest stay when the bound trims
      this.olderResults.set(callId, r);
      if (this.olderResults.size > SOURCE_RESULTS_RETAINED) this.olderResults.delete(this.olderResults.keys().next().value as string);
    }
  }

  get path(): string {
    return this.opts.path;
  }

  /** A page has been served from this source (the empty page of a file not written yet counts). */
  get served(): boolean {
    return this.last !== undefined;
  }

  /** Messages known in the file, as the last page or delta left it. */
  get total(): number {
    return this.last?.total ?? 0;
  }

  /** Byte range served so far: from the oldest page's first message to where the tail has read. */
  get cursor(): { startOffset: number; endOffset: number } | undefined {
    return this.last ? { startOffset: this.earliest ?? this.last.endOffset, endOffset: this.last.endOffset } : undefined;
  }

  /** Byte where a served message begins, if this source served it. */
  offsetOf(id: string): number | undefined {
    return this.offsets.get(id) ?? this.last?.parser.offsetOf(id);
  }

  private remember(messages: readonly AgentMessage[], offsetOf: (id: string) => number | undefined): void {
    for (const m of messages) {
      const o = offsetOf(m.id);
      if (o === undefined) continue;
      this.offsets.set(m.id, o);
      if (this.offsets.size > OFFSETS_RETAINED) this.offsets.delete(this.offsets.keys().next().value as string);
    }
  }

  async page(opts: TranscriptOptions = {}): Promise<TranscriptPage> {
    if (opts.before !== undefined || opts.beforeOffset !== undefined) return this.older(opts);
    let read: PageRead;
    try {
      read = await readTailPage(this.opts.path, this.opts.makeParser, Math.max(1, opts.limit ?? DEFAULT_PAGE), this.opts.limits);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // Not written yet (a thread started seconds ago): an empty, complete page; the tail waits for the file.
      this.last = { parser: this.opts.makeParser(), endOffset: 0, total: 0 };
      this.earliest = 0;
      this.servedCount = 0;
      return { messages: [], total: 0, complete: true }; // no bytes yet, so no cursor to page before
    }
    // Exact when the read reached the start of the file. Otherwise the store's estimate
    // (turns, not tool calls: often low for Codex), never less than a page that is not the
    // whole story plus one, nor less than what an earlier read of this file established.
    const total = read.total ?? Math.max(this.opts.storeCount?.() ?? 0, read.messages.length + (read.complete ? 0 : 1), this.last?.total ?? 0);
    read.parser.take(); // the page is on screen: nothing in it is a pending change for the tail to re-emit
    this.last = { parser: read.parser, endOffset: read.endOffset, total };
    this.offsets = new Map();
    this.remember(read.messages, read.offsetOf);
    this.earliest = read.startOffset;
    this.servedCount = read.messages.length;
    this.gaps.clear();
    this.olderResults = new Map(); // the older pages will be read again from this one
    return { messages: read.messages, total, complete: read.complete, cursor: { startOffset: read.startOffset, endOffset: read.endOffset } };
  }

  /** An older page, read backward from the byte the asked-for message (or range) begins at. */
  private async older(opts: TranscriptOptions): Promise<TranscriptPage> {
    const limit = Math.max(1, opts.limit ?? DEFAULT_PAGE);
    let from = opts.beforeOffset ?? (opts.before !== undefined ? this.offsetOf(opts.before) : undefined) ?? this.earliest;
    if (from === undefined) from = (await stat(this.opts.path)).size;
    from = this.gaps.get(from) ?? from;
    const read = await readBackward(this.opts.path, this.opts.makeParser, limit, from, this.opts.limits, this.lookup());
    this.spill(read.orphans); // this page's slices are gone; the page before it may need what they held
    this.remember(read.messages, read.offsetOf);
    if (read.messages.length === 0 && !read.complete && read.startOffset < from) this.gaps.set(from, read.startOffset);
    const covered = this.earliest === undefined || read.startOffset < this.earliest;
    if (covered) this.earliest = read.startOffset;
    if (covered) this.servedCount += read.messages.length;
    const previous = this.last?.total ?? 0;
    // Exact once a page reached byte 0 (everything between there and the tail has been served); never lower than before.
    const total = read.complete ? Math.max(this.servedCount, previous) : Math.max(previous, this.servedCount + 1, this.opts.storeCount?.() ?? 0);
    if (this.last) this.last.total = total;
    return { messages: read.messages, total, complete: read.complete, cursor: { startOffset: read.startOffset, endOffset: read.endOffset } };
  }

  /**
   * Take over another source's served state: the same parser (its open calls, its ids'
   * offsets) and read position, so a file that moved (Codex archives by moving the
   * rollout) is followed on from the same byte with no gap and no replay.
   */
  continueFrom(other: TranscriptSource): void {
    this.last = other.last;
    this.offsets = other.offsets;
    this.earliest = other.earliest;
    this.servedCount = other.servedCount;
    this.olderResults = other.olderResults;
  }

  /**
   * New messages as the file grows, until the returned function is called. Without a
   * page read first, a small tail is parsed silently to seed the open tool calls;
   * `fromStart` instead replays the whole file as deltas (a file that did not exist when
   * the empty page was shown). Either way the tail's parser becomes the served state, so
   * `interruptOpenCalls`, `total` and `cursor` speak for what the pane was shown — a
   * `codex exec` killed mid-tool after a replay must still read `interrupted`, not run
   * for ever. `onEnd` hears once when the tail stops on its own.
   */
  follow(onDelta: (delta: TranscriptDelta) => void, opts: FollowOptions = {}): () => void {
    let tail: FileTail | undefined;
    let closed = false;
    void (async () => {
      let state: ReadState | undefined = opts.fromStart
        ? { parser: this.opts.makeParser(), endOffset: 0, total: 0 }
        : opts.fromOffset !== undefined
          ? { parser: this.opts.makeParser(), endOffset: opts.fromOffset, total: this.last?.total ?? this.opts.storeCount?.() ?? 0 }
          : this.last;
      let seeded: PageRead | undefined;
      if (!state) {
        try {
          seeded = await readTailPage(this.opts.path, this.opts.makeParser, 1, this.opts.limits);
          state = { parser: seeded.parser, endOffset: seeded.endOffset, total: Math.max(this.opts.storeCount?.() ?? 0, seeded.total ?? 0) };
        } catch {
          state = { parser: this.opts.makeParser(), endOffset: 0, total: 0 };
        }
      }
      if (closed) return;
      const live = state;
      if (live !== this.last) {
        // A replay, a hand-over at a byte, or a silent seed: nothing older was served from
        // this source, so this parser IS what the pane knows from now on.
        this.last = live;
        this.offsets = new Map();
        this.servedCount = 0;
        this.earliest = opts.fromStart ? 0 : opts.fromOffset !== undefined ? opts.fromOffset : (seeded?.startOffset ?? live.endOffset);
        this.gaps.clear();
        this.olderResults = new Map();
      }
      const { parser } = live;
      parser.take(); // whatever the seed produced is already on screen (or never was asked for)
      parser.bound(RETAIN_DRAFTS); // a tail that runs for hours keeps the newest drafts, not every one
      let known = parser.added;
      const queue: Line[] = [];
      let draining = false;
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          while (queue.length && !closed) {
            const batch = queue.splice(0, YIELD_EVERY_LINES);
            for (const line of batch) parser.push(line);
            const messages = parser.take();
            if (tail) live.endOffset = tail.endOffset;
            if (messages.length) {
              const grew = Math.max(0, parser.added - known);
              known = parser.added;
              live.total += grew;
              this.remember(messages, (id) => parser.offsetOf(id));
              if (live === this.last) this.servedCount += grew;
              onDelta({ messages, total: live.total });
            }
            if (queue.length) await yieldNow();
          }
        } finally {
          draining = false;
        }
      };
      tail = new FileTail({
        path: this.opts.path,
        offset: live.endOffset,
        ...(this.opts.pollMs !== undefined ? { pollMs: this.opts.pollMs } : {}),
        ...(this.opts.coalesceMs !== undefined ? { coalesceMs: this.opts.coalesceMs } : {}),
        ...(this.opts.goneAfterMs !== undefined ? { goneAfterMs: this.opts.goneAfterMs } : {}),
        ...(this.opts.limits?.chunkBytes !== undefined ? { chunkBytes: this.opts.limits.chunkBytes } : {}),
        onLines: (lines) => {
          queue.push(...lines);
          void drain();
        },
        onEnd: (reason) => {
          if (tail) this.tails.delete(tail);
          if (!closed) opts.onEnd?.(reason);
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

  /** Every call the served parser still shows running is over (its process ended); the changed messages. */
  interruptOpenCalls(): AgentMessage[] {
    return this.last?.parser.interruptOpenCalls() ?? [];
  }

  /** Stop every tail. */
  close(): void {
    for (const t of this.tails) t.close();
    this.tails.clear();
  }
}
