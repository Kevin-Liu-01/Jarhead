import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { delegate, frame, nextUtterance, rows, settle, until, world } from "./world.ts";

/**
 * Sleep: one grammar, three entries, one closer. A dismissal through the ear
 * ("goodnight jarhead", "power down") or through Live's delegation ("that will be
 * all") reaches `Engine.fallAsleep("said")`: a typed `sleep` row before the close,
 * everything a stop cuts, ONE word from the voice (FAREWELL_LINE) waited for until
 * its first words plus 300 ms quiet or 1.8 s at most, then the session closes
 * (`sleep:said`), the phase is asleep and the blob tucks. Every other cause — the
 * idle timer, a pause that decayed, the dock, the sleep command, the transport's
 * Stop, shutdown — goes through the same function without the farewell, and the
 * phase flips before the first await. Room talk never sleeps it.
 */

type SleepRow = Extract<LedgerRow, { type: "sleep" }>;
type StopRow = Extract<LedgerRow, { type: "stop" }>;
const sequence = (w: ReturnType<typeof world>, ...types: string[]): string[] => (w.engine.ledger.read(w.clock.t) as unknown as { type: string }[]).map((r) => r.type).filter((t) => types.includes(t));
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();

test("ear: a final 'goodnight jarhead.' sleeps it — FAREWELL_LINE appended once, the sleep row (cause, phrase, session, farewell) written before the close, the session closed 300 ms after the voice's first word, no stop row, phase asleep; a delegation during the farewell is recorded and cancelled quietly", async () => {
  const w = world();
  const { engine, live, events, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.instructions.length = 0;
    events.length = 0;

    engine.ear("goodnight jarhead.", true, 1, clock.t);
    await settle();
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE], "the voice is asked for its one word");
    // The cut flushed whatever the voice was saying before the dismissal; the farewell itself is never flushed.
    const flushesAtCut = events.filter((e) => e.type === "speaker-flush").length;
    assert.ok(flushesAtCut >= 1, "the dismissal cuts what was playing");
    assert.equal(live.closes, 0, "the session waits for the word");
    assert.equal(engine.snapshot().session?.id, "sess_1", "still open while the voice says night");
    const sleep = rows<SleepRow>(w, "sleep");
    assert.equal(sleep.length, 1);
    assert.deepEqual(sleep[0], { at: clock.t, type: "sleep", cause: "said", phrase: "goodnight", sessionId: "sess_1", farewell: true });
    assert.equal(rows<StopRow>(w, "stop").length, 0, "a dismissal is not a stop");
    // A delegation landing mid-farewell (Kevin's next words, or Live's own for the cue) is recorded, refused, never a brain task.
    delegate(w, "jarhead open safari", "item_late");
    await settle();
    const late = engine.snapshot().delegations.find((d) => d.liveId === "item_late")!;
    assert.equal(late.status, "cancelled");
    assert.equal(late.summary, "going to sleep");
    assert.equal(brain.tasks.length, 0);
    assert.equal(live.instructions.length, 1, "one farewell, however many entries fire");
    // The voice says "night." — then 300 ms of quiet, then the close.
    live.emit("outputTranscript", " night.", live.nowMs, live.nowMs + 400);
    live.emit("audio", frame());
    await settle(150);
    assert.equal(live.closes, 0, "not yet: the word is still in the air");
    await until(() => live.closes === 1, 1000);
    assert.equal(live.currentState, "closed");
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(engine.transportState, "asleep");
    assert.equal(engine.snapshot().session, undefined);
    assert.deepEqual(sequence(w, "sleep", "session.closed"), ["sleep", "session.closed"], "the row lands in the closing session's log");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "night"));
    assert.equal(events.filter((e) => e.type === "speaker-flush").length, flushesAtCut, "the farewell's tail plays out; nothing is flushed after the append");
    assert.ok(!engine.snapshot().transcript.some((i) => /go to sleep|dismissed/i.test(i.text) && i.speaker === "jarhead"));
  } finally {
    await engine.stop();
  }
});

