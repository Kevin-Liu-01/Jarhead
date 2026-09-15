import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConversationState, JarheadSessionSummary, LedgerRow, SleepCause } from "@jarhead/protocol";

/** How much of the first heard line becomes a session's title. */
const TITLE_CHARS = 60;

/** How much of a matching line a search hit carries. */
const HIT_CHARS = 500;

/** `search()`'s default and ceiling. */
const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;

/**
 * How many day files the walk reads, newest first. Retention is "forever" on this Mac
 * (ledgerRetentionDays 0), so without a bound every `sessions()` after a change would
 * parse the whole history; two months covers every conversation a Console shows. Older
 * files stay on disk and in `days()` (the Ledger tab still opens them by date).
 */
export const WALK_DAYS = 60;

/** The most rows `readChain` returns: a whole conversation for the Console in one round trip, bounded so one long chain cannot be a 100 MB frame. */
export const CHAIN_ROWS_MAX = 20_000;

/**
 * What the tombstone rows say about one conversation — a chain of sessions linked
 * by `resumedFrom`, named by its root session id. Nothing here is ever the bytes of
 * the conversation: the rows that built it stay where they were written.
 */
export interface ConversationInfo {
  readonly state: ConversationState;
  /** Kevin's own name; "" = the auto title. */
  readonly name: string;
  readonly pinned: boolean;
  /** Set while `state` is "trashed". */
  readonly trashedAt?: number;
  /** `at` of the last tombstone row applied. */
  readonly updatedAt: number;
}

export type SearchHitKind = "heard" | "said" | "request" | "summary";

/** One match of `Ledger.search`: where it sits and what matched. */
export interface LedgerSearchHit {
  readonly sessionId: string;
  /** The root of the session's chain (the conversation). */
  readonly chainId: string;
  /** The conversation's state: a hit in a trashed or archived chain says so, so a rail that hides the chain can hide (or mark) the hit. */
  readonly state: ConversationState;
  readonly at: number;
  readonly kind: SearchHitKind;
  readonly text: string;
}

/**
 * Rows about the record rather than of a session: they sit in whichever day file was
 * today when Kevin acted, and never count as a session's own rows by position. A
 * `conversation.*` / `grant` row belongs to its chain and a `now.*` row to its
 * session (`readSession` places them by that); `ledger.moved`, `agent.hidden` and the
 * memory audit rows (`memory.*`: ids only, written when the memory module learns,
 * forgets or restores — often long after the session they came from closed) belong
 * to nobody's session. So do the automation rows (`automation.*`, `recipe.*`): a 07:10
 * alarm fires while asleep, with no session open, and a row set in a conversation is the
 * record of the schedule, not of that conversation.
 */
const META_TYPES: ReadonlySet<string> = new Set([
  "conversation.trashed", "conversation.restored", "conversation.archived", "conversation.renamed", "conversation.pinned",
  "now.cleared", "now.restored", "ledger.moved", "agent.hidden", "grant",
  "memory.added", "memory.updated", "memory.forgotten", "memory.restored", "memory.run",
  "automation.set", "automation.fired", "automation.state", "automation.missed", "recipe.set", "recipe.trashed", "recipe.restored",
]);

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

/** One `agent.hidden` verdict: hidden or shown, and when Kevin said so (the later row wins). */
interface HiddenMark {
  readonly hidden: boolean;
  readonly at: number;
}

/**
 * The `agent.hidden` rows of one day file OUTSIDE the walk's window, kept while the file
 * is what it was (an old day file never changes; only today's grows). Kevin's "hide this
 * agent" is his decision about the rail, not a session of the last two months: it must
 * not lapse because sixty days passed — the walk's bound is for session attribution.
 */
