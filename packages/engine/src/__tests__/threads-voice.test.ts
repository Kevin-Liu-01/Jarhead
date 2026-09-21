import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolResult } from "@jarhead/hands";
import { MAIN_THREAD_ID, type LedgerRow, type Thread } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { RESTART_REASON } from "../threads/index.ts";
import { delegate, nextUtterance, rows, settle, until, world, type World } from "./world.ts";

/**
 * The voice verbs answered from the table (DECISIONS §6), zero generations, the running
 * turn untouched: "what is Spotify doing" from the ear's partial and from Live's delegation;
 * "stop the Slack one" ends Slack alone; a bare stop with one thread is today's cut on the
 * fragment, with two the speech is gated at once and the work cut waits STOP_NAME_WAIT_MS for
 * a name; "spotify, skip this song" is a follow-up turn on Spotify's brain; the Console's
 * Allow lands only on the floor's thread; `thread.stop main` parks the main turn and never
 * the interrupt; a spawned thread's step is one thread.event and no snapshot; the
 * snapshot's `threads` (main first) and the pane stream; the rebuild at start.
 */

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

type EndedRow = Extract<LedgerRow, { type: "thread.ended" }>;
type StopRow = Extract<LedgerRow, { type: "stop" }>;

const spawned = (w: World): readonly Thread[] => w.engine.threads.threads().filter((t) => t.id !== MAIN_THREAD_ID);
const named = (w: World, name: string): Thread | undefined => spawned(w).find((t) => t.name === name);
const busy = (t: Thread | undefined): boolean => t?.status === "thinking" || t?.status === "acting";
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Wake, delegate the two-app request (the main brain holds it), start Spotify (background) and Slack (screen); both hold their turns. */
async function twoThreads(w: World): Promise<void> {
  w.threads.script = async () => undefined;
  await w.engine.start();
  await w.engine.ready();
  w.engine.updateSettings({ idleSleepMinutes: 0 });
  await w.engine.wake("test");
  delegate(w, "jarhead tell ben on slack i'm late and play focus on spotify", "item_1");
  await settle();
  assert.equal(w.brain.tasks.length, 1);
  await w.engine.runner.run("thread_start", { name: "Spotify", task: "play Focus", lane: "background" });
  await w.engine.runner.run("thread_start", { name: "Slack", task: "tell Ben", lane: "screen" });
  await until(() => spawned(w).length === 2 && spawned(w).every(busy) && w.threads.byName("Spotify") !== undefined && w.threads.byName("Slack") !== undefined);
}

test("'what is spotify doing' as an ear partial: the status line reaches Live within the careful window from the table — brain.tasks unchanged, the running turn untouched, the table answers in under 5 ms; the same words from Live's delegation a moment later are not answered twice; another thread's status from Live's delegation is an aside record closed done, no supersede; two thread_starts spoke ONE split line", async () => {
  const w = world();
  const { engine, live, brain, clock } = w;
  try {
    await twoThreads(w);
    assert.deepEqual(live.commentary.filter((c) => /alongside/.test(c)), ["Spotify alongside."], "one split line for the two starts");
    const t0 = performance.now();
    const line = engine.threads.statusLine("spotify");
    assert.ok(performance.now() - t0 < 5 * RUNNER_SLACK, `the table answers in microseconds: under ${5 * RUNNER_SLACK} ms (${(performance.now() - t0).toFixed(2)} ms)`);
    assert.match(line, /^Spotify is (thinking|working) — \d+ seconds in$/);
    live.commentary.length = 0;
    const tasks = brain.tasks.length;
    // The ear's partial, over a running task (a meta kind passes the hold): careful window, then spoken.
    engine.ear("what is spotify doing", false, 1, clock.t);
    await until(() => live.commentary.length > 0, 1500);
    assert.equal(live.commentary.length, 1);
    assert.match(live.commentary[0]!, /^Spotify is (thinking|working)/);
    assert.equal(brain.tasks.length, tasks, "no generation");
    assert.equal(brain.cancels, 0, "the running turn was not superseded");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_1")!.status, "running");
    // Live delegates the same words: the ear already answered them — nothing said twice, no generation.
    nextUtterance(w);
    delegate(w, "what is spotify doing", "item_2");
    await settle();
    const same = engine.snapshot().delegations.find((d) => d.liveId === "item_2")!;
    assert.equal(same.status, "done");
    assert.equal(same.summary, "already answered");
    assert.equal(live.commentary.length, 1);
    // A status question the ear never saw: Live's delegation is answered from the table as an aside.
    nextUtterance(w);
    delegate(w, "jarhead what is slack doing", "item_3");
    await settle();
    const aside = engine.snapshot().delegations.find((d) => d.liveId === "item_3")!;
    assert.equal(aside.status, "done");
    assert.match(aside.summary ?? "", /^Slack is /);
    assert.ok(aside.steps.some((s) => s.kind === "note" && /thread verb/.test(s.text ?? "")));
    await until(() => live.commentary.some((c) => /^Slack is /.test(c)), 1500);
    assert.equal(brain.tasks.length, tasks, "still no generation");
    assert.equal(brain.cancels, 0);
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_1")!.status, "running", "the main turn carries on");
    // "what are you doing" is the overview.
    nextUtterance(w);
    delegate(w, "jarhead what are you doing", "item_4");
    await settle();
    assert.match(engine.snapshot().delegations.find((d) => d.liveId === "item_4")!.summary ?? "", /^Two threads: Spotify (thinking|working), Slack (thinking|working)$/);
  } finally {
    await engine.stop();
  }
});

