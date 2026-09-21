import { join } from "node:path";
import { logger, newId, type Ledger } from "@jarhead/core";
import { ComputerToolset, ConfirmationState, HOLD_ID, Screen, spokenQuestion, type ArmedConfirmation, type ConfirmationDesk, type ConfirmationGrant, type FocusLease, type Grantable, type LaneConfirmationState, type NativeHands, type PendingConfirmation, type ToolResult, type ToolsetOptions } from "@jarhead/hands";
import { screenNote, type Brain, type BrainAttachment, type BrainResult, type BrainSink, type BrainTask, type RunOutcome, type RunnerOptions, type ThreadFloor, type ToolRunner } from "@jarhead/brain";
import { MAIN_THREAD_ID, THREAD_MAX_LIVE, THREAD_NAME_CHARS, THREAD_SECONDS_DEFAULT, THREAD_SECONDS_MAX, THREAD_SPAWN_DEPTH, THREAD_STEPS_DEFAULT, THREAD_STEPS_MAX, type LedgerRow, type OverlayCommand, type Thread, type ThreadEvent, type ThreadStatus, type TranscriptItem } from "@jarhead/protocol";
import { BrainPool, type PoolLane, type Ready } from "./brain-pool.ts";
import { confirmationResume, cutLine, phraseForLine, phraseForTool, resumeText, threadBrief } from "./lines.ts";
import { LaneRunner, ThreadAwareRunner, type ActionObserverLike, type ActingSerializerLike, type SpawnLane } from "./runner.ts";
import { ThreadEventCoalescer, ThreadTable, THREAD_EVENT_COALESCE_MS } from "./table.ts";
import { ThreadLog, ThreadTurns, type ThreadTurn } from "./turns.ts";

/**
 * The scheduler: every spawned thread's turns, from admission to its finish line.
 *
 * A thread is as rich as the main conversation — its own brain (a warm app-server
 * process from the BrainPool), its own Delegation records (`threadId` set, never the
 * parent's), the eyes' shot and the memory block in its task, the same latency
 * marks, follow-up turns by name, confirmations spoken with its name — and as
 * bounded: THREAD_MAX_LIVE, depth one, a step and a seconds budget per turn, three
 * waits for the screen. Each turn has its own AbortController (a follow-up or a pause
 * supersedes the turn; the job's own signal means stop). Every change is one write
 * on the ThreadTable and one ThreadEvent through the sink, coalesced 50 ms per
 * thread — never a snapshot; the snapshot is rebuilt only when the LIST of threads
 * changes (a start, an end). The desk, the lease and the handshake stay exactly as
 * they were: one question floor, one pointer, a yes only for the floor's lane.
 */

const log = logger("engine.threads");

/** Three consecutive "waiting for the screen" answers fail the thread. */
export const THREAD_WAITS_MAX = 3;
/** A paused thread, or one waiting on a yes nobody gives, ends `done "idle"` after this and its lane returns to the pool. */
export const THREAD_IDLE_END_MS = 10 * 60_000;
/** speak_progress on a thread speaks this many times per turn, with its name. */
export const THREAD_PROGRESS_PER_TURN = 1;
/** …and never within this of the thread's last spoken line. */
export const THREAD_PROGRESS_GAP_MS = 20_000;
/** The memory block is raced with the eyes; past this the task goes without it. */
export const MEMORY_RECALL_MS = 250;
/** A superseded turn's brain has this long to let go (its `handle` to return after `cancel()`) before the record is closed without it. */
export const SUPERSEDE_WAIT_MS = 5_000;
/** Finished jobs kept for thread_wait / thread_read after the end. */
const FINISHED_MAX = 50;

// -------------------------------------------------------------- contracts

/** The delegation a thread belongs to: its record ids and Kevin's words (the gates read `request`, never the brief). */
export interface ThreadParent {
  readonly id: string;
  readonly liveId: string;
  readonly request: string;
  readonly kevinDialogue?: string | undefined;
  readonly offsetMs: number;
  /** The thread that runs the parent turn (absent = main). */
  readonly threadId?: string | undefined;
  /** How many spawns deep the parent is (absent = 0: the main thread). */
  readonly depth?: number | undefined;
}

/**
 * How a thread's lines reach the voice: the Delegator's hooks on the parent
 * delegation — `splitLine` once at the split, `threadSay` for Jarhead's own lines
 * about a thread (never gated, through the 600 ms coalescer) while the parent runs
 * or drains. A thread's steps land on its own record, never on the parent's.
 */
export interface ThreadVoice {
  splitLine(parentId: string, name: string): void;
  threadSay(parentId: string, name: string, text: string): void;
}

export interface ThreadBrainSpec {
  readonly runner: ToolRunner;
  /** The thread id — the `thread` field its bridge stamps on every tool.run frame. */
  readonly threadId: string;
  /** The wall clock the brain itself enforces as a backstop (the scheduler cuts first). */
  readonly secondsCap: number;
}

/** Builds a thread's brain over its lane runner; undefined when the current brain kind cannot run a second thread. */
export type ThreadBrainFactory = (spec: ThreadBrainSpec) => Brain | undefined;

export interface SpawnSpec {
  readonly name: string;
  readonly task: string;
  readonly lane: SpawnLane;
  readonly budget?: { readonly steps?: unknown; readonly seconds?: unknown } | undefined;
}

export type StopBy = "kevin" | "brain" | "cut" | "budget";

export interface ThreadSchedulerOptions {
  readonly now?: (() => number) | undefined;
  readonly ledger?: Ledger | undefined;
  readonly desk: ConfirmationDesk;
  readonly lease: FocusLease;
  readonly hands: { readonly focus: NativeHands; readonly background: NativeHands };
  /** The engine's runner options minus the toolset (state dir, agents, ledger, overlay, socket, self-edit). */
  readonly runnerOptions: () => Omit<RunnerOptions, "toolset">;
  /** The engine's toolset options minus hands / screen / confirmations (exclude pids, annotate, onAction, presenceAt). */
  readonly toolsetOptions: () => Omit<ToolsetOptions, "hands" | "screen" | "confirmations">;
  /** The factory for the current brain kind, or undefined ("threads need a brain that runs its own thread"). */
  readonly makeBrain: () => ThreadBrainFactory | undefined;
  /** The delegation behind a task, when it is running. */
  readonly parentFor: (task: BrainTask | undefined) => ThreadParent | undefined;
  /** The parent delegation's voice: the Delegator's hooks. */
  readonly voice: () => ThreadVoice | undefined;
  /** Settings.threads — the on/off flag. */
  readonly enabled: () => boolean;
  /** The LIST of threads changed (a start, an end): the snapshot goes out. Never called for a step or a status. */
  readonly onChange: () => void;
  /** The table (the engine's, shared with the main thread's record); built here when absent. */
  readonly table?: ThreadTable | undefined;
  /** One ThreadEvent per change, coalesced THREAD_EVENT_COALESCE_MS per thread (the daemon broadcasts it). */
  readonly onEvent?: ((e: ThreadEvent) => void) | undefined;
  readonly coalesceMs?: number | undefined;
  /** Settings.warmThreads, read live (default 2, clamped 0..3). */
  readonly warmThreads?: (() => number) | undefined;
  /** The durable-memory block for a thread's task (the Delegator's hook), raced at MEMORY_RECALL_MS. */
  readonly memory?: ((query: string, signal: AbortSignal) => Promise<string | undefined>) | undefined;
  /** The eyes' quick shot at every turn's start, on the reading helper (default on). */
  readonly eyes?: boolean | undefined;
  /** The composite look (front app, windows, a shallow AX tree) for `notes[0]`, when the speed pass wires it. */
  readonly look?: (() => Promise<string | undefined>) | undefined;
  /** The speed pass's hooks for every lane runner. */
  readonly observer?: ActionObserverLike | undefined;
  readonly serializer?: ActingSerializerLike | undefined;
  /** How long a superseded turn's brain may take to let go (default SUPERSEDE_WAIT_MS; tests shorten it). */
  readonly supersedeWaitMs?: number | undefined;
  /** The user's name as the lines say it (the engine's effective name; "Kevin" when none is wired). */
  readonly userName?: (() => string) | undefined;
}

