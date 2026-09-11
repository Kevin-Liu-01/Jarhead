import { test } from "node:test";
import assert from "node:assert/strict";
import { delegate, nextUtterance, settle, world } from "./world.ts";

/**
 * The 250 ms path end to end inside the engine: an ear partial becomes a hands
 * op without a brain, Live's delegation for the same words is finished as "already
 * did it" with the reflex's own line spoken, a click on an irreversible control is
 * dropped without leaving a pending question, a typed mismatch is undone, and the
 * setting switches the whole layer off.
 */

test("ear → hands: a partial scrolls after the stability window through the gated toolset; Live's delegation for the same words is finished as already done and the voice confirms; the brain never sees it", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    const rows: unknown[] = [];
    engine.on("reflex.fired", (row) => rows.push(row));

    const heardAt = clock.t - 150; // the app heard it 150 ms ago (transcription lag)
    engine.ear("scroll down", false, 1, heardAt);
    await settle(10);
    assert.equal(hands.named("scroll").length, 0, "a partial waits for the stability window");
    await settle(60);
    assert.equal(hands.named("scroll").length, 1, "then the scroll was issued to the helper");
    assert.deepEqual(hands.named("scroll")[0]!.params, { dx: 0, dy: -300, modifiers: [] });
    assert.equal(rows.length, 1);
    const row = rows[0] as { phrase: string; action: string; earAt: number; ok: boolean; fired: string };
    assert.deepEqual([row.phrase, row.action, row.earAt, row.ok, row.fired], ["scroll down", "scroll down", heardAt, true, "stable"]);

    // Live catches up 400 ms later with the same words and delegates.
    clock.t += 400;
    delegate(w, "jarhead scroll down.", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 0, "no brain");
    assert.equal(hands.named("scroll").length, 1, "not scrolled twice");
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "already did it");
    assert.ok(d.steps.some((s) => s.kind === "note" && /already ran \d+ ms ago on the ear's words/.test(s.text ?? "")));
    assert.deepEqual(live.commentary, ["scrolled down."], "the voice confirms with the reflex's own line");

    // A second, different delegation runs its own reflex through the delegator as before.
    nextUtterance(w);
    delegate(w, "jarhead press escape", "item_2");
    await settle();
    assert.equal(hands.named("key").length, 1);
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_2")!.status, "done");
  } finally {
    await engine.stop();
  }
});

test("ear: a final fires at once; \"click send\" is dropped by the policy with no pending confirmation left behind; \"click save\" clicks the one control by name; two candidates click nothing", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    const rows: { action: string; ok: boolean; dropped?: string }[] = [];
    engine.on("reflex.fired", (row) => rows.push(row));

    engine.ear("click send", true, 1, 1);
    await settle();
    assert.equal(hands.named("click").length, 0, "Send looks irreversible: dropped for the model path to ask");
    assert.equal(engine.confirmations.pending, undefined, "no question left armed");
    assert.equal(rows[0]?.ok, false);
    assert.match(rows[0]?.dropped ?? "", /irreversible/);

    engine.ear("click save", true, 2, 2);
    await settle();
    assert.equal(hands.named("find_element").length, 1);
    assert.equal(hands.named("click").length, 1, "the one Save button was clicked at its centre");
    assert.deepEqual(hands.named("click")[0]!.params, { x: 530, y: 412, button: "left", count: 1, modifiers: [] });
    assert.equal(rows[1]?.ok, true);

    hands.labels = ["Save", "Save", "Cancel"];
    engine.ear("click save", true, 3, 3);
    await settle();
    assert.equal(hands.named("click").length, 1, "two Save controls: nothing clicked");
    assert.equal(rows[2]?.ok, false);
  } finally {
    await engine.stop();
  }
});

test("ear: a typed reflex whose words differ from what Live heard is undone with ⌘Z while the field is focused, and the voice is told; the request then goes on as usual", async () => {
  const w = world();
  const { engine, live, hands, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    engine.ear("type hello there", true, 1, 1);
    await settle();
    assert.equal(hands.named("type").length, 1);
    assert.equal(hands.named("type")[0]!.params["text"], "hello there");

    delegate(w, "jarhead type hello there everyone how are you today", "item_1");
    await settle(60);
    const keys = hands.named("key").map((k) => k.params["combo"]);
    assert.ok(keys.includes("cmd+z"), `⌘Z was pressed (${keys.join(",")})`);
    assert.ok(live.instructions.some((i) => /by reflex but Kevin said something else; it has been undone/.test(i)));
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.ok(d.steps.some((s) => /reflex mismatch/.test(s.text ?? "")), "the mismatch is on the record");
    // The request is itself a type reflex: the delegator typed the full sentence after the undo.
    assert.equal(hands.named("type").length, 2);
    assert.equal(hands.named("type")[1]!.params["text"], "hello there everyone how are you today");
    assert.equal(brain.tasks.length, 0);
  } finally {
    await engine.stop();
  }
});

