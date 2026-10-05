import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { current, delegate, rows, settle, until, world, type World } from "./world.ts";

/**
 * One attention clock (W1-1; launch findings V13, WG-1, WG-3, WG-8, RAIL-14, RF-2's engine half; decision D1).
 *
 * The idle sleep is "10 min without an ADDRESSED turn". Live transcribes whatever the microphone hears — a TV,
 * a call on the speakers, two people talking — so a Live input delta is presence (Kevin may be in the room),
 * never attention. The addressed clock moves only on: Live's delegation, Jarhead's own speech, a typed line,
 * dictation, an ear reflex that ran, words that name Jarhead, and a Go / wake / resume Kevin pressed. A
 * reconnect after the server dropped the session carries the clock; it does not restart it. Whatever is
 * running, a session with no addressed turn for 30 minutes sleeps, and so does one whose idle setting is not a
 * number (D1); a longer setting is honoured, and an explicit 0 is idle sleep off.
 */

type SleepRow = Extract<LedgerRow, { type: "sleep" }>;
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
/** The presence clock (`presenceAt` for the policy's presence gate): private, read for the RAIL-14 pin. */
const presenceAt = (engine: Engine): number => (engine as unknown as { lastKevinAt: number }).lastKevinAt;

/** `minutes` of ticks, one a second of engine clock, with `each(minute)` called at the top of every minute. */
function runMinutes(w: World, minutes: number, each?: (minute: number) => void): void {
  for (let m = 0; m < minutes; m++) {
    each?.(m);
    for (let s = 0; s < 60; s++) {
      w.clock.t += 1000;
      tick(w.engine);
    }
  }
}

/** One sentence of room talk on Live's input transcript (a TV, a podcast): never addressed, never answered, never delegated. */
function roomTalk(w: World, text: string): void {
  const live = current(w);
  const s = live.nowMs;
  live.nowMs += 2500;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  live.nowMs += 3000;
}

test("control: a quiet room sleeps after idleSleepMinutes (10), with the pre-sleep clause first", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.wake("test");
    runMinutes(w, 9);
    assert.equal(engine.transportState, "awake", "nine quiet minutes: still awake");
    runMinutes(w, 2);
    await settle();
    assert.ok(live.instructions.some((i) => /going to sleep in about 5 seconds/.test(i)), "the pre-sleep clause");
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(live.currentState, "closed");
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => r.cause), ["idle"]);
  } finally {
    await engine.stop();
  }
});

test("V13 / WG-1: thirty minutes of room talk nobody addressed to Jarhead (a fragment every 20 s) does not hold the paid session open past the 10-minute idle sleep", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.wake("test");
    const startedAt = clock.t;
    let asleepAt: number | undefined;
    for (let s = 0; s < 30 * 60; s++) {
      clock.t += 1000;
      if (s % 20 === 0) roomTalk(w, "and that is why the market moved the way it did");
      tick(engine);
      if (engine.transportState !== "awake" && asleepAt === undefined) asleepAt = clock.t;
    }
    await settle();
    assert.notEqual(engine.transportState, "awake", "10 minutes with no addressed turn put it to sleep");
    assert.ok(asleepAt !== undefined && asleepAt - startedAt <= 10 * 60_000 + 2000, `asleep ${Math.round(((asleepAt ?? clock.t) - startedAt) / 1000)} s after the wake`);
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => r.cause), ["idle"]);
    assert.equal(engine.snapshot().delegations.length, 0, "nothing was delegated");
  } finally {
    await engine.stop();
  }
});

test("WG-1, a TV once a minute: asleep after the idle sleep; the room's words are presence (the policy's presence gate), never attention", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.wake("test");
    let heardAt = 0;
    runMinutes(w, 30, (m) => {
      if (engine.transportState !== "awake") return;
      roomTalk(w, `and in other news the weather turns cold this weekend (${m})`);
      heardAt = w.clock.t;
    });
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(live.currentState, "closed");
    assert.equal(presenceAt(engine), heardAt, "Live's input transcript still stamps presence");
  } finally {
    await engine.stop();
  }
});

