import { test } from "node:test";
import assert from "node:assert/strict";
import { addLogSink } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import type { LedgerRow, TranscriptItem } from "@jarhead/protocol";
import { delegate, nextUtterance, rows, settle, until, world } from "./world.ts";

/**
 * Messages typed in the Console (DECISIONS §10): a typed line lands on the record FIRST
 * (a TranscriptItem with `source: "typed"`, a `heard` row) before anything is said to
 * Live, so the request window, the yes check and the reflexes read it as they read speech;
 * a typed command runs as a reflex first; a typed yes arms the question — or is relayed to
 * the thread whose question holds the floor without superseding the main turn; typing
 * while paused resumes; typing while ASLEEP is refused with a toast and the text kept, and
 * opens no paid session unless Settings.typedWakes says so.
 */

type HeardRow = Extract<LedgerRow, { type: "heard" }>;

test("typed while ASLEEP is refused by default: no Live session is opened (the FakeLive is never started), one toast 'asleep — press Go', no instruction, nothing on the record — the text stays in the composer; with Settings.typedWakes the same line wakes Jarhead and reaches the new session as the typed instruction", async () => {
  const w = world();
  const { engine, live, lives, events, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    assert.equal(engine.transportState, "asleep");
    events.length = 0;
    await engine.command({ type: "say-text", text: "open safari" });
    assert.equal(live.config, undefined, "no session was opened: FakeLive.start was never called");
    assert.equal(live.currentState, "idle");
    assert.equal(lives.length, 1);
    assert.equal(engine.transportState, "asleep");
    assert.deepEqual(
      events.filter((e) => e.type === "toast").map((e) => (e.type === "toast" ? `${e.tone}:${e.text}` : "")),
      ["warn:asleep — press Go"],
      "one toast, and the words are the composer's to keep",
    );
    assert.equal(live.instructions.length, 0);
    assert.equal(rows<HeardRow>(w, "heard").length, 0, "nothing on the record");
    assert.equal(hands.named("open_app").length, 0, "no reflex ran asleep");
    // Kevin's word (Settings.typedWakes, default false): the line opens the session and rides in as the typed instruction.
    engine.updateSettings({ typedWakes: true });
    events.length = 0;
    await engine.command({ type: "say-text", text: "open safari" });
    assert.equal(engine.transportState, "awake");
    assert.equal(live.currentState, "started");
    assert.ok(live.instructions.some((i) => /Kevin just typed \(treat it exactly like speech\): "open safari"/.test(i)), live.instructions.join(" | "));
    assert.equal(rows<HeardRow>(w, "heard").filter((r) => r.item.source === "typed").length, 1);
  } finally {
    await engine.stop();
  }
});

test("a typed line is on the record FIRST: a TranscriptItem {speaker kevin, source typed, final true} and its `heard` row exist before the instruction is appended; Live's delegation for it carries the typed words as its request; typed while paused resumes first and reaches the new session", async () => {
  const w = world();
  const { engine, live, lives, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // The record as it stood the moment the instruction went to Live.
    let atAppend: { heard: number; last: TranscriptItem | undefined } | undefined;
    const original = live.appendInstructions.bind(live);
    live.appendInstructions = (id: string | null, content: string): string => {
      if (/Kevin just typed/.test(content)) atAppend = { heard: rows<HeardRow>(w, "heard").length, last: engine.snapshot().transcript.at(-1) };
      return original(id, content);
    };
    await engine.command({ type: "say-text", text: "what is in my notes" });
    assert.ok(atAppend, "the instruction went out");
    assert.equal(atAppend!.heard, 1, "the heard row was on the ledger before the instruction");
    assert.equal(atAppend!.last?.speaker, "kevin");
    assert.equal(atAppend!.last?.source, "typed");
    assert.equal(atAppend!.last?.final, true);
    assert.equal(atAppend!.last?.text, "what is in my notes");
    // Live delegates for it: the request is the typed words, and the brain gets them.
    live.emit("delegation", "item_1", "client", live.nowMs);
    await settle();
    assert.equal(brain.tasks.length, 1);
    assert.equal(brain.tasks[0]!.request, "what is in my notes");
    assert.equal(engine.snapshot().delegations[0]!.request, "what is in my notes");
    brain.resolve!({ status: "done", summary: "three notes." });
    await settle();
    // Paused: typing resumes first — a new session — and the line reaches it.
    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    await engine.command({ type: "say-text", text: "what is in my calendar" });
    assert.equal(lives.length, 2, "the resume opened a new session");
    assert.equal(engine.isPaused, false);
    assert.ok(lives[1]!.instructions.some((i) => /Kevin just typed .*what is in my calendar/.test(i)));
    assert.equal(live.instructions.filter((i) => /calendar/.test(i)).length, 0, "nothing went to the closed session");
  } finally {
    await engine.stop();
  }
});

test("typed 'open safari' runs the reflex first (a hands op within 300 ms; the instruction says Jarhead already did it), Live's delegation for the same words is finished as already done with no second open, and the typed words never ride into the next spoken request", async () => {
  const w = world();
  const { engine, live, hands, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    const t0 = Date.now();
    await engine.command({ type: "say-text", text: "open safari" });
    const took = Date.now() - t0;
    assert.ok(took < 300, `the typed command acted in ${took} ms`);
    assert.equal(hands.named("open_app").length, 1, "the reflex opened Safari on the acting helper");
    assert.match(live.instructions.at(-1) ?? "", /^Kevin just typed \(treat it exactly like speech\): "open safari"\. Jarhead already did it: opened Safari\./);
    // Live's delegation for the typed words: already done, not redone.
    live.emit("delegation", "item_1", "client", live.nowMs);
    await settle();
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "already did it");
    assert.equal(d.request, "open safari");
    assert.equal(hands.named("open_app").length, 1, "not opened twice");
    assert.equal(brain.tasks.length, 0, "no brain for a typed reflex");
    // The next spoken request is its own: the typed words were handled and left behind.
    nextUtterance(w);
    delegate(w, "jarhead what is on my screen", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 1);
    assert.equal(brain.tasks[0]!.request, "jarhead what is on my screen", "the typed 'open safari' is not part of this request");
  } finally {
    await engine.stop();
  }
});

