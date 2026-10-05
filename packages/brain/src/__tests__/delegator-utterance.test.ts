import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { MAIN_THREAD_ID } from "@jarhead/protocol";
import { GAP_MS } from "../../../live/src/transcript.ts";
import { Delegator, UTTERANCE_GAP_MS, type DelegatorThreads, type ThreadFloor } from "../delegator.ts";
import type { Brain, BrainResult, BrainSink, BrainTask } from "../brain.ts";

/**
 * W1-3, the Delegator alone (the engine-level reproductions are in
 * packages/engine/src/__tests__/delegator-utterance.test.ts):
 *
 * - V2: a spoken stop is judged on the utterance its fragment belongs to, never glued onto the
 *   request before it, and never on the words Live already delegated.
 * - V1: dispose() (the session is gone) cuts what that session's delegator still runs or drains.
 * - TH-1: a new request drops only the main brain's pending question, never a thread's.
 * - PERF-7: an aside answered from the table goes to Live at once, past the commentary coalescer.
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

/** A brain that holds every task until its signal aborts (or the test resolves it), and counts its cancels. */
function holdingBrain(): Brain & { cancels: number; tasks: BrainTask[]; sinks: BrainSink[]; resolve: ((r: BrainResult) => void)[] } {
  const b = {
    kind: "fake",
    cancels: 0,
    tasks: [] as BrainTask[],
    sinks: [] as BrainSink[],
    resolve: [] as ((r: BrainResult) => void)[],
    start: async () => ({ ready: true, detail: "" }),
    handle: (task: BrainTask, sink: BrainSink) =>
      new Promise<BrainResult>((resolve) => {
        b.tasks.push(task);
        b.sinks.push(sink);
        b.resolve.push(resolve);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      b.cancels++;
    },
    stop: async () => undefined,
  };
  return b;
}

class FakeThreads implements DelegatorThreads {
  names: string[] = [];
  floor: ThreadFloor | undefined;
  alive = new Map<string, number>();
  resumed: string[] = [];
  drains: { id: string; aborted: boolean }[] = [];
  liveNames(): readonly string[] {
    return this.names;
  }
  byNameLive(name: string): { readonly id: string; readonly name: string } | undefined {
    const n = this.names.find((x) => x.toLowerCase() === name.toLowerCase());
    return n ? { id: `t_${n.toLowerCase()}`, name: n } : undefined;
  }
  statusLine(name?: string): string {
    return name ? `${name} is playing Focus` : `${this.names.join(" and ")} are working`;
  }
  async followUp(): Promise<boolean> {
    return true;
  }
  async stopNamed(): Promise<boolean> {
    return true;
  }
  floorThread(): ThreadFloor | undefined {
    return this.floor;
  }
  drain(id: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { id, aborted: false };
      this.drains.push(entry);
      signal.addEventListener("abort", () => {
        entry.aborted = true;
        resolve();
      }, { once: true });
    });
  }
  running(id?: string): number {
    if (id !== undefined) return this.alive.get(id) ?? 0;
    let n = 0;
    for (const v of this.alive.values()) n += v;
    return n;
  }
  async resume(threadId: string): Promise<void> {
    this.resumed.push(threadId);
  }
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Kevin is heard as the engine hears him: the delegator's listener first, then the fragment goes on the transcript. */
function hear(live: FakeLive, transcript: Transcript, delta: string, startMs: number, endMs: number): void {
  live.nowMs = endMs;
  live.emit("inputTranscript", delta, startMs, endMs);
  transcript.push({ speaker: "kevin", delta, startMs, endMs });
}

function setup(): { live: FakeLive; transcript: Transcript; brain: ReturnType<typeof holdingBrain>; stops: string[]; d: Delegator } {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const brain = holdingBrain();
  const stops: string[] = [];
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => ++clock, commentaryCoalesceMs: 0, onStop: (r) => void stops.push(r) });
  return { live, transcript, brain, stops, d };
}

test("V2: the delegator's merge gap is the transcript's", () => {
  assert.equal(UTTERANCE_GAP_MS, GAP_MS);
});

test("V2: words after a request that began with a stop word are judged on their own utterance; the request's words are never read again as a stop", async () => {
  for (const [request, next] of [
    ["cancel my three pm meeting", " thanks"],
    ["hold on to that file for me", " please"],
    ["stop the timer", " and start a new one"],
  ] as const) {
    for (const gapMs of [GAP_MS + 1, GAP_MS, 300]) {
      const { live, transcript, brain, stops, d } = setup();
      hear(live, transcript, request, 0, 1200);
      live.emit("delegation", "item_1", "client", 1200);
      await tick();
      assert.equal(brain.tasks.length, 1);
      hear(live, transcript, next, 1200 + gapMs, 1600 + gapMs);
      await tick(0);
      assert.deepEqual(stops, [], `"${request}" then "${next.trim()}" ${gapMs} ms later is no stop`);
      assert.equal(brain.tasks[0]!.signal.aborted, false);
      d.dispose();
    }
  }
});

