import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_THREAD_ID, type LedgerRow } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { delegate, frame, nextUtterance, rows, settle, until, world } from "./world.ts";

/**
 * Two stops. An INTERRUPT (a spoken "stop", the `interrupt` command) ends the work
 * and the speech and keeps the session open and listening: Live has no interrupt,
 * so it is local — the speaker is flushed and every output frame is dropped for a
 * while (until Kevin speaks or 2.5 s pass), the running delegation is cancelled and
 * the brain's cancel called, a hands request in flight is failed so its late answer
 * never acts, the voice is told, a toast says "stopped". A STOP (the Stop button,
 * the `stop` command) does all of that and then CLOSES the session — the meter
 * stops — and sleeps; transport.test.ts has the rest of it.
 */

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

type StopRow = Extract<LedgerRow, { type: "stop" }>;

test("interrupt: output audio is dropped for the gate window, the running delegation is cancelled with the brain's cancel called, the hands' pending request is failed, the voice is told, a toast says so — and the session stays open", async () => {
  const w = world();
  const { engine, live, hands, handsBg, events, audio, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    assert.equal(engine.currentPhase, "listening");

    // Speech flows: frames reach the speaker, the phase says speaking.
    live.emit("audio", frame());
    live.emit("outputTranscript", "hello there", 1000, 1500);
    assert.equal(audio.length, 1);
    assert.equal(engine.currentPhase, "speaking");

    // A delegation runs; the brain holds it; a typing's gate probe is in flight in the hands (held here) — on the
    // READING helper, where the main toolset's looks go (SplitHands): the type behind it never reaches the acting one.
    delegate(w, "find the save button", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    assert.equal(engine.snapshot().delegations[0]?.status, "running");
    handsBg.hold = "frontmost";
    const typing = engine.toolset.run("type", { text: "hello" }).catch(() => ({ kind: "error" as const, message: "threw" }));
    await settle();
    assert.ok(handsBg.named("frontmost").length > 0, "the gate probe is waiting on the reading helper");

    // Interrupt.
    events.length = 0;
    live.instructions.length = 0;
    const t0 = Date.now();
    await engine.command({ type: "interrupt" });
    const took = Date.now() - t0;
    assert.ok(took < 150 * RUNNER_SLACK, `interrupt returned in ${took} ms (under ${150 * RUNNER_SLACK})`);
    assert.equal(brain.cancels, 1, "the brain's cancel was called");
    assert.equal(engine.snapshot().delegations[0]?.status, "cancelled");
    assert.equal(engine.snapshot().delegations[0]?.summary, "Kevin pressed stop");
    assert.ok(events.some((e) => e.type === "speaker-flush"), "the speaker was flushed");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"), "a toast says stopped");
    assert.deepEqual(live.instructions, ["Kevin pressed stop. Stop speaking now and wait."], "the voice was told once — not also asked to acknowledge");
    assert.equal(engine.outputGated, true);
    assert.notEqual(engine.currentPhase, "speaking", "no longer speaking, whatever the transcript said a moment ago");
    // The session is still open and ours.
    assert.equal(live.currentState, "started");
    assert.equal(live.closes, 0);
    assert.equal(engine.snapshot().session?.id, "sess_1");
    assert.equal(engine.transportState, "awake");
    const stops = rows<StopRow>(w, "stop");
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.how, "pressed");
    assert.equal(stops[0]!.cancelled, engine.snapshot().delegations[0]!.id);

    // The typing that was waiting on the helper came back as an error, not an action.
    const outcome = await typing;
    assert.equal(outcome.kind, "error");
    assert.match((outcome as { message: string }).message, /cancelled|stop/);
    assert.equal(hands.named("type").length, 0, "nothing was typed after the stop");
    handsBg.release(); // the helper's late answer arrives for an id nobody waits on

    // Frames that arrive after the interrupt are dropped; the output transcript no longer counts as speaking.
    audio.length = 0;
    for (let i = 0; i < 20; i++) live.emit("audio", frame());
    live.emit("outputTranscript", " and then", 2500, 2700);
    assert.equal(audio.length, 0, "gated frames never reach the speaker");
    assert.notEqual(engine.currentPhase, "speaking");

    // 2.5 s later the gate lapses on its own.
    clock.t += Engine.OUTPUT_GATE_MS + 1;
    assert.equal(engine.outputGated, false);
    live.emit("audio", frame());
    assert.equal(audio.length, 1, "after the window, audio flows again");

    // A second interrupt and Kevin's voice: the gate ends the moment he speaks.
    await engine.command({ type: "interrupt" });
    assert.equal(engine.outputGated, true);
    live.emit("audio", frame());
    assert.equal(audio.length, 1, "gated");
    live.emit("inputTranscript", " never mind", 3000, 3400);
    assert.equal(engine.outputGated, false, "Kevin spoke: the gate is lifted");
    live.emit("audio", frame());
    assert.equal(audio.length, 2);
    assert.equal(engine.currentPhase, "listening");
  } finally {
    w.hands.release();
    w.handsBg.release();
    await engine.stop();
  }
});