test("'stop the slack one' through Live's fragments with two threads live: the speech is gated on the stop word at once, the work cut waits for the name, then Slack alone is stopped — Spotify and the main turn carry on, no stop row; Live's delegation for the same words stops and says nothing twice", async () => {
  const w = world();
  const { engine, live, brain } = w;
  try {
    await twoThreads(w);
    const slack = w.threads.byName("Slack")!;
    const spotify = w.threads.byName("Spotify")!;
    live.commentary.length = 0;
    nextUtterance(w);
    const s = live.nowMs;
    live.emit("inputTranscript", " stop", s, s + 300);
    await tick();
    assert.equal(engine.outputGated, true, "the speech is gated the moment the stop word lands");
    assert.ok(busy(named(w, "Slack")) && busy(named(w, "Spotify")), "the work waits for a name");
    assert.equal(engine.snapshot().delegations[0]!.status, "running");
    live.emit("inputTranscript", " the slack one", s + 300, s + 900);
    live.nowMs = s + 900;
    await until(() => named(w, "Slack")?.status === "stopped");
    assert.ok(busy(named(w, "Spotify")), "Spotify carries on");
    assert.equal(slack.cancels, 1);
    assert.equal(spotify.cancels, 0);
    assert.equal(brain.cancels, 0, "the main turn was not cut");
    assert.equal(engine.snapshot().delegations[0]!.status, "running");
    assert.equal(rows<StopRow>(w, "stop").length, 0, "a named stop is not the interrupt");
    assert.deepEqual(rows<EndedRow>(w, "thread.ended").map((r) => [r.threadId, r.status]), [[named(w, "Slack")!.id, "stopped"]]);
    await until(() => live.commentary.some((c) => /Slack stopped\./.test(c)), 1500);
    // Live's delegation for the words: a thread verb, already done — nothing stopped or said twice.
    live.emit("delegation", "item_2", "client", live.nowMs);
    await settle();
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_2")!;
    assert.equal(d.status, "done");
    assert.equal(live.commentary.filter((c) => /Slack stopped\./.test(c)).length, 1);
    assert.equal(slack.cancels, 1);
    assert.equal(brain.tasks.length, 1, "no generation");
    await settle(Engine.STOP_NAME_WAIT_MS + 50);
    assert.ok(busy(named(w, "Spotify")), "the stop word's timer was cancelled by the name: nothing else was cut later");
    assert.equal(brain.cancels, 0);
  } finally {
    await engine.stop();
  }
});

