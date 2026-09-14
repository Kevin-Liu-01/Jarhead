import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow } from "@jarhead/protocol";
import { LiveSession, type SessionConfig, type WebSocketLike } from "@jarhead/live";
import { Engine } from "../engine.ts";
import { FakeLive, delegate, frame, nextUtterance, rows, settle, world } from "./world.ts";

/**
 * The transport: Go / Pause / Stop over one state machine — asleep, connecting,
 * awake, paused. GPT-Live-1 bills every second a session is open, so every state
 * but awake and connecting has NO session: a pause closes it and holds the
 * conversation, a stop closes it and sleeps, a close that is not answered is
 * terminated at the deadline, and a watchdog ends anything that slipped through.
 * An interrupt (a spoken "stop") is the one stop that keeps the session.
 */

type Row = LedgerRow;
type Started = Extract<Row, { type: "session.started" }>;
type Closed = Extract<Row, { type: "session.closed" }>;
type Stop = Extract<Row, { type: "stop" }>;
type Resume = Extract<Row, { type: "resume" }>;

const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
/** The ledger's row types in order, for the day. */
const sequence = (w: ReturnType<typeof world>, ...types: string[]): string[] => (w.engine.ledger.read(w.clock.t) as unknown as { type: string }[]).map((r) => r.type).filter((t) => types.includes(t));

test("pause closes the session, holds the conversation and drops the mic; resume opens a NEW session whose instructions carry the last heard line under Continuity, with resumedFrom on the started row and a resume row", async () => {
  const w = world();
  const { engine, live, lives, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    assert.equal(engine.transportState, "awake");
    delegate(w, "jarhead open the budget spreadsheet", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    live.reportUsage(17);
    const t0 = clock.t;

    await engine.command({ type: "pause" });
    assert.equal(live.currentState, "closed");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(engine.currentPhase, "paused");
    assert.equal(engine.transportState, "paused");
    assert.deepEqual(engine.snapshot().pause, { at: t0, sessionId: "sess_1", usageSeconds: 17, sleepsAt: t0 + Engine.PAUSE_MIN_MS });
    assert.deepEqual(rows<Row>(w, "pause"), [{ at: t0, type: "pause", sessionId: "sess_1", usageSeconds: 17 }]);
    engine.feedMic(frame());
    assert.equal(live.audioIn, 0, "mic dropped while paused");
    // The brain was not stopped: it is warm for the resume.
    assert.equal(engine.brainInfo.ready, true);

    clock.t += 90_000;
    await engine.command({ type: "go" });
    assert.equal(lives.length, 2, "a new FakeLive: a new session");
    const next = lives[1]!;
    assert.equal(next.currentState, "started");
    assert.match(next.config?.instructions ?? "", /# Continuity/);
    assert.match(next.config?.instructions ?? "", /Kevin: jarhead open the budget spreadsheet/);
    assert.match(next.config?.instructions ?? "", /Kevin paused you (a minute|2 minutes) ago/);
    const started = rows<Started>(w, "session.started");
    assert.equal(started[1]?.resumedFrom, "sess_1");
    assert.deepEqual(rows<Resume>(w, "resume"), [{ at: clock.t, type: "resume", sessionId: "sess_2", resumedFrom: "sess_1", pausedMs: 90_000 }]);
    assert.equal(engine.snapshot().pause, undefined);
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.transportState, "awake");
  } finally {
    await engine.stop();
  }
});

test("stop: phase asleep synchronously, the session closed, a stop row then the closed row, no reconnect; from paused the pause is cleared; from asleep only background jobs are stopped and the toast says nothing is running", async () => {
  const w = world();
  const { engine, live, lives, events, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead read me the headline", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    live.reportUsage(9);
    events.length = 0;
    const stopping = engine.command({ type: "stop" });
    assert.equal(engine.currentPhase, "asleep", "asleep before anything is awaited");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(live.currentState, "closed");
    await stopping;
    assert.equal(engine.transportState, "asleep");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"));
    assert.equal(engine.snapshot().delegations[0]?.status, "cancelled");
    assert.deepEqual(sequence(w, "stop", "session.closed"), ["stop", "session.closed"]);
    const stop = rows<Stop>(w, "stop")[0]!;
    assert.equal(stop.how, "pressed");
    assert.equal(stop.cancelled, engine.snapshot().delegations[0]!.id);
    assert.equal(rows<Closed>(w, "session.closed")[0]?.usageSeconds, 9);
    await settle(50);
    assert.equal(lives.length, 1, "no reconnect after a stop");
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 9, sessions: 1 });

    // From paused: the pause is cleared, asleep, a stop row.
    await engine.wake("test");
    await engine.command({ type: "pause" });
    assert.equal(engine.transportState, "paused");
    events.length = 0;
    await engine.command({ type: "stop" });
    assert.equal(engine.transportState, "asleep");
    assert.equal(engine.snapshot().pause, undefined);
    assert.equal(engine.isPaused, false);
    assert.equal(rows<Stop>(w, "stop").length, 2);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"));
    // Go now is a plain wake: no continuity.
    await engine.command({ type: "go" });
    assert.equal(lives.length, 3);
    assert.doesNotMatch(lives[2]!.config?.instructions ?? "", /Continuity/);
    await engine.command({ type: "stop" });

    // From asleep with nothing at all: no row, an honest toast.
    events.length = 0;
    const before = rows<Stop>(w, "stop").length;
    await engine.command({ type: "stop" });
    assert.equal(engine.currentPhase, "asleep");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "nothing running"));
    assert.equal(rows<Stop>(w, "stop").length, before);
    clock.t += 1;
  } finally {
    await engine.stop();
  }
});

