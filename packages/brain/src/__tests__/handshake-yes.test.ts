import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator } from "../delegator.ts";
import type { Brain, BrainResult, BrainTask } from "../brain.ts";

/**
 * W1-4 (launch triage 2026-10-05), RAIL-2 at the Delegator: the audit's rails R6, adopted.
 * The Delegator reads Kevin's last words with `YES_PATTERN`; a yes is the whole utterance,
 * so "Yeah, no, don't send it." no longer arms the pending Send. A plain yes still does.
 */

class FakeLive extends EventEmitter {
  sent: string[] = [];
  nowMs = 5000;
  appendThinking(): string { return "t"; }
  appendCommentary(_id: string | null, content: string): string { this.sent.push(content); return "c"; }
  appendInstructions(_id: string | null, content: string): string { this.sent.push(content); return "i"; }
}

function world(words: string): { confirmations: ConfirmationState; tasks: BrainTask[]; say: () => Promise<void> } {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const clock = 100_000;
  const confirmations = new ConfirmationState(3 * 60_000, () => clock);
  const tasks: BrainTask[] = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task): Promise<BrainResult> => {
      tasks.push(task);
      return { status: "done", summary: "done" };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, now: () => clock, commentaryCoalesceMs: 0 });
  confirmations.ask('click "Send" in Mail', "left_click", { coordinate: [500, 300] });
  return {
    confirmations,
    tasks,
    say: async () => {
      transcript.push({ speaker: "kevin", delta: words, startMs: 0, endMs: 900 });
      live.emit("delegation", "item_1", "client", 900);
      await new Promise((r) => setTimeout(r, 30));
    },
  };
}

test("RAIL-2 (rails R6): 'Yeah, no, don't send it.' does not arm the pending Send; the brain gets the words, not a yes", async () => {
  const w = world("Yeah, no, don't send it.");
  await w.say();
  assert.equal(w.tasks[0]?.confirmation, false, "not a confirmation turn");
  assert.equal(w.confirmations.consume("left_click", { coordinate: [500, 300] }), false, "the Send is not armed");
});

test("RAIL-2: 'Yes, go ahead.' still arms the pending Send for that click, once", async () => {
  const w = world("Yes, go ahead.");
  await w.say();
  assert.equal(w.tasks[0]?.confirmation, true);
  assert.equal(w.confirmations.consume("left_click", { coordinate: [500, 300] }), true);
  assert.equal(w.confirmations.consume("left_click", { coordinate: [500, 300] }), false, "spent");
});