test("LC-7 in the world: idle 1 min with room talk every 15 s — the pre-sleep clause comes ~55 s and the sleep ~60 s after the last addressed turn while the talk goes on, and no 'goodnight' said to someone else sleeps it", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 1 });
    await engine.wake("test");
    const t0 = clock.t;
    let clauseAt: number | undefined;
    let asleepAt: number | undefined;
    for (let s = 1; s <= 90 && asleepAt === undefined; s++) {
      clock.t += 1000;
      if (s % 15 === 0) roomTalk(w, s === 45 ? "okay I'm heading out, goodnight" : "so anyway the meeting ran long again");
      // The ear hears the same goodbye a beat later, as its own segment.
      if (s === 46) engine.ear("goodnight", true, s, clock.t);
      tick(engine);
      if (clauseAt === undefined && live.instructions.some((i) => /going to sleep in about 5 seconds/.test(i))) clauseAt = clock.t;
      if (engine.transportState !== "awake") asleepAt = clock.t;
    }
    await settle(150);
    assert.ok(clauseAt !== undefined && clauseAt - t0 >= 54_000 && clauseAt - t0 <= 57_000, `the clause at ${clauseAt === undefined ? "never" : `${(clauseAt - t0) / 1000} s`}`);
    assert.ok(asleepAt !== undefined && asleepAt - t0 >= 59_000 && asleepAt - t0 <= 62_000, `asleep at ${asleepAt === undefined ? "never" : `${(asleepAt - t0) / 1000} s`}`);
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => [r.cause, r.phrase]), [["idle", undefined]], "the idle sleep, not a 'said goodnight'");
  } finally {
    await engine.stop();
  }
});

test("WG-3: a 'goodnight' said to someone in the room, heard by Live's transcript AND the ear well after any exchange, does not sleep it", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    clock.t += 30_000;
    live.nowMs += 30_000;
    const s = live.nowMs;
    live.nowMs += 1500;
    live.emit("inputTranscript", " okay I'm heading out", s, live.nowMs);
    clock.t += 2000;
    live.nowMs += 2000;
    live.emit("inputTranscript", " goodnight", live.nowMs - 600, live.nowMs);
    engine.ear("goodnight", true, 7, clock.t);
    await settle(150);
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => [r.cause, r.phrase]), [], "room talk never sleeps it");
    assert.equal(live.currentState, "started");
  } finally {
    await engine.stop();
  }
});

test("control: a 'goodnight' mid-exchange (Jarhead spoke 3 s ago) still sleeps it, and so does 'goodnight jarhead' at any time", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    clock.t += 30_000;
    live.emit("outputTranscript", " here you go.", live.nowMs, live.nowMs + 300);
    live.nowMs += 300;
    clock.t += 3000;
    engine.ear("goodnight", true, 1, clock.t);
    await until(() => rows<SleepRow>(w, "sleep").length === 1, 1000);
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => [r.cause, r.phrase]), [["said", "goodnight"]]);
    live.emit("outputTranscript", " night.", live.nowMs, live.nowMs + 300);
    await until(() => engine.currentPhase === "asleep", 2500);

    await engine.wake("test");
    const second = current(w);
    clock.t += 60_000;
    engine.ear("goodnight jarhead.", true, 2, clock.t);
    await until(() => rows<SleepRow>(w, "sleep").length === 2, 1000);
    assert.equal(rows<SleepRow>(w, "sleep")[1]!.cause, "said");
    second.emit("outputTranscript", " night.", second.nowMs, second.nowMs + 300);
    await until(() => engine.currentPhase === "asleep", 2500);
  } finally {
    await engine.stop();
  }
});

