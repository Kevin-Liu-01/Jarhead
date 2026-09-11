import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator, type DelegationTimingsExtra } from "../delegator.ts";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "../brain.ts";

/**
 * The delegator's latency work: the eyes' pre-warm shot rides as the first
 * attachment without counting as the brain's first tool; commentary bursts are
 * coalesced into one append but the first line of a quiet moment goes at once
 * and the finish flushes; a cancel drops what was held.
 */

class FakeLive extends EventEmitter {
  sent: { type: string; payload: { id: string | null; content: string } }[] = [];
  nowMs = 5000;
  appendThinking(id: string | null, content: string): string { this.sent.push({ type: "thinking", payload: { id, content } }); return "t"; }
  appendCommentary(id: string | null, content: string): string { this.sent.push({ type: "commentary", payload: { id, content } }); return "c"; }
  appendInstructions(id: string | null, content: string): string { this.sent.push({ type: "instructions", payload: { id, content } }); return "i"; }
}

test("delegator: the eyes' shot is the first attachment and never the brain's first tool; commentary is coalesced, first line at once, flushed on finish, dropped on cancel", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  let hold: ((r: BrainResult) => void) | undefined;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task, sink) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        hold = resolve;
        sink.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 18 } });
        sink.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
        sink.commentary("Opening the file.");
        sink.commentary("It is a spreadsheet.");
        sink.commentary("Three tabs.");
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  let clock = 100_000;
  const eyesCalls: number[] = [];
  const eyes = async (sink: BrainSink): Promise<BrainAttachment | undefined> => {
    eyesCalls.push(clock);
    // The engine's runner records the shot in the delegation while the sink is attached.
    sink.step({ kind: "tool", tool: { name: "screenshot", input: { quick: true }, ok: true, ms: 61 }, screenshotPath: "shots/x.png" });
    clock += 61;
    return { path: "/shots/x.png", mediaType: "image/png", note: "the screen right now", kind: "screen" };
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), eyes, now: () => clock, commentaryCoalesceMs: 600 });

  transcript.push({ speaker: "kevin", delta: "open the budget", startMs: 0, endMs: 900 });
  live.emit("delegation", "item_1", "client", 900);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 1);
  assert.equal(eyesCalls.length, 1, "one shot per delegation");
  assert.deepEqual(seen[0]!.attachments?.map((a) => a.kind), ["screen"], "the screen rides as the first attachment");
  const running = d.all()[0]!;
  assert.deepEqual(running.steps.map((s) => `${s.kind}:${s.tool?.name ?? ""}`), ["tool:screenshot", "tool:frontmost_app", "tool:left_click", "commentary:", "commentary:", "commentary:"]);
  const t = running.timings as DelegationTimingsExtra;
  assert.equal(t.eyesMs, 61);
  assert.equal(t.firstToolAt, running.steps[1]!.at, "the brain's frontmost_app is the first tool, not the eyes' shot");
  assert.equal(t.firstActionAt, running.steps[2]!.at, "the click is the first action");
  assert.deepEqual(t.toolRoundTripMs, [18, 7], "the eyes' round trip is kept apart (eyesMs)");

  // Commentary: the first line went out at once; the two that followed within the window are held.
  assert.deepEqual(live.sent.map((s) => s.payload.content), ["Opening the file."]);
  hold!({ status: "done", summary: "Three tabs." });
  await new Promise((r) => setTimeout(r, 20));
  // finish() flushed the held lines as one append; the summary was already spoken (last commentary), so nothing more.
  assert.deepEqual(live.sent.map((s) => s.payload.content), ["Opening the file.", "It is a spreadsheet. Three tabs."]);
  assert.equal(d.all()[0]!.status, "done");

  // A cancel drops held commentary: nothing more is said after "stop".
  live.sent.length = 0;
  clock += 10_000;
  live.nowMs = 3000;
  transcript.push({ speaker: "kevin", delta: " open the other one", startMs: 2500, endMs: 3000 });
  live.emit("delegation", "item_2", "client", 3000);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Opening the file."]);
  await d.cancel("Kevin pressed stop");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Opening the file."], "the held lines were dropped");
  assert.equal(d.all()[1]!.status, "cancelled");
  assert.equal(d.all()[1]!.summary, "Kevin pressed stop");
  assert.ok(live.sent.some((s) => s.type === "instructions" && /cancelled/.test(s.payload.content)));
  d.dispose();
});