test("a bare 'stop' with ONE thread live is today's cut, on the fragment, no wait; with TWO the speech is gated at once and everything is cut ≤ STOP_NAME_WAIT_MS later — main cancelled, both threads stopped, one stop row", async () => {
  assert.equal(Engine.STOP_NAME_WAIT_MS, 350);
  // One thread: the cut lands in the same tick as the fragment's listeners (queueMicrotask, as before).
  {
    const w = world();
    const { engine, live, brain } = w;
    try {
      w.threads.script = async () => undefined;
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      delegate(w, "jarhead play focus on spotify and tell ben", "item_1");
      await settle();
      await engine.runner.run("thread_start", { name: "Spotify", task: "play Focus", lane: "background" });
      await until(() => busy(named(w, "Spotify")));
      nextUtterance(w);
      live.emit("inputTranscript", " stop", live.nowMs, live.nowMs + 300);
      await tick();
      assert.equal(engine.snapshot().delegations[0]!.status, "cancelled", "cut on the fragment, as today");
      assert.equal(brain.cancels, 1);
      assert.equal(named(w, "Spotify")!.status, "stopped");
      assert.equal(engine.outputGated, true);
      assert.equal(rows<StopRow>(w, "stop").length, 1);
    } finally {
      await engine.stop();
    }
  }
  // Two threads: the speech gate now, the work cut after the window.
  {
    const w = world();
    const { engine, live, brain } = w;
    try {
      await twoThreads(w);
      nextUtterance(w);
      const t0 = Date.now();
      live.emit("inputTranscript", " stop", live.nowMs, live.nowMs + 300);
      await tick();
      assert.equal(engine.outputGated, true, "speech gated at once");
      assert.equal(engine.snapshot().delegations[0]!.status, "running", "the work waits for a name");
      assert.equal(brain.cancels, 0);
      await until(() => engine.snapshot().delegations[0]!.status === "cancelled", 1000);
      const waited = Date.now() - t0;
      assert.ok(waited >= Engine.STOP_NAME_WAIT_MS - 20 && waited <= Engine.STOP_NAME_WAIT_MS + 200 * RUNNER_SLACK, `cut ${waited} ms after the stop word (under ${Engine.STOP_NAME_WAIT_MS + 200 * RUNNER_SLACK})`);
      assert.equal(brain.cancels, 1);
      assert.deepEqual(spawned(w).map((t) => t.status), ["stopped", "stopped"]);
      assert.equal(w.threads.byName("Spotify")!.cancels, 1);
      assert.equal(w.threads.byName("Slack")!.cancels, 1);
      assert.equal(rows<StopRow>(w, "stop").length, 1);
      assert.equal(rows<StopRow>(w, "stop")[0]!.how, "said");
      assert.equal(live.currentState, "started", "the session stays");
    } finally {
      await engine.stop();
    }
  }
});

