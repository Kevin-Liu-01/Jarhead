import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow } from "@jarhead/protocol";
import { FakeLive, delegate, nextUtterance, rows, settle, world } from "./world.ts";

/**
 * English by default, and a voice that stays in the conversation. The session's
 * instructions are assembled in the engine in a fixed order — the standing orders,
 * `# Language` (English, the accent one fragment), `# Kevin, in brief`, `# Continuity`;
 * the started row and the snapshot say what a session speaks with; a pick while awake
 * is heard at the next wake (session.update cannot change a voice) unless Kevin presses
 * Switch now (`voice.reopen`: pause, then a resume with the new voice — never while
 * work runs); and a reconnect after the server dropped the session carries the
 * conversation (`# Continuity`, the dead id as `resumedFrom`, one chain, toast "back").
 */

type Started = Extract<LedgerRow, { type: "session.started" }>;
type Pause = Extract<LedgerRow, { type: "pause" }>;
type Resume = Extract<LedgerRow, { type: "resume" }>;

const LANGUAGE = "# Language\nSpeak English, British accent — calm, dry, precise, a touch wry, the manner of a well-read English butler-engineer — whatever language you hear; if Kevin speaks another language, answer in English unless he asks you to switch.";

test("wake: ballad, English with a British accent; # Personality before # Language before # Kevin, in brief (before # Continuity on a resume); the started row and the snapshot say voice, language and accent", async () => {
  const w = world();
  const { engine, live, lives, clock } = w;
  w.memory!.voiceText = "# Kevin, in brief\nKevin prefers short answers.\nUse this quietly; never announce that you remember it.";
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const text = live.config?.instructions ?? "";
    assert.equal(live.config?.audio?.output?.voice, "ballad");
    assert.ok(text.includes(LANGUAGE), "the exact language section");
    const at = ["# Personality and tone", "# Language", "# Kevin, in brief"].map((h) => text.indexOf(h));
    assert.ok(at.every((i) => i >= 0), `every section present: ${JSON.stringify(at)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in order");
    assert.doesNotMatch(text, /# Continuity/, "a fresh wake carries no continuity");
    assert.ok(text.indexOf("# Names and numbers") < text.indexOf("# Language"), "the language section follows the standing orders");
    const started = rows<Started>(w, "session.started");
    assert.equal(started.length, 1);
    assert.equal(started[0]!.voice, "ballad");
    assert.equal(started[0]!.language, "en");
    assert.equal(started[0]!.accent, "british");
    assert.equal(engine.snapshot().session?.voice, "ballad");
    assert.equal(engine.snapshot().session?.accent, "british");
    // A resume: the same order, Continuity last.
    await engine.command({ type: "pause" });
    clock.t += 60_000;
    await engine.command({ type: "resume" });
    const resumed = lives[1]!.config?.instructions ?? "";
    const order = ["# Personality and tone", "# Language", "# Kevin, in brief", "# Continuity"].map((h) => resumed.indexOf(h));
    assert.ok(order.every((i) => i >= 0), `every section present on the resume: ${JSON.stringify(order)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "Personality < Language < Kevin, in brief < Continuity");
  } finally {
    await engine.stop();
  }
});

test("a pick while asleep opens nothing; a pick while awake opens no new session and toasts 'heard at the next wake' while the snapshot still names the session's voice", async () => {
  const w = world();
  const { engine, live, lives, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ voice: "marin" });
    assert.equal(engine.transportState, "asleep");
    assert.equal(live.currentState, "idle", "no session opened by a pick");
    assert.equal(live.config === undefined, true, "no config was ever built for it");
    assert.ok(!events.some((e) => e.type === "toast" && /heard at the next wake/.test(e.text)), "asleep, nothing to say");
    await engine.wake("test");
    assert.equal(lives.length, 1);
    assert.equal(live.config?.audio?.output?.voice, "marin");
    events.length = 0;
    engine.updateSettings({ voice: "verse", accent: "british" });
    assert.equal(lives.length, 1, "no new paid session on a pick");
    assert.ok(events.some((e) => e.type === "toast" && /heard at the next wake/.test(e.text)), "the toast says when it is heard");
    assert.equal(engine.snapshot().session?.voice, "marin", "the open session still speaks with what it started with");
    assert.equal(engine.snapshot().session?.accent, "british");
    assert.equal(engine.snapshot().settings.voice, "verse");
    assert.equal(engine.snapshot().settings.accent, "british");
    // A patch that changes nothing about the voice says nothing.
    events.length = 0;
    engine.updateSettings({ idleSleepMinutes: 3 });
    assert.ok(!events.some((e) => e.type === "toast" && /heard at the next wake/.test(e.text)));
  } finally {
    await engine.stop();
  }
});