test("stop during connecting: wantAwake is cleared, the session is closed the moment it starts, and the transport stays asleep without a problem line", async () => {
  const w = world();
  const { engine, live, lives, events } = w;
  try {
    await engine.start();
    await engine.ready();
    // Hold the handshake: session.started only when the test says so.
    let started: (() => void) | undefined;
    const realStart = live.start.bind(live);
    live.start = () =>
      new Promise((resolve) => {
        started = () => void realStart().then(resolve);
      });
    const waking = engine.wake("test");
    await settle();
    assert.equal(engine.currentPhase, "connecting");
    assert.equal(engine.transportState, "connecting");
    events.length = 0;
    await engine.command({ type: "stop" });
    assert.equal(engine.currentPhase, "asleep");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"));
    assert.equal(live.closes, 0, "nothing to close yet: the socket is still opening");
    started?.();
    await waking;
    assert.equal(live.currentState, "closed", "closed right after it started");
    assert.equal(live.closes, 1);
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.transportState, "asleep");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(lives.length, 1);
    assert.equal(engine.snapshot().problems.length, 0, "a stop is not a failed start");
    assert.deepEqual(sequence(w, "stop", "session.started", "session.closed"), ["stop", "session.started", "session.closed"]);
    // Go afterwards works as usual.
    await engine.command({ type: "go" });
    assert.equal(engine.currentPhase, "listening");
    assert.equal(lives.length, 2);
  } finally {
    await engine.stop();
  }
});

test("a late closed event from the old session records its row and folds its usage but never clobbers the new session", async () => {
  // The old session's close hangs (the server is slow); the deadline is far away so the event comes late, after the resume.
  const w = world({ closeDeadlineMs: 60_000 });
  const { engine, live, lives, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.hangOnClose = true;
    live.reportUsage(20);
    await engine.command({ type: "pause" });
    assert.equal(live.currentState, "closing", "the server has not answered");
    assert.equal(engine.snapshot().session, undefined, "detached at once regardless");
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 20, sessions: 1 }, "what it billed so far counts already");
    await engine.command({ type: "resume" });
    const next = lives[1]!;
    assert.equal(engine.snapshot().session?.id, "sess_2");
    delegate(w, "jarhead what is on my screen right now", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 1);

    // Now the old session's closed event arrives, with a final usage a little higher.
    live.serverClosed("client_closed", 23);
    assert.equal(engine.snapshot().session?.id, "sess_2", "the new session is untouched");
    assert.ok(engine.currentPhase === "thinking" || engine.currentPhase === "acting", `the new session's task still runs (phase ${engine.currentPhase})`);
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_2")?.status, "running");
    const closed = rows<Closed>(w, "session.closed");
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.sessionId, "sess_1");
    assert.equal(closed[0]!.usageSeconds, 23);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 23, sessions: 2 }, "the delta is folded once, never the whole twice");
    // And its stragglers are ignored: a frame, a word, a delegation from the old session do nothing.
    live.emit("audio", frame());
    live.emit("inputTranscript", " ghost words", 9000, 9300);
    live.emit("delegation", "item_ghost", "client", 9300);
    await settle();
    assert.ok(!engine.snapshot().transcript.some((i) => /ghost words/.test(i.text)));
    assert.equal(engine.snapshot().delegations.some((d) => d.liveId === "item_ghost"), false);
    next.reportUsage(5);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 28, sessions: 2 });
    clock.t += 1;
  } finally {
    await engine.stop();
  }
});

test("the deadline: a session whose close() is never answered is terminate()d so the meter stops (stop and pause alike)", async () => {
  const w = world({ closeDeadlineMs: 40 });
  const { engine, live, lives } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    live.hangOnClose = true;
    live.reportUsage(4);
    await engine.command({ type: "stop" });
    assert.equal(live.currentState, "closing");
    assert.equal(live.terminates, 0);
    await settle(90);
    assert.equal(live.terminates, 1, "terminated at the deadline");
    assert.equal(live.currentState, "closed");
    const closed = rows<Closed>(w, "session.closed");
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.reason, "client_closed");
    assert.equal(closed[0]!.usageSeconds, 4);
    assert.equal(engine.currentPhase, "asleep");
    // Pause too.
    await engine.wake("test");
    const second = lives[1]!;
    second.hangOnClose = true;
    await engine.command({ type: "pause" });
    assert.equal(second.currentState, "closing");
    await settle(90);
    assert.equal(second.terminates, 1);
    assert.equal(second.currentState, "closed");
    assert.equal(engine.currentPhase, "paused", "the pause holds through the terminate");
    assert.equal(rows<Closed>(w, "session.closed").length, 2);
    // A session that closes gracefully before the deadline is never terminated.
    await engine.command({ type: "resume" });
    const third = lives[2]!;
    await engine.command({ type: "stop" });
    await settle(90);
    assert.equal(third.terminates, 0);
    assert.equal(third.closes, 1);
  } finally {
    await engine.stop();
  }
});

