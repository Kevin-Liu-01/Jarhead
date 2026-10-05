import { logger } from "@jarhead/core";
import { isHandsBusyMessage, NativeRequestError, type FrontmostInfo, type NativeHands, type UserIdle } from "./native.ts";
import type { ToolResult } from "./toolset.ts";

/**
 * One holder of the pointer, the keyboard and the front app at a time.
 *
 * A screen has one pointer; two hands on it read as a seizure, not as help. So the
 * lease is held ACROSS calls — a lane that has it keeps it until its turn ends, it
 * asks Kevin a question, or it has not acted for LEASE_IDLE_MS — and hand-over
 * re-fronts the taker's remembered app once, so its earlier screenshot is valid again
 * and the screen does not flicker between apps every tool call.
 *
 * Kevin's hands win. A thread never takes the screen while he is typing or clicking
 * (`user_idle` says when he last did), and never re-fronts its app over one HE
 * switched to (STALE_FOCUS: the front app is one no lane activated and not the
 * thread's own — he is using it; the thread waits and says so). Jarhead's own hands
 * (the main brain, dictation) acquire with priority: they never wait on a thread's
 * idle or on Kevin's typing beyond the helper's own `busy` refusal and the re-front's
 * wait below, but they take the lease from a thread only after MIN_HOLD_MS and never
 * in the middle of one of its ops (a held `type` finishes first). The one thing the
 * lease itself does to the screen, the re-front, is a `focus_app`: it reads
 * `user_idle` first for every taker, priority too, and waits out his quiet window, so
 * no app is pulled over the one he is typing in. A thread waits only what is left of
 * its acquire, so its tool still waits at most WAIT_MAX_MS in all; Jarhead's own hands
 * wait their patience afresh from the moment they got the lease, capped at WAIT_MAX_MS
 * (the main lane's 30 s acquire is spent on the holder, not on Kevin). If he is still
 * typing when the wait runs out, nothing is re-fronted and the lease is let go: the
 * taker hears `<name> is using the keyboard or mouse` (`busy`), never `ok` with his
 * app in front, where its next `type` or `key` would land once he paused.
 *
 * Nothing decided before an await stands after it. The thread's gate and the re-front
 * are helper round trips; a priority taker, a waking holder or a cut can land in the
 * middle of them, so the lease is re-judged after every one before anything is
 * assigned or reported — one holder, never mid-op, and a cut empties every waiter.
 */

const log = logger("hands.lease");

/** A holder that has not acted for this long has let go; the next in line may take the screen. */
export const LEASE_IDLE_MS = 3_000;
/** A thread keeps the lease at least this long before a priority taker may take it (never mid-op). */
export const MIN_HOLD_MS = 1_500;
/** How long a hand-over waits for the taker's remembered app to come to the front after `focus_app`. */
export const SETTLE_MS = 300;
/** The most a thread's tool waits for the screen before it returns "waiting for the screen: …". */
export const WAIT_MAX_MS = 8_000;
/** Kevin's last key/click/scroll this recent means his hands are on the machine: nobody else's move. */
export const KEVIN_QUIET_MS = 1_500;
/** How often a waiter re-reads `user_idle`, the holder's silence and the front app. */
export const USER_IDLE_POLL_MS = 250;
/**
 * How long "a lane brought this app to the front" stands without that lane working in
 * it again. A thread lives at most 300 s and a main-brain turn as long: an activation
 * older than this is a hand's that is gone, and the app in front is Kevin's own by now —
 * re-fronting over it would be stepping on him. Refreshed by `rememberFront`,
 * `activated`, a re-front and release-time learning; dropped by `forget` and a cut.
 */
export const ACTIVATED_TTL_MS = 5 * 60_000;

/** Why a holder let go. `cut` and `busy` (its re-front waited out Kevin's hands and gave up) learn nothing from the screen. */
export type LeaseRelease = "turn-end" | "question" | "idle" | "done" | "cut" | "busy";

/**
 * `refocused`: the taker's remembered app was brought back to the front. `waitedMs`: the
 * re-front first waited that long for Kevin's hands (the caller notes it). `busy`: the
 * screen was not taken because Kevin kept typing or clicking; the lease is not held.
 */
export type LeaseOutcome =
  | { readonly ok: true; readonly refocused?: string; readonly waitedMs?: number }
  | { readonly ok: false; readonly reason: string; readonly busy?: true };