test("a typed yes arms the main lane's pending question and Live's next delegation runs with confirmation: true; with a thread's question on the floor the typed yes is relayed to that thread (its brain re-calls the tool once) and the main turn is not superseded", async () => {
  const w = world();
  const { engine, live, hands, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // 1. The main lane's own question is pending (through the desk, so the floor is main's).
    engine.desk.lane("jarhead", "Jarhead").ask("click Send in Mail", "left_click", { coordinate: [1, 2] });
    assert.ok(engine.confirmations.pending);
    await engine.command({ type: "say-text", text: "yes" });
    assert.match(live.instructions.at(-1) ?? "", /Kevin just typed \(treat it exactly like speech\): "yes"/);
    live.emit("delegation", "item_yes", "client", live.nowMs);
    await settle();
    assert.equal(brain.tasks.length, 1);
    assert.equal(brain.tasks[0]!.confirmation, true, "the typed yes is transcript.last('kevin'): the delegator's isYes saw it");
    brain.resolve!({ status: "done", summary: "sent." });
    await settle();
    engine.confirmations.clear();

    // 2. A screen thread asks (click Send needs a yes) and holds the floor; the main brain's turn runs on.
    const results: ToolResult[] = [];
    w.threads.script = async (job) => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      results.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
    };
    nextUtterance(w);
    delegate(w, "jarhead tell ben on slack i'm late and play focus on spotify", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 2);
    await engine.runner.run("thread_start", { name: "Slack", task: "send the message", lane: "screen" });
    await until(() => results.length === 1 && engine.threads.floorThread()?.name === "Slack");
    assert.equal(results[0]!.kind, "needs-confirmation");
    const cancels = brain.cancels;
    live.instructions.length = 0;
    await engine.command({ type: "say-text", text: "yes" });
    await until(() => results.length === 2);
    assert.equal(results[1]!.kind, "text", JSON.stringify(results[1]));
    assert.equal(hands.named("click").length, 1, "Slack's Send was clicked, once");
    const slack = w.threads.byName("Slack")!;
    assert.equal(slack.tasks.length, 2);
    assert.equal(slack.tasks[1]!.confirmation, true);
    assert.equal(brain.cancels, cancels, "the main brain's turn was not superseded by a yes meant for a thread");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_2")!.status, "running");
    assert.ok(live.instructions.some((i) => /his yes went to Slack's question/.test(i)), live.instructions.join(" | "));
    assert.equal(rows<HeardRow>(w, "heard").filter((r) => r.item.source === "typed" && r.item.text === "yes").length, 2, "both typed yeses are on the record");
  } finally {
    await engine.stop();
  }
});

test("say-text logs one info line with ms per call; an empty or blank line does nothing and logs nothing", async () => {
  const w = world();
  const { engine, live } = w;
  const lines: string[] = [];
  const off = addLogSink((level, scope, message) => {
    if (scope === "engine" && /^say-text:/.test(message)) lines.push(`${level} ${message}`);
  });
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await engine.command({ type: "say-text", text: "hello there" });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^info say-text: 11 chars → sess_1 in \d+ ms$/);
    await engine.command({ type: "say-text", text: "   " });
    await engine.command({ type: "say-text", text: "" });
    assert.equal(lines.length, 1, "a blank line is nothing said");
    assert.equal(live.instructions.filter((i) => /Kevin just typed/.test(i)).length, 1);
    // A typed thread verb: the line names the reflex it answered from.
    w.threads.script = async () => undefined;
    delegate(w, "jarhead play focus on spotify and tell ben", "item_1");
    await settle();
    await engine.runner.run("thread_start", { name: "Spotify", task: "play Focus", lane: "background" });
    await until(() => engine.threads.threadNames().includes("Spotify"));
    const asides = live.commentary.length;
    await engine.command({ type: "say-text", text: "what is spotify doing" });
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /^info say-text: 21 chars → sess_1 in \d+ ms \(reflex: Spotify is /);
    // ONE channel: the typed instruction carries the table's line; the ear's path spoke no aside for a typed line.
    assert.match(live.instructions.at(-1) ?? "", /^Kevin just typed \(treat it exactly like speech\): "what is spotify doing"\. Jarhead already answered it: "Spotify is (thinking|working) — \d+ seconds in" Say that to Kevin, in these words, and wait\.$/);
    await settle(50);
    assert.equal(live.commentary.length, asides, "no commentary for the typed verb: the instruction alone carries the line");
    assert.equal(live.commentary.filter((c) => /^Spotify is /.test(c)).length, 0);
    // A typed named stop has no line of its own (the scheduler speaks "Spotify stopped."): the instruction says it was handled.
    await engine.command({ type: "say-text", text: "stop the spotify one" });
    assert.equal(lines.length, 3);
    assert.match(lines[2]!, /\(reflex: handled\)$/);
    assert.match(live.instructions.at(-1) ?? "", /^Kevin just typed \(treat it exactly like speech\): "stop the spotify one"\. Jarhead already handled it\. Say one word and wait\.$/);
    await until(() => engine.threads.threads().find((t) => t.name === "Spotify")?.status === "stopped");
  } finally {
    off();
    await engine.stop();
  }
});