test("the watchdog: a session that outlived a stop is terminated after 2 s, a session open while paused is closed, a stray phase with no session is asleep — each logged once, and never during a normal connect", async () => {
  const w = world({ closeDeadlineMs: 60_000 });
  const { engine, live, clock } = w;
  type Inner = { live: unknown; wantAwake: boolean; pauseInfo: unknown; phase: string; connecting: boolean; watchdogSeen: Map<string, number> };
  const inner = engine as unknown as Inner;
  try {
    await engine.start();
    await engine.ready();
    // A normal wake: several ticks while connecting and awake trip nothing.
    let started: (() => void) | undefined;
    const realStart = live.start.bind(live);
    live.start = () =>
      new Promise((resolve) => {
        started = () => void realStart().then(resolve);
      });
    const waking = engine.wake("test");
    await settle();
    tick(engine);
    clock.t += 3000;
    tick(engine);
    assert.equal(engine.currentPhase, "connecting");
    assert.equal(inner.watchdogSeen.size, 0);
    started?.();
    await waking;
    tick(engine);
    clock.t += 3000;
    tick(engine);
    assert.equal(engine.currentPhase, "listening");
    assert.equal(inner.watchdogSeen.size, 0, "an awake session that is wanted is fine");

    // (a) A stop whose close hangs — and, by some bug, the session still attached: the watchdog ends it.
    live.hangOnClose = true;
    await engine.command({ type: "stop" });
    assert.equal(engine.snapshot().session, undefined);
    inner.live = live; // the bug: a session nobody wants, still ours
    assert.equal(inner.wantAwake, false);
    tick(engine);
    assert.equal(live.terminates, 0, "not yet: the 2 s grace");
    clock.t += 2100;
    tick(engine);
    assert.equal(live.terminates, 1, "terminated: it outlived the stop");
    assert.equal(live.currentState, "closed");
    assert.equal(inner.live, undefined);
    assert.equal(engine.currentPhase, "asleep");
    assert.ok([...inner.watchdogSeen.keys()].some((k) => k.startsWith("outlived:sess_1")));
    const seen = inner.watchdogSeen.size;
    tick(engine);
    assert.equal(inner.watchdogSeen.size, seen, "logged once");

    // (b) Paused with a session attached (never through the API; the watchdog is the backstop): closed and detached at once.
    await engine.wake("test");
    const second = w.lives[1]!;
    second.hangOnClose = true; // the server is slow, so there is a close to count when the watchdog asks again
    await engine.command({ type: "pause" });
    assert.equal(second.closes, 1);
    assert.equal(second.currentState, "closing");
    inner.live = second;
    tick(engine);
    assert.equal(inner.live, undefined);
    assert.equal(second.closes, 2, "asked to close again, and detached");
    assert.equal(engine.currentPhase, "paused");
    await engine.command({ type: "stop" });

    // (c) A phase that says awake with no session, no connect, no pause: asleep.
    inner.phase = "listening";
    tick(engine);
    assert.equal(engine.currentPhase, "asleep");
  } finally {
    inner.live = undefined;
    await engine.stop();
  }
});

test("a pause nobody resumes decays to asleep at sleepsAt (idleSleepMinutes, at least a minute); a resume in flight is never decayed", async () => {
  const w = world();
  const { engine, events, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 2 });
    await engine.wake("test");
    const t0 = clock.t;
    await engine.command({ type: "pause" });
    assert.equal(engine.snapshot().pause?.sleepsAt, t0 + 120_000);
    clock.t += 119_000;
    tick(engine);
    assert.equal(engine.currentPhase, "paused");
    clock.t += 1000;
    events.length = 0;
    tick(engine);
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.transportState, "asleep");
    assert.equal(engine.snapshot().pause, undefined);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "paused too long · asleep"));
    assert.equal(rows<Stop>(w, "stop").length, 0, "a decay is a sleep, not a stop");
  } finally {
    await engine.stop();
  }
});

test("usageToday: today's closed sessions from the ledger plus the open one, folded once as each closes; a second engine over the same ledger starts from the same base", async () => {
  const w = world();
  const { engine, live, lives, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 0, sessions: 0 });
    await engine.wake("test");
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 0, sessions: 1 });
    live.reportUsage(30);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 30, sessions: 1 });
    // The server closes it (not expired: no reconnect) with a final figure.
    live.serverClosed("close_requested", 35);
    assert.equal(engine.currentPhase, "asleep");
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 35, sessions: 1 }, "final usage counted once");
    await engine.wake("test");
    lives[1]!.reportUsage(10);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 45, sessions: 2 });
    await engine.command({ type: "pause" });
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 45, sessions: 2 });
    await engine.command({ type: "resume" });
    lives[2]!.reportUsage(5);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 50, sessions: 3 });
    await engine.command({ type: "stop" });
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 50, sessions: 3 });
    // The day rolls over: the base is re-read (an empty file for the new day).
    clock.t += 24 * 60 * 60_000;
    tick(engine);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 0, sessions: 0 });
    clock.t -= 24 * 60 * 60_000;
    tick(engine);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 50, sessions: 3 });
  } finally {
    await engine.stop();
  }
  // A fresh engine over the same state dir sums the same day: 35 + 10 + 5 seconds, three sessions.
  const again = world({}, { dir: w.dir });
  try {
    assert.deepEqual(again.engine.snapshot().usageToday, { seconds: 50, sessions: 3 });
  } finally {
    await again.engine.stop();
  }
});

test("go: asleep → wake; awake → nothing (no toast, one session); connecting → nothing; paused → resume. Also: resume when not paused only says so; go while awake is idempotent", async () => {
  const w = world();
  const { engine, lives, events } = w;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.transportState, "asleep");
    await engine.command({ type: "go" });
    assert.equal(engine.currentPhase, "listening");
    assert.equal(lives.length, 1);
    events.length = 0;
    await engine.command({ type: "go" });
    await engine.command({ type: "go" });
    assert.equal(lives.length, 1, "go while awake opens nothing");
    assert.equal(events.filter((e) => e.type === "toast").length, 0, "and says nothing");
    assert.equal(engine.snapshot().session?.id, "sess_1");
    events.length = 0;
    await engine.command({ type: "resume" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "not paused"));
    await engine.command({ type: "pause" });
    await engine.command({ type: "go" });
    assert.equal(lives.length, 2);
    assert.equal(engine.transportState, "awake");
    await engine.command({ type: "sleep" });
    events.length = 0;
    await engine.command({ type: "resume" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "asleep — wake it instead"));
    assert.equal(lives.length, 2);
  } finally {
    await engine.stop();
  }
});