test("V2: a stop word in the utterance a fragment belongs to still stops: a new utterance, a stop word split across fragments, one added to the request's own utterance, and the transcript lagging the delegation", async () => {
  // A new utterance that is a stop.
  {
    const { live, transcript, stops, d } = setup();
    hear(live, transcript, "cancel my three pm meeting", 0, 1200);
    live.emit("delegation", "item_1", "client", 1200);
    await tick();
    hear(live, transcript, " stop", 4000, 4300);
    await tick(0);
    assert.deepEqual(stops, ["Kevin said stop"]);
    d.dispose();
  }
  // "never" … "mind" in two fragments of one new utterance: the open utterance plus the fragment.
  {
    const { live, transcript, stops, d } = setup();
    hear(live, transcript, "open the budget", 0, 1200);
    live.emit("delegation", "item_1", "client", 1200);
    await tick();
    hear(live, transcript, " never", 4000, 4200);
    await tick(0);
    assert.deepEqual(stops, []);
    hear(live, transcript, " mind", 4300, 4500);
    await tick(0);
    assert.deepEqual(stops, ["Kevin said stop"]);
    d.dispose();
  }
  // A stop word after the delegated words, inside the merge gap: the new words carry it.
  {
    const { live, transcript, stops, d } = setup();
    hear(live, transcript, "open the budget", 0, 1200);
    live.emit("delegation", "item_1", "client", 1200);
    await tick();
    hear(live, transcript, " stop", 1500, 1800);
    await tick(0);
    assert.deepEqual(stops, ["Kevin said stop"]);
    d.dispose();
  }
  // The transcript lagged the delegation ("cancel my" delegated, "three pm meeting" after): no stop.
  {
    const { live, transcript, stops, brain, d } = setup();
    hear(live, transcript, "cancel my", 0, 600);
    live.emit("delegation", "item_1", "client", 600);
    await tick();
    hear(live, transcript, " three pm meeting", 700, 1300);
    await tick(0);
    assert.deepEqual(stops, [], "the rest of the delegated utterance is not a stop on it");
    assert.equal(brain.tasks[0]!.signal.aborted, false);
    d.dispose();
  }
  // Jarhead spoke in between: Kevin's next words are a new utterance even inside the gap.
  {
    const { live, transcript, stops, d } = setup();
    transcript.push({ speaker: "kevin", delta: "check my mail", startMs: 0, endMs: 900 });
    live.emit("delegation", "item_1", "client", 900);
    await tick();
    transcript.push({ speaker: "kevin", delta: " cancel", startMs: 950, endMs: 1100 });
    transcript.push({ speaker: "jarhead", delta: "On it.", startMs: 1150, endMs: 1500 });
    hear(live, transcript, " thanks", 1600, 1900);
    await tick(0);
    assert.deepEqual(stops, [], "the earlier utterance's stop word does not glue onto the new one");
    d.dispose();
  }
});

test("V1: dispose() cuts what its session left: the running turn aborted and the brain's cancel sent, a draining delegation's wait ended, both records cancelled; quiet, no phase, and a late result changes nothing", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const brain = holdingBrain();
  const threads = new FakeThreads();
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => ++clock, commentaryCoalesceMs: 0 });
  // A first request whose brain finishes with a thread still at work: it drains.
  hear(live, transcript, "play focus on spotify", 0, 900);
  live.emit("delegation", "item_1", "client", 900);
  await tick();
  const parent = d.all()[0]!.id;
  threads.alive.set(parent, 1);
  threads.names = ["Spotify"];
  brain.resolve[0]!({ status: "done", summary: "Spotify alongside." });
  await tick();
  assert.equal(d.draining?.id, parent);
  // A second request runs on the brain.
  hear(live, transcript, " send the quarterly report to ben", 4000, 5000);
  live.emit("delegation", "item_2", "client", 5000);
  await tick();
  assert.equal(brain.tasks.length, 2);
  const turn = brain.tasks[1]!;
  const phases: string[] = [];
  const cancelled: string[] = [];
  d.on("phase", (p) => phases.push(p));
  d.on("cancelled", (r) => cancelled.push(r));
  const sentBefore = live.sent.length;

  // The session is gone (the server dropped it): the engine detaches and disposes this delegator.
  d.dispose();
  assert.equal(turn.signal.aborted, true, "the running turn is aborted");
  assert.equal(d.active, undefined, "nothing running, nothing draining");
  assert.equal(d.draining, undefined);
  assert.equal(threads.drains[0]!.aborted, true, "the draining wait ended (its threads are the scheduler's)");
  await tick();
  assert.equal(brain.cancels, 1, "the brain's cancel was sent once (turn/interrupt for Codex)");
  for (const rec of d.all()) {
    assert.equal(rec.status, "cancelled", rec.request);
    assert.equal(rec.summary, "the voice session ended");
  }
  assert.deepEqual(phases, [], "the engine owns the phase across a detach");
  assert.deepEqual(cancelled, []);
  assert.equal(live.sent.length, sentBefore, "nothing is said to a voice that is gone");

  // The brain lets go late, with a result: nothing changes, nothing is said.
  brain.resolve[1]!({ status: "done", summary: "Sent." });
  await tick();
  assert.equal(d.all()[1]!.status, "cancelled");
  assert.equal(live.sent.length, sentBefore);

  // A dispose with nothing running sends no cancel.
  const idle = setup();
  idle.d.dispose();
  await tick();
  assert.equal(idle.brain.cancels, 0);
});