test("both stop sources inside one name window — the ear's partial 'stop', then Live's fragment ' stop' 60 ms later, two threads live: ONE cut (one stop row, one 'stop speaking' instruction, one 'stopped' toast; the Delegator's timer is cleared by the ear's cut); a pressed Stop while the Delegator's window is open: one `pressed` row and no `said` row after it", async () => {
  // The ear first.
  {
    const w = world();
    const { engine, live, brain, events, clock } = w;
    try {
      await twoThreads(w);
      nextUtterance(w);
      events.length = 0;
      live.instructions.length = 0;
      engine.ear("stop", false, 1, clock.t);
      await settle(60);
      assert.equal(engine.outputGated, true, "the ear gated the speech on the stop word");
      assert.equal(engine.snapshot().delegations[0]!.status, "running", "the ear waits for a name");
      // Live's transcription of the same word, behind the ear.
      live.emit("inputTranscript", " stop", live.nowMs, live.nowMs + 300);
      await until(() => engine.snapshot().delegations[0]!.status === "cancelled", 1000);
      // Past both windows: were the Delegator's timer still armed, it would cut a second time now.
      await settle(Engine.STOP_NAME_WAIT_MS + 150);
      assert.equal(rows<StopRow>(w, "stop").length, 1, "one stop row");
      assert.equal(rows<StopRow>(w, "stop")[0]!.how, "said");
      assert.equal(live.instructions.filter((i) => /Stop speaking now and wait/.test(i)).length, 1, "one instruction");
      assert.equal(events.filter((e) => e.type === "toast" && e.text === "stopped").length, 1, "one toast");
      assert.equal(brain.cancels, 1);
      assert.deepEqual(spawned(w).map((t) => t.status), ["stopped", "stopped"]);
      assert.equal(live.currentState, "started", "the session stays");
    } finally {
      await engine.stop();
    }
  }
  // Kevin presses Stop while Live's window is open.
  {
    const w = world();
    const { engine, live } = w;
    try {
      await twoThreads(w);
      nextUtterance(w);
      live.instructions.length = 0;
      live.emit("inputTranscript", " stop", live.nowMs, live.nowMs + 300);
      await tick();
      assert.equal(engine.snapshot().delegations[0]!.status, "running", "the work waits for a name");
      await settle(60);
      await engine.command({ type: "interrupt" });
      assert.deepEqual(rows<StopRow>(w, "stop").map((r) => r.how), ["pressed"]);
      assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
      await settle(Engine.STOP_NAME_WAIT_MS + 150);
      assert.deepEqual(rows<StopRow>(w, "stop").map((r) => r.how), ["pressed"], "the window's timer was cleared by the cut: no `said` row after the `pressed` one");
      assert.equal(live.instructions.filter((i) => /Stop speaking now and wait/.test(i)).length, 1);
    } finally {
      await engine.stop();
    }
  }
});

test("cross-source named stop, the ear first: the ear hears 'stop' … 'stop the slack one' and stops Slack; Live's fragments ' stop' + ' the slack one' for the SAME words arrive with one thread left — the main turn still runs, Spotify is busy, 0 stop rows, brain.cancels 0; Live's delegation of the words is 'already answered' and Kevin hears 'Slack stopped.' exactly once, judged past the 600 ms coalescer", async () => {
  const w = world();
  const { engine, live, brain, clock } = w;
  try {
    await twoThreads(w);
    live.commentary.length = 0;
    nextUtterance(w);
    engine.ear("stop", false, 1, clock.t);
    await tick();
    assert.equal(engine.outputGated, true);
    engine.ear("stop the slack one", false, 1, clock.t);
    await until(() => named(w, "Slack")?.status === "stopped");
    assert.ok(busy(named(w, "Spotify")));
    assert.equal(engine.threads.table.spawnedLiveCount(), 1);
    assert.equal(w.threads.byName("Slack")!.cancels, 1);
    // Live's rendering of the same utterance, ~300 ms behind, as two fragments — with ONE thread live now.
    const s = live.nowMs;
    live.emit("inputTranscript", " stop", s, s + 300);
    await tick();
    assert.equal(engine.snapshot().delegations[0]!.status, "running", "one thread live, but the ear just stopped one by name: the stop word is its echo, not today's cut");
    assert.equal(brain.cancels, 0);
    live.emit("inputTranscript", " the slack one", s + 300, s + 900);
    live.nowMs = s + 900;
    await settle(Engine.STOP_NAME_WAIT_MS + 150);
    assert.equal(engine.snapshot().delegations[0]!.status, "running", "the main turn carries on");
    assert.ok(busy(named(w, "Spotify")), "Spotify carries on");
    assert.equal(brain.cancels, 0);
    assert.equal(rows<StopRow>(w, "stop").length, 0);
    assert.equal(w.threads.byName("Slack")!.cancels, 1, "Slack was not stopped twice");
    assert.equal(w.threads.byName("Spotify")!.cancels, 0);
    // Live delegates the words: a thread verb the ear already answered — nothing stopped or said twice.
    live.emit("delegation", "item_2", "client", live.nowMs);
    await settle();
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_2")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "already answered");
    assert.equal(brain.tasks.length, 1, "no generation");
    // Past the 600 ms commentary coalescer: a second "Slack …" line would have landed by now.
    await settle(750);
    assert.deepEqual(live.commentary.filter((c) => /Slack/.test(c)), ["Slack stopped."]);
  } finally {
    await engine.stop();
  }
});

