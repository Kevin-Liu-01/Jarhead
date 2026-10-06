import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator } from "../delegator.ts";
import { parseReflex, type Reflex, type ReflexOutcome } from "../reflex.ts";
import type { Brain, BrainSink } from "../brain.ts";

/**
 * W3-1 review, PERF-6: a prefired reflex keeps the speech end it fired on. The engine stamps an utterance at each
 * input delta, and a delta that arrives after the prefire (the transcriber's closing period, within the utterance gap)
 * joins the same item and moves its stamp. The delegation that adopts the prefire's record used to read that later
 * stamp, so its speechEndAt came after its own delegatedAt and both intervals went negative. Fake Live, a fake wall
 * clock for the stamps; the quiet windows are short real time.
 */

class FakeLive extends EventEmitter {
  nowMs = 0;
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

const idleBrain: Brain = {
  kind: "fake",
  start: async () => ({ ready: true, detail: "" }),
  handle: async () => ({ status: "done", summary: "done." }),
  cancel: async () => undefined,
  stop: async () => undefined,
};

async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

test("PERF-6 (review): a delegation that adopts a prefire keeps the speech end the prefire fired on, never later than its delegatedAt, though a later delta moved the utterance's stamp", async () => {
  const clock = { t: 1_000_000 };
  const stamps = new Map<string, number>();
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const ran: string[] = [];
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome> => {
      ran.push(reflex.label);
      sink?.step({ kind: "tool", tool: { name: reflex.tool, input: reflex.input, ok: true, ms: 8 } });
      return { reflex, result: { kind: "text", text: "OK" }, ms: 8, ok: true };
    },
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: idleBrain, confirmations: new ConfirmationState(), reflexes, now: () => clock.t, speechEndAt: (item) => stamps.get(item.id), prefireQuietMs: 10, prefireLongQuietMs: 20, commentaryCoalesceMs: 0 });
  // As the engine does: the delegator hears the delta, the transcript takes it, the engine stamps the item.
  const say = (delta: string, s: number, e: number): void => {
    live.emit("inputTranscript", delta, s, e);
    const item = transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
    stamps.set(item.id, clock.t);
  };
  try {
    say("jarhead scroll down", 0, 800);
    const spoke = clock.t;
    clock.t += 300; // the quiet window, on the wall clock
    assert.ok(await until(() => ran.length === 1), "the reflex prefired");
    const early = d.all()[0]!;
    assert.equal(early.timings.delegatedAt, spoke + 300);
    assert.equal(early.timings.speechEndAt, spoke, "the prefire's record carries the speech end it fired on");
    // The transcriber's closing period lands 200 ms after the prefire: the same utterance, its stamp moved on.
    clock.t += 200;
    say(".", 800, 850);
    assert.equal(transcript.last("kevin")?.id, early.liveId.replace(/^prefire:/, ""), "the period joined the prefire's utterance");
    clock.t += 400;
    live.nowMs = 900;
    live.emit("delegation", "item_1", "client", 900);
    assert.ok(await until(() => d.all()[0]?.status === "done"));
    const adopted = d.all()[0]!;
    assert.equal(adopted.id, early.id, "the delegation adopted the prefire's record");
    assert.equal(ran.length, 1, "not run twice");
    assert.equal(adopted.timings.speechEndAt, spoke, "the speech end the prefire fired on, not the period's stamp");
    assert.ok(adopted.timings.speechEndAt! <= adopted.timings.delegatedAt, "never after the delegation");
    const firstAction = (adopted.timings as { firstActionAt?: number }).firstActionAt;
    assert.ok(firstAction !== undefined && firstAction >= adopted.timings.speechEndAt!, "speech end → first action is not negative");
  } finally {
    d.dispose();
  }
});
