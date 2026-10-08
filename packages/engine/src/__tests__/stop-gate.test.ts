import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrainSink } from "@jarhead/brain";
import type { EngineEvent, LedgerRow } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { current, delegate, rows, settle, until, world, type World } from "./world.ts";

/**
 * A Stop that stops, and an output gate that holds (W1-1; launch findings V1, V9, V10, V12).
 *
 * - V1: a brain turn running when the SERVER ends the session (an hour's expiry, a Wi-Fi change) is cut with the
 *   session; it never outlives its delegation, and a later Stop finds nothing attached to the runner.
 * - V10: the gate a spoken stop sets is lifted only by a new utterance that says something, or the lapse. Nothing
 *   inside the stop's own utterance lifts it, whatever follows the stop word ("Stop, Jarhead.", "Stop talking.",
 *   "Stop right there.", "Hold on a second."), and Live's late transcript of a stop the ear acted on is that utterance.
 * - V9: a "stop" heard only by Live while Jarhead is talking and nothing runs still cuts the voice locally. Talking is
 *   its transcript or its sound (LC-6), and only voice no stop has cut: after a press, "hold on, …" is not a second stop.
 * - V12: Pause inside the reconnect window, or during a handshake, is a pause: no paid session opens behind it.
 */

type StopRow = Extract<LedgerRow, { type: "stop" }>;
type PauseRow = Extract<LedgerRow, { type: "pause" }>;
type StartedRow = Extract<LedgerRow, { type: "session.started" }>;

const loud = (): Buffer => {
  const b = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) b.writeInt16LE(i % 2 ? 9000 : -9000, i * 2);
  return b;
};
const toasts = (events: EngineEvent[]): string[] => events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast").map((e) => e.text);

/** Kevin's words on Live's input transcript, one fragment at a time, 80 ms apart on both clocks. */
async function say(w: World, frags: readonly string[]): Promise<void> {
  const live = current(w);
  for (const frag of frags) {
    w.clock.t += 80;
    live.emit("inputTranscript", frag, live.nowMs, live.nowMs + 80);
    live.nowMs += 80;
    await settle(5);
  }
}

/** Five frames of the sentence still streaming from the voice: how many reached the speaker. */
async function framesPlayed(w: World): Promise<number> {
  const before = w.audio.length;
  for (let i = 0; i < 5; i++) current(w).emit("audio", loud());
  await settle(10);
  return w.audio.length - before;
}

/** The common ways to say stop. Each begins with a stop phrase; what follows is still the stop's own utterance. */
const STOPS = [
  [" Stop", " talking."],
  [" Stop", " right", " there."],
  [" Hold on", " a second."],
] as const;

test("V1: a task running when the server drops the session is cut with it — aborted, the brain's cancel called, the runner let go — the reconnect says so, and Stop finds nothing left", async () => {
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
    assert.equal(engine.runner.attached, true, "the brain's turn is attached to the runner");

    current(w).serverClosed("connection_lost", 40);
    assert.equal(task.signal.aborted, true, "the turn is aborted at the drop, not left running under no delegation");
    assert.equal(engine.runner.attached, false, "the daemon's tool.run guard refuses the dead turn's calls");
    await until(() => w.lives.length === 2 && w.lives[1]!.currentState === "started", 3000);
    assert.equal(brain.cancels, 1, "the brain's own cancel (turn/interrupt for Codex) was called once");
    const cut = engine.snapshot().delegations.find((d) => d.request.includes("quarterly report"));
    assert.equal(cut?.status, "cancelled");
    assert.equal(cut?.summary, "the voice connection dropped");
    assert.match(w.lives[1]!.config?.instructions ?? "", /The drop cut the task that was running \("jarhead send the quarterly report to Ben"\)/, "the new session's continuity says the task was cut");

    await engine.command({ type: "stop" });
    await settle(50);
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.runner.attached, false);
    assert.equal(brain.cancels, 1, "nothing was left for Stop to cancel");
  } finally {
    brain.resolve?.({ status: "cancelled" });
    await engine.stop();
  }
});