test("cross-source named stop, Live first: the fragments ' stop' + ' the slack one' stop Slack; the ear's partials 'stop' then 'stop the slack one' for the same words arrive after — with one thread left the ear opens the name window on Live's echo instead of cutting, the name parses through the recent names, and nothing else is stopped or said twice", async () => {
  const w = world();
  const { engine, live, brain, clock } = w;
  try {
    await twoThreads(w);
    live.commentary.length = 0;
    nextUtterance(w);
    const s = live.nowMs;
    live.emit("inputTranscript", " stop", s, s + 300);
    await tick();
    live.emit("inputTranscript", " the slack one", s + 300, s + 900);
    live.nowMs = s + 900;
    await until(() => named(w, "Slack")?.status === "stopped");
    assert.equal(engine.threads.table.spawnedLiveCount(), 1);
    // The ear, behind Live for once: its partial "stop" with one thread live would be today's cut of everything.
    engine.ear("stop", false, 1, clock.t);
    await tick();
    assert.equal(engine.snapshot().delegations[0]!.status, "running", "Live's words just stopped a thread by name: the ear's stop word is the echo");
    assert.ok(busy(named(w, "Spotify")));
    engine.ear("stop the slack one", false, 1, clock.t);
    await settle(Engine.STOP_NAME_WAIT_MS + 150);
    assert.equal(engine.snapshot().delegations[0]!.status, "running");
    assert.ok(busy(named(w, "Spotify")), "Spotify carries on");
    assert.equal(brain.cancels, 0);
    assert.equal(rows<StopRow>(w, "stop").length, 0);
    assert.equal(w.threads.byName("Slack")!.cancels, 1, "not stopped twice");
    await settle(750);
    assert.deepEqual(live.commentary.filter((c) => /Slack/.test(c)), ["Slack stopped."], "said once");
    // The ear's fired verb is remembered: Live's delegation of the words is 'already answered'.
    live.emit("delegation", "item_2", "client", live.nowMs);
    await settle();
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_2")!.summary, "already answered");
    assert.equal(brain.tasks.length, 1);
  } finally {
    await engine.stop();
  }
});

test("thread.answer main / no: the main lane's question is dropped, the main record leaves waiting-kevin (idle in snapshot.threads[0]), Live is told once, and a Deny with nothing waiting only toasts", async () => {
  const w = world();
  const { engine, live, brain, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead send the mail", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    // The main brain's tool asks (Send needs a yes): the confirm step lands on the main record, the turn ends on the question.
    const r = (await engine.runner.run("click_element", { name: "Send" })).result;
    assert.equal(r.kind, "needs-confirmation", JSON.stringify(r));
    brain.resolve!({ status: "done", summary: r.kind === "needs-confirmation" ? r.question : "" });
    await settle();
    assert.equal(engine.snapshot().threads![0]!.status, "waiting-kevin");
    assert.ok(engine.confirmations.pending);
    live.instructions.length = 0;
    events.length = 0;
    await engine.command({ type: "thread.answer", threadId: MAIN_THREAD_ID, yes: false });
    assert.equal(engine.confirmations.pending, undefined);
    assert.equal(engine.desk.floor, undefined);
    assert.equal(engine.snapshot().threads![0]!.status, "idle", "the main record left waiting-kevin without waiting for a Delegator phase");
    assert.deepEqual(live.instructions.filter((i) => /^Kevin denied "/.test(i)).length, 1, live.instructions.join(" | "));
    assert.ok(events.some((e) => e.type === "toast" && e.text === "denied"));
    // Nothing waiting: a toast, no instruction, the record untouched.
    live.instructions.length = 0;
    await engine.command({ type: "thread.answer", threadId: MAIN_THREAD_ID, yes: false });
    assert.equal(live.instructions.length, 0);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "no question is waiting"));
    assert.equal(engine.snapshot().threads![0]!.status, "idle");
  } finally {
    await engine.stop();
  }
});

