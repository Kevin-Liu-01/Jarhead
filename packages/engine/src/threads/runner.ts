import { logger } from "@jarhead/core";
import { ACTING_MEMBERS, USER_IDLE_POLL_MS, WAIT_MAX_MS, isBusyResult, type AcquireOptions, type ConfirmationDesk, type FocusLease, type LeaseOutcome, type ToolResult } from "@jarhead/hands";
import { ToolRunner, type BrainSink, type BrainTask, type RunOutcome, type RunnerOptions } from "@jarhead/brain";
import { ACTING_TOOLS, FOCUS_APPLESCRIPT } from "@jarhead/brain";

/**
 * The runners a thread's tools go through. `runner.ts` in @jarhead/brain is a rail:
 * `LaneRunner` (a spawned thread's) and `ThreadAwareRunner` (the main lane's — the
 * engine's `runner`) subclass ToolRunner through `LeasedRunner`, what the two share,
 * and re-record the step the base records; they never edit it.
 *
 * `background` never touches the pointer, keyboard or front app — Apple events,
 * browser_*, files, shell, web — and is refused the rest HERE, not in policy.ts
 * (a rail). `screen` waits its turn for the one FocusLease, ranked by admission
 * (Kevin's hands > the main lane > threads by age; the lease's `rank` is the lease's
 * business — taken here as an option and handed through). Two hooks for the speed
 * pass ride as options: an `observer` that annotates every ACTING tool's result with
 * what is now in front (after `super.run`, never inside the rail) and a `serializer`
 * that orders acting calls under the lease.
 */

const log = logger("engine.threads.runner");

// ---------------------------------------------------------------- tables

/** A spawned thread's lane: never `voice` (that is the main thread's). */
export type SpawnLane = "screen" | "background";

/** The thread tools: the main brain's four verbs over its spawned threads. */
export const THREAD_TOOLS: ReadonlySet<string> = new Set(["thread_start", "thread_wait", "thread_read", "thread_stop"]);

/** Tools that need the pointer, keyboard, front app or the system clipboard: the lease's business. */
export const FOCUS_TOOLS: ReadonlySet<string> = new Set([...ACTING_MEMBERS, "open_url", "browser_click", "browser_type", "clipboard_read", "clipboard_write"]);

/**
 * A shell head that brings something to the front: `open` (unless a flag cluster
 * carries g or j, or `--background` / `--hide`) or `osascript`. Judged on EVERY
 * command of a compound line (`ls && open -a Slack`, `cd x; open .`, `echo | osascript`),
 * past `sudo` / `env VAR=x` / `nohup` and past the head's directory (`/usr/bin/open`).
 */
export const BACKGROUND_SHELL_REFUSE = /^(?:open|osascript)$/;
/** `open` flags that keep the opened thing in the background: -g (do not bring forward), -j (hidden), in any cluster (`-ga`, `-gj`). */
const OPEN_BACKGROUND_FLAG = /^-[A-Za-z]*[gj][A-Za-z]*$|^--(?:background|hide)$/;
/** Words that run another command rather than being one; their own flags are skipped with them. */
const SHELL_PREFIXES: ReadonlySet<string> = new Set(["sudo", "env", "nohup", "exec", "command", "time", "nice", "caffeinate", "builtin", "doas"]);

/** Depth one: a spawned thread never spawns a thread and never edits Jarhead. */
export const DENIED_FOR_THREADS: ReadonlySet<string> = new Set([...THREAD_TOOLS, "self_edit", "self_check", "self_review", "self_apply", "self_discard", "self_status"]);

export const LANE_REFUSAL = "refused: this hand runs in the background lane — the pointer and keyboard are not its; use applescript (Apple events), browser_*, files, shell or web, or report that the screen is needed";

/**
 * Jarhead's own hands wait this long for a thread's op in flight (never mid-op; a long
 * `type` is bounded by the helper's own timeout) before the lease is cut and taken.
 */
export const MAIN_LEASE_WAIT_MS = 30_000;

