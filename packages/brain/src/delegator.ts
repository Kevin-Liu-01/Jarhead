import { EventEmitter } from "node:events";
import { isAbsolute, join } from "node:path";
import { logger, newId, Marks, type Ledger } from "@jarhead/core";
import { chunkForAppend, type LiveSession, type Transcript } from "@jarhead/live";
import { ACTING_MEMBERS, YES_PATTERN, type ConfirmationState } from "@jarhead/hands";
import type { Delegation, DelegationStep, DelegationTimings, ScreenMark, TranscriptItem } from "@jarhead/protocol";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { markNote } from "./attachments.ts";
import { addressesJarhead, normalizeUtterance, parseReflex, type Reconciliation, type Reflex, type ReflexOutcome } from "./reflex.ts";
import { progressLine } from "./responses.ts";
import { ALL_TOOL_SPECS } from "./tools.ts";

/**
 * Where the voice meets the brain.
 *
 * Listens to one LiveSession, builds a task for every delegation from the
 * transcript, runs it on the brain, and relays progress back through the three
 * append channels with the 500-token cap respected. Also owns the two spoken
 * escape hatches: "stop" ends the running task (through the engine's
 * stopEverything when it is wired, so the speaker, the hands and the toast go
 * with it), and a "yes" arms a pending confirmation so the next attempt of that
 * exact action goes through.
 *
 * Two things happen here before a brain is involved. A *reflex* — "scroll down",
 * "press enter", "open Safari" — is run straight through the ToolRunner and the
 * delegation finishes at once. The cheap reversible ones may *prefire*: when the
 * utterance has clearly ended (the transcriber closed the sentence, or it has
 * been quiet for a good while) and Kevin named Jarhead, the reflex runs before
 * Live delegates, as a delegation record of its own — created, stepped and
 * finished on the ledger like any other — which the delegation that follows
 * adopts (by transcript item, never by text alone) and only has to speak for.
 * And the *eyes* pre-warm: a quick screenshot taken while the circled regions are
 * gathered, handed to the brain as its first attachment so its first move can be
 * an action.
 *
 * Two kinds of slot. `running` is the delegation whose brain turn is in flight —
 * still exactly one at a time. A *draining* delegation is one whose brain has
 * finished (or was cut short by Kevin's next request) while the workers it started
 * are still at work: it stays on the timeline, its workers' steps and finish lines
 * land on it, and it closes when they drain. Several may drain at once (a two-app
 * errand, then another, then a third request): each keeps its own record until its
 * own workers are done — a parent is never closed over a hand still working, so
 * every worker's one finish line is still spoken. Kevin's words are judged before
 * anything is superseded: a dismissal ("go to sleep", "that's all") goes to the
 * engine's one sleep function, and a "yes" meant for a worker's question resumes
 * that worker without touching the brain's running turn.
 */

const log = logger("delegator");

/**
 * How long a task waits on the durable-memory lookup, at most. It rides the marks
 * and eyes race (the eyes' quick shot is ~50–250 ms), so a cached query embedding
 * costs nothing visible and a cold one is cut here rather than moving the first
 * action; `jarhead bench` holds delegation → first action within ±50 ms of before.
 */
export const MEMORY_RECALL_MS = 250;

/** Kevin's own lines since `sinceMs`, one per line, oldest first: what the gates read and what memory is asked with. */
function kevinLines(transcript: Transcript, sinceMs: number): string {
  return transcript
    .since(sinceMs, "kevin")
    .map((i) => i.text.trim())
    .filter(Boolean)
    .join("\n");
}

export interface DelegatorOptions {
  readonly live: LiveSession;
  readonly transcript: Transcript;
  readonly brain: Brain;
  readonly confirmations: ConfirmationState;
  readonly ledger?: Ledger;
  /** How much dialogue to hand the brain. */
  readonly dialogueWindowMs?: number;
  readonly now?: () => number;
  /** Regions Kevin circled since the last task; they ride with the next one and are then consumed. */
  readonly marks?: PendingMarks;
  /**
   * The pre-warm shot: a quick screenshot taken as the task begins, in parallel
   * with the marks, returned as an attachment (`kind: "screen"`) or undefined
   * when there are no eyes right now. The sink is attached so the shot lands in
   * this delegation's timeline.
   */
  readonly eyes?: ((sink: BrainSink) => Promise<BrainAttachment | undefined>) | undefined;
  /**
   * Durable memory of Kevin (the engine's MemoryBridge over @jarhead/memory): given
   * the request plus Kevin's recent lines as the query, answers the rendered block
   * (≤ BRAIN_MEMORY_TOKENS, its own label added by promptParts) or undefined when
   * the store has nothing worth the tokens. It races the marks and the eyes and
   * is cut at MEMORY_RECALL_MS: the first action never waits on a lookup. Absent =
   * no memory in the task.
   */
  readonly memory?: ((query: string, signal: AbortSignal) => Promise<string | undefined>) | undefined;
  /** The reflex table and its runner; absent = every task goes to the brain. */
  readonly reflexes?: ReflexSource | undefined;
  /**
   * Kevin said "stop" while a task ran. When wired (the engine's stopEverything)
   * it owns the whole stop — speaker, hands, jobs, toast, this delegation — and
   * the delegator does not cancel on its own; without it the delegator cancels
   * the task itself.
   */
  readonly onStop?: ((reason: string) => void) | undefined;
  /**
   * Kevin dismissed Jarhead through the voice ("go to sleep", "shut off",
   * "goodnight", "that's all for now"): the engine's `fallAsleep("said", …)` — the
   * one closer — gets his words. Judged first in `onDelegation`, before a running
   * task is superseded, so nothing else is started for those words. Without it a
   * dismissal is the brain's like any request (the reflex table never runs it).
   */
  readonly onSleep?: ((phrase: string) => void) | undefined;
  /**
   * The engine's worker pool as the delegator sees it. With it, a delegation whose
   * brain finished with workers still running drains instead of finishing, a new
   * request parks the running one instead of cancelling its workers, a "yes" for a
   * worker's question resumes that worker, and a spoken "stop" is heard while only
   * workers run. Absent = no workers anywhere.
   */
  readonly workers?: DelegatorWorkers | undefined;
  /**
   * A reason to refuse every new delegation right now ("Kevin paused you"), or
   * undefined to take them. A refused delegation still gets its record: created
   * and finished as cancelled with that reason, so the ledger says what happened.
   */
  readonly refuse?: (() => string | undefined) | undefined;
  /** Consecutive commentary lines within this window go to Live as one append (default 600 ms; 0 sends each at once). */
  readonly commentaryCoalesceMs?: number | undefined;
  /** Quiet after an utterance the transcriber closed with a full stop before a prefire is considered (default 180 ms). */
  readonly prefireQuietMs?: number | undefined;
  /** Quiet after an utterance with no terminal punctuation before a prefire is considered (default 450 ms: a mid-sentence pause is shorter). */
  readonly prefireLongQuietMs?: number | undefined;
  /** How long a prefired reflex waits to be adopted by Live's delegation before its record is closed as never delegated (default 8 s). */
  readonly prefireTtlMs?: number | undefined;
  /**
   * Wall clock of the session timeline's zero (the engine's `session.started`), or
   * 0 when no session is open. With it, the triggering utterance's `endMs` becomes
   * `DelegationTimings.speechEndAt` — the moment Kevin stopped talking, on the same
   * clock as every other stamp. Without it the field stays absent.
   */
  readonly sessionStartedAt?: (() => number) | undefined;
  /**
   * Speak the brain's first tool call that does something — a click, a type, a
   * search, a command; never a look (see SILENT_TOOLS) — as one short line through
   * the commentary channel, the moment its step lands, unless the brain has
   * already said something itself. Kevin hears the action as it happens instead
   * of waiting for the summary. Fire-and-forget: nothing waits on it. Default off;
   * the engine turns it on.
   */
  readonly voiceFirstTool?: boolean | undefined;
  /**
   * How a worker's line reaches the voice: `commentary` (default) appends it on
   * the parent's delegation through the 600 ms coalescer like every other line;
   * `instructions` is the fallback channel should a paid probe show Live drops
   * commentary on a delegation whose brain turn ended — the voice is told to say
   * the line now. Default from env JARHEAD_WORKER_SAY.
   */
  readonly workerSayChannel?: "commentary" | "instructions" | undefined;
}

/** The engine's WorkerPool, as much of it as the delegator needs. */
export interface DelegatorWorkers {
  /**
   * Resolves once every worker of this delegation has finished, failed or been
   * cancelled — or at once when the signal aborts (a cut ends the wait, never the
   * workers: their controllers are the pool's).
   */
  drain(delegationId: string, signal: AbortSignal): Promise<void>;
  /** Workers still alive for this delegation, or in total without an id. */
  running(delegationId?: string): number;
  /** Kevin's yes was armed for the worker holding the question floor: it re-runs its tool on its own thread. */
  resume(workerId: string): Promise<void>;
  /**
   * The worker whose question holds the confirmation floor right now, or
   * undefined when the floor is free or the main brain's own question holds it. A
   * bare id is accepted; with the name the record can say who the yes went to.
   */
  floorLane(): WorkerFloor | string | undefined;
  /** True while Jarhead is mid-exchange (spoke or was spoken to a moment ago). Informational here: Live's attention gate is the addressing test for a spoken cue. */
  inExchange?(): boolean;
}

