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
 * How many day files `sessions()` lists, newest first. Retention is "forever" on this Mac
 * (ledgerRetentionDays 0), so the rail would otherwise carry the whole history; two months
 * covers every conversation a Console shows. A pinned conversation is listed at any age.
 * Kevin's decisions (`conversation.*`, `agent.hidden`, `now.*`), the chains and the sessions
 * of every day are read from EVERY day file: a pin, a Move to Trash or a hide never lapses
 * because sixty days passed, and the Trash's guard sees every day's sessions. Older files
 * stay on disk and in `days()` (the Ledger tab still opens them by date).
 */
export const WALK_DAYS = 60;

/** The most rows `readChain` returns: a whole conversation for the Console in one round trip, bounded so one long chain cannot be a 100 MB frame. */
export const CHAIN_ROWS_MAX = 20_000;

/**
 * How many bytes of day files one search reads, newest first. A year of heavy use is ~100 MB;
 * a search past this bound stops and says where it stopped (`searchPage(…).older`), and the
 * next page goes on from there. The live daemon never blocks on the whole history.
 */
export const SEARCH_PAGE_BYTES = 32 * 1024 * 1024;

/**
 * A day file outside the window is stat'ed at most this often. Old days change only when
 * a row with an old `at` is appended (this instance's own appends recheck at once) or a day
 * moves to or from the Trash (the listing changes); the window's files are stat'ed on every
 * read, as before.
 */
const OLD_RECHECK_MS = 2_000;

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
  /** Set while `state` is "trashed": when Kevin trashed it (a carried row keeps the original instant). */
  readonly trashedAt?: number;
  /** When the last tombstone row applied was decided. */
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

/** One page of a search: the hits, and the day to go on before when the page's byte bound stopped it (absent: nothing older is unread). */
export interface LedgerSearchPage {
  readonly hits: LedgerSearchHit[];
  readonly older?: string;
}

export interface SearchPageOptions {
  readonly limit?: number;
  /** Search only the days before this one (YYYY-MM-DD, exclusive): the `older` of the previous page. */
  readonly before?: string;
  /** Bytes of day files this page may read (at least one file is always read); default SEARCH_PAGE_BYTES. */
  readonly maxBytes?: number;
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
 * The record's rows the walk reads: Kevin's decisions and the moves (a move's `lineage`).
 * The memory and automation rows are the record of other modules; the walk never reads
 * them, so a day file's digest does not keep them.
 */
const WALK_META_TYPES: ReadonlySet<string> = new Set([
  "conversation.trashed", "conversation.restored", "conversation.archived", "conversation.renamed", "conversation.pinned",
  "now.cleared", "now.restored", "ledger.moved", "agent.hidden", "grant",
]);

/** The rows the walk reads whole; every other row is counted (heard, said, a delegation) or only takes its place. */
const WHOLE_TYPES: ReadonlySet<string> = new Set(["session.started", "session.closed", "pause", "resume", "stop", "sleep", ...WALK_META_TYPES]);
const COUNTED_TYPES: ReadonlySet<string> = new Set(["heard", "said", "delegation.created"]);

/** A row's type from the line itself (`{"at":…,"type":"…"` — how every row is written), so most lines are never parsed. */
const TYPE_AFTER_AT = /^\{"at":[-+.\deE]+,"type":"([^"\\]*)"/;
const TYPE_FIRST = /^\{"type":"([^"\\]*)"/;

/**
 * The server's word for a close the engine asked for (`session.close` answered), and
 * ours for one it had to force (`terminate()` after the close deadline). Neither says
 * why; the transport row before it does — a `pause` or a pressed `stop`.
 */
const CLIENT_CLOSE_REASONS = new Set(["close_requested", "client_closed"]);

/**
 * A parsed day file, valid while the file on disk has this mtime and size. `rows[i]` is
 * the i-th non-blank line — undefined when that line does not parse (a torn last line) —
 * so a position means the same line to every reader.
 */
interface ParsedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly rows: readonly (LedgerRow | undefined)[];
}

/** A row the walk reads whole, at its position. */
interface RowMark {
  readonly index: number;
  readonly row: LedgerRow;
}

/** The counted rows between two row marks: what the walk adds to the session open there, and the first heard line's title. */
interface CountMark {
  readonly heard: number;
  readonly said: number;
  readonly delegations: number;
  readonly title: string;
}

/**
 * What one day file holds for the walk, kept while the file is what it was: its whole rows
 * and the counts between them. Never the file's rows: a year of history costs its marks,
 * and the parsed rows live only in the bounded cache (`rowsOf`).
 */
interface Digest {
  readonly mtimeMs: number;
  readonly size: number;
  readonly marks: readonly (RowMark | CountMark)[];
  /** When the file was last stat'ed (Date.now). */
  checkedAt: number;
}

/** Where a row sits in the ledger: which day file, which line. */
interface Position {
  readonly file: string;
  readonly index: number;
}