test("V1 after LC-7: a room refusal kept after the task a drop cut does not take its place; the reconnect still names the cut task", () => {
  const w = world();
  const engine = w.engine as unknown as { lastDelegations: readonly unknown[]; continuityFor(pause: { at: number; sessionId?: string }, how: string): string };
  const base = { offsetMs: 0, timings: {}, steps: [] };
  engine.lastDelegations = [
    { ...base, id: "d1", liveId: "item_1", request: "jarhead send the quarterly report to Ben", status: "cancelled", summary: Engine.CONNECTION_DROPPED },
    { ...base, id: "d2", liveId: "item_room_wait", request: "scroll down a bit", status: "cancelled", summary: "not addressed: the session ended before a name came" },
  ];
  const text = engine.continuityFor({ at: w.clock.t - 5000 }, "reconnected");
  assert.match(text, /The drop cut the task that was running \("jarhead send the quarterly report to Ben"\)/);
  assert.doesNotMatch(text, /Last task: "scroll down a bit"/);
});

test("V1: a brain turn the runner still carries with no delegation behind it (a turn that ignored its abort) is cancelled and let go by Stop", async () => {
  const w = world();
  const { engine, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // An out-of-process brain's turn still attached after its delegation went with a dropped session.
    engine.runner.attach({} as BrainSink);
    assert.equal(engine.runner.attached, true);
    await engine.command({ type: "stop" });
    await settle(30);
    assert.equal(brain.cancels, 1, "Stop cancels the brain's turn though no delegation runs");
    assert.equal(engine.runner.attached, false, "and lets the runner go");
    assert.equal(engine.currentPhase, "asleep");
  } finally {
    await engine.stop();
  }
});

test("V10a: the ear's stop gates the voice; Live's late transcript of the same 'stop' does not lift the gate, and the interrupted sentence stays silent", async () => {
  const w = world();
  const { engine, clock, audio } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    live.emit("outputTranscript", " Your next meeting is at three, with the design team,", live.nowMs, live.nowMs + 800);
    live.nowMs += 800;
    live.emit("audio", loud());
    clock.t += 150;
    engine.ear("stop", true, 1, clock.t);
    await settle(20);
    assert.equal(engine.outputGated, true, "gated by the stop");
    const before = audio.length;
    clock.t += 600;
    live.emit("inputTranscript", " Stop.", live.nowMs, live.nowMs + 300);
    live.nowMs += 300;
    clock.t += 200;
    for (let i = 0; i < 5; i++) live.emit("audio", loud());
    await settle(10);
    assert.equal(audio.length - before, 0, "Live's transcript of the stop word is not new speech");
    assert.equal(engine.outputGated, true);
    // Kevin then says something new: that lifts it.
    clock.t += 300;
    live.nowMs += 2000;
    live.emit("inputTranscript", " what's the weather", live.nowMs, live.nowMs + 600);
    assert.equal(engine.outputGated, false, "new words lift the gate");
  } finally {
    await engine.stop();
  }
});

test("V10b: on Live's path, 'Stop, Jarhead.' — the fragments after 'stop' are the same utterance and do not lift the gate the stop just set", async () => {
  const w = world();
  const { engine, brain, clock, audio } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead find the invoice from march", "item_1");
    await until(() => brain.tasks.length === 1);
    const live = current(w);
    live.nowMs += 3000;
    live.emit("outputTranscript", " Looking for the March invoice in your mail now,", live.nowMs, live.nowMs + 800);
    live.nowMs += 800;
    for (const frag of [" Stop", ",", " Jar", "head."]) {
      clock.t += 80;
      live.emit("inputTranscript", frag, live.nowMs, live.nowMs + 80);
      live.nowMs += 80;
      await settle(5);
    }
    const before = audio.length;
    clock.t += 100;
    for (let i = 0; i < 5; i++) live.emit("audio", loud());
    await settle(10);
    assert.equal(brain.tasks[0]!.signal.aborted, true, "the stop cut the task");
    assert.equal(audio.length - before, 0, "the rest of the stop utterance did not lift the gate");
    assert.equal(rows<StopRow>(w, "stop").length, 1);
  } finally {
    brain.resolve?.({ status: "cancelled" });
    await engine.stop();
  }
});

for (const frags of STOPS) {
  const said = frags.join("").trim();
  test(`V10b: on Live's path, "${said}" cuts the task and the rest of the stop's utterance does not lift the gate; his next utterance does`, async () => {
    const w = world();
    const { engine, brain } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      delegate(w, "jarhead find the invoice from march", "item_1");
      await until(() => brain.tasks.length === 1);
      const live = current(w);
      live.nowMs += 3000;
      live.emit("outputTranscript", " Looking for the March invoice in your mail now,", live.nowMs, live.nowMs + 800);
      live.nowMs += 800;
      await say(w, frags);
      w.clock.t += 100;
      assert.equal(brain.tasks[0]!.signal.aborted, true, "the stop cut the task");
      assert.equal(await framesPlayed(w), 0, "the interrupted sentence stays silent");
      assert.equal(engine.outputGated, true);
      // A new utterance that says something lifts it at once.
      live.nowMs += 2000;
      live.emit("inputTranscript", " what's the weather", live.nowMs, live.nowMs + 600);
      assert.equal(engine.outputGated, false, "his next words lift the gate");
    } finally {
      brain.resolve?.({ status: "cancelled" });
      await engine.stop();
    }
  });
}

