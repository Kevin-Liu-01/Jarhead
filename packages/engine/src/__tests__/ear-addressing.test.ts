import { test } from "node:test";
import assert from "node:assert/strict";
import { FiredReflexes, parseReflex, type Reflex, type ReflexOutcome } from "@jarhead/brain";
import { EarReflexes } from "../ear.ts";
import { delegate, nextUtterance, rows, settle, until, world } from "./world.ts";

/**
 * W1-2 (the launch audit, 2026-10-05): the ear acts only on words addressed to Jarhead, a request
 * that starts with "write" reaches the brain, and a late delegation never repeats what the ear did.
 *
 * RF-1: "write me a haiku" typed "me a haiku about cats" into the focused field and the brain never
 * got the task. RF-2: with a session open, room talk (a video's "hit the like button", a colleague's
 * "press enter") pressed keys and clicked with no wake word and no exchange. RF-5: Live's delegation
 * 4.5 s after the ear's "close this window" closed a second window. Fake Live, fake brain,
 * RecordingHands: nothing reaches the Mac.
 */

/** The engine-level repros, adopted from the audit (scratchpad/launch/reflex/rf-engine.test.ts, rf-late.test.ts). */

test("RF-1: \"Jarhead, write me a haiku about cats.\" reaches the brain; nothing is typed by reflex", async () => {
  const w = world();
  const { engine, hands, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    hands.posted.length = 0;
    delegate(w, "Jarhead, write me a haiku about cats.", "item_1");
    await until(() => brain.tasks.length > 0 || engine.snapshot().delegations.find((d) => d.liveId === "item_1")?.status === "done", 3000);
    const typed = hands.posted.filter((p) => p.op === "type").map((p) => String(p.params["text"]));
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1");
    assert.deepEqual(typed, [], `typed by reflex: ${JSON.stringify(typed)}; delegation ${d?.status} "${d?.summary}"`);
    assert.equal(brain.tasks.length, 1, "the brain got the task");
  } finally {
    await engine.stop();
  }
});

test("RF-1 (ear): the recogniser's final \"jarhead write down buy milk\" does not type \"down buy milk\"", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.posted.length = 0;
    engine.ear("jarhead write down buy milk", true, 1, w.clock.t - 100);
    await settle(150);
    const typed = hands.posted.filter((p) => p.op === "type").map((p) => String(p.params["text"]));
    assert.deepEqual(typed, [], `typed ${JSON.stringify(typed)}`);
  } finally {
    await engine.stop();
  }
});

test("RF-2: words nobody addressed to Jarhead (no wake word, outside the exchange window) press nothing: \"press enter\", \"close this window\"", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    // Well past the exchange window: Jarhead is idle and nobody has talked to it.
    w.clock.t += 60_000;
    nextUtterance(w);
    hands.posted.length = 0;
    engine.ear("press enter", true, 7, w.clock.t - 100);
    engine.ear("close this window", true, 8, w.clock.t - 50);
    await settle(150);
    const keys = hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"]));
    assert.deepEqual(keys, [], `posted keys on unaddressed words: ${JSON.stringify(keys)}`);
    assert.deepEqual(rows(w, "reflex"), [], "no reflex ran, so none is on the ledger");
    // The same words with the name act at once.
    engine.ear("jarhead press enter", true, 9, w.clock.t);
    await until(() => hands.posted.some((p) => p.op === "key"), 2000);
    assert.deepEqual(hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"])), ["Return"]);
  } finally {
    await engine.stop();
  }
});

test("RF-2 (media): a video saying \"hit the like button\" while a session is open clicks nothing", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.frontApp = "Safari";
    hands.labels = ["Like", "Share", "Subscribe"];
    w.clock.t += 60_000;
    nextUtterance(w);
    hands.posted.length = 0;
    engine.ear("hit the like button", true, 9, w.clock.t - 100);
    await settle(200);
    const clicks = hands.posted.filter((p) => p.op === "click");
    assert.equal(clicks.length, 0, `clicked ${JSON.stringify(clicks.map((c) => c.params))}`);
  } finally {
    await engine.stop();
  }
});