// -------------------------------------------------------------- the lane

/**
 * A NativeHands whose target can change: a spare is built on the reading helper and
 * moves to the acting one for a screen lane; the eyes' shot always reads through the
 * reading helper, whatever the lane (`eyes()` routes for its duration — the lane is
 * otherwise idle at a turn's start).
 */
export class LaneHands implements NativeHands {
  private reading = 0;

  constructor(
    public target: NativeHands,
    readonly reader: NativeHands,
  ) {}

  request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return (this.reading > 0 ? this.reader : this.target).request<T>(op, params, timeoutMs);
  }

  get ready(): boolean {
    return this.target.ready;
  }

  /** Run `fn` with every request routed to the reading helper. */
  async eyes<T>(fn: () => Promise<T>): Promise<T> {
    this.reading++;
    try {
      return await fn();
    } finally {
      this.reading--;
    }
  }
}

/**
 * A spare is built before it has a name; the desk names a lane once (`lane(id, name)`
 * keeps the first name). So a lane's toolset gets this stand-in and the real desk lane
 * is bound when the thread is named. Every call forwards; a call before the binding
 * falls back to a state of its own (a spare never acts, so it never happens).
 */
export class LaneConfirmations extends ConfirmationState {
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

/** A thread's process and tools: hands, confirmations, toolset, runner, brain. Built once; named and laned at admission. */
export interface Lane extends PoolLane {
  readonly id: string;
  readonly hands: LaneHands;
  readonly confirmations: LaneConfirmations;
  readonly toolset: ComputerToolset;
  readonly runner: LaneRunner;
  readonly brain: Brain;
  started: Promise<Ready> | undefined;
}

interface TurnSpec {
  readonly request: string;
  readonly dialogue: string;
  readonly kevinDialogue?: string | undefined;
  readonly confirmation: boolean;
  readonly marks?: readonly BrainAttachment[] | undefined;
}

interface Job {
  readonly id: string;
  readonly name: string;
  readonly lane: SpawnLane;
  readonly parent: ThreadParent;
  readonly laneRef: Lane;
  /** The JOB's controller: aborted by a stop, never by a follow-up. */
  readonly abort: AbortController;
  readonly budget: { readonly steps: number; readonly seconds: number };
  readonly turns: ThreadTurns;
  readonly log: ThreadLog;
  readonly brief: string;
  turn: ThreadTurn | undefined;
  settled: boolean;
  /** Its brain answered its boot. Before that no turn runs: a verb that arrives meanwhile leaves its intent below and `runJob` acts on it once. */
  booted: boolean;
  /** The turn to run when the boot answers (a follow-up that arrived while the brain booted replaces the first task — its dialogue carries the brief); undefined = the first task. */
  pendingTurn: TurnSpec | undefined;
  /** The line Kevin was told, for thread_wait's "(Kevin was told: …)". */
  spoken: string | undefined;
  /** The question the last turn ended on (a `confirm` step), while it awaits a yes. */
  question: string | undefined;
  /** The last turn ended on a presence hold: not a question, the thread fails with its line. */
  hold: boolean;
  waits: number;
  timer: NodeJS.Timeout | undefined;
  /** Progress lines spoken this turn, and when the thread last spoke. */
  progressSpoken: number;
  lastSpokenAt: number;
}

export class ThreadScheduler {
  readonly table: ThreadTable;
  readonly pool: BrainPool<Lane>;
  private readonly now: () => number;
  private readonly jobs = new Map<string, Job>();
  /** Settled jobs, oldest first: thread_wait / thread_read still answer for them. */
  private readonly finished: Job[] = [];
  /** Parents whose split line was spoken. */
  private readonly split = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly events: ThreadEventCoalescer;
  /** Admission order: the lease's rank (Kevin's hands > main > threads by age). */
  private admitted = 0;
  /** Process releases in flight (a real `brain.stop()` takes time): `stopAll` awaits them so a sleep leaves nothing behind. */
  private readonly releasing = new Set<Promise<void>>();
  /** How often the LIST of threads changed (a start, an end) — the only times the snapshot is asked for; a step never moves it (tests pin that). */
  listChanges = 0;
  private readonly supersedeWaitMs: number;

  /** The user's name as every line here says it. */
  private get userName(): string {
    return this.opts.userName?.() || "Kevin";
  }

  constructor(private readonly opts: ThreadSchedulerOptions) {
    this.now = opts.now ?? Date.now;
    this.supersedeWaitMs = opts.supersedeWaitMs ?? SUPERSEDE_WAIT_MS;
    this.table = opts.table ?? new ThreadTable({ now: this.now });
    this.events = new ThreadEventCoalescer((e) => opts.onEvent?.(e), opts.coalesceMs ?? THREAD_EVENT_COALESCE_MS);
    this.pool = new BrainPool<Lane>({
      spares: opts.warmThreads,
      now: this.now,
      enabled: opts.enabled,
      makeLane: () => {
        const factory = this.opts.makeBrain();
        return factory ? this.makeLane(newId("t"), factory) : undefined;
      },
    });
  }

  // --------------------------------------------------------- the tools

  /** `thread_*` from the main lane's runner. */
  async tool(name: string, args: Record<string, unknown>, ctx: { readonly task: BrainTask | undefined }): Promise<ToolResult> {
    const parent = this.opts.parentFor(ctx.task);
    if (!parent) return { kind: "error", message: `${name}: no task is running to own a thread` };
    const who = String(args["name"] ?? "").trim();
    switch (name) {
      case "thread_start":
        return this.start(parent, { name: who, task: String(args["task"] ?? ""), lane: args["lane"] === "screen" ? "screen" : "background", budget: typeof args["budget"] === "object" && args["budget"] !== null ? (args["budget"] as { steps?: unknown; seconds?: unknown }) : {} });
      case "thread_wait": {
        const seconds = Math.min(240, Math.max(1, Number(args["timeout"] ?? 120) || 120));
        return this.wait(parent.id, who || "all", seconds * 1000);
      }
      case "thread_read":
        return this.read(parent.id, who);
      case "thread_stop": {
        const job = this.jobNamed(who, parent.id);
        if (!job) return { kind: "error", message: `no thread named "${who}" in this task` };
        await this.stopJob(job, "brain", "stopped by the main brain");
        const t = this.table.get(job.id);
        return { kind: "text", text: `${job.name} stopped (${t?.steps ?? 0} steps). ${this.userName} was told: "${job.name} stopped."` };
      }
      default:
        return { kind: "error", message: `unknown thread tool ${name}` };
    }
  }