test("V10b: the voice's own transcript arriving between the stop's fragments splits the utterance on the record, and the rest still does not lift the gate", async () => {
  const w = world();
  const { engine, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead find the invoice from march", "item_1");
    await until(() => brain.tasks.length === 1);
    const live = current(w);
    live.nowMs += 3000;
    live.emit("outputTranscript", " Looking for the March invoice", live.nowMs, live.nowMs + 600);
    live.nowMs += 600;
    await say(w, [" Stop"]);
    assert.equal(engine.outputGated, true);
    // The sentence the gate is dropping goes on the record between his words.
    live.emit("outputTranscript", " in your mail now,", live.nowMs, live.nowMs + 300);
    clock.t += 300;
    live.nowMs += 300;
    live.emit("inputTranscript", " talking.", live.nowMs, live.nowMs + 200);
    live.nowMs += 200;
    await settle(5);
    assert.equal(await framesPlayed(w), 0, "the rest of the stop's utterance is not new speech");
    assert.equal(engine.outputGated, true);
  } finally {
    brain.resolve?.({ status: "cancelled" });
    await engine.stop();
  }
});

for (const said of [" Stop talking.", " Hold on a second.", " Stop right there."]) {
  test(`V10a: the ear's stop, and Live's transcript of it 1.1 s later as ${JSON.stringify(said.trim())}: the gate holds and the interrupted sentence stays silent`, async () => {
    const w = world();
    const { engine, clock } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      const live = current(w);
      live.emit("outputTranscript", " Your next meeting is at three, with the design team,", live.nowMs, live.nowMs + 800);
      live.nowMs += 800;
      live.emit("audio", loud());
      clock.t += 150;
      engine.ear("stop", true, 1, clock.t);
      await settle(20);
      assert.equal(engine.outputGated, true, "gated by the stop");
      clock.t += 1100;
      live.emit("inputTranscript", said, live.nowMs, live.nowMs + 300);
      live.nowMs += 300;
      clock.t += 200;
      assert.equal(await framesPlayed(w), 0, "Live's transcript of the stop is the stop's own utterance, not new speech");
      assert.equal(engine.outputGated, true);
    } finally {
      await engine.stop();
    }
  });
}

test("V10a: Live's late transcript of the ear's stop in fragments that begin with the name (\"Jar\", \"head,\", \"stop\", \"talking.\") does not lift the gate", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    live.emit("outputTranscript", " Your next meeting is at three, with the design team,", live.nowMs, live.nowMs + 800);
    live.nowMs += 800;
    live.emit("audio", loud());
    clock.t += 150;
    engine.ear("stop", true, 1, clock.t);
    await settle(20);
    clock.t += 700;
    await say(w, [" Jar", "head,", " stop", " talking."]);
    assert.equal(await framesPlayed(w), 0);
    assert.equal(engine.outputGated, true);
  } finally {
    await engine.stop();
  }
});

test("the gate after a pressed stop: punctuation alone is not speech; Kevin's next words lift it as before", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await engine.command({ type: "interrupt" });
    assert.equal(engine.outputGated, true);
    live.emit("inputTranscript", ".", live.nowMs, live.nowMs + 50);
    assert.equal(engine.outputGated, true, "a lone punctuation fragment is not speech");
    live.emit("inputTranscript", " never mind", live.nowMs + 100, live.nowMs + 500);
    assert.equal(engine.outputGated, false, "his words lift it");
  } finally {
    await engine.stop();
  }
});

