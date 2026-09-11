import { EventEmitter } from "node:events";
import { isAbsolute, join } from "node:path";
import { logger, newId, Marks, type Ledger } from "@jarhead/core";
import { chunkForAppend, type LiveSession, type Transcript } from "@jarhead/live";
import { ACTING_MEMBERS, YES_PATTERN, type ConfirmationState } from "@jarhead/hands";
import type { Delegation, DelegationStep, DelegationTimings, ScreenMark, TranscriptItem } from "@jarhead/protocol";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { markNote } from "./attachments.ts";
import { addressesJarhead, normalizeUtterance, type Reconciliation, type Reflex, type ReflexOutcome } from "./reflex.ts";

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
 */

const log = logger("delegator");

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
  readonly firstActionAt?: number;
  readonly toolRoundTripMs?: readonly number[];
  readonly reflex?: boolean;
  /** How long the eyes' pre-warm shot took, when one was taken. */
  readonly eyesMs?: number;
}

const STOP_PATTERN = /^\s*(stop|cancel|never ?mind|forget it|abort|that'?s enough|hold on)\b/i;
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

export class Delegator extends EventEmitter<DelegatorEvents> {
  private readonly delegations: Delegation[] = [];
  private running: { delegation: Delegation; abort: AbortController; marks: Marks; looking?: boolean } | undefined;
  private lastDelegationEndMs = 0;
  private readonly now: () => number;
  private unbind: (() => void)[] = [];
  /** Commentary held back so a burst becomes one append; per delegation id. */
  private readonly commentaryQueue = new Map<string, { liveId: string | null; texts: string[]; timer: NodeJS.Timeout | undefined }>();
  private lastCommentaryAt = 0;
  private prefireTimer: NodeJS.Timeout | undefined;
  /** Wall clock (real, since the timers are real) of the last input-transcript fragment. */
  private lastInputAt = 0;
  private prefired: Prefired | undefined;
  /** Utterances already considered for a prefire (id:text), so a settled utterance is tried once. */
  private prefireSeen = "";

  constructor(private readonly opts: DelegatorOptions) {
    super();
    this.now = opts.now ?? Date.now;
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

  get active(): Delegation | undefined {
    return this.running?.delegation;
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
   * "stop" while a task runs ends it. Checked on fragments so it lands fast; the
   * engine's stop runs after the other listeners on this fragment have had it (its
   * output gate would otherwise be lifted by the very words that asked for it). A
   * settled utterance may be a reflex.
   */
  private onInputDelta(delta: string): void {
    this.lastInputAt = Date.now();
    if (this.running) {
      const recent = (this.opts.transcript.last("kevin")?.text ?? "") + delta;
      const tail = recent.slice(-40);
      if (STOP_PATTERN.test(tail.trimStart()) || /\b(stop|cancel)\b\s*$/i.test(tail)) {
        log.info("Kevin said stop; cancelling");
        const onStop = this.opts.onStop;
        if (onStop) queueMicrotask(() => onStop("Kevin said stop"));
        else void this.cancel("Kevin said stop");
      }
      return;
    }
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
      const doneAt = this.now();
      const ok = outcome?.ok === true;
      const status = ok ? (outcome.result.kind === "needs-confirmation" ? "awaiting-confirmation" : "done") : "failed";
      const summary = ok ? `${p.reflex.said} (${why})` : `reflex ${p.reflex.label} did not apply (${why})`;
      const finished = this.update(p.id, (x) => ({ ...x, status, summary, timings: { ...x.timings, doneAt } }));
      if (finished) this.opts.ledger?.append({ at: doneAt, type: "delegation.finished", delegationId: p.id, status, timings: finished.timings, summary });
      log.info(`prefired reflex "${p.reflex.label}" ${status}: ${why}`);
    });
  }

  /**
   * End the running task. `quiet` skips the delegator's own word to the voice —
   * the engine's stopEverything sends the one instruction for the whole stop and
   * asks for that, so the voice is not told both to acknowledge and to be silent.
   */
  async cancel(reason: string, opts: { readonly quiet?: boolean } = {}): Promise<void> {
    const run = this.running;
    if (!run) return;
    // Finish first, then wait for the brain: a brain that settles its turn on the
    // abort signal must not finish the delegation itself and lose the reason.
    run.abort.abort();
    this.dropCommentary(run.delegation.id);
    this.finish(run.delegation.id, { status: "cancelled", summary: reason });
    this.emit("cancelled", reason);
    if (!opts.quiet) this.opts.live.appendInstructions(null, "Kevin cancelled the task. Acknowledge with one word and wait.");
    await this.opts.brain.cancel();
  }

  private async onDelegation(liveId: string, target: "client" | "responses", offsetMs: number): Promise<void> {
    const { transcript, live, confirmations, brain } = this.opts;
    // Live has spoken: a prefire still being considered for this utterance would only duplicate the work below.
    if (this.prefireTimer) clearTimeout(this.prefireTimer);
    this.prefireTimer = undefined;
    // A new delegation while one runs: the voice decided Kevin wants something
    // else. Finish the old one as superseded rather than running two at once.
    if (this.running) {
      this.running.abort.abort();
      this.dropCommentary(this.running.delegation.id);
      this.finish(this.running.delegation.id, { status: "cancelled", summary: "superseded by a new request" });
      await brain.cancel();
    }

    const kevinSince = transcript.since(this.lastDelegationEndMs, "kevin");
    const requestItems = kevinSince.length > 0 ? kevinSince : [transcript.last("kevin")].filter((x): x is NonNullable<typeof x> => x !== undefined);
    const request = requestItems.map((i) => i.text).join(" ").trim() || "(no transcript yet — ask what Kevin wants)";
    const confirmation = YES_PATTERN.test(transcript.last("kevin")?.text ?? "") && confirmations.arm() !== undefined;
    if (!confirmation && confirmations.pending && !YES_PATTERN.test(request)) {
      // A different request while a confirmation was pending drops it: a later
      // "yes" must not fire an action Kevin has moved on from.
      confirmations.clear();
    }

    const marks = new Marks(this.now);
    const abort = new AbortController();
    // A reflex that already ran for this very utterance: its record becomes this delegation's.
    const prefired = this.claimPrefired(requestItems);
    let delegation: Delegation;
    if (prefired && this.current(prefired.id)?.status === "running") {
      delegation = this.update(prefired.id, (d) => ({ ...d, liveId, offsetMs, request }))!;
    } else {
      const id = newId("dlg");
      const timings: DelegationTimings = { delegatedAt: marks.startedAt };
      delegation = { id, liveId, createdAt: marks.startedAt, offsetMs, request, status: "running", steps: [], timings };
      this.pushDelegation(delegation);
      this.opts.ledger?.append({ at: marks.startedAt, type: "delegation.created", delegation });
      this.emit("change", delegation);
    }
    const id = delegation.id;
    this.running = { delegation, abort, marks };
    this.emit("phase", "thinking");

    // Live rejects non-null delegation ids on appends while a Responses backend
    // owns the task; general session context is the only channel then.
    const appendId = target === "responses" ? null : liveId;
    const sink = this.makeSink(id, appendId, marks);

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
      const lastText = requestItems[requestItems.length - 1]?.text ?? request;
      const r = await this.opts.reflexes.reconcile(lastText);
      if (this.running?.delegation.id !== id) return; // cancelled or superseded while the undo ran
      if (r?.kind === "done") {
        const lead = this.now() - r.fired.dispatchedAt;
        this.addStep(id, { kind: "note", text: `reflex ${r.fired.reflex.label} already ran ${lead} ms ago on the ear's words (${Math.round(r.similarity * 100)} % match)` });
        this.markReflex(id);
        sink.commentary(r.fired.reflex.said);
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
      const done = await this.tryReflex(id, request, sink, prefired);
      if (done || this.running?.delegation.id !== id) return;
    } else if (prefired) {
      // Adopted, but this is a confirmation or a Responses task: the brain takes it, the record says what already happened.
      this.addStep(id, { kind: "note", text: `reflex ${prefired.reflex.label} already ran ahead of this request` });
    }

    // A circle still being captured is waited for (it is what "this" means); the
    // eyes take their quick shot meanwhile. A delegation that supersedes this one
    // meanwhile takes the marks instead.
    const [{ attachments: circled, ids: markIds }, screen] = await Promise.all([this.takeMarks(), this.look(id, sink)]);
    if (this.running?.delegation.id !== id) return;
    const attachments: BrainAttachment[] = [...(screen ? [screen] : []), ...circled];
    log.info(`delegation ${id} (${target}): "${request.slice(0, 80)}"${confirmation ? " [confirmation]" : ""}${circled.length ? ` [${circled.length} circled region(s)]` : ""}${screen ? " [screen]" : ""}`);

    const windowMs = this.opts.dialogueWindowMs ?? 120_000;
    const uptoMs = live.nowMs || offsetMs;
    const task: BrainTask = {
      delegationId: liveId,
      request,
      dialogue: transcript.render(windowMs, uptoMs),
      // Kevin's side only, for the gates: the rendered dialogue above carries Jarhead's lines too.
      kevinDialogue: transcript
        .since(uptoMs - windowMs - 1, "kevin")
        .map((i) => i.text.trim())
        .filter(Boolean)
        .join("\n"),
      confirmation,
      offsetMs,
      signal: abort.signal,
      ...(attachments.length ? { attachments } : {}),
    };

    let result: BrainResult;
    try {
      result = await brain.handle(task, sink);
    } catch (e) {
      result = { status: "failed", error: (e as Error).message };
    }
    if (this.running?.delegation.id !== id) return; // cancelled or superseded meanwhile
    if (result.status === "failed") {
      // The brain never got to work on it ("restarting", "already handling a task", a
      // spawn failure): the circles are still Kevin's next question, not spent.
      if (markIds.length > 0) this.opts.marks?.release(markIds);
      sink.commentary(`Something went wrong: ${(result.error ?? "unknown error").slice(0, 300)}`);
    } else if (result.summary && result.status === "done") {
      // Only speak the summary when the brain did not already speak it.
      const spokenAlready = this.current(id)?.steps.some((s) => s.kind === "commentary" && s.text === result.summary);
      if (!spokenAlready) sink.commentary(result.summary);
    }
    this.finish(id, result);
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
  private async tryReflex(id: string, request: string, sink: BrainSink, prefired: Prefired | undefined): Promise<boolean> {
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
      return false;
    }
    this.markReflex(id);
    if (outcome.result.kind === "needs-confirmation") {
      // The runner recorded the handshake; the question is the whole answer.
      sink.commentary(outcome.result.question);
      this.finish(id, { status: "done", summary: outcome.result.question });
      return true;
    }
    sink.commentary(reflex.said);
    this.finish(id, { status: "done", summary: reflex.said });
    return true;
  }

  private markReflex(id: string): void {
    this.update(id, (d) => ({ ...d, timings: { ...d.timings, reflex: true } as DelegationTimings }));
  }

  /** The eyes' quick shot, in this delegation's timeline; never throws, never blocks a task without eyes. */
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

  private update(id: string, patch: (d: Delegation) => Delegation): Delegation | undefined {
    const idx = this.delegations.findIndex((d) => d.id === id);
    if (idx < 0) return undefined;
    const next = patch(this.delegations[idx] as Delegation);
    this.delegations[idx] = next;
    if (this.running?.delegation.id === id) this.running.delegation = next;
    this.emit("change", next);
    return next;
  }

  /** Record a step and keep the latency marks: first tool, first action, every round trip. */
  private addStep(id: string, step: Omit<DelegationStep, "id" | "at">): void {
    const full: DelegationStep = { id: newId("step"), at: this.now(), ...step };
    const looking = this.running?.delegation.id === id && this.running.looking === true;
    this.update(id, (d) => {
      let timings = d.timings as DelegationTimingsExtra;
      // The eyes' pre-warm shot is the engine's, not the brain's: it does not count as the first tool.
      if (!looking && (step.kind === "tool" || step.kind === "screenshot" || step.kind === "confirm")) {
        const name = step.tool?.name;
        if (timings.firstToolAt === undefined) timings = { ...timings, firstToolAt: full.at };
        if (timings.firstActionAt === undefined && name && ACTING_MEMBERS.has(name) && step.kind === "tool") timings = { ...timings, firstActionAt: full.at };
        if (step.tool && Number.isFinite(step.tool.ms)) {
          const samples = timings.toolRoundTripMs ?? [];
          if (samples.length < MAX_ROUND_TRIP_SAMPLES) timings = { ...timings, toolRoundTripMs: [...samples, Math.round(step.tool.ms)] };
        }
      }
      return { ...d, steps: [...d.steps, full], timings: timings as DelegationTimings };
    });
    this.opts.ledger?.append({ at: full.at, type: "delegation.step", delegationId: id, step: full });
  }

  private makeSink(id: string, liveId: string | null, marks: Marks): BrainSink {
    const { live } = this.opts;
    const lastThinkingAt = { value: 0 };
    return {
      thinking: (text) => {
        if (this.running?.delegation.id !== id) return;
        if (!marks.has("firstThinking")) {
          marks.mark("firstThinking");
          this.update(id, (d) => ({ ...d, timings: { ...d.timings, firstThinkingAt: this.now() } }));
        }
        this.addStep(id, { kind: "thinking", text });
        // The voice does not need every click narrated; one silent nudge per
        // ~2.5 s keeps it able to say "still on it" without flooding the timeline.
        const t = this.now();
        if (t - lastThinkingAt.value < 2500) return;
        lastThinkingAt.value = t;
        for (const chunk of chunkForAppend(text)) live.appendThinking(liveId, chunk);
      },
      commentary: (text) => {
        if (this.running?.delegation.id !== id) return;
        if (!marks.has("firstCommentary")) {
          marks.mark("firstCommentary");
          this.update(id, (d) => ({ ...d, timings: { ...d.timings, firstCommentaryAt: this.now() } }));
        }
        this.addStep(id, { kind: "commentary", text });
        this.queueCommentary(id, liveId, text);
      },
      step: (step) => {
        if (this.running?.delegation.id !== id) return;
        if (step.kind === "tool" || step.kind === "screenshot") this.emit("phase", "acting");
        if (step.kind === "commentary" && !marks.has("firstCommentary")) {
          marks.mark("firstCommentary");
          this.update(id, (d) => ({ ...d, timings: { ...d.timings, firstCommentaryAt: this.now() } }));
        }
        if (step.kind === "confirm") this.update(id, (d) => ({ ...d, status: "awaiting-confirmation" }));
        this.addStep(id, step);
      },
      screenshot: (path, note) => {
        if (this.running?.delegation.id !== id) return;
        this.addStep(id, { kind: "screenshot", screenshotPath: path, ...(note ? { text: note } : {}) });
      },
    };
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

  private finish(id: string, result: BrainResult): void {
    const run = this.running;
    if (run?.delegation.id !== id) return;
    this.running = undefined;
    if (result.status === "cancelled") this.dropCommentary(id);
    else this.flushCommentary(id);
    const doneAt = this.now();
    const awaiting = run.delegation.steps.some((s) => s.kind === "confirm");
    const status = result.status === "done" && awaiting ? "awaiting-confirmation" : result.status;
    const finished = this.update(id, (d) => ({
      ...d,
      status,
      ...(result.summary ? { summary: result.summary } : {}),
      timings: { ...d.timings, doneAt },
    }));
    this.lastDelegationEndMs = this.opts.live.nowMs || run.delegation.offsetMs;
    if (finished) {
      this.opts.ledger?.append({ at: doneAt, type: "delegation.finished", delegationId: id, status: finished.status, timings: finished.timings, ...(finished.summary ? { summary: finished.summary } : {}) });
      const t = finished.timings as DelegationTimingsExtra;
      const rel = (v: number | undefined): string => (v === undefined ? "-" : String(v - t.delegatedAt));
      log.info(`delegation ${id} ${finished.status} in ${doneAt - run.marks.startedAt}ms (thinking@${rel(t.firstThinkingAt)} tool@${rel(t.firstToolAt)} action@${rel(t.firstActionAt)} commentary@${rel(t.firstCommentaryAt)}${t.reflex ? " reflex" : ""}${t.toolRoundTripMs?.length ? ` tools ${t.toolRoundTripMs.join("/")}ms` : ""})`);
    }
    this.emit("phase", "idle");
  }
}