test("voice.reopen: exactly one pause row and one resume row, a new session with the new voice and accent, # Continuity (reconnected) in it, the old session closed first, one chain; asleep it opens nothing and toasts", async () => {
  const w = world();
  const { engine, live, lives, events, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead what time is it", "item_1");
    await settle();
    brain.resolve?.({ status: "done", summary: "ten past four" });
    await settle();
    engine.updateSettings({ voice: "verse", accent: "british" });
    events.length = 0;
    clock.t += 2000;
    await engine.command({ type: "voice.reopen" });
    assert.equal(lives.length, 2, "one new session");
    assert.equal(live.currentState, "closed");
    assert.ok(live.closes >= 1, "the old session was closed");
    const next = lives[1]!;
    assert.equal(next.currentState, "started");
    assert.equal(next.config?.audio?.output?.voice, "verse");
    const text = next.config?.instructions ?? "";
    assert.match(text, /# Language\nSpeak English, British accent — calm, dry, precise/);
    assert.match(text, /# Continuity/);
    assert.match(text, /The voice connection dropped \d+ seconds? ago and just came back\. This is the same conversation, picked up where it was cut\./);
    assert.match(text, /Kevin: jarhead what time is it/);
    assert.match(text, /Say nothing now unless Kevin was mid-request — then answer it\./);
    assert.doesNotMatch(text, /paused you|engine restarted/);
    assert.equal(rows<Pause>(w, "pause").length, 1);
    assert.equal(rows<Resume>(w, "resume").length, 1);
    assert.equal(rows<Resume>(w, "resume")[0]!.resumedFrom, "sess_1");
    const started = rows<Started>(w, "session.started");
    assert.equal(started.length, 2);
    assert.equal(started[1]!.resumedFrom, "sess_1");
    assert.equal(started[1]!.voice, "verse");
    assert.equal(started[1]!.accent, "british");
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.isPaused, false);
    assert.equal(engine.snapshot().session?.voice, "verse");
    assert.equal(engine.snapshot().session?.accent, "british");
    assert.equal(engine.ledger.chainRootOf("sess_2"), "sess_1", "one conversation in the Console");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "back"));
    assert.ok(!events.some((e) => e.type === "toast" && e.text === "paused · meter stopped"), "the pause inside a switch is quiet");
    // Asleep: nothing opens.
    await engine.command({ type: "stop" });
    events.length = 0;
    await engine.command({ type: "voice.reopen" });
    assert.equal(lives.length, 2);
    assert.equal(engine.transportState, "asleep");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "heard at the next wake"));
  } finally {
    await engine.stop();
  }
});

test("voice.reopen while a delegation runs opens nothing and cancels nothing; while paused it opens nothing", async () => {
  const w = world();
  const { engine, lives, events, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead find the save button", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    events.length = 0;
    await engine.command({ type: "voice.reopen" });
    assert.equal(lives.length, 1, "no session opened");
    assert.equal(brain.cancels, 0, "the task was not cancelled");
    assert.equal(engine.snapshot().delegations[0]!.status, "running");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "busy — heard at the next wake"));
    assert.equal(rows<Pause>(w, "pause").length, 0);
    brain.resolve?.({ status: "done", summary: "found it" });
    await settle();
    // Paused: the pick is heard at the resume anyway.
    await engine.command({ type: "pause" });
    events.length = 0;
    await engine.command({ type: "voice.reopen" });
    assert.equal(lives.length, 1);
    assert.equal(engine.transportState, "paused");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "heard at the next wake"));
  } finally {
    await engine.stop();
  }
});

