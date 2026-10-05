import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { MAIN_THREAD_ID } from "@jarhead/protocol";
import { GAP_MS } from "../../../live/src/transcript.ts";
import { Delegator, REFUSAL_HEAD, REFUSAL_PATTERN, UTTERANCE_GAP_MS, type DelegatorThreads, type ThreadFloor } from "../delegator.ts";
import type { Brain, BrainResult, BrainSink, BrainTask } from "../brain.ts";
import { parseReflex, type Reflex, type ReflexOutcome } from "../reflex.ts";

/**
 * W1-3, the Delegator alone (the engine-level reproductions are in
 * packages/engine/src/__tests__/delegator-utterance.test.ts):
 *
 * - V2: a spoken stop is judged on the utterance its fragment belongs to, never glued onto the
 *   request before it, and never on the words Live already delegated. Live's leading punctuation
 *   and the name ("…. Never mind", "Jarhead, stop.") do not hide it.
 * - V1: dispose() (the session is gone) cuts the turn that session's delegator still runs. A
 *   draining delegation closes with its brain's own result (its threads carry on), and a reflex
 *   that ran ahead closes once it settles.
 * - TH-1: a new request drops only the main brain's pending question, never a thread's. After
 *   Kevin moved on, his next yes asks the thread's question again first. His no to a thread's
 *   question stops that thread, so no later yes can land the action he refused.
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
  stopped: string[] = [];
  /** What a stop by name does (the scheduler's: the thread ends and its question leaves the desk); true by default. */
  onStopNamed: ((name: string) => boolean) | undefined;
  async stopNamed(name: string): Promise<boolean> {
    this.stopped.push(name);
    return this.onStopNamed ? this.onStopNamed(name) : true;
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

test("V2: Live's leading punctuation and the name do not hide a stop: '. Never mind', '. Cancel that', 'Jarhead, stop.'", async () => {
  for (const frags of [[". Never mind"], [". Never", " mind"], [". Cancel that"], [" Jarhead,", " stop."], [" hey jarhead, cancel"]]) {
    const { live, transcript, stops, d } = setup();
    hear(live, transcript, "open the budget", 0, 1200);
    live.emit("delegation", "item_1", "client", 1200);
    await tick();
    let t = 4000;
    for (const f of frags) {
      hear(live, transcript, f, t, t + 250);
      t += 250;
      await tick(0);
    }
    assert.deepEqual(stops, ["Kevin said stop"], JSON.stringify(frags));
    d.dispose();
  }
  // A request whose words merely follow the name is no stop.
  const { live, transcript, stops, d } = setup();
  hear(live, transcript, "open the budget", 0, 1200);
  live.emit("delegation", "item_1", "client", 1200);
  await tick();
  hear(live, transcript, ". Jarhead, what is the weather", 4000, 4600);
  await tick(0);
  assert.deepEqual(stops, []);
  d.dispose();
});

test("V1: dispose() cuts what its session left: the running turn aborted, the brain's cancel sent, its record cancelled; a draining delegation's wait ends and it closes with its brain's own result, its threads carrying on; quiet, no phase, and a late result changes nothing", async () => {
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
  const [drained, cut] = d.all();
  assert.equal(drained!.status, "done", "the draining delegation keeps its brain's result: its threads were never cancelled");
  assert.equal(drained!.summary, "Spotify alongside.");
  assert.equal(drained!.steps.at(-1)!.text, "the voice session ended; its threads carried on");
  assert.equal(cut!.status, "cancelled", "the running turn is cancelled");
  assert.equal(cut!.summary, "the voice session ended");
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

/** A delegator with Slack's question on the floor, as the engine's desk would hold it: the root's pending question, the floor naming Slack. */
async function slackAsks(): Promise<{ live: FakeLive; transcript: Transcript; brain: ReturnType<typeof holdingBrain>; threads: FakeThreads; confirmations: ConfirmationState; d: Delegator; said: () => string[] }> {
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
  threads.names = ["Slack"];
  threads.alive.set("t_slack", 1);
  confirmations.ask('left click on "Send" in Slack', "click_element", { name: "Send" });
  threads.floor = { id: "t_slack", name: "Slack" };
  // A stop by name ends the thread and takes its question off the desk, as the scheduler does.
  threads.onStopNamed = (name) => {
    if (name !== "Slack") return false;
    threads.floor = undefined;
    threads.names = [];
    threads.alive.clear();
    confirmations.dropQuestion();
    return true;
  };
  const said = (): string[] => live.sent.filter((x) => x.type === "commentary").map((x) => x.content);
  return { live, transcript, brain, threads, confirmations, d, said };
}

let at = 4000;
/** Kevin says `words` as a new utterance and Live delegates on it. */
async function says(live: FakeLive, transcript: Transcript, words: string, id: string): Promise<void> {
  at += 4000;
  hear(live, transcript, ` ${words}`, at, at + 600);
  live.emit("delegation", id, "client", at + 600);
  await tick();
}

test("TH-1: a new request drops the main brain's pending question, never a spawned thread's: Slack's question stays on the floor", async () => {
  for (const [floor, survives] of [
    [{ id: "t_slack", name: "Slack" }, true],
    [{ id: MAIN_THREAD_ID, name: "Jarhead" }, false],
    [undefined, false],
  ] as const) {
    const { live, transcript, threads, confirmations, d } = await slackAsks();
    threads.floor = floor;
    // Kevin asks for something else before he answers.
    await says(live, transcript, "what is in my notes", "item_2");
    assert.equal(confirmations.pending !== undefined, survives, `${floor?.name ?? "a free floor"}: the question ${survives ? "survives" : "is dropped"}`);
    d.dispose();
  }
});

test("TH-1: after Kevin moved on from Slack's question, his next yes may be for what was said since: nothing is armed, Slack's question is asked again, and the yes after that reaches Slack", async () => {
  for (const between of ["what is in my notes", "spotify, play something calmer"]) {
    const { live, transcript, brain, threads, confirmations, d, said } = await slackAsks();
    threads.names = ["Slack", "Spotify"];
    await says(live, transcript, between, "item_2");
    // The brain (or Spotify) speaks and may ask something of its own ("should I read them?"). Kevin: "yes".
    await says(live, transcript, "yes", "item_yes");
    assert.deepEqual(threads.resumed, [], `after "${between}": the yes did not reach Slack`);
    assert.equal(confirmations.consume("click_element", { name: "Send" }), false, "nothing was armed");
    assert.ok(confirmations.pending, "Slack's question is still on the floor");
    assert.equal(said().at(-1), 'Slack still asks: may I left click on "Send" in Slack? Say yes.', "the question is asked again, at once");
    const reask = d.all().find((x) => x.liveId === "item_yes");
    assert.equal(reask?.summary, "asked Slack's question again");
    const tasks = brain.tasks.length;
    // Kevin heard the question again; this yes answers it.
    await says(live, transcript, "yes", "item_yes2");
    assert.deepEqual(threads.resumed, ["t_slack"], "the yes reached Slack");
    assert.equal(brain.tasks.length, tasks, "neither yes was a brain task");
    assert.equal(confirmations.consume("click_element", { name: "Send" }), true, "the yes was armed for Slack's exact action");
    d.dispose();
  }
  // No request in between: the yes is Slack's at once.
  const { live, transcript, threads, d } = await slackAsks();
  await says(live, transcript, "yes", "item_yes");
  assert.deepEqual(threads.resumed, ["t_slack"]);
  d.dispose();
});

test("TH-1: Kevin's no to Slack's question stops Slack, as the Console's Deny does; the brain is untouched, and a later yes lands nothing", async () => {
  for (const no of ["no", "no, don't send it", "don't send that", "not now", "nope. not yet", "no thanks"]) {
    const { live, transcript, brain, threads, confirmations, d } = await slackAsks();
    const turn = brain.tasks[0]!;
    await says(live, transcript, no, "item_no");
    assert.deepEqual(threads.stopped, ["Slack"], `"${no}": Slack stopped`);
    assert.equal(confirmations.pending, undefined, `"${no}": its question is gone`);
    assert.equal(brain.tasks.length, 1, `"${no}": no brain task`);
    assert.equal(turn.signal.aborted, false, `"${no}": the running turn carries on`);
    assert.equal(d.all().find((x) => x.liveId === "item_no")?.summary, "Kevin said no to Slack");
    await says(live, transcript, "yes", "item_yes");
    assert.deepEqual(threads.resumed, [], `"${no}" then "yes": Slack is not resumed`);
    assert.equal(confirmations.consume("click_element", { name: "Send" }), false, `"${no}" then "yes": nothing armed`);
    d.dispose();
  }
});

test("TH-1: a no that cannot stop Slack still drops its question; a no with a request after it stops Slack and the request goes on to the brain", async () => {
  {
    const { live, transcript, threads, confirmations, d } = await slackAsks();
    threads.onStopNamed = () => false; // Slack ended a moment ago
    await says(live, transcript, "no", "item_no");
    assert.deepEqual(threads.stopped, ["Slack"]);
    assert.equal(confirmations.pending, undefined, "the question never waits for a later yes");
    await says(live, transcript, "yes", "item_yes");
    assert.deepEqual(threads.resumed, []);
    d.dispose();
  }
  {
    const { live, transcript, brain, threads, d } = await slackAsks();
    await says(live, transcript, "no, send it to anna instead", "item_no");
    assert.deepEqual(threads.stopped, ["Slack"], "the no answered Slack");
    assert.equal(brain.tasks.length, 2, "the rest went on as a request");
    assert.match(brain.tasks[1]!.request, /send it to anna instead/);
    d.dispose();
  }
});

test("TH-1: after Kevin moved on, a no may be for what was said since: Slack is not stopped, the words go to the brain, and Slack's question stays for a yes to ask again", async () => {
  const { live, transcript, brain, threads, confirmations, d, said } = await slackAsks();
  await says(live, transcript, "what is in my notes", "item_2");
  await says(live, transcript, "no", "item_no");
  assert.deepEqual(threads.stopped, [], "Slack carries on");
  assert.equal(brain.tasks.length, 3, "the no went to the brain");
  assert.ok(confirmations.pending, "Slack's question stays");
  await says(live, transcript, "yes", "item_yes");
  assert.deepEqual(threads.resumed, []);
  assert.match(said().at(-1) ?? "", /^Slack still asks: /);
  d.dispose();
});

test("TH-1: the refusal grammar: a no, a no with a request after it, and words that are no no at all", () => {
  const whole = ["no", "No.", "nope", "nah", "no thanks", "no thank you", "no, don't send it", "don't send that", "don't", "do not send it", "not now", "not yet", "no, not yet", "never", "no way", "jarhead, no", "no wait", "nope, don't do it", "don’t post that", "no, I changed my mind", "don't send the message"];
  const headOnly = ["no, send it to anna instead", "no what's the weather", "don't send it to ben, send it to anna", "not that one, the blue one", "never send messages after ten"];
  const neither = ["yes", "now what", "nobody told me", "notes", "no problem", "no worries", "what is in my notes", "know what", "nothing yet", "send it", "stop", "cancel that"];
  for (const t of whole) {
    assert.ok(REFUSAL_HEAD.test(t), `"${t}" opens with a no`);
    assert.ok(REFUSAL_PATTERN.test(t), `"${t}" is a no and nothing else`);
  }
  for (const t of headOnly) {
    assert.ok(REFUSAL_HEAD.test(t), `"${t}" opens with a no`);
    assert.ok(!REFUSAL_PATTERN.test(t), `"${t}" says more than no`);
  }
  for (const t of neither) assert.ok(!REFUSAL_HEAD.test(t), `"${t}" is no no`);
});

test("V1: dispose() closes a reflex that ran ahead of a delegation Live never sent, once the reflex settles", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const ran: string[] = [];
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome> => {
      ran.push(reflex.label);
      await tick(80);
      sink?.step({ kind: "tool", tool: { name: reflex.tool, input: reflex.input, ok: true, ms: 80 } });
      return { reflex, result: { kind: "text", text: "OK" }, ms: 80, ok: true };
    },
    inExchange: () => false,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: holdingBrain(), confirmations: new ConfirmationState(), reflexes, prefireQuietMs: 10, prefireTtlMs: 60_000, commentaryCoalesceMs: 0 });
  live.emit("inputTranscript", "jarhead scroll down.", 0, 700);
  transcript.push({ speaker: "kevin", delta: "jarhead scroll down.", startMs: 0, endMs: 700 });
  await tick(40);
  assert.deepEqual(ran, ["scroll down"], "the reflex ran ahead");
  assert.equal(d.all()[0]!.status, "running");
  d.dispose(); // the session drops before Live delegates
  await tick(120);
  const rec = d.all()[0]!;
  assert.equal(rec.status, "done", "closed once the reflex settled, not left running");
  assert.equal(rec.summary, "scrolled down. (the voice session ended)");
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