test("ear: Settings.reflexes off switches the layer off (ear and delegation alike); \"stop\" through the ear stops a running task; the layer is off while asleep", async () => {
  const w = world();
  const { engine, hands, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0, reflexes: false });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    engine.ear("scroll down", true, 1, 1);
    await settle();
    assert.equal(hands.named("scroll").length, 0, "reflexes off: the ear does nothing");
    delegate(w, "jarhead scroll down", "item_1");
    await settle();
    assert.equal(hands.named("scroll").length, 0, "and the delegation goes to the brain");
    assert.equal(brain.tasks.length, 1);
    // The brain is holding the task; "stop" through the ear ends it.
    engine.updateSettings({ reflexes: true });
    engine.ear("stop", false, 2, 2);
    await settle();
    assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
    assert.equal(engine.snapshot().delegations[0]!.summary, "Kevin said stop");
    assert.equal(brain.cancels, 1);
    // Asleep: partials are ignored.
    await engine.sleep();
    engine.ear("scroll down", true, 3, 3);
    await settle(60);
    assert.equal(hands.named("scroll").length, 0);
  } finally {
    await engine.stop();
  }
});

test("dictation: \"start dictating\" types the ear's finals into the focused field (policy-gated), the phase shows acting, Live is told to stay quiet and delegations are refused; a password field ends it; \"stop dictating\" ends it", async () => {
  const w = world();
  const { engine, live, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    engine.ear("start dictating", true, 1, 1);
    await settle();
    assert.equal(engine.isDictating, true);
    assert.equal(engine.currentPhase, "acting");
    assert.ok(live.instructions.some((i) => /Kevin is dictating/.test(i)));
    engine.ear("start dictating dear ana thanks for the notes new line see you tomorrow", true, 1, 2);
    await settle(40);
    assert.deepEqual(hands.named("type").map((t) => t.params["text"]), ["dear ana thanks for the notes ", "see you tomorrow "]);
    assert.deepEqual(hands.named("key").map((k) => k.params["combo"]), ["Return"]);
    // Live delegates the dictated words as a task: refused, recorded.
    delegate(w, "dear ana thanks for the notes", "item_1");
    await settle();
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "cancelled");
    assert.equal(d.summary, "Kevin is dictating");
    // Focus lands in a password field: nothing is typed, dictation ends, Kevin is told.
    hands.secure = true;
    engine.ear("my secret word", true, 2, 3);
    await settle(40);
    assert.equal(hands.named("type").length, 2, "nothing typed into the password field");
    assert.equal(engine.isDictating, false);
    assert.ok(live.instructions.some((i) => /Dictation stopped: the focused field is a password field/.test(i)));
    // Again, then stop by voice.
    hands.secure = false;
    engine.ear("start dictating", true, 3, 4);
    await settle();
    assert.equal(engine.isDictating, true);
    engine.ear("start dictating hello stop dictating", true, 3, 5);
    await settle(40);
    assert.equal(hands.named("type").length, 3);
    assert.equal(engine.isDictating, false);
    assert.equal(engine.currentPhase, "listening");
  } finally {
    await engine.stop();
  }
});

test("circle that: the blob traces a frame around the element under the cursor (else the front window)", async () => {
  const w = world();
  const { engine, overlays } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    overlays.length = 0;
    engine.ear("circle that", true, 1, 1);
    await settle();
    const trace = overlays.find((o) => o.cmd === "orb.trace");
    assert.ok(trace && trace.cmd === "orb.trace", "an orb.trace went to the overlay");
    assert.equal(trace.label, "Save");
    assert.equal(trace.reason, "reflex circle");
    assert.ok(trace.points.length > 8);
  } finally {
    await engine.stop();
  }
});

test("reconciliation with Live's real ordering — transcript delta, a quiet moment, then the delegation: the prefire check only peeks, so the delegation still finds the ear's reflex and nothing scrolls twice", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    engine.ear("scroll down", true, 1, clock.t - 120);
    await settle();
    assert.equal(hands.named("scroll").length, 1);
    // Live's transcript lands ~400 ms later; its delegation another ~300 ms after that (the
    // Delegator's prefire window of 180 ms runs out in between and looks at the ear's reflex).
    clock.t += 400;
    const s = live.nowMs;
    live.nowMs += 900;
    live.emit("inputTranscript", " jarhead scroll down.", s, live.nowMs);
    await settle(320);
    assert.equal(hands.named("scroll").length, 1, "the prefire check did not scroll");
    live.emit("delegation", "item_1", "client", live.nowMs);
    await settle();
    assert.equal(hands.named("scroll").length, 1, "and the delegation did not either");
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "already did it");
    assert.deepEqual(live.commentary, ["scrolled down."]);
    assert.equal(brain.tasks.length, 0);
  } finally {
    await engine.stop();
  }
});