test("RF-2 (control): mid-exchange the bare words still act, and a screenshot needs no address", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.posted.length = 0;
    // Just woken: Kevin is talking to Jarhead.
    engine.ear("press enter", true, 1, w.clock.t - 100);
    await until(() => hands.posted.some((p) => p.op === "key"), 2000);
    assert.deepEqual(hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"])), ["Return"]);
    // A minute later, no name: a screenshot is Jarhead's own look, free; a key is not.
    w.clock.t += 60_000;
    nextUtterance(w);
    engine.ear("take a screenshot", true, 2, w.clock.t - 100);
    await until(() => rows<{ type: string; action: string }>(w, "reflex").some((r) => r.action === "screenshot"), 2000);
    assert.ok(rows<{ type: string; action: string }>(w, "reflex").some((r) => r.action === "screenshot"), "the look ran");
  } finally {
    await engine.stop();
  }
});

test("RF-5: Live's delegation 4.5 s after the ear's \"close this window\" is already done: one ⌘W", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.posted.length = 0;
    engine.ear("jarhead close this window", true, 1, w.clock.t - 100);
    await until(() => hands.posted.some((p) => p.op === "key"), 2000);
    await until(() => rows(w, "reflex").length > 0, 2000);
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 1, "the ear pressed ⌘W once");
    w.clock.t += 4_500;
    delegate(w, "Jarhead, close this window.", "item_late");
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_late")?.status === "done", 3000);
    const keys = hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"]));
    assert.deepEqual(keys, ["cmd+w"], `keys posted: ${JSON.stringify(keys)}`);
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_late")?.summary, "already did it");
    // Claimed: the same words again, later, are a new command and run.
    w.clock.t += 10_000;
    nextUtterance(w);
    delegate(w, "Jarhead, close this window.", "item_again");
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_again")?.status === "done", 3000);
    assert.deepEqual(hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"])), ["cmd+w", "cmd+w"]);
  } finally {
    await engine.stop();
  }
});

test("RF-5 (in flight): a delegation that lands while the ear's ⌘W is still running joins it: one ⌘W, and nothing is left held", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.posted.length = 0;
    engine.ear("jarhead close this window", true, 1, w.clock.t - 100);
    await until(() => hands.posted.some((p) => p.op === "key"), 2000);
    // No wait for the ear's answer: the audit's repro, where the run is not yet remembered.
    w.clock.t += 4_500;
    delegate(w, "Jarhead, close this window.", "item_joined");
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_joined")?.status === "done", 3000);
    await until(() => rows(w, "reflex").length > 0, 2000);
    assert.deepEqual(hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"])), ["cmd+w"]);
    // The delegation had that run: a new request for the same words 10 s later is a new command.
    w.clock.t += 10_000;
    nextUtterance(w);
    delegate(w, "Jarhead, close this window.", "item_next");
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_next")?.status === "done", 3000);
    assert.deepEqual(hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"])), ["cmd+w", "cmd+w"]);
  } finally {
    await engine.stop();
  }
});

/**
 * The review of W1-2 (2026-10-05). The 30 s hold must not swallow a NEW utterance of the same words: a typed
 * line is not held (Live is told it is done and does not delegate it), and an ear reflex Live never delegated is
 * released once the ear hears the same words again and leaves them to Live.
 */
test("RF-5 hold: a typed 'press enter' is not held, so a spoken 'press enter' delegated 10 s later presses again", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.posted.length = 0;
    await engine.sayText("press enter");
    await until(() => hands.posted.some((p) => p.op === "key"), 2000);
    await settle(50);
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 1, "the typed line pressed Return");
    w.clock.t += 10_000;
    nextUtterance(w);
    delegate(w, "Jarhead, press enter.", "item_spoken");
    await until(() => ["done", "failed", "cancelled"].includes(engine.snapshot().delegations.find((d) => d.liveId === "item_spoken")?.status ?? ""), 3000);
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_spoken");
    const keys = hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"]));
    assert.deepEqual(keys, ["Return", "Return"], `keys ${JSON.stringify(keys)}; spoken delegation ${d?.status} "${d?.summary}"`);
  } finally {
    await engine.stop();
  }
});