/** `undefined` is accepted for every optional (callers pass a maybe-signal straight through). */
export interface AcquireOptions {
  /** Jarhead's own hands: skip Kevin's-typing and stale-focus waits; take from a thread after MIN_HOLD_MS. */
  readonly priority: boolean;
  /** The app this actor works in, remembered for the re-front on a later hand-over. */
  readonly app?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Default WAIT_MAX_MS. */
  readonly timeoutMs?: number | undefined;
  /**
   * A non-priority waiter's place in line (a thread's admission index): a free lease goes
   * to the lowest rank waiting, whichever polled first, so two screen threads take the
   * screen in the order they were started instead of racing the 250 ms poll. Absent =
   * last in line. A priority taker (Jarhead's hands, dictation) ignores ranks.
   */
  readonly rank?: number | undefined;
}

export interface FocusLeaseOptions {
  /**
   * The helper the lease reads `frontmost` through and re-fronts with `focus_app`. The
   * engine hands it the ACTING helper (`pool.focus`); `pool.background` serves too when
   * `userIdle` names the acting one.
   */
  readonly hands: NativeHands;
  /**
   * The helper `user_idle` is read from — it MUST be the one that posts events
   * (`pool.focus`, the default when `hands` is). Each helper subtracts only its own
   * posts, so on the never-posting background helper Jarhead's own clicks and
   * keystrokes read as Kevin's, and every thread acquire after a Jarhead action would
   * wait out KEVIN_QUIET_MS for nothing. Default: `hands`.
   */
  readonly userIdle?: NativeHands | undefined;
  /** The user's name in the thread gate's reasons (release F1), read live; default "Kevin". */
  readonly userName?: (() => string) | undefined;
  readonly now?: () => number;
  /** Test seam: the wait between polls (a virtual clock advances instead of sleeping). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** The poll interval (default USER_IDLE_POLL_MS). */
  readonly pollMs?: number | undefined;
}

/** What the re-front needs from its acquisition: how long the taker waits for Kevin's hands, and its stop. */
interface RefrontOptions {
  /** How long the re-front may wait for Kevin's hands, from the start of the settle (`quietWaitMs`). */
  readonly waitMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * How long a taker's re-front waits out Kevin's quiet window, given what is left of its
 * acquire. A thread (not priority): only what is left, so its tool waits at most its
 * timeout (WAIT_MAX_MS) in all, the bound README and AGENTS state; with nothing left it
 * reads `user_idle` once and answers `busy` if his hands are on the machine. Jarhead's
 * own hands: their patience afresh, capped at WAIT_MAX_MS, since their acquire waited on
 * the holder (MIN_HOLD_MS, never mid-op), not on him.
 */
function quietWaitMs(o: AcquireOptions, leftMs: number): number {
  if (o.priority) return Math.min(o.timeoutMs ?? WAIT_MAX_MS, WAIT_MAX_MS);
  return Math.max(0, Math.min(leftMs, WAIT_MAX_MS));
}

interface Holder {
  actor: string;
  priority: boolean;
  since: number;
  lastActAt: number;
}

/** Who brought an app forward (or worked in it), and when: the claim ages out (ACTIVATED_TTL_MS) and goes with its actor. */
interface Activation {
  actor: string;
  at: number;
}

export class FocusLease {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Where `user_idle` is read: the acting helper. */
  private readonly idleHands: NativeHands;
  private held: Holder | undefined;
  /** Ops the holder has in flight right now (a re-front counts): a taker never lands between a mouse-down and its up. */
  private inFlight = 0;
  /** The app each actor was seen working in (`rememberFront` / `touch(actor, app)`): the re-front target, and the STALE_FOCUS comparison. */
  private readonly remembered = new Map<string, string>();
  /** The app an actor said it wants (`acquire({app})`): a re-front fallback only — a thread that has not acted yet has switched nothing. */
  private readonly intended = new Map<string, string>();
  /** Apps some lane brought to the front or worked in (lower-cased → who, when): re-fronting over one of these is fair; over any other, Kevin switched. */
  private readonly activations = new Map<string, Activation>();
  /** Bumped by `cancelAll`; every waiter compares and gives up. */
  private generation = 0;
  /** Non-priority actors waiting right now, by rank (Infinity = unranked): the lowest is granted first. */
  private readonly waiters = new Map<string, number>();

