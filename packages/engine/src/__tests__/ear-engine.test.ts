import { test } from "node:test";
import assert from "node:assert/strict";
import { delegate, nextUtterance, rows, settle, until, world } from "./world.ts";
import { Engine, earHintsFrom } from "../engine.ts";

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
    // Checked before any await: a partial never acts on arrival, only after its stability window.
    assert.equal(hands.named("scroll").length, 0, "a partial waits for the stability window");
    await until(() => hands.named("scroll").length === 1 && rows.length === 1, 3000); // the fired row lands a tick after the op
    assert.equal(hands.named("scroll").length, 1, "then the scroll was issued to the helper");
    assert.deepEqual(hands.named("scroll")[0]!.params, { dx: 0, dy: -300, modifiers: [] });
    assert.equal(rows.length, 1);
    const row = rows[0] as { phrase: string; action: string; earAt: number; ok: boolean; fired: string };
    assert.deepEqual([row.phrase, row.action, row.earAt, row.ok, row.fired], ["scroll down", "scroll down", heardAt, true, "stable"]);

    // Live catches up 400 ms later with the same words and delegates.
    clock.t += 400;
    delegate(w, "jarhead scroll down.", "item_1");
    await settle();
    // The delegator's "already did it" path is a few awaits deep; under a loaded runner it can outlast one settle.
    await until(() => engine.snapshot().delegations.find((x) => x.liveId === "item_1")?.status === "done", 3000);
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
    await until(() => engine.snapshot().delegations.find((x) => x.liveId === "item_2")?.status === "done", 3000);
    assert.equal(hands.named("key").length, 1);
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_2")!.status, "done");
  } finally {
    await engine.stop();
  }
});

