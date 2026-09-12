import { appendFileSync, copyFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Settings, TrashInfo } from "@jarhead/protocol";
import { Ledger } from "./ledger.ts";

/**
 * The Trash: <stateDir>/trash. Jarhead never deletes Kevin's data — bytes move only
 * as WHOLE DAY FILES, by rename(2), from `ledger/YYYY-MM-DD.jsonl` to
 * `trash/ledger/` and from `shots/YYYY-MM-DD/` to `trash/shots/`, and back. Every
 * move appends a `ledger.moved` row to today's ledger (the record stays
 * append-only) and a line to `trash/manifest.jsonl`. Emptying the Trash is Kevin's,
 * in Finder; nothing here unlinks a live file. The one exception is spelled out in
 * `move()`: a rename across devices falls back to copy + fsync + rename, and the
 * copy's SOURCE is removed only after the copy verified byte for byte — or the move
 * is refused whole. There is never a partial move.
 *
 * Refusals (`refusal()`) say why in one line, for the row and the toast: today's
 * file is live; the open session's day; a day holding a session of a pinned chain;
 * a day holding a session of a chain still open. The retention sweep (`sweep()`)
 * applies `Settings.ledgerRetentionDays` / `shotsRetentionDays` (0 = never): it
 * lists what it would move first, logged, then moves.
 *
 * Shots are the one folder another writer shares: the screenshot cap (runner.ts
 * `evictShots`) renames single files into `trash/shots/<day>/` as it goes, so that
 * folder may already exist when the day's turn comes. A shots day then MERGES —
 * every live file renames into the folder there (a name already present refuses the
 * whole day, checked before the first rename; a rename that fails part-way moves
 * the moved ones back) and the emptied live folder is removed. Restoring merges the
 * same way into a live folder that exists. A ledger day is one file and never merges.
 */

export type TrashWhat = "ledger" | "shots";
export type TrashBy = "kevin" | "retention";

export interface TrashMove {
  readonly day: string;
  readonly what: TrashWhat;
  readonly from: string;
  readonly to: string;
}

export interface TrashRefusal {
  readonly day: string;
  readonly what: TrashWhat;
  readonly reason: string;
}

export type MoveResult = { readonly ok: true; readonly move: TrashMove } | ({ readonly ok: false } & TrashRefusal);

export interface RestoreResult {
  readonly restored: readonly TrashMove[];
  readonly refused: readonly TrashRefusal[];
}

/** What a sweep would do (the dry run), then what it did. */
export interface SweepPlan {
  /** Days before these move (exclusive); absent when that retention is off. */
  readonly cutoff: { readonly ledger?: string; readonly shots?: string };
  readonly moves: readonly { readonly day: string; readonly what: TrashWhat }[];
  readonly refused: readonly TrashRefusal[];
}

export interface SweepResult extends SweepPlan {
  readonly moved: readonly TrashMove[];
  readonly failed: readonly TrashRefusal[];
}

export interface TrashDay {
  readonly day: string;
  readonly ledger: boolean;
  readonly shots: boolean;
  readonly bytes: number;
}

export interface TrashOptions {
  readonly now?: () => number;
  /** Session ids the engine holds open or paused right now: their chains' days never move. */
  readonly openSessionIds?: () => readonly string[];
  readonly log?: (line: string) => void;
  /** Test seam: rename(2). Throwing `EXDEV` exercises the cross-device fallback. */
  readonly rename?: (from: string, to: string) => void;
}

export type RetentionSettings = Pick<Settings, "ledgerRetentionDays" | "shotsRetentionDays">;

export class Trash {
  /** <stateDir>/trash */
  readonly dir: string;
  readonly manifestPath: string;
  private readonly liveLedger: string;
  private readonly liveShots: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** `info()` memoised on the mtimes of the Trash's folders: a file added or removed anywhere (Finder, the cap, a move) changes one of them. */
  private infoMemo: { readonly sig: string; readonly info: TrashInfo } | undefined;

