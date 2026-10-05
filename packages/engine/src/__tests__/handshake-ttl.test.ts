import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_THREAD_ID, type Thread } from "@jarhead/protocol";
import type { BrainResult } from "@jarhead/brain";
import type { ToolResult } from "@jarhead/hands";
import { delegate, nextUtterance, settle, until, world, type World } from "./world.ts";

/**
 * W1-4 (launch triage 2026-10-05), TH-1's expired-yes half: the audit's TH-ORPHAN-TTL,
 * adopted. Slack asks "send?"; Kevin answers four minutes later, past the 3 min TTL.
 * Before, `arm()` answered nothing: the yes became a main-brain task and Slack sat in
 * waiting-kevin with nobody to ask it again. Now `arm()` answers `expired`, the
 * Delegator relays the yes to Slack, and Slack's tool asks its question again on the
 * same floor. Kevin's next yes lands the one click.
 */

const threadsOf = (w: World): readonly Thread[] => w.engine.threads.threads().filter((t) => t.id !== MAIN_THREAD_ID);
const named = (w: World, name: string): Thread | undefined => threadsOf(w).find((t) => t.name === name);

test("TH-1 (TH-ORPHAN-TTL): a yes four minutes after Slack asked re-asks Slack's question on its floor; it never becomes a main-brain task; the next yes sends once", async () => {
  const w = world();
  const { engine, hands } = w;
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  try {
    const results: ToolResult[] = [];
    w.threads.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      results.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
    };
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead tell ben on slack i'm late and play focus on spotify", "item_1");
    await settle();
    assert.equal(w.brain.tasks.length, 1, "the main brain holds the task");
    await engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
    await until(() => named(w, "Slack")?.status === "waiting-kevin");
    assert.equal(results.length, 1);

    // Four minutes pass. The root ConfirmationState runs on its own clock (engine.ts): move both.
    w.clock.t += 4 * 60_000;
    const realNow = Date.now;
    (engine.confirmations as unknown as { now: () => number }).now = () => realNow() + 4 * 60_000;
    tick();
    assert.equal(engine.threads.floorThread()?.name, "Slack", "an expired question still holds its floor");
    assert.equal(engine.desk.holds(named(w, "Slack")!.id), false, "but nothing answerable is held");

    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => results.length === 2);
    await settle(50);
    assert.equal(results[1]?.kind, "needs-confirmation", "Slack's tool asked again");
    assert.equal(named(w, "Slack")?.status, "waiting-kevin");
    assert.equal(engine.threads.floorThread()?.name, "Slack", "on Slack's floor");
    assert.equal(engine.desk.holds(named(w, "Slack")!.id), true);
    assert.equal(w.brain.tasks.length, 1, "the late yes did not become a main-brain task");
    assert.equal(hands.named("click").length, 0, "the late yes landed nothing");

    nextUtterance(w);
    delegate(w, "yes", "item_yes_2");
    await until(() => results.length === 3);
    await settle(50);
    assert.equal(results[2]?.kind, "text", "the fresh yes lands the click");
    assert.equal(hands.named("click").length, 1, "once");
  } finally {
    await engine.stop();
  }
});