  /**
   * Admit a thread — synchronously: every refusal is decided here and the answer
   * returns at once; the brain boots (or is already warm) and runs on its own. The
   * split line is spoken once per parent, at its first start.
   */
  start(parent: ThreadParent, spec: SpawnSpec): ToolResult {
    if (!this.opts.enabled()) return { kind: "error", message: "threads are off in Settings; do it yourself, one thing at a time" };
    const name = spec.name.replace(/\s+/g, " ").trim();
    if (!name) return { kind: "error", message: `thread_start needs a name ${this.userName} will hear (one word, usually the app)` };
    if (name.length > THREAD_NAME_CHARS) return { kind: "error", message: `thread name "${name}" is too long (at most ${THREAD_NAME_CHARS} characters)` };
    if (!spec.task.trim()) return { kind: "error", message: "thread_start needs a task, in full sentences" };
    if ((parent.depth ?? 0) >= THREAD_SPAWN_DEPTH) return { kind: "error", message: "refused: a thread never spawns a thread (depth one); do it yourself" };
    if (this.table.byNameLive(name)) return { kind: "error", message: `a thread named "${name}" is already running; thread_wait for it or pick another name` };
    if (this.table.spawnedLiveCount() >= THREAD_MAX_LIVE - 1) return { kind: "error", message: `${THREAD_MAX_LIVE - 1} threads are busy: thread_wait for one, or thread_stop one` };
    const factory = this.opts.makeBrain();
    if (!factory) return { kind: "error", message: "threads need a brain that runs its own thread; do it yourself, one thing at a time" };
    const budget = spec.budget ?? {};
    const steps = Math.min(THREAD_STEPS_MAX, Math.max(1, Math.round(Number(budget.steps ?? THREAD_STEPS_DEFAULT) || THREAD_STEPS_DEFAULT)));
    const seconds = Math.min(THREAD_SECONDS_MAX, Math.max(10, Math.round(Number(budget.seconds ?? THREAD_SECONDS_DEFAULT) || THREAD_SECONDS_DEFAULT)));

    // A warm spare when there is one (its process is up: < 5 ms here); else a cold lane whose boot runJob awaits.
    const lane = this.pool.take() ?? this.makeLane(newId("t"), factory);
    if (!lane) return { kind: "error", message: "could not start a thread brain" };
    const rank = this.admitted++;
    lane.runner.setLane(spec.lane);
    lane.runner.setRank(rank);
    lane.hands.target = spec.lane === "screen" ? this.opts.hands.focus : this.opts.hands.background;
    // Named now: the desk's lane carries the name Kevin hears ("Spotify asks: …", "Queued behind Slack's question").
    lane.confirmations.bind(this.opts.desk.lane(lane.id, name));

    const at = this.now();
    const task = lane.runner.redactor.redact(spec.task.replace(/\s+/g, " ").trim()).slice(0, 200);
    const thread: Thread = {
      id: lane.id,
      name,
      lane: spec.lane,
      status: "starting",
      parentId: parent.threadId ?? MAIN_THREAD_ID,
      parentDelegationId: parent.id,
      liveId: parent.liveId,
      task,
      apps: [],
      startedAt: at,
      updatedAt: at,
      turns: 0,
      steps: 0,
      waits: 0,
      budget: { steps, seconds },
      canSay: true,
      canStop: true,
    };
    const logRing = new ThreadLog();
    const job: Job = {
      id: lane.id,
      name,
      lane: spec.lane,
      parent,
      laneRef: lane,
      abort: new AbortController(),
      budget: { steps, seconds },
      turns: new ThreadTurns({ threadId: lane.id, now: this.now, ledger: this.opts.ledger, log: logRing }),
      log: logRing,
      brief: threadBrief(name, spec.task, spec.lane, parent.request, this.userName),
      turn: undefined,
      settled: false,
      booted: false,
      pendingTurn: undefined,
      spoken: undefined,
      question: undefined,
      hold: false,
      waits: 0,
      timer: undefined,
      progressSpoken: 0,
      lastSpokenAt: 0,
    };
    this.jobs.set(lane.id, job);
    this.publish(this.table.started(thread));
    this.row({ at, type: "thread.started", thread });
    job.turns.system("play.fill", `${name} started on the ${spec.lane} lane`, task.slice(0, 80));
    this.changed();
    this.notify();
    if (!this.split.has(parent.id)) {
      this.split.add(parent.id);
      this.opts.voice()?.splitLine(parent.id, name);
    }
    log.info(`thread ${name} (${lane.id}) started on the ${spec.lane} lane for ${parent.id}: "${task.slice(0, 80)}" (budget ${steps} steps / ${seconds} s${lane.started ? ", warm" : ", cold"})`);
    void this.runJob(job);
    return { kind: "text", text: `started thread ${name} (${lane.id}) on the ${spec.lane} lane: ${task}. It works on its own; Jarhead speaks its finish line for you. thread_wait {name:"${name}"} collects its result when your part is done.` };
  }