test("WG-8: a session the network drops every 6 min is reconnected with the idle clock carried — nobody speaks for 30 min and it sleeps 10 min after the wake", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.wake("test");
    const t0 = clock.t;
    for (let i = 0; i < 5; i++) {
      runMinutes(w, 6);
      if (engine.currentPhase === "asleep") break;
      current(w).serverClosed("connection_lost", 60);
      await until(() => current(w).currentState === "started" && engine.transportState === "awake", 3000);
    }
    await settle();
    assert.equal(engine.currentPhase, "asleep", `30 min of silence across ${w.lives.length} sessions; phase ${engine.currentPhase}`);
    const sleepRow = rows<SleepRow>(w, "sleep")[0];
    assert.equal(sleepRow?.cause, "idle");
    assert.ok(sleepRow && sleepRow.at - t0 <= 12 * 60_000, `slept ${Math.round(((sleepRow?.at ?? clock.t) - t0) / 60_000)} min after the wake`);
    assert.equal(w.lives.length, 2, "one reconnect happened before the carried clock ran out");
  } finally {
    await engine.stop();
  }
});

test("addressed turns hold it awake: a delegation, Jarhead's answer, a typed line and words that name Jarhead each restart the 10-minute clock; room talk in between does not", async () => {
  const w = world();
  const { engine, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.wake("test");
    // Minute 8: Kevin asks for something; the brain answers at once.
    runMinutes(w, 8);
    delegate(w, "jarhead what time is it", "item_1");
    await until(() => brain.tasks.length === 1);
    brain.resolve?.({ status: "done", summary: "It is three." });
    await settle();
    // Minute 16: Jarhead speaks (an answer, a thread's line).
    runMinutes(w, 8, () => roomTalk(w, "the weather turns cold this weekend"));
    assert.equal(engine.transportState, "awake", "8 min after the delegation, with room talk: awake");
    const live = current(w);
    live.emit("outputTranscript", " Your timer is done.", live.nowMs, live.nowMs + 600);
    live.nowMs += 600;
    // Minute 24: a typed line.
    runMinutes(w, 8, () => roomTalk(w, "the weather turns cold this weekend"));
    assert.equal(engine.transportState, "awake", "8 min after Jarhead spoke: awake");
    await engine.sayText("thanks");
    // Minute 32: Kevin names Jarhead and Live does not answer.
    runMinutes(w, 8);
    assert.equal(engine.transportState, "awake", "8 min after the typed line: awake");
    roomTalk(w, "jarhead are you still there");
    runMinutes(w, 8);
    assert.equal(engine.transportState, "awake", "8 min after words that named Jarhead: awake");
    // Then nothing addressed for 10 minutes, only the room: asleep.
    runMinutes(w, 3, () => roomTalk(w, "the weather turns cold this weekend"));
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => r.cause), ["idle"]);
  } finally {
    await engine.stop();
  }
});

test("the pre-sleep clause is not an addressed turn: room talk after 'going to sleep' does not keep it awake, but Kevin naming Jarhead does", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 1 });
    await engine.wake("test");
    clock.t += 56_000;
    tick(engine);
    let live = current(w);
    assert.ok(live.instructions.some((i) => /going to sleep in about 5 seconds/.test(i)), "the clause was asked for");
    // The voice says it; a TV talks over it.
    live.emit("outputTranscript", " Going to sleep.", live.nowMs, live.nowMs + 700);
    live.nowMs += 700;
    clock.t += 1000;
    roomTalk(w, "and now the sports");
    clock.t += 5000;
    tick(engine);
    await settle();
    assert.equal(engine.currentPhase, "asleep", "the clause and the room do not hold it");

    // Again — and this time Kevin answers it by name.
    await engine.wake("test");
    live = current(w);
    clock.t += 56_000;
    tick(engine);
    assert.ok(live.instructions.some((i) => /going to sleep in about 5 seconds/.test(i)));
    live.emit("outputTranscript", " Going to sleep.", live.nowMs, live.nowMs + 700);
    live.nowMs += 700;
    clock.t += 1000;
    roomTalk(w, "no wait jarhead stay awake");
    clock.t += 5000;
    tick(engine);
    clock.t += 30_000;
    tick(engine);
    await settle();
    assert.equal(engine.transportState, "awake", "Kevin named Jarhead after the clause: the sleep is off");
  } finally {
    await engine.stop();
  }
});

