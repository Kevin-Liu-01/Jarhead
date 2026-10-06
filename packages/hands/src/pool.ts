import { NativeHandsProcess, type NativeHands, type NativeHandsProcessOptions } from "./native.ts";

/**
 * Two helper processes from one binary: `focus` acts (every op that posts an event,
 * activates an app or touches the pasteboard — the main brain, dictation, screen-lane
 * threads) and `background` reads (the engine's AX warm tick and ear hints, background
 * threads' probes). The helper is serial, so a thread's 30 s
 * `open_app` or a long `type` on one process never stalls the gate probes and the
 * 500 ms tree walk on the other.
 *
 * Same daemon parent → same TCC identity: the second process needs no new grant and
 * no prompt. Both are spawned with Jarhead's keys stripped from the environment
 * (`NativeHandsProcess` does that for every spawn). The two coexist on nothing but the
 * pointer, the keyboard and the pasteboard — the lease and the lane rules keep the
 * acting ops on `focus`.
 *
 * Only `focus` captures. A `screenshot` or `zoom` asked of `background` (a background
 * thread's look, a thread's eyes) is taken by `focus` (CAPTURE_OPS): two capturing
 * processes from one executable path livelock replayd while the screen is locked and
 * wedge the second one's serial queue.
 *
 * What one capturing process costs (none of it touches "your hands win": a capture never
 * posts, and the busy guard, the type watch, the lease and `cancelAll` are unchanged):
 * - a reading-side capture waits behind the acting queue. A main-lane `open_app` (up to
 *   30 s) or a `type` longer than 6 s times out a background thread's shot; that timeout
 *   fails `capture_failed`, so its screenshot falls back to `screencapture`;
 * - a thread's eyes shot adds about 100 to 300 ms to the acting queue (during dictation, say);
 * - the cold wake shot (0.4 to 1.6 s) sits on the acting queue at wake, so a spoken click
 *   right after a wake waits behind it.
 */
export interface HandsPoolOptions extends NativeHandsProcessOptions {
  /** Per-helper overrides (a test hands each helper its own fake). */
  readonly background?: Partial<NativeHandsProcessOptions>;
}

export class HandsPool {
  readonly focus: NativeHandsProcess;
  readonly background: NativeHandsProcess;

  constructor(opts: HandsPoolOptions) {
    const { background, ...shared } = opts;
    this.focus = new NativeHandsProcess(shared);
    // One ScreenCaptureKit process: the reading helper's captures are the acting helper's.
    this.background = new NativeHandsProcess({ ...shared, ...(background ?? {}), captures: this.focus });
  }

  /** Both helpers, acting one first. */
  get all(): readonly [NativeHandsProcess, NativeHandsProcess] {
    return [this.focus, this.background];
  }

  /** The acting helper is running (what the status line means by "hands ready"); `background.ready` for the other. */
  get ready(): boolean {
    return this.focus.ready;
  }

  /** Is either helper running? */
  get anyReady(): boolean {
    return this.focus.ready || this.background.ready;
  }

  /** The binary exists (one binary, so one answer). */
  get available(): boolean {
    return this.focus.available;
  }

  /** Requests in flight on both helpers. */
  get pendingCount(): number {
    return this.focus.pendingCount + this.background.pendingCount;
  }

  /**
   * A cut: every pending request on both helpers fails `cancelled`. Each client sends
   * SIGURG only when it has a `type` in flight — so the signal reaches the child that
   * is typing and no other. Returns how many requests were dropped in all.
   */
  cancelAll(reason = "stopped"): number {
    return this.focus.cancelPending(reason) + this.background.cancelPending(reason);
  }