test("RF-5 hold: the ear's 'jarhead press enter' that Live never delegated is released when the ear hears 'press enter' again; the new delegation presses", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.posted.length = 0;
    engine.ear("jarhead press enter", true, 1, w.clock.t - 100);
    await until(() => hands.posted.some((p) => p.op === "key"), 2000);
    await until(() => rows(w, "reflex").length > 0, 2000);
    w.clock.t += 12_000;
    nextUtterance(w);
    // The ear hears the bare words outside the exchange window: gated (left to Live).
    engine.ear("press enter", true, 2, w.clock.t - 100);
    await settle(100);
    delegate(w, "press enter", "item_new");
    await until(() => ["done", "failed", "cancelled"].includes(engine.snapshot().delegations.find((d) => d.liveId === "item_new")?.status ?? ""), 3000);
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_new");
    const keys = hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"]));
    assert.deepEqual(keys, ["Return", "Return"], `keys ${JSON.stringify(keys)}; delegation ${d?.status} "${d?.summary}"`);
  } finally {
    await engine.stop();
  }
});

test("addressing: an unaddressed partial left to Live does not fire when the recogniser re-emits it after Live's delegation ran it", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    w.clock.t += 60_000;
    nextUtterance(w);
    hands.posted.length = 0;
    engine.ear("press enter", false, 5, w.clock.t - 100); // a partial, unaddressed: left to Live, not consumed
    await settle(600);
    assert.deepEqual(hands.posted.filter((p) => p.op === "key"), [], "room talk: the ear pressed nothing");
    w.clock.t += 700;
    delegate(w, "press enter", "item_live");
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_live")?.status === "done", 3000);
    await settle(50);
    w.clock.t += 300; // the recogniser re-emits the same partial within the 1.5 s gap
    engine.ear("press enter", false, 5, w.clock.t - 50);
    await settle(700);
    const keys = hands.posted.filter((p) => p.op === "key").map((p) => String(p.params["combo"]));
    assert.deepEqual(keys, ["Return"], `keys ${JSON.stringify(keys)}`);
  } finally {
    await engine.stop();
  }
});

/**
 * Pinned for W1-1 (engine.ts is its file): the ear gates a bare "start dictating" outside the exchange, and
 * Live's delegation of it reaches the Delegator's runReflex, which cannot start dictation, so the brain gets a
 * task. The fix is the engine's: runReflex handles dictate_start and dictate_stop through startDictation and
 * stopDictation, as runEarReflex does. Drop the todo once that lands.
 */
