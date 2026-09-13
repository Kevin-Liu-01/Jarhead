import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow, Snapshot } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { delegate, frame, nextUtterance, rows, settle, world } from "./world.ts";

/**
 * Pause: the session is CLOSED — GPT-Live-1 bills every second a session is
 * open, muted or not — and the conversation is held in the engine: transcript,
 * marks, brain, hands. The running task is cancelled, the mic is dropped, the ear
 * is off, the phase reads "paused", the snapshot carries `pause` and no `session`.
 * Resume opens a NEW session whose instructions carry the continuity. Asleep,
 * pause only says so. A pause nobody resumes decays to sleep.
 */

type Row = Extract<LedgerRow, { type: "pause" | "resume" | "session.started" | "session.closed" }>;

test("pause during a running task: the session closes (the meter stops), the task is cancelled, the mic is dropped, phase paused, PauseInfo in the snapshot, typed ledger rows; resume opens a new session carrying the conversation", async () => {
  const w = world();
  const { engine, live, lives, hands, events, audio, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead find the save button", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    assert.equal(engine.snapshot().delegations[0]!.status, "running");
    live.emit("audio", frame());
    assert.equal(audio.length, 1);
    engine.feedMic(frame());
    assert.equal(live.audioIn, 1);
    live.reportUsage(42);
    assert.deepEqual(engine.snapshot().usageToday, { seconds: 42, sessions: 1 });

    events.length = 0;
    live.instructions.length = 0;
    const t0 = clock.t;
    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    assert.equal(engine.transportState, "paused");
    assert.equal(engine.currentPhase, "paused");
    // The session is gone, not muted: closed once, no mute, nothing appended to it.
    assert.equal(live.currentState, "closed");
    assert.equal(live.closes, 1);
    assert.deepEqual(live.mutes, []);
    assert.deepEqual(live.instructions, []);
    const snap = engine.snapshot();
    assert.equal(snap.session, undefined, "the very next snapshot has no session");
    assert.deepEqual(snap.pause, { at: t0, sessionId: "sess_1", usageSeconds: 42, sleepsAt: t0 + Engine.PAUSE_MIN_MS });
    assert.deepEqual(snap.usageToday, { seconds: 42, sessions: 1 }, "the closed session's seconds are counted once");
    // The conversation is held: the delegations and the transcript are still there.
    assert.equal(snap.delegations[0]!.status, "cancelled");
    assert.equal(snap.delegations[0]!.summary, "paused");
    assert.ok(snap.transcript.some((i) => /find the save button/.test(i.text)));
    assert.equal(brain.cancels, 1);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "paused · meter stopped"));
    assert.ok(events.some((e) => e.type === "speaker-flush"));
    // Ledger: a typed pause row, then the session's closed row with its final usage.
    assert.deepEqual(rows<Row>(w, "pause"), [{ at: t0, type: "pause", sessionId: "sess_1", usageSeconds: 42 }]);
    const closed = rows<Row>(w, "session.closed");
    assert.equal(closed.length, 1);
    assert.equal((closed[0] as Extract<Row, { type: "session.closed" }>).sessionId, "sess_1");
    assert.equal((closed[0] as Extract<Row, { type: "session.closed" }>).usageSeconds, 42);

    // While paused: mic frames are dropped, the old session's late frames and words are ignored, the ear is off, levels read 0.
    engine.feedMic(frame());
    assert.equal(live.audioIn, 1, "mic dropped while paused");
    audio.length = 0;
    live.emit("audio", frame());
    live.emit("outputTranscript", " I found it", 2000, 2400);
    assert.equal(audio.length, 0);
    assert.equal(engine.currentPhase, "paused");
    assert.ok(!engine.snapshot().transcript.some((i) => /I found it/.test(i.text)), "a stale session's words never reach the transcript");
    live.emit("inputTranscript", " hello", 2500, 2800);
    live.emit("delegation", "item_2", "client", 2900);
    await settle();
    assert.equal(brain.tasks.length, 1, "no delegation reaches the brain while paused");
    engine.ear("scroll down", true, 1, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 0);
    events.length = 0;
    (engine as unknown as { tick(): void }).tick();
    const levels = events.find((e) => e.type === "levels");
    assert.ok(levels && levels.type === "levels" && levels.levels.output === 0);
    assert.equal(engine.currentPhase, "paused", "paused is decided before 'no session → asleep'");

    // Resume: a new session, its instructions carrying what was said and the last task.
    events.length = 0;
    clock.t += 3 * 60_000;
    await engine.command({ type: "resume" });
    assert.equal(engine.isPaused, false);
    assert.equal(engine.transportState, "awake");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(lives.length, 2, "a NEW session was opened");
    const next = lives[1]!;
    assert.equal(next.currentState, "started");
    const instructions = next.config?.instructions ?? "";
    assert.match(instructions, /# Continuity/);
    assert.match(instructions, /Kevin paused you 3 minutes ago and just resumed/);
    assert.match(instructions, /Kevin: jarhead find the save button/, "the last heard line is in the continuity");
    assert.match(instructions, /Last task: "jarhead find the save button" — cancelled: paused/);
    assert.match(instructions, /Carry on as before; do not recap unless he asks\./);
    assert.ok(instructions.indexOf("# Personality") < instructions.indexOf("# Continuity"), "the continuity follows the standing instructions");
    const after: Snapshot = engine.snapshot();
    assert.equal(after.pause, undefined);
    assert.equal(after.session?.id, "sess_2");
    assert.deepEqual(after.usageToday, { seconds: 42, sessions: 2 });
    assert.equal(after.delegations.length, 1, "the held delegations are still shown");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "resumed"));
    const started = rows<Row>(w, "session.started") as Extract<Row, { type: "session.started" }>[];
    assert.equal(started.length, 2);
    assert.equal(started[1]!.sessionId, "sess_2");
    assert.equal(started[1]!.resumedFrom, "sess_1");
    assert.deepEqual(rows<Row>(w, "resume"), [{ at: clock.t, type: "resume", sessionId: "sess_2", resumedFrom: "sess_1", pausedMs: 3 * 60_000 }]);
    // Audio and mic flow on the new session; delegations run again.
    next.emit("audio", frame());
    assert.equal(audio.length, 1, "audio flows again");
    engine.feedMic(frame());
    assert.equal(next.audioIn, 1);
    nextUtterance(w);
    delegate(w, "jarhead what is on my screen", "item_3");
    await settle();
    assert.equal(brain.tasks.length, 2, "delegations run again");
    assert.equal(engine.snapshot().delegations.length, 2);
    // Resume twice is harmless.
    events.length = 0;
    await engine.command({ type: "resume" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "not paused"));
    assert.equal(lives.length, 2);
  } finally {
    await engine.stop();
  }
});