  /** A grant landed: TCC answers are per process, so both helpers restart to read it. Both are tried; the first failure is rethrown after. */
  async restartAll(): Promise<void> {
    const results = await Promise.allSettled(this.all.map((h) => h.restart()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }

  /** Shutdown: both helpers stopped, every pending failed `unavailable`. */
  stop(): void {
    for (const h of this.all) h.stop();
  }
}

// ------------------------------------------------------------- SplitHands

export type HandsRoute = "focus" | "background";

/**
 * Ops that post an event, activate an app, drive a browser page or otherwise change
 * what the next read would see. They go to the acting helper, whose serial queue is
 * the order Kevin's screen sees them in.
 */
export const ACTING_OPS: ReadonlySet<string> = new Set(["click", "move", "drag", "scroll", "type", "key", "hold_key", "mouse_down", "mouse_up", "open_app", "focus_app", "browser_js", "browser_navigate", "wait"]);

/**
 * Ops that only look and can be answered by any process: they go to the reading
 * helper so a read never queues behind a `type` (≥ 8 ms per grapheme) or an `open_app`
 * (up to 30 s) on the acting one. `screenshot` is NOT here: it sets the frame the next
 * coordinate click is aimed at, so it must see the act it follows — on the acting
 * helper's queue that ordering is free; on the other process it could capture before a
 * queued `type` lands. `zoom` is not here either: it captures, and only the acting
 * helper captures (CAPTURE_OPS; HandsPool forwards a capture asked of the reading one).
 * `user_idle` stays with the acting helper too: its `foreignMs` excludes only the posts
 * of the process asked, and the acting helper is the one whose posts are Jarhead's.
 */
export const READ_OPS: ReadonlySet<string> = new Set(["cursor", "frontmost", "windows", "focused_text", "element_at", "find_element", "ax_tree", "browser_url", "browser_tabs", "displays"]);

/** What every helper op is routed to by default; unknown ops go to `focus` (an op nobody classified may act). */
export function defaultRoute(op: string): HandsRoute {
  return READ_OPS.has(op) ? "background" : "focus";
}

/** The two helpers a SplitHands routes over — a `HandsPool`, or two fakes in a test. */
export interface HandsPair {
  readonly focus: NativeHands;
  readonly background: NativeHands;
}

/**
 * One `NativeHands` for the main toolset over both helpers: reads on `background`,
 * acts (and the frame-setting screenshot, the clipboard-adjacent `type`, browser
 * scripting) on `focus`. The gate's probes, the observer's reads and the model's own
 * frontmost_app / find_element then never wait behind the brain's or a thread's `type`
 * — the design's "a read during a 2 s type < 20 ms". Nothing about the verdicts
 * moves: `expectFront`, `busy`, STALE_FRAME and presence are judged in the acting
 * helper immediately before the post and in the gate, exactly as before, so a probe
 * answered by the other process changes no decision — only how long it took.
 *
 * `routes` overrides the table per op (a test, or an A/B). Over a HandsPool a capture
 * routed to `background` is still taken by `focus` (CAPTURE_OPS). A cut / restart /
 * stop reaches both helpers through the pool when the pair is one.
 */
export class SplitHands implements NativeHands {
  private readonly routes: ReadonlyMap<string, HandsRoute>;

  constructor(
    private readonly pair: HandsPair,
    routes: Partial<Record<string, HandsRoute>> = {},
  ) {
    this.routes = new Map(Object.entries(routes).filter((e): e is [string, HandsRoute] => e[1] === "focus" || e[1] === "background"));
  }

  /** The acting helper. */
  get focus(): NativeHands {
    return this.pair.focus;
  }

  /** The reading helper. */
  get background(): NativeHands {
    return this.pair.background;
  }

  /** "hands ready" means the acting helper (what the status line has always meant). */
  get ready(): boolean {
    return this.pair.focus.ready;
  }

  /** Which helper answers `op`. */
  routeOf(op: string): HandsRoute {
    return this.routes.get(op) ?? defaultRoute(op);
  }

  request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const helper = this.routeOf(op) === "background" ? this.pair.background : this.pair.focus;
    return helper.request<T>(op, params, timeoutMs);
  }

  /** A cut: every pending request on both helpers fails `cancelled` (the typing child alone gets the signal). Returns how many were dropped. */
  cancelAll(reason = "stopped"): number {
    let n = 0;
    for (const h of [this.pair.focus, this.pair.background]) {
      const cancel = (h as Partial<Pick<NativeHandsProcess, "cancelPending">>).cancelPending;
      if (typeof cancel === "function") n += cancel.call(h, reason);
    }
    return n;
  }

  /** A grant landed: both processes restart to read it. */
  async restartAll(): Promise<void> {
    const results = await Promise.allSettled(
      [this.pair.focus, this.pair.background].map(async (h) => {
        const restart = (h as Partial<Pick<NativeHandsProcess, "restart">>).restart;
        if (typeof restart === "function") await restart.call(h);
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
  }

  /** Shutdown: both helpers. */
  stop(): void {
    for (const h of [this.pair.focus, this.pair.background]) {
      const stop = (h as Partial<Pick<NativeHandsProcess, "stop">>).stop;
      if (typeof stop === "function") stop.call(h);
    }
  }
}