test("addressing: a bare 'start dictating' a minute after the last exchange, which Live delegates, starts dictation", { todo: "W1-1: the engine's Delegator-side runReflex must start and stop dictation" }, async () => {
  const w = world();
  const { engine, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    w.clock.t += 60_000;
    nextUtterance(w);
    engine.ear("start dictating", true, 3, w.clock.t - 100);
    await settle(100);
    delegate(w, "Start dictating.", "item_d");
    await until(() => ["done", "failed", "cancelled"].includes(engine.snapshot().delegations.find((d) => d.liveId === "item_d")?.status ?? "") || brain.tasks.length > 0, 3000);
    await settle(100);
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_d");
    assert.equal(engine.isDictating, true, `dictating? delegation ${d?.status} "${d?.summary}"; brain tasks ${brain.tasks.length}`);
    assert.equal(brain.tasks.length, 0, "no generation for a dictation toggle");
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ the ear alone

interface Harness {
  ear: EarReflexes;
  ran: string[];
  stops: number;
  clock: { t: number };
  addressed: boolean;
}

function harness(threadNames: readonly string[] = []): Harness {
  const clock = { t: 1_000_000 };
  const fired = new FiredReflexes(() => clock.t);
  const h: Harness = { ear: undefined as unknown as EarReflexes, ran: [], stops: 0, clock, addressed: false };
  h.ear = new EarReflexes({
    now: () => clock.t,
    enabled: () => true,
    match: (u) => parseReflex(u, { threadNames, now: () => clock.t }),
    run: async (reflex: Reflex): Promise<ReflexOutcome> => {
      h.ran.push(reflex.label);
      return { reflex, result: { kind: "text", text: "OK" }, ms: 1, ok: true, dispatchedAt: clock.t };
    },
    onStop: () => void h.stops++,
    liveThreads: () => threadNames.length,
    onGateSpeech: () => undefined,
    stopNameWaitMs: 40,
    addressed: () => h.addressed,
    dictation: { active: () => false, start: () => undefined, stop: () => undefined, type: async () => true, newline: async () => undefined, deleteWord: async () => undefined },
    fired,
    stableMs: 20,
    carefulMs: 40,
  });
  return h;
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("ear: an acting kind fires only when the words name Jarhead or the engine says mid-exchange; a partial may still grow into the name", async () => {
  const h = harness();
  h.ear.hear("press enter", true, 1, h.clock.t);
  h.ear.hear("scroll down", true, 2, h.clock.t);
  h.ear.hear("start dictating", true, 3, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, [], "room talk: nothing ran");
  // A partial is not consumed: "press enter" → "press enter jarhead" fires once, at the terminal tail.
  h.ear.hear("press enter", false, 4, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, [], "no fire on the partial's careful window");
  h.ear.hear("press enter jarhead", false, 4, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, ["press enter"]);
  // Mid-exchange, the bare words act.
  h.addressed = true;
  h.ear.hear("page down", true, 5, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, ["press enter", "page down"]);
});

test("ear: words left to Live need the name from then on, even once the exchange opens; new words after them are judged afresh", async () => {
  const h = harness();
  h.ear.hear("press enter", false, 1, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, [], "room talk: left to Live");
  // Live delegated the words (the exchange is open now); the recogniser re-emits and revises the same partial.
  h.addressed = true;
  h.ear.hear("press enter", false, 1, h.clock.t);
  h.ear.hear("press enter please", false, 1, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, [], "the same utterance: Live's, not the ear's a second time");
  h.ear.hear("press enter please jarhead", false, 1, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, ["press enter"], "the name makes it the ear's");
  // A new segment mid-exchange is a new utterance: the bare words act.
  h.ear.hear("page down", true, 2, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, ["press enter", "page down"]);
});

test("ear: new words the ear does not act on (left to Live, or heard while it holds still) release an older held reflex for the same words", () => {
  const clock = { t: 1_000_000 };
  const fired = new FiredReflexes(() => clock.t);
  let held: string | undefined;
  const ear = new EarReflexes({
    now: () => clock.t,
    enabled: () => true,
    match: (u) => parseReflex(u),
    run: async (reflex: Reflex): Promise<ReflexOutcome> => ({ reflex, result: { kind: "text", text: "OK" }, ms: 1, ok: true, dispatchedAt: clock.t }),
    onStop: () => undefined,
    addressed: () => false,
    suppressed: () => held,
    dictation: { active: () => false, start: () => undefined, stop: () => undefined, type: async () => true, newline: async () => undefined, deleteWord: async () => undefined },
    fired,
  });
  for (const phrase of ["press enter", "close this window"]) {
    fired.record({ id: phrase, phrase, reflex: parseReflex(phrase)!, source: "ear", earAt: clock.t, matchedAt: clock.t, dispatchedAt: clock.t, doneAt: clock.t, ok: true });
  }
  clock.t += 10_000;
  assert.equal(fired.peek("press enter")?.kind, "done", "held: Live never delegated it");
  ear.hear("press enter", true, 1, clock.t);
  assert.equal(fired.peek("press enter"), undefined, "left to Live: the next delegation of these words is theirs");
  held = "a brain task is running";
  ear.hear("close this window", true, 2, clock.t);
  assert.equal(fired.peek("close this window"), undefined, "held still: new words all the same");
});

test("ear: a screenshot and a circle are Jarhead's own look and need no address; the meta rows (the clock, the voice) do; a stop is still a stop", async () => {
  const h = harness();
  h.ear.hear("take a screenshot", true, 1, h.clock.t);
  h.ear.hear("circle that", true, 2, h.clock.t);
  h.ear.hear("what time is it", true, 3, h.clock.t);
  h.ear.hear("switch voice to marin", true, 4, h.clock.t);
  await tick();
  assert.deepEqual(h.ran, ["screenshot", "circle that"]);
  h.ear.hear("stop", true, 5, h.clock.t);
  assert.equal(h.stops, 1, "the interrupt is not an acting kind: the engine judges it");
});

test("ear: the stop's name window is not gated — 'stop' then 'the slack one' with two threads live stops Slack alone, addressed or not", async () => {
  const h = harness(["Slack", "Spotify"]);
  h.ear.hear("stop", false, 1, h.clock.t);
  h.ear.hear("stop the slack one", false, 1, h.clock.t);
  await tick(80);
  assert.deepEqual(h.ran, ["stop Slack"]);
  assert.equal(h.stops, 0, "no cut of everything");
});