  constructor(private readonly opts: FocusLeaseOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.idleHands = opts.userIdle ?? opts.hands;
  }

  /** Who has the screen, if anyone. */
  get holder(): string | undefined {
    return this.held?.actor;
  }

  /** Who holds it and since when (the engine's log line). */
  get holding(): { readonly actor: string; readonly since: number } | undefined {
    return this.held ? { actor: this.held.actor, since: this.held.since } : undefined;
  }

  /** For the snapshot and the tests. */
  info(): { readonly holder: string; readonly app?: string; readonly since: number; readonly inFlight: number } | undefined {
    const h = this.held;
    if (!h) return undefined;
    const app = this.appOf(h.actor);
    return { holder: h.actor, ...(app ? { app } : {}), since: h.since, inFlight: this.inFlight };
  }

  /** The app `actor` works in (remembered for the re-front); also marks it as a lane's, so re-fronting over it is fair game. */
  rememberFront(actor: string, app: string): void {
    if (!app) return;
    this.remembered.set(actor, app);
    this.activate(app, actor);
  }

  /** A lane brought `app` to the front (open_app / focus_app): re-fronting another lane's app over it is not stepping on Kevin. */
  activated(app: string, actor = "lane"): void {
    if (app) this.activate(app, actor);
  }

  /** Is `app` one a lane brought forward or worked in, recently enough (ACTIVATED_TTL_MS) to still be a lane's? */
  isActivated(app: string): boolean {
    const key = appKey(app);
    const a = this.activations.get(key);
    if (!a) return false;
    if (this.now() - a.at > ACTIVATED_TTL_MS) {
      this.activations.delete(key);
      return false;
    }
    return true;
  }

  /**
   * An actor is gone (its thread ended): what it remembered, what it intended and the
   * apps it activated are nobody's — the screen it left is Kevin's until a lane acts on
   * it again. A hold it still had is dropped without learning from it.
   */
  forget(actor: string): void {
    this.remembered.delete(actor);
    this.intended.delete(actor);
    for (const [k, a] of this.activations) if (a.actor === actor) this.activations.delete(k);
    if (this.held?.actor === actor) {
      this.held = undefined;
      this.inFlight = 0;
    }
  }

  /** The app `actor` works in: where it was seen working, else where it said it would. */
  appOf(actor: string): string | undefined {
    return this.remembered.get(actor) ?? this.intended.get(actor);
  }

  /** The non-priority actors in line for the screen, lowest rank first (tests, the log). */
  get waiting(): readonly string[] {
    return [...this.waiters.entries()].sort((a, b) => a[1] - b[1]).map(([actor]) => actor);
  }

  /** Someone with a lower rank is waiting too: this actor's turn is not yet. */
  private behindInLine(actor: string): string | undefined {
    const mine = this.waiters.get(actor);
    if (mine === undefined) return undefined;
    for (const [other, rank] of this.waiters) if (other !== actor && rank < mine) return `${other} is ahead in line`;
    return undefined;
  }