test("interrupt with nothing running is harmless: a flush, a toast, the voice told, no delegation touched; asleep it says nothing is running", async () => {
  const w = world();
  const { engine, live, events, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    events.length = 0;
    await engine.command({ type: "interrupt" });
    assert.equal(brain.cancels, 0, "no delegation, no brain cancel");
    assert.equal(engine.snapshot().delegations.length, 0);
    assert.ok(events.some((e) => e.type === "speaker-flush"));
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"));
    assert.equal(live.instructions.filter((i) => /Kevin pressed stop/.test(i)).length, 1);
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.snapshot().session?.id, "sess_1");
    // Asleep: still harmless, and honest about it.
    await engine.command({ type: "sleep" });
    events.length = 0;
    await engine.command({ type: "interrupt" });
    assert.equal(engine.currentPhase, "asleep");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "nothing running"));
    assert.equal(rows<StopRow>(w, "stop").length, 1, "nothing to record asleep");
  } finally {
    await engine.stop();
  }
});

test("a spoken \"stop\" is an interrupt: the delegation is cancelled, the brain's cancel called, the pending hands request failed so nothing lands after it, a toast, one instruction, the gate set by the very words that asked for it — and the session stays", async () => {
  const w = world();
  const { engine, live, hands, handsBg, events, audio, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");

    delegate(w, "jarhead type my address", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    handsBg.hold = "frontmost";
    const typing = engine.toolset.run("type", { text: "hello again" }).catch(() => ({ kind: "error" as const, message: "threw" }));
    await settle();
    assert.ok(handsBg.named("frontmost").length > 0, "the gate probe is waiting on the reading helper");

    events.length = 0;
    live.instructions.length = 0;
    live.emit("inputTranscript", " stop", live.nowMs + 200, live.nowMs + 500);
    await settle();
    assert.equal(engine.snapshot().delegations[0]?.status, "cancelled");
    assert.equal(engine.snapshot().delegations[0]?.summary, "Kevin said stop");
    assert.equal(brain.cancels, 1, "the brain's cancel was called");
    assert.ok(events.some((e) => e.type === "speaker-flush"), "the speaker was flushed");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"), "a toast says stopped");
    assert.deepEqual(live.instructions, ["Kevin said stop. Stop speaking now and wait."], "one instruction, for the whole stop");
    assert.equal(engine.outputGated, true, "the gate is set — the 'stop' fragment itself does not lift it");
    assert.equal(live.currentState, "started", "the session stays open: a spoken stop is not the transport's stop");
    assert.equal(engine.snapshot().session?.id, "sess_1");
    assert.equal(rows<StopRow>(w, "stop")[0]?.how, "said");
    const outcome = await typing;
    assert.equal(outcome.kind, "error", "the typing that was waiting on the helper came back as an error");
    handsBg.release();
    await settle();
    assert.equal(hands.named("type").length, 0, "nothing was typed after the spoken stop");

    // The voice's sentence in flight is dropped; Kevin's next words lift the gate.
    audio.length = 0;
    live.emit("audio", frame());
    assert.equal(audio.length, 0);
    live.emit("inputTranscript", " ok now open safari", live.nowMs + 1500, live.nowMs + 2200);
    assert.equal(engine.outputGated, false);
    live.emit("audio", frame());
    assert.equal(audio.length, 1);
    clock.t += 10;
  } finally {
    w.hands.release();
    w.handsBg.release();
    await engine.stop();
  }
});

/**
 * Kevin: "once we press stop we can't wake; the stop button just stays there" and
 * "even though i pressed stop im still getting billed and time is still going up".
 * After a Stop during a running delegation: the delegation is cancelled before the
 * brain's (slow) cancel is awaited, the phase is asleep and the session closed
 * SYNCHRONOUSLY, the snapshot shows nothing running or awaiting and no session,
 * the pending confirmation is cleared, and wake / say-text / a new delegation work
 * at once on a fresh session — while the old brain's cancel is still in flight.
 */
test("stop aftermath: nothing is left running, armed or billed; asleep at once; and wake, say-text and a new delegation work on a new session while the brain's slow cancel is still settling", async () => {
  const w = world();
  const { engine, live, lives, hands, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead send the email", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    // The task asked a question (a Send needs a yes) — the confirmation is pending.
    engine.confirmations.ask("click Send in Mail", "left_click", { coordinate: [1, 2] });
    assert.ok(engine.confirmations.pending);
    // The brain's cancel takes a while (a Codex interrupt on a loaded Mac).
    let releaseCancel: (() => void) | undefined;
    const slowCancel = new Promise<void>((r) => (releaseCancel = r));
    const realBrain = (engine as unknown as { opts: { brain: { cancel: () => Promise<void> } } }).opts.brain;
    const originalCancel = realBrain.cancel;
    realBrain.cancel = async () => {
      brain.cancels++;
      await slowCancel;
    };

    const t0 = Date.now();
    const stopping = engine.command({ type: "stop" });
    // Before anything is awaited: asleep, no session, the session closed.
    assert.equal(engine.currentPhase, "asleep", "asleep synchronously");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(live.currentState, "closed");
    await stopping;
    assert.ok(Date.now() - t0 < 1700 * RUNNER_SLACK, `stop returned without waiting for the brain's cancel: under ${1700 * RUNNER_SLACK} ms (${Date.now() - t0} ms)`);
    const snap = engine.snapshot();
    assert.equal(snap.delegations.filter((d) => d.status === "running" || d.status === "awaiting-confirmation").length, 0, "nothing running or awaiting");
    assert.equal(snap.delegations[0]!.status, "cancelled");
    assert.equal(snap.delegations[0]!.summary, "Kevin pressed stop");
    assert.equal(engine.confirmations.pending, undefined, "the stopped task's question is not armed for a later yes");
    assert.equal(engine.outputGated, false, "no gate: there is no session to gate");
    assert.equal(engine.transportState, "asleep");

    // While the old cancel is still in flight: go opens a fresh session, say-text reaches it, a new delegation runs on it.
    await engine.command({ type: "go" });
    assert.equal(engine.currentPhase, "listening");
    assert.equal(lives.length, 2);
    const next = lives[1]!;
    assert.equal(engine.snapshot().session?.id, "sess_2");
    await engine.command({ type: "say-text", text: "open safari" });
    assert.ok(next.instructions.some((i) => /Kevin just typed/.test(i)));
    assert.equal(live.instructions.length, 0, "nothing went to the closed session");
    hands.ops.length = 0;
    nextUtterance(w);
    delegate(w, "jarhead scroll down", "item_2");
    await settle();
    const second = engine.snapshot().delegations.find((d) => d.liveId === "item_2")!;
    assert.equal(second.status, "done", "the reflex delegation ran and finished while the brain's cancel was pending");
    assert.equal(hands.named("scroll").length, 1);
    nextUtterance(w);
    delegate(w, "jarhead what is on my screen", "item_3");
    await settle();
    assert.equal(brain.tasks.length, 2, "a brain task was accepted too");
    releaseCancel?.();
    realBrain.cancel = originalCancel;
    await settle();
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_3")!.status, "running");
    // And sleep does not hang on a brain whose cancel never answers; the session is closed at once regardless.
    realBrain.cancel = () => new Promise<void>(() => undefined);
    const s0 = Date.now();
    const sleeping = engine.command({ type: "sleep" });
    assert.equal(next.currentState, "closed", "closed before the brain's cancel is awaited");
    await sleeping;
    assert.ok(Date.now() - s0 < 2000 * RUNNER_SLACK, `sleep is bounded even when the brain's cancel hangs: under ${2000 * RUNNER_SLACK} ms (${Date.now() - s0} ms)`);
    assert.equal(engine.currentPhase, "asleep");
    realBrain.cancel = originalCancel;
  } finally {
    await engine.stop();
  }
});

test("interrupt while threads run: every thread is cancelled quietly (its brain's cancel once), the parent is cancelled, the session stays open; thread.stop stops one thread with its one line and keeps the other", async () => {
  const w = world();
  const { engine, live, brain } = w;
  try {
    w.threads.script = async () => undefined;
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead tell ben on slack and play focus on spotify", "item_1");
    await settle();
    await engine.runner.run("thread_start", { name: "Spotify", task: "play Focus" });
    await engine.runner.run("thread_start", { name: "Slack", task: "tell Ben", lane: "screen" });
    await settle(50);
    const spawned = () => engine.snapshot().threads.filter((x) => x.id !== MAIN_THREAD_ID);
    assert.equal(spawned().length, 2);
    live.commentary.length = 0;
    // The Console's Stop on one row.
    await engine.command({ type: "thread.stop", threadId: spawned().find((x) => x.name === "Spotify")!.id });
    await until(() => live.commentary.length > 0, 1500);
    assert.equal(spawned().find((x) => x.name === "Spotify")!.status, "stopped");
    assert.equal(spawned().find((x) => x.name === "Slack")!.status, "thinking");
    assert.deepEqual(live.commentary, ["Spotify stopped."]);
    assert.equal(live.currentState, "started");
    // The spoken stop: everything.
    live.commentary.length = 0;
    await engine.command({ type: "interrupt", how: "said" });
    assert.equal(brain.cancels, 1);
    assert.deepEqual(spawned().map((x) => x.status), ["stopped", "stopped"]);
    assert.equal(w.threads.byName("Slack")!.cancels, 1);
    assert.equal(w.threads.byName("Spotify")!.cancels, 1, "cancelled once, whichever verb");
    assert.deepEqual(live.commentary, [], "a cut says nothing per thread");
    assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
    assert.equal(live.currentState, "started", "the session stays");
    assert.equal(rows<StopRow>(w, "stop").length, 1);
  } finally {
    await engine.stop();
  }
});