interface HiddenFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly marks: ReadonlyMap<string, HiddenMark>;
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
  /** The last transport row inside the session: what a client-requested close meant (`sleep:<cause>` for a sleep). */
  lastTransport?: "pause" | "stop" | `sleep:${SleepCause}`;
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
  /** Session id → the root of its chain (itself when it resumed nothing known). */
  readonly roots: ReadonlyMap<string, string>;
  /** The tombstone rows' verdict per chain root, last row by `at` winning. */
  readonly conversations: ReadonlyMap<string, ConversationInfo>;
  /** `conversation.*` and `grant` rows by chain root, in file order. */
  readonly chainRows: ReadonlyMap<string, readonly Position[]>;
  /** `now.cleared` / `now.restored` rows by session, in file order. */
  readonly nowRows: ReadonlyMap<string, readonly Position[]>;
  /** Session → `at` of the clear in force (absent when restored or never cleared). */
  readonly nowCleared: ReadonlyMap<string, number>;
  /** Agent id → hidden and when, last row by `at` inside the window (`hiddenAgents` merges the older files' verdicts). */
  readonly hidden: ReadonlyMap<string, HiddenMark>;
  /** Per file, the id of the session open at each row (what `search` attributes a hit to). */
  readonly owners: ReadonlyMap<string, readonly (string | undefined)[]>;
  /** `conversation.*` / `grant` rows whose chainId names no session the ledger knows: ignored, counted. */
  readonly unresolved: number;
}

/** A tombstone row waiting for the chain roots to be known. */
interface PendingChainRow {
  readonly row: LedgerRow;
  readonly at: Position;
  readonly order: number;
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
  /** `agent.hidden` verdicts per day file outside the walk's window (see HiddenFile); the rows themselves are not kept. */
  private readonly hiddenOutside = new Map<string, HiddenFile>();

  constructor(stateDir: string) {
    this.dir = join(stateDir, "ledger");
    mkdirSync(this.dir, { recursive: true });
  }

  static fileNameFor(at: number): string {
    return `${Ledger.dayFor(at)}.jsonl`;
  }