  /**
   * Take the screen, or wait for it. Resolves `ok` with the lease held (and `refocused`
   * when the taker's remembered app was re-fronted, `waitedMs` when that waited for
   * Kevin's hands), or `ok: false` with the reason the screen is not to be had — the
   * caller renders "waiting for the screen: <reason>". `busy` on a failure means Kevin's
   * hands stayed on the machine through the re-front's whole wait: the lease is not held.
   */
  async acquire(actor: string, o: AcquireOptions): Promise<LeaseOutcome> {
    if (o.app) this.intended.set(actor, o.app);
    const gen = this.generation;
    const deadline = this.now() + (o.timeoutMs ?? WAIT_MAX_MS);
    let reason = "the screen is busy";
    // In line while waiting (non-priority only): the lowest rank present is granted first.
    if (!o.priority) this.waiters.set(actor, o.rank ?? Number.POSITIVE_INFINITY);
    try {
      for (;;) {
        if (o.signal?.aborted) return { ok: false, reason: "cancelled" };
        if (this.generation !== gen) return { ok: false, reason: "cut" };
        const h = this.held;
        if (h?.actor === actor) {
          h.lastActAt = this.now();
          return { ok: true };
        }
        let blocked = this.blockedBy(actor, o.priority) ?? (o.priority ? undefined : this.behindInLine(actor));
        if (!blocked) {
          // The gate is two helper round trips; the lease may have moved meanwhile — a
          // priority taker landed, the idle holder woke and began an op, a cut — so the
          // verdict from before it counts for nothing: judge again before taking anything.
          const gate = o.priority ? undefined : await this.threadGate(actor);
          if (o.signal?.aborted) return { ok: false, reason: "cancelled" };
          if (this.generation !== gen) return { ok: false, reason: "cut" };
          if (this.held?.actor === actor) return { ok: true };
          blocked = this.blockedBy(actor, o.priority) ?? gate ?? (o.priority ? undefined : this.behindInLine(actor));
          if (!blocked) {
            const prev = this.held;
            const now = this.now();
            this.held = { actor, priority: o.priority, since: now, lastActAt: now };
            if (prev) log.debug(`${prev.actor} → ${actor}`);
            // Out of the line before the settle: the next in rank may judge the lease free once this one lets go.
            this.waiters.delete(actor);
            return this.settle(actor, gen, { waitMs: quietWaitMs(o, deadline - now), signal: o.signal });
          }
        }
        reason = blocked;
        if (this.now() >= deadline) return { ok: false, reason };
        await this.sleep(this.opts.pollMs ?? USER_IDLE_POLL_MS);
      }
    } finally {
      this.waiters.delete(actor);
    }
  }

  /**
   * What the lease itself holds against `actor` right now, or undefined when it is free
   * for the taking: a holder mid-op (nobody's, ever), a thread's MIN_HOLD against a
   * priority taker, a holder's recent activity against a thread.
   */
  private blockedBy(actor: string, priority: boolean): string | undefined {
    const h = this.held;
    if (!h || h.actor === actor) return undefined;
    const now = this.now();
    if (priority) {
      // Never mid-op; from a thread only after it has had its MIN_HOLD.
      if (this.inFlight === 0 && (h.priority || now - h.since >= MIN_HOLD_MS)) return undefined;
      return `${h.actor} is mid-action`;
    }
    if (this.inFlight === 0 && now - h.lastActAt >= LEASE_IDLE_MS) return undefined;
    return `${h.actor} has the screen`;
  }

  /**
   * What keeps a thread off the screen even when the lease is free: Kevin's hands on
   * the machine within KEVIN_QUIET_MS, or an app in front that Kevin switched to
   * (one no lane activated, not the thread's own). Returns the reason, or undefined.
   */
  private async threadGate(actor: string): Promise<string | undefined> {
    const idle = await this.idleHands.request<UserIdle>("user_idle", {}, 1500).catch(() => undefined);
    const who = this.opts.userName?.() || "Kevin";
    if (idle && idle.foreignMs < KEVIN_QUIET_MS) return `${who} is using the keyboard or mouse`;
    const front = await this.front();
    const mine = this.remembered.get(actor);
    if (front && mine && !this.isActivated(front.app) && !sameApp(mine, front.app)) {
      // He switched here himself; the thread is never re-fronted behind him.
      return `${who} is using ${front.app}`;
    }
    return undefined;
  }

