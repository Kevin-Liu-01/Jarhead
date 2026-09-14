import { logger } from "@jarhead/core";
import { READ_ONLY_TOOLS, renderObservation, type ScreenStateCache } from "@jarhead/hands";
import { ACTING_TOOLS, type RunOutcome } from "@jarhead/brain";
import type { Point } from "@jarhead/protocol";

/**
 * Two things a lane's runner does around every tool call, both options a runner
 * SUBCLASS takes (packages/brain/src/runner.ts is a rail: never edited, only wrapped):
 *
 * - `ActionObserver` — after an acting tool answered ok, read the screen state on the
 *   reading helper (150 ms after the ack; 400 ms after a browser click or navigation,
 *   which land later) and end the result with one `now:` line: the front app, the
 *   focused element, what is under the pointer. The model verifies from the result
 *   (the standing orders already say results are the verification) instead of taking
 *   the screenshot that follows 45 % of acting steps and costs the slowest generation.
 *
 * - `ActingSerializer` — concurrent tool.run frames are legal end to end (the bridge
 *   multiplexes, the daemon dispatches fire-and-forget, the runner has no lock), so on
 *   Codex nothing ordered acting calls or stopped after a needs-confirmation. Here:
 *   read-only calls run at once, acting calls of one lane run one at a time in arrival
 *   order, and a needs-confirmation / refusal / error halts every acting call already
 *   queued behind it (they answer batch.ts's haltReason text instead of running).
 */

const log = logger("engine.observe");

/** Tools whose effect lands later than the ack (a page load, a DOM click's handlers): a longer settle before the read. */
export const SLOW_SETTLE_TOOLS: ReadonlySet<string> = new Set(["browser_click", "browser_navigate"]);

/**
 * What a BACKGROUND lane's observer watches: the browser tools only. A background
 * thread never touches the pointer or the front app, so a line about Kevin's front
 * window after its `tell application "Spotify" to play` is 150–300 ms spent on a nudge
 * in the wrong direction; a page load is worth the line. Pass as `only`.
 */
export const BACKGROUND_OBSERVES: ReadonlySet<string> = new Set(["browser_navigate", "browser_click", "browser_type"]);

/** The settle before the read (named for the observer: @jarhead/hands has its own SETTLE_MS for the lease). */
export const OBSERVE_SETTLE_MS = 150;
export const OBSERVE_SLOW_SETTLE_MS = 400;
/** The read is raced against this: a slow app never holds an acting result hostage. */
export const OBSERVE_BUDGET_MS = 300;

export interface ActionObserverOptions {
  /** The cache over the READING helper (never the acting one: the read must not queue behind the act it observes). */
  readonly state: ScreenStateCache;
  /** Observe only these tools (∩ ACTING_TOOLS) — BACKGROUND_OBSERVES for a background lane. Default: every acting tool. */
  readonly only?: ReadonlySet<string>;
  /** The runner's redactor: the line is appended after `redactResult` and must itself carry no secret (I7). */
  readonly redact?: (text: string) => string;
  /** `Settings.observe` — read per call so the A/B flips without a restart. */
  readonly enabled?: () => boolean;
  readonly now?: () => number;
  readonly settleMs?: number;
  readonly slowSettleMs?: number;
  readonly budgetMs?: number;
  /** Test seam for the settle timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A point (global) the action landed on, when the caller knows it (the toolset's `onAction` points); else the pointer is asked. */
  readonly pointOf?: (name: string, args: Record<string, unknown>) => Point | undefined;
  /** The line as appended, for a note on the timeline or a counter. */
  readonly onLine?: (name: string, line: string, ms: number) => void;
}

export class ActionObserver {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Acting results that carried a line / that were eligible, for the bench's "observed" ratio. */
  observed = 0;
  eligible = 0;

  constructor(private readonly opts: ActionObserverOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The settle before the read for `name`. */
  settleFor(name: string): number {
    return SLOW_SETTLE_TOOLS.has(name) ? this.opts.slowSettleMs ?? OBSERVE_SLOW_SETTLE_MS : this.opts.settleMs ?? OBSERVE_SETTLE_MS;
  }

  /** Does this observer watch `name`? An acting tool, and one of `only` when the lane named some. */
  observes(name: string): boolean {
    return ACTING_TOOLS.has(name) && (this.opts.only === undefined || this.opts.only.has(name));
  }

  /**
   * `out` with the `now:` line appended, when `name` is an acting tool that answered a
   * text result; unchanged for a look, a question, a refusal, an error, a disabled
   * setting, or a read that landed nothing within the budget. Never throws.
   */
  async annotate(name: string, args: Record<string, unknown>, out: RunOutcome): Promise<RunOutcome> {
    if (this.opts.enabled && !this.opts.enabled()) return out;
    if (!this.observes(name) || out.result.kind !== "text") return out;
    this.eligible++;
    const t0 = this.now();
    try {
      const state = this.opts.state;
      // What was in front before the action, for "(was X)"; then the act made it stale.
      const before = state.get(Number.POSITIVE_INFINITY);
      state.invalidate(`after ${name}`);
      await this.sleep(this.settleFor(name));
      const point = this.opts.pointOf?.(name, args);
      const after = await state.refresh({ focused: true, ...(point ? { point } : { underCursor: true }) }, this.opts.budgetMs ?? OBSERVE_BUDGET_MS);
      const settled = this.now() - t0;
      const raw = renderObservation(before, after, { name, ...(point ? { point } : {}), settleMs: settled });
      if (!raw) return out;
      const line = this.opts.redact ? this.opts.redact(raw) : raw;
      this.observed++;
      this.opts.onLine?.(name, line, settled);
      return { ...out, result: { kind: "text", text: out.result.text ? `${out.result.text}\n${line}` : line } };
    } catch (e) {
      log.debug(`observe ${name}: ${(e as Error).message}`);
      return out;
    }
  }
}

// ---------------------------------------------------------- ActingSerializer

/**
 * Tools that never take the lane's acting queue: the looks (READ_ONLY_TOOLS), the
 * passive tools that wait or speak — a `thread_wait` of 240 s or a `speak_progress` in
 * the queue would hold every act behind it for nothing — and the hands-free management
 * tools: a `thread_start` issued in the same breath as a `left_click` (the split rule
 * asks for exactly that) must not wait behind the click nor be halted when the click
 * asks Kevin — Spotify's thread has nothing to do with the Send button. `self_*` stay
 * in the queue: they act on Jarhead's own code. Everything else acts, or may.
 */
export const SERIALIZER_BYPASS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS,
  "speak_progress", "remember",
  "thread_start", "thread_wait", "thread_read", "thread_stop",
  "agent_start", "agent_send", "agent_wait", "agent_read",
]);

