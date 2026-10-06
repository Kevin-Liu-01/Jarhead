import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, BrainSink, BrainTask } from "@jarhead/brain";
import type { Delegation, DelegationStep, LedgerRow } from "@jarhead/protocol";
import { delegate, settle, until, world, type World } from "../../../engine/src/__tests__/world.ts";
import { analyzeSpeed, renderSpeed } from "../ledger-speed.ts";

/**
 * W3-1, PERF-5: the `now:` line the observer adds to an acting result is on the ledger, as a note after the step,
 * so `pnpm jarhead ledger --speed` can count it (before, nothing recorded the line, and the report read 0 % whatever
 * happened). And `ledger --speed` leaves a negative interval out of its figures and says how
 * many it left out: a speech end stamped after the action (PERF-6's skewed clock, in rows written before W3-1) is not a
 * latency. Fake hands, fake Live, the fake clock; the one shell line prints zeros.
 */

/** A main brain that runs `calls` through the engine's runner and keeps what each result said. */
function scripted(w: () => World, calls: readonly [string, Record<string, unknown>][], seen: string[]): Brain {
  return {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async (task: BrainTask, sink: BrainSink) => {
      const { engine } = w();
      engine.runner.attach(sink, task);
      try {
        for (const [name, input] of calls) {
          const r = await engine.runner.run(name, input);
          seen.push(r.result.kind === "text" ? r.result.text : r.result.kind === "error" ? `error: ${r.result.message}` : r.result.kind);
        }
        return { status: "done", summary: "done." };
      } finally {
        engine.runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
}

test("PERF-5 (audit repro): an acting result the model saw with a now: line is counted as observed by ledger --speed", async () => {
  let w!: World;
  const seen: string[] = [];
  w = world({ brain: scripted(() => w, [["mouse_move", { coordinate: [400, 300] }]], seen) });
  try {
    await w.engine.start();
    await w.engine.ready();
    await w.engine.wake("test");
    delegate(w, "move the pointer", "l1");
    await until(() => w.engine.snapshot().delegations.some((x) => x.liveId === "l1" && x.status !== "running"), 5000);
    await settle(100);
    const rows = w.engine.ledger.read(w.clock.t);
    assert.match(seen[0] ?? "", /(^|\n)now: /, "the model's result carries the observation line (Settings.observe on by default)");
    const report = analyzeSpeed(rows);
    assert.equal(report.observed.steps, 1);
    assert.equal(report.observed.withLine, report.observed.steps, `ledger --speed counts ${report.observed.withLine}/${report.observed.steps} acting results with a now: line`);
  } finally {
    await Promise.race([w.engine.stop(), settle(2000)]);
  }
});

test("PERF-5: each acting step is recorded once, as its call returned, and the now: line follows it as a note, whole however long the result", async () => {
  let w!: World;
  const seen: string[] = [];
  w = world({ brain: scripted(() => w, [["run_shell", { command: "printf '%0900d\\n' 0" }], ["mouse_move", { coordinate: [10, 20] }]], seen) });
  try {
    await w.engine.start();
    await w.engine.ready();
    await w.engine.wake("test");
    delegate(w, "print the zeros and move the pointer", "l2");
    await until(() => w.engine.snapshot().delegations.some((x) => x.liveId === "l2" && x.status !== "running"), 8000);
    await settle(100);
    assert.equal(seen.length, 2, seen.join(" | "));
    assert.ok((seen[0]?.length ?? 0) > 900, "the model read the whole output");
    assert.match(seen[0] ?? "", /\nnow: /);
    const all = (w.engine.ledger.read(w.clock.t) as LedgerRow[]).filter((r): r is Extract<LedgerRow, { type: "delegation.step" }> => r.type === "delegation.step").map((r) => r.step);
    const steps = all.filter((s) => s.tool !== undefined && s.tool.name !== "screenshot");
    assert.deepEqual(steps.map((s) => s.tool?.name), ["run_shell", "mouse_move"], "one step per call");
    const shell = steps[0]!;
    assert.equal(typeof shell.tool?.output, "string");
    const output = shell.tool!.output as string;
    assert.ok(output.length < 900, "the recorded output is cut as before");
    assert.doesNotMatch(output, /now: /, "the step is the result as it landed");
    const notes = all.filter((s) => s.kind === "note" && /^now:/.test(s.text ?? ""));
    assert.equal(notes.length, 2, "each acting call's now: line is a note");
    assert.ok(all.indexOf(notes[0]!) > all.indexOf(shell), "after the step it observed");
    assert.ok((seen[0] ?? "").endsWith(notes[0]!.text ?? "-"), "the line the model read, whole");
    const report = analyzeSpeed(w.engine.ledger.read(w.clock.t));
    assert.deepEqual([report.observed.withLine, report.observed.steps], [2, 2]);
  } finally {
    await Promise.race([w.engine.stop(), settle(2000)]);
  }
});

const T0 = Date.parse("2026-10-05T10:00:00.000Z");

function finished(id: string, at: number, steps: DelegationStep[], timings: Record<string, number>): LedgerRow[] {
  const d: Delegation = { id, liveId: `live_${id}`, createdAt: at, offsetMs: 0, request: "jarhead press return", status: "running", steps: [], timings: { delegatedAt: at } };
  return [
    { at, type: "delegation.created", delegation: d },
    ...steps.map((s): LedgerRow => ({ at: s.at, type: "delegation.step", delegationId: id, step: s })),
    { at: at + 5000, type: "delegation.finished", delegationId: id, status: "done", timings: { delegatedAt: at, doneAt: at + 5000, ...timings } },
  ];
}

const click = (at: number): DelegationStep => ({ id: `s_${at}`, at, kind: "tool", tool: { name: "key", input: {}, output: "OK", ok: true, ms: 40 } });

test("ledger --speed leaves a negative interval out of its figures and says how many: a speech end after the action, an action before the delegation", () => {
  const rows = [
    // Good: speech ended 600 ms before the delegation, the action 2 s after it.
    ...finished("good", T0, [click(T0 + 2000)], { firstActionAt: T0 + 2000, speechEndAt: T0 - 600 }),
    // PERF-6's skew: speech "ended" 3 s after the delegation, 1 s after the action.
    ...finished("skewed", T0 + 60_000, [click(T0 + 62_000)], { firstActionAt: T0 + 62_000, speechEndAt: T0 + 63_000 }),
    // An action stamped before its delegation (a clock that moved back).
    ...finished("early", T0 + 120_000, [click(T0 + 119_000)], { firstActionAt: T0 + 119_000, speechEndAt: T0 + 118_000 }),
  ];
  const r = analyzeSpeed(rows, ["2026-10-05"]);
  assert.deepEqual([r.speechToActionMs.n, r.speechToActionMs.min, r.speechToActionMs.median], [2, 1000, 1000], "the skewed one is out; the early one's speech-to-action stands");
  assert.ok(r.speechToActionMs.min >= 0);
  assert.deepEqual([r.firstActionMs.n, r.firstActionMs.min], [2, 2000], "the early one's delegation-to-action is out");
  assert.deepEqual(r.negative, { firstAction: 1, speechToAction: 1 });
  const line = renderSpeed(r).find((l) => l.includes("first action after delegation")) ?? "";
  assert.match(line, /left out: 1 negative after delegation, 1 negative after speech end/);
  const clean = renderSpeed(analyzeSpeed(rows.slice(0, 4)));
  assert.ok(!clean.some((l) => l.includes("negative")), "no note when nothing was left out");
});