test("ear: a final fires at once; \"click send\" is dropped by the policy with no pending confirmation left behind; \"click save\" clicks the one control by name; two candidates click nothing", async () => {
  const w = world();
  const { engine, hands, handsBg } = w;
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
    assert.equal(handsBg.named("find_element").length, 1, "the look went to the reading helper (SplitHands)");
    assert.equal(hands.named("find_element").length, 0, "never the acting one");
    assert.equal(hands.named("click").length, 1, "the one Save button was clicked at its centre, on the acting helper");
    // `expectFront`: the pid the gate's own probe saw in front rides on the click, so the helper posts nothing if the app moved.
    assert.deepEqual(hands.named("click")[0]!.params, { x: 530, y: 412, button: "left", count: 1, modifiers: [], expectFront: { pid: 1 } });
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
    await engine.command({ type: "sleep" });
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

test("typed while dictating: a line from the Console's composer is the voice's, never a reflex — 'open safari' typed during dictation opens nothing", async () => {
  const w = world();
  const { engine, live, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    engine.ear("start dictating", true, 1, 1);
    await settle();
    assert.equal(engine.isDictating, true);
    hands.ops.length = 0;
    await engine.command({ type: "say-text", text: "open safari" });
    assert.equal(hands.named("open_app").length, 0, "no reflex while dictating");
    assert.ok(live.instructions.some((i) => /Kevin just typed .*"open safari"\. Respond to it now/.test(i)), "the voice takes the line");
    engine.ear("stop dictating", true, 2, 2);
    await settle(40);
    assert.equal(engine.isDictating, false);
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
    await engine.command({ type: "interrupt" });
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

test("search through the ear: \"search the wiki for design\" with the wiki up in the front browser clicks the page's search field, types the words and presses Return after the careful window; Live's delegation for the same words is finished as already done with what was done on the record", async () => {
  const w = world();
  const { engine, live, hands, handsBg, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.frontApp = "Google Chrome";
    // The looks (frontmost, find_element) go to the READING helper (SplitHands); the click, the keys and the typing to the acting one.
    const original = handsBg.request.bind(handsBg);
    handsBg.request = async <T>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (op === "frontmost") return { app: hands.frontApp, pid: 1, window: { title: "Design system — Kevin's Wiki", x: 0, y: 0, w: 1200, h: 800, windowId: 1 } } as T;
      if (op === "find_element" && String(params["name"]) === "search") {
        handsBg.ops.push({ op, params, at: clock.t });
        const el = { i: 4, depth: 3, role: "AXTextField", title: "Search the wiki", app: hands.frontApp, score: 0.4, label: "Search the wiki", x: 500, y: 400, w: 60, h: 24, center: { x: 530, y: 412 }, pressable: false };
        return { app: hands.frontApp, window: "Design system — Kevin's Wiki", found: true, unique: true, candidates: 1, tier: "contains", element: el, cached: true, treeMs: 3, nodes: 120, truncated: false, ms: 1 } as T;
      }
      return original<T>(op, params);
    };
    hands.ops.length = 0;
    handsBg.ops.length = 0;
    const rows: { action: string; ok: boolean; did?: string; fired: string }[] = [];
    engine.on("reflex.fired", (row) => rows.push(row));

    const heardAt = clock.t;
    engine.ear("search the wiki for design", false, 1, heardAt);
    await settle(20);
    assert.equal(hands.named("type").length, 0, "a careful kind waits out its window");
    await settle(120);
    assert.deepEqual(handsBg.named("find_element").map((f) => [f.params["name"], f.params["role"]]), [["search", "pagefield"]], "the page's field, never the address bar");
    assert.equal(hands.named("click").length, 1, "the field was clicked");
    assert.deepEqual(hands.named("key").map((k) => k.params["combo"]), ["cmd+a", "Return"]);
    assert.deepEqual(hands.named("type").map((t) => t.params["text"]), ["design"]);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]!.action, rows[0]!.ok, rows[0]!.fired], ["search wiki for design", true, "stable"]);
    assert.equal(rows[0]!.did, 'typed "design" into the search field of Google Chrome and pressed Return');

    // Live catches up with the same words: finished as done, the reflex's line spoken, nothing typed twice.
    clock.t += 500;
    delegate(w, "Jarhead, search the wiki for design.", "item_1");
    await settle(60);
    assert.equal(brain.tasks.length, 0, "no brain");
    assert.deepEqual(hands.named("type").map((t) => t.params["text"]), ["design"], "typed once");
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    assert.equal(d.status, "done");
    assert.equal(d.summary, "already did it");
    // The line spoken is where the words landed (the batch's account, verified by its tool results), not the grammar's guess.
    assert.deepEqual(live.commentary, ['typed "design" into the search field of Google Chrome and pressed Return.']);
  } finally {
    await engine.stop();
  }
});

test("the ear is not held by output audio that is silence: GPT-Live-1 streams frames continuously, so only audible frames (or the output transcript) count as the voice speaking", async () => {
  const w = world();
  const { engine, live, hands, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    // Silence, as the API streams between sentences: frames keep arriving, nothing is audible.
    for (let i = 0; i < 5; i++) live.emit("audio", Buffer.alloc(480, 0));
    engine.ear("scroll down", true, 1, clock.t);
    await settle(30);
    assert.equal(hands.named("scroll").length, 1, "silent frames do not hold the ear");
    // Audible output (Jarhead talking): the same words are held.
    live.emit("audio", Buffer.alloc(480, 7));
    engine.ear("scroll down scroll up", true, 1, clock.t);
    await settle(30);
    assert.equal(hands.named("scroll").length, 1, "audible frames hold the ear");
    // The hold lapses with the speaking window; then the next words act.
    clock.t += 1300;
    engine.ear("scroll down scroll up scroll left", true, 1, clock.t);
    await settle(30);
    assert.equal(hands.named("scroll").length, 2);
    // The app's ear reports its own state on a negative segment: logged, never judged.
    engine.ear("off: Speech Recognition not decided", true, -1, clock.t);
    engine.ear("on (listening)", true, -1, clock.t);
    await settle(30);
    assert.equal(hands.named("scroll").length, 2);
  } finally {
    await engine.stop();
  }
});

test("ear hints: the AX warm tick turns the front window into `ear.hints` — app first, then the window, then the controls' titles (controls only, deduped) — once per change of the tree, never twice within 500 ms; asleep sends nothing", async () => {
  const w = world();
  const { engine, handsBg } = w;
  // The AX warm tick and the hints read the tree on the READING helper; the acting one stays free for a click.
  const original = handsBg.request.bind(handsBg);
  let nodes: Record<string, unknown>[] = [
    { i: 1, depth: 1, role: "AXButton", title: "Save" },
    { i: 2, depth: 1, role: "AXButton", title: "Add Folder" },
    { i: 3, depth: 1, role: "AXStaticText", title: "Some prose that is long" },
    { i: 4, depth: 2, role: "AXMenuItem", title: "Add to Reading List…" },
    { i: 5, depth: 2, role: "AXGroup", pressable: true, description: "Close" },
    { i: 6, depth: 2, role: "AXButton", title: "save" },
  ];
  const tree = (): Record<string, unknown> => ({ app: handsBg.frontApp, pid: 1, window: "Meeting notes", count: nodes.length, cached: true, ageMs: 1, treeMs: 3, truncated: false });
  handsBg.request = async <T,>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    handsBg.ops.push({ op, params, at: handsBg.now() });
    if (op === "ax_tree") return (params["summary"] ? tree() : { ...tree(), nodes }) as T;
    handsBg.ops.pop();
    return original<T>(op, params);
  };
  const sent: { at: number; strings: readonly string[] }[] = [];
  engine.on("ear.hints", (strings) => sent.push({ at: performance.now(), strings }));
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle(150);
    assert.equal(sent.length, 1, "one set after the first tick");
    const first = sent[0]!.strings;
    assert.deepEqual(first.slice(0, 2), ["Notes", "Meeting notes"], "the app, then the window");
    for (const want of ["Save", "Add Folder", "Add to Reading", "Close"]) assert.ok(first.includes(want), `${want} in ${JSON.stringify(first)}`);
    assert.ok(!first.some((s) => /prose/i.test(s)), "static text is not a control");
    assert.equal(first.filter((s) => s.toLowerCase() === "save").length, 1, "deduped case-insensitively");
    assert.ok(handsBg.named("ax_tree").some((o) => !o.params["summary"]), "the nodes were read from the cache");
    // The next tick sees the same tree: nothing new goes out, and the nodes are not re-read.
    const reads = handsBg.named("ax_tree").filter((o) => !o.params["summary"]).length;
    await settle(600);
    assert.equal(sent.length, 1);
    assert.equal(handsBg.named("ax_tree").filter((o) => !o.params["summary"]).length, reads, "same summary: no node read");
    // The tree changes: a new set, at least 500 ms after the first, carrying the new control.
    nodes = [...nodes, { i: 7, depth: 1, role: "AXButton", title: "Send" }];
    await settle(600);
    assert.equal(sent.length, 2, "a changed tree sends a new set");
    assert.ok(sent[1]!.at - sent[0]!.at >= 500, `paced: ${Math.round(sent[1]!.at - sent[0]!.at)} ms apart`);
    assert.ok(sent[1]!.strings.includes("Send"));
    // Asleep: the warm tick stops and nothing more is sent.
    await engine.command({ type: "sleep" });
    nodes = [...nodes, { i: 8, depth: 1, role: "AXButton", title: "Later" }];
    await settle(600);
    assert.equal(sent.length, 2);
  } finally {
    handsBg.request = original as typeof handsBg.request;
    await engine.stop();
  }
});