/** Whether a tool call, with these arguments, acts on the screen (and so needs the lease, or the background refusal). */
export function needsFocus(name: string, args: Record<string, unknown>): boolean {
  if (FOCUS_TOOLS.has(name)) return true;
  if (name === "applescript") return FOCUS_APPLESCRIPT.test(String(args["script"] ?? ""));
  if (name === "run_shell") return shellSteals(String(args["command"] ?? ""));
  return false;
}

/**
 * Does any command in this line front an app? Every segment of `a; b && c | d` is
 * judged: its wrappers (`sudo`, `env VAR=x`, `nohup`) and `VAR=value` heads skipped,
 * the head's directory dropped, `open` allowed only with a background flag.
 */
export function shellSteals(command: string): boolean {
  return shellSegments(command).some((segment) => {
    const words = shellWords(segment);
    const head = words[0];
    if (!head || !BACKGROUND_SHELL_REFUSE.test(head)) return false;
    if (head === "osascript") return true;
    return !words.slice(1).some((w) => OPEN_BACKGROUND_FLAG.test(w));
  });
}

/** The line split at `;`, `&`, `&&`, `|`, `||` and newlines outside quotes (good enough for the head test: a quoted separator is an argument). */
function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"') {
        cur += command[i + 1] ?? "";
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** A segment's words with the command's wrappers and leading assignments gone, the head reduced to its lower-cased basename. */
function shellWords(segment: string): string[] {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  let afterPrefix = false;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (SHELL_PREFIXES.has(basename(w))) {
      afterPrefix = true;
      i++;
      continue;
    }
    if (afterPrefix && w.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  if (rest[0] !== undefined) rest[0] = basename(rest[0]).toLowerCase();
  return rest;
}

function basename(word: string): string {
  const bare = word.replace(/^["']|["']$/g, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
}

// ------------------------------------------------------- step recording
// The base ToolRunner.run records a step for every result; the subclasses below
// answer some calls without the base and must record the same shape (runner.ts is a
// rail: mirrored here, never edited).

export function argsOf(input: unknown): Record<string, unknown> {
  return (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  return out;
}

function summarizeResult(result: ToolResult): unknown {
  switch (result.kind) {
    case "image":
      return { image: `${result.width}x${result.height}`, ...(result.note ? { note: result.note } : {}) };
    case "text":
      return result.text.length > 600 ? `${result.text.slice(0, 600)}…` : result.text;
    case "error":
      return { error: result.message };
    case "needs-confirmation":
      return { needsConfirmation: result.question };
  }
}

export function recordStep(sink: BrainSink | undefined, name: string, args: Record<string, unknown>, result: ToolResult, ms: number): void {
  sink?.step({
    kind: result.kind === "needs-confirmation" ? "confirm" : result.kind === "error" ? "error" : "tool",
    ...(result.kind === "needs-confirmation" ? { text: result.question } : result.kind === "error" ? { text: result.message } : {}),
    tool: { name, input: redactArgs(args), output: summarizeResult(result), ok: result.kind !== "error", ms },
  });
}

/** The helper's `busy` refusal as the base runner records it (`busy: Kevin used the keyboard/mouse …`): not a step while the lease retries it. */
const BUSY_STEP = /^busy: /i;

/** The sink the base records through: a `busy` refusal mid-retry is dropped (the retry is silent); everything else passes. */
function quietSink(raw: BrainSink, retrying: () => boolean): BrainSink {
  return {
    thinking: (text) => raw.thinking(text),
    commentary: (text) => raw.commentary(text),
    screenshot: (path, note) => raw.screenshot(path, note),
    step: (step) => {
      if (retrying() && step.kind === "error" && BUSY_STEP.test(step.text ?? "")) return;
      raw.step(step);
    },
  };
}

// ------------------------------------------------------------ the hooks

/**
 * The speed pass's observer (packages/engine/src/observe.ts): after an ACTING tool
 * landed, its result gains a `now:` line — front app, focused element, what is under
 * the pointer. Structural here so this file needs nothing from that one.
 */
export interface ActionObserverLike {
  annotate(name: string, args: Record<string, unknown>, out: RunOutcome): Promise<RunOutcome> | RunOutcome;
}

/** The speed pass's serializer: acting calls in order (read-only ones run concurrently); a needs_confirmation halts the queue. */
export interface ActingSerializerLike {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface LeasedRunnerOptions extends RunnerOptions {
  readonly observer?: ActionObserverLike | undefined;
  readonly serializer?: ActingSerializerLike | undefined;
  /** The set the observer and the serializer apply to (default ACTING_TOOLS). */
  readonly actingTools?: ReadonlySet<string> | undefined;
}

// ---------------------------------------------------------- LeasedRunner

/**
 * What the two lane runners share: the sink and task the base holds (kept here too,
 * for the records a subclass answers itself), the lease released when the turn ends
 * (`attach(undefined)`), and one screen tool run under the lease. The op counts as in
 * flight — a priority taker waits for it, never mid-op — and a `busy` answer (Kevin's
 * hands on the machine) is retried silently until it lands or WAIT_MAX_MS pass: the
 * refusals are not steps (the base records one per attempt; those are dropped while
 * the retry runs — the Console would otherwise show a burst of red rows every time
 * Kevin's keystroke met Jarhead's), and one note says how long the hands waited. When
 * the wait runs out the last refusal is the answer and is recorded once. Nothing is
 * posted meanwhile.
 */
export abstract class LeasedRunner extends ToolRunner {
  protected sinkRef: BrainSink | undefined;
  protected taskRef: BrainTask | undefined;
  protected readonly clock: () => number;
  private retrying = 0;
  protected observer: ActionObserverLike | undefined;
  protected serializer: ActingSerializerLike | undefined;
  protected readonly actingTools: ReadonlySet<string>;

  constructor(
    opts: LeasedRunnerOptions,
    protected readonly lease: FocusLease,
    /** This runner's name on the lease (the thread id; "jarhead" for the main lane). */
    protected readonly actor: string,
  ) {
    super(opts);
    this.clock = opts.now ?? Date.now;
    this.observer = opts.observer;
    this.serializer = opts.serializer;
    this.actingTools = opts.actingTools ?? ACTING_TOOLS;
  }

  /** The speed pass wires these after construction (the engine owns both). */
  setHooks(hooks: { readonly observer?: ActionObserverLike | undefined; readonly serializer?: ActingSerializerLike | undefined }): void {
    if ("observer" in hooks) this.observer = hooks.observer;
    if ("serializer" in hooks) this.serializer = hooks.serializer;
  }

  override attach(sink: BrainSink | undefined, task?: BrainTask): void {
    super.attach(sink ? quietSink(sink, () => this.retrying > 0) : undefined, task);
    this.sinkRef = sink;
    if (task) this.taskRef = task;
    if (!sink) {
      this.taskRef = undefined;
      this.lease.release(this.actor, "turn-end");
    }
  }

  /**
   * The base runner's run, with the two hooks around it: the serializer orders an
   * acting call; the observer annotates its result once it landed. Never inside the
   * rail — after `super.run`, before the step is finished for the sink's reader.
   */
  protected async runBase(name: string, input: unknown): Promise<RunOutcome> {
    const acting = this.actingTools.has(name);
    const out = acting && this.serializer ? await this.serializer.run(name, () => super.run(name, input)) : await super.run(name, input);
    if (!acting || !this.observer || out.result.kind !== "text") return out;
    try {
      return await this.observer.annotate(name, argsOf(input), out);
    } catch (e) {
      log.debug(`observer for ${name}: ${(e as Error).message}`);
      return out;
    }
  }

  /** The screen tool itself, under the lease: in flight for its duration, `busy` retried silently. */
  protected async actUnderLease(name: string, args: Record<string, unknown>, run: () => Promise<RunOutcome>): Promise<RunOutcome> {
    const t0 = this.clock();
    let busy = 0;
    this.retrying++;
    let out: RunOutcome;
    try {
      out = await this.lease.act(this.actor, () =>
        this.lease.retryBusy(
          run,
          (o) => {
            const b = isBusyResult(o.result);
            if (b) busy++;
            return b;
          },
          { signal: this.taskRef?.signal },
        ),
      );
    } finally {
      this.retrying--;
    }
    if (busy === 0) return out;
    if (isBusyResult(out.result)) recordStep(this.sinkRef, name, args, out.result, out.ms);
    else this.sinkRef?.step({ kind: "note", text: `waited ${this.clock() - t0} ms for Kevin's hands` });
    return out;
  }
}

// ------------------------------------------------------------ LaneRunner

export interface LaneRunnerOptions extends LeasedRunnerOptions {
  readonly lane: SpawnLane;
  readonly laneId: string;
  readonly lease: FocusLease;
  /** The desk, for the queued-question text and the floor's name. */
  readonly desk: ConfirmationDesk;
  /** The lane is waiting for the screen (true) or has it / gave up (false). */
  readonly onWaiting?: ((waiting: boolean, reason?: string) => void) | undefined;
  /** Every result this lane produced, after the base recorded it: the scheduler counts waits, questions and holds. */
  readonly onOutcome?: ((name: string, result: ToolResult) => void) | undefined;
  /** The thread's place in the lease's line (its admission index); the lease grants the lowest first. */
  readonly rank?: number | undefined;
}

/** `AcquireOptions` plus the rank the lease learns in this pass (packages/hands/src/lease.ts, B3): passed through, never required. */
type RankedAcquire = AcquireOptions & { readonly rank?: number | undefined };

/**
 * A spawned thread's runner. Refuses what is not a thread's (thread_*,
 * self_*), refuses screen work in the background lane with one line, and in the
 * screen lane takes the lease around every screen tool (waiting at most WAIT_MAX_MS,
 * then answering "waiting for the screen"). A queued confirmation's text says whose
 * question it waits behind. `attach(undefined)` — the thread's turn ended — releases
 * the lease.
 */
export class LaneRunner extends LeasedRunner {
  private lane: SpawnLane;
  private rank: number | undefined;
  private readonly laneOpts: LaneRunnerOptions;

  constructor(opts: LaneRunnerOptions) {
    super(opts, opts.lease, opts.laneId);
    this.laneOpts = opts;
    this.lane = opts.lane;
    this.rank = opts.rank;
  }

  get laneId(): string {
    return this.actor;
  }

  get laneKind(): SpawnLane {
    return this.lane;
  }

  /** A spare is built on the background lane and told its lane when it is used. */
  setLane(lane: SpawnLane): void {
    this.lane = lane;
  }

  /** Its place in the lease's line, set at admission. */
  setRank(rank: number | undefined): void {
    this.rank = rank;
  }

  override async run(name: string, input: unknown): Promise<RunOutcome> {
    const started = this.clock();
    const args = argsOf(input);
    if (DENIED_FOR_THREADS.has(name)) return this.answer(name, args, { kind: "error", message: `refused: ${name} is not a spawned thread's (depth one: a thread never spawns or edits Jarhead)` }, started);
    // design11: a headless `wake-brain` turn runs on this lane; a briefing never arms more automations or edits the recipes.
    if (this.lane === "background" && /^(automation|recipe)_/.test(name)) return this.answer(name, args, { kind: "error", message: `refused: ${name} is not a background lane's (an automation is set in the conversation, never by a headless turn)` }, started);
    const focus = needsFocus(name, args);
    if (focus && this.lane === "background") return this.answer(name, args, { kind: "error", message: LANE_REFUSAL }, started);
    if (!focus) return this.finish(name, await this.runBase(name, input));
    const got = await this.acquireOrWait();
    if (!got.ok) return this.answer(name, args, { kind: "error", message: `waiting for the screen: ${got.reason}; do the rest first, or call it again` }, started);
    if (got.refocused) this.sinkRef?.step({ kind: "note", text: `brought ${got.refocused} back to the front` });
    const out = await this.actUnderLease(name, args, () => this.runBase(name, input));
    // The app this lane works in, for the re-front on a later hand-over.
    if ((name === "open_app" || name === "focus_app") && out.result.kind === "text") this.lease.rememberFront(this.actor, String(args["name"] ?? args["app"] ?? ""));
    if (out.result.kind === "needs-confirmation") this.lease.release(this.actor, "question");
    return this.finish(name, out);
  }

  /**
   * The lease, or the reason it is not to be had. The scheduler hears about the wait
   * (the rail's hourglass): at once when another lane holds the screen, else once a
   * poll has passed without it — Kevin's hands on the machine, an app he switched to.
   */
  private async acquireOrWait(): Promise<LeaseOutcome> {
    const holder = this.lease.holder;
    let told = false;
    const tell = (reason: string): void => {
      told = true;
      this.laneOpts.onWaiting?.(true, reason);
    };
    if (holder !== undefined && holder !== this.actor) tell(`${holder === ThreadAwareRunner.ACTOR ? "Jarhead's hands have" : holder === "dictation" ? "dictation has" : `thread ${holder} has`} the screen`);
    const slow = setTimeout(() => {
      if (!told) tell("the screen is not free yet");
    }, USER_IDLE_POLL_MS);
    slow.unref?.();
    try {
      const o: RankedAcquire = { priority: false, signal: this.taskRef?.signal, timeoutMs: WAIT_MAX_MS, ...(this.rank !== undefined ? { rank: this.rank } : {}) };
      return await this.lease.acquire(this.actor, o);
    } finally {
      clearTimeout(slow);
      this.laneOpts.onWaiting?.(false);
    }
  }

  /** A result answered here (a refusal, a wait): recorded the way the base records its own. */
  private answer(name: string, args: Record<string, unknown>, result: ToolResult, started: number): RunOutcome {
    const ms = this.clock() - started;
    recordStep(this.sinkRef, name, args, result, ms);
    if (result.kind === "error") log.info(`${this.actor} ${name}: ${result.message.slice(0, 120)}`);
    this.laneOpts.onOutcome?.(name, result);
    return { result, ms };
  }

  /**
   * A question queued behind the floor reads as "Queued behind <Name>'s question …" (the
   * desk renders it) — and tells a thread to end its turn rather than wait on a tool that
   * is not a thread's; Jarhead resumes it when Kevin answers. Every outcome reaches the scheduler.
   */
  private finish(name: string, out: RunOutcome): RunOutcome {
    let result = this.laneOpts.desk.render(out.result);
    if (result.kind === "needs-confirmation" && result.question.includes("(thread_wait)")) result = { ...result, question: result.question.replace("(thread_wait)", "(end your turn; Jarhead resumes you when Kevin answers)") };
    this.laneOpts.onOutcome?.(name, result);
    return result === out.result ? out : { ...out, result };
  }
}

// ---------------------------------------------------- ThreadAwareRunner

/** As much of the scheduler as the main lane's runner needs: the thread tools. */
export interface ThreadToolSource {
  tool(name: string, args: Record<string, unknown>, ctx: { readonly task: BrainTask | undefined }): Promise<ToolResult>;
}

export interface ThreadAwareRunnerOptions extends LeasedRunnerOptions {
  readonly pool: ThreadToolSource;
  readonly lease: FocusLease;
  /** The desk, for the queued-question text when the main lane's question waits behind a thread's. */
  readonly desk: ConfirmationDesk;
}

/**
 * The main lane's runner (the engine's `runner`): every brain call, reflex and the
 * eyes' shot go through it. It answers `thread_*` from
 * the scheduler and records the step as the base would; for screen tools it takes
 * the lease with priority (Jarhead's own hands never wait on a thread's idle — only
 * on its op in flight and MIN_HOLD, and on Kevin's own hands through the helper's
 * busy answer) and releases it when the turn ends or a question is asked.
 */
export class ThreadAwareRunner extends LeasedRunner {
  private readonly mainOpts: ThreadAwareRunnerOptions;
  /** `thread_wait` calls in flight: the main brain is blocked on its threads and its hands touch nothing. */
  private waitingOn = 0;

  constructor(opts: ThreadAwareRunnerOptions) {
    super(opts, opts.lease, ThreadAwareRunner.ACTOR);
    this.mainOpts = opts;
  }

  static readonly ACTOR = "jarhead";

  /** The task under way on the main lane (a thread's parent), for the scheduler. */
  get currentTask(): BrainTask | undefined {
    return this.taskRef;
  }

  /** The main brain's turn is blocked in `thread_wait`: the ear need not hold for it (its hands are still). */
  get waitingOnThreads(): boolean {
    return this.waitingOn > 0;
  }

  override async run(name: string, input: unknown): Promise<RunOutcome> {
    const started = this.clock();
    const args = argsOf(input);
    if (THREAD_TOOLS.has(name)) {
      let result: ToolResult;
      const waits = name === "thread_wait";
      if (waits) this.waitingOn++;
      try {
        result = await this.mainOpts.pool.tool(name, args, { task: this.taskRef });
      } catch (e) {
        result = { kind: "error", message: (e as Error).message };
      } finally {
        if (waits) this.waitingOn--;
      }
      if (result.kind === "text") result = { kind: "text", text: this.redactor.redact(result.text) };
      else if (result.kind === "error") result = { kind: "error", message: this.redactor.redact(result.message) };
      const ms = this.clock() - started;
      recordStep(this.sinkRef, name, args, result, ms);
      if (result.kind === "error") log.warn(`${name}: ${result.message}`);
      return { result, ms };
    }
    if (!needsFocus(name, args)) return this.rendered(await this.runBase(name, input));
    const got = await this.takeScreen();
    if (got.ok && got.refocused) this.sinkRef?.step({ kind: "note", text: `brought ${got.refocused} back to the front` });
    const out = await this.actUnderLease(name, args, () => this.runBase(name, input));
    if ((name === "open_app" || name === "focus_app") && out.result.kind === "text") this.lease.rememberFront(ThreadAwareRunner.ACTOR, String(args["name"] ?? args["app"] ?? ""));
    if (out.result.kind === "needs-confirmation") this.lease.release(ThreadAwareRunner.ACTOR, "question");
    return this.rendered(out);
  }

  /**
   * The main lane's question, queued behind a thread's, reads as "Queued behind <Name>'s
   * question … stop and wait (thread_wait)" — not as a question to relay: Kevin hears one
   * question at a time, and this one is asked (by Jarhead itself) when the floor clears.
   */
  private rendered(out: RunOutcome): RunOutcome {
    const result = this.mainOpts.desk.render(out.result);
    return result === out.result ? out : { ...out, result };
  }

  /**
   * Jarhead's hands win — but never mid-op: a thread's op in flight (a long `type`)
   * finishes first, bounded by the helper's own timeout, then Jarhead's lands next.
   * Past MAIN_LEASE_WAIT_MS the lease is cut and taken, so the thread's next tool
   * waits on Jarhead instead of landing between its keystrokes. A stop or a cut
   * meanwhile is left to the base (the toolset refuses after a stop).
   */
  private async takeScreen(): Promise<LeaseOutcome> {
    const signal = this.taskRef?.signal;
    const got = await this.lease.acquire(ThreadAwareRunner.ACTOR, { priority: true, signal, timeoutMs: MAIN_LEASE_WAIT_MS });
    if (got.ok || got.reason === "cancelled" || got.reason === "cut") return got;
    const holder = this.lease.holder;
    log.warn(`main lane: ${got.reason} for ${MAIN_LEASE_WAIT_MS} ms; taking the screen`);
    this.lease.cancelAll("Jarhead's hands took the screen");
    this.sinkRef?.step({ kind: "note", text: `took the screen${holder ? ` from ${holder}` : ""} (${got.reason})` });
    return this.lease.acquire(ThreadAwareRunner.ACTOR, { priority: true, signal, timeoutMs: WAIT_MAX_MS });
  }
}