test("D1 ceiling: an idle setting that is not a number (or negative) still sleeps after 30 min with no addressed turn; a longer setting is honoured; an explicit 0 is off", async () => {
  for (const minutes of [Number.NaN, -5]) {
    const w = world();
    const { engine } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: minutes });
      await engine.wake("test");
      runMinutes(w, 29, () => roomTalk(w, "the weather turns cold this weekend"));
      assert.equal(engine.transportState, "awake", `idleSleepMinutes=${minutes}: awake at 29 min`);
      runMinutes(w, 2, () => roomTalk(w, "the weather turns cold this weekend"));
      await settle();
      assert.equal(engine.currentPhase, "asleep", `idleSleepMinutes=${minutes}: asleep after 30 min`);
      assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => r.cause), ["idle"]);
    } finally {
      await engine.stop();
    }
  }
  const w = world();
  try {
    await w.engine.start();
    await w.engine.ready();
    w.engine.updateSettings({ idleSleepMinutes: 45 });
    await w.engine.wake("test");
    runMinutes(w, 40);
    assert.equal(w.engine.transportState, "awake", "45 min set: awake at 40");
    runMinutes(w, 6);
    await settle();
    assert.equal(w.engine.currentPhase, "asleep", "45 min set: asleep after 45");
  } finally {
    await w.engine.stop();
  }
  const off = world();
  try {
    await off.engine.start();
    await off.engine.ready();
    off.engine.updateSettings({ idleSleepMinutes: 0 });
    await off.engine.wake("test");
    runMinutes(off, 40);
    assert.equal(off.engine.transportState, "awake", "0 is idle sleep off (a developer's env, the tests)");
  } finally {
    await off.engine.stop();
  }
});

test("D1 ceiling: a main turn that never ends and never speaks holds the session at most 30 min", async () => {
  const w = world();
  const { engine, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    await engine.wake("test");
    delegate(w, "jarhead tidy up my downloads folder", "item_1");
    await until(() => brain.tasks.length === 1);
    runMinutes(w, 20);
    assert.equal(engine.transportState, "awake", "a task runs: the 10-minute idle sleep waits");
    runMinutes(w, 11);
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(brain.tasks[0]!.signal.aborted, true, "the sleep cut the turn");
  } finally {
    await engine.stop();
  }
});

test("RAIL-14: Live's delegation is attention, not presence — it never stamps the presence clock; Kevin's own words and typed lines do", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const atWake = presenceAt(engine);
    clock.t += 120_000;
    // A delegation with no words of Kevin's behind it (the model acting on its own, a resumed context).
    live.emit("delegation", "item_1", "client", live.nowMs);
    await settle();
    assert.equal(presenceAt(engine), atWake, "the delegation did not stamp presence");
    clock.t += 1000;
    live.emit("inputTranscript", " hello", live.nowMs, live.nowMs + 300);
    assert.equal(presenceAt(engine), clock.t, "Kevin's words do");
    clock.t += 1000;
    await engine.sayText("thanks");
    assert.equal(presenceAt(engine), clock.t, "a typed line does");
  } finally {
    w.brain.resolve?.({ status: "cancelled" });
    await engine.stop();
  }
});

test("RF-2 (engine half): the ear's 'addressed' window reads Jarhead's speech and the last addressed turn, never room talk — a 'goodnight' 3 s after a TV sentence is not mid-exchange", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    clock.t += 60_000;
    roomTalk(w, "and that is the forecast for tonight");
    clock.t += 3000;
    engine.ear("goodnight", true, 3, clock.t);
    await settle(150);
    assert.equal(rows<SleepRow>(w, "sleep").length, 0, "the room's own words do not open the exchange window");
    assert.equal(live.currentState, "started");
  } finally {
    await engine.stop();
  }
});
