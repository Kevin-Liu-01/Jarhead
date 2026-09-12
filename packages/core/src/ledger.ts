import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JarheadSessionSummary, LedgerRow } from "@jarhead/protocol";

/** How much of the first heard line becomes a session's title. */
const TITLE_CHARS = 60;

/**
 * The server's word for a close the engine asked for (`session.close` answered), and
 * ours for one it had to force (`terminate()` after the close deadline). Neither says
 * why; the transport row before it does — a `pause` or a pressed `stop`.
 */
const CLIENT_CLOSE_REASONS = new Set(["close_requested", "client_closed"]);

/** A parsed day file, valid while the file on disk has this mtime and size. */
interface ParsedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly rows: readonly LedgerRow[];
}

/** Where a row sits in the ledger: which day file, which line. */
interface Position {
  readonly file: string;
  readonly index: number;
}

/**
 * One of Jarhead's sessions as the walk over the ledger builds it. `end` is where
 * its rows stop: the `session.closed` row (inclusive) or, for a session that was
 * never closed, the next `session.started` row (exclusive) — a late closed row for
 * a lost session updates the summary but never widens the span into the next one.
 */
interface BuiltSession {
  readonly id: string;
  readonly day: string;
  readonly startedAt: number;
  readonly resumedFrom?: string;
  readonly start: Position;
  /** This session began by losing the one before it (no closed row); a `?` closed row after that is ambiguous. */
  readonly lostPredecessor: boolean;
  end?: Position;
  endInclusive: boolean;
  closedAt?: number;
  reason?: string;
  /** From the `session.closed` row, or a lost session's last usage-bearing row. */
  usageSeconds: number;
  /** The last `pause` row's usage: what a session with no closed row was billed. */
  lastUsage: number;
  /** The last transport row inside the session: what a client-requested close meant. */
  lastTransport?: "pause" | "stop";
  heard: number;
  said: number;
  delegations: number;
  title: string;
}

/** One pass over the ledger, valid while no day file changed. */
interface Walk {
  /** Every (file, mtime, size) the walk read, in order — the cache key. */
  readonly signature: string;
  readonly sessions: readonly BuiltSession[];
  /** Rows that name a session (`sessionId`), by session, wherever they sit. */
  readonly named: ReadonlyMap<string, readonly Position[]>;
}

/**
 * Append-only JSONL, one file per local day, under <stateDir>/ledger.
 *
 * Synchronous appends on purpose: rows are small, the file is local, and a crash
 * between "did" and "recorded" is exactly the gap an append-only log exists to
 * close. The Console reads it back; nothing is shown that was not written.
 */