  /**
   * The lease is this actor's now; its remembered app comes back to the front, once,
   * whenever it is not there already and the app in front is a lane's — a fresh lease
   * or a hand-over alike — so its earlier screenshot's display-configuration hash
   * matches again. Over an app Kevin switched to himself (no lane fronted it): nothing;
   * his window stays where it is. The re-front counts as an op in flight, so nobody
   * takes the lease in the middle of it; a cut meanwhile makes the outcome `cut`.
   * While Kevin's hands are on the machine the re-front waits, up to `waitMs` from here.
   * A stop meanwhile answers `cancelled`, and his hands still on the machine at the end
   * answer `busy`; either way nothing is re-fronted and the lease is empty.
   */
  private async settle(actor: string, gen: number, o: RefrontOptions): Promise<LeaseOutcome> {
    const want = this.appOf(actor);
    if (!want) return { ok: true };
    this.inFlight += 1;
    try {
      return await this.refront(actor, want, gen, o);
    } finally {
      // A cut or a forget emptied the count with the lease; only a hold still ours is ours to give back.
      if (this.generation === gen && this.held?.actor === actor) this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async refront(actor: string, want: string, gen: number, o: RefrontOptions): Promise<LeaseOutcome> {
    const t0 = this.now();
    const until = t0 + o.waitMs;
    /** How long the re-front has waited for Kevin's hands so far (0 when it never had to). */
    let waitedMs = 0;
    // Judged again after every wait: the app in front may be one Kevin switched to while he typed.
    for (;;) {
      const front = await this.front();
      const lost = this.lostSince(actor, gen);
      if (lost) return lost;
      if (!front || sameApp(front.app, want) || !this.isActivated(front.app)) return waitedMs > 0 ? { ok: true, waitedMs } : { ok: true };
      // A focus_app pulls `want` over whatever Kevin is typing into: his quiet window first, for every taker.
      const idle = await this.idleHands.request<UserIdle>("user_idle", {}, 1500).catch(() => undefined);
      const lostIdle = this.lostSince(actor, gen);
      if (lostIdle) return lostIdle;
      if (idle === undefined || idle.foreignMs >= KEVIN_QUIET_MS) {
        // The taker may have been stopped during the reads: a stopped lane pulls nothing forward.
        if (o.signal?.aborted) return this.stopped(actor);
        try {
          await this.opts.hands.request("focus_app", { name: want }, 3000);
          break;
        } catch (e) {
          // The helper refuses busy too (he typed between the read and the activation): that waits like the read.
          if (!isBusyResult(e)) {
            log.debug(`re-front ${want}: ${(e as Error).message}`);
            return this.lostSince(actor, gen) ?? { ok: true };
          }
        }
      }
      if (o.signal?.aborted) return this.stopped(actor);
      // Out of patience with his hands still on the machine: his app stays in front, and the screen is not the taker's.
      if (this.now() >= until) return this.lostSince(actor, gen) ?? this.busy(actor, want);
      await this.sleep(this.opts.pollMs ?? USER_IDLE_POLL_MS);
      waitedMs = this.now() - t0;
      if (o.signal?.aborted) return this.stopped(actor);
      const lostWait = this.lostSince(actor, gen);
      if (lostWait) return lostWait;
    }
    const lostAfter = this.lostSince(actor, gen);
    if (lostAfter) return lostAfter;
    this.activate(want, actor);
    const settleUntil = this.now() + SETTLE_MS;
    while (this.now() < settleUntil) {
      await this.sleep(Math.min(50, SETTLE_MS));
      const f = await this.front();
      const lostMid = this.lostSince(actor, gen);
      if (lostMid) return lostMid;
      if (f && sameApp(f.app, want)) break;
    }
    return waitedMs > 0 ? { ok: true, refocused: want, waitedMs } : { ok: true, refocused: want };
  }

  /** The taker was stopped while its re-front waited for Kevin: nothing is re-fronted, and the screen is nobody's. */
  private stopped(actor: string): LeaseOutcome {
    this.release(actor, "cut");
    return { ok: false, reason: "cancelled" };
  }

  /**
   * Kevin kept typing or clicking for the taker's whole quiet wait: nothing is re-fronted, and
   * the lease is let go without learning from the app in front (it is his, not the taker's).
   * The taker answers "waiting for the screen", never acts with his app in front.
   */
  private busy(actor: string, want: string): LeaseOutcome {
    const who = this.opts.userName?.() || "Kevin";
    log.debug(`re-front ${want}: ${who} is still using the keyboard or mouse; not re-fronted, ${actor} lets go`);
    this.release(actor, "busy");
    return { ok: false, reason: `${who} is using the keyboard or mouse`, busy: true };
  }

  /** After an await inside an acquisition: is the lease still this actor's? A cut → "cut"; otherwise whoever has it now. */
  private lostSince(actor: string, gen: number): LeaseOutcome | undefined {
    if (this.generation !== gen) return { ok: false, reason: "cut" };
    const h = this.held;
    if (h?.actor === actor) return undefined;
    return { ok: false, reason: h ? `${h.actor} has the screen` : "released" };
  }

  private front(): Promise<FrontmostInfo | undefined> {
    return this.opts.hands.request<FrontmostInfo>("frontmost", {}, 1500).catch(() => undefined);
  }

  private activate(app: string, actor: string): void {
    this.activations.set(appKey(app), { actor, at: this.now() });
  }

  /** Is `app` one this actor may claim as its own: where it said it works, where it was seen working, or one some lane fronted? */
  private isOwn(actor: string, app: string): boolean {
    const r = this.remembered.get(actor);
    const i = this.intended.get(actor);
    return (r !== undefined && sameApp(r, app)) || (i !== undefined && sameApp(i, app)) || this.isActivated(app);
  }

  /** The holder acted (an acting call went out): its idle clock restarts; `app` updates where it works. */
  touch(actor: string, app?: string): void {
    if (app) this.rememberFront(actor, app);
    const h = this.held;
    if (h?.actor === actor) h.lastActAt = this.now();
  }

  /** The holder's op is going out (a probe about to post): nobody takes the lease until `endOp`. */
  beginOp(actor: string): void {
    if (this.held?.actor === actor) {
      this.inFlight += 1;
      this.touch(actor);
    }
  }

  /** The holder's op is over: the idle clock restarts; a waiting priority taker may have it now. */
  endOp(actor: string): void {
    if (this.held?.actor !== actor) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.touch(actor);
  }

  /** `beginOp` … `endOp` around one call, for callers that hold the op as a function. */
  async act<T>(actor: string, fn: () => Promise<T>): Promise<T> {
    this.beginOp(actor);
    try {
      return await fn();
    } finally {
      this.endOp(actor);
    }
  }

  /**
   * The holder lets go (its turn ended, it asked a question, it is done). Someone
   * else's release is ignored. What the holder left in front is where it was working
   * — remembered for its re-front, and refreshed as a lane's app — but ONLY when it was
   * already the lane's (its intended or remembered app, or one some lane fronted):
   * anything else in front is what Kevin brought forward while the lane held the
   * lease, and it is not the lane's to cover later. Not on a cut, and not on `busy` (its
   * re-front gave up over Kevin's typing): nothing about that screen is the lane's.
   */
  release(actor: string, why: LeaseRelease): void {
    if (this.held?.actor !== actor) return;
    log.debug(`${actor} released (${why})`);
    this.held = undefined;
    this.inFlight = 0;
    if (why === "cut" || why === "busy") return;
    const gen = this.generation;
    void this.front().then((f) => {
      if (!f?.app || this.generation !== gen) return;
      if (this.isOwn(actor, f.app)) this.rememberFront(actor, f.app);
    });
  }

  /** A cut: the lease is empty, every waiter returns `ok: false` on its next poll, and no app is a lane's any more. */
  cancelAll(reason = "cut"): void {
    this.generation += 1;
    if (this.held) log.debug(`${this.held.actor} cut (${reason})`);
    this.held = undefined;
    this.inFlight = 0;
    this.activations.clear();
    // Every waiter returns `cut` on its next poll and leaves the line itself; the line is empty now regardless.
    this.waiters.clear();
  }

  /**
   * Retry a tool call the helper answered `busy` (Kevin's hands were on the machine),
   * silently, until it lands or the wait runs out — the helper re-judges the quiet
   * window itself on every attempt. Anything but a `busy` result returns at once. A
   * stop during the wait (the signal, or a cut of the lease) tries the op no more: the
   * last busy answer stands, and nothing goes out after Kevin said stop.
   */
  async retryBusy<T>(fn: () => Promise<T>, isBusy: (r: T) => boolean, o: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {}): Promise<T> {
    const gen = this.generation;
    const deadline = this.now() + (o.timeoutMs ?? WAIT_MAX_MS);
    for (;;) {
      const r = await fn();
      if (!isBusy(r) || o.signal?.aborted || this.generation !== gen || this.now() >= deadline) return r;
      await this.sleep(USER_IDLE_POLL_MS);
      if (o.signal?.aborted || this.generation !== gen) return r;
    }
  }
}

/** Is this the helper's `busy` refusal, as a ToolResult (the toolset renders the error as `busy: <message>`) or as the thrown error? */
export function isBusyResult(r: ToolResult | unknown): boolean {
  if (r instanceof NativeRequestError) return r.detail.code === "busy";
  if (typeof r !== "object" || r === null) return false;
  const t = r as { kind?: unknown; message?: unknown };
  return t.kind === "error" && typeof t.message === "string" && (t.message.startsWith("busy: ") || isHandsBusyMessage(t.message));
}

function sameApp(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function appKey(app: string): string {
  return app.trim().toLowerCase();
}