/** The session open at each line of a file, as change points: `ids[k]` from line `idx[k]` on. */
interface Owners {
  readonly idx: number[];
  readonly ids: (string | undefined)[];
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

/** A decision row and where it sits: what a move of its day would take away. */
interface Decided {
  readonly row: LedgerRow;
  readonly at: Position;
}

/** The three things a conversation's tombstones decide, each by its own last row. */
type ConversationAttr = "state" | "name" | "pinned";

/**
 * A conversation's state decision in force: when Kevin made it (a carried row keeps that
 * instant), then its place in the walk's order, which breaks a tie (higher is newer).
 */
interface StateMark {
  readonly state: ConversationState;
  readonly decidedAt: number;
  readonly rank: number;
}

/**
 * What a ledger day's move keeps: how many decisions were carried into today's file, and the
 * lineage the move's own `ledger.moved` row records — per id that continues a conversation,
 * the session ids that leave (or left earlier) whose conversation it continues.
 */
export interface CarryResult {
  readonly rows: number;
  readonly lineage?: Readonly<Record<string, readonly string[]>>;
}

/** One pass over the ledger, valid while no day file changed. */
interface Walk {
  /** Every (file, mtime, size) the walk read, in order — the cache key. */
  readonly signature: string;
  /** Every session of every day file, oldest first. */
  readonly sessions: readonly BuiltSession[];
  readonly byId: ReadonlyMap<string, BuiltSession>;
  /** What `sessions()` lists, `readSession` and `readChain` read: the window's sessions and every pinned conversation's. */
  readonly listed: ReadonlySet<string>;
  /** Sessions by the day file their started row is in. */
  readonly byDay: ReadonlyMap<string, readonly BuiltSession[]>;
  /** Rows that name a session (`sessionId`), by session, wherever they sit. */
  readonly named: ReadonlyMap<string, readonly Position[]>;
  /** Session id → the root of its chain (itself when it resumed nothing known). */
  readonly roots: ReadonlyMap<string, string>;
  /** Chain root → its sessions, oldest first. */
  readonly members: ReadonlyMap<string, readonly BuiltSession[]>;
  /** The tombstone rows' verdict per chain root, last row by `at` winning. */
  readonly conversations: ReadonlyMap<string, ConversationInfo>;
  /** `conversation.*` and `grant` rows by chain root, in file order. */
  readonly chainRows: ReadonlyMap<string, readonly Position[]>;
  /** `now.cleared` / `now.restored` rows by session, in file order. */
  readonly nowRows: ReadonlyMap<string, readonly Position[]>;
  /** Session → when the clear in force was made (absent when restored or never cleared). */
  readonly nowCleared: ReadonlyMap<string, number>;
  /** Agent id → hidden and when, last row by `at`. */
  readonly hidden: ReadonlyMap<string, { readonly hidden: boolean; readonly at: number }>;
  /** Per file, the session open at each line (what `search` attributes a hit to). */
  readonly owners: ReadonlyMap<string, Owners>;
  /** `conversation.*` / `grant` rows whose chainId names no session the ledger knows: ignored, counted. */
  readonly unresolved: number;
  /** The rows in force — what a day's move would undo (`carry`): per chain root and attribute, per unresolved chainId and attribute, per agent, per session. */
  readonly force: {
    readonly chains: ReadonlyMap<string, ReadonlyMap<ConversationAttr, Decided>>;
    readonly unresolved: ReadonlyMap<string, ReadonlyMap<ConversationAttr, Decided>>;
    readonly hidden: ReadonlyMap<string, Decided>;
    readonly now: ReadonlyMap<string, Decided>;
  };
  /** The state decision in force per chain root, and per unresolved chainId (its own rows). */
  readonly stateOf: ReadonlyMap<string, StateMark>;
  /**
   * Lineage: a session id no live day file holds → the ids that continue its conversation
   * (a session that resumed from it, a part of its chain that stayed when its day moved) →
   * the day files that say so. Its verdict follows theirs (`trashedSessionIds`).
   */
  readonly heirs: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /** `trashedSessionIds()`, computed once per walk. */
  trashed?: ReadonlySet<string>;
}

/** A lineage entry of a `ledger.moved` row, waiting for the walk to know which ids are gone. */
interface PendingLineage {
  readonly from: string;
  readonly heir: string;
  readonly file: string;
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
  /** The parsed-row cache's bound, in bytes of day files (the newest read always stays). */
  static readonly PARSED_BYTES_MAX = 4 * 1024 * 1024;

  readonly dir: string;
  private readonly listeners = new Set<(row: LedgerRow) => void>();
  /** Parsed day files keyed by file name, least recently read first, invalidated by mtime + size (an append changes both). */
  private readonly parsed = new Map<string, ParsedFile>();
  private parsedTotal = 0;
  /** Every day file's digest, invalidated by mtime + size. */
  private readonly digests = new Map<string, Digest>();
  /** Day files this instance appended to since their last stat. */
  private readonly dirty = new Set<string>();
  /** The last walk over every file, reused while every file's mtime + size is what it read. */
  private walked?: Walk;

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
    const file = Ledger.fileNameFor(row.at);
    appendFileSync(join(this.dir, file), `${JSON.stringify(row)}\n`);
    this.dirty.add(file);
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
    return this.rowsOf(file).filter((r): r is LedgerRow => r !== undefined);
  }

  days(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort();
  }

