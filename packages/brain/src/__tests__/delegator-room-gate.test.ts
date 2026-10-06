import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import type { TranscriptItem } from "@jarhead/protocol";
import { Delegator } from "../delegator.ts";
import type { Brain, BrainResult, BrainTask } from "../brain.ts";

/**
 * The room-talk gate at the Delegator (LC-7, 2026-10-06): GPT-Live-1 delegates what it hears on its own, the room's
 * commands included. The engine's verdict comes first in `onDelegation`: a delegation for words nobody said to Jarhead
 * is recorded, refused and closed with one silent thinking append, and nothing reaches the brain, the sleep cue or a
 * running task; one that waits on a late name runs when the name lands, with the whole request read again; room lines
 * are left out of an addressed request.
 */

class FakeLive extends EventEmitter {
  sent: { type: string; id: string | null; content: string }[] = [];
  nowMs = 5000;
  appendThinking(id: string | null, content: string): string {
    this.sent.push({ type: "thinking", id, content });
    return "t";
  }
  appendCommentary(id: string | null, content: string): string {
    this.sent.push({ type: "commentary", id, content });
    return "c";
  }
  appendInstructions(id: string | null, content: string): string {
    this.sent.push({ type: "instructions", id, content });
    return "i";
  }
}

function brainOf(): Brain & { tasks: BrainTask[] } {
  const b = {
    kind: "fake",
    tasks: [] as BrainTask[],
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task: BrainTask): Promise<BrainResult> => {
      b.tasks.push(task);
      return { status: "done", summary: "done." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  return b;
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hear(live: FakeLive, transcript: Transcript, delta: string, startMs: number, endMs: number): TranscriptItem {
  live.nowMs = endMs;
  live.emit("inputTranscript", delta, startMs, endMs);
  return transcript.push({ speaker: "kevin", delta, startMs, endMs });
}

function setup(verdicts: Map<string, boolean>, judge?: (liveId: string, item: TranscriptItem | undefined) => boolean | Promise<boolean>) {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const brain = brainOf();
  const sleeps: string[] = [];
  let clock = 100_000;
  const d = new Delegator({
    live: live as unknown as LiveSession,
    transcript,
    brain,
    confirmations: new ConfirmationState(),
    now: () => ++clock,
    commentaryCoalesceMs: 0,
    onSleep: (phrase) => void sleeps.push(phrase),
    addressed: (item) => verdicts.get(item.text) ?? false,
    delegationAddressed: judge ?? ((_id, item) => (item ? (verdicts.get(item.text) ?? false) : false)),
  });
  return { live, transcript, brain, sleeps, d };
}

test("a delegation for room talk is recorded, refused and closed silently: no brain, no sleep cue, no words asked of the voice", async () => {
  const { live, transcript, brain, sleeps, d } = setup(new Map());
  hear(live, transcript, " okay I'm heading out, goodnight", 0, 1800);
  live.emit("delegation", "item_room", "client", 1800);
  await tick();
  assert.equal(brain.tasks.length, 0, "the room reached the brain");
  assert.deepEqual(sleeps, [], "a goodnight to someone else slept it");
  const rec = d.all().find((x) => x.liveId === "item_room");
  assert.deepEqual([rec?.status, rec?.summary], ["cancelled", "not addressed: room talk, heard and not run"]);
  assert.deepEqual(live.sent.map((s) => [s.type, s.id]), [["thinking", "item_room"]], "one silent note on its id, nothing that asks for words");
});

test("a delegation waiting on a late name runs when it lands, with the request read again; room lines before it are left out", async () => {
  const verdicts = new Map<string, boolean>([["what's on my screen, jarhead", true]]);
  let settle!: (ok: boolean) => void;
  const { live, transcript, brain, d } = setup(verdicts, (_id, item) => (item && verdicts.get(item.text) ? true : new Promise<boolean>((r) => (settle = r))));
  hear(live, transcript, " and the market moved", 0, 1500);
  live.emit("outputTranscript", " mm.", 1600, 1700);
  transcript.push({ speaker: "jarhead", delta: " mm.", startMs: 1600, endMs: 1700 });
  hear(live, transcript, " what's on my screen,", 4000, 5000);
  live.emit("delegation", "item_late", "client", 5000);
  await tick();
  assert.equal(brain.tasks.length, 0, "it waits for the name");
  // The name lands on the same item; the engine's verdict settles.
  hear(live, transcript, " jarhead", 5000, 5400);
  settle(true);
  await tick();
  assert.equal(brain.tasks.length, 1);
  assert.equal(brain.tasks[0]!.request, "what's on my screen, jarhead", "the room's line is not part of the request; the late name is");
  assert.equal(d.all().find((x) => x.liveId === "item_late")?.status, "done");
});

test("without the gate's options every delegation runs as before (a voice that is not always on, the brain's own tests)", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const brain = brainOf();
  new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => 1, commentaryCoalesceMs: 0 });
  hear(live, transcript, " scroll down a bit", 0, 900);
  live.emit("delegation", "item_any", "client", 900);
  await tick();
  assert.equal(brain.tasks.length, 1);
});
