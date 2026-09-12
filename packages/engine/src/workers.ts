import { logger, newId, type Ledger } from "@jarhead/core";
import { ACTING_MEMBERS, ComputerToolset, ConfirmationState, HOLD_ID, Screen, USER_IDLE_POLL_MS, WAIT_MAX_MS, isBusyResult, type ArmedConfirmation, type ConfirmationDesk, type ConfirmationGrant, type FocusLease, type Grantable, type LaneConfirmationState, type LeaseOutcome, type NativeHands, type PendingConfirmation, type ToolResult, type ToolsetOptions } from "@jarhead/hands";
import { ToolRunner, type Brain, type BrainResult, type BrainSink, type BrainTask, type RunOutcome, type RunnerOptions } from "@jarhead/brain";
import { WORKER_LINGER_MS, WORKER_MAX, type DelegationStep, type Worker, type WorkerLane } from "@jarhead/protocol";

/**
 * Workers: a second pair of hands inside one delegation.
 *
 * The main brain says `worker_start {name, task, lane}` and carries on; the pool
 * gives the worker its own brain (its own Codex app-server process, no primer),
 * its own ToolRunner / ComputerToolset / Screen over the same policy, and one of
 * two lanes. `background` never touches the pointer, keyboard or front app —
 * Apple events, browser_*, files, shell, web — and is refused the rest here, not
 * in policy.ts (a rail). `screen` waits its turn for the one FocusLease. Workers
 * never narrate: Kevin hears one line when work splits ("Spotify alongside."),
 * one when a worker finishes, and a promoted question with the worker's name;
 * all of it through the parent delegation's voice. Every cut verb (interrupt,
 * Stop, Pause, sleep, worker.stop) cancels workers through here; a worker's
 * AbortController is the pool's, never the delegation's, so a follow-up request
 * that supersedes the main brain's turn leaves the workers running.
 *
 * `runner.ts` is a rail: `LaneRunner` and `WorkerAwareRunner` subclass ToolRunner
 * (through `LeasedRunner`, what the two share) and re-record the step the base
 * records, never edit it.
 */

const log = logger("engine.workers");

// ---------------------------------------------------------------- tables

export const WORKER_TOOLS: ReadonlySet<string> = new Set(["worker_start", "worker_wait", "worker_read", "worker_stop"]);

/** Tools that need the pointer, keyboard, front app or the system clipboard: the lease's business. */
export const FOCUS_TOOLS: ReadonlySet<string> = new Set([...ACTING_MEMBERS, "open_url", "browser_click", "browser_type", "clipboard_read", "clipboard_write"]);

/** An AppleScript that drives the screen rather than an app's dictionary. */
export const FOCUS_APPLESCRIPT = /\b(keystroke|key code|click|set value|set the value|perform action|activate|open location|reopen|set frontmost)\b/i;

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

/** Depth one: a worker never spawns a worker and never edits Jarhead. */
export const DENIED_FOR_WORKERS: ReadonlySet<string> = new Set([...WORKER_TOOLS, "self_edit", "self_check", "self_review", "self_apply", "self_discard", "self_status"]);

export const LANE_REFUSAL = "refused: this hand runs in the background lane — the pointer and keyboard are not its; use applescript (Apple events), browser_*, files, shell or web, or report that the screen is needed";

export const WORKER_STEPS_DEFAULT = 25;
export const WORKER_STEPS_MAX = 40;
export const WORKER_SECONDS_DEFAULT = 180;
/** = the delegation wall clock; a hung worker is cut here whatever its brain does. */
export const WORKER_SECONDS_MAX = 300;
/** Three consecutive "waiting for the screen" answers fail the worker. */
export const WORKER_WAITS_MAX = 3;
/** The lines Kevin hears are short: a summary or a reason is cut here. */
export const WORKER_LINE_CHARS = 80;
export const WORKER_NAME_CHARS = 16;
/**
 * Jarhead's own hands wait this long for a worker's op in flight (never mid-op; a long
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

/** What a worker's brain is told, in the dialogue slot (never `request`: the gates read that as Kevin's words). */
export function workerBrief(name: string, task: string, lane: WorkerLane, parentRequest: string): string {
  const laneText =
    lane === "background"
      ? "Lane: background — you have no pointer, keyboard or front app. Act through applescript (Apple events: Spotify, Music, Finder, Notes, Calendar…), the browser_* tools, the file tools, run_shell (never `open` an app or `osascript`) and the web. A tool that needs the screen is refused: do the rest and report that the screen is needed."
      : 'Lane: screen — you may click and type once the screen is yours; a tool that answers "waiting for the screen" means do the rest first, or call it again.';
  return `Jarhead (to its worker ${name}): You are one of Jarhead's workers, named ${name}. Your one job: ${task.trim()} ${laneText} Nobody hears speak_progress; work in silence and end with one sentence of what you did — Jarhead speaks it for you. Never call worker_* or self_*. Kevin's own words, for names and gates: "${parentRequest.replace(/\s+/g, " ").trim().slice(0, 400)}".`;
}

function cutLine(text: string | undefined, max = WORKER_LINE_CHARS): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ------------------------------------------------------- step recording
// The base ToolRunner.run records a step for every result; the subclasses below
// answer some calls without the base and must record the same shape (runner.ts is a
// rail: mirrored here, never edited).