test("pause keeps Kevin's own mute; pause while asleep only says so; a pause nobody resumes decays to sleep after idleSleepMinutes (at least a minute) and the next wake has no continuity", async () => {
  const w = world();
  const { engine, lives, events, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    // Asleep: a toast, nothing else.
    events.length = 0;
    await engine.command({ type: "pause" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "asleep already"));
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.isPaused, false);

    engine.updateSettings({ idleSleepMinutes: 1 });
    await engine.wake("test");
    engine.setMuted(true);
    assert.equal(engine.currentPhase, "muted");
    await engine.command({ type: "pause" });
    assert.equal(engine.currentPhase, "paused");
    await engine.command({ type: "resume" });
    assert.equal(engine.currentPhase, "muted", "Kevin's mute survives the pause");
    assert.deepEqual(lives[1]!.mutes, ["mute"], "the new session starts muted");
    engine.setMuted(false);
    assert.equal(engine.currentPhase, "listening");

    // Decay: idleSleepMinutes 1 → the pause sleeps a minute later, unpaused, no continuity on the next wake.
    events.length = 0;
    const t0 = clock.t;
    await engine.command({ type: "pause" });
    assert.equal(engine.snapshot().pause?.sleepsAt, t0 + 60_000);
    clock.t += 30_000;
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.currentPhase, "paused", "not yet");
    clock.t += 31_000;
    (engine as unknown as { tick(): void }).tick();
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.isPaused, false);
    assert.equal(engine.snapshot().pause, undefined);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "paused too long · asleep"));
    await engine.wake("test");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.outputGated, false);
    assert.equal(lives.length, 3);
    assert.doesNotMatch(lives[2]!.config?.instructions ?? "", /Continuity/, "a decayed pause is not resumed: a plain wake");

    // A longer idle setting stretches the pause; zero (never idle-sleep) still means a minute.
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.command({ type: "pause" });
    assert.equal(engine.snapshot().pause?.sleepsAt, clock.t + 10 * 60_000);
    clock.t += 61_000;
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.currentPhase, "paused");
    await engine.command({ type: "resume" });
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.command({ type: "pause" });
    assert.equal(engine.snapshot().pause?.sleepsAt, clock.t + Engine.PAUSE_MIN_MS);
  } finally {
    await engine.stop();
  }
});