test("farewell cap: a voice that never answers is cut at FAREWELL_CAP_MS and the session closes anyway; a voice that already said night gets no second farewell and the session closes after the quiet window", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.instructions.length = 0;
    const t0 = Date.now();
    engine.ear("go to sleep jarhead", true, 1, clock.t);
    await settle();
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE]);
    await settle(1200);
    assert.equal(live.closes, 0, "still waiting inside the cap");
    await until(() => live.closes === 1, 1500);
    const took = Date.now() - t0;
    assert.ok(took >= Engine.FAREWELL_CAP_MS - 50 && took < Engine.FAREWELL_CAP_MS + 800, `closed at the cap (${took} ms)`);
    assert.equal(engine.currentPhase, "asleep");

    // Again, but the voice said "night." 400 ms before the cue landed (Live's path spoke first).
    await engine.wake("test");
    const next = w.lives[1]!;
    next.emit("outputTranscript", " night.", 100, 500);
    clock.t += 400;
    next.instructions.length = 0;
    const t1 = Date.now();
    engine.ear("go to sleep jarhead", true, 2, clock.t);
    await settle();
    assert.deepEqual(next.instructions, [], "no second farewell");
    await until(() => next.closes === 1, 1000);
    assert.ok(Date.now() - t1 < 1000, "closed after the quiet window, not the cap");
    assert.equal(rows<SleepRow>(w, "sleep").length, 2);
    assert.equal(rows<SleepRow>(w, "sleep")[1]!.phrase, "go to sleep");
  } finally {
    await engine.stop();
  }
});

test("Live's path: with reflexes off, a delegation of 'jarhead that will be all' never reaches the brain — the delegation finishes 'going to sleep', the sleep row says cause said, the voice is asked for its word", async () => {
  const w = world();
  const { engine, live, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0, reflexes: false });
    await engine.wake("test");
    live.instructions.length = 0;
    delegate(w, "jarhead that will be all", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 0, "no brain task");
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "going to sleep");
    const sleep = rows<SleepRow>(w, "sleep");
    assert.equal(sleep.length, 1);
    assert.equal(sleep[0]!.cause, "said");
    assert.equal(sleep[0]!.farewell, true);
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE]);
    live.emit("outputTranscript", " night.", live.nowMs, live.nowMs + 300);
    await until(() => live.closes === 1, 1000);
    assert.equal(engine.currentPhase, "asleep");
  } finally {
    await engine.stop();
  }
});

test("mid-task 'power down' through the ear (a held ear still hears a dismissal): the task is cancelled with the brain's cancel called, both helpers' pendings fail, the sleep row is written, the session closes after the farewell", async () => {
  const w = world();
  const { engine, live, hands, handsBg, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead find the save button", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    // The main toolset's gate probe reads on the reading helper (SplitHands) and is held there; the type behind it never reaches the acting one.
    hands.hold = "frontmost";
    handsBg.hold = "frontmost";
    const typing = engine.toolset.run("type", { text: "hello" }).catch(() => ({ kind: "error" as const, message: "threw" }));
    await settle();
    assert.ok(handsBg.named("frontmost").length > 0, "the gate's probe is pending on the reading helper");
    const reading = handsBg.request("frontmost").catch((e: Error) => ({ kind: "error" as const, message: e.message }));
    live.instructions.length = 0;

    engine.ear("power down", true, 1, clock.t);
    await settle();
    assert.equal(brain.cancels, 1);
    assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
    assert.match(engine.snapshot().delegations[0]!.summary ?? "", /going to sleep/);
    const fg = await typing;
    assert.equal(fg.kind, "error", "the acting helper's pending failed");
    hands.release();
    handsBg.release();
    await settle();
    assert.equal(hands.named("type").length, 0, "nothing typed after the cut");
    void reading;
    assert.equal(rows<SleepRow>(w, "sleep")[0]?.cause, "said");
    assert.equal(rows<SleepRow>(w, "sleep")[0]?.phrase, "power down");
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE]);
    live.emit("outputTranscript", " night.", live.nowMs, live.nowMs + 300);
    await until(() => live.closes === 1, 1000);
    assert.equal(engine.currentPhase, "asleep");
  } finally {
    hands.release();
    handsBg.release();
    await engine.stop();
  }
});