test("ear hints: earHintsFrom keeps controls only, three words at most, trims ellipses and edge punctuation, dedupes, caps 80 controls and 100 strings, app first, window second, agents last", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ i, depth: 1, role: "AXButton", title: `Button ${i}` }));
  const hints = earHintsFrom(many, "Google Chrome", "Kevin Wiki — Design notes and more", ["Codex · jarhead", "Claude Code · Kevin-Wiki-v3"]);
  assert.equal(hints[0], "Google Chrome");
  assert.equal(hints[1], "Kevin Wiki", "the window's first three words, the dangling dash trimmed");
  assert.equal(hints.filter((h) => h.startsWith("Button")).length, 80, "controls capped at 80");
  assert.deepEqual(hints.slice(-2), ["Codex · jarhead", "Claude Code"], "agents last, each cut to three words, a dangling separator trimmed");
  assert.ok(hints.length <= 100);
  const cleaned = earHintsFrom(
    [
      { i: 1, depth: 1, role: "AXButton", title: "Save…" },
      { i: 2, depth: 1, role: "AXButton", title: "+" },
      { i: 3, depth: 1, role: "AXStaticText", title: "Hello there" },
      { i: 4, depth: 1, role: "AXGroup", pressable: true, description: "Close window now please" },
      { i: 5, depth: 1, role: "AXMenuItem", title: "  Add   Folder " },
      { i: 6, depth: 1, role: "AXTextField", title: "", description: "" },
      { i: 7, depth: 1, role: "AXButton", title: "SAVE" },
    ],
    "",
    "",
    [],
  );
  assert.deepEqual(cleaned, ["Save", "Close window now", "Add Folder"]);
  const capped = earHintsFrom(many, "App", "Win", Array.from({ length: 40 }, (_, i) => `Agent ${i}`));
  assert.equal(capped.length, 100, "total capped at 100");
});

