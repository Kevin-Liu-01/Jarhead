import { READ_ONLY_TOOLS } from "@jarhead/hands";
import type { RunOutcome, ToolRunner } from "./runner.ts";

/**
 * A model that emits several tool calls in one turn gets them run together when
 * every one of them only looks (screenshot + frontmost_app + list_windows is the
 * common opener); the moment one of them acts, the batch runs in order, because
 * a click changes what the next screenshot shows. The results come back in the
 * order the calls were made either way, which is what every transport expects.
 *
 * In the ordered branch the batch stops at the first call that did not go
 * through: a `needs-confirmation` (the question must reach Kevin before anything
 * else happens — the brain used to guarantee that by ending its turn with the
 * question, one call per turn), a refusal, or any error (the calls after it were
 * planned on the assumption it worked). The calls not run get an error result
 * that says so, so the model re-plans instead of guessing.
 */

export interface BatchCall {
  readonly name: string;
  readonly input: unknown;
}

export function allReadOnly(calls: readonly BatchCall[]): boolean {
  return calls.length > 1 && calls.every((c) => READ_ONLY_TOOLS.has(c.name));
}

/** Why the rest of an ordered batch was not run, or undefined when this outcome lets the batch go on. */
export function haltReason(call: BatchCall, outcome: RunOutcome, userName = "Kevin"): string | undefined {
  switch (outcome.result.kind) {
    case "needs-confirmation":
      return `not run: ${call.name} is waiting for ${userName}'s answer; ask ${userName} and stop`;
    case "error":
      return /^refused:/.test(outcome.result.message) ? `not run: ${call.name} was refused earlier in this turn` : `not run: ${call.name} failed earlier in this turn (${outcome.result.message.slice(0, 120)})`;
    default:
      return undefined;
  }
}

export async function runToolBatch(
  runner: ToolRunner,
  calls: readonly BatchCall[],
  opts: { readonly signal?: AbortSignal | undefined; readonly before?: ((call: BatchCall) => void) | undefined } = {},
): Promise<RunOutcome[]> {
  if (allReadOnly(calls)) {
    for (const c of calls) opts.before?.(c);
    return Promise.all(calls.map((c) => runner.run(c.name, c.input)));
  }
  const out: RunOutcome[] = [];
  let halted: string | undefined;
  for (const c of calls) {
    if (opts.signal?.aborted) break;
    if (halted) {
      out.push({ result: { kind: "error", message: halted }, ms: 0 });
      continue;
    }
    opts.before?.(c);
    const outcome = await runner.run(c.name, c.input);
    out.push(outcome);
    halted = haltReason(c, outcome, runner.userName);
  }
  return out;
}