/** Who holds the confirmation floor, when it is a worker. */
export interface WorkerFloor {
  readonly id: string;
  readonly name: string;
}

/** What the delegator needs to run a reflex; the engine builds it over its ToolRunner. */
export interface ReflexSource {
  match(utterance: string): Reflex | undefined;
  /** Run it with the sink attached, so the tool step lands in the delegation (a prefire has a record of its own). */
  run(reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome>;
  /** True while Jarhead is mid-exchange (spoke or was delegated to a moment ago); a prefire without the wake word needs this and a closed sentence. */
  inExchange?(): boolean;
  /**
   * The ear already acted on these words (the 250 ms path): "done" finishes the
   * delegation at once with the reflex's own line; "partial" says the reflex did
   * the tail of a longer request and the brain takes the rest; "mismatch" says the
   * reflex acted on other words than the request carries (the engine has undone
   * what it can, and says so in `undone`) and the task goes on to the brain with a
   * note. Undefined: nothing happened yet. **Claims** the match — call it once, from
   * the delegation that is taking the reflex as its own; it may take a moment (the
   * undo).
   */
  reconcile?(utterance: string): Reconciliation | undefined | Promise<Reconciliation | undefined>;
  /** The same look without the claim, for the prefire check: a peek must leave the reflex for the delegation to find. */
  peek?(utterance: string): Reconciliation | undefined;
}

/** The engine's ScreenMarks as the delegator sees them. */
export interface PendingMarks {
  /** Unconsumed marks, oldest first. */
  pending(): readonly ScreenMark[];
  /** The marks with these ids were handed to the brain. */
  consume(ids: readonly string[]): void;
  /** The brain never took the task (it failed before doing anything); these marks are pending again. */
  release(ids: readonly string[]): void;
  /** Resolves once every capture still in flight has landed (or given up), so a mark circled a moment ago rides with this task, pixels included. */
  settled?(): Promise<void>;
  /** ScreenMark.screenshotPath is relative to this directory. */
  readonly stateDir: string;
}

export interface DelegatorEvents {
  change: [delegation: Delegation];
  phase: [phase: "thinking" | "acting" | "idle"];
  /** A running delegation was cancelled (stop word, Stop button, sleep). */
  cancelled: [reason: string];
  /** A reflex ran (label as understood, ms it took, whether before the delegation arrived). */
  reflex: [label: string, ms: number, prefired: boolean];
}

/**
 * What the ledger's `delegation.finished` row carries beyond the contract's
 * DelegationTimings: when the first tool ran, when the first *action* (a member
 * that moves or types) ran, every tool's round trip, and whether a reflex did the
 * work. The Swift decoder ignores keys it does not know; the contract should grow
 * these as optional fields.
 */
export interface DelegationTimingsExtra extends DelegationTimings {
  readonly firstToolAt?: number;
  // firstActionAt and speechEndAt moved into the contract's DelegationTimings (packages/protocol).
  readonly toolRoundTripMs?: readonly number[];
  readonly reflex?: boolean;
  /** How long the eyes' pre-warm shot took, when one was taken. */
  readonly eyesMs?: number;
}

/**
 * What stamps `firstActionAt` — a step that changed something Kevin can see or
 * that acted on the Mac: the hands' acting members, the tools that act without
 * the hands, and the overlays drawn on his screen ("circle where Slack is": the
 * circle IS the visible action; `show_clear` removes, it does not show). Only a
 * step whose tool returned ok counts (a click that was refused, a `type` with no
 * text, a shell command the policy stopped did nothing). The bench keeps a copy
 * of this set (packages/cli/src/bench-brain.ts); both tests pin it.
 */
export const ACTING_TOOLS: ReadonlySet<string> = new Set([...ACTING_MEMBERS, "applescript", "run_shell", "write_file", "edit_file", "browser_navigate", "browser_click", "browser_type", "show_circle", "show_arrow", "show_rect", "show_text", "show_stroke"]);

const STOP_PATTERN = /^\s*(stop|cancel|never ?mind|forget it|abort|that'?s enough|hold on)\b/i;
/**
 * Narration at the level of intent (REDESIGN §17, the voice's `# Narration`): a
 * brain line that reads as one click — "Clicking Save.", "Pressing Return.",
 * "Scrolling down." — once something has already been voiced for this task.
 * Such lines stay on the timeline and never reach the voice; the first spoken
 * line of a task passes whatever its shape (Kevin hears that work began).
 */
const PER_CLICK_LINE = /^\s*(?:clicking|clicked|pressing|pressed|scrolling|scrolled|taking a screenshot|took a screenshot|zooming|zoomed|moving the (?:mouse|pointer|cursor)|pointing at|double[- ]clicking)\b/i;
/**
 * A line that asks Kevin something — a question, or the confirmation handshake's own
 * words ("say yes"). He has to hear it to answer it, so it is never gated, whatever
 * else it carries (the runner's question quotes the command: `run "python edit_file.py"`).
 */
const ASKS_KEVIN = /\?|\b(?:say yes|confirm|go ahead)\b/i;
/** Every tool the brains have, by name: a spoken line that carries one of these is mechanics, not intent. */
const TOOL_NAMES: ReadonlySet<string> = new Set(ALL_TOOL_SPECS.map((t) => t.name));
const SNAKE_TOKENS = /\b[a-z]+(?:_[a-z]+)+\b/g;
/** Whether a line names a tool (a snake_case token that is one of ours); Kevin's own identifiers pass. */
function namesATool(text: string): boolean {
  for (const token of text.match(SNAKE_TOKENS) ?? []) if (TOOL_NAMES.has(token)) return true;
  return false;
}
/** What the voice hears when a first-tool line would otherwise carry the tool's own name. */
const GENERIC_WORKING_LINE = "working on it.";
/**
 * Tools that only look, remember or already speak: not worth a spoken line when
 * they are the brain's first move. The worker tools are here too: the split is
 * voiced once by the pool's own line (`splitLine`), never as "Checking worker start".
 */
const SILENT_TOOLS: ReadonlySet<string> = new Set([
  "screenshot", "zoom", "cursor_position", "frontmost_app", "list_windows", "element_at", "find_element", "read_focused_text", "wait",
  "browser_tabs", "browser_find", "agents_list", "self_status", "recall", "remember", "speak_progress", "show_clear",
  "worker_start", "worker_wait", "worker_read", "worker_stop",
]);
/** A prefired reflex is adopted by the delegation for its utterance within this long; then its record is finished as never delegated. */
const PREFIRE_TTL_MS = 8000;
const MAX_ROUND_TRIP_SAMPLES = 40;
/** The transcriber closed the sentence: the strongest end-of-utterance signal there is. */
const CLOSED_SENTENCE = /[.!?…]["')\]]?\s*$/;

/**
 * A reflex that ran ahead of Live's delegation. `id` is its delegation record
 * (already created on the ledger); `itemId` the transcript utterance it answers —
 * only a delegation whose request ends with that very item adopts it. `outcome`
 * settles when the tool has run (a delegation that arrives earlier waits for it
 * instead of running the reflex again).
 */
interface Prefired {
  readonly id: string;
  readonly itemId: string;
  readonly text: string;
  readonly reflex: Reflex;
  readonly at: number;
  readonly outcome: Promise<ReflexOutcome | undefined>;
  settled: ReflexOutcome | undefined;
  forgetTimer: NodeJS.Timeout | undefined;
}

/**
 * A delegation holding a slot — running, or draining. `abort` is the brain turn's signal (a
 * supersede or a cut ends the turn); `cut` is the whole delegation's, aborted only
 * by a cut verb — the drain waits on it, so Kevin's next request never ends the
 * wait for the workers it left behind. `result` is set once the brain's turn is
 * over and the delegation is draining.
 */
interface Slot {
  delegation: Delegation;
  readonly abort: AbortController;
  readonly cut: AbortController;
  readonly marks: Marks;
  /** Live's id for appends on this task; null for a Responses task (general context only). */
  readonly liveId: string | null;
  looking?: boolean;
  result?: BrainResult;
}

export class Delegator extends EventEmitter<DelegatorEvents> {
  private readonly delegations: Delegation[] = [];
  /** The delegation whose brain turn is in flight: one at a time, as ever. */
  private running: Slot | undefined;
  /** Delegations whose brain is done but whose workers are not: each drains, then finishes; insertion order = age. */
  private readonly parked = new Map<string, Slot>();
  /** A failed reflex batch's account of itself, handed to the brain task that follows (by delegation id). */
  private readonly reflexNotes = new Map<string, readonly string[]>();
  private lastDelegationEndMs = 0;
  private readonly now: () => number;
  private unbind: (() => void)[] = [];
  /** Commentary held back so a burst becomes one append; per delegation id. */
  private readonly commentaryQueue = new Map<string, { liveId: string | null; texts: string[]; timer: NodeJS.Timeout | undefined }>();
  private lastCommentaryAt = 0;
  private prefireTimer: NodeJS.Timeout | undefined;
  /** Wall clock (real, since the timers are real) of the last input-transcript fragment. */
  private lastInputAt = 0;
  /** When the pre-sleep clause was sent; cleared by Kevin's next words or the next task — one announcement per idle stretch. */
  private sleepAnnouncedAt: number | undefined;
  private prefired: Prefired | undefined;
  /** Utterances already considered for a prefire (id:text), so a settled utterance is tried once. */
  private prefireSeen = "";
  private readonly workerSayChannel: "commentary" | "instructions";

  constructor(private readonly opts: DelegatorOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.workerSayChannel = opts.workerSayChannel ?? (process.env["JARHEAD_WORKER_SAY"] === "instructions" ? "instructions" : "commentary");
    const { live } = opts;
    const onDelegation = (id: string, target: "client" | "responses", offsetMs: number): void => void this.onDelegation(id, target, offsetMs);
    const onInput = (delta: string): void => this.onInputDelta(delta);
    live.on("delegation", onDelegation);
    live.on("inputTranscript", onInput);
    this.unbind.push(() => live.off("delegation", onDelegation), () => live.off("inputTranscript", onInput));
  }

  all(): readonly Delegation[] {
    return this.delegations;
  }

  /** The delegation Jarhead is busy with: the one whose brain runs, else the newest whose workers are still at work. */
  get active(): Delegation | undefined {
    return this.running?.delegation ?? this.newestParked()?.delegation;
  }

  /**
   * The newest delegation whose brain is done and whose workers are draining, if any
   * (the engine's ear compares it with `active`: equal means only workers are at work).
   */
  get draining(): Delegation | undefined {
    return this.newestParked()?.delegation;
  }

  private newestParked(): Slot | undefined {
    let last: Slot | undefined;
    for (const s of this.parked.values()) last = s;
    return last;
  }

  dispose(): void {
    for (const u of this.unbind.splice(0)) u();
    if (this.prefireTimer) clearTimeout(this.prefireTimer);
    this.prefireTimer = undefined;
    if (this.prefired?.forgetTimer) clearTimeout(this.prefired.forgetTimer);
    for (const q of this.commentaryQueue.values()) if (q.timer) clearTimeout(q.timer);
    this.commentaryQueue.clear();
  }

  /**
   * "stop" while anything runs — the brain's turn, or only a worker or two — ends
   * it. Checked on fragments so it lands fast; the engine's stop runs after the
   * other listeners on this fragment have had it (its output gate would otherwise
   * be lifted by the very words that asked for it). A settled utterance may be a
   * reflex: not while the brain runs, but a draining delegation's hands are the
   * pool's and Kevin's own "scroll down" still lands.
   */
  private onInputDelta(delta: string): void {
    this.lastInputAt = Date.now();
    this.sleepAnnouncedAt = undefined; // Kevin is speaking: the idle stretch is over
    const busy = this.running !== undefined || this.parked.size > 0 || (this.opts.workers?.running() ?? 0) > 0;
    if (busy) {
      const recent = (this.opts.transcript.last("kevin")?.text ?? "") + delta;
      const tail = recent.slice(-40);
      if (STOP_PATTERN.test(tail.trimStart()) || /\b(stop|cancel)\b\s*$/i.test(tail)) {
        log.info("Kevin said stop; cancelling");
        const onStop = this.opts.onStop;
        if (onStop) queueMicrotask(() => onStop("Kevin said stop"));
        else void this.cancel("Kevin said stop");
        return;
      }
    }
    if (this.running) return;
    if (!this.opts.reflexes) return;
    // The engine pushes this fragment into the transcript after us; judge the whole
    // utterance once it has been quiet for a moment, not the fragment.
    this.armPrefire(this.opts.prefireQuietMs ?? 180);
  }

  private armPrefire(inMs: number): void {
    if (this.prefireTimer) clearTimeout(this.prefireTimer);
    this.prefireTimer = setTimeout(() => {
      this.prefireTimer = undefined;
      void this.considerPrefire();
    }, inMs);
  }

  /**
   * A settled utterance that is a whole cheap reflex, said to Jarhead, runs now as
   * a delegation record of its own; the delegation that follows adopts the result
   * and only has to speak. The utterance must have clearly ended: a sentence the
   * transcriber closed with a full stop counts after the short quiet window, an
   * open one only after the long window ("scroll down" — pause — "to the footer"
   * must not scroll). Without the wake word only a closed sentence mid-exchange
   * qualifies. Nothing else fires ahead of Live's word.
   */
  private async considerPrefire(): Promise<void> {
    const reflexes = this.opts.reflexes;
    const last = this.opts.transcript.last("kevin");
    if (!reflexes || !last || this.running) return;
    const key = `${last.id}:${last.text}`;
    if (key === this.prefireSeen) return;
    const closed = CLOSED_SENTENCE.test(last.text);
    const need = closed ? (this.opts.prefireQuietMs ?? 180) : (this.opts.prefireLongQuietMs ?? 450);
    const quiet = Date.now() - this.lastInputAt;
    if (quiet < need) {
      this.armPrefire(need - quiet);
      return;
    }
    this.prefireSeen = key;
    const reflex = reflexes.match(last.text);
    if (!reflex?.prefire) return;
    // The ear beat Live to it: the delegation that follows will find it done; nothing to
    // run here. A peek, never a claim — a claim here would hide the reflex from that
    // delegation, which would then run it a second time.
    if (reflexes.peek?.(last.text)?.kind === "done") {
      log.debug(`prefire "${reflex.label}" skipped: the ear already did it`);
      return;
    }
    const addressed = addressesJarhead(last.text);
    if (!addressed && !(closed && reflexes.inExchange?.())) return;

    // The record first: the scroll about to happen is on the ledger whatever Live decides.
    const at = this.now();
    const id = newId("dlg");
    const timings: DelegationTimingsExtra = { delegatedAt: at, reflex: true };
    const delegation: Delegation = { id, liveId: `prefire:${last.id}`, createdAt: at, offsetMs: last.endMs, request: last.text, status: "running", steps: [], timings: timings as DelegationTimings };
    this.pushDelegation(delegation);
    this.opts.ledger?.append({ at, type: "delegation.created", delegation });
    this.emit("change", delegation);
    this.addStep(id, { kind: "note", text: `reflex: ${reflex.label} — running ahead of the delegation` });
    // A prefire still parked for an earlier utterance is not this one's; it is finished as never delegated.
    if (this.prefired) this.finishPrefire(this.prefired, "superseded by the next utterance");

    const prefired: Prefired = {
      id,
      itemId: last.id,
      text: last.text,
      reflex,
      at,
      settled: undefined,
      forgetTimer: undefined,
      outcome: reflexes
        .run(reflex, this.makePrefireSink(id))
        .then((outcome) => {
          prefired.settled = outcome;
          if (outcome.ok) {
            log.info(`reflex "${reflex.label}" fired ${this.now() - at}ms after the utterance settled, ahead of the delegation`);
            this.emit("reflex", reflex.label, outcome.ms, true);
          }
          return outcome;
        })
        .catch((e: unknown) => {
          log.warn(`prefire "${reflex.label}" threw: ${(e as Error).message}`);
          this.addStep(id, { kind: "error", text: (e as Error).message.slice(0, 300) });
          return undefined;
        }),
    };
    this.prefired = prefired;
    // Live may decide Kevin was not talking to it; then nobody adopts this and the record is closed as such.
    prefired.forgetTimer = setTimeout(() => this.finishPrefire(prefired, "Live never delegated this utterance; forgotten"), this.opts.prefireTtlMs ?? PREFIRE_TTL_MS);
    prefired.forgetTimer.unref?.();
  }

  /** The prefire's steps land in its own record; a reflex has no thinking or commentary of its own. */
  private makePrefireSink(id: string): BrainSink {
    const open = (): boolean => this.current(id)?.status === "running";
    return {
      thinking: () => undefined,
      commentary: () => undefined,
      step: (step) => {
        if (open()) this.addStep(id, step);
      },
      screenshot: (path, note) => {
        if (open()) this.addStep(id, { kind: "screenshot", screenshotPath: path, ...(note ? { text: note } : {}) });
      },
    };
  }

  /**
   * The prefire whose utterance is the last item of this delegation's request, if
   * any — the delegation adopts its record. A prefire for an earlier item of the
   * request (Kevin said more before Live delegated) is closed instead: the
   * delegation is about more than the reflex, and the brain gets all of it.
   */
  private claimPrefired(items: readonly TranscriptItem[]): Prefired | undefined {
    const p = this.prefired;
    if (!p) return undefined;
    const last = items[items.length - 1];
    if (!last || last.id !== p.itemId) {
      if (items.some((i) => i.id === p.itemId)) this.finishPrefire(p, "a longer request followed; the brain took it whole");
      return undefined;
    }
    this.prefired = undefined;
    if (p.forgetTimer) clearTimeout(p.forgetTimer);
    p.forgetTimer = undefined;
    return p;
  }

  /** Close a prefire's record that no delegation adopted, once its tool has settled. */
  private finishPrefire(p: Prefired, why: string): void {
    if (this.prefired === p) this.prefired = undefined;
    if (p.forgetTimer) clearTimeout(p.forgetTimer);
    p.forgetTimer = undefined;
    void p.outcome.then((outcome) => {
      const d = this.current(p.id);
      if (!d || d.status !== "running") return;
      this.addStep(p.id, { kind: "note", text: why });
      const ok = outcome?.ok === true;
      const status = ok ? (outcome.result.kind === "needs-confirmation" ? "awaiting-confirmation" : "done") : "failed";
      const summary = ok ? `${p.reflex.said} (${why})` : `reflex ${p.reflex.label} did not apply (${why})`;
      // Nobody delegated these words yet: the request window stays where it was.
      this.closeRecord(p.id, status, summary, false);
      log.info(`prefired reflex "${p.reflex.label}" ${status}: ${why}`);
    });
  }

  /**
   * The engine's idle timer is about to put the session to sleep: the voice says
   * so in one clause before the session closes, instead of going quiet without a
   * word. Nothing here waits. Once per idle stretch: true when the line was sent,
   * false while a task runs or drains (a running task is the reason it is not
   * idle) or when the stretch already has its announcement — Kevin's next words or
   * the next task start a new stretch. The engine's `tick()` arms one sleep
   * deadline off a true return and sleeps at it unless `sleepAnnounced` has
   * cleared by then; it must not re-read its idle clock for that decision, because
   * the voice saying "going to sleep" is Jarhead's own speech and moves
   * `lastAddressedAt` — judged again, the session would announce every idle period
   * and never sleep.
   */
  announceSleep(inSeconds = 5): boolean {
    if (this.active || this.sleepAnnouncedAt !== undefined) return false;
    this.sleepAnnouncedAt = this.now();
    const s = Math.max(1, Math.round(inSeconds));
    this.opts.live.appendInstructions(null, `Nothing has been said for a while: you are going to sleep in about ${s} seconds. Say so in one short clause ("going to sleep") and then stay quiet.`);
    return true;
  }

  /** Whether the pre-sleep clause stands: sent, and nothing from Kevin and no task since. */
  get sleepAnnounced(): boolean {
    return this.sleepAnnouncedAt !== undefined;
  }

  /** Something other than Kevin's words woke the stretch (Go, a tap on the orb, a wake): the next idle stretch announces again. */
  clearSleepAnnouncement(): void {
    this.sleepAnnouncedAt = undefined;
  }

  /**
   * End what is running — the brain's turn and a draining delegation alike (a cut
   * verb: interrupt, Stop, Pause, sleep; the engine cancels the workers themselves).
   * `quiet` skips the delegator's own word to the voice — the engine's
   * stopEverything sends the one instruction for the whole stop and asks for that,
   * so the voice is not told both to acknowledge and to be silent.
   */
  async cancel(reason: string, opts: { readonly quiet?: boolean } = {}): Promise<void> {
    const run = this.running;
    const parked = [...this.parked.values()];
    if (!run && parked.length === 0) return;
    // Oldest first, so the ledger's finished rows read in the order the work began.
    for (const slot of parked) {
      slot.cut.abort();
      slot.abort.abort();
      this.dropCommentary(slot.delegation.id);
      this.parked.delete(slot.delegation.id);
      this.closeSlot(slot, { status: "cancelled", summary: reason });
    }
    if (run) {
      // Finish first, then wait for the brain: a brain that settles its turn on the
      // abort signal must not finish the delegation itself and lose the reason.
      run.abort.abort();
      run.cut.abort();
      this.dropCommentary(run.delegation.id);
      this.running = undefined;
      this.closeSlot(run, { status: "cancelled", summary: reason });
    }
    this.emit("cancelled", reason);
    if (!opts.quiet) this.opts.live.appendInstructions(null, "Kevin cancelled the task. Acknowledge with one word and wait.");
    if (run) await this.opts.brain.cancel();
  }

  private async onDelegation(liveId: string, target: "client" | "responses", offsetMs: number): Promise<void> {
    const { transcript, live, confirmations, brain } = this.opts;
    this.sleepAnnouncedAt = undefined; // a task is starting: not idle
    // Live has spoken: a prefire still being considered for this utterance would only duplicate the work below.
    if (this.prefireTimer) clearTimeout(this.prefireTimer);
    this.prefireTimer = undefined;

    // Kevin's words first: a dismissal and a yes for a worker are answered before
    // anything running is touched, so neither ends a turn or a worker by accident.
    // The window: since the last finish — or, while a delegation runs, since now (its
    // words are not this request's; the transcript's last utterance is, as when the
    // supersede used to move the window first).
    const windowStart = this.running ? Math.max(this.lastDelegationEndMs, live.nowMs || this.running.delegation.offsetMs) : this.lastDelegationEndMs;
    const kevinSince = transcript.since(windowStart, "kevin");
    const requestItems = kevinSince.length > 0 ? kevinSince : [transcript.last("kevin")].filter((x): x is NonNullable<typeof x> => x !== undefined);
    const request = requestItems.map((i) => i.text).join(" ").trim() || "(no transcript yet — ask what Kevin wants)";
    const lastText = requestItems[requestItems.length - 1]?.text ?? request;
    // Live rejects non-null delegation ids on appends while a Responses backend
    // owns the task; general session context is the only channel then.
    const appendId = target === "responses" ? null : liveId;
    const speechEndAt = this.speechEndAt(requestItems, offsetMs);

    // (a) A dismissal: the engine's one sleep function gets his words; nothing else
    // starts for them. Judged on the whole request (§3.2). Its last utterance alone
    // counts only when it names Jarhead — "what a day" … "jarhead, go to sleep" is a
    // cue with room talk before it. A closer said as a second breath after a real
    // request ("send Ben a message that I'm late" … "that's all") is NOT: the task
    // would be dropped and the paid session closed for a pleasantry; the brain takes
    // the request whole and "that's all" is harmless there.
    const cue = this.opts.onSleep ? this.sleepCue(request, requestItems, lastText) : undefined;
    if (cue && this.opts.onSleep) {
      const phrase = String(cue.input["phrase"] ?? lastText);
      const aside = this.recordAside(liveId, offsetMs, request, speechEndAt, requestItems);
      this.markReflex(aside.id);
      const addressed = addressesJarhead(request);
      const inExchange = this.opts.workers?.inExchange?.() ?? this.opts.reflexes?.inExchange?.();
      // The one false positive worse than a miss is a "goodnight" meant for someone in the
      // room. Live's attention gate is the test on this path; when it fired on words that
      // neither name Jarhead nor land mid-exchange, the log says so, for the day it is wrong.
      if (!addressed && inExchange === false) log.info(`sleep cue "${phrase}" on Live's word alone (not addressed, not mid-exchange)`);
      this.addStep(aside.id, { kind: "note", text: `sleep cue: "${phrase}" — the engine puts Jarhead to sleep` });
      this.closeRecord(aside.id, "done", "going to sleep");
      log.info(`delegation ${aside.id}: sleep cue "${phrase}"`);
      this.opts.onSleep(phrase);
      return;
    }

    // Kevin's yes to a repeatable question ("act in 1Password?") stays good for the conversation
    // (never a destructive verb — those carry no grant). The grant exists only with its ledger
    // row: `arm(record)` writes the row as the grant is born; with no ledger the yes is one-off.
    const ledger = this.opts.ledger;
    const record = ledger ? (g: { app: string; actionClass: string; until: number }): void => ledger.append({ at: this.now(), type: "grant", chainId: confirmations.conversationId, app: g.app, actionClass: g.actionClass, until: g.until }) : undefined;
    const isYes = YES_PATTERN.test(transcript.last("kevin")?.text ?? "");

    // (b) A yes while a worker's question holds the floor: the yes is armed on the root
    // and that worker re-runs its tool on its own thread. The brain's running turn is
    // not superseded — the yes was never for it.
    const floor = isYes ? this.workerFloor() : undefined;
    if (floor && this.opts.workers && confirmations.arm(record) !== undefined) {
      const aside = this.recordAside(liveId, offsetMs, request, speechEndAt, requestItems);
      this.addStep(aside.id, { kind: "note", text: `yes for ${floor.name}'s question; the running task carries on`, worker: floor.name });
      try {
        await this.opts.workers.resume(floor.id);
        this.closeRecord(aside.id, "done", `relayed the yes to ${floor.name}`);
      } catch (e) {
        this.closeRecord(aside.id, "failed", `could not relay the yes to ${floor.name}: ${(e as Error).message.slice(0, 200)}`);
      }
      return;
    }

    // (c) A new delegation while one runs: the voice decided Kevin wants something else.
    // The brain's turn ends. Workers it started carry on: their delegation is parked
    // to drain rather than cancelled (only a cut verb ends workers).
    if (this.running) {
      const old = this.running;
      old.abort.abort();
      if ((this.opts.workers?.running(old.delegation.id) ?? 0) > 0) {
        this.park(old, "Kevin asked something else; the workers carry on", { status: "cancelled", summary: "Kevin asked something else; the workers carried on" });
      } else {
        this.dropCommentary(old.delegation.id);
        this.finish(old.delegation.id, { status: "cancelled", summary: "superseded by a new request" });
      }
      await brain.cancel();
    }

    const armed = isYes ? confirmations.arm(record) : undefined;
    const confirmation = armed !== undefined;
    if (!confirmation && confirmations.pending && !YES_PATTERN.test(request)) {
      // A different request while a confirmation was pending drops it: a later
      // "yes" must not fire an action Kevin has moved on from. The question only —
      // moving on from a question is not a cut, so the standing grants stay.
      confirmations.dropQuestion();
    }

    const marks = new Marks(this.now);
    const abort = new AbortController();
    // A reflex that already ran for this very utterance: its record becomes this delegation's.
    const prefired = this.claimPrefired(requestItems);
    let delegation: Delegation;
    if (prefired && this.current(prefired.id)?.status === "running") {
      delegation = this.update(prefired.id, (d) => ({ ...d, liveId, offsetMs, request, timings: { ...d.timings, ...(speechEndAt !== undefined ? { speechEndAt } : {}) } }))!;
    } else {
      const id = newId("dlg");
      const timings: DelegationTimings = { delegatedAt: marks.startedAt, ...(speechEndAt !== undefined ? { speechEndAt } : {}) };
      delegation = { id, liveId, createdAt: marks.startedAt, offsetMs, request, status: "running", steps: [], timings };
      this.pushDelegation(delegation);
      this.opts.ledger?.append({ at: marks.startedAt, type: "delegation.created", delegation });
      this.emit("change", delegation);
    }
    const id = delegation.id;
    this.running = { delegation, abort, cut: new AbortController(), marks, liveId: appendId };
    this.emit("phase", "thinking");

    // `sink` is the brain's channel (its commentary passes the narration gate);
    // `say` is Jarhead's own word — a reflex's landing, the summary, a failure — and
    // is never gated: it is the answer.
    const { sink, say } = this.makeSink(id);

    // Paused: the record exists, nothing runs, the voice was told once when the pause began.
    const refused = this.opts.refuse?.();
    if (refused) {
      this.addStep(id, { kind: "note", text: `not run: ${refused}` });
      if (prefired) void prefired.outcome.then(() => undefined);
      this.finish(id, { status: "cancelled", summary: refused });
      return;
    }

    // The ear's reflex already did these words: confirm, do not redo. Judged on the
    // request's LAST utterance — the one Live delegated on; earlier items are
    // context ("what a nice day" … "jarhead scroll down"). A request whose last
    // utterance ends with the reflex but says more is the brain's, minus the tail.
    let brainTakesIt: string | undefined;
    if (!confirmation && this.opts.reflexes?.reconcile && target === "client") {
      const r = await this.opts.reflexes.reconcile(lastText);
      if (this.running?.delegation.id !== id) return; // cancelled or superseded while the undo ran
      if (r?.kind === "done") {
        const lead = this.now() - r.fired.dispatchedAt;
        this.addStep(id, { kind: "note", text: `reflex ${r.fired.reflex.label} already ran ${lead} ms ago on the ear's words (${Math.round(r.similarity * 100)} % match)` });
        this.markReflex(id);
        say(r.fired.reflex.said);
        this.finish(id, { status: "done", summary: "already did it" });
        this.emit("reflex", r.fired.reflex.label, r.fired.doneAt !== undefined ? r.fired.doneAt - r.fired.dispatchedAt : 0, true);
        return;
      }
      if (r?.kind === "partial") {
        brainTakesIt = `reflex ${r.fired.reflex.label} already ran on the last words of this request ("${r.fired.phrase}"); the brain takes the rest and must not repeat it`;
        this.addStep(id, { kind: "note", text: brainTakesIt });
      }
      if (r?.kind === "mismatch") {
        const stands = r.undone === false && !r.fired.reflex.idempotent;
        this.addStep(id, { kind: "note", text: `reflex mismatch: the ear heard "${r.fired.phrase}" and ran ${r.fired.reflex.label}; the request says "${normalizeUtterance(request)}" (${Math.round(r.similarity * 100)} % alike); ${stands ? "it could not be undone, so the brain takes it and must not repeat it on top" : "the brain takes it"}` });
        // The effect stands (a text typed where ⌘Z does not reach): running the request's own
        // reflex now would put the whole text after the ear's; the brain sees the screen first.
        if (stands) brainTakesIt = `reflex ${r.fired.reflex.label} ran on the ear's words and stands`;
      }
    }

    // A reflex needs no brain: run it (or take the one that already ran) and finish.
    if (!confirmation && this.opts.reflexes && target === "client" && !brainTakesIt) {
      const done = await this.tryReflex(id, request, sink, say, prefired);
      if (done || this.running?.delegation.id !== id) return;
    } else if (prefired) {
      // Adopted, but this is a confirmation or a Responses task: the brain takes it, the record says what already happened.
      this.addStep(id, { kind: "note", text: `reflex ${prefired.reflex.label} already ran ahead of this request` });
    }

    // A circle still being captured is waited for (it is what "this" means); the
    // eyes take their quick shot meanwhile, and so does the memory lookup — its
    // query is Kevin's words as they stand now, its bound MEMORY_RECALL_MS. A
    // delegation that supersedes this one meanwhile takes the marks instead.
    const windowMs = this.opts.dialogueWindowMs ?? 120_000;
    const recall = this.recallMemory(request, kevinLines(transcript, (live.nowMs || offsetMs) - windowMs - 1), abort.signal);
    const [{ attachments: circled, ids: markIds }, screen, memory] = await Promise.all([this.takeMarks(), this.look(id, sink), recall]);
    if (this.running?.delegation.id !== id) return;
    const attachments: BrainAttachment[] = [...(screen ? [screen] : []), ...circled];
    log.info(`delegation ${id} (${target}): "${request.slice(0, 80)}"${confirmation ? " [confirmation]" : ""}${circled.length ? ` [${circled.length} circled region(s)]` : ""}${screen ? " [screen]" : ""}${memory ? " [memory]" : ""}`);

    const uptoMs = live.nowMs || offsetMs;
    const reflexNotes = this.reflexNotes.get(id);
    this.reflexNotes.delete(id);
    const task: BrainTask = {
      delegationId: liveId,
      request,
      dialogue: transcript.render(windowMs, uptoMs),
      // Kevin's side only, for the gates: the rendered dialogue above carries Jarhead's lines too.
      kevinDialogue: kevinLines(transcript, uptoMs - windowMs - 1),
      confirmation,
      offsetMs,
      signal: abort.signal,
      ...(attachments.length ? { attachments } : {}),
      ...(reflexNotes ? { notes: reflexNotes } : {}),
      // Never inside kevinDialogue: the gates must not read a remembered line as his words today.
      ...(memory ? { memory } : {}),
    };

    let result: BrainResult;
    try {
      result = await brain.handle(task, sink);
    } catch (e) {
      result = { status: "failed", error: (e as Error).message };
    }
    const run = this.running;
    if (run?.delegation.id !== id) return; // cancelled or superseded meanwhile
    if (result.status === "failed") {
      // The brain never got to work on it ("restarting", "already handling a task", a
      // spawn failure): the circles are still Kevin's next question, not spent.
      if (markIds.length > 0) this.opts.marks?.release(markIds);
      say(`Something went wrong: ${(result.error ?? "unknown error").slice(0, 300)}`);
    } else if (result.summary && result.status === "done") {
      // Only speak the summary when the brain did not already speak it.
      const spokenAlready = this.current(id)?.steps.some((s) => s.kind === "commentary" && s.text === result.summary);
      if (!spokenAlready) say(result.summary);
    }
    // The brain is done; its hands may not be. The delegation then drains — Kevin's
    // next request starts at once, and this record closes when the workers do.
    const hands = result.status === "cancelled" ? 0 : (this.opts.workers?.running(id) ?? 0);
    if (hands > 0) {
      this.park(run, `the brain is done; ${hands} hand${hands === 1 ? "" : "s"} still working`, result);
      return;
    }
    this.finish(id, result);
  }

  /** The dismissal in this request, if it is one: the whole of it, or an addressed last utterance after context. */
  private sleepCue(request: string, requestItems: readonly TranscriptItem[], lastText: string): Reflex | undefined {
    const whole = parseReflex(request);
    if (whole?.kind === "sleep") return whole;
    if (requestItems.length > 1 && addressesJarhead(lastText)) {
      const last = parseReflex(lastText);
      if (last?.kind === "sleep") return last;
    }
    return undefined;
  }

  /**
   * When Kevin stopped talking: the last of his utterances that ended before Live's
   * delegation event (the request's last item when the transcript lagged the event),
   * placed on the wall clock through the session's start. Absent without a session clock.
   */
  private speechEndAt(requestItems: readonly TranscriptItem[], offsetMs: number): number | undefined {
    const spoke = requestItems.filter((i) => i.endMs <= offsetMs).at(-1) ?? requestItems.at(-1);
    const sessionStart = this.opts.sessionStartedAt?.() ?? 0;
    return spoke && sessionStart > 0 ? sessionStart + spoke.endMs : undefined;
  }

  /** The worker holding the confirmation floor, named when the pool names it. */
  private workerFloor(): WorkerFloor | undefined {
    const floor = this.opts.workers?.floorLane();
    if (!floor) return undefined;
    return typeof floor === "string" ? { id: floor, name: floor } : floor;
  }

  /**
   * A delegation answered here without the brain and without a slot — a sleep cue,
   * a yes relayed to a worker: created on the ledger like any other, finished by
   * `closeRecord`. A prefire parked for an earlier utterance is closed on the way.
   */
  private recordAside(liveId: string, offsetMs: number, request: string, speechEndAt: number | undefined, requestItems: readonly TranscriptItem[]): Delegation {
    this.claimPrefired(requestItems);
    const at = this.now();
    const delegation: Delegation = { id: newId("dlg"), liveId, createdAt: at, offsetMs, request, status: "running", steps: [], timings: { delegatedAt: at, ...(speechEndAt !== undefined ? { speechEndAt } : {}) } };
    this.pushDelegation(delegation);
    this.opts.ledger?.append({ at, type: "delegation.created", delegation });
    this.emit("change", delegation);
    return delegation;
  }

  /**
   * Finish a record that holds no slot (an aside, a prefire nobody adopted): status,
   * summary, the ledger row — and, when the words were Live's delegation, the request
   * window moves past them.
   */
  private closeRecord(id: string, status: Delegation["status"], summary: string, moveWindow = true): void {
    const doneAt = this.now();
    const finished = this.update(id, (d) => ({ ...d, status, summary, timings: { ...d.timings, doneAt } }));
    if (!finished) return;
    if (moveWindow) this.lastDelegationEndMs = Math.max(this.lastDelegationEndMs, this.opts.live.nowMs || finished.offsetMs);
    this.opts.ledger?.append({ at: doneAt, type: "delegation.finished", delegationId: id, status, timings: finished.timings, summary });
  }

  private pushDelegation(delegation: Delegation): void {
    this.delegations.push(delegation);
    if (this.delegations.length > 200) this.delegations.splice(0, this.delegations.length - 200);
  }

  /**
   * The reflex path. Returns true when the delegation is finished here (the
   * reflex ran, or asked for a confirmation); false hands the task to the brain,
   * with the failed attempt on the timeline. A prefire whose result this
   * delegation adopted is waited for, never run again; one whose words are not
   * the whole request is noted and the brain takes the request as a whole.
   */
  private async tryReflex(id: string, request: string, sink: BrainSink, say: (text: string) => void, prefired: Prefired | undefined): Promise<boolean> {
    const reflexes = this.opts.reflexes;
    if (!reflexes) return false;
    let reflex: Reflex | undefined;
    let outcome: ReflexOutcome;
    if (prefired) {
      const want = normalizeUtterance(prefired.text);
      const got = normalizeUtterance(request);
      const matches = want !== "" && (got === want || got.endsWith(want));
      const settled = prefired.settled ?? (await prefired.outcome);
      if (this.running?.delegation.id !== id) return true;
      const lead = this.now() - prefired.at;
      if (!matches) {
        this.addStep(id, { kind: "note", text: `reflex ${prefired.reflex.label} already ran ${lead} ms ago, but the request says more; the brain takes it whole` });
        return false;
      }
      reflex = prefired.reflex;
      this.addStep(id, { kind: "note", text: `the delegation arrived ${lead} ms after the reflex ran` });
      if (!settled) {
        this.addStep(id, { kind: "note", text: `reflex ${reflex.label} did not apply; the brain takes it` });
        return false;
      }
      outcome = settled;
    } else {
      reflex = reflexes.match(request);
      if (!reflex) return false;
      this.addStep(id, { kind: "note", text: `reflex: ${reflex.label}` });
      this.emit("phase", "acting");
      try {
        outcome = await reflexes.run(reflex, sink);
      } catch (e) {
        outcome = { reflex, result: { kind: "error", message: (e as Error).message }, ms: 0, ok: false };
      }
      if (this.running?.delegation.id !== id) return true;
      this.emit("reflex", reflex.label, outcome.ms, false);
    }
    if (!outcome.ok) {
      this.addStep(id, { kind: "note", text: `reflex ${reflex.label} did not apply (${outcome.result.kind === "error" ? outcome.result.message.slice(0, 200) : outcome.result.kind}); the brain takes it` });
      // The batch's own account (what it did, where it stopped) rides with the task so the model does not repeat the walk.
      if (outcome.did) this.reflexNotes.set(id, [`reflex "${reflex.label}": ${outcome.did.slice(0, 400)}`]);
      return false;
    }
    this.markReflex(id);
    if (outcome.result.kind === "needs-confirmation") {
      // The runner recorded the handshake; the question is the whole answer.
      say(outcome.result.question);
      this.finish(id, { status: "done", summary: outcome.result.question });
      return true;
    }
    // The verified landing (what the tool results say happened), not the grammar's line.
    const said = outcome.reflex.said || reflex.said;
    say(said);
    this.finish(id, { status: "done", summary: said });
    return true;
  }

  private markReflex(id: string): void {
    this.update(id, (d) => ({ ...d, timings: { ...d.timings, reflex: true } as DelegationTimings }));
  }

  /** The eyes' quick shot, in this delegation's timeline; never throws, never blocks a task without eyes. */
  /**
   * The durable-memory block for this task, or undefined: no memory wired, an
   * empty answer, an error, or the MEMORY_RECALL_MS bound hit (the lookup is
   * aborted through its signal so an in-flight embedding call is dropped, not
   * awaited). The rendered text is passed through as is — its budget was cut by
   * the renderer; nothing here re-renders it.
   */
  private async recallMemory(request: string, kevinRecent: string, signal: AbortSignal): Promise<string | undefined> {
    const recall = this.opts.memory;
    if (!recall) return undefined;
    const query = kevinRecent ? `${request}\n${kevinRecent}` : request;
    const cut = new AbortController();
    const onAbort = (): void => cut.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const t0 = this.now();
    try {
      const bound = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          cut.abort();
          resolve(undefined);
        }, MEMORY_RECALL_MS);
      });
      const text = await Promise.race([
        // Started inside the chain: a hook that throws synchronously is swallowed like
        // one that rejects — the task goes to the brain without a block either way.
        Promise.resolve()
          .then(() => recall(query, cut.signal))
          .catch((e: unknown) => {
            log.warn(`memory lookup failed: ${(e as Error).message}`);
            return undefined;
          }),
        bound,
      ]);
      if (text === undefined && cut.signal.aborted && !signal.aborted) log.info(`memory lookup cut at ${MEMORY_RECALL_MS} ms (${this.now() - t0} ms)`);
      return text || undefined;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async look(id: string, sink: BrainSink): Promise<BrainAttachment | undefined> {
    if (!this.opts.eyes) return undefined;
    const t0 = this.now();
    const run = this.running;
    if (run) run.looking = true;
    try {
      const shot = await this.opts.eyes(sink);
      if (shot) this.update(id, (d) => ({ ...d, timings: { ...d.timings, eyesMs: this.now() - t0 } as DelegationTimings }));
      return shot;
    } catch (e) {
      log.debug(`no pre-warm screenshot: ${(e as Error).message}`);
      return undefined;
    } finally {
      if (run) run.looking = false;
    }
  }

  /**
   * Everything Kevin circled since the last task goes in with this one. A capture
   * still in flight is waited for first. Every pending mark is consumed, with or
   * without a screenshot — a region the hands could not capture is not worth
   * showing him twice — and the brain gets the ones that have pixels, as absolute
   * paths with the standard note (which says how old the circle is once that
   * matters). The ids come back so a task the brain never took can release them.
   */
  private async takeMarks(): Promise<{ attachments: BrainAttachment[]; ids: string[] }> {
    const source = this.opts.marks;
    if (!source) return { attachments: [], ids: [] };
    if (source.settled && source.pending().some((m) => !m.consumed)) {
      try {
        await source.settled();
      } catch (e) {
        log.warn(`waiting for a mark capture: ${(e as Error).message}`);
      }
    }
    const pending = source.pending().filter((m) => !m.consumed);
    if (pending.length === 0) return { attachments: [], ids: [] };
    const attachments: BrainAttachment[] = [];
    const now = this.now();
    for (const m of pending) {
      if (!m.screenshotPath) continue;
      const what = m.element?.title || m.element?.app ? ` — ${[m.element?.role, m.element?.title ? `"${m.element.title}"` : undefined, m.element?.app ? `in ${m.element.app}` : undefined].filter(Boolean).join(" ")}` : "";
      attachments.push({ path: isAbsolute(m.screenshotPath) ? m.screenshotPath : join(source.stateDir, m.screenshotPath), mediaType: "image/png", note: `${markNote(m.rect, now - m.at)}${what}`, kind: "mark" });
    }
    const ids = pending.map((m) => m.id);
    source.consume(ids);
    return { attachments, ids };
  }

  private current(id: string): Delegation | undefined {
    return this.delegations.find((d) => d.id === id);
  }

  /** The slot — running or draining — holding this delegation, if either does. */
  private slot(id: string): Slot | undefined {
    if (this.running?.delegation.id === id) return this.running;
    return this.parked.get(id);
  }

  private update(id: string, patch: (d: Delegation) => Delegation): Delegation | undefined {
    const idx = this.delegations.findIndex((d) => d.id === id);
    if (idx < 0) return undefined;
    const next = patch(this.delegations[idx] as Delegation);
    this.delegations[idx] = next;
    if (this.running?.delegation.id === id) this.running.delegation = next;
    const parked = this.parked.get(id);
    if (parked) parked.delegation = next;
    this.emit("change", next);
    return next;
  }

  /**
   * Record a step and keep the latency marks: first tool, first action, every
   * round trip. A worker's step (`step.worker`) is on the timeline but stamps no
   * mark: the marks measure the main brain, which the bench reads them for.
   */
  private addStep(id: string, step: Omit<DelegationStep, "id" | "at">): void {
    const full: DelegationStep = { id: newId("step"), at: this.now(), ...step };
    const looking = this.running?.delegation.id === id && this.running.looking === true;
    this.update(id, (d) => {
      let timings = d.timings as DelegationTimingsExtra;
      // The eyes' pre-warm shot is the engine's, not the brain's: it does not count as the first tool.
      if (!looking && !step.worker && (step.kind === "tool" || step.kind === "screenshot" || step.kind === "confirm")) {
        const name = step.tool?.name;
        if (timings.firstToolAt === undefined) timings = { ...timings, firstToolAt: full.at };
        // The first action: an acting tool (ACTING_TOOLS) whose step is a `tool` that returned ok — not a
        // look, not an `error` step (the runner records a failed tool as one), not a `confirm` question.
        if (timings.firstActionAt === undefined && name && ACTING_TOOLS.has(name) && step.kind === "tool" && step.tool?.ok === true) timings = { ...timings, firstActionAt: full.at };
        if (step.tool && Number.isFinite(step.tool.ms)) {
          const samples = timings.toolRoundTripMs ?? [];
          if (samples.length < MAX_ROUND_TRIP_SAMPLES) timings = { ...timings, toolRoundTripMs: [...samples, Math.round(step.tool.ms)] };
        }
      }
      return { ...d, steps: [...d.steps, full], timings: timings as DelegationTimings };
    });
    this.opts.ledger?.append({ at: full.at, type: "delegation.step", delegationId: id, step: full });
  }

  // ------------------------------------------------------------------ workers

  /**
   * A worker's step lands on its parent's timeline, tagged with the worker's name,
   * while the parent runs or drains. Nothing is voiced here: workers never narrate.
   */
  workerStep(parentId: string, name: string, step: Omit<DelegationStep, "id" | "at" | "worker">): void {
    if (!this.slot(parentId)) {
      log.debug(`worker ${name}: step for ${parentId}, which is not running or draining; dropped`);
      return;
    }
    this.addStep(parentId, { ...step, worker: name });
  }

  /**
   * The one or two lines a worker gets to say — its finish line ("Spotify: playing
   * Focus."), a promoted question ("Spotify asks: …") — as Jarhead's own words on the
   * parent's delegation: never gated, coalesced with the rest, and spoken whether the
   * parent's brain is still running or the delegation is draining (the pool formats the
   * line; this only carries it). `instructions` (JARHEAD_WORKER_SAY) is the fallback
   * channel: the voice is told to say it now.
   */
  workerSay(parentId: string, name: string, text: string): void {
    const slot = this.slot(parentId);
    if (!slot) {
      log.debug(`worker ${name}: "${text.slice(0, 60)}" for ${parentId}, which is not running or draining; dropped`);
      return;
    }
    this.addStep(parentId, { kind: "commentary", text, worker: name });
    if (this.workerSayChannel === "instructions") {
      this.opts.live.appendInstructions(null, `A hand finished. Tell Kevin now in one short sentence: "${text}". Then wait.`);
      return;
    }
    this.queueCommentary(parentId, slot.liveId, text);
  }

  /**
   * "<Name> alongside." — Jarhead's one line when work splits, at the first
   * `worker_start` of a delegation and never again for it. It counts as the
   * task's voiced tool, so the first-tool line does not follow it with a second
   * sentence ("Opening Slack.").
   */
  splitLine(parentId: string, name: string): void {
    const slot = this.slot(parentId);
    if (!slot || slot.marks.has("split")) return;
    slot.marks.mark("split");
    slot.marks.mark("voicedTool");
    this.voice(slot, `${name} alongside.`, false);
  }

  /**
   * Park the running delegation by hand — the engine's word that its brain turn is
   * over while its workers are not: it leaves the running slot and drains (its
   * workers' steps and lines still land on it, Kevin's next request starts at once,
   * and it finishes when they do, or when a cut ends the wait). This ENDS the turn it
   * parks: the turn's signal is aborted and the brain's cancel awaited, and whatever
   * the brain would still report is discarded — `result` is what the record closes
   * with. `note` says why on the timeline. The request window moves now: Kevin's
   * words from here on are the next task's. The delegator parks on its own after a
   * finished turn and on a supersede; this is for a turn the engine has to end.
   */
  async parkRunning(note: string, result: BrainResult = { status: "done" }): Promise<void> {
    const run = this.running;
    if (!run) return;
    run.abort.abort();
    this.park(run, note, result);
    await this.opts.brain.cancel();
  }

  /**
   * Move a slot from running to draining. Never closes an older draining delegation:
   * its workers are still at work and its finish lines are still owed, so it keeps
   * its record until its own drain resolves (WORKER_MAX bounds how many can be).
   */
  private park(run: Slot, note: string, result: BrainResult): void {
    if (this.running !== run) return;
    const id = run.delegation.id;
    this.running = undefined;
    run.result = result;
    this.parked.set(id, run);
    this.addStep(id, { kind: "note", text: `${note}; draining` });
    this.lastDelegationEndMs = Math.max(this.lastDelegationEndMs, this.opts.live.nowMs || run.delegation.offsetMs);
    log.info(`delegation ${id} draining: ${note}${this.parked.size > 1 ? ` (${this.parked.size} draining)` : ""}`);
    const workers = this.opts.workers;
    if (!workers) {
      this.finishParked(id);
      return;
    }
    void workers
      .drain(id, run.cut.signal)
      .catch((e: unknown) => {
        if (this.parked.get(id) === run) this.addStep(id, { kind: "error", text: `waiting for the workers: ${(e as Error).message.slice(0, 200)}` });
      })
      .then(() => this.finishParked(id));
  }

  /**
   * A draining delegation's workers are done (or the wait was cut): it finishes
   * with the result its brain reported. Its last lines are flushed, never dropped
   * — a worker's finish line queued a moment ago is still owed to Kevin.
   */
  finishParked(id: string, why?: string): void {
    const slot = this.parked.get(id);
    if (!slot) return;
    this.parked.delete(id);
    if (why) this.addStep(id, { kind: "note", text: why });
    this.flushCommentary(id);
    this.closeSlot(slot, slot.result ?? { status: "done" });
  }

  // ------------------------------------------------------------------- voice

  /**
   * The line to speak for the brain's first acting tool, or undefined: only with
   * `voiceFirstTool` on, only once per delegation, only while nothing has been
   * spoken yet, and never for a look (SILENT_TOOLS) or a step that did not run.
   */
  private firstToolLine(step: Omit<DelegationStep, "id" | "at">, marks: Marks): string | undefined {
    if (!this.opts.voiceFirstTool || step.kind !== "tool" || !step.tool) return undefined;
    if (marks.has("firstCommentary") || marks.has("voicedTool") || SILENT_TOOLS.has(step.tool.name)) return undefined;
    marks.mark("voicedTool");
    // The line is the intent ("Opening Safari."), never the tool: a tool progressLine
    // has no words for is voiced generically rather than by name.
    const line = progressLine(step.tool.name, step.tool.input);
    return namesATool(line) ? GENERIC_WORKING_LINE : line;
  }

  /**
   * The narration gate on the brain's commentary (`# Narration` in the voice's
   * instructions, mirrored here so no brain has to be trusted with it): a line that
   * names a tool never reaches the voice; a per-click line ("Clicking Save.")
   * reaches it only as the task's first spoken words. Everything gated stays on
   * the timeline — the Console sees every line, Kevin hears the state changes.
   * Never gated: a line that asks him something, and every line once the task has
   * asked for a confirmation (`asking`: a `confirm` step is pending) — the question
   * quotes the command, so it names a tool, and Kevin must hear it or the handshake
   * sits pending until his next request drops it.
   */
  static narrationVerdict(text: string, spokenBefore: boolean, asking = false): "speak" | "timeline" {
    if (asking || ASKS_KEVIN.test(text)) return "speak";
    if (namesATool(text)) return "timeline";
    if (spokenBefore && PER_CLICK_LINE.test(text)) return "timeline";
    return "speak";
  }

  /**
   * Say a line on a delegation and record it. `firstCommentaryAt` measures the
   * brain's own first words, so only a line from the brain stamps it — never
   * Jarhead's synthetic first-tool line (voiceFirstTool) or the split line. `gated`:
   * the brain's own lines pass the narration verdict; Jarhead's (a reflex's landing,
   * the summary, a failure, the first-tool line) do not — they are the answer. Works
   * for a running and a draining delegation alike.
   */
  private voice(slot: Slot, text: string, fromBrain: boolean, gated = false): void {
    const id = slot.delegation.id;
    const spokenBefore = slot.marks.has("firstCommentary") || slot.marks.has("voicedTool");
    // The main brain's own pending question lifts the gate; a worker's question is spoken by the pool with its name.
    const asking = this.current(id)?.steps.some((s) => s.kind === "confirm" && !s.worker) ?? false;
    if (fromBrain && !slot.marks.has("firstCommentary")) {
      slot.marks.mark("firstCommentary");
      this.update(id, (d) => ({ ...d, timings: { ...d.timings, firstCommentaryAt: this.now() } }));
    }
    this.addStep(id, { kind: "commentary", text });
    if (gated && Delegator.narrationVerdict(text, spokenBefore, asking) === "timeline") {
      log.debug(`narration kept to the timeline: "${text.slice(0, 60)}"`);
      return;
    }
    this.queueCommentary(id, slot.liveId, text);
  }

  private makeSink(id: string): { sink: BrainSink; say: (text: string) => void } {
    const { live } = this.opts;
    const lastThinkingAt = { value: 0 };
    // `say`'s guard is running-or-draining: a summary spoken as the brain hands over to
    // its workers, and anything Jarhead has to say for a draining delegation, still lands.
    const say = (text: string, fromBrain: boolean, gated = false): void => {
      const slot = this.slot(id);
      if (slot) this.voice(slot, text, fromBrain, gated);
    };
    const commentary = (text: string): void => say(text, true, true);
    const sink: BrainSink = {
      thinking: (text) => {
        const slot = this.slot(id);
        if (!slot) return;
        if (!slot.marks.has("firstThinking")) {
          slot.marks.mark("firstThinking");
          this.update(id, (d) => ({ ...d, timings: { ...d.timings, firstThinkingAt: this.now() } }));
        }
        this.addStep(id, { kind: "thinking", text });
        // The voice does not need every click narrated; one silent nudge per
        // ~2.5 s keeps it able to say "still on it" without flooding the timeline.
        const t = this.now();
        if (t - lastThinkingAt.value < 2500) return;
        lastThinkingAt.value = t;
        for (const chunk of chunkForAppend(text)) live.appendThinking(slot.liveId, chunk);
      },
      commentary,
      step: (step) => {
        const slot = this.slot(id);
        if (!slot) return;
        if (step.kind === "tool" || step.kind === "screenshot") this.emit("phase", "acting");
        if (step.kind === "commentary" && !slot.marks.has("firstCommentary")) {
          slot.marks.mark("firstCommentary");
          this.update(id, (d) => ({ ...d, timings: { ...d.timings, firstCommentaryAt: this.now() } }));
        }
        if (step.kind === "confirm") this.update(id, (d) => ({ ...d, status: "awaiting-confirmation" }));
        this.addStep(id, step);
        // Kevin hears the first thing the brain did, right as its step lands (the tool itself already ran).
        // Jarhead's line, not the brain's: it does not count as the brain's first commentary.
        const line = this.firstToolLine(step, slot.marks);
        if (line) say(line, false);
      },
      screenshot: (path, note) => {
        if (!this.slot(id)) return;
        this.addStep(id, { kind: "screenshot", screenshotPath: path, ...(note ? { text: note } : {}) });
      },
    };
    return { sink, say: (text) => say(text, true) };
  }

  /**
   * Commentary reaches Live promptly but not as a burst: the first line of a
   * quiet moment goes at once; lines that follow within the window are joined
   * into one append when it closes (or when the delegation finishes).
   */
  private queueCommentary(id: string, liveId: string | null, text: string): void {
    const windowMs = this.opts.commentaryCoalesceMs ?? 600;
    const now = this.now();
    const queue = this.commentaryQueue.get(id);
    if (windowMs <= 0 || (!queue?.texts.length && now - this.lastCommentaryAt >= windowMs)) {
      this.lastCommentaryAt = now;
      for (const chunk of chunkForAppend(text)) this.opts.live.appendCommentary(liveId, chunk);
      return;
    }
    const q = queue ?? { liveId, texts: [], timer: undefined };
    q.texts.push(text);
    this.commentaryQueue.set(id, q);
    if (!q.timer) {
      const wait = Math.max(20, windowMs - (now - this.lastCommentaryAt));
      q.timer = setTimeout(() => this.flushCommentary(id), wait);
    }
  }

  private flushCommentary(id: string): void {
    const q = this.commentaryQueue.get(id);
    if (!q) return;
    this.commentaryQueue.delete(id);
    if (q.timer) clearTimeout(q.timer);
    const text = q.texts.join(" ").trim();
    if (!text) return;
    this.lastCommentaryAt = this.now();
    for (const chunk of chunkForAppend(text)) this.opts.live.appendCommentary(q.liveId, chunk);
  }

  /** A cancelled task says nothing more. */
  private dropCommentary(id: string): void {
    const q = this.commentaryQueue.get(id);
    if (!q) return;
    if (q.timer) clearTimeout(q.timer);
    this.commentaryQueue.delete(id);
  }

  /** Finish the running delegation (a draining one goes through `finishParked` or `cancel`). */
  private finish(id: string, result: BrainResult): void {
    const run = this.running;
    if (run?.delegation.id !== id) return;
    this.running = undefined;
    if (result.status === "cancelled") this.dropCommentary(id);
    else this.flushCommentary(id);
    this.closeSlot(run, result);
  }

  /**
   * Close a delegation that held a slot: status (a pending question of the main
   * brain's keeps it awaiting-confirmation; a worker's question is the worker's),
   * summary, doneAt, the ledger row, the request window — and idle once nothing
   * runs and nothing drains.
   */
  private closeSlot(slot: Slot, result: BrainResult): void {
    const id = slot.delegation.id;
    const doneAt = this.now();
    const awaiting = slot.delegation.steps.some((s) => s.kind === "confirm" && !s.worker);
    const status = result.status === "done" && awaiting ? "awaiting-confirmation" : result.status;
    const finished = this.update(id, (d) => ({
      ...d,
      status,
      ...(result.summary ? { summary: result.summary } : {}),
      timings: { ...d.timings, doneAt },
    }));
    this.lastDelegationEndMs = Math.max(this.lastDelegationEndMs, this.opts.live.nowMs || slot.delegation.offsetMs);
    if (finished) {
      this.opts.ledger?.append({ at: doneAt, type: "delegation.finished", delegationId: id, status: finished.status, timings: finished.timings, ...(finished.summary ? { summary: finished.summary } : {}) });
      const t = finished.timings as DelegationTimingsExtra;
      // Every mark is ms relative to the delegation; speech@ is negative (Kevin stopped talking before Live delegated).
      const rel = (v: number | undefined): string => (v === undefined ? "-" : String(v - t.delegatedAt));
      log.info(`delegation ${id} ${finished.status} in ${doneAt - slot.marks.startedAt}ms (speech@${rel(t.speechEndAt)} thinking@${rel(t.firstThinkingAt)} tool@${rel(t.firstToolAt)} action@${rel(t.firstActionAt)} commentary@${rel(t.firstCommentaryAt)}${t.reflex ? " reflex" : ""}${t.toolRoundTripMs?.length ? ` tools ${t.toolRoundTripMs.join("/")}ms` : ""})`);
    }
    if (!this.running && this.parked.size === 0) this.emit("phase", "idle");
  }
}
