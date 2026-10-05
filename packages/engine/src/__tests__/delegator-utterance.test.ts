/**
 * W1-3, the Delegator through the real Engine (the launch audit's reproductions, adopted):
 *
 * - V2: the spoken-stop check judges the utterance a fragment belongs to. Kevin's next words while
 *   "cancel my three pm meeting" runs ("thanks") are a new utterance, or new words in the same one,
 *   and carry no stop word: nothing is cut.
 * - V1 (the Delegator's half): a turn running when the server drops the session is cut with that
 *   session's Delegator. Its signal aborts, the brain's cancel is sent, and its record closes as
 *   cancelled, so no turn is left acting where no later Stop can reach it.
 * - TH-1 (the Delegator's half): a thread's question survives an unrelated request. Kevin's later
 *   "yes" still reaches it.
 * - PERF-7: a status answered from the thread table reaches the voice at once, never held in the
 *   commentary coalescer behind the lines said a moment before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_THREAD_ID, type Thread } from "@jarhead/protocol";
import type { Brain, BrainResult } from "@jarhead/brain";
import type { ToolResult } from "@jarhead/hands";
import { current, delegate, nextUtterance, rows, settle, until, world, type World } from "./world.ts";

for (const [request, next, gapMs] of [
  ["cancel my three pm meeting", " thanks", 3000],
  ["stop the timer on my phone", " and start a new one", 3000],
  ["hold on to that file for me", " please", 3000],
  // A second breath inside the merge gap is the same utterance; the words Live already delegated are not judged again.
  ["cancel my three pm meeting", " thanks", 500],
  ["stop the timer on my phone", " and start a new one", 400],
] as const) {
  test(`V2: "${request}" is running; Kevin then says "${next.trim()}" ${gapMs} ms later: nothing stops`, async () => {
    const w = world();
    const { engine, brain } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      delegate(w, request, "item_1");
      await until(() => brain.tasks.length === 1);
      const task = brain.tasks[0]!;
      await settle(30);
      const live = current(w);
      live.nowMs += gapMs;
      const s = live.nowMs;
      live.nowMs += 400;
      live.emit("inputTranscript", next, s, live.nowMs);
      await settle(50);
      const stops = rows<{ type: string }>(w, "stop");
      const told = live.instructions.filter((i) => /Stop speaking now/.test(i));
      assert.equal(task.signal.aborted, false, "words with no stop word in them do not cancel the running task");
      assert.equal(stops.length, 0, "no stop row");
      assert.equal(told.length, 0, "the voice is not told to stop speaking");
    } finally {
      brain.resolve?.({ status: "done", summary: "ok" });
      await engine.stop();
    }
  });
}

test("V2 controls: a stop word in Kevin's next utterance still stops the running task; so does one at the end of the request's own utterance", async () => {
  for (const [next, gapMs] of [
    [" stop", 3000],
    [" never mind", 3000],
    [" stop", 300],
  ] as const) {
    const w = world();
    const { engine, brain } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      delegate(w, "cancel my three pm meeting", "item_1");
      await until(() => brain.tasks.length === 1);
      const task = brain.tasks[0]!;
      await settle(30);
      const live = current(w);
      live.nowMs += gapMs;
      const s = live.nowMs;
      live.nowMs += 300;
      live.emit("inputTranscript", next, s, live.nowMs);
      await until(() => task.signal.aborted, 1000);
      assert.equal(task.signal.aborted, true, `"${next.trim()}" ${gapMs} ms after the request stops it`);
      assert.equal(rows(w, "stop").length, 1, "one stop row");
    } finally {
      brain.resolve?.({ status: "cancelled" });
      await engine.stop();
    }
  }
});

test("V1: a turn running when the server drops the session is cut with that session's Delegator: aborted, the brain's cancel sent, its record cancelled; Stop then finds nothing left acting", async () => {
  const w = world();
  const { engine, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead send the quarterly report to Ben", "item_1");
    await until(() => brain.tasks.length === 1);
    const task = brain.tasks[0]!;
    assert.equal(task.signal.aborted, false);
    assert.equal(engine.runner.attached, true, "the brain's turn is attached to the runner");

    // The server ends the session mid-task (an hour's expiry, a Wi-Fi change).
    current(w).serverClosed("connection_lost", 40);
    await until(() => w.lives.length === 2 && w.lives[1]!.currentState === "started", 3000);
    assert.equal(w.lives.length, 2, "the engine reconnected (a new session)");
    await settle(20);
    assert.equal(task.signal.aborted, true, "the orphaned turn is aborted with the session that started it");
    assert.ok(brain.cancels >= 1, "the brain's cancel was sent (turn/interrupt for Codex)");
    assert.equal(engine.runner.attached, false, "the turn let go of the runner");
    const finished = rows<{ type: string; status: string; summary?: string }>(w, "delegation.finished");
    assert.equal(finished.length, 1);
    assert.equal(finished[0]!.status, "cancelled", "its record is closed as cancelled on the ledger");

    // Kevin presses Stop: "cut everything, close the session, sleep". Nothing is left running.
    await engine.command({ type: "stop" });
    await settle(50);
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.runner.attached, false);
  } finally {
    brain.resolve?.({ status: "cancelled" });
    await engine.stop();
  }
});

const threadsOf = (w: World): readonly Thread[] => w.engine.threads.threads().filter((t) => t.id !== MAIN_THREAD_ID);
const named = (w: World, name: string): Thread | undefined => threadsOf(w).find((t) => t.name === name);

test("TH-1: Slack asks 'send?'; Kevin asks for something else first; Slack's question keeps the floor and his later 'yes' still reaches it", async () => {
  const w = world();
  const { engine, hands } = w;
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
    assert.equal(engine.threads.floorThread()?.name, "Slack", "Slack's question holds the floor");

    // Kevin, before answering, asks for something else (a brain request, not a thread verb, not a yes).
    nextUtterance(w);
    delegate(w, "jarhead what is in my notes", "item_2");
    await settle(50);
    assert.equal(engine.threads.floorThread()?.name, "Slack", "the unrelated request leaves Slack's question on the floor");
    assert.ok(engine.confirmations.pending, "the question is still pending on the root");
    assert.equal(named(w, "Slack")?.status, "waiting-kevin");

    // Kevin: "yes" (meant for Slack, whose question the Console still shows). It reaches Slack.
    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => results.length === 2, 1000);
    assert.equal(results.length, 2, "Slack re-ran its tool on the yes");
    assert.equal(results[1]!.kind, "text", "…and this time it went through");
    assert.equal(hands.named("click").length, 1, "one click: the send");
    const yes = engine.snapshot().delegations.find((d) => d.liveId === "item_yes");
    assert.equal(yes?.summary, "relayed the yes to Slack", "the yes was relayed, not handed to the main brain as a task");
  } finally {
    await engine.stop();
  }
});

for (const via of ["Live's delegation", "the ear"] as const) {
  test(`PERF-7: the table's status answer reaches the voice at once through ${via}, even right after other speech`, async (t) => {
    let w!: World;
    let mode = "split";
    const brain: Brain = {
      kind: "fake",
      start: async () => ({ ready: true, detail: "fake" }),
      handle: async (task, sink) => {
        w.engine.runner.attach(sink, task);
        try {
          if (mode === "split") {
            for (const [name, t] of [["Slack", "tell Ben"], ["Spotify", "play Focus"]] as const) await w.engine.runner.run("thread_start", { name, task: t, lane: "background" });
            return { status: "done", summary: "Slack and Spotify alongside." };
          }
          return { status: "done", summary: "model" };
        } finally {
          w.engine.runner.attach(undefined);
        }
      },
      cancel: async () => undefined,
      stop: async () => undefined,
    };
    w = world({ brain, now: Date.now });
    try {
      await w.engine.start();
      await w.engine.ready();
      await w.engine.wake("test");
      const live = current(w);
      const said: { at: number; text: string }[] = [];
      const orig = live.appendCommentary.bind(live);
      live.appendCommentary = (id: string | null, text: string): string => {
        said.push({ at: Date.now(), text });
        return orig(id, text);
      };
      delegate(w, "jarhead tell ben on slack i'm late and put on focus on spotify", "split");
      await until(() => w.engine.snapshot().threads.filter((x) => x.id !== MAIN_THREAD_ID && !["done", "failed", "stopped"].includes(x.status)).length >= 2, 4000);
      mode = "answer";
      nextUtterance(w);
      const t0 = Date.now();
      if (via === "the ear") w.engine.ear("what is spotify doing", false, 1, w.clock.t);
      else delegate(w, "jarhead what is spotify doing", "ask");
      await until(() => said.some((s) => /Spotify is/.test(s.text)), 3000);
      const line = said.find((s) => /Spotify is/.test(s.text));
      assert.ok(line, "the status line was said");
      t.diagnostic(`[measure] through ${via}, the status line reached Live ${line.at - t0} ms after the words`);
      // The coalescer held it 500–600 ms behind the split's lines. Now it goes when the table answers
      // (the ear first waits out its careful window, 70 ms in this world).
      assert.ok(line.at - t0 < (via === "the ear" ? 300 : 100), `through ${via}, the status line reached Live ${line.at - t0} ms after the words`);
    } finally {
      await w.engine.stop();
    }
  });
}