for (const reason of ["connection_lost", "expired"] as const) {
  test(`a reconnect after ${reason} opens exactly one new session whose instructions carry # Continuity ('The voice connection dropped'), resumedFrom the dead id, a resume row, one chain, the grants on it, toast 'back'`, async () => {
    const w = world();
    const { engine, live, lives, events, brain, clock } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      delegate(w, "jarhead read the headline", "item_1");
      await settle();
      brain.resolve?.({ status: "done", summary: "the market is up" });
      await settle();
      nextUtterance(w);
      live.emit("inputTranscript", " and the weather", live.nowMs, live.nowMs + 800);
      live.nowMs += 5000;
      clock.t += 2000;
      (engine as unknown as { tick(): void }).tick();
      assert.equal(engine.confirmations.conversationId, "sess_1");
      events.length = 0;
      // The server drops the session; the engine reconnects 500 ms later.
      live.serverClosed(reason, 42);
      clock.t += 4000;
      await settle(650);
      assert.equal(lives.length, 2, "exactly one new session");
      const next = lives[1]!;
      assert.equal(next.currentState, "started");
      const text = next.config?.instructions ?? "";
      assert.match(text, /# Continuity/);
      assert.match(text, /The voice connection dropped 4 seconds ago and just came back\. This is the same conversation, picked up where it was cut\. What was said before, most recent last:/);
      assert.match(text, /Kevin: jarhead read the headline/);
      assert.match(text, /Kevin: and the weather/);
      assert.match(text, /Last task: "jarhead read the headline" — done: the market is up/);
      assert.match(text, /Carry on as before; do not recap or apologise\. Say nothing now unless Kevin was mid-request — then answer it\./);
      assert.doesNotMatch(text, /paused you|engine restarted/);
      assert.ok(text.indexOf("# Language") < text.indexOf("# Continuity"));
      const started = rows<Started>(w, "session.started");
      assert.equal(started.length, 2);
      assert.equal(started[1]!.resumedFrom, "sess_1", "the dead session's id");
      const resumes = rows<Resume>(w, "resume");
      assert.equal(resumes.length, 1);
      assert.equal(resumes[0]!.resumedFrom, "sess_1");
      assert.equal(resumes[0]!.sessionId, "sess_2");
      assert.equal(rows<Pause>(w, "pause").length, 0, "a reconnect is not a pause");
      assert.equal(engine.ledger.chainRootOf("sess_2"), "sess_1", "one chain in the Console");
      assert.equal(engine.ledger.sessions().length, 2);
      assert.equal(engine.confirmations.conversationId, "sess_1", "the grants stay on the chain; no grant outlives a resume, none is lost by one");
      assert.ok(events.some((e) => e.type === "toast" && e.text === "back"), "the toast is 'back', not 'resumed'");
      assert.ok(!events.some((e) => e.type === "toast" && e.text === "resumed"));
      assert.equal(engine.transportState, "awake");
      assert.equal(engine.snapshot().problems.some((p) => /reconnecting/.test(p)), false, "the reconnect row left");
      const closed = rows<Extract<LedgerRow, { type: "session.closed" }>>(w, "session.closed");
      assert.equal(closed[0]!.usageSeconds, 42, "usage from the closed event");
    } finally {
      await engine.stop();
    }
  });
}

test("a reconnect whose start fails (the network still down) keeps the conversation: the next Go carries # Continuity (reconnected, the real gap), resumedFrom the dead id, one chain, toast 'back'; Stop lets it go and the Go after that starts afresh", async () => {
  const w = world();
  const { engine, live, lives, events, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead read the headline", "item_1");
    await settle();
    brain.resolve?.({ status: "done", summary: "the market is up" });
    await settle();
    assert.equal(engine.confirmations.conversationId, "sess_1");
    // The session the 500 ms reconnect opens refuses the socket.
    const refused = new FakeLive("sess_2");
    refused.failStart = true;
    lives.push(refused);
    live.serverClosed("connection_lost", 7);
    await settle(700);
    assert.equal(lives.length, 2, "the reconnect was attempted once");
    assert.equal(engine.currentPhase, "error");
    assert.equal(rows<Started>(w, "session.started").length, 1, "a socket that never started has no row");
    // Kevin presses Go twenty seconds later: the same conversation, the gap it names the real one.
    clock.t += 20_000;
    events.length = 0;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 3);
    const next = lives[2]!;
    assert.equal(next.currentState, "started");
    const text = next.config?.instructions ?? "";
    assert.match(text, /# Continuity/);
    assert.match(text, /The voice connection dropped 20 seconds ago and just came back\. This is the same conversation, picked up where it was cut\./);
    assert.match(text, /Kevin: jarhead read the headline/);
    assert.match(text, /Last task: "jarhead read the headline" — done: the market is up/);
    const started = rows<Started>(w, "session.started");
    assert.equal(started.length, 2);
    assert.equal(started[1]!.resumedFrom, "sess_1", "the dead session's id");
    assert.equal(rows<Resume>(w, "resume").length, 1);
    assert.equal(rows<Pause>(w, "pause").length, 0);
    assert.equal(engine.ledger.chainRootOf("sess_3"), "sess_1", "one chain in the Console");
    assert.equal(engine.confirmations.conversationId, "sess_1", "the grants stay on the chain");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "back"));
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.snapshot().problems.length, 0, "the failed start's line left with the session that started");
    // A second failure would be held again; a Stop lets the conversation go, and the next Go opens a fresh chain.
    const refusedAgain = new FakeLive("sess_4");
    refusedAgain.failStart = true;
    lives.push(refusedAgain);
    next.serverClosed("expired", 3);
    await settle(700);
    assert.equal(lives.length, 4);
    assert.equal(engine.currentPhase, "error");
    await engine.command({ type: "stop" });
    clock.t += 1000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 5);
    assert.doesNotMatch(lives[4]!.config?.instructions ?? "", /# Continuity/, "his Stop wins: a fresh conversation");
    assert.equal(rows<Started>(w, "session.started").at(-1)!.resumedFrom, undefined);
  } finally {
    await engine.stop();
  }
});