/** batch.ts's words for a call not run because an earlier one in the same batch did not go through (serializer.test.ts pins them equal). */
export function haltReasonFor(name: string, outcome: RunOutcome): string | undefined {
  switch (outcome.result.kind) {
    case "needs-confirmation":
      return `not run: ${name} is waiting for Kevin's answer; ask him and stop`;
    case "error":
      return /^refused:/.test(outcome.result.message) ? `not run: ${name} was refused earlier in this turn` : `not run: ${name} failed earlier in this turn (${outcome.result.message.slice(0, 120)})`;
    default:
      return undefined;
  }
}

export interface ActingSerializerOptions {
  /** Tools that bypass the queue (default SERIALIZER_BYPASS); a runner subclass adds its own passive tools. */
  readonly bypass?: ReadonlySet<string>;
  readonly now?: () => number;
}

interface Queued {
  readonly seq: number;
  readonly name: string;
  /** Resolves when this call may start; `undefined` = run, a string = answer it without running. */
  readonly gate: Promise<string | undefined>;
  resolve: (halt: string | undefined) => void;
  /** The lane was idle at arrival: the call starts on the caller's tick, no gate awaited. */
  readonly ready: boolean;
}

/**
 * One acting op in flight per lane, arrival order (I1); reads never wait (I3); a
 * needs-confirmation, a refusal or an error halts the acting calls ALREADY QUEUED behind
 * it — the ones the model issued in the same breath, planned on the assumption the
 * earlier one worked (I2) — and a call issued later (the model saw the question and
 * re-planned) runs; `drain(reason)` answers every queued call `stopped: <reason>` (I6).
 * Because acts are one at a time, call N's gate runs after call N−1 landed, so an armed
 * confirmation is consumed once and a grant born mid-generation applies only to later
 * calls (I5). The verdicts themselves are judged where they always were (I4).
 */
export class ActingSerializer {
  private readonly queue: Queued[] = [];
  private running: Queued | undefined;
  private seq = 0;
  /** Acting calls that ran / were answered without running, for the tests and the bench. */
  ran = 0;
  halted = 0;

  constructor(private readonly opts: ActingSerializerOptions = {}) {}

  /** Acting calls waiting behind the one in flight. */
  get pending(): number {
    return this.queue.length;
  }

  /** The acting call in flight, if any. */
  get inFlight(): string | undefined {
    return this.running?.name;
  }

  /** Does `name` take the queue? */
  serializes(name: string): boolean {
    return !(this.opts.bypass ?? SERIALIZER_BYPASS).has(name);
  }

  /** Run `fn` for tool `name`: at once for a read, in its turn for an act (at once too when the lane is idle — no tick is spent). */
  async run(name: string, fn: () => Promise<RunOutcome>): Promise<RunOutcome> {
    if (!this.serializes(name)) return fn();
    const entry = this.enqueue(name);
    const halt = entry.ready ? undefined : await entry.gate;
    if (halt !== undefined) {
      this.halted++;
      this.finish(entry);
      return { result: { kind: "error", message: halt }, ms: 0 };
    }
    let out: RunOutcome;
    try {
      out = await fn();
    } catch (e) {
      out = { result: { kind: "error", message: (e as Error).message }, ms: 0 };
    }
    this.ran++;
    const reason = haltReasonFor(name, out);
    // Halt what was queued behind this call at the moment it settled — not what comes later.
    if (reason) for (const q of this.queue) q.resolve(reason);
    this.finish(entry);
    return out;
  }

  /** A stop: every queued acting call answers `stopped: <reason>`; the one in flight is the toolset's to refuse (cancelPending did). */
  drain(reason: string): number {
    const n = this.queue.length;
    for (const q of this.queue) q.resolve(`stopped: ${reason}`);
    return n;
  }

  private enqueue(name: string): Queued {
    let resolve!: (halt: string | undefined) => void;
    const gate = new Promise<string | undefined>((r) => (resolve = r));
    const ready = this.running === undefined;
    const entry: Queued = { seq: ++this.seq, name, gate, resolve, ready };
    if (ready) {
      this.running = entry;
      resolve(undefined);
    } else this.queue.push(entry);
    return entry;
  }

  /** The call is over: the next queued one (halted or not) takes the slot. */
  private finish(entry: Queued): void {
    if (this.running !== entry) {
      // A halted call that never held the slot: just leave the queue.
      const i = this.queue.indexOf(entry);
      if (i >= 0) this.queue.splice(i, 1);
      return;
    }
    const next = this.queue.shift();
    this.running = next;
    // A call whose gate was already settled (halted / drained) still takes the slot briefly and
    // releases it in its own `run`; a fresh one is let through now.
    next?.resolve(undefined);
  }
}