test("every other cause, no farewell: idle (after the announcement), the dock (asleep synchronously before the first await), pause-decayed, pressStop (stop row then sleep row), shutdown; a sleep with nothing open writes no row", async () => {
  const w = world();
  const { engine, live, lives, events, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    // idle
    engine.updateSettings({ idleSleepMinutes: 1 });
    await engine.wake("test");
    clock.t += 56_000;
    tick(engine);
    assert.ok(live.instructions.some((i) => /going to sleep in about 5 seconds/.test(i)), "the pre-sleep clause");
    clock.t += 6_000;
    tick(engine);
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(live.currentState, "closed");
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => [r.cause, r.farewell, r.sessionId]), [["idle", undefined, "sess_1"]]);
    assert.ok(!live.instructions.includes(Engine.FAREWELL_LINE), "no farewell for an idle sleep");

    // dock: synchronous
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const dockLive = lives[1]!;
    events.length = 0;
    const sleeping = engine.command({ type: "sleep", cause: "dock" });
    assert.equal(engine.currentPhase, "asleep", "asleep before anything is awaited");
    assert.equal(engine.snapshot().session, undefined);
    assert.equal(dockLive.currentState, "closed");
    await sleeping;
    assert.equal(rows<SleepRow>(w, "sleep")[1]!.cause, "dock");
    assert.equal(rows<SleepRow>(w, "sleep")[1]!.sessionId, "sess_2");
    assert.ok(!dockLive.instructions.includes(Engine.FAREWELL_LINE));
    assert.ok(events.some((e) => e.type === "toast" && e.text === "asleep"));

    // pause-decayed
    await engine.wake("test");
    await engine.command({ type: "pause" });
    clock.t += 61_000;
    tick(engine);
    await settle();
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(rows<SleepRow>(w, "sleep")[2]!.cause, "pause-decayed");
    assert.equal(rows<SleepRow>(w, "sleep")[2]!.sessionId, undefined, "the paused session was closed by the pause; the decay closes no session");

    // pressStop: its own row, then the sleep row
    await engine.wake("test");
    const stopLive = lives[3]!;
    const stopping = engine.command({ type: "stop" });
    assert.equal(engine.currentPhase, "asleep", "asleep before anything is awaited");
    assert.equal(stopLive.currentState, "closed");
    await stopping;
    assert.deepEqual(sequence(w, "stop", "sleep").slice(-2), ["stop", "sleep"]);
    assert.equal(rows<SleepRow>(w, "sleep")[3]!.cause, "stop");
    assert.equal(rows<SleepRow>(w, "sleep")[3]!.sessionId, "sess_4");

    // asleep: a sleep command records nothing
    const before = rows<SleepRow>(w, "sleep").length;
    await engine.command({ type: "sleep" });
    assert.equal(rows<SleepRow>(w, "sleep").length, before, "nothing to put to sleep, nothing to record");

    // shutdown
    await engine.wake("test");
    await engine.stop();
    assert.equal(rows<SleepRow>(w, "sleep").at(-1)!.cause, "shutdown");
    assert.equal(rows<SleepRow>(w, "sleep").at(-1)!.sessionId, "sess_5");
    assert.equal(lives[4]!.currentState, "closed");
  } finally {
    await engine.stop();
  }
});

test("negatives: 'turn off the lights' is a task; a spoken 'stop' mid-task is the interrupt (stop row, no sleep row, session open); a bare 'goodnight' to someone in the room does nothing, but 3 s after Jarhead spoke it fires; 'that is all' growing into 'that is all wrong' fires nothing", async () => {
  const w = world();
  const { engine, live, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead turn off the lights", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1, "a task, not a dismissal");
    assert.equal(rows<SleepRow>(w, "sleep").length, 0);
    engine.ear("stop", true, 1, clock.t);
    await settle();
    assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
    assert.equal(rows<StopRow>(w, "stop")[0]?.how, "said");
    assert.equal(rows<SleepRow>(w, "sleep").length, 0, "stop is the interrupt, never a sleep");
    assert.equal(live.currentState, "started");

    // Not to Jarhead: nothing (the exchange window has passed).
    clock.t += 10_000;
    engine.ear("goodnight", true, 2, clock.t);
    await settle(120);
    assert.equal(rows<SleepRow>(w, "sleep").length, 0, "room talk never sleeps it");
    assert.equal(live.currentState, "started");
    // "that is all" that grows into "that is all wrong" within the careful window: nothing.
    live.emit("outputTranscript", " here you go.", live.nowMs, live.nowMs + 300);
    engine.ear("that is all", false, 3, clock.t);
    await settle(20);
    engine.ear("that is all wrong", false, 3, clock.t);
    await settle(150);
    engine.ear("that is all wrong", true, 3, clock.t);
    await settle(120);
    assert.equal(rows<SleepRow>(w, "sleep").length, 0);
    assert.equal(live.currentState, "started");
    // Mid-exchange (Jarhead spoke 3 s ago) a bare "goodnight" is to Jarhead.
    clock.t += 3000;
    engine.ear("goodnight", true, 4, clock.t);
    await settle();
    assert.equal(rows<SleepRow>(w, "sleep").length, 1);
    assert.equal(rows<SleepRow>(w, "sleep")[0]!.phrase, "goodnight");
    assert.ok(live.instructions.includes(Engine.FAREWELL_LINE));
    live.emit("outputTranscript", " night.", live.nowMs, live.nowMs + 300);
    await until(() => live.closes === 1, 1000);
    assert.equal(engine.currentPhase, "asleep");
    nextUtterance(w);
  } finally {
    await engine.stop();
  }
});

