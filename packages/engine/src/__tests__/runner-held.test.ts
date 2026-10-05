/**
 * W1-9 through the real engine: a scripted keystroke held for Kevin's hands (the
 * ToolRunner reads `user_idle` before an applescript keystroke) is retried by the main
 * lane with no row on the timeline, as the helper's own busy refusal is. And Jarhead's
 * own scripted keystroke, which the helper counts as foreign input, does not hold the
 * next one.
 *
 * Safe by construction: the one script that runs is `return "keystroke"`, which says
 * the word the gates read and posts nothing. The hands are the world's fakes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { delegate, rows, settle, world } from "./world.ts";

/** Says keystroke, as the gates read it; returns a string, so nothing is typed. */
const KEYSTROKE_SCRIPT = 'return "keystroke"';

test("a held applescript keystroke on the main lane is retried quietly: no error step, no error row, one note saying how long the hands waited; its own keystroke holds nothing after it", async () => {
  const w = world();
  const { engine, hands, clock } = w;
  type StepRow = { type: "delegation.step"; step: { kind: string; text?: string } };
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead type it into notes for me", "item_1");
    await settle();
    assert.equal(w.brain.tasks.length, 1);

    hands.kevinActed();
    const pressing = engine.runner.run("applescript", { script: KEYSTROKE_SCRIPT });
    await settle(600);
    assert.ok(hands.named("user_idle").length >= 2, "held and read again meanwhile");
    clock.t += 1600; // Kevin stopped
    const out = await pressing;
    assert.equal(out.result.kind, "text", JSON.stringify(out.result));
    const steps = engine.snapshot().delegations[0]!.steps;
    assert.equal(steps.filter((s) => s.kind === "error").length, 0, "no busy rows on the timeline");
    assert.equal(steps.filter((s) => s.kind === "note" && /^waited \d+ ms for Kevin's hands$/.test(s.text ?? "")).length, 1, "one note for the wait");
    assert.equal(rows<StepRow>(w, "delegation.step").filter((r) => r.step.kind === "error").length, 0, "no error row in the ledger");

    // The helper counts System Events' keystroke as foreign input: the next scripted keystroke runs straight after it.
    hands.kevinActed(clock.t);
    clock.t += 200;
    const reads = hands.named("user_idle").length;
    const next = await engine.runner.run("applescript", { script: KEYSTROKE_SCRIPT });
    assert.equal(next.result.kind, "text", JSON.stringify(next.result));
    assert.equal(hands.named("user_idle").length, reads + 1, "read once, not held");
    const after = engine.snapshot().delegations[0]!.steps;
    assert.equal(after.filter((s) => s.kind === "note" && /waited/.test(s.text ?? "")).length, 1, "no second wait");
  } finally {
    await engine.stop();
  }
});