test("ear: a dismissal is judged before the hold and only to Jarhead — a final 'goodnight jarhead' sleeps it at once; a bare 'goodnight' with no exchange does nothing; 3 s after Jarhead spoke it fires; 'that is all' → 'that is all wrong' fires nothing; a stop is still a stop", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  type SleepRow = { type: "sleep"; phrase?: string; cause: string };
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    hands.ops.length = 0;
    // Past the exchange window: a bare "goodnight" is to someone in the room.
    clock.t += 9000;
    engine.ear("goodnight", true, 1, clock.t);
    await settle(120);
    assert.equal(rows<SleepRow>(w, "sleep").length, 0);
    assert.equal(live.currentState, "started");
    // A prefix that grows within the careful window never fires.
    live.emit("outputTranscript", " all done.", live.nowMs, live.nowMs + 300);
    engine.ear("that is all", false, 2, clock.t);
    await settle(20);
    engine.ear("that is all wrong", false, 2, clock.t);
    await settle(150);
    assert.equal(rows<SleepRow>(w, "sleep").length, 0);
    // "stop" is the interrupt, even now.
    delegate(w, "jarhead what is on my screen", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    engine.ear("stop", true, 3, clock.t);
    await settle();
    assert.equal(engine.snapshot().delegations[0]!.status, "cancelled");
    assert.equal(rows<SleepRow>(w, "sleep").length, 0);
    assert.equal(live.currentState, "started");
    // Mid-exchange, a bare "goodnight" 3 s after Jarhead spoke is to Jarhead — and a held ear still hears it.
    clock.t += 3000;
    live.emit("outputTranscript", " stopped.", live.nowMs + 100, live.nowMs + 400);
    clock.t += 3000;
    engine.ear("goodnight", true, 4, clock.t);
    await settle();
    assert.equal(rows<SleepRow>(w, "sleep").length, 1);
    assert.equal(rows<SleepRow>(w, "sleep")[0]!.phrase, "goodnight");
    assert.equal(rows<SleepRow>(w, "sleep")[0]!.cause, "said");
    assert.ok(live.instructions.includes(Engine.FAREWELL_LINE));
    live.emit("outputTranscript", " night.", live.nowMs + 500, live.nowMs + 800);
    await until(() => live.closes === 1, 1000);
    assert.equal(engine.currentPhase, "asleep");
    // Asleep, the ear is off: a final "goodnight jarhead" sleeps nothing twice.
    engine.ear("goodnight jarhead", true, 5, clock.t);
    await settle();
    assert.equal(rows<SleepRow>(w, "sleep").length, 1);
  } finally {
    await engine.stop();
  }
});

// ---------------------------------------------------------------- threads (pass 4)

test("ear: a meta kind passes the hold — 'what are you doing' over a running brain task is answered from the table on the delegation under way (no generation), while an ordinary reflex is still held; 'what time is it' is Jarhead's own line from the clock", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await settle();
    delegate(w, "jarhead what is on my screen", "item_1");
    await settle();
    assert.equal(brain.tasks.length, 1);
    hands.ops.length = 0;
    live.commentary.length = 0;
    // Held: a scroll under the brain's hands.
    engine.ear("scroll down", true, 1, clock.t);
    await settle(60);
    assert.equal(hands.named("scroll").length, 0, "an ordinary reflex is held while the task runs");
    // Not held: a meta kind acts on Jarhead, not the screen (with no thread live the overview wants the wake word).
    engine.ear("jarhead what are you doing", true, 2, clock.t);
    await until(() => live.commentary.length > 0, 1500);
    assert.match(live.commentary[0]!, /^I am working on it — \d+ seconds in$/);
    assert.equal(brain.tasks.length, 1, "no generation");
    assert.equal(brain.cancels, 0, "the running turn untouched");
    engine.ear("what time is it", true, 3, clock.t);
    await until(() => live.commentary.length > 1, 1500);
    assert.match(live.commentary[1]!, /^it's \d{1,2}:\d{2} [ap]m\.$/);
    assert.equal(hands.ops.length, 0, "no hands for either");
  } finally {
    await engine.stop();
  }
});