  /** The local day an instant falls on, YYYY-MM-DD — the day file's name without its extension. */
  static dayFor(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    const walk = this.walk();
    return walk.sessions
      .map((b) => Ledger.summarize(b, walk.conversations.get(walk.roots.get(b.id) ?? b.id)))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The rows of one session: its `session.started` row through its `session.closed`
   * row inclusive (across a midnight file boundary), plus every `stop` / `pause` /
   * `resume` row that lands within it, and any row that names the session wherever
   * it sits (a `resume` written before the started row it announces). Rows inside
   * the span that name another session belong to that one and are left out. The
   * record's own rows come by ownership, never by position: the chain's
   * `conversation.*` / `grant` rows and this session's `now.*` rows are included
   * wherever they sit ("Moved to Trash 14:02 · Restored 14:03" in the Log), and a
   * tombstone for another chain that happened to land inside an open span is not.
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
    const root = walk.roots.get(sessionId) ?? sessionId;
    const owned = [...(walk.chainRows.get(root) ?? []), ...(walk.nowRows.get(sessionId) ?? [])];
    const ownedKeys = new Set(owned.map(Ledger.key));
    const before = owned.filter((p) => p.file < built.start.file).sort(Ledger.byPosition);
    const after = built.end ? owned.filter((p) => p.file > (built.end as Position).file).sort(Ledger.byPosition) : [];
    for (const p of [...outside.filter((p) => p.file < built.start.file), ...before].sort(Ledger.byPosition)) out.push(this.rowsOf(p.file)[p.index]!);
    for (let f = Math.max(0, first); f <= last; f++) {
      const file = files[f]!;
      const rows = this.rowsOf(file);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        if (Ledger.isMeta(row)) {
          if (ownedKeys.has(Ledger.key({ file, index }))) out.push(row);
          continue;
        }
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
    const late = built.end ? [...outside.filter((p) => p.file > (built.end as Position).file), ...after].sort(Ledger.byPosition) : [];
    for (const p of late) out.push(this.rowsOf(p.file)[p.index]!);
    return out;
  }

  /**
   * A whole conversation in one read: the rows of every session of the chain
   * `rootId` names (any member id resolves to the root), oldest session first, each
   * session's rows as `readSession` gives them, the chain's tombstones and grants once.
   * The Console used to read a chain one session at a time, one 5 s round trip each;
   * this is the single request behind `ledger.chain`. Bounded: the newest `max` rows
   * are kept and `truncated` says so. Reads only; nothing here writes.
   */
  readChain(rootId: string, max: number = CHAIN_ROWS_MAX): { rows: LedgerRow[]; truncated: boolean } {
    const walk = this.walk();
    const root = walk.roots.get(rootId) ?? rootId;
    const members = walk.sessions.filter((b) => walk.roots.get(b.id) === root).sort((a, b) => a.startedAt - b.startedAt);
    if (members.length === 0) return { rows: [], truncated: false };
    const rows: LedgerRow[] = [];
    // The chain's own rows (a trash, a grant) come back with every member; they appear once.
    const seenMeta = new Set<string>();
    for (const m of members) {
      for (const row of this.readSession(m.id)) {
        if (Ledger.isMeta(row)) {
          const key = JSON.stringify(row);
          if (seenMeta.has(key)) continue;
          seenMeta.add(key);
        }
        rows.push(row);
      }
    }
    const cap = Math.max(1, Math.floor(max));
    const truncated = rows.length > cap;
    return { rows: truncated ? rows.slice(rows.length - cap) : rows, truncated };
  }

  /** What the tombstone rows say about the conversation `sessionId` belongs to; undefined when no row ever named its chain. */
  conversation(sessionId: string): ConversationInfo | undefined {
    const walk = this.walk();
    const root = walk.roots.get(sessionId);
    return root === undefined ? undefined : walk.conversations.get(root);
  }

  /** The root session of the chain `sessionId` belongs to (itself when it resumed nothing); undefined for an id the ledger never saw start. */
  chainRootOf(sessionId: string): string | undefined {
    return this.walk().roots.get(sessionId);
  }

  /** `at` of the `now.cleared` row in force for the session, or undefined after a `now.restored` (or never cleared). */
  nowClearedAt(sessionId: string): number | undefined {
    return this.walk().nowCleared.get(sessionId);
  }

  /**
   * Agent ids Kevin hid from the rail (`agent.hidden` rows, last one per agent by `at`
   * wins), sorted. Every day file is asked, not only the walk's window: a hide is Kevin's
   * decision about the rail and holds however long ago he made it (a long-lived thread
   * hidden 61 days ago must not reappear at the next daemon start). The files outside the
   * window are read once for their `agent.hidden` lines and remembered by mtime + size.
   */
  hiddenAgents(): string[] {
    const marks = new Map<string, HiddenMark>();
    const apply = (id: string, mark: HiddenMark): void => {
      const last = marks.get(id);
      if (!last || mark.at >= last.at) marks.set(id, mark);
    };
    const files = this.days();
    for (const file of files.slice(0, Math.max(0, files.length - WALK_DAYS))) for (const [id, mark] of this.hiddenIn(file)) apply(id, mark);
    for (const [id, mark] of this.walk().hidden) apply(id, mark);
    const out: string[] = [];
    for (const [id, mark] of marks) if (mark.hidden) out.push(id);
    return out.sort();
  }

  /**
   * The `agent.hidden` verdicts in one day file outside the walk's window. Reuses the parse
   * cache when `read(at)` already opened the file; otherwise scans the text for the rows'
   * type before parsing a line, so an old file costs one read and no retained rows.
   */
  private hiddenIn(file: string): ReadonlyMap<string, HiddenMark> {
    const path = join(this.dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      this.hiddenOutside.delete(file);
      return new Map();
    }
    const hit = this.hiddenOutside.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.marks;
    const marks = new Map<string, HiddenMark>();
    const mark = (row: LedgerRow): void => {
      if (row.type !== "agent.hidden" || typeof row.agentId !== "string") return;
      const last = marks.get(row.agentId);
      if (!last || row.at >= last.at) marks.set(row.agentId, { hidden: row.hidden === true, at: row.at });
    };
    const parsed = this.parsed.get(file);
    if (parsed && parsed.mtimeMs === stat.mtimeMs && parsed.size === stat.size) {
      for (const row of parsed.rows) mark(row);
    } else {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return new Map();
      }
      for (const line of text.split("\n")) {
        if (!line.includes('"agent.hidden"')) continue;
        try {
          const row = JSON.parse(line) as LedgerRow;
          if (row && typeof row === "object" && typeof row.at === "number") mark(row);
        } catch {
          // a malformed line is skipped here as it is everywhere else
        }
      }
    }
    this.hiddenOutside.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, marks });
    return marks;
  }

  /** How many `conversation.*` / `grant` rows named a chain the ledger does not know (a day file moved away, a typo): ignored, never fatal. */
  unresolvedConversationRows(): number {
    return this.walk().unresolved;
  }

  /**
   * Case-insensitive substring search over what was heard and said and over the
   * delegations' requests and summaries, across the LIVE day files only (the trash
   * is not read), newest first. Bounded: `limit` defaults to 50 and never exceeds
   * 200. Reads the walk's parsed cache — a search on a quiet day costs the stats.
   */
  search(query: string, limit: number = SEARCH_DEFAULT_LIMIT): LedgerSearchHit[] {
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (!q) return [];
    // A limit that is not a positive number (0, -3, NaN) is the default, never a cap of 1.
    const asked = Math.floor(Number(limit));
    const cap = Math.min(SEARCH_MAX_LIMIT, asked > 0 ? asked : SEARCH_DEFAULT_LIMIT);
    const walk = this.walk();
    const files = this.days();
    const hits: LedgerSearchHit[] = [];
    for (let f = files.length - 1; f >= 0 && hits.length < cap; f--) {
      const file = files[f]!;
      const rows = this.rowsOf(file);
      const owners = walk.owners.get(file);
      for (let index = rows.length - 1; index >= 0 && hits.length < cap; index--) {
        const row = rows[index]!;
        const found = Ledger.searchable(row);
        if (!found || !found.text.toLowerCase().includes(q)) continue;
        const sessionId = owners?.[index] ?? "";
        const chainId = walk.roots.get(sessionId) ?? sessionId;
        hits.push({ sessionId, chainId, state: walk.conversations.get(chainId)?.state ?? "active", at: row.at, kind: found.kind, text: found.text.length > HIT_CHARS ? found.text.slice(0, HIT_CHARS) : found.text });
      }
    }
    return hits;
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
        // Day files from before 2026-09-13 hold pause / resume rows without a session,
        // and a closed row for a session whose id was already gone says "?": those
        // belong to whichever session is open around them.
        return typeof row.sessionId === "string" && row.sessionId !== "?" ? row.sessionId : undefined;
      default:
        return undefined;
    }
  }

  private static isMeta(row: LedgerRow): boolean {
    return META_TYPES.has(row.type);
  }

  private static key(p: Position): string {
    return `${p.file}:${p.index}`;
  }

  private static byPosition(a: Position, b: Position): number {
    return a.file < b.file ? -1 : a.file > b.file ? 1 : a.index - b.index;
  }

  /** The text a row offers to `search`, and what kind of hit it makes. */
  private static searchable(row: LedgerRow): { kind: SearchHitKind; text: string } | undefined {
    switch (row.type) {
      case "heard":
      case "said": {
        const text = Ledger.flat(row.item?.text);
        return text ? { kind: row.type, text } : undefined;
      }
      case "delegation.created": {
        const text = Ledger.flat(row.delegation?.request);
        return text ? { kind: "request", text } : undefined;
      }
      case "delegation.finished": {
        const text = Ledger.flat(row.summary);
        return text ? { kind: "summary", text } : undefined;
      }
      default:
        return undefined;
    }
  }

  private static flat(text: unknown): string {
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  }

  private static within(b: BuiltSession, at: Position): boolean {
    if (at.file < b.start.file || (at.file === b.start.file && at.index < b.start.index)) return false;
    if (!b.end) return true;
    if (at.file < b.end.file) return true;
    if (at.file > b.end.file) return false;
    return b.endInclusive ? at.index <= b.end.index : at.index < b.end.index;
  }

  /**
   * One pass over the last WALK_DAYS day files, oldest first, attributing rows to the
   * session open around them. Memoised: every file in the window is stat'ed (the parse
   * cache does that anyway) and the pass is redone only when one changed — a
   * `ledger.sessions` request on a quiet day costs the stats, not the rows. A session or
   * tombstone row older than the window is outside the walk (the file itself stays;
   * `read(at)` still opens it); `agent.hidden` rows are the one thing `hiddenAgents`
   * also gathers from the older files — Kevin's hide does not lapse with the window.
   */
  private walk(): Walk {
    const files = this.days().slice(-WALK_DAYS);
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
    const owners = new Map<string, (string | undefined)[]>();
    const pendingChain: PendingChainRow[] = [];
    const pendingNow: PendingChainRow[] = [];
    const nowRows = new Map<string, Position[]>();
    const hidden = new Map<string, { hidden: boolean; at: number }>();
    let order = 0;
    let open: BuiltSession | undefined;
    for (const file of files) {
      const day = file.replace(/\.jsonl$/, "");
      const rows = this.rowsOf(file);
      const owner: (string | undefined)[] = new Array<string | undefined>(rows.length);
      owners.set(file, owner);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        owner[index] = open?.id;
        if (Ledger.isMeta(row)) {
          // The record's own rows: kept aside and placed once every chain root is known.
          const position = { file, index };
          switch (row.type) {
            case "conversation.trashed":
            case "conversation.restored":
            case "conversation.archived":
            case "conversation.renamed":
            case "conversation.pinned":
            case "grant":
              pendingChain.push({ row, at: position, order: order++ });
              break;
            case "now.cleared":
            case "now.restored": {
              if (typeof row.sessionId !== "string") break;
              const list = nowRows.get(row.sessionId);
              if (list) list.push(position);
              else nowRows.set(row.sessionId, [position]);
              pendingNow.push({ row, at: position, order: order++ });
              break;
            }
            case "agent.hidden": {
              if (typeof row.agentId !== "string") break;
              const last = hidden.get(row.agentId);
              if (!last || row.at >= last.at) hidden.set(row.agentId, { hidden: row.hidden === true, at: row.at });
              break;
            }
            default:
              break;
          }
          continue;
        }
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
            owner[index] = row.sessionId;
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
            // A "?" row (day files from before 2026-09-13) is the open session's — unless
            // that one began by losing its predecessor, when the row is as likely the lost
            // one's; then it is left out rather than closing the wrong session with the wrong usage.
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
          case "sleep": {
            // Written before the close it explains: "sleep:said", "sleep:idle", "sleep:dock"…; a pressed
            // Stop's sleep row keeps the stop's word.
            const target = (typeof row.sessionId === "string" ? byId.get(row.sessionId) : undefined) ?? open;
            if (target) target.lastTransport = row.cause === "stop" ? "stop" : `sleep:${row.cause}`;
            break;
          }
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

    // Chains: every session resolves to its root through the resumedFrom links. A link
    // to a session the ledger does not know (its day file moved away) ends the chain
    // there — the last known session is the root — and a loop, which no engine writes,
    // is cut by the visited set rather than followed.
    const roots = new Map<string, string>();
    for (const b of sessions) {
      const seen = new Set<string>([b.id]);
      let cur = b;
      for (;;) {
        const parent = cur.resumedFrom ? byId.get(cur.resumedFrom) : undefined;
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        cur = parent;
      }
      roots.set(b.id, cur.id);
    }

    // Tombstones: last row by `at` wins (file order breaks ties), applied per chain root.
    // A chainId the ledger cannot resolve is counted and ignored — never fatal.
    const conversations = new Map<string, ConversationInfo>();
    const chainRows = new Map<string, Position[]>();
    let unresolved = 0;
    pendingChain.sort((a, b) => a.row.at - b.row.at || a.order - b.order);
    for (const { row, at } of pendingChain) {
      const chainId = (row as { chainId?: unknown }).chainId;
      const root = typeof chainId === "string" ? roots.get(chainId) : undefined;
      if (root === undefined) {
        unresolved++;
        continue;
      }
      const list = chainRows.get(root);
      if (list) list.push(at);
      else chainRows.set(root, [at]);
      const prev = conversations.get(root) ?? { state: "active" as ConversationState, name: "", pinned: false, updatedAt: row.at };
      switch (row.type) {
        case "conversation.trashed":
          conversations.set(root, { ...prev, state: "trashed", trashedAt: row.at, updatedAt: row.at });
          break;
        case "conversation.restored": {
          const { trashedAt: _gone, ...rest } = prev;
          conversations.set(root, { ...rest, state: "active", updatedAt: row.at });
          break;
        }
        case "conversation.archived": {
          const { trashedAt: _gone, ...rest } = prev;
          conversations.set(root, { ...rest, state: "archived", updatedAt: row.at });
          break;
        }
        case "conversation.renamed":
          conversations.set(root, { ...prev, name: typeof row.name === "string" ? row.name.trim() : "", updatedAt: row.at });
          break;
        case "conversation.pinned":
          conversations.set(root, { ...prev, pinned: row.pinned === true, updatedAt: row.at });
          break;
        default:
          // A grant is the chain's row for the Log; it says nothing about the conversation's state.
          break;
      }
    }
    for (const list of chainRows.values()) list.sort(Ledger.byPosition);

    // The Now stream's clear per session: the last of cleared / restored by `at` decides.
    const nowCleared = new Map<string, number>();
    pendingNow.sort((a, b) => a.row.at - b.row.at || a.order - b.order);
    for (const { row } of pendingNow) {
      const sessionId = (row as { sessionId?: unknown }).sessionId as string;
      if (row.type === "now.cleared") nowCleared.set(sessionId, row.at);
      else nowCleared.delete(sessionId);
    }

    this.walked = { signature, sessions, named, roots, conversations, chainRows, nowRows, nowCleared, hidden, owners, unresolved };
    return this.walked;
  }

  /** "paused" / "stopped" / "sleep:<cause>" for a close the engine asked for after that row; the server's word otherwise. */
  private static closeReason(reason: string, lastTransport: BuiltSession["lastTransport"]): string {
    if (!CLIENT_CLOSE_REASONS.has(reason) || !lastTransport) return reason;
    if (lastTransport === "pause") return "paused";
    if (lastTransport === "stop") return "stopped";
    return lastTransport;
  }

  private static title(text: string): string {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > TITLE_CHARS ? flat.slice(0, TITLE_CHARS).trimEnd() : flat;
  }

  /** A summary; `conv` is the chain's verdict from the tombstone rows, stamped on every session of the chain. */
  private static summarize(b: BuiltSession, conv: ConversationInfo | undefined): JarheadSessionSummary {
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
      ...(conv
        ? {
            state: conv.state,
            pinned: conv.pinned,
            ...(conv.name ? { name: conv.name } : {}),
            ...(conv.state === "trashed" && conv.trashedAt !== undefined ? { trashedAt: conv.trashedAt } : {}),
          }
        : {}),
    };
  }
}
