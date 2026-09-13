import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryItem, MemorySource } from "@jarhead/protocol";
import type { Exclusion, MemoryRow, Watermark } from "./types.ts";
import { MAX_SOURCES } from "./limits.ts";

/**
 * The record: one JSON row per line, appended and never rewritten. Appends are
 * fsync-free — a crash mid-write leaves at most a partial last line, which
 * replay skips as malformed and the next append heals with a newline so it
 * costs exactly that one line, never the row after it; the file only grows.
 * `replay` folds the rows into the state the store serves — it is the source
 * of truth whenever index.json is missing, corrupt or stale.
 */
export class MemoryLog {
  /** What is known about the file's last byte, and at what size; another writer growing the file makes it unknown again. */
  private tail: { readonly size: number; readonly newline: boolean } | undefined;

  constructor(readonly path: string) {}

  append(row: MemoryRow): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(row)}\n`;
    const text = this.tailNeedsNewline() ? `\n${line}` : line;
    appendFileSync(this.path, text, { mode: 0o600 });
    this.tail = { size: (this.tail?.size ?? 0) + Buffer.byteLength(text), newline: true };
  }

  /** A row appended onto an unknown or foreign tail first looks at the last byte; our own appends are known to end in a newline. */
  private tailNeedsNewline(): boolean {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      this.tail = { size: 0, newline: true };
      return false;
    }
    if (size === 0) {
      this.tail = { size: 0, newline: true };
      return false;
    }
    if (this.tail && this.tail.size === size) return !this.tail.newline;
    const fd = openSync(this.path, "r");
    try {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      const newline = b[0] === 0x0a;
      this.tail = { size, newline };
      return !newline;
    } finally {
      closeSync(fd);
    }
  }

  /** Every row in order; malformed lines are skipped and counted, never fatal. */
  read(): { readonly rows: MemoryRow[]; readonly lines: number; readonly skipped: number } {
    if (!existsSync(this.path)) {
      this.tail = { size: 0, newline: true };
      return { rows: [], lines: 0, skipped: 0 };
    }
    const text = readFileSync(this.path, "utf8");
    this.tail = { size: Buffer.byteLength(text), newline: text.length === 0 || text.endsWith("\n") };
    const rows: MemoryRow[] = [];
    let lines = 0;
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      lines++;
      try {
        const row = JSON.parse(line) as MemoryRow;
        if (typeof row !== "object" || row === null || typeof row.op !== "string") throw new Error("not a row");
        rows.push(row);
      } catch {
        skipped++;
      }
    }
    return { rows, lines, skipped };
  }

  bytes(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }
}

export interface ReplayState {
  readonly items: Map<string, MemoryItem>;
  readonly watermarks: Map<string, Watermark>;
  readonly exclusions: Exclusion[];
  consolidatedAt: number;
}

export function emptyState(): ReplayState {
  return { items: new Map(), watermarks: new Map(), exclusions: [], consolidatedAt: 0 };
}

function combine(a: number, b: number): number {
  return 1 - (1 - a) * (1 - b);
}

function unionSubjects(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of [...a, ...b]) {
    const t = s.toLowerCase().trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * ≤ MAX_SOURCES, newest last — and the FIRST mention always kept: an episode
 * is dated by it, and eight later recalls must not move the day it happened.
 */
export function capSources(sources: readonly MemorySource[]): MemorySource[] {
  if (sources.length <= MAX_SOURCES) return [...sources];
  return [sources[0]!, ...sources.slice(sources.length - (MAX_SOURCES - 1))];
}

function pushSource(sources: readonly MemorySource[], s: MemorySource): MemorySource[] {
  return capSources([...sources, s]);
}

/** Apply one row to the state. Rows for unknown ids are ignored (a log is never rejected for one bad line). */
export function applyRow(state: ReplayState, row: MemoryRow): void {
  switch (row.op) {
    case "add":
      state.items.set(row.item.id, { ...row.item });
      return;
    case "update": {
      const it = state.items.get(row.id);
      if (!it) return;
      const next: MemoryItem = {
        ...it,
        ...(row.patch.text !== undefined ? { text: row.patch.text } : {}),
        ...(row.patch.kind !== undefined ? { kind: row.patch.kind } : {}),
        ...(row.patch.subjects !== undefined ? { subjects: [...row.patch.subjects] } : {}),
        ...(row.patch.confidence !== undefined ? { confidence: row.patch.confidence } : {}),
        ...(row.patch.importance !== undefined ? { importance: row.patch.importance } : {}),
        // Seen again: the count grows — unless the new words reverse the old, when they start their own count.
        ...(row.source ? { seenCount: row.replaces ? 1 : it.seenCount + 1, lastSeenAt: row.at, sources: pushSource(it.sources, row.source) } : {}),
      };
      state.items.set(row.id, next);
      return;
    }
    case "touch": {
      const it = state.items.get(row.id);
      if (!it) return;
      state.items.set(row.id, {
        ...it,
        seenCount: it.seenCount + 1,
        lastSeenAt: row.at,
        sources: pushSource(it.sources, row.source),
        ...(row.patch?.confidence !== undefined ? { confidence: row.patch.confidence } : {}),
        ...(row.patch?.importance !== undefined ? { importance: row.patch.importance } : {}),
        ...(row.patch?.subjects !== undefined ? { subjects: [...row.patch.subjects] } : {}),
      });
      return;
    }
    case "forget": {
      const it = state.items.get(row.id);
      if (it) state.items.set(row.id, { ...it, state: "forgotten" });
      return;
    }
    case "restore": {
      const it = state.items.get(row.id);
      if (it) state.items.set(row.id, { ...it, state: "live" });
      return;
    }
    case "merge": {
      const older = state.items.get(row.id);
      const newer = state.items.get(row.into);
      if (older) state.items.set(row.id, { ...older, state: "merged", mergedInto: row.into });
      if (older && newer && row.fold) {
        const sources = [...newer.sources, ...older.sources].sort((a, b) => a.at - b.at);
        state.items.set(row.into, {
          ...newer,
          seenCount: newer.seenCount + older.seenCount,
          confidence: combine(newer.confidence, older.confidence),
          importance: Math.max(newer.importance, older.importance),
          subjects: unionSubjects(newer.subjects, older.subjects),
          sources: capSources(sources),
        });
      }
      return;
    }
    case "archive": {
      const it = state.items.get(row.id);
      if (it && it.state === "live") state.items.set(row.id, { ...it, state: "archived" });
      return;
    }
    case "watermark":
      state.watermarks.set(row.sessionId, { at: row.at, upToAt: row.upToAt, extractor: row.extractor, counts: row.counts });
      return;
    case "exclude":
      state.exclusions.push({ from: row.from, to: row.to, ...(row.sessionId ? { sessionId: row.sessionId } : {}) });
      return;
    case "consolidated":
      state.consolidatedAt = row.at;
      return;
    default:
      return;
  }
}

export function replay(rows: readonly MemoryRow[]): ReplayState {
  const state = emptyState();
  for (const row of rows) applyRow(state, row);
  return state;
}
