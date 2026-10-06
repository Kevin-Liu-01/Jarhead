import { test } from "node:test";
import assert from "node:assert/strict";
import { delegate, settle, until, world } from "./world.ts";

/**
 * ScreenCaptureKit runs in one helper process (CAPTURE_OPS). Measured 2026-10-06 with the Mac locked, at
 * 684b282, 0d673ce and c7d4e63 alike: the wake shot on the reading helper answered, then the eyes' shot on
 * the acting helper never did. Both helpers start from one executable path, and two capturing processes
 * from one path set replayd's connections interrupting each other. The second capture's callback never
 * came, and its serial queue held every op behind it (the brain's screenshots, `move`, the ear's `cursor`,
 * `browser_url`) until the process was restarted; the reading helper's next capture hung too. With one
 * capturing process the same sequence answers every time.
 */

const captures = (ops: readonly { op: string }[]): string[] => ops.filter((o) => o.op === "screenshot" || o.op === "zoom").map((o) => o.op);

test("the wake shot, the delegation's eyes shot and a zoom are all taken by the acting helper's process; the reading helper never captures", async () => {
  const w = world();
  const { engine, hands, handsBg, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // The wake shot, as the daemon takes it at every wake with a brain that takes images.
    assert.ok(await until(() => captures(hands.ops).length + captures(handsBg.ops).length >= 1), "the wake shot was asked");
    assert.deepEqual(captures(hands.ops), ["screenshot"], "the wake shot warms the one capturing process, the acting helper");
    // A delegation: its eyes' shot is the first thing it does, before the brain gets the task.
    delegate(w, "what is on my screen", "item_1");
    assert.ok(await until(() => brain.tasks.length === 1), "the brain got the task");
    // The model's own zoom through the main toolset (SplitHands routed it to the reading helper before).
    await engine.toolset.run("zoom", { region: [0, 0, 100, 100] });
    await settle();
    assert.deepEqual(captures(handsBg.ops), [], "the reading helper never captures");
    assert.deepEqual(captures(hands.ops), ["screenshot", "screenshot", "zoom"], "the wake shot, the eyes' shot and the zoom, all on the acting helper");
  } finally {
    await engine.stop();
  }
});