for (const reflexes of [true, false]) {
  test(`V9: Live hears "stop" while the voice speaks and nothing runs (ear silent, reflexes ${reflexes ? "on" : "off"}) — the voice is gated and flushed and a stop row is written`, async () => {
    const w = world();
    const { engine, events, clock, audio } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0, reflexes });
      await engine.wake("test");
      const live = current(w);
      live.emit("outputTranscript", " The weather in London today is mild,", live.nowMs, live.nowMs + 600);
      live.nowMs += 600;
      live.emit("audio", loud());
      const flushesBefore = events.filter((e) => e.type === "speaker-flush").length;
      clock.t += 300;
      live.emit("inputTranscript", " stop", live.nowMs, live.nowMs + 300);
      live.nowMs += 300;
      await settle(30);
      assert.ok(events.filter((e) => e.type === "speaker-flush").length > flushesBefore, "the speaker was flushed");
      assert.equal(engine.outputGated, true, "the voice is gated");
      assert.deepEqual(rows<StopRow>(w, "stop").map((r) => r.how), ["said"], "one stop row");
      assert.notEqual(engine.currentPhase, "speaking");
      // The rest of the same utterance ("…, jarhead.") does not lift it; the sentence in flight stays silent.
      clock.t += 80;
      live.emit("inputTranscript", ", jarhead.", live.nowMs, live.nowMs + 200);
      live.nowMs += 200;
      const before = audio.length;
      for (let i = 0; i < 3; i++) live.emit("audio", loud());
      assert.equal(audio.length - before, 0);
      assert.equal(rows<StopRow>(w, "stop").length, 1, "the same utterance writes no second row");
      assert.equal(live.currentState, "started", "the session stays open");
    } finally {
      await engine.stop();
    }
  });
}

for (const frags of STOPS) {
  test(`V9: ${JSON.stringify(frags.join("").trim())} over the voice with nothing running: the voice is cut and the rest of the utterance does not bring it back`, async () => {
    const w = world();
    const { engine } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      const live = current(w);
      live.emit("outputTranscript", " The weather in London today is mild,", live.nowMs, live.nowMs + 600);
      live.nowMs += 600;
      live.emit("audio", loud());
      await say(w, frags);
      w.clock.t += 100;
      assert.equal(await framesPlayed(w), 0);
      assert.equal(engine.outputGated, true);
      assert.equal(rows<StopRow>(w, "stop").length, 1, "one stop row for the utterance");
    } finally {
      await engine.stop();
    }
  });
}

test("V9: 'can you stop by the store' over the voice gates on 'stop'; the rest of the same utterance cannot be told from 'can you stop talking' and does not lift it; the lapse does, and the answer then plays", async () => {
  const w = world();
  const { engine, clock, audio } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    live.emit("outputTranscript", " Here is what I found,", live.nowMs, live.nowMs + 600);
    live.nowMs += 600;
    clock.t += 300;
    for (const frag of [" can you", " stop", " by the store"]) {
      live.emit("inputTranscript", frag, live.nowMs, live.nowMs + 200);
      live.nowMs += 200;
      clock.t += 100;
    }
    assert.equal(engine.outputGated, true, "the rest of the stop's utterance does not lift the gate");
    clock.t += Engine.OUTPUT_GATE_MS;
    const before = audio.length;
    live.emit("audio", loud());
    assert.equal(audio.length - before, 1, "after the lapse the answer plays");
  } finally {
    await engine.stop();
  }
});

test("V9 control: nobody speaking, nothing running — a 'stop' on Live's transcript gates nothing and writes nothing", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    clock.t += 5000;
    live.emit("inputTranscript", " stop", live.nowMs, live.nowMs + 300);
    await settle(20);
    assert.equal(engine.outputGated, false);
    assert.equal(rows<StopRow>(w, "stop").length, 0);
  } finally {
    await engine.stop();
  }
});

/** 100 ms of PCM16 at 24 kHz, as Live's deltas, at ±amp. */
const delta100 = (amp: number): Buffer => {
  const b = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b;
};

/**
 * LC-6 (live, 2026-10-06 00:19) replayed on the engine's clock. A story's last output-transcript delta, its sound
 * audible until `soundAgeMs` before the stop, the API's silence frames after it, then Live's " Stop" fragment
 * `transcriptAgeMs` after that delta. Then what Live sends inside the gate: 2.2 s of frames, silence with a
 * two-frame "Stopped." in it.
 */