test("TH-1: a new request drops the main brain's pending question, never a spawned thread's: Slack's question stays on the floor and Kevin's later yes reaches it", async () => {
  for (const [floor, survives] of [
    [{ id: "t_slack", name: "Slack" }, true],
    [{ id: MAIN_THREAD_ID, name: "Jarhead" }, false],
    [undefined, false],
  ] as const) {
    const live = new FakeLive();
    const transcript = new Transcript(() => 0);
    const brain = holdingBrain();
    const threads = new FakeThreads();
    const confirmations = new ConfirmationState();
    let clock = 100_000;
    const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, threads, now: () => ++clock, commentaryCoalesceMs: 0 });
    hear(live, transcript, "tell ben on slack i'm late", 0, 900);
    live.emit("delegation", "item_1", "client", 900);
    await tick();
    confirmations.ask("left click on \"Send\" in Slack", "click_element", { name: "Send" });
    threads.floor = floor;
    // Kevin asks for something else before he answers.
    hear(live, transcript, " what is in my notes", 4000, 4900);
    live.emit("delegation", "item_2", "client", 4900);
    await tick();
    assert.equal(confirmations.pending !== undefined, survives, `${floor?.name ?? "a free floor"}: the question ${survives ? "survives" : "is dropped"}`);
    if (survives) {
      hear(live, transcript, " yes", 8000, 8300);
      live.emit("delegation", "item_yes", "client", 8300);
      await tick();
      assert.deepEqual(threads.resumed, ["t_slack"], "the yes reached Slack");
      assert.equal(brain.tasks.length, 2, "the yes was not a brain task");
      assert.equal(confirmations.consume("click_element", { name: "Send" }), true, "the yes was armed for Slack's exact action");
    }
    d.dispose();
  }
});

test("PERF-7: a status answered from the table goes to Live at once, even inside the commentary coalescer's window", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const brain = holdingBrain();
  const threads = new FakeThreads();
  threads.names = ["Slack", "Spotify"];
  const clock = 100_000; // a still clock: every line falls inside the 600 ms window
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => clock, commentaryCoalesceMs: 600 });
  hear(live, transcript, "tell ben on slack and play focus on spotify", 0, 1500);
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  brain.sinks[0]!.commentary("Slack and Spotify alongside.");
  brain.sinks[0]!.commentary("Ben first.");
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.content);
  assert.deepEqual(spoken(), ["Slack and Spotify alongside."], "the second line is held in the window");

  hear(live, transcript, " what is spotify doing", 4000, 4900);
  live.emit("delegation", "item_2", "client", 4900);
  await tick();
  assert.deepEqual(spoken(), ["Slack and Spotify alongside.", "Spotify is playing Focus"], "the answer went at once; the held line waits its turn");
  assert.equal(live.sent.at(-1)!.id, "item_2", "on the aside's own delegation id");
  assert.equal(brain.tasks.length, 1, "the table answered: no brain turn");
  await tick(650);
  assert.deepEqual(spoken(), ["Slack and Spotify alongside.", "Spotify is playing Focus", "Ben first."], "the held line still lands when its window closes");

  // The ear's answer reaches the delegator as Jarhead's own line on the delegation under way: at once too.
  // A spawned thread's line still coalesces.
  const parent = d.active!.id;
  d.threadSay(parent, "Spotify", "Spotify: playing Focus.");
  d.threadSay(parent, "Jarhead", "Slack is sending the message");
  assert.deepEqual(spoken().slice(3), ["Slack is sending the message"], "Jarhead's aside went at once; Spotify's line waits in the window");
  assert.equal(live.sent.at(-1)!.id, "item_1", "on the delegation under way");
  await tick(650);
  assert.deepEqual(spoken().slice(3), ["Slack is sending the message", "Spotify: playing Focus."]);
  d.dispose();
});
