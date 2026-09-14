import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator } from "../delegator.ts";
import type { Brain, BrainResult } from "../brain.ts";

/**
 * The delegator's two newer stamps, judged without an engine: `speechEndAt` from
 * the transcript item the delegation was made on and the session's start clock;
 * `firstActionAt` from the first acting step that returned ok — a look-only tool,
 * a failed click and a `needs-confirmation` do not stamp it, an AppleScript or a
 * browser action does.
 */

class FakeLive extends EventEmitter {
  nowMs = 5000;
  appendThinking(): string {
    return "t";
  }
  appendCommentary(): string {
    return "c";
  }
  appendInstructions(): string {
    return "i";
  }
}

function harness(steps: (sink: Parameters<Brain["handle"]>[1], tick: () => number) => void, sessionStartedAt: number | undefined): { live: FakeLive; transcript: Transcript; delegator: Delegator; clock: { t: number } } {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const clock = { t: 100_000 };
  const tick = (): number => (clock.t += 50);
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (_task, sink): Promise<BrainResult> => {
      steps(sink, tick);
      return { status: "done", summary: "done." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const delegator = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => clock.t, commentaryCoalesceMs: 0, ...(sessionStartedAt !== undefined ? { sessionStartedAt: () => sessionStartedAt } : {}) });
  return { live, transcript, delegator, clock };
}

test("delegator timings: firstActionAt is the first acting step that returned ok — not a look, not a failed click, not a confirmation question", async () => {
  const marks: Record<string, number> = {};
  const { live, transcript, delegator } = harness((sink, tick) => {
    marks["look"] = tick();
    sink.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 3 } });
    marks["failedClick"] = tick();
    sink.step({ kind: "error", text: "no control named Save", tool: { name: "click_element", input: { name: "Save" }, ok: false, ms: 4 } });
    marks["question"] = tick();
    sink.step({ kind: "confirm", text: "About to click Send", tool: { name: "left_click", input: { coordinate: [1, 2] }, ok: true, ms: 2 } });
    marks["script"] = tick();
    sink.step({ kind: "tool", tool: { name: "applescript", input: { script: "tell application \"Safari\" to activate" }, ok: true, ms: 40 } });
    marks["type"] = tick();
    sink.step({ kind: "tool", tool: { name: "type", input: { text: "hello" }, ok: true, ms: 12 } });
  }, 90_000);
  transcript.push({ speaker: "kevin", delta: "jarhead click save and type hello", startMs: 1000, endMs: 2200 });
  live.emit("delegation", "item_1", "client", 2600);
  await new Promise((r) => setTimeout(r, 30));
  const d = delegator.all()[0];
  assert.ok(d);
  assert.equal(d.status, "awaiting-confirmation", "the confirm step keeps the handshake's status");
  assert.equal(d.timings.firstActionAt, marks["script"], "the AppleScript is the first action that went through");
  assert.equal((d.timings as { firstToolAt?: number }).firstToolAt, marks["look"], "the first tool is the look");
  assert.equal(d.timings.speechEndAt, 90_000 + 2200, "session start + the utterance's endMs");
});

test("delegator timings: speechEndAt takes the last utterance that ended before the delegation; without a session start clock it is absent; a failed action alone stamps nothing", async () => {
  const { live, transcript, delegator } = harness((sink, tick) => {
    tick();
    sink.step({ kind: "error", text: "type needs text", tool: { name: "type", input: {}, ok: false, ms: 0 } });
  }, 500_000);
  transcript.push({ speaker: "kevin", delta: "what a nice day", startMs: 0, endMs: 800 });
  transcript.push({ speaker: "kevin", delta: " jarhead type something", startMs: 3000, endMs: 4100 });
  // Live delegates at 4400: the request carries both utterances, the speech end is the second's.
  live.emit("delegation", "item_2", "client", 4400);
  await new Promise((r) => setTimeout(r, 30));
  const d = delegator.all()[0];
  assert.ok(d);
  assert.equal(d.request, "what a nice day jarhead type something");
  assert.equal(d.timings.speechEndAt, 500_000 + 4100);
  assert.equal(d.timings.firstActionAt, undefined, "a type that did nothing is not an action");

  const bare = harness(() => undefined, undefined);
  bare.transcript.push({ speaker: "kevin", delta: "jarhead hello", startMs: 0, endMs: 700 });
  bare.live.emit("delegation", "item_3", "client", 900);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bare.delegator.all()[0]?.timings.speechEndAt, undefined, "no session clock, no wall-clock speech end");
});

test("delegator timings: the overlays Kevin sees act — a show_circle that drew stamps firstActionAt, after a look that did not", async () => {
  const marks: Record<string, number> = {};
  const { live, transcript, delegator } = harness((sink, tick) => {
    marks["look"] = tick();
    sink.step({ kind: "tool", tool: { name: "find_element", input: { name: "Slack" }, ok: true, ms: 3 } });
    marks["circle"] = tick();
    sink.step({ kind: "tool", tool: { name: "show_circle", input: { x: 120, y: 700, radius: 40 }, ok: true, ms: 9 } });
  }, 90_000);
  transcript.push({ speaker: "kevin", delta: "jarhead circle where slack is", startMs: 1000, endMs: 2200 });
  live.emit("delegation", "item_9", "client", 2600);
  await new Promise((r) => setTimeout(r, 30));
  const d = delegator.all()[0];
  assert.ok(d);
  assert.equal(d.timings.firstActionAt, marks["circle"], "the circle Kevin sees is the first visible action (the analysts' BEFORE counted overlays the same way)");
  assert.equal((d.timings as { firstToolAt?: number }).firstToolAt, marks["look"]);
});