test("'spotify, skip this song' from Live is a follow-up turn on Spotify's own brain (its first turn superseded, cancel once, the second task carries Kevin's words), the main turn not superseded; 'pause slack' / 'carry on slack' are the table's too", async () => {
  const w = world();
  const { engine, live, brain } = w;
  try {
    await twoThreads(w);
    const spotify = w.threads.byName("Spotify")!;
    const slack = w.threads.byName("Slack")!;
    nextUtterance(w);
    delegate(w, "spotify, skip this song", "item_2");
    await until(() => spotify.tasks.length === 2);
    assert.equal(spotify.cancels, 1, "the running turn was interrupted once");
    assert.equal(spotify.tasks[1]!.request, "skip this song");
    assert.match(spotify.tasks[1]!.dialogue, /Kevin \(to Spotify\): skip this song/);
    assert.equal(brain.cancels, 0, "the main brain's turn was not superseded");
    assert.equal(brain.tasks.length, 1);
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_1")!.status, "running");
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_2")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "passed to Spotify");
    assert.equal(engine.threads.turnsOf(named(w, "Spotify")!.id).length, 2);
    // Pause and resume by name: the record says so, the brain is interrupted once more, a continuation turn follows.
    nextUtterance(w);
    delegate(w, "jarhead pause slack", "item_3");
    await until(() => named(w, "Slack")?.status === "paused");
    assert.equal(slack.cancels, 1);
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_3")!.summary, "Slack paused.");
    nextUtterance(w);
    delegate(w, "jarhead carry on slack", "item_4");
    await until(() => slack.tasks.length === 2);
    assert.match(slack.tasks[1]!.dialogue, /Kevin paused you at step/);
    assert.ok(busy(named(w, "Slack")));
    assert.equal(brain.cancels, 0);
    await until(() => live.commentary.length >= 1);
  } finally {
    await engine.stop();
  }
});

test("thread.answer: Allow on Spotify's pane while Slack's question holds the floor is refused ('another question is on the floor: Slack's') and arms nothing; Allow on Slack's pane arms once and resumes it; Deny on the promoted question forgets that lane's alone; thread.stop main parks the main turn and never the interrupt", async () => {
  const w = world();
  const { engine, live, hands, brain, events } = w;
  try {
    const results: Record<string, ToolResult[]> = { Slack: [], Spotify: [] };
    w.threads.script = async (job) => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      results[job.brain.name]!.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
    };
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead send the two messages", "item_1");
    await settle();
    await engine.runner.run("thread_start", { name: "Slack", task: "send the message", lane: "screen" });
    await until(() => results["Slack"]!.length === 1 && engine.threads.floorThread()?.name === "Slack");
    await engine.runner.run("thread_start", { name: "Spotify", task: "clear the queue", lane: "screen" });
    await until(() => results["Spotify"]!.length === 1 && named(w, "Spotify")?.status === "waiting-kevin");
    const slackId = named(w, "Slack")!.id;
    const spotifyId = named(w, "Spotify")!.id;
    events.length = 0;
    // Misrouted: Spotify's pane while Slack holds the floor.
    await engine.command({ type: "thread.answer", threadId: spotifyId, yes: true });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "another question is on the floor: Slack's"));
    assert.equal(results["Spotify"]!.length, 1, "nothing re-ran");
    assert.equal(results["Slack"]!.length, 1);
    assert.equal(hands.named("click").length, 0, "nothing clicked");
    assert.equal(engine.threads.floorThread()?.name, "Slack", "the floor is still Slack's");
    // The floor's pane: armed once, Slack re-calls its tool, the click lands.
    await engine.command({ type: "thread.answer", threadId: slackId, yes: true });
    await until(() => results["Slack"]!.length === 2);
    assert.equal(results["Slack"]![1]!.kind, "text");
    assert.equal(hands.named("click").length, 1);
    assert.equal(w.threads.byName("Slack")!.tasks[1]!.confirmation, true);
    assert.equal(brain.cancels, 0, "the main turn was never touched");
    // Spotify's question is promoted and spoken with its name; Deny forgets it and Spotify, waiting on the yes, stops.
    await until(() => engine.threads.floorThread()?.name === "Spotify", 1500);
    await engine.command({ type: "thread.answer", threadId: spotifyId, yes: false });
    await until(() => named(w, "Spotify")?.status === "stopped");
    assert.equal(engine.threads.floorThread(), undefined);
    assert.equal(engine.confirmations.pending, undefined);
    assert.equal(results["Spotify"]!.length, 1, `a no never runs the action (Spotify's tasks: ${JSON.stringify(w.threads.byName("Spotify")!.tasks.map((t) => [t.confirmation, t.dialogue.slice(-80)]))}; results ${JSON.stringify(results["Spotify"])})`);
    // thread.stop main: the main turn is parked (its brain's cancel awaited), the session stays, no stop row.
    await until(() => named(w, "Slack")?.status === "done");
    nextUtterance(w);
    delegate(w, "jarhead what is in my notes", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 2);
    const cancels = brain.cancels; // item_2 superseded item_1's held turn: that cancel is the ordinary one
    await engine.command({ type: "thread.stop", threadId: MAIN_THREAD_ID });
    assert.equal(brain.cancels, cancels + 1, "the park ends the turn: the brain's cancel once");
    assert.equal(live.currentState, "started");
    assert.equal(rows<StopRow>(w, "stop").length, 0, "never the interrupt");
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_2")!.status === "cancelled");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_2")!.summary, "Kevin stopped this thread");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "main thread stopped"));
  } finally {
    await engine.stop();
  }
});

