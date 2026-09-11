import { test } from "node:test";
import assert from "node:assert/strict";
import { allReadOnly, haltReason, runToolBatch } from "../batch.ts";
import type { RunOutcome, ToolRunner } from "../runner.ts";

/**
 * Several tool calls in one model turn: look-only ones run together, anything
 * that acts runs in order — and the ordered batch stops at the first call that
 * did not go through. A needs-confirmation must reach Kevin before anything
 * else happens; a refusal or an error invalidates the plan the later calls
 * assumed. The calls not run get an error result that says why.
 */

function fakeRunner(script: Record<string, RunOutcome["result"]>): { runner: ToolRunner; ran: string[]; inFlight: () => number; maxInFlight: () => number } {
  const ran: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner = {
    run: async (name: string): Promise<RunOutcome> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      ran.push(name);
      return { result: script[name] ?? { kind: "text", text: `${name} ok` }, ms: 5 };
    },
  } as unknown as ToolRunner;
  return { runner, ran, inFlight: () => inFlight, maxInFlight: () => maxInFlight };
}

test("batch: look-only calls run together; a batch with an action runs in order", async () => {
  assert.equal(allReadOnly([{ name: "screenshot", input: {} }, { name: "frontmost_app", input: {} }]), true);
  assert.equal(allReadOnly([{ name: "screenshot", input: {} }]), false, "one call is not a batch");
  assert.equal(allReadOnly([{ name: "screenshot", input: {} }, { name: "left_click", input: {} }]), false);

  const looks = fakeRunner({});
  const out = await runToolBatch(looks.runner, [{ name: "screenshot", input: {} }, { name: "frontmost_app", input: {} }, { name: "list_windows", input: {} }]);
  assert.equal(out.length, 3);
  assert.equal(looks.maxInFlight(), 3, "concurrent");

  const acts = fakeRunner({});
  const before: string[] = [];
  await runToolBatch(acts.runner, [{ name: "screenshot", input: {} }, { name: "left_click", input: { coordinate: [1, 2] } }, { name: "type", input: { text: "x" } }], { before: (c) => before.push(c.name) });
  assert.deepEqual(acts.ran, ["screenshot", "left_click", "type"], "in order");
  assert.equal(acts.maxInFlight(), 1);
  assert.deepEqual(before, ["screenshot", "left_click", "type"]);
});

test("batch: after a needs-confirmation the rest of the ordered batch is not run — the question reaches Kevin before anything else happens", async () => {
  const { runner, ran } = fakeRunner({ left_click: { kind: "needs-confirmation", pendingId: "p1", question: "About to click Send. Ask Kevin, then stop." } });
  const out = await runToolBatch(runner, [
    { name: "screenshot", input: {} },
    { name: "left_click", input: { coordinate: [10, 10] } },
    { name: "key", input: { text: "cmd+q" } },
    { name: "type", input: { text: "bye" } },
  ]);
  assert.deepEqual(ran, ["screenshot", "left_click"], "cmd+q and the typing never ran");
  assert.equal(out.length, 4, "every call still has a result, in order");
  assert.equal(out[1]!.result.kind, "needs-confirmation");
  assert.equal(out[2]!.result.kind, "error");
  assert.match((out[2]!.result as { message: string }).message, /^not run: left_click is waiting for Kevin's answer/);
  assert.equal((out[3]!.result as { message: string }).message, (out[2]!.result as { message: string }).message);
});

test("batch: a refusal or an error earlier in the turn halts the rest too, with the reason; the concurrent look-only branch is untouched", async () => {
  const refused = fakeRunner({ run_shell: { kind: "error", message: "refused: rm outside temp is on the never list" } });
  const out = await runToolBatch(refused.runner, [{ name: "run_shell", input: { command: "rm x" } }, { name: "left_click", input: {} }]);
  assert.deepEqual(refused.ran, ["run_shell"]);
  assert.match((out[1]!.result as { message: string }).message, /^not run: run_shell was refused earlier in this turn$/);

  const failed = fakeRunner({ left_click: { kind: "error", message: "no element at 900,900" } });
  const out2 = await runToolBatch(failed.runner, [{ name: "left_click", input: {} }, { name: "type", input: { text: "hello" } }]);
  assert.deepEqual(failed.ran, ["left_click"], "typing into whatever is focused after a failed click is not the plan");
  assert.match((out2[1]!.result as { message: string }).message, /^not run: left_click failed earlier in this turn \(no element at 900,900\)$/);

  assert.equal(haltReason({ name: "x", input: {} }, { result: { kind: "text", text: "ok" }, ms: 1 }), undefined);
  assert.equal(haltReason({ name: "x", input: {} }, { result: { kind: "image", pngBase64: "", width: 1, height: 1 }, ms: 1 }), undefined);

  // Look-only calls that fail do not stop their siblings: they ran together anyway.
  const looks = fakeRunner({ frontmost_app: { kind: "error", message: "hands are down" } });
  const out3 = await runToolBatch(looks.runner, [{ name: "frontmost_app", input: {} }, { name: "screenshot", input: {} }]);
  assert.equal(out3.length, 2);
  assert.equal(out3[1]!.result.kind, "text");

  // An aborted signal ends the batch early with fewer results, as before.
  const abort = new AbortController();
  abort.abort();
  const out4 = await runToolBatch(fakeRunner({}).runner, [{ name: "left_click", input: {} }, { name: "type", input: {} }], { signal: abort.signal });
  assert.equal(out4.length, 0);
});