async function lateStop(transcriptAgeMs: number, soundAgeMs: number): Promise<{ gated: boolean; stopRows: StopRow[]; playedInGate: number }> {
  const w = world();
  const { engine, clock, audio } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    const t0 = clock.t;
    live.emit("outputTranscript", " where the tides kept their own calendar", live.nowMs, live.nowMs + 200);
    // Live's barge-in cuts its transcript stream first; the sound of the words in flight plays on.
    const soundUntil = transcriptAgeMs - soundAgeMs;
    const frames = new Map<number, boolean>();
    for (let at = 0; at < transcriptAgeMs; at += 100) frames.set(at, at <= soundUntil);
    if (soundUntil >= 0) frames.set(soundUntil, true);
    for (const at of [...frames.keys()].sort((a, b) => a - b)) {
      clock.t = t0 + at;
      live.emit("audio", delta100(frames.get(at) ? 6000 : 0));
    }
    clock.t = t0 + transcriptAgeMs;
    live.nowMs += transcriptAgeMs;
    live.emit("inputTranscript", " Stop", live.nowMs, live.nowMs + 200);
    live.nowMs += 200;
    await settle(20);
    const gated = engine.outputGated;
    const before = audio.length;
    for (let i = 0; i < 22; i++) {
      clock.t += 100;
      live.emit("audio", delta100(i === 17 || i === 18 ? 6000 : 0));
    }
    return { gated, stopRows: rows<StopRow>(w, "stop"), playedInGate: audio.length - before };
  } finally {
    await engine.stop();
  }
}

test("V9 (LC-6 trial 2): a stop said over the voice whose transcript Live's barge-in cut 1322 ms before the fragment, its sound audible until 490 ms before, gates; nothing plays inside the gate", async () => {
  const r = await lateStop(1322, 490);
  assert.equal(r.gated, true, "the gate is set at the fragment");
  assert.deepEqual(r.stopRows.map((x) => x.how), ["said"], "exactly one stop row");
  assert.equal(r.playedInGate, 0, "0 frames reach the speaker inside the gate: Live's silence and its 'Stopped.' alike");
});

test("V9 (LC-6 trials 1 and 3 shape): the transcript 915 ms old and the sound 110 ms old at the fragment gates", async () => {
  const r = await lateStop(915, 110);
  assert.equal(r.gated, true);
  assert.equal(r.stopRows.length, 1);
  assert.equal(r.playedInGate, 0);
});

test("V9 control (LC-6): no sound and no transcript for 1.5 s before a 'stop' gates nothing and writes nothing", async () => {
  const r = await lateStop(1500, 1500);
  assert.equal(r.gated, false);
  assert.equal(r.stopRows.length, 0);
});

/**
 * A pressed stop, then Kevin's next words `afterMs` later. The voice's transcript is 1 s old at the press and its sound
 * plays up to the press. The press cut that voice, so nothing is audible when he speaks: a stop phrase at the head of
 * his words ("hold on, what time is it") lifts the press's gate and is not a second stop, on Live's path or the ear's.
 */
async function pressedThenHoldOn(afterMs: number, path: "live" | "ear"): Promise<{ gated: boolean; stopRows: StopRow[]; stopped: number }> {
  const w = world();
  const { engine, clock, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    live.emit("outputTranscript", " and the tide came in again", live.nowMs, live.nowMs + 200);
    const t0 = clock.t;
    for (let at = 0; at <= 1000; at += 100) {
      clock.t = t0 + at;
      live.emit("audio", loud());
    }
    events.length = 0;
    await engine.command({ type: "interrupt" });
    assert.equal(engine.outputGated, true, "the press gates the voice");
    clock.t += afterMs;
    live.nowMs += 1000 + afterMs;
    if (path === "live") {
      live.emit("inputTranscript", " hold on, what time is it", live.nowMs, live.nowMs + 300);
    } else {
      // Live's transcript of his first word lifts the press's gate; the ear's "hold on" lands after it.
      live.emit("inputTranscript", " So", live.nowMs, live.nowMs + 100);
      engine.ear("hold on", false, 7, clock.t);
    }
    await settle(20);
    return { gated: engine.outputGated, stopRows: rows<StopRow>(w, "stop"), stopped: toasts(events).filter((t) => t === "stopped").length };
  } finally {
    await engine.stop();
  }
}

test("V9 after a press: 'hold on, …' said 300 ms or 1.1 s after a pressed stop is not a second stop; the press already cut the voice, so its sound before the press is not speech said over", async () => {
  for (const afterMs of [300, 1100]) {
    for (const path of ["live", "ear"] as const) {
      const r = await pressedThenHoldOn(afterMs, path);
      assert.equal(r.gated, false, `${path} +${afterMs} ms: his words lift the press's gate and nothing re-gates the answer`);
      assert.deepEqual(r.stopRows.map((x) => x.how), ["pressed"], `${path} +${afterMs} ms: one stop row`);
      assert.equal(r.stopped, 1, `${path} +${afterMs} ms: one 'stopped' toast`);
    }
  }
});