  static readonly DAY = /^\d{4}-\d{2}-\d{2}$/;

  constructor(
    stateDir: string,
    private readonly ledger: Ledger,
    private readonly opts: TrashOptions = {},
  ) {
    this.dir = join(stateDir, "trash");
    this.manifestPath = join(this.dir, "manifest.jsonl");
    this.liveLedger = ledger.dir;
    this.liveShots = join(stateDir, "shots");
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  /** Where a day's ledger file or shots folder lives while live. */
  livePath(day: string, what: TrashWhat): string {
    return what === "ledger" ? join(this.liveLedger, `${day}.jsonl`) : join(this.liveShots, day);
  }

  /** Where it sits in the Trash. */
  trashPath(day: string, what: TrashWhat): string {
    return what === "ledger" ? join(this.dir, "ledger", `${day}.jsonl`) : join(this.dir, "shots", day);
  }

  /**
   * Why a day may not move to the Trash right now, in one line — or undefined when it
   * may. Checked again inside `moveDay`; callers read it to grey a row out.
   */
  refusal(day: string, what: TrashWhat): string | undefined {
    if (!Trash.DAY.test(day)) return "not a day (YYYY-MM-DD)";
    const today = Ledger.dayFor(this.now());
    if (day === today) return "today is live";
    if (day > today) return "that day has not happened yet";
    if (!existsSync(this.livePath(day, what))) return existsSync(this.trashPath(day, what)) ? "already in the Trash" : what === "ledger" ? "no ledger file for that day" : "no screenshots for that day";
    if (existsSync(this.trashPath(day, what))) {
      // One ledger file per day: a second one is a real conflict. A shots folder merges into what the cap already moved there — unless a name is taken.
      if (what === "ledger") return "the Trash already holds that day";
      const taken = Trash.collision(this.livePath(day, what), this.trashPath(day, what));
      if (taken) return `the Trash already holds ${taken} for that day`;
    }
    return this.guard(day);
  }

  /**
   * The sessions of that day decide: the open (or paused) session's day stays; a day
   * holding any session of a pinned conversation stays; a day holding any session of
   * a conversation still open stays — its root or a link, moving either would split
   * the chain under the Console. "Open" is the engine's word first (`openSessionIds`)
   * and the ledger's second (a session with no closed row and no later start).
   */
  private guard(day: string): string | undefined {
    const sessions = this.ledger.sessions();
    const openIds = new Set<string>(this.opts.openSessionIds?.() ?? []);
    for (const s of sessions) if (s.closedAt === undefined) openIds.add(s.id);
    const openRoots = new Set<string>();
    for (const id of openIds) openRoots.add(this.ledger.chainRootOf(id) ?? id);
    for (const s of sessions) {
      if (s.day !== day) continue;
      if (openIds.has(s.id)) return "the open session's day";
      if (s.pinned) return "a pinned conversation";
      if (openRoots.has(this.ledger.chainRootOf(s.id) ?? s.id)) return "a conversation still open has a session that day";
    }
    return undefined;
  }

  /** Move one day's ledger file or shots folder to the Trash. Refused with a reason, or moved and recorded. */
  moveDay(day: string, what: TrashWhat, by: TrashBy): MoveResult {
    const reason = this.refusal(day, what);
    if (reason) {
      this.log(`trash: ${what} ${day} kept — ${reason}`);
      return { ok: false, day, what, reason };
    }
    const from = this.livePath(day, what);
    const to = this.trashPath(day, what);
    const merged = what === "shots" && existsSync(to);
    try {
      mkdirSync(dirname(to), { recursive: true });
      if (merged) this.merge(from, to);
      else this.move(from, to);
    } catch (e) {
      const why = `move failed: ${(e as Error).message}`;
      this.log(`trash: ${what} ${day} kept — ${why}`);
      return { ok: false, day, what, reason: why };
    }
    this.record({ day, what, from, to }, "trash", by);
    this.log(`trash: ${what} ${day} ${merged ? "merged into" : "moved to"} the Trash (${by})`);
    return { ok: true, move: { day, what, from, to } };
  }

  /** Move a day back from the Trash — its ledger file and its shots, whichever are there. */
  restoreDay(day: string): RestoreResult {
    const restored: TrashMove[] = [];
    const refused: TrashRefusal[] = [];
    if (!Trash.DAY.test(day)) return { restored, refused: [{ day, what: "ledger", reason: "not a day (YYYY-MM-DD)" }] };
    let found = false;
    for (const what of ["ledger", "shots"] as const) {
      const from = this.trashPath(day, what);
      if (!existsSync(from)) continue;
      found = true;
      const to = this.livePath(day, what);
      const merged = existsSync(to);
      if (merged) {
        // A ledger file that exists live is a conflict; a live shots folder takes the files back unless a name is taken.
        if (what === "ledger") {
          refused.push({ day, what, reason: "a live ledger file for that day already exists" });
          continue;
        }
        const taken = Trash.collision(from, to);
        if (taken) {
          refused.push({ day, what, reason: `the live shots folder for that day already holds ${taken}` });
          continue;
        }
      }
      try {
        mkdirSync(dirname(to), { recursive: true });
        if (merged) this.merge(from, to);
        else this.move(from, to);
      } catch (e) {
        refused.push({ day, what, reason: `move failed: ${(e as Error).message}` });
        continue;
      }
      this.record({ day, what, from, to }, "live", "kevin");
      this.log(`trash: ${what} ${day} restored${merged ? " (merged into the live folder)" : ""}`);
      restored.push({ day, what, from, to });
    }
    if (!found) refused.push({ day, what: "ledger", reason: "nothing for that day in the Trash" });
    return { restored, refused };
  }

  /** What the Trash holds, per day, oldest first. */
  days(): TrashDay[] {
    const byDay = new Map<string, { ledger: boolean; shots: boolean; bytes: number }>();
    const note = (day: string, what: TrashWhat, bytes: number): void => {
      const d = byDay.get(day) ?? { ledger: false, shots: false, bytes: 0 };
      d[what] = true;
      d.bytes += bytes;
      byDay.set(day, d);
    };
    for (const name of Trash.list(join(this.dir, "ledger"))) {
      if (!name.endsWith(".jsonl")) continue;
      const day = name.slice(0, -".jsonl".length);
      if (Trash.DAY.test(day)) note(day, "ledger", Trash.sizeOf(join(this.dir, "ledger", name)));
    }
    for (const name of Trash.list(join(this.dir, "shots"))) if (Trash.DAY.test(name)) note(name, "shots", Trash.sizeOf(join(this.dir, "shots", name)));
    return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, d]) => ({ day, ...d }));
  }

  /**
   * For the snapshot: "3 days · 129 MB", and where. The walk over every file runs only
   * when a folder's mtime changed since the last answer (`signature()`): a Trash Kevin
   * emptied in Finder reads 0 on the next call, and an unchanged one costs a few stats.
   */
  info(): TrashInfo {
    const sig = this.signature();
    if (this.infoMemo && this.infoMemo.sig === sig) return this.infoMemo.info;
    let bytes = 0;
    const days = this.days();
    for (const d of days) bytes += d.bytes;
    const info = { path: this.dir, days: days.length, bytes };
    this.infoMemo = { sig, info };
    return info;
  }

  /**
   * The retention rule as a listing: every live day older than the window, and why any
   * of them stays. `0` = never. A day is older than N days when it lies before the day
   * N local days ago (today − N stays; the day before it moves).
   */
  plan(settings: RetentionSettings, now: number = this.now()): SweepPlan {
    const cutoffLedger = Trash.cutoff(settings.ledgerRetentionDays, now);
    const cutoffShots = Trash.cutoff(settings.shotsRetentionDays, now);
    const moves: { day: string; what: TrashWhat }[] = [];
    const refused: TrashRefusal[] = [];
    const consider = (day: string, what: TrashWhat, cutoff: string | undefined): void => {
      if (cutoff === undefined || !(day < cutoff)) return;
      const reason = this.refusal(day, what);
      if (reason) refused.push({ day, what, reason });
      else moves.push({ day, what });
    };
    for (const file of this.ledger.days()) consider(file.replace(/\.jsonl$/, ""), "ledger", cutoffLedger);
    for (const name of Trash.list(this.liveShots)) if (Trash.DAY.test(name)) consider(name, "shots", cutoffShots);
    moves.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.what < b.what ? -1 : 1));
    return { cutoff: { ...(cutoffLedger ? { ledger: cutoffLedger } : {}), ...(cutoffShots ? { shots: cutoffShots } : {}) }, moves, refused };
  }

  /** The retention sweep: the plan, logged line by line, then the moves. Nothing is deleted. */
  sweep(settings: RetentionSettings, now: number = this.now()): SweepResult {
    const plan = this.plan(settings, now);
    const window = [plan.cutoff.ledger ? `ledger before ${plan.cutoff.ledger}` : "ledger kept forever", plan.cutoff.shots ? `shots before ${plan.cutoff.shots}` : "shots kept forever"].join(", ");
    this.log(`sweep: ${window}; would move ${plan.moves.length}, keep ${plan.refused.length}`);
    for (const m of plan.moves) this.log(`sweep: would move ${m.what} ${m.day} to the Trash`);
    for (const r of plan.refused) this.log(`sweep: keeping ${r.what} ${r.day} — ${r.reason}`);
    const moved: TrashMove[] = [];
    const failed: TrashRefusal[] = [];
    for (const m of plan.moves) {
      const r = this.moveDay(m.day, m.what, "retention");
      if (r.ok) moved.push(r.move);
      else failed.push({ day: r.day, what: r.what, reason: r.reason });
    }
    return { ...plan, moved, failed };
  }

  // ------------------------------------------------------------------ internals

  /** The mtimes of trash/, trash/ledger, trash/shots and every day folder under shots — a change anywhere in the Trash moves one of them. */
  private signature(): string {
    const parts: string[] = [];
    const stamp = (path: string): void => {
      try {
        const st = statSync(path);
        parts.push(`${path}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${path}:-`);
      }
    };
    stamp(this.dir);
    stamp(join(this.dir, "ledger"));
    const shots = join(this.dir, "shots");
    stamp(shots);
    for (const name of Trash.list(shots)) stamp(join(shots, name));
    return parts.join("|");
  }

  /** The first name a merge of `fromDir` into `toDir` would land on twice, or undefined when none is taken. */
  private static collision(fromDir: string, toDir: string): string | undefined {
    for (const name of Trash.list(fromDir).sort()) if (existsSync(join(toDir, name))) return name;
    return undefined;
  }

  /**
   * Every entry of `fromDir` moves into `toDir`, which exists. Names are checked before
   * the first rename (a taken name refuses the whole folder); a rename that fails
   * part-way moves the ones already moved back, so the folder is whole on one side or
   * the other. The emptied source folder is removed — a folder, never a file; one
   * that took a new file meanwhile stays.
   */
  private merge(fromDir: string, toDir: string): void {
    const names = readdirSync(fromDir).sort();
    const taken = Trash.collision(fromDir, toDir);
    if (taken) throw new Error(`${join(toDir, taken)} exists; nothing overwritten`);
    const done: string[] = [];
    try {
      for (const name of names) {
        this.move(join(fromDir, name), join(toDir, name));
        done.push(name);
      }
    } catch (e) {
      for (const name of done) {
        try {
          this.move(join(toDir, name), join(fromDir, name));
        } catch (back) {
          this.log(`trash: ${join(toDir, name)} could not move back after a failed merge: ${(back as Error).message}`);
        }
      }
      throw e;
    }
    try {
      rmdirSync(fromDir);
    } catch {
      // Not empty any more (a screenshot landed as the day moved) or already gone: the files moved; the folder may stay.
    }
  }

  /** The day N local days before `now`, or undefined when N is 0 (never). Noon-anchored so a DST change cannot shift the day. */
  private static cutoff(days: number, now: number): string | undefined {
    const n = Math.floor(Number(days));
    if (!(n > 0)) return undefined;
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return Ledger.dayFor(d.getTime());
  }

  /** The row in today's ledger and the line in the manifest, for one move in either direction. */
  private record(move: TrashMove, to: "trash" | "live", by: TrashBy): void {
    const at = this.now();
    this.ledger.append({ at, type: "ledger.moved", day: move.day, what: move.what, to, path: move.to, by });
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.manifestPath, `${JSON.stringify({ at, day: move.day, what: move.what, to, from: move.from, path: move.to, by })}\n`);
    } catch (e) {
      // The ledger row is the record; the manifest is a convenience for Finder.
      this.log(`trash: manifest not written: ${(e as Error).message}`);
    }
  }

  /**
   * rename(2), whole. Across devices (EXDEV — a state dir on one volume with its
   * trash symlinked to another) the fallback is: copy beside the destination as
   * `<to>.partial`, fsync every file, verify the copy against the source byte for
   * byte, rename the copy into place, and only then remove the source. A copy that
   * does not verify is removed and the move refused; the source is never touched
   * before a verified copy stands at the destination.
   */
  private move(from: string, to: string): void {
    const rename = this.opts.rename ?? renameSync;
    if (existsSync(to)) throw new Error(`${to} exists; nothing overwritten`);
    try {
      rename(from, to);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    }
    const partial = `${to}.partial`;
    rmSync(partial, { recursive: true, force: true });
    try {
      Trash.copyTree(from, partial);
      Trash.fsyncTree(partial);
      const why = Trash.differ(from, partial);
      if (why) throw new Error(`cross-device copy did not verify (${why}); ${from} stays where it was`);
      rename(partial, to);
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      throw e;
    }
    // The verified copy is in place under its final name: the source is the copy's source now, not the record.
    rmSync(from, { recursive: true, force: false });
  }

  private static copyTree(from: string, to: string): void {
    const st = lstatSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) Trash.copyTree(join(from, name), join(to, name));
    } else if (st.isFile()) {
      copyFileSync(from, to);
    } else {
      throw new Error(`${from} is neither a file nor a folder`);
    }
  }

  private static fsyncTree(path: string): void {
    const st = lstatSync(path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path)) Trash.fsyncTree(join(path, name));
      return;
    }
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Why two trees differ (the first difference found), or undefined when they match file for file, byte for byte. */
  private static differ(a: string, b: string): string | undefined {
    const sa = lstatSync(a);
    const sb = lstatSync(b);
    if (sa.isDirectory() !== sb.isDirectory()) return `${a} and ${b} are not the same kind`;
    if (sa.isDirectory()) {
      const na = readdirSync(a).sort();
      const nb = readdirSync(b).sort();
      if (na.length !== nb.length || na.some((n, i) => n !== nb[i])) return `${b} lists different entries than ${a}`;
      for (const name of na) {
        const why = Trash.differ(join(a, name), join(b, name));
        if (why) return why;
      }
      return undefined;
    }
    if (sa.size !== sb.size) return `${b} is ${sb.size} bytes, ${a} is ${sa.size}`;
    if (!readFileSync(a).equals(readFileSync(b))) return `${b} differs from ${a}`;
    return undefined;
  }

  private static list(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  /** Bytes under a path, links not followed. */
  private static sizeOf(path: string): number {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return 0;
    }
    if (st.isDirectory()) {
      let total = 0;
      for (const name of Trash.list(path)) total += Trash.sizeOf(join(path, name));
      return total;
    }
    return st.isFile() ? st.size : 0;
  }
}
