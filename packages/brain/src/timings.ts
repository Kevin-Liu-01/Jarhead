import { ACTING_MEMBERS } from "@jarhead/hands";
import type { DelegationStep, DelegationTimings } from "@jarhead/protocol";

/**
 * The latency marks one step stamps on a turn — pure, so the main conversation
 * (the Delegator) and every spawned thread (the ThreadScheduler) stamp them the
 * same way, and a bench reading `delegation.finished` rows cannot tell whose turn
 * it was. Factored out of `Delegator.addStep`; not a rail.
 */

/**
 * What the ledger's `delegation.finished` row carries beyond the contract's
 * DelegationTimings: when the first tool ran, every tool's round trip, whether a
 * reflex did the work, how long the eyes took. The Swift decoder ignores keys it
 * does not know.
 */
export interface TimingsExtra extends DelegationTimings {
  readonly firstToolAt?: number;
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
 * step whose tool returned ok counts. The one acting set: the Delegator, the threads'
 * turns, the engine's observer and the bench all import it from here.
 */
export const ACTING_TOOLS: ReadonlySet<string> = new Set([...ACTING_MEMBERS, "applescript", "run_shell", "write_file", "edit_file", "browser_navigate", "browser_click", "browser_type", "show_circle", "show_arrow", "show_rect", "show_text", "show_stroke"]);

/** Round trips kept per turn; past this the timings stop growing. */
export const MAX_ROUND_TRIP_SAMPLES = 40;

export interface StampOptions {
  /** When the step landed (wall clock). */
  readonly at: number;
  /** The eyes' pre-warm shot is in flight: its screenshot is the engine's, not the brain's first tool. */
  readonly looking?: boolean | undefined;
  /** The acting set (default ACTING_TOOLS). */
  readonly acting?: ReadonlySet<string> | undefined;
  readonly maxSamples?: number | undefined;
}

/**
 * The timings after this step: `firstToolAt` on the first tool / screenshot /
 * confirm step, `firstActionAt` on the first acting tool whose `tool` step returned
 * ok (never a look, an `error` step or a `confirm` question), one round-trip sample
 * per tool. A step tagged with a thread's name stamps nothing (the parent's marks
 * measure the parent); the eyes' shot stamps nothing. Returns the same object when
 * nothing changed.
 */
export function stampStep(timings: TimingsExtra, step: Omit<DelegationStep, "id" | "at">, opts: StampOptions): TimingsExtra {
  if (opts.looking || step.thread) return timings;
  if (step.kind !== "tool" && step.kind !== "screenshot" && step.kind !== "confirm") return timings;
  const acting = opts.acting ?? ACTING_TOOLS;
  const max = opts.maxSamples ?? MAX_ROUND_TRIP_SAMPLES;
  let out = timings;
  const name = step.tool?.name;
  if (out.firstToolAt === undefined) out = { ...out, firstToolAt: opts.at };
  if (out.firstActionAt === undefined && name && acting.has(name) && step.kind === "tool" && step.tool?.ok === true) out = { ...out, firstActionAt: opts.at };
  if (step.tool && Number.isFinite(step.tool.ms)) {
    const samples = out.toolRoundTripMs ?? [];
    if (samples.length < max) out = { ...out, toolRoundTripMs: [...samples, Math.round(step.tool.ms)] };
  }
  return out;
}