  /**
   * Jarhead's own Live sessions, newest first: one summary per `session.started` row in
   * the newest WALK_DAYS day files, and every session of a pinned conversation however
   * old. A session may cross midnight (its closed row is in the next file); one with no
   * closed row anywhere is open — unless a later session started, in which case it was
   * lost at that moment, billed what its last `pause` row said (else nothing). A close the
   * engine asked for (`close_requested`, or `client_closed` when it had to force it) is
   * reported as what Kevin did — "paused" after a `pause` row, "stopped" after a pressed
   * `stop` — since the server's word says nothing about why; any other reason (idle,
   * connection_lost, …) is kept.
   */
  sessions(): JarheadSessionSummary[] {
    const walk = this.walk();
    return walk.sessions
      .filter((b) => walk.listed.has(b.id))
      .map((b) => this.summaryOf(walk, b))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Every session whose started row is in that day's file, at any age (the Trash's guard asks this). */
  sessionsOn(day: string): JarheadSessionSummary[] {
    const walk = this.walk();
    return (walk.byDay.get(`${day}.jsonl`) ?? []).map((b) => this.summaryOf(walk, b));
  }

  /** Sessions with no closed row and no later start, in any day file: the ledger's own word for open. */
  unclosedSessionIds(): string[] {
    return this.walk()
      .sessions.filter((b) => b.closedAt === undefined)
      .map((b) => b.id);
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
   * Only a listed session reads (see `sessions()`).
   */
  readSession(sessionId: string): LedgerRow[] {
    const walk = this.walk();
    const built = walk.listed.has(sessionId) ? walk.byId.get(sessionId) : undefined;
    if (!built) return [];
    const out: LedgerRow[] = [];
    const push = (row: LedgerRow | undefined): void => {
      if (row) out.push(row);
    };
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
    for (const p of [...outside.filter((p) => p.file < built.start.file), ...before].sort(Ledger.byPosition)) push(this.rowsOf(p.file)[p.index]);
    for (let f = Math.max(0, first); f <= last; f++) {
      const file = files[f]!;
      const rows = this.rowsOf(file);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (!row) continue;
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
    for (const p of late) push(this.rowsOf(p.file)[p.index]);
    return out;
  }

  /**
   * A whole conversation in one read: the rows of every listed session of the chain
   * `rootId` names (any member id resolves to the root), oldest session first, each
   * session's rows as `readSession` gives them, the chain's tombstones and grants once.
   * The Console used to read a chain one session at a time, one 5 s round trip each;
   * this is the single request behind `ledger.chain`. Bounded: the newest `max` rows
   * are kept and `truncated` says so. Reads only; nothing here writes.
   */
  readChain(rootId: string, max: number = CHAIN_ROWS_MAX): { rows: LedgerRow[]; truncated: boolean } {
    const walk = this.walk();
    const root = walk.roots.get(rootId) ?? rootId;
    const members = (walk.members.get(root) ?? []).filter((b) => walk.listed.has(b.id));
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

  /** The root session of the chain `sessionId` belongs to (itself when it resumed nothing); undefined for an id no live day file saw start. */
  chainRootOf(sessionId: string): string | undefined {
    return this.walk().roots.get(sessionId);
  }

  /** Every known session's chain root, in one read (a loop over sessions asks this once, not per session). */
  chainRoots(): ReadonlyMap<string, string> {
    return this.walk().roots;
  }

  /**
   * The session ids whose conversation is in the Trash: what memory hides (decision D5;
   * memory names what it learned by the chain's root). Every member of a trashed chain; and
   * every id no live day file holds a session of any more (a moved day took it away) whose
   * newest state decision says trashed — its own rows, or the newest of the conversations
   * that continue it (`heirs`: a session that resumed from it, a part of its chain that
   * stayed). So a Restore of what continues a conversation brings back what was learned
   * from it, whichever days moved before or after; moving a day changes nothing here.
   */
  trashedSessionIds(): ReadonlySet<string> {
    const walk = this.walk();
    if (walk.trashed) return walk.trashed;
    const out = new Set<string>();
    for (const [root, conv] of walk.conversations) {
      if (conv.state !== "trashed") continue;
      for (const b of walk.members.get(root) ?? []) out.add(b.id);
    }
    const memo = new Map<string, StateMark | null>();
    const newest = (id: string, visiting: Set<string>): StateMark | undefined => {
      const known = memo.get(id);
      if (known !== undefined) return known ?? undefined;
      let top = walk.stateOf.get(id);
      if (visiting.has(id)) return top;
      visiting.add(id);
      for (const heir of walk.heirs.get(id)?.keys() ?? []) {
        const root = walk.roots.get(heir);
        const mark = root !== undefined ? walk.stateOf.get(root) : newest(heir, visiting);
        if (mark && (!top || Ledger.newer(mark, top))) top = mark;
      }
      visiting.delete(id);
      memo.set(id, top ?? null);
      return top;
    };
    const gone = new Set<string>([...walk.heirs.keys(), ...walk.stateOf.keys()].filter((id) => !walk.byId.has(id)));
    for (const id of gone) if (newest(id, new Set())?.state === "trashed") out.add(id);
    walk.trashed = out;
    return out;
  }

  /** `at` of the `now.cleared` row in force for the session (when it was decided), or undefined after a `now.restored` (or never cleared). */
  nowClearedAt(sessionId: string): number | undefined {
    return this.walk().nowCleared.get(sessionId);
  }

  /**
   * Agent ids Kevin hid from the rail (`agent.hidden` rows, last one per agent by `at`
   * wins), sorted. Every day file is asked: a hide is Kevin's decision about the rail and
   * holds however long ago he made it (a long-lived thread hidden 61 days ago must not
   * reappear at the next daemon start). An old file is read once for its marks.
   */
  hiddenAgents(): string[] {
    const out: string[] = [];
    for (const [id, mark] of this.walk().hidden) if (mark.hidden) out.push(id);
    return out.sort();
  }

  /** How many `conversation.*` / `grant` rows named a chain the ledger does not know (a day file moved away, a typo): ignored, never fatal. */
  unresolvedConversationRows(): number {
    return this.walk().unresolved;
  }

  /**
   * Before a day file moves to the Trash: the decisions in force that the move would undo
   * are carried into today's file as rows marked `carried: true`, with `decidedAt` the
   * instant Kevin decided (append-only; the originals move with their day). A decision in
   * force is the last row for its key — a conversation's state, name or pin; an agent's
   * hide; a session's Now clear. A conversation whose root (or a link) sits on that day
   * splits there: each part that stays gets the conversation's decisions under its own
   * root, unless a row that stays already reaches it.
   *
   * The move also keeps the lineage memory reads by (`trashedSessionIds`), returned for the
   * move's own `ledger.moved` row: each part that stays continues the sessions above it that
   * leave; a session that leaves with nothing of its own after it follows its chain's root;
   * and a lineage only that day said is said again. Nothing is written for it unless the
   * move happens.
   */
  carry(day: string, at: number): CarryResult {
    const walk = this.walk();
    const file = `${day}.jsonl`;
    const out: LedgerRow[] = [];
    const lineage = new Map<string, Set<string>>();
    const link = (from: string, heir: string): void => {
      if (from === heir) return;
      const set = lineage.get(heir) ?? new Set<string>();
      set.add(from);
      lineage.set(heir, set);
    };
    // The copy is the row as written plus `carried` and `decidedAt`, which the protocol's row types do not
    // name (readers that do not know them read the decision as it was; this walk reads `decidedAt`).
    const stamp = (row: LedgerRow, chainId?: string): LedgerRow => {
      const copy: Record<string, unknown> = { ...row, at, carried: true, decidedAt: Ledger.decidedAt(row) };
      if (chainId !== undefined) copy["chainId"] = chainId;
      return copy as unknown as LedgerRow;
    };
    const none: ReadonlyMap<ConversationAttr, Decided> = new Map();
    for (const [root, members] of walk.members) {
      const attrs = walk.force.chains.get(root) ?? none;
      if (attrs.size === 0 && !members.some((b) => b.start.file === file)) continue;
      const alive = new Set(members.filter((b) => b.start.file !== file).map((b) => b.id));
      const partRoot = (id: string): string => {
        let cur = walk.byId.get(id);
        const seen = new Set<string>();
        while (cur && cur.resumedFrom && alive.has(cur.resumedFrom) && !seen.has(cur.resumedFrom)) {
          seen.add(cur.id);
          cur = walk.byId.get(cur.resumedFrom);
        }
        return cur?.id ?? id;
      };
      const parts = [...new Set(members.filter((b) => alive.has(b.id)).map((b) => partRoot(b.id)))];
      // Lineage: a part continues every session that leaves between it and the next session that
      // stays (its chain's root among them); a session that leaves with no part after it follows the root.
      const continued = new Set<string>();
      for (const part of parts) {
        let cur = walk.byId.get(part);
        const seen = new Set<string>([part]);
        while (cur?.resumedFrom && !alive.has(cur.resumedFrom) && !seen.has(cur.resumedFrom)) {
          const up = walk.byId.get(cur.resumedFrom);
          if (!up) break;
          seen.add(up.id);
          continued.add(up.id);
          link(up.id, part);
          cur = up;
        }
      }
      for (const b of members) if (!alive.has(b.id) && !continued.has(b.id)) link(b.id, root);
      for (const d of attrs.values()) {
        const chainId = (d.row as { chainId?: unknown }).chainId;
        if (parts.length === 0) {
          // Every session of the chain is on that day: the decision moves with them and comes back with them; a copy
          // under the root keeps it for what reads by id (memory) — also one that named another of its sessions.
          if (d.at.file === file || chainId !== root) out.push(stamp(d.row, root));
          continue;
        }
        const reached = d.at.file !== file && typeof chainId === "string" && alive.has(chainId) ? partRoot(chainId) : undefined;
        for (const part of parts) if (part !== reached) out.push(stamp(d.row, part));
      }
    }
    // A lineage only that day said (the started row of a session that resumed from a gone one, an
    // earlier move's row) is said again by this move's row.
    for (const [from, heirs] of walk.heirs) {
      for (const [heir, files] of heirs) if (files.size === 1 && files.has(file)) link(from, heir);
    }
    for (const attrs of walk.force.unresolved.values()) for (const d of attrs.values()) if (d.at.file === file) out.push(stamp(d.row));
    for (const d of walk.force.hidden.values()) if (d.at.file === file) out.push(stamp(d.row));
    for (const d of walk.force.now.values()) if (d.at.file === file) out.push(stamp(d.row));
    for (const row of out) this.append(row);
    if (lineage.size === 0) return { rows: out.length };
    const record: Record<string, string[]> = {};
    for (const heir of [...lineage.keys()].sort()) record[heir] = [...(lineage.get(heir) as Set<string>)].sort();
    return { rows: out.length, lineage: record };
  }

  /**
   * Case-insensitive substring search over what was heard and said and over the
   * delegations' requests and summaries, across the LIVE day files only (the trash
   * is not read), newest first. Bounded: `limit` defaults to 50 and never exceeds
   * 200, and one search reads at most SEARCH_PAGE_BYTES of day files (`searchPage`
   * says where to go on).
   */
  search(query: string, limit: number = SEARCH_DEFAULT_LIMIT): LedgerSearchHit[] {
    return this.searchPage(query, { limit }).hits;
  }

  /**
   * One page of `search`: the day files before `before`, newest first, until `maxBytes`
   * of them were read or `limit` hits found. A line is parsed only when its raw text holds
   * every word of the query (JSON-escaped, lowercased), so a rare word costs the reads and
   * no rows are kept. `older` is the day to pass as the next page's `before` when the byte
   * bound stopped the page with older files unread.
   */
  searchPage(query: string, opts: SearchPageOptions = {}): LedgerSearchPage {
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (!q) return { hits: [] };
    // A limit that is not a positive number (0, -3, NaN) is the default, never a cap of 1.
    const asked = Math.floor(Number(opts.limit ?? SEARCH_DEFAULT_LIMIT));
    const cap = Math.min(SEARCH_MAX_LIMIT, asked > 0 ? asked : SEARCH_DEFAULT_LIMIT);
    const budget = Math.max(1, Math.floor(Number(opts.maxBytes ?? SEARCH_PAGE_BYTES)) || SEARCH_PAGE_BYTES);
    // Every word as the day file spells it: JSON escapes quotes, backslashes and control characters.
    const needles = [...new Set(q.split(" "))].map((w) => JSON.stringify(w).slice(1, -1)).sort((a, b) => b.length - a.length);
    const has = (lower: string): boolean => needles.every((n) => lower.includes(n));
    const walk = this.walk();
    const files = this.days();
    const hits: LedgerSearchHit[] = [];
    let f = files.length - 1;
    if (opts.before) while (f >= 0 && files[f]!.slice(0, -".jsonl".length) >= opts.before) f--;
    let read = 0;
    let lastRead: string | undefined;
    let stopped = false;
    for (; f >= 0 && hits.length < cap; f--) {
      if (read >= budget) {
        stopped = true;
        break;
      }
      const file = files[f]!;
      let text: string;
      try {
        text = readFileSync(join(this.dir, file), "utf8");
      } catch {
        continue;
      }
      read += text.length;
      lastRead = file.slice(0, -".jsonl".length);
      if (!has(text.toLowerCase())) continue;
      const matches: { index: number; line: string }[] = [];
      let index = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const i = index++;
        if (has(line.toLowerCase())) matches.push({ index: i, line });
      }
      const owners = walk.owners.get(file);
      for (let k = matches.length - 1; k >= 0 && hits.length < cap; k--) {
        const row = Ledger.parseLine(matches[k]!.line);
        if (!row) continue;
        const found = Ledger.searchable(row);
        if (!found || !found.text.toLowerCase().includes(q)) continue;
        const sessionId = (owners ? Ledger.ownerAt(owners, matches[k]!.index) : undefined) ?? "";
        const chainId = walk.roots.get(sessionId) ?? sessionId;
        hits.push({ sessionId, chainId, state: walk.conversations.get(chainId)?.state ?? "active", at: row.at, kind: found.kind, text: found.text.length > HIT_CHARS ? found.text.slice(0, HIT_CHARS) : found.text });
      }
    }
    return stopped && lastRead !== undefined ? { hits, older: lastRead } : { hits };
  }

  /** Bytes of day files the parsed-row cache holds (bounded by PARSED_BYTES_MAX, the newest read excepted). */
  parsedBytes(): number {
    return this.parsedTotal;
  }

  // ------------------------------------------------------------------ internals

  /** A day file's rows by line (see ParsedFile), through a cache bounded by bytes and kept least-recently-read first. */
  private rowsOf(file: string): readonly (LedgerRow | undefined)[] {
    const path = join(this.dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      this.forget(file);
      return [];
    }
    const hit = this.parsed.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      this.parsed.delete(file);
      this.parsed.set(file, hit);
      return hit.rows;
    }
    this.forget(file);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const rows: (LedgerRow | undefined)[] = [];
    for (const line of text.split("\n")) if (line.trim()) rows.push(Ledger.parseLine(line));
    this.parsed.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
    this.parsedTotal += stat.size;
    for (const [name, p] of this.parsed) {
      if (this.parsedTotal <= Ledger.PARSED_BYTES_MAX || name === file) break;
      this.parsed.delete(name);
      this.parsedTotal -= p.size;
    }
    return rows;
  }

  private forget(file: string): void {
    const p = this.parsed.get(file);
    if (!p) return;
    this.parsed.delete(file);
    this.parsedTotal -= p.size;
  }

  /** One line as a row, or undefined when it does not parse to an object (a torn last line). */
  private static parseLine(line: string): LedgerRow | undefined {
    try {
      const row = JSON.parse(line) as unknown;
      return row && typeof row === "object" ? (row as LedgerRow) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The digest of a day file (see Digest), re-read when its mtime or size moved. A file in
   * the window (`recheck`) is stat'ed every time; an older one when this instance appended
   * to it or OLD_RECHECK_MS passed.
   */
  private digestOf(file: string, recheck: boolean, now: number): Digest | undefined {
    const hit = this.digests.get(file);
    if (hit && !recheck && !this.dirty.has(file) && now - hit.checkedAt < OLD_RECHECK_MS) return hit;
    const path = join(this.dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      this.digests.delete(file);
      return undefined;
    }
    this.dirty.delete(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      hit.checkedAt = now;
      return hit;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      this.digests.delete(file);
      return undefined;
    }
    const digest: Digest = { mtimeMs: stat.mtimeMs, size: stat.size, marks: Ledger.digest(text), checkedAt: now };
    this.digests.set(file, digest);
    return digest;
  }

  /**
   * A day file's marks: every row the walk reads whole, parsed, at its line; between them
   * the heard / said / delegation rows counted from the line's type alone, a heard line
   * parsed only until it gives the stretch a title. A line whose type the prefix does not
   * show is parsed; one that does not parse holds its place and counts for nothing.
   */
  private static digest(text: string): (RowMark | CountMark)[] {
    const marks: (RowMark | CountMark)[] = [];
    let heard = 0;
    let said = 0;
    let delegations = 0;
    let title = "";
    const flush = (): void => {
      if (heard || said || delegations) marks.push({ heard, said, delegations, title });
      heard = 0;
      said = 0;
      delegations = 0;
      title = "";
    };
    let index = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const i = index++;
      let type = TYPE_AFTER_AT.exec(line)?.[1] ?? TYPE_FIRST.exec(line)?.[1];
      let row: LedgerRow | undefined;
      if (type === undefined) {
        row = Ledger.parseLine(line);
        type = typeof row?.type === "string" ? row.type : undefined;
        if (type === undefined) continue;
      }
      if (COUNTED_TYPES.has(type)) {
        // A torn line is skipped by the parse, as everywhere else: a whole row always ends its object.
        if (!line.trimEnd().endsWith("}")) continue;
        if (type === "heard") {
          if (!title) {
            row ??= Ledger.parseLine(line);
            if (!row) continue;
            if (row.type === "heard" && row.item) title = Ledger.title(row.item.text);
          }
          heard++;
        } else if (type === "said") said++;
        else delegations++;
        continue;
      }
      if (!WHOLE_TYPES.has(type)) continue;
      row ??= Ledger.parseLine(line);
      if (!row || row.type !== type) continue;
      flush();
      marks.push({ index: i, row });
    }
    flush();
    return marks;
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

  /** When a decision was made: a carried row says so, any other row was written then. */
  private static decidedAt(row: LedgerRow): number {
    const d = (row as { decidedAt?: unknown }).decidedAt;
    return typeof d === "number" && Number.isFinite(d) ? d : row.at;
  }

  /** Whether decision `a` was made after `b`: by the instant Kevin decided, a carried copy of an old decision never outranking a newer one. */
  private static newer(a: StateMark, b: StateMark): boolean {
    return a.decidedAt !== b.decidedAt ? a.decidedAt > b.decidedAt : a.rank > b.rank;
  }

  private static key(p: Position): string {
    return `${p.file}:${p.index}`;
  }

  private static byPosition(a: Position, b: Position): number {
    return a.file < b.file ? -1 : a.file > b.file ? 1 : a.index - b.index;
  }

  /** The session open at line `index` (the last change point at or before it). */
  private static ownerAt(o: Owners, index: number): string | undefined {
    let lo = 0;
    let hi = o.idx.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (o.idx[mid]! <= index) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k < 0 ? undefined : o.ids[k];
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
   * One pass over every day file's digest, oldest first, attributing rows to the session
   * open around them. Memoised: the window's files are stat'ed on every call (older ones
   * every OLD_RECHECK_MS, or at once after this instance appended to them) and the pass is
   * redone only when one changed — a `ledger.sessions` request on a quiet day costs the
   * stats, not the rows. The pass reads marks, never rows: a year of history is a few
   * thousand of them.
   */
  private walk(): Walk {
    const files = this.days();
    const windowStart = Math.max(0, files.length - WALK_DAYS);
    const now = Date.now();
    const digests: (Digest | undefined)[] = [];
    const parts: string[] = [];
    for (let f = 0; f < files.length; f++) {
      const d = this.digestOf(files[f]!, f >= windowStart, now);
      digests.push(d);
      parts.push(d ? `${files[f]}:${d.mtimeMs}:${d.size}` : `${files[f]}:gone`);
    }
    if (this.digests.size > files.length) {
      const live = new Set(files);
      for (const name of [...this.digests.keys()]) if (!live.has(name)) this.digests.delete(name);
    }
    const signature = parts.join("\n");
    if (this.walked && this.walked.signature === signature) return this.walked;

    const sessions: BuiltSession[] = [];
    const byId = new Map<string, BuiltSession>();
    const byDay = new Map<string, BuiltSession[]>();
    const named = new Map<string, Position[]>();
    const owners = new Map<string, Owners>();
    const pendingChain: PendingChainRow[] = [];
    const pendingNow: PendingChainRow[] = [];
    const pendingLineage: PendingLineage[] = [];
    const nowRows = new Map<string, Position[]>();
    const hidden = new Map<string, { hidden: boolean; at: number }>();
    const hiddenForce = new Map<string, Decided>();
    let order = 0;
    let open: BuiltSession | undefined;
    for (let f = 0; f < files.length; f++) {
      const digest = digests[f];
      if (!digest) continue;
      const file = files[f]!;
      const day = file.replace(/\.jsonl$/, "");
      const owner: Owners = { idx: [], ids: [] };
      owners.set(file, owner);
      const setOwner = (index: number, id: string | undefined): void => {
        const n = owner.ids.length;
        if (n > 0 && owner.ids[n - 1] === id) return;
        owner.idx.push(index);
        owner.ids.push(id);
      };
      setOwner(0, open?.id);
      for (const mark of digest.marks) {
        if (!("row" in mark)) {
          if (open) {
            open.heard += mark.heard;
            open.said += mark.said;
            open.delegations += mark.delegations;
            if (!open.title && mark.title) open.title = mark.title;
          }
          continue;
        }
        const { row, index } = mark;
        const position = { file, index };
        setOwner(index, row.type === "session.started" ? row.sessionId : open?.id);
        if (Ledger.isMeta(row)) {
          // The record's own rows: kept aside and placed once every chain root is known.
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
              if (!last || row.at >= last.at) {
                hidden.set(row.agentId, { hidden: row.hidden === true, at: row.at });
                hiddenForce.set(row.agentId, { row, at: position });
              }
              break;
            }
            case "ledger.moved": {
              // A move's lineage (`carry`): heir → the ids whose conversation it continues. Not in the protocol's row type.
              const said = (row as { lineage?: unknown }).lineage;
              if (!said || typeof said !== "object" || Array.isArray(said)) break;
              for (const [heir, froms] of Object.entries(said as Record<string, unknown>)) {
                if (!Array.isArray(froms)) continue;
                for (const from of froms) if (typeof from === "string" && from !== heir) pendingLineage.push({ from, heir, file });
              }
              break;
            }
            default:
              break;
          }
          setOwner(index + 1, open?.id);
          continue;
        }
        const names = Ledger.sessionIdOf(row);
        if (names !== undefined) {
          const list = named.get(names);
          if (list) list.push(position);
          else named.set(names, [position]);
        }
        switch (row.type) {
          case "session.started": {
            const lost = open !== undefined && open.closedAt === undefined;
            if (open && lost) {
              // Never closed: lost when the next one started, billed what its last pause said.
              open.closedAt = row.at;
              open.reason = "lost";
              open.usageSeconds = open.lastUsage;
              open.end = position;
              open.endInclusive = false;
            }
            const started: BuiltSession = {
              id: row.sessionId,
              day,
              startedAt: row.at,
              ...(row.resumedFrom ? { resumedFrom: row.resumedFrom } : {}),
              start: position,
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
            const list = byDay.get(file);
            if (list) list.push(started);
            else byDay.set(file, [started]);
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
              target.end = position;
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
          default:
            break;
        }
        setOwner(index + 1, open?.id);
      }
    }

    // Chains: every session resolves to its root through the resumedFrom links. A link
    // to a session the ledger does not know (its day file moved away) ends the chain
    // there — the last known session is the root — and a loop, which no engine writes,
    // is cut by the visited set rather than followed.
    const roots = new Map<string, string>();
    const members = new Map<string, BuiltSession[]>();
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
      const list = members.get(cur.id);
      if (list) list.push(b);
      else members.set(cur.id, [b]);
    }

    // Tombstones: last row by `at` wins (file order breaks ties), applied per chain root.
    // A chainId the ledger cannot resolve is counted and ignored — never fatal — and its
    // last rows are kept aside (a carry keeps them; memory reads a trashed one by id).
    const conversations = new Map<string, ConversationInfo>();
    const chainRows = new Map<string, Position[]>();
    const chainForce = new Map<string, Map<ConversationAttr, Decided>>();
    const unresolvedForce = new Map<string, Map<ConversationAttr, Decided>>();
    // The state in force per root and per unresolved chainId, and when it was decided (this order breaks a tie).
    const stateOf = new Map<string, StateMark>();
    const stateOfRow = (row: LedgerRow): ConversationState => (row.type === "conversation.trashed" ? "trashed" : row.type === "conversation.archived" ? "archived" : "active");
    let unresolved = 0;
    pendingChain.sort((a, b) => a.row.at - b.row.at || a.order - b.order);
    for (const [rank, { row, at }] of pendingChain.entries()) {
      const chainId = (row as { chainId?: unknown }).chainId;
      const root = typeof chainId === "string" ? roots.get(chainId) : undefined;
      const attr = Ledger.attrOf(row);
      if (root === undefined) {
        unresolved++;
        if (typeof chainId === "string" && attr) {
          const force = unresolvedForce.get(chainId) ?? new Map<ConversationAttr, Decided>();
          force.set(attr, { row, at });
          unresolvedForce.set(chainId, force);
          if (attr === "state") stateOf.set(chainId, { state: stateOfRow(row), decidedAt: Ledger.decidedAt(row), rank });
        }
        continue;
      }
      const list = chainRows.get(root);
      if (list) list.push(at);
      else chainRows.set(root, [at]);
      if (attr) {
        const force = chainForce.get(root) ?? new Map<ConversationAttr, Decided>();
        force.set(attr, { row, at });
        chainForce.set(root, force);
        if (attr === "state") stateOf.set(root, { state: stateOfRow(row), decidedAt: Ledger.decidedAt(row), rank });
      }
      const when = Ledger.decidedAt(row);
      const prev = conversations.get(root) ?? { state: "active" as ConversationState, name: "", pinned: false, updatedAt: when };
      switch (row.type) {
        case "conversation.trashed":
          conversations.set(root, { ...prev, state: "trashed", trashedAt: when, updatedAt: when });
          break;
        case "conversation.restored": {
          const { trashedAt: _gone, ...rest } = prev;
          conversations.set(root, { ...rest, state: "active", updatedAt: when });
          break;
        }
        case "conversation.archived": {
          const { trashedAt: _gone, ...rest } = prev;
          conversations.set(root, { ...rest, state: "archived", updatedAt: when });
          break;
        }
        case "conversation.renamed":
          conversations.set(root, { ...prev, name: typeof row.name === "string" ? row.name.trim() : "", updatedAt: when });
          break;
        case "conversation.pinned":
          conversations.set(root, { ...prev, pinned: row.pinned === true, updatedAt: when });
          break;
        default:
          // A grant is the chain's row for the Log; it says nothing about the conversation's state.
          break;
      }
    }
    for (const list of chainRows.values()) list.sort(Ledger.byPosition);

    // Lineage of the ids no live day file holds: a session that resumed from one continues it (its
    // started row says so), and a move's row says which parts continue what it took away.
    const heirs = new Map<string, Map<string, Set<string>>>();
    const inherit = (from: string, heir: string, file: string): void => {
      if (from === heir || byId.has(from)) return;
      const byHeir = heirs.get(from) ?? new Map<string, Set<string>>();
      const files = byHeir.get(heir) ?? new Set<string>();
      files.add(file);
      byHeir.set(heir, files);
      heirs.set(from, byHeir);
    };
    for (const b of sessions) if (b.resumedFrom) inherit(b.resumedFrom, b.id, b.start.file);
    for (const l of pendingLineage) inherit(l.from, l.heir, l.file);

    // The Now stream's clear per session: the last of cleared / restored by `at` decides.
    const nowCleared = new Map<string, number>();
    const nowForce = new Map<string, Decided>();
    pendingNow.sort((a, b) => a.row.at - b.row.at || a.order - b.order);
    for (const { row, at } of pendingNow) {
      const sessionId = (row as { sessionId?: unknown }).sessionId as string;
      nowForce.set(sessionId, { row, at });
      if (row.type === "now.cleared") nowCleared.set(sessionId, Ledger.decidedAt(row));
      else nowCleared.delete(sessionId);
    }

    // What the rail lists: the window's sessions, and every session of a pinned conversation.
    const windowFiles = new Set(files.slice(windowStart));
    const listed = new Set<string>();
    for (const b of sessions) if (windowFiles.has(b.start.file) || conversations.get(roots.get(b.id) ?? b.id)?.pinned) listed.add(b.id);

    this.walked = {
      signature,
      sessions,
      byId,
      listed,
      byDay,
      named,
      roots,
      members,
      conversations,
      chainRows,
      nowRows,
      nowCleared,
      hidden,
      owners,
      unresolved,
      force: { chains: chainForce, unresolved: unresolvedForce, hidden: hiddenForce, now: nowForce },
      stateOf,
      heirs,
    };
    return this.walked;
  }

  /** Which of a conversation's three decisions a tombstone row makes; undefined for a grant. */
  private static attrOf(row: LedgerRow): ConversationAttr | undefined {
    switch (row.type) {
      case "conversation.trashed":
      case "conversation.restored":
      case "conversation.archived":
        return "state";
      case "conversation.renamed":
        return "name";
      case "conversation.pinned":
        return "pinned";
      default:
        return undefined;
    }
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

  private summaryOf(walk: Walk, b: BuiltSession): JarheadSessionSummary {
    return Ledger.summarize(b, walk.conversations.get(walk.roots.get(b.id) ?? b.id));
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