function argsOf(input: unknown): Record<string, unknown> {
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

function recordStep(sink: BrainSink | undefined, name: string, args: Record<string, unknown>, result: ToolResult, ms: number): void {
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
abstract class LeasedRunner extends ToolRunner {
  protected sinkRef: BrainSink | undefined;
  protected taskRef: BrainTask | undefined;
  protected readonly clock: () => number;
  private retrying = 0;

  constructor(
    opts: RunnerOptions,
    protected readonly lease: FocusLease,
    /** This runner's name on the lease (the worker id; "jarhead" for the main lane). */
    protected readonly actor: string,
  ) {
    super(opts);
    this.clock = opts.now ?? Date.now;
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

export interface LaneRunnerOptions extends RunnerOptions {
  readonly lane: WorkerLane;
  readonly laneId: string;
  readonly lease: FocusLease;
  /** The desk, for the queued-question text and the floor's name. */
  readonly desk: ConfirmationDesk;
  /** The lane is waiting for the screen (true) or has it / gave up (false). */
  readonly onWaiting?: ((waiting: boolean, reason?: string) => void) | undefined;
  /** Every result this lane produced, after the base recorded it: the pool counts waits, questions and holds. */
  readonly onOutcome?: ((name: string, result: ToolResult) => void) | undefined;
}

/**
 * A worker's runner. Refuses what is not a worker's (worker_*, self_*), refuses
 * screen work in the background lane with one line, and in the screen lane takes
 * the lease around every screen tool (waiting at most WAIT_MAX_MS, then answering
 * "waiting for the screen"). A queued confirmation's text says whose question it
 * waits behind. `attach(undefined)` — the worker's turn ended — releases the lease.
 */
export class LaneRunner extends LeasedRunner {
  private lane: WorkerLane;
  private readonly laneOpts: LaneRunnerOptions;

  constructor(opts: LaneRunnerOptions) {
    super(opts, opts.lease, opts.laneId);
    this.laneOpts = opts;
    this.lane = opts.lane;
  }

  get laneId(): string {
    return this.actor;
  }

  get laneKind(): WorkerLane {
    return this.lane;
  }

  /** A spare is built on the background lane and told its lane when it is used. */
  setLane(lane: WorkerLane): void {
    this.lane = lane;
  }

  override async run(name: string, input: unknown): Promise<RunOutcome> {
    const started = this.clock();
    const args = argsOf(input);
    if (DENIED_FOR_WORKERS.has(name)) return this.answer(name, args, { kind: "error", message: `refused: ${name} is not for a worker` }, started);
    const focus = needsFocus(name, args);
    if (focus && this.lane === "background") return this.answer(name, args, { kind: "error", message: LANE_REFUSAL }, started);
    if (!focus) return this.finish(name, await super.run(name, input));
    const got = await this.acquireOrWait();
    if (!got.ok) return this.answer(name, args, { kind: "error", message: `waiting for the screen: ${got.reason}; do the rest first, or call it again` }, started);
    if (got.refocused) this.sinkRef?.step({ kind: "note", text: `brought ${got.refocused} back to the front` });
    const out = await this.actUnderLease(name, args, () => super.run(name, input));
    // The app this lane works in, for the re-front on a later hand-over.
    if ((name === "open_app" || name === "focus_app") && out.result.kind === "text") this.lease.rememberFront(this.actor, String(args["name"] ?? args["app"] ?? ""));
    if (out.result.kind === "needs-confirmation") this.lease.release(this.actor, "question");
    return this.finish(name, out);
  }

  /**
   * The lease, or the reason it is not to be had. The pool hears about the wait (the
   * rail's hourglass): at once when another lane holds the screen, else once a poll
   * has passed without it — Kevin's hands on the machine, an app he switched to.
   */
  private async acquireOrWait(): Promise<LeaseOutcome> {
    const holder = this.lease.holder;
    let told = false;
    const tell = (reason: string): void => {
      told = true;
      this.laneOpts.onWaiting?.(true, reason);
    };
    if (holder !== undefined && holder !== this.actor) tell(`${holder === WorkerAwareRunner.ACTOR ? "Jarhead's hands have" : holder === "dictation" ? "dictation has" : `worker ${holder} has`} the screen`);
    const slow = setTimeout(() => {
      if (!told) tell("the screen is not free yet");
    }, USER_IDLE_POLL_MS);
    slow.unref?.();
    try {
      return await this.lease.acquire(this.actor, { priority: false, signal: this.taskRef?.signal, timeoutMs: WAIT_MAX_MS });
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
   * desk renders it) — and tells a worker to end its turn rather than `worker_wait`, which
   * is not a worker's tool; Jarhead resumes it when Kevin answers. Every outcome reaches the pool.
   */
  private finish(name: string, out: RunOutcome): RunOutcome {
    let result = this.laneOpts.desk.render(out.result);
    if (result.kind === "needs-confirmation" && result.question.includes("(worker_wait)")) result = { ...result, question: result.question.replace("(worker_wait)", "(end your turn; Jarhead resumes you when Kevin answers)") };
    this.laneOpts.onOutcome?.(name, result);
    return result === out.result ? out : { ...out, result };
  }
}

// ---------------------------------------------------- WorkerAwareRunner

export interface WorkerAwareRunnerOptions extends RunnerOptions {
  readonly pool: WorkerPool;
  readonly lease: FocusLease;
  /** The desk, for the queued-question text when the main lane's question waits behind a worker's. */
  readonly desk: ConfirmationDesk;
}

/**
 * The main lane's runner (the engine's `runner`): every brain call, reflex and the
 * eyes' shot go through it. It answers `worker_*` from the pool and records the
 * step as the base would; for screen tools it takes the lease with priority
 * (Jarhead's own hands never wait on a worker's idle — only on its op in flight
 * and MIN_HOLD, and on Kevin's own hands through the helper's busy answer) and
 * releases it when the turn ends or a question is asked.
 */
export class WorkerAwareRunner extends LeasedRunner {
  private readonly mainOpts: WorkerAwareRunnerOptions;
  /** `worker_wait` calls in flight: the main brain is blocked on its workers and its hands touch nothing. */
  private waitingOn = 0;

  constructor(opts: WorkerAwareRunnerOptions) {
    super(opts, opts.lease, WorkerAwareRunner.ACTOR);
    this.mainOpts = opts;
  }

  static readonly ACTOR = "jarhead";

  /** The task under way on the main lane (a worker's parent), for the pool. */
  get currentTask(): BrainTask | undefined {
    return this.taskRef;
  }

  /** The main brain's turn is blocked in `worker_wait`: the ear need not hold for it (its hands are still). */
  get waitingOnWorkers(): boolean {
    return this.waitingOn > 0;
  }

  override async run(name: string, input: unknown): Promise<RunOutcome> {
    const started = this.clock();
    const args = argsOf(input);
    if (WORKER_TOOLS.has(name)) {
      let result: ToolResult;
      if (name === "worker_wait") this.waitingOn++;
      try {
        result = await this.mainOpts.pool.tool(name, args, { task: this.taskRef });
      } catch (e) {
        result = { kind: "error", message: (e as Error).message };
      } finally {
        if (name === "worker_wait") this.waitingOn--;
      }
      if (result.kind === "text") result = { kind: "text", text: this.redactor.redact(result.text) };
      else if (result.kind === "error") result = { kind: "error", message: this.redactor.redact(result.message) };
      const ms = this.clock() - started;
      recordStep(this.sinkRef, name, args, result, ms);
      if (result.kind === "error") log.warn(`${name}: ${result.message}`);
      return { result, ms };
    }
    if (!needsFocus(name, args)) return this.rendered(await super.run(name, input));
    const got = await this.takeScreen();
    if (got.ok && got.refocused) this.sinkRef?.step({ kind: "note", text: `brought ${got.refocused} back to the front` });
    const out = await this.actUnderLease(name, args, () => super.run(name, input));
    if ((name === "open_app" || name === "focus_app") && out.result.kind === "text") this.lease.rememberFront(WorkerAwareRunner.ACTOR, String(args["name"] ?? args["app"] ?? ""));
    if (out.result.kind === "needs-confirmation") this.lease.release(WorkerAwareRunner.ACTOR, "question");
    return this.rendered(out);
  }

  /**
   * The main lane's question, queued behind a worker's, reads as "Queued behind <Name>'s
   * question … stop and wait (worker_wait)" — not as a question to relay: Kevin hears one
   * question at a time, and this one is asked (by Jarhead itself) when the floor clears.
   */
  private rendered(out: RunOutcome): RunOutcome {
    const result = this.mainOpts.desk.render(out.result);
    return result === out.result ? out : { ...out, result };
  }

  /**
   * Jarhead's hands win — but never mid-op: a worker's op in flight (a long `type`)
   * finishes first, bounded by the helper's own timeout, then Jarhead's lands next.
   * Past MAIN_LEASE_WAIT_MS the lease is cut and taken, so the worker's next tool
   * waits on Jarhead instead of landing between its keystrokes. A stop or a cut
   * meanwhile is left to the base (the toolset refuses after a stop).
   */
  private async takeScreen(): Promise<LeaseOutcome> {
    const signal = this.taskRef?.signal;
    const got = await this.lease.acquire(WorkerAwareRunner.ACTOR, { priority: true, signal, timeoutMs: MAIN_LEASE_WAIT_MS });
    if (got.ok || got.reason === "cancelled" || got.reason === "cut") return got;
    const holder = this.lease.holder;
    log.warn(`main lane: ${got.reason} for ${MAIN_LEASE_WAIT_MS} ms; taking the screen`);
    this.lease.cancelAll("Jarhead's hands took the screen");
    this.sinkRef?.step({ kind: "note", text: `took the screen${holder ? ` from ${holder}` : ""} (${got.reason})` });
    return this.lease.acquire(WorkerAwareRunner.ACTOR, { priority: true, signal, timeoutMs: WAIT_MAX_MS });
  }
}

// ------------------------------------------------------------ WorkerPool

/** The delegation a worker belongs to: its record ids and Kevin's words (the gates read `request`, never the brief). */
export interface WorkerParent {
  readonly id: string;
  readonly liveId: string;
  readonly request: string;
  readonly kevinDialogue?: string | undefined;
  readonly offsetMs: number;
}

/**
 * How a worker's steps and its one or two lines reach the parent delegation (the
 * Delegator's `splitLine` / `workerStep` / `workerSay`: Jarhead's own voice, the 600 ms
 * coalescer, the timeline with `step.worker`).
 */
export interface WorkerVoice {
  /** "<Name> alongside." — once per delegation, at the first worker_start. */
  splitLine(parentId: string, name: string): void;
  /** A worker's step on the parent's timeline (never voiced). */
  workerStep(parentId: string, name: string, step: Omit<DelegationStep, "id" | "at" | "worker">): void;
  /** One spoken line, Jarhead's own (never gated): a finish line, a promoted question. */
  workerSay(parentId: string, name: string, text: string): void;
}

/**
 * A spare is built before it has a name; the desk names a lane once (`lane(id, name)`
 * keeps the first name). So a lane's toolset gets this stand-in and the real desk lane
 * is bound when the worker is named. Every call forwards; a call before the binding
 * falls back to a state of its own (a spare never acts, so it never happens).
 */
class LaneConfirmations extends ConfirmationState {
  private target: LaneConfirmationState | undefined;

  bind(lane: LaneConfirmationState): void {
    this.target = lane;
  }

  override ask(description: string, member: string, input: Record<string, unknown>, grantable?: Grantable): PendingConfirmation {
    return this.target ? this.target.ask(description, member, input, grantable) : super.ask(description, member, input, grantable);
  }

  override consume(member: string, input: Record<string, unknown>): boolean {
    return this.target ? this.target.consume(member, input) : super.consume(member, input);
  }

  override granted(app: string | undefined, actionClass: string | undefined): boolean {
    return this.target ? this.target.granted(app, actionClass) : super.granted(app, actionClass);
  }

  override arm(record?: (grant: ConfirmationGrant) => void): ArmedConfirmation | undefined {
    return this.target ? this.target.arm(record) : super.arm(record);
  }

  override get activeGrants(): readonly ConfirmationGrant[] {
    return this.target ? this.target.activeGrants : super.activeGrants;
  }

  override beginConversation(chainId: string): void {
    if (this.target) this.target.beginConversation(chainId);
    else super.beginConversation(chainId);
  }

  override endConversation(): void {
    if (this.target) this.target.endConversation();
    else super.endConversation();
  }

  override clear(): void {
    if (this.target) this.target.clear();
    else super.clear();
  }

  override dropQuestion(): void {
    if (this.target) this.target.dropQuestion();
    else super.dropQuestion();
  }
}

export interface WorkerBrainSpec {
  readonly runner: ToolRunner;
  readonly workerId: string;
  /** The wall clock the brain itself enforces as a backstop (the pool cuts first). */
  readonly secondsCap: number;
}

/** Builds a worker's brain over its lane runner; undefined when the current brain kind cannot run a second thread. */
export type WorkerBrainFactory = (spec: WorkerBrainSpec) => Brain | undefined;

export interface WorkerPoolOptions {
  readonly now?: () => number;
  readonly ledger?: Ledger | undefined;
  readonly desk: ConfirmationDesk;
  readonly lease: FocusLease;
  readonly hands: { readonly focus: NativeHands; readonly background: NativeHands };
  /** The engine's runner options minus the toolset (state dir, agents, ledger, overlay, socket, self-edit). */
  readonly runnerOptions: () => Omit<RunnerOptions, "toolset">;
  /** The engine's toolset options minus hands / screen / confirmations (exclude pids, annotate, onAction, presenceAt). */
  readonly toolsetOptions: () => Omit<ToolsetOptions, "hands" | "screen" | "confirmations">;
  /** The factory for the current brain kind, or undefined ("workers need a brain that runs its own thread"). */
  readonly makeBrain: () => WorkerBrainFactory | undefined;
  /** The delegation behind a task, when it is running. */
  readonly parentFor: (task: BrainTask | undefined) => WorkerParent | undefined;
  /** The parent delegation's voice: the Delegator's worker hooks (splitLine / workerStep / workerSay). */
  readonly voice: () => WorkerVoice | undefined;
  /** Settings.workers. */
  readonly enabled: () => boolean;
  /** A worker changed: the snapshot goes out. */
  readonly onChange: () => void;
}

/** A NativeHands whose target can change: a spare is built on the reading helper and moves to the acting one for a screen lane. */
class LaneHands implements NativeHands {
  constructor(public target: NativeHands) {}

  request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.target.request<T>(op, params, timeoutMs);
  }

  get ready(): boolean {
    return this.target.ready;
  }
}

interface Lane {
  readonly id: string;
  readonly hands: LaneHands;
  /** The toolset's confirmation state: bound to the desk's lane once the worker has a name. */
  readonly confirmations: LaneConfirmations;
  readonly toolset: ComputerToolset;
  readonly runner: LaneRunner;
  readonly brain: Brain;
  started: Promise<{ ready: boolean; detail: string }> | undefined;
}

interface Job {
  worker: Worker;
  readonly parent: WorkerParent;
  readonly lane: Lane;
  readonly abort: AbortController;
  readonly budget: { readonly steps: number; readonly seconds: number };
  /** `brain.cancel()` is called once, whichever verb cut it. */
  brainCancelled: boolean;
  settled: boolean;
  /** The line Kevin was told, for worker_wait's "(Kevin was told: …)". */
  spoken: string | undefined;
  /** The question the worker's last turn ended on (a `confirm` step), while it awaits a yes. */
  question: string | undefined;
  /** The last turn ended on a presence hold: not a question, the worker fails with its line. */
  hold: boolean;
  waits: number;
  timer: NodeJS.Timeout | undefined;
  brief: string;
}

export class WorkerPool {
  private readonly now: () => number;
  private readonly jobs = new Map<string, Job>();
  /** Settled jobs, oldest first: their records linger in the snapshot for WORKER_LINGER_MS and worker_wait / worker_read still answer for them. */
  private readonly finished: Job[] = [];
  private spare: Lane | undefined;
  /** A spare's boot failed this wake: no second try until the next (sleep resets it — Codex logs in, the app-server comes back). */
  private spareFailed = false;
  /** Parents whose split line was spoken. */
  private readonly split = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: WorkerPoolOptions) {
    this.now = opts.now ?? Date.now;
  }

  // --------------------------------------------------------- the tools

  /** `worker_*` from the main lane's runner. */
  async tool(name: string, args: Record<string, unknown>, ctx: { readonly task: BrainTask | undefined }): Promise<ToolResult> {
    const parent = this.opts.parentFor(ctx.task);
    if (!parent) return { kind: "error", message: `${name}: no task is running to own a worker` };
    const who = String(args["name"] ?? "").trim();
    switch (name) {
      case "worker_start":
        return this.start(parent, { name: who, task: String(args["task"] ?? ""), lane: args["lane"] === "screen" ? "screen" : "background", budget: typeof args["budget"] === "object" && args["budget"] !== null ? (args["budget"] as { steps?: unknown; seconds?: unknown }) : {} });
      case "worker_wait": {
        const seconds = Math.min(240, Math.max(1, Number(args["timeout"] ?? 120) || 120));
        return this.wait(parent.id, who || "all", seconds * 1000);
      }
      case "worker_read":
        return this.read(parent.id, who);
      case "worker_stop": {
        const job = this.jobNamed(parent.id, who);
        if (!job) return { kind: "error", message: `no worker named "${who}" in this task` };
        await this.stopJob(job, "brain", "stopped by the main brain");
        return { kind: "text", text: `${job.worker.name} stopped (${job.worker.steps} steps). Kevin was told: "${job.worker.name} stopped."` };
      }
      default:
        return { kind: "error", message: `unknown worker tool ${name}` };
    }
  }

  /**
   * Start a worker. Returns at once; the worker's brain runs on its own. The split
   * line is spoken once per parent, here, at the first start.
   */
  async start(parent: WorkerParent, spec: { readonly name: string; readonly task: string; readonly lane: WorkerLane; readonly budget: { readonly steps?: unknown; readonly seconds?: unknown } }): Promise<ToolResult> {
    if (!this.opts.enabled()) return { kind: "error", message: "workers are off in Settings; do it yourself, one thing at a time" };
    const name = spec.name.replace(/\s+/g, " ").trim();
    if (!name) return { kind: "error", message: "worker_start needs a name Kevin will hear (one word, usually the app)" };
    if (name.length > WORKER_NAME_CHARS) return { kind: "error", message: `worker name "${name}" is too long (at most ${WORKER_NAME_CHARS} characters)` };
    if (!spec.task.trim()) return { kind: "error", message: "worker_start needs a task, in full sentences" };
    if (this.jobNamed(parent.id, name)) return { kind: "error", message: `a worker named "${name}" is already running in this task; worker_wait for it or pick another name` };
    if (this.running() >= WORKER_MAX) return { kind: "error", message: `${WORKER_MAX} hands are busy: worker_wait for one, or worker_stop one` };
    const factory = this.opts.makeBrain();
    if (!factory) return { kind: "error", message: "workers need a brain that runs its own thread; do it yourself, one thing at a time" };
    const steps = Math.min(WORKER_STEPS_MAX, Math.max(1, Math.round(Number(spec.budget.steps ?? WORKER_STEPS_DEFAULT) || WORKER_STEPS_DEFAULT)));
    const seconds = Math.min(WORKER_SECONDS_MAX, Math.max(10, Math.round(Number(spec.budget.seconds ?? WORKER_SECONDS_DEFAULT) || WORKER_SECONDS_DEFAULT)));

    // The spare, when there is one: its process is up already; it is named and laned now.
    let lane = this.spare;
    this.spare = undefined;
    lane ??= this.makeLane(newId("w"), factory);
    if (!lane) return { kind: "error", message: "could not start a worker brain" };
    lane.runner.setLane(spec.lane);
    lane.hands.target = spec.lane === "screen" ? this.opts.hands.focus : this.opts.hands.background;
    // Named now: the desk's lane carries the name Kevin hears ("Spotify asks: …", "Queued behind Slack's question").
    lane.confirmations.bind(this.opts.desk.lane(lane.id, name));

    const at = this.now();
    const task = lane.runner.redactor.redact(spec.task.replace(/\s+/g, " ").trim()).slice(0, 200);
    const worker: Worker = { id: lane.id, name, delegationId: parent.id, task, lane: spec.lane, status: "starting", startedAt: at, steps: 0 };
    const job: Job = { worker, parent, lane, abort: new AbortController(), budget: { steps, seconds }, brainCancelled: false, settled: false, spoken: undefined, question: undefined, hold: false, waits: 0, timer: undefined, brief: workerBrief(name, spec.task, spec.lane, parent.request) };
    this.jobs.set(lane.id, job);
    this.row(job);
    this.notify();
    if (!this.split.has(parent.id)) {
      this.split.add(parent.id);
      this.opts.voice()?.splitLine(parent.id, name);
    }
    log.info(`worker ${name} (${lane.id}) started on the ${spec.lane} lane for ${parent.id}: "${task.slice(0, 80)}" (budget ${steps} steps / ${seconds} s)`);
    void this.runJob(job);
    return { kind: "text", text: `started worker ${name} (${lane.id}) on the ${spec.lane} lane: ${task}. It works on its own; Jarhead speaks its finish line for you. worker_wait {name:"${name}"} collects its result when your part is done.` };
  }

  /** Wait until the named worker (or every worker of this parent) has settled or waits on a yes, or the timeout. */
  async wait(parentId: string, name: string, timeoutMs: number): Promise<ToolResult> {
    const targets = name === "all" ? this.jobsOf(parentId) : [this.jobNamed(parentId, name)].filter((j): j is Job => j !== undefined);
    if (targets.length === 0) {
      const lingering = this.finished.filter((j) => j.parent.id === parentId && (name === "all" || j.worker.name.toLowerCase() === name.toLowerCase()));
      if (lingering.length > 0) return { kind: "text", text: lingering.map((j) => this.describe(j)).join("\n") };
      return { kind: "error", message: name === "all" ? "no workers in this task" : `no worker named "${name}" in this task` };
    }
    const done = (): boolean => targets.every((j) => j.settled || j.worker.status === "awaiting-confirmation");
    if (!done()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, timeoutMs);
        timer.unref?.();
        function finish(): void {
          clearTimeout(timer);
          resolve();
        }
        const check = (): void => {
          if (done()) {
            this.listeners.delete(check);
            finish();
          }
        };
        this.listeners.add(check);
        // A timeout leaves the listener in place until the next change; it is cheap and bounded.
        setTimeout(() => this.listeners.delete(check), timeoutMs + 1).unref?.();
      });
    }
    return { kind: "text", text: targets.map((j) => this.describe(j)).join("\n") };
  }

  /** A worker's state right now, without waiting. */
  read(parentId: string, name: string): ToolResult {
    const job = this.jobNamed(parentId, name) ?? this.finished.find((j) => j.parent.id === parentId && j.worker.name.toLowerCase() === name.toLowerCase());
    if (job) return { kind: "text", text: this.describe(job) };
    return { kind: "error", message: `no worker named "${name}" in this task` };
  }

  private describe(job: Job): string {
    const w = job.worker;
    const elapsed = Math.round(((w.doneAt ?? this.now()) - w.startedAt) / 1000);
    const told = job.spoken ? ` (Kevin was told: "${job.spoken}")` : "";
    switch (w.status) {
      case "done":
        return `${w.name}: done — ${w.detail ?? "done"}${told}`;
      case "failed":
        return `${w.name}: failed — ${w.detail ?? "unknown reason"}${told}`;
      case "cancelled":
        return `${w.name}: stopped — ${w.detail ?? "stopped"}${told}`;
      case "awaiting-confirmation":
        return `${w.name}: awaiting Kevin's yes — ${job.question ?? w.detail ?? "a confirmation"} (${w.steps} steps, ${elapsed} s)`;
      case "waiting-screen":
        return `${w.name}: waiting for the screen (${w.steps} steps, ${elapsed} s)${w.detail ? ` — ${w.detail}` : ""}`;
      default:
        return `${w.name}: still working (${w.steps} steps, ${elapsed} s)${w.detail ? ` — ${w.detail}` : ""}; worker_wait again or worker_stop it`;
    }
  }

  // ------------------------------------------------------------ running

  private async runJob(job: Job): Promise<void> {
    const { lane } = job;
    lane.started ??= lane.brain.start();
    let ready: { ready: boolean; detail: string };
    try {
      ready = await lane.started;
    } catch (e) {
      ready = { ready: false, detail: (e as Error).message };
    }
    if (job.settled) return;
    if (!ready.ready) {
      this.endJob(job, "failed", `its brain did not start: ${ready.detail}`, `${job.worker.name} failed: ${cutLine(ready.detail)}`);
      return;
    }
    this.setStatus(job, { status: "working" });
    job.timer = setTimeout(() => void this.stopJob(job, "budget", this.outOfTime(job)), job.budget.seconds * 1000);
    job.timer.unref?.();
    await this.runTurn(job, this.taskFor(job, false));
  }

  private outOfTime(job: Job): string {
    return `I ran out of time after ${job.budget.seconds} seconds`;
  }

  /** The worker's BrainTask: Kevin's words as `request` and `kevinDialogue` (the gates), the brief in `dialogue` and `notes`. */
  private taskFor(job: Job, confirmation: boolean): BrainTask {
    const resume = confirmation ? "\n\nJarhead (to its worker): Kevin said yes. Call the same tool again with exactly the same arguments, then finish your job." : "";
    return {
      delegationId: `${job.parent.liveId}/${job.worker.name}`,
      request: job.parent.request,
      dialogue: `${job.brief}${resume}`,
      ...(job.parent.kevinDialogue !== undefined ? { kevinDialogue: job.parent.kevinDialogue } : {}),
      confirmation,
      offsetMs: job.parent.offsetMs,
      signal: job.abort.signal,
      notes: [`you are Jarhead's worker ${job.worker.name}; your job: ${job.worker.task}`],
    };
  }

  private async runTurn(job: Job, task: BrainTask): Promise<void> {
    const sink = this.sinkFor(job);
    job.question = undefined;
    job.hold = false;
    let result: BrainResult;
    try {
      result = await job.lane.brain.handle(task, sink);
    } catch (e) {
      result = { status: "failed", error: (e as Error).message };
    }
    if (job.settled) return;
    const name = job.worker.name;
    if (result.status === "cancelled" || job.abort.signal.aborted) {
      // A cut got here first and ended the job; a brain that settled on its own abort is the same thing.
      this.endJob(job, "cancelled", job.worker.detail ?? "stopped", undefined);
      return;
    }
    if (result.status === "failed") {
      this.endJob(job, "failed", result.error ?? "unknown error", `${name} failed: ${cutLine(result.error ?? "unknown error")}`);
      return;
    }
    if (job.hold) {
      // A presence hold is not a question: Kevin is away, the worker says so and ends.
      const line = job.question ?? result.summary ?? "Kevin is away; not now";
      this.endJob(job, "failed", line, `${name}: ${cutLine(line)}`);
      return;
    }
    if (job.question !== undefined) {
      // The turn ended on a question. On the floor it is spoken with the worker's name; queued, the desk speaks it when promoted.
      this.setStatus(job, { status: "awaiting-confirmation", detail: job.question });
      if (this.opts.desk.floor?.laneId === job.worker.id) this.say(job, `${name} asks: ${cutLine(result.summary ?? job.question, 160)}`);
      job.lane.runner.attach(undefined);
      return;
    }
    const summary = (result.summary ?? "").trim() || "done.";
    this.endJob(job, "done", summary, `${name}: ${cutLine(summary)}`);
  }

  private sinkFor(job: Job): BrainSink {
    const voice = (): WorkerVoice | undefined => this.opts.voice();
    const name = job.worker.name;
    return {
      thinking: (text) => {
        if (job.settled) return;
        voice()?.workerStep(job.parent.id, name, { kind: "thinking", text });
      },
      commentary: (text) => {
        // Workers never narrate: the line stays on the timeline.
        if (job.settled) return;
        voice()?.workerStep(job.parent.id, name, { kind: "commentary", text });
      },
      step: (step) => {
        if (job.settled) return;
        voice()?.workerStep(job.parent.id, name, step);
        if (step.kind === "tool" || step.kind === "screenshot" || step.kind === "confirm" || step.kind === "error") {
          const steps = job.worker.steps + 1;
          const detail = step.kind === "confirm" || step.kind === "error" ? step.text : step.tool ? `${step.tool.name}${step.kind === "tool" && typeof step.tool.output === "string" ? `: ${step.tool.output}` : ""}` : job.worker.detail;
          if (step.kind === "confirm") job.question = step.text;
          this.setStatus(job, { steps, ...(detail !== undefined ? { detail } : {}), ...(step.kind === "tool" && step.tool?.ok ? { status: "working" as const } : {}) });
          // The budgets, judged on the engine's clock as well as the cap timer: a live worker past its seconds is cut at its next step.
          if (steps > job.budget.steps) void this.stopJob(job, "budget", `I stopped after ${job.budget.steps} tool calls without finishing`);
          else if (this.now() - job.worker.startedAt >= job.budget.seconds * 1000) void this.stopJob(job, "budget", this.outOfTime(job));
        }
      },
      screenshot: (path, note) => {
        if (job.settled) return;
        voice()?.workerStep(job.parent.id, name, { kind: "screenshot", screenshotPath: path, ...(note ? { text: note } : {}) });
      },
    };
  }

  /** Every result a lane's runner produced: waits are counted here (three in a row fail the worker), holds noted. */
  private onLaneOutcome(laneId: string, toolName: string, result: ToolResult): void {
    const job = this.jobs.get(laneId);
    if (!job || job.settled) return;
    if (result.kind === "error" && result.message.startsWith("waiting for the screen")) {
      job.waits++;
      this.setStatus(job, { status: "waiting-screen", detail: result.message });
      if (job.waits >= WORKER_WAITS_MAX) void this.stopJob(job, "budget", "could not get the screen");
      return;
    }
    if (result.kind === "needs-confirmation") {
      job.question = result.question;
      job.hold = result.pendingId === HOLD_ID;
      return;
    }
    if (result.kind !== "error") {
      job.waits = 0;
      if (job.worker.status === "waiting-screen") this.setStatus(job, { status: "working" });
    }
    log.debug(`worker ${job.worker.name}: ${toolName} → ${result.kind}`);
  }

  private onLaneWaiting(laneId: string, waiting: boolean, reason: string | undefined): void {
    const job = this.jobs.get(laneId);
    if (!job || job.settled) return;
    if (waiting) this.setStatus(job, { status: "waiting-screen", ...(reason ? { detail: `waiting for the screen: ${reason}` } : {}) });
    else if (job.worker.status === "waiting-screen") this.setStatus(job, { status: "working" });
  }

  // ------------------------------------------------------------- ending

  /**
   * Cut one worker. `by`: "kevin" (the Console's Stop) and "brain" (worker_stop) speak
   * "<Name> stopped."; "cut" (interrupt, Stop, Pause, sleep) is silent — the verb already
   * spoke or closed the session; "budget" is a failure with its reason.
   */
  private async stopJob(job: Job, by: "kevin" | "brain" | "cut" | "budget", reason: string): Promise<void> {
    if (job.settled) return;
    job.abort.abort();
    const cancel = this.cancelBrain(job);
    job.lane.runner.abortTask(reason);
    job.lane.runner.attach(undefined); // the lease goes; a late tool.run {worker} is refused (attached === false)
    // Its question goes with it — THIS lane's only: a queued one is forgotten, one on the floor is
    // dropped and the next queued question comes up, spoken (`desk.dropQuestion()` would take the
    // whole queue with it, and another hand's question would never be asked).
    this.opts.desk.forget(job.worker.id);
    const name = job.worker.name;
    if (by === "budget") this.endJob(job, "failed", reason, `${name} failed: ${cutLine(reason)}`);
    else this.endJob(job, "cancelled", reason, by === "cut" ? undefined : `${name} stopped.`);
    await cancel;
  }

  /** `brain.cancel()` once per worker, whatever cut it; never throws. */
  private cancelBrain(job: Job): Promise<void> {
    if (job.brainCancelled) return Promise.resolve();
    job.brainCancelled = true;
    return job.lane.brain.cancel().catch((e: unknown) => log.debug(`worker ${job.worker.name} cancel: ${(e as Error).message}`));
  }

  private endJob(job: Job, status: "done" | "failed" | "cancelled", detail: string, line: string | undefined): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    this.jobs.delete(job.worker.id);
    this.setStatus(job, { status, detail, doneAt: this.now() });
    this.finished.push(job);
    if (this.finished.length > 50) this.finished.splice(0, this.finished.length - 50);
    job.lane.runner.attach(undefined);
    this.opts.lease.release(job.worker.id, "done");
    // Its remembered app and the apps it activated stop counting as a lane's.
    this.opts.lease.forget(job.worker.id);
    // A finished worker's question is nobody's now (queued or on the floor: a worker that ends while
    // its question waits was cut, not answered); the next queued question comes up.
    this.opts.desk.forget(job.worker.id);
    if (line) job.spoken = this.say(job, line);
    log.info(`worker ${job.worker.name} (${job.worker.id}) ${status} after ${job.worker.steps} steps: ${job.worker.detail?.slice(0, 120) ?? ""}`);
    // Its process goes; the spare (if any) is a different lane.
    void job.lane.brain.stop().catch((e: unknown) => log.debug(`worker ${job.worker.name} stop: ${(e as Error).message}`));
    this.notify();
  }

  /** One line for Kevin, in Jarhead's voice — struck of secrets first, like every text a model or Kevin gets. Returns what was said. */
  private say(job: Job, line: string): string {
    const clean = job.lane.runner.redactor.redact(line);
    this.opts.voice()?.workerSay(job.parent.id, job.worker.name, clean);
    return clean;
  }

  // ------------------------------------------------------------ the pool

  /** The Console's Stop on a row, or the main brain's worker_stop by id. True when a running worker was cut; false for one already finished or unknown. */
  async stop(workerId: string, by: "kevin" | "brain" | "cut"): Promise<boolean> {
    const job = this.jobs.get(workerId);
    if (!job) return false;
    await this.stopJob(job, by, by === "kevin" ? "Kevin stopped it" : by === "brain" ? "stopped by the main brain" : "cut");
    return true;
  }

  /** A cut verb: every worker cancelled quietly, each brain's cancel called once. Resolves when the cancels settle. */
  cancelAll(reason: string): Promise<void> {
    const jobs = [...this.jobs.values()];
    return Promise.all(jobs.map((j) => this.stopJob(j, "cut", reason))).then(() => undefined);
  }

  /** Sleep / shutdown: every worker cancelled and every worker process — the spare too — stopped. The next wake may warm a spare again. */
  async stopAll(): Promise<void> {
    await this.cancelAll("going to sleep");
    const spare = this.spare;
    this.spare = undefined;
    this.spareFailed = false;
    if (spare) await spare.brain.stop().catch((e: unknown) => log.debug(`spare worker stop: ${(e as Error).message}`));
  }

  /** Resolves once this parent has no running worker (or the signal aborts). */
  drain(parentId: string, signal: AbortSignal): Promise<void> {
    if (this.running(parentId) === 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.running(parentId) === 0 || signal.aborted) {
          this.listeners.delete(check);
          signal.removeEventListener("abort", check);
          resolve();
        }
      };
      this.listeners.add(check);
      signal.addEventListener("abort", check, { once: true });
    });
  }

  /** Workers alive right now (starting, working, waiting for the screen, awaiting a yes), for one parent or all. */
  running(parentId?: string): number {
    let n = 0;
    for (const j of this.jobs.values()) if (parentId === undefined || j.parent.id === parentId) n++;
    return n;
  }

  /** Kevin's yes reached a worker's question: its brain re-calls the same tool on a new turn of its own thread. */
  async resume(laneId: string): Promise<void> {
    const job = this.jobs.get(laneId);
    if (!job || job.settled || job.worker.status !== "awaiting-confirmation") return;
    this.setStatus(job, { status: "working" });
    void this.runTurn(job, this.taskFor(job, true));
  }

  /** The worker whose question is on the floor (id and the name Kevin hears), or undefined: the floor is free or the main lane's. */
  floorLane(): { readonly id: string; readonly name: string } | undefined {
    const floor = this.opts.desk.floor;
    const job = floor ? this.jobs.get(floor.laneId) : undefined;
    return job ? { id: job.worker.id, name: job.worker.name } : undefined;
  }

  /** The desk promoted a lane's question: a worker's is spoken with its name. False when no worker owns the lane (the main lane's — the engine speaks for it). */
  speakQuestion(laneName: string, question: string): boolean {
    const job = [...this.jobs.values()].find((j) => j.worker.name === laneName || j.worker.id === laneName);
    if (!job) return false;
    job.question = question;
    this.setStatus(job, { status: "awaiting-confirmation", detail: question });
    this.say(job, `${job.worker.name} asks: ${cutLine(question, 160)}`);
    return true;
  }

  /** The runner a `tool.run {worker}` frame lands on; undefined for a worker nobody owns (the daemon refuses). */
  laneRunner(workerId: string): ToolRunner | undefined {
    return this.jobs.get(workerId)?.lane.runner;
  }

  /** Running workers plus those finished within WORKER_LINGER_MS, oldest first. */
  list(): readonly Worker[] {
    const now = this.now();
    const alive = [...this.jobs.values()].map((j) => j.worker);
    const recent = this.finished.map((j) => j.worker).filter((w) => w.doneAt !== undefined && now - w.doneAt <= WORKER_LINGER_MS);
    return [...alive, ...recent].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The worker record by id, alive or lingering (tests and the Console). */
  get(workerId: string): Worker | undefined {
    return this.jobs.get(workerId)?.worker ?? this.finished.find((j) => j.worker.id === workerId)?.worker;
  }

  /**
   * One spare worker PROCESS at wake: its brain is started (a Codex app-server and
   * its thread — no primer, no model request) so the first split lands at once. Not
   * a second spare: memory. Nothing awaits it.
   */
  warmSpare(): void {
    if (!this.opts.enabled() || this.spare || this.spareFailed) return;
    const factory = this.opts.makeBrain();
    if (!factory) return;
    const lane = this.makeLane(newId("w"), factory);
    if (!lane) return;
    this.spare = lane;
    lane.started = lane.brain.start().catch((e: unknown) => ({ ready: false, detail: (e as Error).message }));
    void lane.started.then((r) => {
      if (!r.ready) {
        log.warn(`spare worker brain did not start: ${r.detail}`);
        if (this.spare === lane) this.spare = undefined;
        this.spareFailed = true;
      } else log.info(`spare worker ready (${lane.id}): ${r.detail}`);
    });
  }

  /** For tests: the spare lane's id, if one is warm. */
  get spareId(): string | undefined {
    return this.spare?.id;
  }

  private makeLane(id: string, factory: WorkerBrainFactory): Lane | undefined {
    const hands = new LaneHands(this.opts.hands.background);
    const confirmations = new LaneConfirmations();
    const toolset = new ComputerToolset({ ...this.opts.toolsetOptions(), hands, screen: new Screen(), confirmations });
    const runner = new LaneRunner({
      ...this.opts.runnerOptions(),
      toolset,
      lane: "background",
      laneId: id,
      lease: this.opts.lease,
      desk: this.opts.desk,
      onWaiting: (waiting, reason) => this.onLaneWaiting(id, waiting, reason),
      onOutcome: (name, result) => this.onLaneOutcome(id, name, result),
    });
    const brain = factory({ runner, workerId: id, secondsCap: WORKER_SECONDS_MAX });
    if (!brain) return undefined;
    return { id, hands, confirmations, toolset, runner, brain, started: undefined };
  }

  private jobsOf(parentId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.parent.id === parentId);
  }

  private jobNamed(parentId: string, name: string): Job | undefined {
    const key = name.trim().toLowerCase();
    return this.jobsOf(parentId).find((j) => j.worker.name.toLowerCase() === key || j.worker.id === name);
  }

  /**
   * The record changes. `detail` — a tool's output, an error, a question, a summary — is
   * struck of secrets and cut to the contract's 200 characters here, whatever wrote it:
   * the row goes to the ledger and the snapshot to the Console.
   */
  private setStatus(job: Job, patch: Partial<Pick<Worker, "status" | "detail" | "doneAt" | "steps">>): void {
    const before = job.worker;
    const detail = patch.detail !== undefined ? { detail: cutLine(job.lane.runner.redactor.redact(patch.detail), 200) } : {};
    job.worker = { ...before, ...patch, ...detail };
    // One ledger row per status change (not per step count), and a snapshot for every change.
    if (patch.status !== undefined && patch.status !== before.status) this.row(job);
    this.opts.onChange();
    if (patch.status !== undefined) this.notify();
  }

  private row(job: Job): void {
    try {
      this.opts.ledger?.append({ at: this.now(), type: "worker", worker: job.worker });
    } catch (e) {
      log.warn(`worker row not written: ${(e as Error).message}`);
    }
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}
