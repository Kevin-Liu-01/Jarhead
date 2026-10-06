import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, BrainResult, BrainSink, BrainTask, RunOutcome } from "@jarhead/brain";
import type { DelegationStep, LedgerRow } from "@jarhead/protocol";
import { analyzeSpeed } from "../../../cli/src/ledger-speed.ts";
import { delegate, settle, until, world, type World } from "./world.ts";

/**
 * W3-1 review, PERF-5: the lane runner records an acting step as the call returns, and the observer's `now:` line
 * follows it as a note. Before, the step waited for the observation (a 150 or 400 ms settle plus a read of up to
 * 300 ms): a Stop in that window dropped a step whose pointer move had already landed, two acting calls issued
 * together reached the ledger out of order, and `firstActionAt` carried the settle. A stand-in observer with the
 * production settles shows each case. Fake hands, fake Live, the fake clock; nothing acts on the Mac.
 */

type StepRow = Extract<LedgerRow, { type: "delegation.step" }>;
type Finished = Extract<LedgerRow, { type: "delegation.finished" }>;

/** An observer that settles `ms(name)` real milliseconds (the clock moves with it) and ends the result with a now: line. */
function observer(w: () => World, ms: (name: string) => number) {
  return {
    annotate: async (name: string, _args: Record<string, unknown>, out: RunOutcome): Promise<RunOutcome> => {
      const wait = ms(name);
      await settle(wait);
      w().clock.t += wait;
      return out.result.kind === "text" ? { ...out, result: { kind: "text", text: `${out.result.text}\nnow: Finder in front; ${wait} ms after ${name}` } } : out;
    },
  };
}

/** A main brain that runs `body` with the engine's runner attached for its turn, and answers a stop at once (a real brain's cancel does). */
function brainOf(w: () => World, body: (runner: World["engine"]["runner"]) => Promise<void>): Brain {
  return {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async (task: BrainTask, sink: BrainSink): Promise<BrainResult> => {
      const { engine } = w();
      engine.runner.attach(sink, task);
      try {
        const cancelled = new Promise<BrainResult>((r) => task.signal.addEventListener("abort", () => r({ status: "cancelled" }), { once: true }));
        return await Promise.race([body(engine.runner).then((): BrainResult => ({ status: "done", summary: "done." })), cancelled]);
      } finally {
        engine.runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
}

const stepsOf = (w: World): DelegationStep[] => (w.engine.ledger.read(w.clock.t) as LedgerRow[]).filter((r): r is StepRow => r.type === "delegation.step").map((r) => r.step);
const finishedOf = (w: World): Finished | undefined => (w.engine.ledger.read(w.clock.t) as LedgerRow[]).find((r): r is Finished => r.type === "delegation.finished");
const toolNames = (steps: readonly DelegationStep[]): string[] => steps.filter((s) => s.tool !== undefined && s.tool.name !== "screenshot").map((s) => s.tool!.name);

test("PERF-5 (review): a Stop while the observer reads the screen after a pointer move that landed keeps the move on the ledger, and firstActionAt with it; the line the model never read is not written", async () => {
  let w!: World;
  w = world({ brain: brainOf(() => w, async (runner) => void (await runner.run("mouse_move", { coordinate: [10, 10] }))) });
  w.engine.runner.setHooks({ observer: observer(() => w, () => 400) });
  try {
    await w.engine.start();
    await w.engine.ready();
    await w.engine.wake("test");
    delegate(w, "jarhead move the pointer", "l1");
    assert.ok(await until(() => w.hands.ops.some((o) => o.op === "move" || o.op === "mouse_move"), 3000), "the pointer moved");
    await settle(50); // inside the observation's 400 ms
    await w.engine.command({ type: "stop" });
    await settle(600);
    const steps = stepsOf(w);
    assert.deepEqual(toolNames(steps), ["mouse_move"], "the move that landed is on the ledger");
    const fin = finishedOf(w);
    assert.equal(fin?.status, "cancelled");
    assert.notEqual(fin?.timings.firstActionAt, undefined, "and stamped the first action");
    assert.equal(steps.filter((s) => s.kind === "note" && /^now:/.test(s.text ?? "")).length, 0, "the turn was stopped: no now: note for a line nobody read");
  } finally {
    await Promise.race([w.engine.stop(), settle(2000)]);
  }
});

test("PERF-5 (review): two acting calls issued together reach the ledger in the order they ran, the first one's slower settle notwithstanding; firstActionAt is the first landing, before its now: note; ledger --speed counts both observed", async () => {
  let w!: World;
  w = world({
    brain: brainOf(() => w, async (runner) => {
      const move = runner.run("mouse_move", { coordinate: [10, 10] });
      await until(() => w.hands.ops.some((o) => o.op === "move" || o.op === "mouse_move"), 2000);
      const scroll = runner.run("scroll", { coordinate: [10, 10], scroll_direction: "down", scroll_amount: 3 });
      await Promise.all([move, scroll]);
    }),
  });
  // The production settles: 400 ms after a browser click or navigation, 150 ms after the rest. The first call settles longer here.
  w.engine.runner.setHooks({ observer: observer(() => w, (name) => (name === "mouse_move" ? 400 : 150)) });
  try {
    await w.engine.start();
    await w.engine.ready();
    await w.engine.wake("test");
    delegate(w, "jarhead move and scroll", "l2");
    assert.ok(await until(() => w.engine.snapshot().delegations.some((x) => x.liveId === "l2" && x.status !== "running"), 5000));
    await settle(100);
    const ran = w.hands.ops.filter((o) => o.op === "move" || o.op === "mouse_move" || o.op === "scroll").map((o) => o.op);
    assert.equal(ran.length, 2);
    const steps = stepsOf(w);
    assert.deepEqual(toolNames(steps), ["mouse_move", "scroll"], `ran ${ran.join(", ")}: the ledger keeps that order`);
    const move = steps.find((s) => s.tool?.name === "mouse_move")!;
    const notes = steps.filter((s) => s.kind === "note" && /^now:/.test(s.text ?? ""));
    assert.equal(notes.length, 2, "each observed call's line follows it as a note");
    assert.ok(notes.every((n) => steps.indexOf(n) > steps.indexOf(move)), "after the step it observed");
    assert.equal(typeof move.tool?.output === "string" && /now:/.test(move.tool.output), false, "the step itself is the result as it landed");
    const fin = finishedOf(w);
    assert.equal(fin?.timings.firstActionAt, move.at, "the first action is stamped when it landed");
    assert.ok(Math.min(...notes.map((n) => n.at)) > move.at, "not after its observation");
    const report = analyzeSpeed(w.engine.ledger.read(w.clock.t));
    assert.deepEqual([report.observed.withLine, report.observed.steps], [2, 2], "ledger --speed pairs each note with an acting step");
  } finally {
    await Promise.race([w.engine.stop(), settle(2000)]);
  }
});