test("wire: a spawned thread's step emits 0 snapshots and exactly one thread.event ≤ 200 B; snapshot.threads lists main first then the spawned threads (≤ 16); thread.transcript frames go out only once a viewer opened the thread (replace with a seq cursor, then coalesced appends); the snapshot's delegations carry every step (no stepCount)", async () => {
  const w = world();
  const { engine, live, events } = w;
  try {
    await twoThreads(w);
    const spotify = w.threads.byName("Spotify")!;
    const spotifyId = named(w, "Spotify")!.id;
    // main first, then the spawned ones, all live.
    const threads = engine.snapshot().threads!;
    assert.equal(threads[0]!.id, MAIN_THREAD_ID);
    assert.ok(busy(threads[0]), `main's record follows the Delegator's phase (${threads[0]!.status}: its own thread_start steps count)`);
    assert.deepEqual(threads.slice(1).map((t) => t.name), ["Spotify", "Slack"]);
    assert.ok(threads.length <= 16);
    assert.ok(JSON.stringify(threads[1]).length <= 700);
    // Quiet the stream, then one step on Spotify's lane.
    for (let n = events.length, i = 0; i < 12; n = events.length, i++) {
      await settle(150);
      if (events.length === n) break;
    }
    const snapshots = events.filter((e) => e.type === "snapshot").length;
    const threadEvents = events.filter((e) => e.type === "thread.event").length;
    assert.equal(events.filter((e) => e.type === "thread.transcript").length, 0, "nobody opened a pane: no transcript frame");
    await spotify.runner.run("frontmost_app", {});
    await settle(150);
    assert.equal(events.filter((e) => e.type === "snapshot").length, snapshots, "a thread's step never rebuilds the snapshot");
    const fresh = events.filter((e) => e.type === "thread.event").slice(threadEvents);
    assert.equal(fresh.length, 1, JSON.stringify(fresh));
    assert.equal(fresh[0]!.type === "thread.event" ? fresh[0]!.event.kind : "", "step");
    assert.ok(JSON.stringify(fresh[0]!.type === "thread.event" ? fresh[0]!.event : {}).length <= 200);
    // The pane: open → replace with a seq cursor; a step → one append within the coalesce window; close → nothing more.
    await engine.command({ type: "thread.open", threadId: spotifyId, viewer: "c1/p1" });
    const opened = events.filter((e) => e.type === "thread.transcript");
    assert.equal(opened.length, 1);
    const page = opened[0]!.type === "thread.transcript" ? opened[0]! : undefined;
    assert.ok(page && page.mode === "replace" && page.transcript.live && page.transcript.cursor && page.transcript.entries.length > 0 && page.transcript.entries.some((e) => e.kind === "delegation"));
    await spotify.runner.run("frontmost_app", {});
    await settle(Engine.THREAD_TRANSCRIPT_COALESCE_MS + 60);
    const appends = events.filter((e) => e.type === "thread.transcript" && e.mode === "append");
    assert.equal(appends.length, 1, "one coalesced append");
    const append = appends[0]!.type === "thread.transcript" ? appends[0]! : undefined;
    assert.ok(append && append.transcript.entries.some((e) => e.kind === "step") && JSON.stringify(append.transcript).length <= 1024);
    await engine.command({ type: "thread.close", threadId: spotifyId, viewer: "c1/p1" });
    const before = events.filter((e) => e.type === "thread.transcript").length;
    await spotify.runner.run("frontmost_app", {});
    await settle(Engine.THREAD_TRANSCRIPT_COALESCE_MS + 60);
    assert.equal(events.filter((e) => e.type === "thread.transcript").length, before, "closed: no more frames");
    // The main pane: its utterances (an utterance settles when the next begins) and its card.
    nextUtterance(w);
    live.emit("inputTranscript", " and one more thing", live.nowMs, live.nowMs + 600);
    await engine.command({ type: "thread.open", threadId: MAIN_THREAD_ID, viewer: "c1/p2" });
    const main = events.filter((e) => e.type === "thread.transcript").at(-1)!;
    assert.ok(main.type === "thread.transcript" && main.mode === "replace" && main.transcript.threadId === MAIN_THREAD_ID, JSON.stringify(main).slice(0, 200));
    const kinds = main.type === "thread.transcript" ? main.transcript.entries.map((e) => e.kind) : [];
    assert.ok(kinds.includes("utterance") && kinds.includes("delegation") && kinds.includes("step"), `the main pane carries its utterances, its card and its steps: ${kinds.join(",")}`);
    // The snapshot carries every step of a main-thread delegation: the Console's card reads them from it.
    for (let i = 0; i < 14; i++) await engine.runner.run("frontmost_app", {});
    const full = engine.snapshot();
    assert.ok(full.delegations[0]!.steps.length >= 14);
    assert.ok(full.delegations.every((d) => d.stepCount === undefined), "main's delegations carry their steps, never a count");
  } finally {
    await engine.stop();
  }
});