test("interrupt keeps the session open; the ear's spoken stop is an interrupt; typing in the Console while paused resumes first and the words reach the new session", async () => {
  const w = world();
  const { engine, live, lives, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead summarise this page", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    live.instructions.length = 0;
    await engine.command({ type: "interrupt", how: "said" });
    assert.equal(engine.snapshot().delegations[0]?.status, "cancelled");
    assert.equal(live.currentState, "started", "the session stays");
    assert.equal(engine.snapshot().session?.id, "sess_1");
    assert.equal(engine.transportState, "awake");
    assert.deepEqual(live.instructions, ["Kevin said stop. Stop speaking now and wait."]);
    assert.equal(rows<Stop>(w, "stop")[0]?.how, "said");

    // The ear: "stop" while a task runs.
    nextUtterance(w);
    clock.t += Engine.OUTPUT_GATE_MS + 1;
    delegate(w, "jarhead find the invoice", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 2);
    engine.ear("stop", false, 1, clock.t);
    await settle();
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_2")?.status, "cancelled");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_2")?.summary, "Kevin said stop");
    assert.equal(live.currentState, "started", "a spoken stop never closes the session");
    assert.equal(lives.length, 1);
    assert.equal(rows<Stop>(w, "stop").length, 2);

    // Typing while paused: resume first, then the text — on the new session.
    await engine.command({ type: "pause" });
    assert.equal(engine.transportState, "paused");
    await engine.command({ type: "say-text", text: "open safari" });
    assert.equal(engine.transportState, "awake");
    assert.equal(lives.length, 2);
    assert.ok(lives[1]!.instructions.some((i) => /Kevin just typed .*open safari/.test(i)));
    assert.equal(live.instructions.filter((i) => /Kevin just typed/.test(i)).length, 0, "nothing went to the closed session");
  } finally {
    await engine.stop();
  }
});

test("FakeLive itself: closed fires once however it ends", () => {
  const l = new FakeLive("x");
  let n = 0;
  l.on("closed", () => n++);
  l.close();
  l.terminate();
  l.serverClosed("expired");
  assert.equal(n, 1);
  const h = new FakeLive("y");
  h.hangOnClose = true;
  h.on("closed", () => n++);
  h.close();
  assert.equal(h.currentState, "closing");
  assert.equal(n, 1);
  h.terminate();
  assert.equal(h.currentState, "closed");
  assert.equal(n, 2);
});

// ---------------------------------------------------------------------------
// The handshake. A resume's opening session is still "paused" until it starts
// (pauseInfo is cleared at session.started); a stop's disarmed connect can be
// re-armed by Go; an interrupt has no session to speak to yet; a socket the server
// refuses is one failed start, not a loop; and a wake during a brain swap waits.

/** A session whose start() answers only when the test says so. */
function holdStart(live: FakeLive): () => void {
  let release: (() => void) | undefined;
  const realStart = live.start.bind(live);
  live.start = () =>
    new Promise((resolve, reject) => {
      release = () => void realStart().then(resolve, reject);
    });
  return () => release?.();
}

test("a resume's handshake is left alone: ticks mid-handshake close nothing and never decay the pause, the mic is queued to the opening session, and once started the transport is awake with no problem line", async () => {
  const w = world();
  const { engine, live, lives, events, clock } = w;
  const inner = engine as unknown as { watchdogSeen: Map<string, number> };
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead open the calendar", "item_1");
    await settle();
    await engine.command({ type: "pause" });
    assert.equal(live.currentState, "closed");
    const second = new FakeLive("sess_2");
    lives.push(second);
    const release = holdStart(second);
    events.length = 0;
    const resuming = engine.command({ type: "resume" });
    await settle();
    assert.equal(engine.transportState, "paused", "the pause is held until the new session starts");
    assert.equal(engine.currentPhase, "connecting");
    // The 1 s tick lands during the handshake — several times, and past the pause's decay clock.
    tick(engine);
    clock.t += 1000;
    tick(engine);
    clock.t += Engine.PAUSE_MIN_MS + 1;
    tick(engine);
    assert.equal(second.closes, 0, "the watchdog must not close a resume's opening session");
    assert.equal(second.terminates, 0);
    assert.equal(inner.watchdogSeen.size, 0);
    assert.ok(engine.snapshot().pause, "still paused: the resume has not started");
    assert.equal(engine.currentPhase, "connecting");
    assert.ok(!events.some((e) => e.type === "toast" && /paused too long/.test(e.text)), "a resume in flight is never decayed");
    // Kevin's first words after pressing Go are queued to the opening session, as a wake does.
    engine.feedMic(frame());
    assert.equal(second.audioIn, 1, "mic queued to the opening session during a resume's handshake");
    release();
    await resuming;
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.snapshot().session?.id, "sess_2");
    assert.equal(engine.snapshot().pause, undefined);
    assert.equal(engine.snapshot().problems.length, 0, "a healthy resume has no problem line");
    assert.equal(second.currentState, "started");
    assert.equal(rows<Resume>(w, "resume").length, 1);
    assert.match(second.config?.instructions ?? "", /Kevin: jarhead open the calendar/);
  } finally {
    await engine.stop();
  }
});

