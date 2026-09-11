import { EventEmitter } from "node:events";
import { isAbsolute, join } from "node:path";
import { logger, newId, Marks, type Ledger } from "@jarhead/core";
import { chunkForAppend, type LiveSession, type Transcript } from "@jarhead/live";
import { YES_PATTERN, type ConfirmationState } from "@jarhead/hands";
import type { Delegation, DelegationStep, DelegationTimings, ScreenMark } from "@jarhead/protocol";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { markNote } from "./attachments.ts";

/**
 * Where the voice meets the brain.
 *
 * Listens to one LiveSession, builds a task for every delegation from the
 * transcript, runs it on the brain, and relays progress back through the three
 * append channels with the 500-token cap respected. Also owns the two spoken
 * escape hatches: "stop" cancels the running task, and a "yes" arms a pending
 * confirmation so the next attempt of that exact action goes through.
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
}

const STOP_PATTERN = /^\s*(stop|cancel|never ?mind|forget it|abort|that'?s enough|hold on)\b/i;

export class Delegator extends EventEmitter<DelegatorEvents> {
  private readonly delegations: Delegation[] = [];
  private running: { delegation: Delegation; abort: AbortController; marks: Marks } | undefined;
  private lastDelegationEndMs = 0;
  private readonly now: () => number;
  private unbind: (() => void)[] = [];

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
  }

  /** "stop" while a task runs cancels it. Checked on fragments so it lands fast. */
  private onInputDelta(delta: string): void {
    if (!this.running) return;
    const recent = (this.opts.transcript.last("kevin")?.text ?? "") + delta;
    const tail = recent.slice(-40);
    if (STOP_PATTERN.test(tail.trimStart()) || /\b(stop|cancel)\b\s*$/i.test(tail)) {
      log.info("Kevin said stop; cancelling");
      void this.cancel("Kevin said stop");
    }
  }

  async cancel(reason: string): Promise<void> {
    const run = this.running;
    if (!run) return;
    run.abort.abort();
    await this.opts.brain.cancel();
    this.finish(run.delegation.id, { status: "cancelled", summary: reason });
    this.emit("cancelled", reason);
    this.opts.live.appendInstructions(null, "Kevin cancelled the task. Acknowledge with one word and wait.");
  }

  private async onDelegation(liveId: string, target: "client" | "responses", offsetMs: number): Promise<void> {
    const { transcript, live, confirmations, brain } = this.opts;
    // A new delegation while one runs: the voice decided Kevin wants something
    // else. Finish the old one as superseded rather than running two at once.
    if (this.running) {
      this.running.abort.abort();
      await brain.cancel();
      this.finish(this.running.delegation.id, { status: "cancelled", summary: "superseded by a new request" });
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
    const id = newId("dlg");
    const timings: DelegationTimings = { delegatedAt: marks.startedAt };
    const delegation: Delegation = { id, liveId, createdAt: marks.startedAt, offsetMs, request, status: "running", steps: [], timings };
    this.delegations.push(delegation);
    if (this.delegations.length > 200) this.delegations.splice(0, this.delegations.length - 200);
    this.running = { delegation, abort, marks };
    this.opts.ledger?.append({ at: marks.startedAt, type: "delegation.created", delegation });
    this.emit("change", delegation);
    this.emit("phase", "thinking");

    // A circle still being captured is waited for (it is what "this" means); a
    // delegation that supersedes this one meanwhile takes the marks instead.
    const { attachments, ids: markIds } = await this.takeMarks();
    if (this.running?.delegation.id !== id) return;
    log.info(`delegation ${id} (${target}): "${request.slice(0, 80)}"${confirmation ? " [confirmation]" : ""}${attachments.length ? ` [${attachments.length} circled region(s)]` : ""}`);

    // Live rejects non-null delegation ids on appends while a Responses backend
    // owns the task; general session context is the only channel then.
    const appendId = target === "responses" ? null : liveId;
    const sink = this.makeSink(id, appendId, marks);
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
      attachments.push({ path: isAbsolute(m.screenshotPath) ? m.screenshotPath : join(source.stateDir, m.screenshotPath), mediaType: "image/png", note: markNote(m.rect, now - m.at) });
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

  private addStep(id: string, step: Omit<DelegationStep, "id" | "at">): void {
    const full: DelegationStep = { id: newId("step"), at: this.now(), ...step };
    this.update(id, (d) => ({ ...d, steps: [...d.steps, full] }));
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
        for (const chunk of chunkForAppend(text)) live.appendCommentary(liveId, chunk);
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

  private finish(id: string, result: BrainResult): void {
    const run = this.running;
    if (run?.delegation.id !== id) return;
    this.running = undefined;
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
      log.info(`delegation ${id} ${finished.status} in ${doneAt - run.marks.startedAt}ms (thinking@${run.marks.since("firstThinking") ?? "-"} commentary@${run.marks.since("firstCommentary") ?? "-"})`);
    }
    this.emit("phase", "idle");
  }
}