test("V9 after a press, control: once the voice speaks again, a 'hold on' said over that new speech is a stop", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const live = current(w);
    live.emit("outputTranscript", " and the tide came in again", live.nowMs, live.nowMs + 200);
    live.emit("audio", loud());
    await engine.command({ type: "interrupt" });
    clock.t += 300;
    live.nowMs += 2000;
    live.emit("inputTranscript", " what was that", live.nowMs, live.nowMs + 300);
    assert.equal(engine.outputGated, false, "his words lift the press's gate");
    // The voice answers him: new sound, after the gate.
    clock.t += 400;
    live.emit("audio", loud());
    clock.t += 300;
    live.nowMs += 3000;
    live.emit("inputTranscript", " hold on", live.nowMs, live.nowMs + 200);
    await settle(20);
    assert.equal(engine.outputGated, true, "said over the new answer: gated");
    assert.deepEqual(rows<StopRow>(w, "stop").map((x) => x.how), ["pressed", "said"]);
  } finally {
    await engine.stop();
  }
});

test("V12: Pause inside the reconnect window holds the conversation the server cut — no new paid session, 'paused · meter stopped' — and Go resumes it once", async () => {
  const w = world();
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    current(w).serverClosed("connection_lost", 30);
    await settle(100);
    await engine.command({ type: "pause" });
    assert.equal(engine.transportState, "paused");
    assert.ok(toasts(events).includes("paused · meter stopped"), `toasts: ${JSON.stringify(toasts(events).slice(-3))}`);
    await settle(700);
    assert.equal(w.lives.length, 1, "no new paid session after Kevin pressed Pause");
    assert.equal(engine.transportState, "paused");
    assert.equal(engine.currentPhase, "paused");
    assert.deepEqual(rows<PauseRow>(w, "pause").map((r) => r.sessionId), ["sess_1"]);
    assert.equal(engine.snapshot().problems.some((p) => /reconnecting/.test(p.text)), false, "the reconnect row is over");

    await engine.command({ type: "go" });
    assert.equal(w.lives.length, 2, "Go opens exactly one session");
    assert.equal(engine.transportState, "awake");
    const started = rows<StartedRow>(w, "session.started");
    assert.equal(started.at(-1)?.resumedFrom, "sess_1", "the held conversation is carried on");
    assert.match(w.lives[1]!.config?.instructions ?? "", /# Continuity/);
  } finally {
    await engine.stop();
  }
});

test("V12: Pause during a handshake closes the session the moment it starts and holds the pause; Go then resumes once", async () => {
  const w = world();
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    const waking = engine.wake("test");
    assert.equal(engine.transportState, "connecting");
    await engine.command({ type: "pause" });
    await waking;
    assert.equal(engine.transportState, "paused");
    assert.equal(w.lives[0]!.currentState, "closed", "the session that started is closed at once");
    assert.ok(toasts(events).includes("paused · meter stopped"));
    assert.deepEqual(rows<PauseRow>(w, "pause").map((r) => r.sessionId), ["sess_1"]);
    await settle(50);
    assert.equal(w.lives.length, 1);

    await engine.command({ type: "go" });
    assert.equal(w.lives.length, 2);
    assert.equal(engine.transportState, "awake");
    assert.equal(rows<StartedRow>(w, "session.started").at(-1)?.resumedFrom, "sess_1");
  } finally {
    await engine.stop();
  }
});

test("V12: Pause then Go inside one handshake keeps the session — awake, one session, nothing held", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    const waking = engine.wake("test");
    const pausing = engine.command({ type: "pause" });
    const going = engine.command({ type: "go" });
    await Promise.all([waking, pausing, going]);
    await settle(20);
    assert.equal(engine.transportState, "awake");
    assert.equal(w.lives.length, 1);
    assert.equal(w.lives[0]!.currentState, "started");
    assert.equal(rows<PauseRow>(w, "pause").length, 0);
  } finally {
    await engine.stop();
  }
});

test("V12: Stop after a pause pressed during the handshake wins — asleep, nothing held", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    // Both presses land inside the same handshake, before session.started.
    const waking = engine.wake("test");
    const pausing = engine.command({ type: "pause" });
    const stopping = engine.command({ type: "stop" });
    await Promise.all([waking, pausing, stopping]);
    await settle(20);
    assert.equal(engine.transportState, "asleep");
    assert.notEqual(w.lives[0]!.currentState, "started", "no session is left open");
    assert.equal(rows<PauseRow>(w, "pause").length, 0, "nothing is held");
    assert.equal(w.lives.length, 1);
  } finally {
    await engine.stop();
  }
});