export class Ledger {
  readonly dir: string;
  private readonly listeners = new Set<(row: LedgerRow) => void>();
  /** Parsed day files keyed by file name, invalidated by mtime + size (an append changes both). */
  private readonly parsed = new Map<string, ParsedFile>();
  /** The last walk over every file, reused while every file's mtime + size is what it read. */
  private walked?: Walk;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "ledger");
    mkdirSync(this.dir, { recursive: true });
  }

  static fileNameFor(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`;
  }

  append(row: LedgerRow): void {
    appendFileSync(join(this.dir, Ledger.fileNameFor(row.at)), `${JSON.stringify(row)}\n`);
    for (const l of this.listeners) {
      try {
        l(row);
      } catch {
        // Listeners are views; a broken view never blocks the record.
      }
    }
  }

  onRow(listener: (row: LedgerRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rows for one day, oldest first. Malformed lines are skipped, not fatal. */
  read(at: number = Date.now()): LedgerRow[] {
    const file = Ledger.fileNameFor(at);
    if (!existsSync(join(this.dir, file))) return [];
    return [...this.rowsOf(file)];
  }

  days(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort();
  }

  /**
   * Jarhead's own Live sessions across every day, newest first: one summary per
   * `session.started` row. A session may cross midnight (its closed row is in the
   * next file); one with no closed row anywhere is open — unless a later session
   * started, in which case it was lost at that moment, billed what its last `pause`
   * row said (else nothing). A close the engine asked for (`close_requested`, or
   * `client_closed` when it had to force it) is reported as what Kevin did — "paused"
   * after a `pause` row, "stopped" after a pressed `stop` — since the server's word
   * says nothing about why; any other reason (idle, connection_lost, …) is kept.
   */
  sessions(): JarheadSessionSummary[] {
    return this.walk()
      .sessions.map((b) => Ledger.summarize(b))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The rows of one session: its `session.started` row through its `session.closed`
   * row inclusive (across a midnight file boundary), plus every `stop` / `pause` /
   * `resume` row that lands within it, and any row that names the session wherever
   * it sits (a `resume` written before the started row it announces). Rows inside
   * the span that name another session belong to that one and are left out.
   */
  readSession(sessionId: string): LedgerRow[] {
    const walk = this.walk();
    const built = walk.sessions.find((b) => b.id === sessionId);
    if (!built) return [];
    const out: LedgerRow[] = [];
    // Only the span's own files are read; a row that names the session from outside
    // the span (a `resume` before its started row) is placed by the walk already.
    const files = this.days();
    const first = files.indexOf(built.start.file);
    const last = built.end ? files.indexOf(built.end.file) : files.length - 1;
    const outside = (walk.named.get(sessionId) ?? []).filter((p) => !Ledger.within(built, p));
    for (const p of outside) if (p.file < built.start.file) out.push(this.rowsOf(p.file)[p.index]!);
    for (let f = Math.max(0, first); f <= last; f++) {
      const file = files[f]!;
      const rows = this.rowsOf(file);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const named = Ledger.sessionIdOf(row);
        if (named === sessionId) {
          out.push(row);
          continue;
        }
        if (named !== undefined) continue;
        if (Ledger.within(built, { file, index })) out.push(row);
      }
    }
    // An open session's span runs to the last file, so only a closed one has files after it.
    if (built.end) for (const p of outside) if (p.file > built.end.file) out.push(this.rowsOf(p.file)[p.index]!);
    return out;
  }

  // ------------------------------------------------------------------ internals

  private rowsOf(file: string): readonly LedgerRow[] {
    const path = join(this.dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      this.parsed.delete(file);
      return [];
    }
    const hit = this.parsed.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.rows;
    const rows = Ledger.parse(readFileSync(path, "utf8"));
    this.parsed.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
    return rows;
  }

  private static parse(text: string): LedgerRow[] {
    const rows: LedgerRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as LedgerRow);
      } catch {
        // A torn last line from a crash is expected; skip it.
      }
    }
    return rows;
  }

  /** The session a row names, for the rows that carry one. */
  private static sessionIdOf(row: LedgerRow): string | undefined {
    switch (row.type) {
      case "session.started":
      case "session.closed":
      case "pause":
      case "resume":
        // Older engines wrote pause / resume rows without a session, and a closed row
        // for a session whose id was already gone says "?": those belong to whichever
        // session is open around them.
        return typeof row.sessionId === "string" && row.sessionId !== "?" ? row.sessionId : undefined;
      default:
        return undefined;
    }
  }

  private static within(b: BuiltSession, at: Position): boolean {
    if (at.file < b.start.file || (at.file === b.start.file && at.index < b.start.index)) return false;
    if (!b.end) return true;
    if (at.file < b.end.file) return true;
    if (at.file > b.end.file) return false;
    return b.endInclusive ? at.index <= b.end.index : at.index < b.end.index;
  }

  /**
   * One pass over every day file, oldest first, attributing rows to the session open
   * around them. Memoised: every file is stat'ed (the parse cache does that anyway)
   * and the pass is redone only when one changed — a `ledger.sessions` request on a
   * quiet day costs the stats, not the rows.
   */
  private walk(): Walk {
    const files = this.days();
    const parts: string[] = [];
    for (const file of files) {
      this.rowsOf(file);
      const p = this.parsed.get(file);
      parts.push(p ? `${file}:${p.mtimeMs}:${p.size}` : `${file}:gone`);
    }
    const signature = parts.join("\n");
    if (this.walked && this.walked.signature === signature) return this.walked;

    const sessions: BuiltSession[] = [];
    const byId = new Map<string, BuiltSession>();
    const named = new Map<string, Position[]>();
    let open: BuiltSession | undefined;
    for (const file of files) {
      const day = file.replace(/\.jsonl$/, "");
      const rows = this.rowsOf(file);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const names = Ledger.sessionIdOf(row);
        if (names !== undefined) {
          const list = named.get(names);
          if (list) list.push({ file, index });
          else named.set(names, [{ file, index }]);
        }
        switch (row.type) {
          case "session.started": {
            const lost = open !== undefined && open.closedAt === undefined;
            if (open && lost) {
              // Never closed: lost when the next one started, billed what its last pause said.
              open.closedAt = row.at;
              open.reason = "lost";
              open.usageSeconds = open.lastUsage;
              open.end = { file, index };
              open.endInclusive = false;
            }
            const started: BuiltSession = {
              id: row.sessionId,
              day,
              startedAt: row.at,
              ...(row.resumedFrom ? { resumedFrom: row.resumedFrom } : {}),
              start: { file, index },
              lostPredecessor: lost,
              endInclusive: true,
              usageSeconds: 0,
              lastUsage: 0,
              heard: 0,
              said: 0,
              delegations: 0,
              title: "",
            };
            byId.set(started.id, started);
            sessions.push(started);
            open = started;
            break;
          }
          case "session.closed": {
            // A legacy "?" row is the open session's — unless that one began by losing its
            // predecessor, when the row is as likely the lost one's; then it is left out
            // rather than closing the wrong session with the wrong usage.
            const target = byId.get(row.sessionId) ?? (row.sessionId === "?" && open && !open.lostPredecessor ? open : undefined);
            if (!target) break;
            const lost = target.end !== undefined && !target.endInclusive;
            target.closedAt = row.at;
            target.reason = Ledger.closeReason(row.reason, target.lastTransport);
            target.usageSeconds = typeof row.usageSeconds === "number" ? row.usageSeconds : target.lastUsage;
            if (!lost) {
              target.end = { file, index };
              target.endInclusive = true;
            }
            if (open === target) open = undefined;
            break;
          }
          case "pause": {
            const target = (typeof row.sessionId === "string" ? byId.get(row.sessionId) : undefined) ?? open;
            if (!target) break;
            if (typeof row.usageSeconds === "number") target.lastUsage = row.usageSeconds;
            target.lastTransport = "pause";
            break;
          }
          case "stop":
            // Only a pressed stop closes the session (a spoken one keeps it listening).
            if (open && row.how === "pressed") open.lastTransport = "stop";
            break;
          case "heard":
            if (open) {
              open.heard += 1;
              if (!open.title && row.item) open.title = Ledger.title(row.item.text);
            }
            break;
          case "said":
            if (open) open.said += 1;
            break;
          case "delegation.created":
            if (open) open.delegations += 1;
            break;
          default:
            break;
        }
      }
    }
    this.walked = { signature, sessions, named };
    return this.walked;
  }

  /** "paused" / "stopped" for a close the engine asked for after that row; the server's word otherwise. */
  private static closeReason(reason: string, lastTransport: BuiltSession["lastTransport"]): string {
    if (!CLIENT_CLOSE_REASONS.has(reason) || !lastTransport) return reason;
    return lastTransport === "pause" ? "paused" : "stopped";
  }

  private static title(text: string): string {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > TITLE_CHARS ? flat.slice(0, TITLE_CHARS).trimEnd() : flat;
  }

  private static summarize(b: BuiltSession): JarheadSessionSummary {
    const closed = b.closedAt !== undefined;
    return {
      id: b.id,
      day: b.day,
      startedAt: b.startedAt,
      ...(closed ? { closedAt: b.closedAt as number } : {}),
      ...(closed && b.reason !== undefined ? { reason: b.reason } : {}),
      usageSeconds: closed ? b.usageSeconds : b.lastUsage,
      heard: b.heard,
      said: b.said,
      delegations: b.delegations,
      title: b.title,
      ...(b.resumedFrom ? { resumedFrom: b.resumedFrom } : {}),
    };
  }
}