  /** Wait until the named thread (or every thread of this parent) has settled, waits on a yes or is paused, or the timeout. */
  async wait(parentId: string, name: string, timeoutMs: number): Promise<ToolResult> {
    const targets = name === "all" ? this.jobsOf(parentId) : [this.jobNamed(name, parentId)].filter((j): j is Job => j !== undefined);
    if (targets.length === 0) {
      const lingering = this.finished.filter((j) => j.parent.id === parentId && (name === "all" || j.name.toLowerCase() === name.toLowerCase()));
      if (lingering.length > 0) return { kind: "text", text: lingering.map((j) => this.describe(j)).join("\n") };
      return { kind: "error", message: name === "all" ? "no threads in this task" : `no thread named "${name}" in this task` };
    }
    const settledOrWaiting = (j: Job): boolean => {
      const s = this.table.get(j.id)?.status;
      return j.settled || s === "waiting-kevin" || s === "paused";
    };
    const done = (): boolean => targets.every(settledOrWaiting);
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

  /** A thread's state right now, without waiting. */
  read(parentId: string, name: string): ToolResult {
    const job = this.jobNamed(name, parentId) ?? this.finished.find((j) => j.parent.id === parentId && j.name.toLowerCase() === name.toLowerCase());
    if (job) return { kind: "text", text: this.describe(job) };
    return { kind: "error", message: `no thread named "${name}" in this task` };
  }

  private describe(job: Job): string {
    const t = this.table.get(job.id);
    const name = job.name;
    if (!t) return `${name}: gone`;
    const elapsed = Math.round(((t.doneAt ?? this.now()) - t.startedAt) / 1000);
    const told = job.spoken ? ` (${this.userName} was told: "${job.spoken}")` : "";
    switch (t.status) {
      case "done":
        return `${name}: done — ${t.detail ?? "done"}${told}`;
      case "failed":
        return `${name}: failed — ${t.detail ?? "unknown reason"}${told}`;
      case "stopped":
        return `${name}: stopped — ${t.detail ?? "stopped"}${told}`;
      case "waiting-kevin":
        return `${name}: awaiting ${this.userName}'s yes — ${job.question ?? t.question ?? t.detail ?? "a confirmation"} (${t.steps} steps, ${elapsed} s)`;
      case "waiting-screen":
        return `${name}: waiting for the screen (${t.steps} steps, ${elapsed} s)${t.detail ? ` — ${t.detail}` : ""}`;
      case "paused":
        return `${name}: paused by ${this.userName} (${t.steps} steps, ${elapsed} s)`;
      default:
        return `${name}: still working (${t.steps} steps, ${elapsed} s)${t.detail ? ` — ${t.detail}` : ""}; thread_wait again or thread_stop it`;
    }
  }

  // ------------------------------------------------------------ running

  private async runJob(job: Job): Promise<void> {
    const lane = job.laneRef;
    lane.started ??= lane.brain.start();
    let ready: Ready;
    try {
      ready = await lane.started;
    } catch (e) {
      ready = { ready: false, detail: (e as Error).message };
    }
    if (job.settled) return;
    if (!ready.ready) {
      this.endJob(job, "failed", `its brain did not start: ${ready.detail}`, `${job.name} failed: ${cutLine(ready.detail)}`);
      return;
    }
    job.booted = true;
    // Kevin paused it while its brain booted: it stays paused, no turn; `resume` runs one.
    if (this.table.get(job.id)?.status === "paused") return;
    // A follow-up that arrived while the brain booted is the first turn (one turn on one brain, never two):
    // its dialogue carries the brief, so the job is not lost with the first task's words.
    const spec = job.pendingTurn ?? this.firstTurn(job);
    job.pendingTurn = undefined;
    this.setStatus(job, "thinking");
    await this.runTurn(job, spec);
  }

  private firstTurn(job: Job): TurnSpec {
    return { request: job.parent.request, dialogue: job.brief, kevinDialogue: job.parent.kevinDialogue, confirmation: false };
  }

  private outOfTime(job: Job): string {
    return `I ran out of time after ${job.budget.seconds} seconds`;
  }

  /**
   * One turn on the thread's own brain: a Delegation of its own, the eyes' quick shot
   * (through its runner, on the reading helper) raced with the memory block, the
   * brief in `dialogue`, Kevin's words in `request` (the gates), the identity and the
   * composite look in `notes`. A follow-up or a pause supersedes the turn: its record
   * closes `cancelled` and the job lives on; a stop ends both.
   */
  private async runTurn(job: Job, spec: TurnSpec): Promise<void> {
    const lane = job.laneRef;
    const turn = job.turns.open(spec.request, job.parent.liveId, job.parent.offsetMs);
    job.turn = turn;
    job.question = undefined;
    job.hold = false;
    job.progressSpoken = 0;
    this.publish(this.table.turn(job.id, turn.delegation.id, spec.request));
    this.armTimer(job, turn);
    const sink = this.sinkFor(job, turn);

    const [screen, memory, look] = await Promise.all([this.look(job, turn, sink), this.recall(spec.request, turn.abort.signal), this.composite(turn.abort.signal)]);
    if (job.settled || turn.superseded !== undefined) {
      this.closeSuperseded(job, turn);
      return;
    }
    const attachments: BrainAttachment[] = [...(screen ? [screen] : []), ...(spec.marks ?? [])];
    const identity = `you are Jarhead's thread ${job.name}; your job: ${this.table.get(job.id)?.task ?? ""}`;
    const task: BrainTask = {
      // Identity rides here until BrainTask.thread (a rail) is named: `<threadId>/<delegationId>`.
      delegationId: `${job.id}/${turn.delegation.id}`,
      // Its identity as the brain sees it (BrainTask.thread — the one field the brain rail gained).
      thread: { id: job.id, name: job.name, lane: job.lane },
      request: spec.request,
      dialogue: spec.dialogue,
      ...(spec.kevinDialogue !== undefined ? { kevinDialogue: spec.kevinDialogue } : {}),
      confirmation: spec.confirmation,
      offsetMs: job.parent.offsetMs,
      signal: turn.abort.signal,
      ...(attachments.length ? { attachments } : {}),
      notes: [...(look ? [look] : []), identity],
      // Never inside kevinDialogue: the gates must not read a remembered line as his words today.
      ...(memory ? { memory } : {}),
    };
    let result: BrainResult;
    try {
      result = await lane.brain.handle(task, sink);
    } catch (e) {
      result = { status: "failed", error: (e as Error).message };
    }
    // This turn's cap timer only: a brain that let go late (after a bounded supersede) must not clear the next turn's.
    if (job.turn === turn) this.clearTimer(job);
    if (job.settled) {
      // A cut got here first and ended the job (and closed the turn's record).
      if (!turn.closed) job.turns.close(turn, { status: "cancelled", summary: this.table.get(job.id)?.detail ?? "stopped" });
      return;
    }
    if (turn.superseded !== undefined) {
      this.closeSuperseded(job, turn);
      return;
    }
    const name = job.name;
    if (result.status === "cancelled" || job.abort.signal.aborted) {
      this.endJob(job, "stopped", this.table.get(job.id)?.detail ?? "stopped", undefined);
      return;
    }
    if (result.status === "failed") {
      this.endJob(job, "failed", result.error ?? "unknown error", `${name} failed: ${cutLine(result.error ?? "unknown error")}`);
      return;
    }
    if (job.hold) {
      // A presence hold is not a question: Kevin is away, the thread says so and ends.
      const line = job.question ?? result.summary ?? `${this.userName} is away; not now`;
      this.endJob(job, "failed", line, `${name}: ${cutLine(line)}`);
      return;
    }
    if (job.question !== undefined) {
      // The turn ended on a question. On the floor it is spoken with the thread's name; queued, the desk speaks it
      // when promoted — and the record carries the question's own words either way, not the "Queued behind …"
      // text its brain read, so the pane, the status line and the one `waiting-kevin` row say what it wants to ask.
      const queued = this.opts.desk.queued.find((x) => x.laneId === job.id);
      const q = queued ? spokenQuestion(queued.description) : job.question;
      job.question = q;
      job.turns.close(turn, { status: "awaiting-confirmation", summary: q });
      job.turn = undefined;
      this.publish(this.table.question(job.id, q));
      this.row({ at: this.now(), type: "thread.status", threadId: job.id, status: "waiting-kevin", threadStatus: "waiting-kevin", detail: cutLine(q, 200) });
      if (this.opts.desk.floor?.laneId === job.id) this.say(job, `${name} asks: ${cutLine(result.summary ?? q, 160)}`);
      lane.runner.attach(undefined);
      this.notify();
      return;
    }
    const summary = (result.summary ?? "").trim() || "done.";
    this.endJob(job, "done", summary, `${name}: ${cutLine(summary)}`);
  }

  /** A superseded turn's record closes `cancelled` with the reason; the thread carries on with the next turn. */
  private closeSuperseded(job: Job, turn: ThreadTurn): void {
    if (!turn.closed) job.turns.close(turn, { status: "cancelled", summary: turn.superseded ?? "superseded" });
    if (job.turn === turn) job.turn = undefined;
    turn.settle();
  }

  /** The eyes' pre-warm shot: the display under the cursor at the quick budget, through the thread's own runner on the reading helper. */
  private async look(job: Job, turn: ThreadTurn, sink: BrainSink): Promise<BrainAttachment | undefined> {
    if (this.opts.eyes === false) return undefined;
    const reader = job.laneRef.hands.reader as NativeHands & { readonly available?: boolean };
    if (!reader.ready && reader.available !== true) return undefined;
    const t0 = this.now();
    turn.looking = true;
    job.laneRef.runner.attach(sink);
    try {
      const out: RunOutcome = await job.laneRef.hands.eyes(() => job.laneRef.runner.run("screenshot", { quick: true }));
      if (job.settled || turn.superseded !== undefined) return undefined;
      if (out.result.kind !== "image" || !out.screenshotPath) return undefined;
      job.turns.stamp(turn, { eyesMs: this.now() - t0 });
      return { path: join(this.opts.runnerOptions().stateDir, out.screenshotPath), mediaType: "image/png", note: screenNote(out.result.width, out.result.height, out.result.note), kind: "screen" };
    } catch (e) {
      log.debug(`thread ${job.name}: no pre-warm screenshot: ${(e as Error).message}`);
      return undefined;
    } finally {
      turn.looking = false;
      job.laneRef.runner.attach(undefined);
    }
  }

  /** The memory block, bounded at MEMORY_RECALL_MS; absent when the hook is slow or missing. */
  private async recall(query: string, signal: AbortSignal): Promise<string | undefined> {
    const hook = this.opts.memory;
    if (!hook) return undefined;
    const cut = new AbortController();
    const onAbort = (): void => cut.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const bound = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          cut.abort();
          resolve(undefined);
        }, MEMORY_RECALL_MS);
        timer.unref?.();
      });
      return await Promise.race([hook(query, cut.signal).catch(() => undefined), bound]);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** The composite look for `notes[0]`, bounded like the memory block. */
  private async composite(signal: AbortSignal): Promise<string | undefined> {
    const hook = this.opts.look;
    if (!hook || signal.aborted) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const bound = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 300);
        timer.unref?.();
      });
      return await Promise.race([hook().catch(() => undefined), bound]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private armTimer(job: Job, turn: ThreadTurn): void {
    this.clearTimer(job);
    job.timer = setTimeout(() => {
      if (job.turn === turn && !job.settled) void this.stopJob(job, "budget", this.outOfTime(job));
    }, job.budget.seconds * 1000);
    job.timer.unref?.();
  }

  private clearTimer(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
  }

  /**
   * The brain's channel for one turn: every step on the thread's OWN record (the
   * marks stamped, the ledger row written, the log entry appended) and one table
   * write — never the parent's timeline, never a snapshot. speak_progress speaks once
   * per turn as "<Name>: …"; the rest of the commentary stays on the record.
   */
  private sinkFor(job: Job, turn: ThreadTurn): BrainSink {
    const live = (): boolean => !job.settled && !turn.closed;
    return {
      thinking: (text) => {
        if (!live()) return;
        if (!turn.marks.has("firstThinking")) {
          turn.marks.mark("firstThinking");
          job.turns.stamp(turn, { firstThinkingAt: this.now() });
        }
        job.turns.step(turn, { kind: "thinking", text });
      },
      commentary: (text) => {
        if (!live()) return;
        if (!turn.marks.has("firstCommentary")) {
          turn.marks.mark("firstCommentary");
          job.turns.stamp(turn, { firstCommentaryAt: this.now() });
        }
        job.turns.step(turn, { kind: "commentary", text });
        const phrase = phraseForLine(text);
        if (phrase) this.table.phrase(job.id, phrase);
        this.progress(job, text);
      },
      step: (step) => {
        if (!live()) return;
        job.turns.step(turn, step);
        if (step.kind !== "tool" && step.kind !== "screenshot" && step.kind !== "confirm" && step.kind !== "error") return;
        // The eyes' pre-warm shot is the engine's look, not the thread's work: on the record, not in the count or the budget.
        if (turn.looking) return;
        turn.steps++;
        const detail = step.kind === "confirm" || step.kind === "error" ? step.text : step.tool ? `${step.tool.name}${step.kind === "tool" && typeof step.tool.output === "string" ? `: ${step.tool.output}` : ""}` : undefined;
        if (step.kind === "confirm") job.question = step.text;
        if (step.tool) {
          const app = appHint(step.tool.name, step.tool.input);
          if (app && step.tool.ok) this.table.claimApp(job.id, app);
        }
        const phrase = step.kind === "tool" && step.tool?.ok ? phraseForTool(step.tool.name, step.tool.input) : undefined;
        this.publish(
          this.table.step(job.id, {
            ...(step.tool ? { tool: step.tool.name, ok: step.tool.ok } : {}),
            ...(step.kind === "screenshot" ? { screenshot: true } : {}),
            ...(phrase ? { phrase } : {}),
            ...(detail !== undefined ? { detail: job.laneRef.runner.redactor.redact(detail) } : {}),
            ...(step.screenshotPath ? { screenshotPath: step.screenshotPath } : {}),
          }),
        );
        // The budgets, judged on the engine's clock as well as the cap timer: a live thread past its seconds is cut at its next step.
        if (turn.steps > job.budget.steps) void this.stopJob(job, "budget", `I stopped after ${job.budget.steps} tool calls without finishing`);
        else if (this.now() - turn.startedAt >= job.budget.seconds * 1000) void this.stopJob(job, "budget", this.outOfTime(job));
      },
      screenshot: (path, note) => {
        if (!live()) return;
        // The tool step that follows carries the count and the path; this is the image on the record.
        job.turns.step(turn, { kind: "screenshot", screenshotPath: path, ...(note ? { text: note } : {}) });
      },
    };
  }

  /** speak_progress on a thread: at most THREAD_PROGRESS_PER_TURN spoken lines a turn, never within THREAD_PROGRESS_GAP_MS of its last. */
  private progress(job: Job, text: string): void {
    if (job.progressSpoken >= THREAD_PROGRESS_PER_TURN) return;
    if (this.now() - job.lastSpokenAt < THREAD_PROGRESS_GAP_MS) return;
    job.progressSpoken++;
    this.say(job, `${job.name}: ${cutLine(text)}`);
  }

  /** Every result a lane's runner produced: waits are counted here (three in a row fail the thread), holds noted. */
  private onLaneOutcome(laneId: string, toolName: string, result: ToolResult): void {
    const job = this.jobs.get(laneId);
    if (!job || job.settled) return;
    if (result.kind === "error" && result.message.startsWith("waiting for the screen")) {
      job.waits++;
      this.table.waited(job.id);
      this.setStatus(job, "waiting-screen", result.message);
      if (job.waits >= THREAD_WAITS_MAX) void this.stopJob(job, "budget", "could not get the screen");
      return;
    }
    if (result.kind === "needs-confirmation") {
      job.question = result.question;
      job.hold = result.pendingId === HOLD_ID;
      return;
    }
    if (result.kind !== "error") {
      job.waits = 0;
      if (this.table.get(job.id)?.status === "waiting-screen") this.setStatus(job, "thinking");
    }
    log.debug(`thread ${job.name}: ${toolName} → ${result.kind}`);
  }

  /**
   * The lane began waiting for the screen (the rail's hourglass, at once). The end of a
   * wait is not a status of its own: the tool's outcome decides — a result that landed
   * flips the thread back to thinking (onLaneOutcome), a "waiting for the screen" answer
   * keeps it waiting — so one wait streak is one status change and one ledger row.
   */
  private onLaneWaiting(laneId: string, waiting: boolean, reason: string | undefined): void {
    const job = this.jobs.get(laneId);
    if (!job || job.settled || !waiting) return;
    this.setStatus(job, "waiting-screen", reason ? `waiting for the screen: ${reason}` : undefined);
  }

  /**
   * A status change on the table (one event) and, for the statuses the rebuild
   * needs — waiting-screen, waiting-kevin, paused — one ledger row. thinking↔acting
   * never writes a row (they would flood the day file); `waits` is counted here too.
   */
  private setStatus(job: Job, status: ThreadStatus, detail?: string): void {
    const before = this.table.get(job.id)?.status;
    const clean = detail !== undefined ? job.laneRef.runner.redactor.redact(detail) : undefined;
    const ev = this.table.status(job.id, status, clean);
    this.publish(ev);
    if (ev && before !== status && (status === "waiting-screen" || status === "paused" || status === "waiting-kevin")) {
      this.row({ at: this.now(), type: "thread.status", threadId: job.id, status, threadStatus: status, ...(clean !== undefined ? { detail: cutLine(clean, 200) } : {}) });
      job.turns.system(status === "paused" ? "pause.fill" : "hourglass", clean ?? status);
    }
    if (ev) this.notify();
  }

  // ------------------------------------------------------------- ending

  /**
   * Cut one thread. `by`: "kevin" (the Console's Stop, a spoken "stop the Slack one")
   * and "brain" (thread_stop) speak "<Name> stopped."; "cut" (interrupt, Stop, Pause,
   * sleep) is silent — the verb already spoke or closed the session; "budget" is a
   * failure with its reason.
   */
  private async stopJob(job: Job, by: StopBy, reason: string): Promise<void> {
    if (job.settled) return;
    job.abort.abort();
    const turn = job.turn;
    let cancel = Promise.resolve();
    if (turn) {
      turn.abort.abort();
      cancel = this.cancelBrain(job, turn);
    }
    job.laneRef.runner.abortTask(reason);
    job.laneRef.runner.attach(undefined); // the lease goes; a late tool.run {thread} is refused (attached === false)
    // Its question goes with it — THIS lane's only: a queued one is forgotten, one on the floor is
    // dropped and the next queued question comes up, spoken (`desk.dropQuestion()` would take the
    // whole queue with it, and another hand's question would never be asked).
    this.opts.desk.forget(job.id);
    if (by === "budget") this.endJob(job, "failed", reason, `${job.name} failed: ${cutLine(reason)}`);
    else this.endJob(job, "stopped", reason, by === "cut" ? undefined : `${job.name} stopped.`);
    await cancel;
  }

  /** `brain.cancel()` once per turn, whatever cut it; never throws. */
  private cancelBrain(job: Job, turn: ThreadTurn): Promise<void> {
    if (turn.brainCancelled) return Promise.resolve();
    turn.brainCancelled = true;
    return job.laneRef.brain.cancel().catch((e: unknown) => log.debug(`thread ${job.name} cancel: ${(e as Error).message}`));
  }

  private endJob(job: Job, status: "done" | "failed" | "stopped", detail: string, line: string | undefined): void {
    if (job.settled) return;
    job.settled = true;
    this.clearTimer(job);
    this.jobs.delete(job.id);
    const turn = job.turn;
    if (turn && !turn.closed) job.turns.close(turn, { status: status === "done" ? "done" : status === "failed" ? "failed" : "cancelled", summary: detail });
    job.turn = undefined;
    job.pendingTurn = undefined;
    const clean = job.laneRef.runner.redactor.redact(detail);
    // The finish line FIRST, then the end: a consumer that closes the thread on `ended` (the Console's store) has its last line.
    if (line) job.spoken = this.say(job, line);
    this.publish(this.table.ended(job.id, status, clean));
    const t = this.table.get(job.id);
    const at = this.now();
    this.row({ at, type: "thread.ended", threadId: job.id, status, threadStatus: status, summary: cutLine(clean, 200), steps: t?.steps ?? 0, seconds: Math.max(0, Math.round((at - (t?.startedAt ?? at)) / 1000)) });
    this.finished.push(job);
    if (this.finished.length > FINISHED_MAX) this.finished.splice(0, this.finished.length - FINISHED_MAX);
    job.laneRef.runner.attach(undefined);
    this.opts.lease.release(job.id, "done");
    // Its remembered app and the apps it activated stop counting as a lane's.
    this.opts.lease.forget(job.id);
    // A finished thread's question is nobody's now (queued or on the floor: a thread that ends while
    // its question waits was cut, not answered); the next queued question comes up.
    this.opts.desk.forget(job.id);
    job.turns.system(status === "done" ? "checkmark" : status === "failed" ? "xmark" : "stop.fill", `${job.name} ${status}: ${cutLine(clean, 120)}`);
    log.info(`thread ${job.name} (${job.id}) ${status} after ${t?.steps ?? 0} steps: ${clean.slice(0, 120)}`);
    // Its process goes; the pool tops up its spares (not while closed for a sleep). Tracked: a sleep awaits every release.
    const release: Promise<void> = this.pool.release(job.laneRef).finally(() => this.releasing.delete(release));
    this.releasing.add(release);
    job.log.trim();
    this.changed();
    this.notify();
  }

  /** The list of threads changed (a start, an end): the one time the snapshot is asked for. */
  private changed(): void {
    this.listChanges++;
    this.opts.onChange();
  }

  /** Every process release in flight has settled (their brains' `stop()` returned). */
  private async settleReleases(): Promise<void> {
    while (this.releasing.size > 0) await Promise.all([...this.releasing]);
  }

  /** One line for Kevin, in Jarhead's voice — struck of secrets first, like every text a model or Kevin gets. Returns what was said. */
  private say(job: Job, line: string): string {
    const clean = job.laneRef.runner.redactor.redact(line);
    this.opts.voice()?.threadSay(job.parent.id, job.name, clean);
    this.publish(this.table.said(job.id, clean));
    this.row({ at: this.now(), type: "thread.said", threadId: job.id, text: clean });
    job.turns.system("waveform", clean);
    job.lastSpokenAt = this.now();
    return clean;
  }

  // -------------------------------------------------------------- verbs

  /** The Console's Stop on a row, a spoken stop by name, or the main brain's thread_stop. True when a live thread was cut. */
  async stop(threadId: string, by: "kevin" | "brain" | "cut" = "kevin"): Promise<boolean> {
    const job = this.jobs.get(threadId);
    if (!job) return false;
    await this.stopJob(job, by, by === "kevin" ? `${this.userName} stopped it` : by === "brain" ? "stopped by the main brain" : "cut");
    return true;
  }

  /** "stop the Slack one": the live thread by that name, case-insensitive. */
  async stopNamed(name: string, by: "kevin" | "cut" = "kevin"): Promise<boolean> {
    const t = this.table.byNameLive(name);
    return t ? this.stop(t.id, by) : false;
  }

  /**
   * A follow-up turn on a live thread ("spotify, skip this song"): the running turn is
   * superseded — its signal aborted, `brain.cancel()` awaited, its record closed
   * `cancelled` — and the next turn runs on the same brain with Kevin's words and his
   * circled marks. A paused thread resumes with the words. False for a thread that is
   * not live.
   */
  async followUp(threadId: string, request: string, opts: { readonly items?: readonly TranscriptItem[] | undefined; readonly marks?: readonly BrainAttachment[] | undefined } = {}): Promise<boolean> {
    const job = this.jobs.get(threadId);
    if (!job || job.settled) return false;
    const words = request.replace(/\s+/g, " ").trim();
    if (!words) return false;
    for (const item of opts.items ?? []) job.turns.utterance(item);
    if (!opts.items?.length) job.turns.system("keyboard", words);
    const kevinDialogue = [job.parent.kevinDialogue, words].filter((s): s is string => Boolean(s)).join("\n");
    const spec: TurnSpec = { request: words, dialogue: `${job.brief}\n\n${this.userName} (to ${job.name}): ${words}`, kevinDialogue, confirmation: false, marks: opts.marks };
    if (!job.booted) {
      // Its brain is still booting (0.5–7 s on this Mac): the words wait for it and become its first
      // turn — one `handle` on one brain, never two. A pause meanwhile is undone by the words.
      job.pendingTurn = spec;
      if (this.table.get(threadId)?.status === "paused") this.setStatus(job, "starting");
      return true;
    }
    await this.supersede(job, `superseded by ${this.userName}'s follow-up`);
    if (job.settled) return false;
    // A question the thread was waiting on goes with the turn that asked it — off the floor (or out of the
    // queue) BEFORE the next turn, or Kevin's later yes would arm an action nobody asked about any more
    // (the handshake's rule: a yes lands only on the question he heard). The next queued question comes up.
    if (job.question !== undefined || this.table.get(threadId)?.status === "waiting-kevin") {
      this.opts.desk.drop(threadId);
      job.question = undefined;
    }
    this.setStatus(job, "thinking");
    void this.runTurn(job, spec);
    return true;
  }

  /**
   * End the turn in flight without ending the job; resolves once the brain has let go —
   * or, after `supersedeWaitMs`, without it: the record closes `cancelled` and the next
   * turn goes ahead (a brain whose `handle` never returns after `cancel()` must not hang
   * a follow-up, a pause or the global Pause; its late return finds the turn closed).
   */
  private async supersede(job: Job, reason: string): Promise<void> {
    const turn = job.turn;
    if (!turn || turn.closed) return;
    turn.superseded = reason;
    turn.abort.abort();
    this.clearTimer(job);
    await this.cancelBrain(job, turn);
    if (await settledWithin(turn.settled, this.supersedeWaitMs)) return;
    log.warn(`thread ${job.name}: its brain did not let go of the turn within ${this.supersedeWaitMs} ms; the record closes without it`);
    this.closeSuperseded(job, turn);
  }

  /**
   * Kevin's yes reached the thread's question: its brain re-calls the same tool on a
   * new turn of its own thread (`confirmation: true`). A paused thread resumes with a
   * continuation turn instead. The Delegator calls this after arming the root; the
   * Console's Allow goes through `answerYes`, which checks the floor first.
   */
  async resume(threadId: string): Promise<void> {
    const job = this.jobs.get(threadId);
    if (!job || job.settled) return;
    const t = this.table.get(threadId);
    if (!t) return;
    if (t.status === "waiting-kevin") {
      this.setStatus(job, "thinking");
      job.question = undefined;
      void this.runTurn(job, { request: job.parent.request, dialogue: `${job.brief}${confirmationResume(this.userName)}`, kevinDialogue: job.parent.kevinDialogue, confirmation: true });
      return;
    }
    if (t.status === "paused") {
      job.turns.system("play.fill", `${this.userName} resumed it`);
      if (!job.booted) {
        // Paused while its brain booted: back to starting; the boot's end runs the first turn (or the follow-up that waited).
        this.setStatus(job, "starting");
        return;
      }
      this.setStatus(job, "thinking");
      const spec = job.pendingTurn ?? { request: job.parent.request, dialogue: `${job.brief}${resumeText(t.steps, this.userName)}`, kevinDialogue: job.parent.kevinDialogue, confirmation: false };
      job.pendingTurn = undefined;
      void this.runTurn(job, spec);
    }
  }

  /**
   * The Console's Allow on a thread's pane: arms the root ONLY when that thread's
   * question is the one on the floor (a yes never lands another lane's action), writes
   * the grant row iff grantable, and runs the confirmation turn. "main" is the engine's
   * to arm (its turn is the Delegator's).
   */
  async answerYes(threadId: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const floor = this.opts.desk.floor;
    if (!floor) return { ok: false, reason: "no question is waiting" };
    const laneId = threadId === MAIN_THREAD_ID ? ThreadAwareRunner.ACTOR : threadId;
    if (floor.laneId !== laneId) return { ok: false, reason: `another question is on the floor: ${floor.name}'s` };
    if (threadId === MAIN_THREAD_ID) return { ok: false, reason: "the main thread's yes is the engine's to arm" };
    const job = this.jobs.get(threadId);
    if (!job || job.settled) return { ok: false, reason: "that thread is gone" };
    if (!this.opts.desk.root.arm(this.grantRecord())) return { ok: false, reason: "the question has expired" };
    await this.resume(threadId);
    return { ok: true };
  }

  /**
   * The Console's Deny: that lane's question goes (nobody else's). A thread waiting on
   * the yes cannot go on without it and stops (its lane is forgotten with it); a live
   * thread that is not waiting keeps its lane — only its question is dropped; a finished
   * thread's leftover lane, if any, goes whole.
   */
  async answerNo(threadId: string): Promise<boolean> {
    const job = this.jobs.get(threadId);
    if (!job || job.settled) {
      this.opts.desk.forget(threadId);
      return false;
    }
    if (this.table.get(threadId)?.status === "waiting-kevin") {
      await this.stopJob(job, "kevin", `${this.userName} said no`);
      return true;
    }
    this.opts.desk.drop(threadId);
    job.question = undefined;
    return true;
  }

  /** The grant row a yes writes as it is armed (the ledger keeps it; without a ledger the yes is one-off). */
  private grantRecord(): ((g: ConfirmationGrant) => void) | undefined {
    const ledger = this.opts.ledger;
    if (!ledger) return undefined;
    return (g) => ledger.append({ at: this.now(), type: "grant", chainId: this.opts.desk.root.conversationId, app: g.app, actionClass: g.actionClass, until: g.until });
  }

  /**
   * Pause one thread: its turn is superseded (brain.cancel once), its lease released,
   * its question dropped; the record stays `paused`, the process stays warm. `resume`
   * runs a continuation turn.
   */
  async pause(threadId: string, by: "kevin" | "cut" = "kevin"): Promise<boolean> {
    const job = this.jobs.get(threadId);
    if (!job || job.settled) return false;
    const t = this.table.get(threadId);
    if (!t || t.status === "paused") return false;
    const reason = by === "kevin" ? `${this.userName} paused it` : "paused";
    if (!job.booted) {
      // Its brain is still booting: nothing to supersede; the boot's end finds it paused and runs no turn.
      this.setStatus(job, "paused", reason);
      return true;
    }
    await this.supersede(job, reason);
    if (job.settled) return false;
    job.laneRef.runner.attach(undefined);
    this.opts.lease.release(threadId, "turn-end");
    this.opts.desk.drop(threadId);
    job.question = undefined;
    this.setStatus(job, "paused", reason);
    return true;
  }

  /** Global Pause: every live thread paused, brains interrupted, processes kept. */
  async pauseAll(by: "kevin" | "cut" = "kevin"): Promise<void> {
    await Promise.all([...this.jobs.values()].map((j) => this.pause(j.id, by)));
  }

  /** Global Resume: continuation turns, oldest first. */
  async resumeAll(): Promise<void> {
    for (const id of this.table.liveIds()) {
      if (this.table.get(id)?.status === "paused") await this.resume(id);
    }
  }

  /** A cut verb: every thread cancelled quietly, each brain's cancel called once. Resolves when the cancels settle. */
  cancelAll(reason: string): Promise<void> {
    const jobs = [...this.jobs.values()];
    return Promise.all(jobs.map((j) => this.stopJob(j, "cut", reason))).then(() => undefined);
  }

  /**
   * Sleep / shutdown: every thread cancelled and every process — the spares too —
   * stopped, and none started behind it: the pool closes FIRST (a thread's release that
   * settles during the cancel tops nothing up), the releases are awaited (a real
   * `brain.stop()` takes time), then the spares go. 0 processes when this resolves; the
   * next wake's `warm()` opens the pool again.
   */
  async stopAll(): Promise<void> {
    this.pool.close();
    await this.cancelAll("going to sleep");
    await this.settleReleases();
    await this.pool.stopAll();
    this.events.flush();
  }

  /** Resolves once this parent has no live thread (or the signal aborts). */
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

  /** Threads alive right now (starting, thinking, acting, waiting, paused), for one parent or all. */
  running(parentId?: string): number {
    let n = 0;
    for (const j of this.jobs.values()) if (parentId === undefined || j.parent.id === parentId) n++;
    return n;
  }

  /** The thread whose question is on the floor — main included ("Jarhead") — or undefined when the floor is free or the lane is nobody's. */
  floorThread(): ThreadFloor | undefined {
    const floor = this.opts.desk.floor;
    if (!floor) return undefined;
    if (floor.laneId === ThreadAwareRunner.ACTOR) return { id: MAIN_THREAD_ID, name: "Jarhead" };
    const job = this.jobs.get(floor.laneId);
    return job ? { id: job.id, name: job.name } : undefined;
  }

  /** A screen-lane thread is at work (thinking, acting or waiting for the screen): the ear holds; background threads never hold it. */
  anyScreenBusy(): boolean {
    for (const j of this.jobs.values()) {
      if (j.lane !== "screen") continue;
      const s = this.table.get(j.id)?.status;
      if (s === "thinking" || s === "acting" || s === "waiting-screen" || s === "starting") return true;
    }
    return false;
  }

  /** The desk promoted a lane's question: a thread's is spoken with its name. False when no thread owns the lane (the main lane's — the engine speaks for it). */
  speakQuestion(laneName: string, question: string): boolean {
    const job = [...this.jobs.values()].find((j) => j.name === laneName || j.id === laneName);
    if (!job) return false;
    // A promoted question was recorded `waiting-kevin` (with its own words) when its turn ended: one row per
    // status change, so a promotion writes none; the table appends events only when the words changed.
    const already = this.table.get(job.id)?.status === "waiting-kevin";
    job.question = question;
    this.publish(this.table.question(job.id, question));
    if (!already) this.row({ at: this.now(), type: "thread.status", threadId: job.id, status: "waiting-kevin", threadStatus: "waiting-kevin", detail: cutLine(question, 200) });
    this.say(job, `${job.name} asks: ${cutLine(question, 160)}`);
    this.notify();
    return true;
  }

  /** The runner a `tool.run {thread}` frame lands on; undefined for a thread nobody owns (the daemon refuses). */
  runnerFor(threadId: string): ToolRunner | undefined {
    return this.jobs.get(threadId)?.laneRef.runner;
  }

  /** The snapshot's `threads`: live (main first) and lingering summaries. */
  threads(): readonly Thread[] {
    return this.table.summaries();
  }

  /** One record, live or lingering. */
  get(threadId: string): Thread | undefined {
    return this.table.get(threadId);
  }

  /** The thread's pane: its recent turns and its seq-numbered log (undefined once evicted). */
  log(threadId: string): ThreadLog | undefined {
    return (this.jobs.get(threadId) ?? this.finished.find((j) => j.id === threadId))?.log;
  }

  turnsOf(threadId: string): readonly import("@jarhead/protocol").Delegation[] {
    return (this.jobs.get(threadId) ?? this.finished.find((j) => j.id === threadId))?.turns.all() ?? [];
  }

  /** Deterministic English for "what is Spotify doing" / "what are you doing": zero generations. */
  statusLine(name?: string): string {
    return this.table.statusLine(name);
  }

  /** The names the reflex grammar matches against — live spawned threads only. */
  threadNames(): readonly string[] {
    return this.table.liveNames();
  }

  /** Warm the spares (Settings.warmThreads) at wake and after a retry window. Nothing awaits it. */
  warm(): number {
    if (!this.opts.enabled()) return 0;
    return this.pool.warm();
  }

  /** For tests: the first spare lane's id, if one is warm or booting. */
  get spareId(): string | undefined {
    return this.pool.spareIds[0];
  }

  get spareIds(): readonly string[] {
    return this.pool.spareIds;
  }

  /**
   * The engine's tick: the acting→thinking flip after ACTING_HOLD_MS without a step,
   * a spare top-up when a retry window passed (never while the pool is closed for a
   * sleep), and the idle end — a paused thread or one waiting on a yes for
   * THREAD_IDLE_END_MS ends `done "idle"` and its lane returns.
   */
  tick(now = this.now()): void {
    for (const e of this.table.tick(now)) this.publish(e);
    this.pool.topUp();
    for (const job of [...this.jobs.values()]) {
      const t = this.table.get(job.id);
      if (!t) continue;
      if ((t.status === "paused" || t.status === "waiting-kevin") && now - t.updatedAt >= THREAD_IDLE_END_MS) {
        this.opts.desk.forget(job.id);
        this.endJob(job, "done", "idle", undefined);
      }
    }
  }

  /** Events from outside the scheduler (the engine's main-thread writes) through the same coalescer. */
  publish(events: ThreadEvent | readonly ThreadEvent[] | undefined): void {
    if (!events) return;
    if (Array.isArray(events)) for (const e of events as readonly ThreadEvent[]) this.events.push(e);
    else this.events.push(events as ThreadEvent);
  }

  /** Everything coalesced goes out now. */
  flushEvents(): void {
    this.events.flush();
  }

  dispose(): void {
    this.events.dispose();
    for (const job of this.jobs.values()) this.clearTimer(job);
  }

  // ------------------------------------------------------------- inner

  /**
   * One lane built cold, outside the pool: for the automations' headless `wake-brain` turn,
   * which takes a single brain process and never opens the pool (asleep, no spare boots
   * behind Jarhead's back). Undefined when the current brain kind cannot run a thread.
   */
  coldLane(): Lane | undefined {
    const factory = this.opts.makeBrain();
    return factory ? this.makeLane(newId("t"), factory) : undefined;
  }

  private makeLane(id: string, factory: ThreadBrainFactory): Lane | undefined {
    const hands = new LaneHands(this.opts.hands.background, this.opts.hands.background);
    const confirmations = new LaneConfirmations();
    const base = this.opts.toolsetOptions();
    const toolset = new ComputerToolset({ ...base, hands, screen: new Screen(), confirmations, annotate: (cmd) => this.annotate(id, base.annotate, cmd) });
    const runner = new LaneRunner({
      ...this.opts.runnerOptions(),
      toolset,
      lane: "background",
      laneId: id,
      lease: this.opts.lease,
      desk: this.opts.desk,
      onWaiting: (waiting, reason) => this.onLaneWaiting(id, waiting, reason),
      onOutcome: (name, result) => this.onLaneOutcome(id, name, result),
      observer: this.opts.observer,
      serializer: this.opts.serializer,
    });
    const brain = factory({ runner, threadId: id, secondsCap: THREAD_SECONDS_MAX });
    if (!brain) return undefined;
    return { id, hands, confirmations, toolset, runner, brain, started: undefined };
  }

  /** The lane's overlay commands, tagged with the thread: its blob flies where it acts; the table learns the point. */
  private annotate(id: string, base: ((cmd: OverlayCommand) => void) | undefined, cmd: OverlayCommand): void {
    if (cmd.cmd === "orb.fly") {
      base?.({ ...cmd, thread: id });
      this.publish(this.table.at(id, { x: cmd.x, y: cmd.y }));
      return;
    }
    if (cmd.cmd === "orb.trace") {
      base?.({ ...cmd, thread: id });
      return;
    }
    base?.(cmd);
  }

  private jobsOf(parentId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.parent.id === parentId);
  }

  /** By live name (case-insensitive) or id; `parentId` narrows to that parent's threads when given. */
  private jobNamed(name: string, parentId?: string): Job | undefined {
    const key = name.trim().toLowerCase();
    for (const j of this.jobs.values()) {
      if (parentId !== undefined && j.parent.id !== parentId) continue;
      if (j.name.toLowerCase() === key || j.id === name) return j;
    }
    return undefined;
  }

  private row(row: LedgerRow): void {
    try {
      this.opts.ledger?.append(row);
    } catch (e) {
      log.warn(`${row.type} row not written: ${(e as Error).message}`);
    }
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** True when `p` settles within `ms` (real time: a brain's `handle` is real I/O). */
function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void p.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The app a tool call works in: open_app / focus_app's name, an AppleScript's `tell application "X"`, a browser host. */
export function appHint(name: string, input: unknown): string | undefined {
  const a = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "open_app":
    case "focus_app": {
      const v = String(a["name"] ?? a["app"] ?? "").trim();
      return v || undefined;
    }
    case "applescript": {
      const m = /tell\s+application\s+"([^"]{1,32})"/i.exec(String(a["script"] ?? ""));
      return m?.[1];
    }
    case "browser_navigate":
    case "open_url": {
      try {
        return new URL(String(a["url"] ?? "")).host || undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return undefined;
  }
}
