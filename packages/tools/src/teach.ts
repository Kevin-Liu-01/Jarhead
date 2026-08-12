import { executeTool, type ToolDeps } from "./executor.ts";
import { planFromToolCalls, VISUAL_TOOL_NAMES, visualCue, type Beat, type ModelBlock } from "./choreograph.ts";

/**
 * Multi-step teaching: "show me how to use discord" becomes a loop of model
 * turns, each narrated and choreographed, until the model stops calling tools.
 *
 * Three governors, all non-negotiable, because a model with tools and no cap
 * is an unbounded process attached to Kevin's screen:
 *
 * - a hard step cap (steps, not tool calls: one confused turn can emit many);
 * - a wall-clock budget, checked between every await so a slow tool cannot
 *   sail past it by starting just under the line;
 * - an abort signal, checked at the same seams, because Kevin interrupting
 *   must stop the lesson mid-step — the beats already playing are the
 *   presenter's problem, but no further tool may run.
 *
 * Narration is presented BEFORE this step's actions execute: Kevin hears what
 * is about to happen while the arrows land, and only then does anything
 * irreversible (a click) actually fire. Visual tool calls are performed by the
 * presenter as `show` commands at the right moment in the narration —
 * executing them here too would draw every arrow twice.
 *
 * The model call is injected, so the whole loop runs under test against a
 * scripted sequence of fake steps.
 */

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** One model turn: what it wants to say and what it wants to do. */
export interface ModelStep {
  readonly narration: string;
  readonly calls: readonly ToolCallRequest[];
}

export interface ToolResultRecord {
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  /** JSON for successes, the error message for failures — what goes back into the model's context. */
  readonly detail: string;
}

export interface TeachExchange {
  readonly step: ModelStep;
  readonly results: readonly ToolResultRecord[];
}

export type RunModel = (utterance: string, transcript: readonly TeachExchange[]) => Promise<ModelStep>;

export interface TeachOptions {
  readonly runModel: RunModel;
  readonly deps: ToolDeps;
  /** How beats reach Kevin — the integrator wires runChoreography with a real speaker here. */
  readonly present: (beats: readonly Beat[]) => Promise<void>;
  readonly maxSteps?: number;
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export type TeachStop = "model-done" | "step-cap" | "budget" | "aborted" | "error";

export interface TeachOutcome {
  readonly stopped: TeachStop;
  /** Model turns taken, including the final one that called no tools. */
  readonly steps: number;
  readonly transcript: readonly TeachExchange[];
  readonly error: string | undefined;
}

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_BUDGET_MS = 90_000;

export async function teach(utterance: string, opts: TeachOptions): Promise<TeachOutcome> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = now();
  const transcript: TeachExchange[] = [];
  let steps = 0;

  const done = (stopped: TeachStop, error?: string): TeachOutcome => ({
    stopped,
    steps,
    transcript,
    error,
  });

  /**
   * Sentinels, so a race can report WHY it won without throwing.
   *
   * The step cap, the budget and the abort were all checked between awaits,
   * which meant a single hung call — a model request that never returns, a
   * presenter waiting on audio that never finishes — defeated all three at once.
   * Kevin interrupting did nothing, because the abort check only ran after the
   * await it was supposed to cancel. Racing each await against the deadline and
   * the signal is what makes them governors rather than suggestions.
   */
  const ABORTED = Symbol("aborted");
  const EXPIRED = Symbol("expired");

  /**
   * Takes a THUNK, not a promise.
   *
   * `guard(runModel(...))` evaluates the call before guard can measure the
   * deadline, so work that consumed the whole budget was reported as having
   * never run — the step counter said 0 for a step that had plainly happened.
   * Starting the work inside guard keeps the measurement honest.
   */
  function guard<T>(start: () => Promise<T>): Promise<T | typeof ABORTED | typeof EXPIRED> {
    const remaining = budgetMs - (now() - startedAt);
    if (remaining <= 0) return Promise.resolve(EXPIRED);
    if (opts.signal?.aborted) return Promise.resolve(ABORTED);

    let work: Promise<T>;
    try {
      work = start();
    } catch (e) {
      return Promise.reject(e as Error);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (v: T | typeof ABORTED | typeof EXPIRED): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = (): void => finish(ABORTED);
      const timer = setTimeout(() => finish(EXPIRED), remaining);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      work.then(finish, (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(e as Error);
      });
    });
  }

  try {
    for (;;) {
      if (opts.signal?.aborted) return done("aborted");
      if (now() - startedAt >= budgetMs) return done("budget");
      if (steps >= maxSteps) return done("step-cap");

      const stepOrStop = await guard(() => opts.runModel(utterance, transcript));
      if (stepOrStop === ABORTED) return done("aborted");
      if (stepOrStop === EXPIRED) return done("budget");
      const step = stepOrStop;
      steps++;
      if (opts.signal?.aborted) return done("aborted");

      const blocks: readonly ModelBlock[] = [
        { type: "text", text: step.narration },
        ...step.calls.map((c): ModelBlock => ({ type: "tool_use", name: c.name, input: c.input })),
      ];
      const beats = planFromToolCalls(blocks);
      if (beats.length > 0) {
        const shown = await guard(() => opts.present(beats));
        if (shown === ABORTED) {
          transcript.push({ step, results: [] });
          return done("aborted");
        }
        if (shown === EXPIRED) {
          transcript.push({ step, results: [] });
          return done("budget");
        }
      }
      if (opts.signal?.aborted) {
        transcript.push({ step, results: [] });
        return done("aborted");
      }

      if (step.calls.length === 0) {
        transcript.push({ step, results: [] });
        return done("model-done");
      }

      const results: ToolResultRecord[] = [];
      for (const call of step.calls) {
        if (opts.signal?.aborted) {
          transcript.push({ step, results });
          return done("aborted");
        }
        if (now() - startedAt >= budgetMs) {
          transcript.push({ step, results });
          return done("budget");
        }

        if (VISUAL_TOOL_NAMES.has(call.name)) {
          // Already performed by the presenter — but only if the plan could
          // actually parse it. Claiming a malformed arrow was shown would
          // teach the model its broken input worked.
          const shown = visualCue(call.name, call.input) !== undefined;
          results.push({
            id: call.id,
            name: call.name,
            ok: shown,
            detail: shown ? "shown during narration" : "malformed input; nothing was shown",
          });
          continue;
        }

        // Guarded too: a tool that hangs (a vision call on a wedged capture, an
        // accessibility query against a frozen app) is the most likely thing to
        // stall a teaching sequence, and it is exactly when Kevin reaches for
        // the interrupt.
        const guarded = await guard(() => executeTool(call.name, call.input, opts.deps));
        if (guarded === ABORTED) {
          transcript.push({ step, results });
          return done("aborted");
        }
        if (guarded === EXPIRED) {
          transcript.push({ step, results });
          return done("budget");
        }
        const outcome = guarded;
        results.push({
          id: call.id,
          name: call.name,
          ok: outcome.ok,
          detail: outcome.ok ? JSON.stringify(outcome.result) : outcome.error,
        });
      }
      transcript.push({ step, results });
    }
  } catch (e) {
    // The injected model call or presenter failing must surface as an outcome,
    // not an exception — the voice loop above this has nothing sane to do with
    // a throw except go silent.
    return done("error", e instanceof Error ? e.message : String(e));
  }
}
