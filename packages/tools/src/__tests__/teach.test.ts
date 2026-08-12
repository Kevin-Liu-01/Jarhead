import { test } from "node:test";
import assert from "node:assert/strict";
import { teach, type ModelStep, type TeachExchange } from "../teach.ts";
import type { Beat } from "../choreograph.ts";
import { fakeDeps } from "./fakes.ts";

const silentPresent = async (_beats: readonly Beat[]): Promise<void> => undefined;

const pointingStep: ModelStep = {
  narration: "The server list runs down the left edge. This arrow marks the Gaming server.",
  calls: [
    { id: "t1", name: "find_on_screen", input: { description: "the Gaming server icon" } },
    { id: "t2", name: "point_at", input: { x: 40, y: 300, label: "the Gaming server" } },
  ],
};

const finalStep: ModelStep = { narration: "That is all there is to it.", calls: [] };

test("the loop runs until the model stops calling tools", async () => {
  const { deps, calls } = fakeDeps();
  const presented: (readonly Beat[])[] = [];
  const outcome = await teach("show me how to use discord", {
    runModel: async (_utterance, transcript) => (transcript.length === 0 ? pointingStep : finalStep),
    deps,
    present: async (beats) => {
      presented.push(beats);
    },
  });

  assert.equal(outcome.stopped, "model-done");
  assert.equal(outcome.steps, 2);
  assert.equal(presented.length, 2, "both narrations were presented");

  // The non-visual call executed for real; the visual one belongs to the
  // presenter and must not have hit the annotator a second time.
  assert.ok(calls.includes("find:the Gaming server icon"));
  assert.equal(calls.some((c) => c.startsWith("draw:") || c.startsWith("move:")), false);

  const results = outcome.transcript[0]?.results ?? [];
  assert.equal(results[0]?.id, "t1");
  assert.equal(results[0]?.ok, true);
  assert.match(results[0]?.detail ?? "", /"found":true/);
  assert.equal(results[1]?.id, "t2");
  assert.equal(results[1]?.detail, "shown during narration");
});

test("tool results feed the next model call", async () => {
  const { deps } = fakeDeps();
  const seen: (readonly TeachExchange[])[] = [];
  await teach("q", {
    runModel: async (_utterance, transcript) => {
      // Snapshot: teach appends to the same array across the loop.
      seen.push([...transcript]);
      return transcript.length === 0 ? pointingStep : finalStep;
    },
    deps,
    present: silentPresent,
  });
  assert.equal(seen[0]?.length, 0);
  assert.match(seen[1]?.[0]?.results[0]?.detail ?? "", /"found":true/);
});

test("a malformed visual call is reported as not shown, not as success", async () => {
  const { deps } = fakeDeps();
  const outcome = await teach("q", {
    runModel: async (_utterance, transcript) =>
      transcript.length === 0
        ? { narration: "Watch this.", calls: [{ id: "v1", name: "point_at", input: { x: "forty", y: 300 } }] }
        : finalStep,
    deps,
    present: silentPresent,
  });
  const record = outcome.transcript[0]?.results[0];
  assert.equal(record?.ok, false);
  assert.match(record?.detail ?? "", /nothing was shown/);
});

test("the step cap is hard, even against a model that never stops", async () => {
  const { deps } = fakeDeps();
  let modelCalls = 0;
  const outcome = await teach("q", {
    runModel: async () => {
      modelCalls++;
      return pointingStep;
    },
    deps,
    present: silentPresent,
    maxSteps: 3,
  });
  assert.equal(outcome.stopped, "step-cap");
  assert.equal(outcome.steps, 3);
  assert.equal(modelCalls, 3);
});

test("the budget stops the loop between tool calls, not just between steps", async () => {
  // A fake clock the model call burns through: the between-call check must
  // trip before list_windows ever executes.
  let t = 0;
  const { deps, calls } = fakeDeps();
  const outcome = await teach("q", {
    runModel: async () => {
      t += 40_000;
      return { narration: "", calls: [{ id: "w1", name: "list_windows", input: {} }] };
    },
    deps,
    present: silentPresent,
    budgetMs: 30_000,
    now: () => t,
  });
  assert.equal(outcome.stopped, "budget");
  assert.equal(outcome.steps, 1);
  assert.equal(calls.length, 0, "no tool may run past the budget");
  assert.deepEqual(outcome.transcript[0]?.results, []);
});

test("Kevin interrupting mid-step stops the lesson there", async () => {
  const { deps, calls } = fakeDeps();
  const controller = new AbortController();
  let modelCalls = 0;
  const outcome = await teach("q", {
    runModel: async () => {
      modelCalls++;
      return pointingStep;
    },
    deps,
    // The interruption arrives while this step's narration is playing.
    present: async () => {
      controller.abort();
    },
    signal: controller.signal,
  });
  assert.equal(outcome.stopped, "aborted");
  assert.equal(modelCalls, 1);
  assert.equal(calls.length, 0, "no tool ran after the abort");
});

test("an already-aborted signal never reaches the model at all", async () => {
  const { deps } = fakeDeps();
  const controller = new AbortController();
  controller.abort();
  let modelCalls = 0;
  const outcome = await teach("q", {
    runModel: async () => {
      modelCalls++;
      return finalStep;
    },
    deps,
    present: silentPresent,
    signal: controller.signal,
  });
  assert.equal(outcome.stopped, "aborted");
  assert.equal(modelCalls, 0);
});

test("a model call blowing up is an outcome, not an exception", async () => {
  const { deps } = fakeDeps();
  const outcome = await teach("q", {
    runModel: async () => {
      throw new Error("529 overloaded");
    },
    deps,
    present: silentPresent,
  });
  assert.equal(outcome.stopped, "error");
  assert.match(outcome.error ?? "", /529/);
});

test("a hung model call cannot outlive the budget", async () => {
  // Every governor used to be checked between awaits, so one call that never
  // returned defeated the step cap, the budget and abort simultaneously.
  const outcome = await teach("show me discord", {
    runModel: () => new Promise(() => undefined), // never settles
    present: async () => undefined,
    deps: {} as never,
    budgetMs: 60,
  });
  assert.equal(outcome.stopped, "budget");
});

test("a hung model call still yields to an interrupt", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40);
  const outcome = await teach("show me discord", {
    runModel: () => new Promise(() => undefined),
    present: async () => undefined,
    deps: {} as never,
    budgetMs: 10_000,
    signal: ac.signal,
  });
  assert.equal(outcome.stopped, "aborted");
});

test("a hung presenter cannot strand the loop either", async () => {
  const outcome = await teach("show me discord", {
    runModel: async () => ({ narration: "here", calls: [{ id: "1", name: "draw", input: { shape: "arrow", x: 1, y: 1 } }] }),
    present: () => new Promise(() => undefined),
    deps: {} as never,
    budgetMs: 60,
  });
  assert.equal(outcome.stopped, "budget");
});
