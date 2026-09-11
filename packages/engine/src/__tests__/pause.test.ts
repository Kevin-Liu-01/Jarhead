import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../engine.ts";
import { delegate, frame, nextUtterance, settle, world } from "./world.ts";

/**
 * Pause: the session stays open but Jarhead goes silent and still — the mic is
 * muted at Live and dropped locally, output is gated for as long as the pause
 * lasts, the running task is cancelled and new delegations are refused (recorded
 * as "paused"), the voice is told once, the phase reads "paused". Resume undoes
 * exactly that. Asleep, pause only says so. Idle-sleep keeps counting.
 */

test("pause during a running task: mic muted and dropped, output gated indefinitely, the task cancelled, new delegations refused as paused, phase paused, one instruction, ledger rows; resume restores everything", async () => {
  const w = world();
  const { engine, live, hands, events, audio, brain, clock } = w;
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

    events.length = 0;
    live.instructions.length = 0;
    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    assert.equal(engine.currentPhase, "paused");
    assert.deepEqual(live.mutes, ["mute"]);
    assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
    assert.equal(engine.snapshot().delegations[0]!.summary, "paused");
    assert.equal(brain.cancels, 1);
    assert.deepEqual(live.instructions, ["Kevin paused you. Stay silent until he resumes."]);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "paused"));
    assert.ok(events.some((e) => e.type === "speaker-flush"));
    // Mic frames are dropped locally too; output frames never reach the speaker, however long the pause lasts.
    engine.feedMic(frame());
    assert.equal(live.audioIn, 1, "mic dropped while paused");
    audio.length = 0;
    live.emit("audio", frame());
    clock.t += Engine.OUTPUT_GATE_MS * 10;
    live.emit("audio", frame());
    live.emit("outputTranscript", " I found it", 2000, 2400);
    assert.equal(audio.length, 0, "the gate is held open for the whole pause");
    assert.equal(engine.currentPhase, "paused");
    // Kevin's own words do not lift a pause's gate (Live is muted anyway; a straggling delta must not either).
    live.emit("inputTranscript", " hello", 2500, 2800);
    live.emit("audio", frame());
    assert.equal(audio.length, 0);
    // A delegation while paused is recorded and refused; the brain never sees it.
    nextUtterance(w);
    delegate(w, "jarhead open safari", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 1, "no new task reached the brain");
    const refused = engine.snapshot().delegations.find((d) => d.liveId === "item_2")!;
    assert.equal(refused.status, "cancelled");
    assert.equal(refused.summary, "paused");
    assert.ok(refused.steps.some((s) => /not run: paused/.test(s.text ?? "")));
    assert.equal(hands.named("open_app").length, 0);
    // The ear is off while paused.
    engine.ear("scroll down", true, 1, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 0);
    // Ledger: a pause row.
    const rows = engine.ledger.read(clock.t) as unknown as { type: string }[];
    assert.ok(rows.some((r) => r.type === "pause"));

    // Resume.
    events.length = 0;
    live.instructions.length = 0;
    await engine.command({ type: "resume" });
    assert.equal(engine.isPaused, false);
    assert.equal(engine.currentPhase, "listening");
    assert.deepEqual(live.mutes, ["mute", "unmute"]);
    assert.deepEqual(live.instructions, ["Kevin resumed. Carry on as before; do not recap what you were doing unless he asks."]);
    assert.ok(events.some((e) => e.type === "toast" && e.text === "resumed"));
    live.emit("audio", frame());
    assert.equal(audio.length, 1, "audio flows again");
    engine.feedMic(frame());
    assert.equal(live.audioIn, 2);
    nextUtterance(w);
    delegate(w, "jarhead what is on my screen", "item_3");
    await settle();
    assert.equal(brain.tasks.length, 2, "delegations run again");
    assert.ok((engine.ledger.read(clock.t) as unknown as { type: string }[]).some((r) => r.type === "resume"));
    // Resume twice is harmless.
    await engine.command({ type: "resume" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "not paused"));
  } finally {
    await engine.stop();
  }
});

test("pause keeps Kevin's own mute; pause while asleep only says so; idle-sleep keeps counting while paused and wakes unpaused", async () => {
  const w = world();
  const { engine, live, events, clock } = w;
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
    assert.deepEqual(live.mutes, ["mute", "mute"], "resume did not unmute a mic Kevin muted");
    engine.setMuted(false);

    // Idle-sleep: a pause is not attention. One tick past the idle window while paused → asleep, unpaused.
    await engine.command({ type: "pause" });
    clock.t += 61_000;
    (engine as unknown as { tick(): void }).tick();
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.isPaused, false);
    // Waking again starts clean: audio flows, nothing gated.
    await engine.wake("test");
    assert.equal(engine.currentPhase, "listening");
    assert.equal(engine.outputGated, false);
  } finally {
    await engine.stop();
  }
});

test("`jarhead cmd pause|resume` shapes: the engine commands are accepted by the command switch", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    await engine.command({ type: "pause" });
    assert.equal(engine.currentPhase, "paused");
    await engine.command({ type: "resume" });
    assert.equal(engine.currentPhase, "listening");
  } finally {
    await engine.stop();
  }
});