test("rebuild at start: an engine started over a state dir whose day file holds a live thread appends exactly one thread.ended {failed, 'the daemon restarted'} row, builds no brain and touches no helper, and snapshot.threads shows it (main first) within the linger", async () => {
  const w = world();
  const { engine } = w;
  const at = w.clock.t - 5000;
  const old: Thread = { id: "t_old", name: "Spotify", lane: "background", status: "thinking", parentId: MAIN_THREAD_ID, parentDelegationId: "dlg_p", liveId: "item_x", task: "play Focus", apps: [], startedAt: at, updatedAt: at, turns: 1, steps: 3, waits: 0, budget: { steps: 25, seconds: 180 }, canSay: true, canStop: true };
  engine.ledger.append({ at, type: "thread.started", thread: old });
  // The daemon restarts: a second engine over the same state dir.
  const w2 = world({}, { dir: w.dir, firstSessionId: "sess_b" });
  try {
    const ended = rows<EndedRow>(w2, "thread.ended").filter((r) => r.threadId === "t_old");
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!.status, "failed");
    assert.equal(ended[0]!.summary, RESTART_REASON);
    assert.equal(ended[0]!.steps, 3);
    const shown = w2.engine.snapshot().threads!;
    assert.equal(shown[0]!.id, MAIN_THREAD_ID);
    assert.equal(shown[0]!.status, "idle");
    const found = shown.find((t) => t.id === "t_old");
    assert.equal(found?.status, "failed");
    assert.equal(found?.detail, RESTART_REASON);
    assert.equal(w2.threads.brains.length, 0, "no brain was built for it");
    assert.equal(w2.hands.ops.length + w2.handsBg.ops.length, 0, "nothing acts");
    assert.equal(w2.engine.threads.statusLine("spotify"), `Spotify failed: ${RESTART_REASON}`);
    assert.equal(w2.engine.threads.running(), 0);
  } finally {
    await w2.engine.stop();
    await engine.stop();
  }
});