test("a longer request that merely ends with the ear's reflex is not 'already did it': the delegation notes the tail was done and the brain takes the rest without redoing it", async () => {
  const w = world();
  const { engine, hands, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    // The ear's 1.5 s gap rule split the clauses: "read me the headline" was left behind, "scroll down" fired.
    engine.ear("read me the headline", false, 1, clock.t);
    await settle(20);
    clock.t += 1600;
    engine.ear("read me the headline scroll down", true, 1, clock.t);
    await settle();
    assert.equal(hands.named("scroll").length, 1);
    delegate(w, "jarhead read me the headline scroll down", "item_1");
    await settle();
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "running", "the brain has it");
    assert.notEqual(d.summary, "already did it");
    assert.ok(d.steps.some((s) => s.kind === "note" && /already ran on the last words of this request/.test(s.text ?? "")), "the tail is noted for the brain");
    assert.equal(brain.tasks.length, 1);
    assert.equal(hands.named("scroll").length, 1, "the delegation did not scroll again");
    brain.resolve?.({ status: "done", summary: "the headline says hello." });
    await settle();
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_1")!.status, "done");
  } finally {
    await engine.stop();
  }
});

test("Jarhead's own words back through the microphone press nothing: while the voice is speaking the ear holds (consumes) everything but \"stop\"; a task running holds it too; muted holds it", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    // The voice says "Now press enter." — and the recogniser hears it (echo cancellation off).
    live.emit("outputTranscript", " Now press enter.", live.nowMs, live.nowMs + 600);
    assert.equal(engine.currentPhase, "speaking");
    engine.ear("now press enter", true, 3, clock.t);
    await settle();
    assert.equal(hands.named("key").length, 0, "Return was not pressed on the voice's own words");
    // Kevin talks over it: "stop" goes through.
    engine.ear("now press enter stop", false, 3, clock.t);
    await settle();
    assert.ok(live.instructions.some((i) => /Kevin said stop/.test(i)), "stop reached the engine while speaking");
    assert.equal(engine.outputGated, true);
    // The words heard while speaking stay consumed: the segment's later final fires nothing for them, Kevin's next words do.
    engine.ear("now press enter stop press escape", true, 3, clock.t);
    await settle();
    assert.deepEqual(hands.named("key").map((k) => k.params["combo"]), ["Escape"]);

    // A brain task running: the ear holds ("scroll under the brain's hands"); stop still works.
    clock.t += 3000;
    nextUtterance(w);
    delegate(w, "jarhead what is on my screen", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    engine.ear("scroll down", true, 4, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 0, "no scroll under a running task");
    engine.ear("scroll down stop", false, 4, clock.t);
    await settle();
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_1")!.status, "cancelled");
    clock.t += 3000; // past the stop's output gate
    engine.ear("scroll down stop scroll down", true, 4, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 1, "after the task is gone the ear acts again");

    // Muted: the mic button is Kevin's word that he is not talking to Jarhead.
    engine.setMuted(true);
    engine.ear("scroll up", true, 5, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 1);
    engine.setMuted(false);
    engine.ear("scroll up", true, 6, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 2);
  } finally {
    await engine.stop();
  }
});

test("after Stop the recogniser's late partial or final for the same segment runs nothing again; the careful window keeps a typed prefix from firing; \"right click save\" clicks nothing", async () => {
  const w = world();
  const { engine, hands, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    engine.ear("type hello", false, 7, clock.t);
    await settle(40);
    assert.equal(hands.named("type").length, 0, "a typed text waits out the careful window, not the short one");
    await settle(60);
    assert.equal(hands.named("type").length, 1);
    await engine.command({ type: "stop" });
    engine.ear("type hello", true, 7, clock.t + 300);
    await settle(100);
    assert.equal(hands.named("type").length, 1, "the late final did not type it again");
    // A prefix that grows within the careful window never types the prefix.
    clock.t += 3000;
    engine.ear("type good", false, 8, clock.t);
    await settle(40);
    engine.ear("type good morning", false, 8, clock.t);
    await settle(100);
    assert.deepEqual(hands.named("type").map((t) => t.params["text"]), ["hello", "good morning"]);
    // "right click save" is not "click save".
    engine.ear("right click save", true, 9, clock.t);
    await settle();
    assert.equal(hands.named("click").length, 0);
    assert.equal(hands.named("find_element").length, 0);
  } finally {
    await engine.stop();
  }
});

test("a typed mismatch where ⌘Z cannot reach (the focus is not a text field): the voice is told the text stands, the delegation goes to the brain with the note, and the full text is NOT typed again on top", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.frontApp = "Terminal";
    hands.focusedRole = "AXGroup";
    hands.ops.length = 0;
    engine.ear("type ls", true, 1, clock.t);
    await settle();
    assert.deepEqual(hands.named("type").map((t) => t.params["text"]), ["ls"]);
    delegate(w, "jarhead type ls dash la", "item_1");
    await settle(60);
    assert.deepEqual(hands.named("key").map((k) => k.params["combo"]), [], "no ⌘Z outside a text field");
    assert.ok(live.instructions.some((i) => /could not be undone/.test(i)), "the voice is told the text stands");
    assert.deepEqual(hands.named("type").map((t) => t.params["text"]), ["ls"], "the request's own type reflex did not run on top");
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.ok(d.steps.some((s) => /reflex mismatch/.test(s.text ?? "") && /could not be undone/.test(s.text ?? "")));
    assert.equal(brain.tasks.length, 1, "the brain takes it, screen first");
  } finally {
    await engine.stop();
  }
});