/** The session.test.ts fake socket: close() fires onclose synchronously, as the real one does eventually. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  types(): string[] {
    return this.sent.map((l) => (JSON.parse(l) as { type: string }).type);
  }
}

const resource = (id: string): { id: string; expires_at: number; model: string; status: "active" } => ({ id, expires_at: Math.floor(Date.now() / 1000) + 3600, model: "gpt-live-1", status: "active" });

test("the same over a real LiveSession and a fake socket: the pause's graceful close is answered and its socket closed; a tick mid-resume leaves the new socket open; session.started makes it awake", async () => {
  const socks: FakeSocket[] = [];
  const makeLive = (config: SessionConfig): LiveSession => {
    const sock = new FakeSocket();
    socks.push(sock);
    return new LiveSession({ apiKey: "k", config, webSocketFactory: () => sock });
  };
  const w = world({ makeLive });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    const waking = engine.wake("test");
    await settle();
    socks[0]!.open();
    socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
    await waking;
    assert.equal(engine.transportState, "awake");
    socks[0]!.receive({ type: "session.usage.updated", event_id: "u", usage: { seconds: 12 } });

    // Pause: a graceful close goes out; the server answers; the socket is closed from this side too.
    const pausing = engine.command({ type: "pause" });
    assert.equal(engine.snapshot().session, undefined);
    assert.ok(socks[0]!.types().includes("session.close"), "a graceful close was asked for");
    socks[0]!.receive({ type: "session.closed", event_id: "c", reason: "close_requested", session: resource("live_1"), usage: { seconds: 12 } });
    await pausing;
    assert.equal(engine.transportState, "paused");
    assert.equal(socks[0]!.readyState, 3, "the answered close does not leave the old socket open");
    assert.equal(rows<Closed>(w, "session.closed")[0]?.reason, "close_requested");

    // Resume: the socket opens, session.start goes out, and the tick lands before session.started answers.
    const resuming = engine.command({ type: "resume" });
    await settle();
    assert.equal(socks.length, 2, "a new socket for the resumed session");
    socks[1]!.open();
    assert.ok(socks[1]!.types().includes("session.start"));
    assert.equal(engine.currentPhase, "connecting");
    const problemsBefore = engine.snapshot().problems.length;
    tick(engine);
    assert.equal(socks[1]!.readyState, 1, "the resume's socket stays open through a tick");
    socks[1]!.receive({ type: "session.started", event_id: "e2", session: resource("live_2") });
    await resuming;
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.snapshot().session?.id, "live_2");
    assert.equal(engine.snapshot().pause, undefined);
    assert.equal(engine.snapshot().problems.length, problemsBefore, "no problem line for a healthy resume");
    assert.match(socks[1]!.sent[0] ?? "", /# Continuity/, "the new session's instructions carry the continuity");
  } finally {
    await engine.stop();
  }
});

test("stop then go within one handshake: go re-arms the connect a stop had disarmed, so the session that starts is kept", async () => {
  const w = world();
  const { engine, live, lives, events } = w;
  try {
    await engine.start();
    await engine.ready();
    const release = holdStart(live);
    const waking = engine.wake("test");
    await settle();
    assert.equal(engine.transportState, "connecting");
    await engine.command({ type: "stop" });
    assert.equal(engine.currentPhase, "asleep");
    events.length = 0;
    await engine.command({ type: "go" }); // Kevin changes his mind before session.started
    assert.equal(engine.currentPhase, "connecting", "the connect is wanted again");
    assert.equal(events.filter((e) => e.type === "toast").length, 0);
    release();
    await waking;
    await settle();
    assert.equal(live.currentState, "started", "kept, not closed the moment it started");
    assert.equal(live.closes, 0);
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.snapshot().session?.id, "sess_1");
    assert.equal(lives.length, 1);
    assert.equal(rows<Stop>(w, "stop").length, 1, "the stop is on the record");
    assert.equal(rows<Closed>(w, "session.closed").length, 0);
    assert.equal(engine.snapshot().problems.length, 0);
  } finally {
    await engine.stop();
  }
});

test("interrupt during a connect: background jobs are still cut, but no stop row is written and nothing is queued for the session about to start", async () => {
  const w = world();
  const { engine, live, events } = w;
  try {
    await engine.start();
    await engine.ready();
    const release = holdStart(live);
    const waking = engine.wake("test");
    await settle();
    events.length = 0;
    await engine.command({ type: "interrupt" });
    assert.equal(rows<Stop>(w, "stop").length, 0, "no session has an id yet: no stop row");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "nothing running"));
    assert.equal(engine.transportState, "connecting", "an interrupt never touches the transport");
    release();
    await waking;
    assert.equal(live.currentState, "started");
    assert.deepEqual(live.instructions, [], "'stop speaking' was not the new session's first instruction");
    assert.equal(engine.outputGated, false);
    assert.equal(engine.currentPhase, "listening");
  } finally {
    await engine.stop();
  }
});

test("a socket that closes before session.started is one failed start, not a reconnect loop: phase error, one problem line, no 'reconnecting' toast, one session; go tries again", async () => {
  const w = world();
  const { engine, live, lives, events } = w;
  try {
    await engine.start();
    await engine.ready();
    live.failStart = true;
    events.length = 0;
    await engine.wake("test");
    assert.equal(engine.currentPhase, "error");
    assert.equal(engine.transportState, "asleep");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(engine.snapshot().problems.length, 1);
    assert.match(engine.snapshot().problems[0]?.text ?? "", /could not start a Live session: live socket closed before start/);
    assert.ok(!events.some((e) => e.type === "toast" && /reconnecting/.test(e.text)), "a refused socket is not a lost connection");
    await settle(700);
    assert.equal(lives.length, 1, "no reconnect every 500 ms");
    assert.equal(rows<Started>(w, "session.started").length, 0);
    assert.equal(rows<Closed>(w, "session.closed").length, 0, "never started: no closed row either");
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 0, sessions: 0 });
    // Kevin presses Go: a fresh attempt.
    await engine.command({ type: "go" });
    assert.equal(lives.length, 2);
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.snapshot().session?.id, "sess_2");
  } finally {
    await engine.stop();
  }
});

test("a wake during a brain restart waits for the brain instead of wedging the transport in connecting", async () => {
  const w = world();
  const { engine, lives } = w;
  const inner = engine as unknown as { connecting: boolean; brainRestart: Promise<void> | undefined };
  try {
    await engine.start();
    await engine.ready();
    // The brain is being swapped (keys changed): `this.brain` is undefined until the new one starts.
    const restarting = engine.restartBrain("test");
    assert.ok(inner.brainRestart, "a restart is in flight");
    await engine.wake("test");
    await restarting;
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(inner.connecting, false);
    assert.equal(lives.length, 1);
    assert.equal(engine.snapshot().problems.length, 0);
    assert.equal(engine.brainInfo.ready, true);
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------ auto-resume after a restart (REDESIGN §16)
// The engine process dies mid-conversation (a crash, a kill, a self-update); the app
// respawns it and, seeing it come back asleep after a session was open, sends `go` once.
// The new process has no transcript: the ledger says what was said, and the voice says
// "back" once. A second engine over the first one's state dir is that new process here.

test("auto-resume: a Go soon after start resumes the session the previous engine left open — the continuity comes from the LEDGER, the started row says resumedFrom, the voice is told to say 'back' once — and only once", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead open the budget spreadsheet", "item_1");
    await settle();
    a.live.emit("outputTranscript", " Opening it now.", a.live.nowMs + 100, a.live.nowMs + 900);
    nextUtterance(a);
    delegate(a, "jarhead scroll to the totals", "item_2");
    await settle();
    // Quiet for a while on the session timeline: the tick settles the last utterance and the heard / said rows land.
    a.live.nowMs += 5000;
    a.clock.t += 2000;
    tick(a.engine);
    assert.ok(rows<Row>(a, "heard").length >= 2, "the words are on the ledger");
    // The process dies here: no stop row, no closed row. A new engine over the same state dir.
    a.clock.t += 8000;
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t;
    await b.engine.start();
    await b.engine.ready();
    assert.equal(b.engine.transportState, "asleep");
    b.clock.t += 3000;
    await b.engine.command({ type: "go" });
    assert.equal(b.engine.transportState, "awake");
    const config = b.live.config;
    assert.match(config?.instructions ?? "", /# Continuity/);
    assert.match(config?.instructions ?? "", /Jarhead's engine restarted \d+ seconds ago in the middle of this conversation/);
    assert.match(config?.instructions ?? "", /Kevin: jarhead open the budget spreadsheet/);
    assert.match(config?.instructions ?? "", /Jarhead: Opening it now\./);
    assert.match(config?.instructions ?? "", /Kevin: jarhead scroll to the totals/);
    assert.match(config?.instructions ?? "", /Say exactly one word now — "back"/);
    const started = rows<Started>(b, "session.started");
    assert.equal(started.at(-1)?.sessionId, "sess_b");
    assert.equal(started.at(-1)?.resumedFrom, "sess_1", "chained to the cut session");
    const resume = rows<Resume>(b, "resume").at(-1);
    assert.equal(resume?.resumedFrom, "sess_1");
    assert.ok((resume?.pausedMs ?? 0) >= 10_000, `pausedMs is the downtime (${resume?.pausedMs})`);
    // Once only: a later wake in this process is a plain session.
    await b.engine.command({ type: "stop" });
    await b.engine.command({ type: "go" });
    assert.equal(b.lives.length, 2);
    assert.doesNotMatch(b.lives[1]!.config?.instructions ?? "", /Continuity/);
  } finally {
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("auto-resume never happens after Kevin's Stop: a pressed stop before the cut leaves nothing to resume, and a Stop in the new process before its Go does too; outside the window a Go is a plain wake", async () => {
  // Stopped before the cut.
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  let c: ReturnType<typeof world> | undefined;
  let d: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead read the headline", "item_1");
    await settle();
    await a.engine.command({ type: "stop" });
    a.clock.t += 5000;
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t;
    await b.engine.start();
    await b.engine.ready();
    await b.engine.command({ type: "go" });
    assert.doesNotMatch(b.live.config?.instructions ?? "", /Continuity/, "Kevin stopped it: nothing to pick up");
    assert.equal(rows<Started>(b, "session.started").at(-1)?.resumedFrom, undefined);
    // Cut mid-conversation, but Kevin presses Stop in the new process before pressing Go.
    b.clock.t += 5000;
    c = world({}, { dir: a.dir, firstSessionId: "sess_c" });
    c.clock.t = b.clock.t;
    await c.engine.start();
    await c.engine.ready();
    await c.engine.command({ type: "stop" }); // from asleep: no row, but his word
    await c.engine.command({ type: "go" });
    assert.doesNotMatch(c.live.config?.instructions ?? "", /Continuity/, "his Stop in this process wins");
    // Cut mid-conversation, Go after the window: a plain wake.
    await c.engine.command({ type: "stop" });
    c.clock.t += 5000;
    d = world({}, { dir: a.dir, firstSessionId: "sess_d" });
    d.clock.t = c.clock.t;
    await d.engine.start();
    await d.engine.ready();
    d.clock.t += Engine.AUTO_RESUME_WINDOW_MS + 1000;
    await d.engine.command({ type: "go" });
    assert.doesNotMatch(d.live.config?.instructions ?? "", /Continuity/, "the window has passed");
  } finally {
    await d?.engine.stop();
    await c?.engine.stop();
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("a pause survives the engine's death: the new process holds it again (paused, meter stopped, decaying as it would have) and Go resumes with the ledger's continuity; a pause past its decay is asleep", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  let c: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead find the invoice", "item_1");
    await settle();
    a.live.reportUsage(21);
    const pausedAt = a.clock.t;
    await a.engine.command({ type: "pause" });
    assert.equal(a.engine.transportState, "paused");
    // The process dies while paused; the new one reads the pause row back.
    a.clock.t += 10_000;
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t;
    await b.engine.start();
    await b.engine.ready();
    assert.equal(b.engine.transportState, "paused");
    assert.equal(b.engine.currentPhase, "paused");
    assert.deepEqual(b.engine.snapshot().pause, { at: pausedAt, sessionId: "sess_1", usageSeconds: 21, sleepsAt: pausedAt + Engine.PAUSE_MIN_MS });
    assert.equal(b.engine.snapshot().session, undefined, "no session, no meter");
    await b.engine.command({ type: "go" });
    assert.equal(b.engine.transportState, "awake");
    assert.match(b.live.config?.instructions ?? "", /# Continuity/);
    assert.match(b.live.config?.instructions ?? "", /Kevin paused you/);
    assert.match(b.live.config?.instructions ?? "", /Kevin: jarhead find the invoice/, "the lines come from the ledger");
    assert.equal(rows<Started>(b, "session.started").at(-1)?.resumedFrom, "sess_1");
    await b.engine.command({ type: "stop" });
    // A pause whose decay has passed by the time the new process starts is not held: asleep.
    await b.engine.command({ type: "go" });
    await b.engine.command({ type: "pause" });
    b.clock.t += Engine.PAUSE_MIN_MS + 1000;
    c = world({}, { dir: a.dir, firstSessionId: "sess_c" });
    c.clock.t = b.clock.t;
    await c.engine.start();
    await c.engine.ready();
    assert.equal(c.engine.transportState, "asleep");
    assert.equal(c.engine.snapshot().pause, undefined);
  } finally {
    await c?.engine.stop();
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("the resume loop guard: a session that was itself a ledger resume and lived is resumed again; one that died inside 60 s is not (a Go is a plain wake); a pause's resume is exempt", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  let c: ReturnType<typeof world> | undefined;
  let d: ReturnType<typeof world> | undefined;
  let e: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead open the budget spreadsheet", "item_1");
    await settle();
    a.live.nowMs += 5000;
    a.clock.t += 2000;
    tick(a.engine);
    // Cut. b resumes sess_1 (the first resume) and then LIVES: rows 90 s into it.
    a.clock.t += 5000;
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t;
    await b.engine.start();
    await b.engine.ready();
    await b.engine.command({ type: "go" });
    assert.match(b.live.config?.instructions ?? "", /# Continuity/);
    assert.equal(rows<Started>(b, "session.started").at(-1)?.resumedFrom, "sess_1");
    b.clock.t += 90_000;
    delegate(b, "jarhead scroll to the totals", "item_2");
    await settle();
    b.live.nowMs += 5000;
    b.clock.t += 2000;
    tick(b.engine);
    assert.ok(rows<Row>(b, "heard").some((r) => r.at >= b!.clock.t - 3000), "b's words are on the ledger, late in its life");
    // Cut again. c: b was a resume, but it lived — resumed once more, with b's lines.
    b.clock.t += 5000;
    c = world({}, { dir: a.dir, firstSessionId: "sess_c" });
    c.clock.t = b.clock.t;
    await c.engine.start();
    await c.engine.ready();
    await c.engine.command({ type: "go" });
    assert.match(c.live.config?.instructions ?? "", /# Continuity/, "a resume that lived is a conversation");
    assert.match(c.live.config?.instructions ?? "", /Kevin: jarhead scroll to the totals/);
    assert.equal(rows<Started>(c, "session.started").at(-1)?.resumedFrom, "sess_b");
    // c dies 20 s in: a resume that died young. d must not resume it — that is the loop.
    c.clock.t += 20_000;
    d = world({}, { dir: a.dir, firstSessionId: "sess_d" });
    d.clock.t = c.clock.t;
    await d.engine.start();
    await d.engine.ready();
    assert.equal(d.engine.transportState, "asleep");
    d.clock.t += 2000;
    await d.engine.command({ type: "go" });
    assert.equal(d.engine.transportState, "awake");
    assert.doesNotMatch(d.live.config?.instructions ?? "", /Continuity/, "a resume that died young is a loop, not a conversation");
    assert.equal(rows<Started>(d, "session.started").at(-1)?.resumedFrom, undefined);
    assert.equal(rows<Resume>(d, "resume").filter((r) => r.resumedFrom === "sess_c").length, 0);
    // The exemption: d pauses and resumes (Kevin's own chain, resumedFrom set), then dies 10 s in — e resumes it.
    delegate(d, "jarhead find the invoice", "item_3");
    await settle();
    await d.engine.command({ type: "pause" });
    d.clock.t += 1000;
    await d.engine.command({ type: "go" });
    assert.equal(rows<Started>(d, "session.started").at(-1)?.resumedFrom, "sess_d");
    d.clock.t += 10_000;
    e = world({}, { dir: a.dir, firstSessionId: "sess_e" });
    e.clock.t = d.clock.t;
    await e.engine.start();
    await e.engine.ready();
    await e.engine.command({ type: "go" });
    assert.match(e.live.config?.instructions ?? "", /# Continuity/, "a pause's resume that died young is still Kevin's conversation");
    assert.equal(rows<Started>(e, "session.started").at(-1)?.resumedFrom, "sess_d_2");
  } finally {
    await e?.engine.stop();
    await d?.engine.stop();
    await c?.engine.stop();
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("Stop inside the reconnect window after connection_lost writes the stop row (it lands after the session's closed row), and the next process does not resume that session", async () => {
  const a = world();
  let b: ReturnType<typeof world> | undefined;
  try {
    await a.engine.start();
    await a.engine.ready();
    a.engine.updateSettings({ idleSleepMinutes: 0 });
    await a.engine.wake("test");
    delegate(a, "jarhead read the headline", "item_1");
    await settle();
    a.live.nowMs += 5000;
    a.clock.t += 2000;
    tick(a.engine);
    // The server drops the session; the engine will reconnect in 500 ms. Kevin presses Stop first.
    a.live.serverClosed("connection_lost", 5);
    assert.equal(a.engine.snapshot().session, undefined, "detached");
    assert.equal(a.engine.snapshot().problems.some((p) => /reconnecting/.test(p.text)), true);
    a.clock.t += 100;
    await a.engine.command({ type: "stop" });
    const stops = rows<Stop>(a, "stop").filter((r) => r.how === "pressed");
    assert.equal(stops.length, 1, "Kevin's word is on the ledger even though nothing was connecting yet");
    assert.ok(stops[0]!.at >= rows<Closed>(a, "session.closed").at(-1)!.at, "after the closed row");
    assert.equal(a.engine.snapshot().problems.some((p) => /reconnecting/.test(p.text)), false, "the reconnect row left with the stop");
    await settle(600); // the reconnect timer fires into a stopped engine
    assert.equal(a.lives.length, 1, "nothing reopened");
    assert.equal(a.engine.transportState, "asleep");
    // The process dies; the next engine reads the stop after the closed row and leaves the session alone.
    a.clock.t += 3000;
    b = world({}, { dir: a.dir, firstSessionId: "sess_b" });
    b.clock.t = a.clock.t;
    await b.engine.start();
    await b.engine.ready();
    b.clock.t += 1000;
    await b.engine.command({ type: "go" });
    assert.doesNotMatch(b.live.config?.instructions ?? "", /Continuity/, "his Stop wins");
    assert.equal(rows<Started>(b, "session.started").at(-1)?.resumedFrom, undefined);
  } finally {
    await b?.engine.stop();
    await a.engine.stop();
  }
});

test("sleep with a cause: the transport's Stop writes its stop row and then the sleep row (cause stop, the session id); the dock's sleep is asleep synchronously with no farewell; sleeping while asleep records nothing; the sleep command still closes the session", async () => {
  const w = world();
  const { engine, live, lives, clock } = w;
  type SleepRow = Extract<LedgerRow, { type: "sleep" }>;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.reportUsage(4);
    await engine.command({ type: "stop" });
    assert.deepEqual(sequence(w, "stop", "sleep", "session.closed"), ["stop", "sleep", "session.closed"]);
    const first = rows<SleepRow>(w, "sleep")[0]!;
    assert.equal(first.cause, "stop");
    assert.equal(first.sessionId, "sess_1");
    assert.equal(first.farewell, undefined);
    assert.equal(rows<Closed>(w, "session.closed")[0]!.reason, "client_closed");

    await engine.command({ type: "go" });
    const second = lives[1]!;
    const sleeping = engine.command({ type: "sleep", cause: "dock" });
    assert.equal(engine.currentPhase, "asleep", "before the first await");
    assert.equal(second.currentState, "closed");
    await sleeping;
    assert.equal(rows<SleepRow>(w, "sleep")[1]!.cause, "dock");
    assert.equal(second.instructions.length, 0, "no farewell for the dock");
    assert.equal(engine.transportState, "asleep");

    const before = rows<SleepRow>(w, "sleep").length;
    await engine.command({ type: "sleep" });
    await engine.command({ type: "sleep" });
    assert.equal(rows<SleepRow>(w, "sleep").length, before, "asleep already: nothing recorded");

    await engine.command({ type: "go" });
    await engine.command({ type: "sleep" });
    assert.equal(rows<SleepRow>(w, "sleep").at(-1)!.cause, "command");
    assert.equal(lives[2]!.currentState, "closed");
    assert.equal(engine.currentPhase, "asleep");
    clock.t += 1;
  } finally {
    await engine.stop();
  }
});

test("an utterance still open 15 s of wall clock after a live error with no closed behind it is final (the caret stops); a younger one is not; detach still finalises everything", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.emit("inputTranscript", " hello there", 1000, 1500);
    assert.equal(engine.snapshot().transcript[0]?.final, false);
    // The server errors; the session clock (live.nowMs) stops moving and no `closed` ever comes.
    live.emit("error", new Error("response_input_buffer_full: Backend response input history is limited"), "item_9");
    clock.t += 5000;
    tick(engine);
    assert.equal(engine.snapshot().transcript[0]?.final, false, "5 s is not an orphan yet");
    clock.t += 10_000;
    tick(engine);
    assert.equal(engine.snapshot().transcript[0]?.final, true, "15 s of wall clock with no fragment: final");
    assert.equal(rows<Row>(w, "heard").length, 1, "and on the ledger");
    // A fresh utterance that keeps growing is never orphaned while fragments arrive.
    live.emit("inputTranscript", " one more", 1600, 1900);
    clock.t += 14_000;
    live.emit("inputTranscript", " thing", 1900, 2100);
    clock.t += 14_000;
    tick(engine);
    assert.equal(engine.snapshot().transcript[1]?.final, false, "touched 14 s ago: still open");
    clock.t += 1000;
    tick(engine);
    assert.equal(engine.snapshot().transcript[1]?.final, true);
    live.emit("inputTranscript", " last", 3000, 3300);
    await engine.command({ type: "stop" });
    assert.ok(engine.snapshot().transcript.every((i) => i.final), "a detach finalises whatever was open");
  } finally {
    await engine.stop();
  }
});