test("Stop mid-farewell: the transport's Stop ends the wait for the word at once — the session closes now, the ledger reads sleep(said) then stop, the phase is asleep when the command returns", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.instructions.length = 0;
    const t0 = Date.now();
    engine.ear("goodnight jarhead.", true, 1, clock.t);
    await settle();
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE]);
    assert.equal(live.closes, 0, "waiting for the word");
    await engine.command({ type: "stop" });
    assert.ok(Date.now() - t0 < Engine.FAREWELL_CAP_MS - 200, "did not wait out the cap");
    assert.equal(live.currentState, "closed");
    assert.equal(live.closes, 1);
    assert.equal(engine.currentPhase, "asleep");
    assert.deepEqual(sequence(w, "sleep", "stop", "session.closed"), ["sleep", "stop", "session.closed"]);
    assert.equal(rows<SleepRow>(w, "sleep").length, 1, "one sleep, the dismissal's");
    assert.equal(rows<SleepRow>(w, "sleep")[0]!.cause, "said");
    assert.equal(rows<StopRow>(w, "stop")[0]!.how, "pressed");
    assert.equal(live.instructions.length, 1, "nothing else appended to the closing session");
  } finally {
    await engine.stop();
  }
});

test("Pause mid-farewell: a dismissal already in flight wins — the farewell ends now, the session closes asleep (not paused), no pause row, the spare's process ends; a plain pause afterwards is still a pause", async () => {
  const w = world();
  const { engine, live, events, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await until(() => w.workers.brains.length === 1);
    const spare = w.workers.brains[0]!;
    live.instructions.length = 0;
    engine.ear("go to sleep jarhead", true, 1, clock.t);
    await settle();
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE]);
    events.length = 0;
    const t0 = Date.now();
    await engine.command({ type: "pause" });
    assert.ok(Date.now() - t0 < Engine.FAREWELL_CAP_MS - 200, "did not wait out the cap");
    assert.equal(engine.isPaused, false);
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(live.currentState, "closed");
    assert.equal(rows(w, "pause").length, 0);
    assert.equal(rows<SleepRow>(w, "sleep").length, 1);
    assert.equal(spare.stops, 1, "the spare went with the sleep, as a sleep always ends it");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "asleep already"));
    // Nothing in flight: a pause is a pause.
    await engine.wake("test");
    await engine.command({ type: "pause" });
    assert.equal(engine.isPaused, true);
    assert.equal(rows(w, "pause").length, 1);
  } finally {
    await engine.stop();
  }
});

test("negative: Jarhead's own line back through the microphone is not a dismissal — 'that's all for now' heard within 1.5 s of Jarhead saying it does nothing; the same words from Kevin 3 s later, mid-exchange, sleep it", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    live.instructions.length = 0;
    // Jarhead speaks a line that happens to be a cue; the mic hears it back a moment later.
    live.emit("outputTranscript", " That's all for now.", live.nowMs, live.nowMs + 600);
    clock.t += 700;
    engine.ear("that's all for now", true, 1, clock.t);
    await settle(150);
    assert.equal(rows<SleepRow>(w, "sleep").length, 0, "its own words never dismiss it");
    assert.equal(live.currentState, "started");
    assert.deepEqual(live.instructions, []);
    // Kevin, 3 s later, still mid-exchange: the same words are his.
    clock.t += 3000;
    engine.ear("that's all for now", true, 2, clock.t);
    await settle();
    assert.equal(rows<SleepRow>(w, "sleep").length, 1);
    // The phrase is the normaliser's ("now" is a polite tail it strips), as for every cue.
    assert.match(rows<SleepRow>(w, "sleep")[0]!.phrase ?? "", /^that's all for/);
    assert.deepEqual(live.instructions, [Engine.FAREWELL_LINE]);
    live.emit("outputTranscript", " night.", live.nowMs, live.nowMs + 300);
    await until(() => live.closes === 1, 1000);
    assert.equal(engine.currentPhase, "asleep");
  } finally {
    await engine.stop();
  }
});

test("cause brain-changed (the closer's half of a brain swap across the Responses line): the sleep row says so, no farewell, the session closes, the spare's process ends", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await until(() => w.workers.brains.length === 1);
    live.instructions.length = 0;
    await engine.fallAsleep("brain-changed");
    assert.equal(engine.currentPhase, "asleep");
    assert.equal(live.currentState, "closed");
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => [r.cause, r.farewell, r.sessionId]), [["brain-changed", undefined, "sess_1"]]);
    assert.deepEqual(live.instructions, [], "no farewell for a swap");
    assert.equal(w.workers.brains[0]!.stops, 1, "the spare runs the old brain kind: it goes with it");
  } finally {
    await engine.stop();
  }
});
