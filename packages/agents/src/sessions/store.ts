import { open, stat } from "node:fs/promises";

/**
 * Shared shapes and file helpers for the session stores.
 *
 * Both Claude Code and Codex keep one JSONL file per session, and some of those
 * files run to hundreds of MB. Everything a listing needs (who, where, first
 * ask, last answer, when) lives at the very start and the very end of the file,
 * so the stores read a bounded head and tail and never the middle.
 */

export type SessionTool = "claude" | "codex";

/**
 * Who drove the session. Codex writes `thread_source` into session_meta: "user" for a
 * thread Kevin typed into, "subagent" for a child rollout spawned by another thread,
 * "automation" for a scheduled run. Older rollouts and Claude Code sessions say nothing,
 * hence "unknown".
 */
export type SessionSource = "user" | "subagent" | "automation" | "unknown";

export interface DiscoveredSession {
  readonly tool: SessionTool;
  /** The tool's own id (Claude session uuid, Codex thread id — the one in the rollout filename). */
  readonly id: string;
  readonly source: SessionSource;
  /** Codex sub-agent rollouts: the thread that spawned this one. */
  readonly parentId: string | undefined;
  readonly path: string;
  readonly cwd: string | undefined;
  /** A saved title when the tool wrote one; otherwise undefined. */
  readonly title: string | undefined;
  readonly firstPrompt: string | undefined;
  /** Last assistant text block(s), ≤ 2000 chars. */
  readonly lastAssistantText: string | undefined;
  readonly startedAt: number | undefined;
  /** max(file mtime, last in-file timestamp), in ms. */
  readonly lastActivityAt: number;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  /**
   * Kevin's turns plus assistant messages. Claude Code writes one JSONL line per content
   * block (thinking, text, each tool_use), so an assistant message is counted once per
   * `message.id`, not per line. An extrapolation when the middle was skipped.
   */
  readonly messageCount: number;
  readonly messageCountExact: boolean;
  /** Codex: the file sits in archived_sessions. */
  readonly archived: boolean;
}

export interface StoreOptions {
  /** Skip files not modified within this many days. Default 14. */
  readonly maxAgeDays?: number;
  /** Newest-first cap. Default 60. */
  readonly limit?: number;
  readonly now?: () => number;
}

export const DEFAULT_MAX_AGE_DAYS = 14;
export const DEFAULT_LIMIT = 60;
export const MAX_ASSISTANT_CHARS = 2000;

export interface FileSlices {
  /** Complete lines from the start of the file. */
  readonly head: string[];
  /** Complete lines from the end of the file; empty when `whole` is true. */
  readonly tail: string[];
  /** The whole file fit in the head budget, so `head` is every line. */
  readonly whole: boolean;
  readonly bytesRead: number;
  readonly size: number;
  readonly mtimeMs: number;
}

const NEWLINE = 0x0a;

/**
 * Read the first `headBytes` and last `tailBytes` of a file as complete lines.
 * Small files are read whole. A line torn by a cut point is dropped; a cut that
 * lands exactly on a line break tears nothing, and every line on its side is kept.
 */
export async function readHeadTail(path: string, headBytes: number, tailBytes: number): Promise<FileSlices> {
  const st = await stat(path);
  const size = st.size;
  const fh = await open(path, "r");
  try {
    if (size <= headBytes + tailBytes) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      return { head: splitLines(buf.toString("utf8")), tail: [], whole: true, bytesRead: size, size, mtimeMs: st.mtimeMs };
    }
    const headBuf = Buffer.alloc(headBytes);
    // One byte before the tail slice tells whether the slice starts a line (that byte is
    // a newline) or lands inside one; the slice itself cannot know.
    const tailBuf = Buffer.alloc(tailBytes + 1);
    await Promise.all([fh.read(headBuf, 0, headBytes, 0), fh.read(tailBuf, 0, tailBytes + 1, size - tailBytes - 1)]);
    const headLines = splitLines(headBuf.toString("utf8"));
    if (headBytes > 0 && headBuf[headBytes - 1] !== NEWLINE) headLines.pop(); // the cut line
    const tailLines = splitLines(tailBuf.subarray(1).toString("utf8"));
    if (tailBuf[0] !== NEWLINE) tailLines.shift(); // the cut line
    return { head: headLines, tail: tailLines, whole: false, bytesRead: headBytes + tailBytes, size, mtimeMs: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Strip pseudo-XML wrappers Claude Code adds around slash commands and attachments. */
export function stripTags(text: string): string {
  return text.replace(/<[^>\n]{1,60}>/g, " ").replace(/\s+/g, " ").trim();
}

/** "3d ago", "12m ago", "just now". */
export function ago(thenMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Extrapolate a count seen in `bytesRead` bytes to the full file. */
export function extrapolateCount(seen: number, bytesRead: number, size: number): number {
  if (bytesRead <= 0 || size <= bytesRead) return seen;
  return Math.round((seen * size) / bytesRead);
}

/** Newest first, then the cap. */
export function newestFirst<T extends { readonly mtimeMs: number }>(items: readonly T[], limit: number): T[] {
  return [...items].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Parse results cached by path, invalidated by size or mtime. */
export class ParseCache<T> {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; value: T }>();

  get(path: string, mtimeMs: number, size: number): T | undefined {
    const e = this.entries.get(path);
    return e && e.mtimeMs === mtimeMs && e.size === size ? e.value : undefined;
  }

  set(path: string, mtimeMs: number, size: number, value: T): void {
    this.entries.set(path, { mtimeMs, size, value });
  }

  /** Drop entries for files no longer listed. */
  retain(paths: ReadonlySet<string>): void {
    for (const k of this.entries.keys()) if (!paths.has(k)) this.entries.delete(k);
  }
}