test("`jarhead cmd pause|resume` shapes: the engine commands are accepted by the command switch; wake and go while paused are a resume; a second pause only says so", async () => {
  const w = world();
  const { engine, lives, events } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    await engine.command({ type: "pause" });
    assert.equal(engine.currentPhase, "paused");
    events.length = 0;
    await engine.command({ type: "pause" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "paused already"));
    assert.equal(lives.length, 1);
    await engine.command({ type: "resume" });
    assert.equal(engine.currentPhase, "listening");
    assert.equal(lives.length, 2);
    await engine.command({ type: "pause" });
    await engine.command({ type: "wake" });
    assert.equal(engine.currentPhase, "listening", "wake while paused is a resume");
    assert.equal(lives.length, 3);
    assert.match(lives[2]!.config?.instructions ?? "", /Continuity/);
    await engine.command({ type: "pause" });
    await engine.command({ type: "go" });
    assert.equal(engine.currentPhase, "listening", "go while paused is a resume");
    assert.equal(lives.length, 4);
  } finally {
    await engine.stop();
  }
});

test("pause while workers run: every worker is cancelled with its brain's cancel called once, both helpers' pendings dropped, the session closed; the resume opens a new session and workers start again", async () => {
  const w = world();
  const { engine, live, lives, hands, handsBg, brain } = w;
  try {
    let read!: (r: unknown) => void;
    const reading = new Promise<unknown>((r) => (read = r));
    w.workers.script = async (job) => {
      read((await job.runner.run("frontmost_app", {})).result);
      return undefined;
    };
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead tell ben on slack and play focus on spotify", "item_1");
    await settle();
    handsBg.hold = "frontmost";
    await engine.runner.run("worker_start", { name: "Spotify", task: "play Focus" });
    await settle(50);
    // The main toolset's gate probe reads on the reading helper (SplitHands); the type itself is the acting helper's pending.
    hands.hold = "type";
    const typing = engine.toolset.run("type", { text: "hi" });
    await settle();
    assert.ok(hands.named("type").length > 0 && handsBg.named("frontmost").length > 0);

    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    assert.equal(live.currentState, "closed");
    assert.equal(brain.cancels, 1);
    assert.equal(w.workers.byName("Spotify")!.cancels, 1);
    assert.equal((engine.snapshot().workers ?? [])[0]!.status, "cancelled");
    assert.equal((await typing).kind, "error", "the acting helper's pending failed");
    assert.equal(((await reading) as { kind: string }).kind, "error", "the reading helper's pending failed");
    hands.release();
    handsBg.release();
    assert.deepEqual(rows<Row>(w, "pause").length, 1);

    await engine.command({ type: "resume" });
    assert.equal(lives.length, 2);
    nextUtterance(w);
    delegate(w, "jarhead play focus on spotify and tell ben", "item_2");
    await settle();
    const again = await engine.runner.run("worker_start", { name: "Spotify", task: "play Focus" });
    assert.equal(again.result.kind, "text", "workers start again on the new session");
  } finally {
    hands.release();
    handsBg.release();
    await engine.stop();
  }
});
