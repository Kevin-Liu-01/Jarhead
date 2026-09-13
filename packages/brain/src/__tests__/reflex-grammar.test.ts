import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfirmationState } from "@jarhead/hands";
import { Transcript, type LiveSession } from "@jarhead/live";
import { EventEmitter } from "node:events";
import { Delegator } from "../delegator.ts";
import { BROWSER_APPS, ReflexRunner, endsTerminally, parseReflex, similarity, type Reflex, type ReflexOutcome } from "../reflex.ts";
import type { Brain, BrainTask } from "../brain.ts";
import { FakeHands, makeRunner } from "./fakes.ts";

/**
 * The reflex grammar the ear and the Delegator share (REDESIGN §12): every phrase
 * in the fixed table parses to one tool call; near-misses, compounds and anything
 * that needs a look do not. Browser-only reflexes need a browser in front.
 */

/** [utterance, kind, tool, input] */
const TABLE: ReadonlyArray<readonly [string, string, string, Record<string, unknown>]> = [
  ["scroll down", "scroll", "scroll", { scroll_direction: "down", scroll_amount: 5 }],
  ["scroll up a bit", "scroll", "scroll", { scroll_direction: "up", scroll_amount: 2 }],
  ["scroll down a lot", "scroll", "scroll", { scroll_direction: "down", scroll_amount: 15 }],
  ["scroll left", "scroll", "scroll", { scroll_direction: "left", scroll_amount: 5 }],
  ["scroll right", "scroll", "scroll", { scroll_direction: "right", scroll_amount: 5 }],
  ["scroll to the top", "scroll", "key", { text: "cmd+Up" }],
  ["scroll down to the bottom", "scroll", "key", { text: "cmd+Down" }],
  ["page down", "page", "key", { text: "Page_Down" }],
  ["page up", "page", "key", { text: "Page_Up" }],
  ["press enter", "key", "key", { text: "Return" }],
  ["hit return", "key", "key", { text: "Return" }],
  ["press escape", "key", "key", { text: "Escape" }],
  ["press the tab key", "key", "key", { text: "Tab" }],
  ["press space", "key", "key", { text: "space" }],
  ["press delete", "key", "key", { text: "Delete" }],
  ["select all", "edit", "key", { text: "cmd+a" }],
  ["copy", "edit", "key", { text: "cmd+c" }],
  ["cut", "edit", "key", { text: "cmd+x" }],
  ["paste", "edit", "key", { text: "cmd+v" }],
  ["paste it", "edit", "key", { text: "cmd+v" }],
  ["undo", "edit", "key", { text: "cmd+z" }],
  ["undo that", "edit", "key", { text: "cmd+z" }],
  ["redo", "edit", "key", { text: "cmd+shift+z" }],
  ["new tab", "tab", "key", { text: "cmd+t" }],
  ["open a new tab", "tab", "key", { text: "cmd+t" }],
  ["close tab", "tab", "key", { text: "cmd+w" }],
  ["close this tab", "tab", "key", { text: "cmd+w" }],
  ["next tab", "tab", "key", { text: "ctrl+Tab" }],
  ["previous tab", "tab", "key", { text: "ctrl+shift+Tab" }],
  ["reload", "reload", "key", { text: "cmd+r" }],
  ["refresh the page", "reload", "key", { text: "cmd+r" }],
  ["back", "back", "key", { text: "cmd+[" }],
  ["go back", "back", "key", { text: "cmd+[" }],
  ["go forward", "forward", "key", { text: "cmd+]" }],
  ["zoom in", "zoom", "key", { text: "cmd+=" }],
  ["zoom out", "zoom", "key", { text: "cmd+-" }],
  ["close this window", "close_window", "key", { text: "cmd+w" }],
  ["type hello world", "type", "type", { text: "hello world" }],
  ["write see you tomorrow", "type", "type", { text: "see you tomorrow" }],
  ["open safari", "open_app", "open_app", { name: "Safari" }],
  ["switch to visual studio code", "open_app", "open_app", { name: "Visual Studio Code" }],
  ["go to slack", "open_app", "open_app", { name: "Slack" }],
  ["go to github.com", "go_to", "go_to", { url: "https://github.com/" }],
  ["go to github dot com", "go_to", "go_to", { url: "https://github.com/" }],
  ["go to hacker news", "go_to", "go_to", { url: "https://news.ycombinator.com/" }],
  ["go to localhost 3000", "go_to", "go_to", { url: "http://localhost:3000/" }],
  ["click save", "click", "click_element", { name: "save" }],
  ["click the add folder button", "click", "click_element", { name: "add folder" }],
  ["tap on next", "click", "click_element", { name: "next" }],
  ["double click readme", "double_click", "click_element", { name: "readme", count: 2 }],
  ["double-click the notes folder", "double_click", "click_element", { name: "notes", count: 2 }],
  ["screenshot this", "screenshot", "screenshot", { quick: true }],
  ["circle that", "circle", "circle", {}],
  ["highlight this", "circle", "circle", {}],
  ["start dictating", "dictate_start", "dictate", { on: true }],
  ["take dictation", "dictate_start", "dictate", { on: true }],
  ["stop dictating", "dictate_stop", "dictate", { on: false }],
  ["end dictation", "dictate_stop", "dictate", { on: false }],
];

test("grammar: every phrase in the table is one tool call, wrapped in the wake word and politeness or bare", () => {
  for (const [utterance, kind, tool, input] of TABLE) {
    for (const said of [utterance, `Jarhead, ${utterance} please.`, `hey jar head ${utterance}`]) {
      const r = parseReflex(said);
      assert.ok(r, `${JSON.stringify(said)} should be a reflex`);
      assert.equal(r.kind, kind, said);
      assert.equal(r.tool, tool, said);
      assert.deepEqual(r.input, input, said);
    }
  }
});

test("grammar: compounds, descriptions, pronouns, positions, ambiguous phrases and 'copy that' are not reflexes", () => {
  for (const s of [
    "scroll down to the footer and click save",
    "scroll down until you see the total",
    "scroll down three times",
    "press enter twice",
    "click the third row",
    "click it",
    "click the blue button",
    "type the address from the email",
    "open the file",
    "open my downloads folder",
    "go to the settings page",
    "copy that",
    "what app is open",
    "double click on it",
    "circle the save button",
    "start dictating my email",
    "right click save",
    "click the thing",
    "click the one",
    "click the link",
    "click the blue one",
    "double click the thing",
    "",
    "scroll",
    "zoom",
    "new",
  ]) {
    assert.equal(parseReflex(s), undefined, s);
  }
  // A single generic noun may be a literal label ("Link", "Tab", "Button" as a control's own name).
  assert.equal(parseReflex("click link")!.input["name"], "link");
});

/**
 * Kevin's request 2: "go to sleep or shut off or things like that are cues to return to
 * dock and go to sleep." One grammar for the ear, the Delegator and Live's delegation
 * path — the whole utterance, anchored, wake word and politeness stripped.
 */
const SLEEP_POSITIVE: readonly string[] = [
  "go to sleep",
  "jarhead go to sleep",
  "Jarhead, go to sleep please.",
  "go back to sleep",
  "back to sleep",
  "sleep now",
  "shut off",
  "shut yourself off",
  "shut yourself down",
  "turn yourself off",
  "turn your self off",
  "power down",
  "power off",
  "goodnight",
  "goodnight jarhead",
  "good night jarhead",
  "Goodnight, Jarhead.",
  "good night night",
  "night night",
  "that is all",
  "that's all",
  "that’s all",
  "that will be all",
  "that will be all, thanks",
  "that'll be all",
  "that's all for now",
  "that is all for today",
  "that's it for tonight",
  "hey jarhead that'll be all for tonight",
  "dismissed",
  "you're dismissed",
  "you are dismissed",
  "you can rest",
  "you can rest now",
  "you may rest",
  "go to bed",
  "stand down",
  "go dormant",
];

/** Not cues: bare words, negations, trailing clauses, objects, room talk, and the commands that share a word with one. */
const SLEEP_NEGATIVE: readonly string[] = [
  "shut down",
  "shut down my mac",
  "shut down the computer",
  "sleep",
  "night",
  "night.",
  "stop",
  "cancel",
  "going to sleep",
  "i'm going to sleep now",
  "turn off the lights",
  "turn yourself off after this",
  "turn it off",
  "put the display to sleep",
  "sleep timer for spotify",
  "don't go to sleep",
  "do not go to sleep",
  "is that all",
  "that is all wrong",
  "that's all i wanted to say about it",
  "you can rest assured",
  "dismissed the dialog",
  "night mode",
  "power down the volume",
  "stand down the alert",
  "go to slack",
  "go to safari",
  "stop dictating",
  "good morning",
  // Longer than the cue and not an app: neither a sleep nor a phantom `open_app "Sleep Mode"` / `"Bed Early"`.
  "go to sleep mode",
  "go to bed early",
];

test("sleep grammar: every dismissal in the table is a sleep cue — never a tool, never prefired, Kevin's words as the phrase", () => {
  for (const said of SLEEP_POSITIVE) {
    const r = parseReflex(said);
    assert.ok(r, `${JSON.stringify(said)} should be a sleep cue`);
    assert.equal(r.kind, "sleep", said);
    assert.equal(r.tool, "sleep", said);
    assert.equal(r.said, "night.", said);
    assert.equal(r.label, "go to sleep", said);
    assert.equal(r.prefire, false, `${said}: a dismissal never runs ahead of Live's word`);
    assert.equal(r.idempotent, true, said);
    assert.equal(r.input["phrase"], said.trim().replace(/\s+/g, " "), "the phrase is what Kevin said, for the ledger's sleep row");
  }
  // Today's defect: at f6c3b40 these were `open_app Sleep` and `open_app Bed`.
  assert.equal(parseReflex("go to sleep")!.kind, "sleep");
  assert.equal(parseReflex("go to bed")!.kind, "sleep");
  // The row that used to take them still takes an app.
  assert.deepEqual(parseReflex("go to slack"), { kind: "open_app", tool: "open_app", input: { name: "Slack" }, said: "opened Slack.", label: "open Slack", prefire: false, idempotent: true });
});

test("sleep grammar: bare words, negations, trailing clauses, objects and room talk are not cues; the commands sharing a word keep their own row", () => {
  for (const said of SLEEP_NEGATIVE) assert.notEqual(parseReflex(said)?.kind, "sleep", `${JSON.stringify(said)} must not be a sleep cue (got ${JSON.stringify(parseReflex(said))})`);
  assert.equal(parseReflex("go to slack")!.kind, "open_app");
  assert.equal(parseReflex("stop dictating")!.kind, "dictate_stop");
  for (const said of ["shut down", "shut down my mac", "sleep", "night", "stop", "turn off the lights", "that is all wrong", "don't go to sleep", "dismissed the dialog", "night mode", "go to sleep mode", "go to bed early"]) assert.equal(parseReflex(said), undefined, `${said}: not a reflex at all`);
});

test("sleep grammar: ReflexRunner.match never hands a sleep cue out as a reflex to run — the ear and the Delegator ask parseReflex for it", () => {
  const { runner } = makeRunner({}, new FakeHands());
  const reflexes = new ReflexRunner({ runner, frontmostApp: async () => "Finder" });
  for (const said of SLEEP_POSITIVE) assert.equal(reflexes.match(said), undefined, said);
  assert.equal(reflexes.match("scroll down")?.kind, "scroll", "everything else still matches");
  assert.equal(reflexes.match("go to slack")?.kind, "open_app");
});

test("grammar: flags — idempotent vs not, prefire, browserOnly; terminal tails; similarity", () => {
  assert.equal(parseReflex("scroll down")!.idempotent, true);
  assert.equal(parseReflex("screenshot this")!.idempotent, true);
  assert.equal(parseReflex("open safari")!.idempotent, true);
  assert.equal(parseReflex("press enter")!.idempotent, false);
  assert.equal(parseReflex("type hello")!.idempotent, false);
  assert.equal(parseReflex("click save")!.idempotent, false);
  assert.equal(parseReflex("scroll down")!.prefire, true);
  assert.equal(parseReflex("press enter")!.prefire, false);
  for (const s of ["new tab", "close tab", "next tab", "previous tab", "reload", "back", "go forward"]) assert.equal(parseReflex(s)!.browserOnly, true, s);
  assert.equal(parseReflex("scroll down")!.browserOnly, undefined);
  assert.ok(endsTerminally("scroll down.") && endsTerminally("scroll down please") && endsTerminally("press enter now") && !endsTerminally("scroll down"));
  assert.ok(BROWSER_APPS.test("Google Chrome") && BROWSER_APPS.test("Safari") && BROWSER_APPS.test("Arc") && !BROWSER_APPS.test("Finder"));
  assert.equal(similarity("scroll down", "scroll down"), 1);
  assert.ok(similarity("type hello there", "type hello their") > 0.8);
  assert.ok(similarity("type hello there", "type hello there everyone how are you today") < 0.8);
});

test("ReflexRunner: browser-only reflexes need a browser in front; clicks go through click_element by name; go to navigates the browser in front else opens the default browser", async () => {
  const hands = new FakeHands();
  const { runner } = makeRunner({}, hands);
  let front = "Finder";
  const calls: string[] = [];
  const origRun = runner.run.bind(runner);
  runner.run = async (name, input) => {
    calls.push(name);
    if (name === "browser_navigate" || name === "open_url") return { result: { kind: "text", text: "ok" }, ms: 1 };
    return origRun(name, input);
  };
  const reflexes = new ReflexRunner({ runner, frontmostApp: async () => front });
  const tab = await reflexes.run(reflexes.match("new tab")!);
  assert.equal(tab.ok, false, "Finder in front: no browser shortcut");
  assert.match((tab.result as { message: string }).message, /no browser in front/);
  front = "Google Chrome";
  const tab2 = await reflexes.run(reflexes.match("new tab")!);
  assert.equal(tab2.ok, true);
  assert.equal(calls.at(-1), "key");
  const go = await reflexes.run(reflexes.match("go to github.com")!);
  assert.equal(go.ok, true);
  assert.equal(calls.at(-1), "browser_navigate");
  front = "Finder";
  await reflexes.run(reflexes.match("go to github.com")!);
  assert.equal(calls.at(-1), "open_url");
  const click = await reflexes.run(reflexes.match("click save")!);
  assert.equal(calls.at(-1), "click_element");
  assert.equal(click.ok, false, "the fake hands' find_element finds nothing: the brain takes it");
});

/** A LiveSession stand-in with the surface the delegator touches. */
class FakeLive extends EventEmitter {
  sent: { type: string; content: string }[] = [];
  nowMs = 5000;
  appendThinking(_id: string | null, content: string): string { this.sent.push({ type: "thinking", content }); return "t"; }
  appendCommentary(_id: string | null, content: string): string { this.sent.push({ type: "commentary", content }); return "c"; }
  appendInstructions(_id: string | null, content: string): string { this.sent.push({ type: "instructions", content }); return "i"; }
}

test("delegator: a `refuse` reason records the delegation and finishes it as cancelled with that reason, without the brain; a prefire is skipped when the ear already did the words", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain: Brain = { kind: "fake", start: async () => ({ ready: true, detail: "" }), handle: async (task) => { seen.push(task); return { status: "done", summary: "done." }; }, cancel: async () => undefined, stop: async () => undefined };
  let refuse: string | undefined = "paused";
  const ran: string[] = [];
  let earDid = false;
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex): Promise<ReflexOutcome> => {
      ran.push(reflex.label);
      return { reflex, result: { kind: "text", text: "OK" }, ms: 1, ok: true };
    },
    inExchange: () => true,
    reconcile: (u: string) => (earDid && /scroll down/.test(u) ? { kind: "done" as const, fired: { id: "x", phrase: "scroll down", reflex: parseReflex("scroll down")!, source: "ear" as const, earAt: 1, matchedAt: 2, dispatchedAt: 3, doneAt: 4, ok: true }, similarity: 1 } : undefined),
    peek: (u: string) => (earDid && /scroll down/.test(u) ? { kind: "done" as const, fired: { id: "x", phrase: "scroll down", reflex: parseReflex("scroll down")!, source: "ear" as const, earAt: 1, matchedAt: 2, dispatchedAt: 3, doneAt: 4, ok: true }, similarity: 1 } : undefined),
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), reflexes, refuse: () => refuse, prefireQuietMs: 10, commentaryCoalesceMs: 0 });
  transcript.push({ speaker: "kevin", delta: "jarhead open safari", startMs: 0, endMs: 700 });
  live.emit("delegation", "item_1", "client", 700);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 0);
  assert.deepEqual(ran, []);
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "paused");
  assert.ok(d.all()[0]!.steps.some((s) => s.text === "not run: paused"));

  refuse = undefined;
  earDid = true;
  live.nowMs = 3700;
  const say = (delta: string, s: number, e: number): void => {
    live.emit("inputTranscript", delta, s, e);
    transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
  };
  say(" jarhead scroll down.", 3000, 3700);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(ran, [], "the ear did it: no prefire");
  live.emit("delegation", "item_2", "client", 3700);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, [], "and no reflex on the delegation either");
  const dlg = d.all()[1]!;
  assert.equal(dlg.status, "done");
  assert.equal(dlg.summary, "already did it");
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.content), ["scrolled down."]);
  d.dispose();
});

// ---------------------------------------------------------------- pass 4: fillers, tails, media, window, time, thread verbs

import { classifyAction, classifyAppleScript } from "@jarhead/core";
import { FILLER_HEAD, TAIL_KINDS, normalizeUtterance, parseReflexTail } from "../reflex.ts";

/**
 * Kevin's real utterances (heard rows, 09-10..12) start with fillers and end with the
 * command: 0 of 119 requests parsed whole, 1 last clause did, 2 after stripping fillers.
 * The filler strip and the tail are the enabling change; every new row is one the
 * policy runs without a question and none is a destructive verb.
 */

test("fillers and transcriber tags at the head are stripped before the grammar; a bare yes / okay stays whole", () => {
  const TABLE: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
    ["um, okay, scroll down", "scroll", { scroll_direction: "down", scroll_amount: 5 }],
    ["[chuckle] yeah press enter", "key", { text: "Return" }],
    ["oh awesome. open safari", "open_app", { name: "Safari" }],
    ["jarhead, um, scroll down", "scroll", { scroll_direction: "down", scroll_amount: 5 }],
    ["yeah so like go to github.com", "go_to", { url: "https://github.com/" }],
    ["so type hello there", "type", { text: "hello there" }],
    ["(laughs) okay so, hey jarhead, page down", "page", { text: "Page_Down" }],
    ["alright then, um, take a screenshot", "screenshot", { quick: true }],
    ["well, actually, zoom in", "zoom", { text: "cmd+=" }],
  ];
  for (const [said, kind, input] of TABLE) {
    const r = parseReflex(said);
    assert.ok(r, `${JSON.stringify(said)} should be a reflex`);
    assert.equal(r.kind, kind, said);
    assert.deepEqual(r.input, input, said);
  }
  assert.equal(normalizeUtterance("um, okay, scroll down"), "scroll down");
  assert.equal(normalizeUtterance("yes"), "yes", "a bare yes is left for the yes gate");
  assert.equal(normalizeUtterance("okay"), "okay");
  // A lone filler with its punctuation is the utterance, not a head: as at 2633faf.
  assert.equal(normalizeUtterance("okay."), "okay");
  assert.equal(normalizeUtterance("yes."), "yes");
  assert.equal(normalizeUtterance("great."), "great");
  assert.equal(normalizeUtterance("um"), "um");
  assert.equal(normalizeUtterance("right click save"), "right click save", "'right' is not a filler: right click is a command of its own");
  assert.equal(parseReflex("yes"), undefined);
  assert.equal(parseReflex("um"), undefined);
  // THE DECISION the shared list makes for the ear's stop test (ear.ts reads STOP_WORDS through
  // normalizeUtterance): these lead-ins now cut, where at 2633faf only the ear's own list did
  // (um/uh/erm/so/like/okay/ok/alright/hey/yeah/yes). Pinned so a wider list is a choice, not a drift.
  for (const [said, phrase] of [
    ["oh stop", "stop"],
    ["well, hold on", "hold on"],
    ["actually, cancel", "cancel"],
    ["great. stop", "stop"],
    ["anyway stop", "stop"],
    ["hmm stop", "stop"],
    ["cool stop", "stop"],
    ["nice, cancel", "cancel"],
    ["yep. stop", "stop"],
    ["basically stop", "stop"],
    ["so stop", "stop"],
    ["yeah stop", "stop"],
  ] as const) assert.equal(normalizeUtterance(said), phrase, said);
  assert.ok(FILLER_HEAD instanceof RegExp && FILLER_HEAD.test("oh stop") && !FILLER_HEAD.test("stop"), "the list is exported for the ear and the miner: one list, not three");
  assert.equal("okay.".replace(FILLER_HEAD, ""), "okay.", "a lone filler is not stripped by the list itself either");
});

test("tail matching: the last clause runs on its own only for TAIL_KINDS; the head is left to the brain; a whole command or a non-tail kind is not a tail", () => {
  // Kevin's own example: the fillers peel and the whole is the command — no tail needed (the prefire path takes it).
  assert.equal(parseReflex("yeah okay. jarhead, scroll down")?.kind, "scroll");
  assert.equal(parseReflexTail("yeah okay. jarhead, scroll down"), undefined, "whole, not a tail");
  const scroll = parseReflexTail("read me the headline. jarhead, scroll down");
  assert.ok(scroll);
  assert.equal(scroll.reflex.kind, "scroll");
  assert.equal(scroll.head, "read me the headline.");
  assert.equal(scroll.tail, "jarhead, scroll down");
  const page = parseReflexTail("read me the headline, then page down");
  assert.equal(page?.reflex.kind, "page");
  assert.equal(page?.head, "read me the headline");
  const shot = parseReflexTail("okay that looks right jarhead take a screenshot");
  assert.equal(shot?.reflex.kind, "screenshot");
  assert.equal(shot?.head, "okay that looks right");
  const app = parseReflexTail("i need to check something. open slack");
  assert.equal(app?.reflex.kind, "open_app");
  assert.deepEqual(app?.reflex.input, { name: "Slack" });
  assert.equal(parseReflexTail("yeah okay. jarhead, type hello"), undefined, "type is not a tail kind: words to type are judged whole");
  assert.equal(parseReflexTail("that one is wrong. click save"), undefined, "click is not a tail kind");
  assert.equal(parseReflexTail("scroll down to the footer and click save"), undefined, "no clause boundary, no tail");
  assert.equal(parseReflexTail("scroll down"), undefined, "a whole command is not a tail");
  assert.equal(parseReflexTail("um, okay, scroll down"), undefined, "fillers make it whole, not a tail");
  assert.equal(parseReflexTail("it is 5 o'clock. go to sleep"), undefined, "a dismissal is never a tail");
  assert.equal(parseReflexTail(""), undefined);
  for (const k of ["type", "click", "double_click", "key", "edit", "search", "close_window", "dictate_start", "dictate_stop", "sleep"]) assert.ok(!TAIL_KINDS.has(k as never), `${k} never runs as a tail`);
  const names = ["Slack", "Spotify"];
  const status = parseReflexTail("let me think about it. what is spotify doing", { threadNames: names });
  assert.equal(status?.reflex.kind, "thread_status");
  assert.deepEqual(status?.reflex.input, { name: "Spotify" });
  const stop = parseReflexTail("no wait, stop the slack one", { threadNames: names });
  assert.equal(stop, undefined, "no clause boundary before 'stop the slack one': whole-utterance rules (the stop rule is the Delegator's)");
  // At 2633faf the OPEN row read "go to github.com. jarhead scroll down" as ONE site and navigated to
  // `https://github.com.jarheadscrolldown/` (spaces collapsed into the host). An address never has a
  // space in it: the whole does not parse, and the tail is the reflex.
  assert.equal(parseReflex("go to github.com. jarhead scroll down"), undefined, "never a navigation to a garbage host");
  assert.equal(parseReflex("go to github.com jarhead scroll down"), undefined);
  const afterGoTo = parseReflexTail("go to github.com. jarhead scroll down");
  assert.equal(afterGoTo?.reflex.kind, "scroll");
  assert.equal(afterGoTo?.head, "go to github.com.");
  assert.equal(parseReflexTail("go to github.com jarhead scroll down")?.reflex.kind, "scroll", "the wake word inside marks the tail when no sentence ends");
  // The addresses the row does take, unchanged.
  assert.deepEqual(parseReflex("go to github.com")!.input, { url: "https://github.com/" });
  assert.deepEqual(parseReflex("go to github.com/kevin")!.input, { url: "https://github.com/kevin" });
  assert.deepEqual(parseReflex("go to hacker news")!.input, { url: "https://news.ycombinator.com/" }, "a two-word SITE still resolves by name (never through urlOf)");
  assert.deepEqual(parseReflex("go to localhost 3000")!.input, { url: "http://localhost:3000/" });
  assert.deepEqual(parseReflex("go to localhost port 8080")!.input, { url: "http://localhost:8080/" });
});

/** workers.ts's FOCUS_APPLESCRIPT (a copy; the engine package is not this test's to import): a script that drives the screen rather than an app's dictionary. */
const FOCUS_APPLESCRIPT = /\b(keystroke|key code|click|set value|set the value|perform action|activate|open location|reopen|set frontmost)\b/i;

test("media rows: play / pause / next / previous / volume / mute by Apple event to the music app, only when the policy says run and never a screen script", () => {
  const TABLE: ReadonlyArray<readonly [string, RegExp, string, boolean]> = [
    ["play", /^if application "Spotify" is running then tell application "Spotify" to play$/, "playing.", true],
    ["resume the music", /to play$/, "playing.", true],
    ["pause the music", /^if application "Spotify" is running then tell application "Spotify" to pause$/, "paused.", true],
    ["pause", /to pause$/, "paused.", true],
    ["pause spotify", /"Spotify" to pause$/, "paused.", true],
    ["next track", /to next track$/, "next track.", false],
    ["skip this song", /to next track$/, "next track.", false],
    ["skip the track", /to next track$/, "next track.", false],
    ["skip ahead", /to next track$/, "next track.", false],
    ["previous track", /to previous track$/, "previous track.", false],
    ["turn the volume up", /to set sound volume to \(sound volume \+ 10\)$/, "louder.", false],
    ["volume down", /to set sound volume to \(sound volume - 10\)$/, "quieter.", false],
    ["a bit louder", /\+ 10\)$/, "louder.", false],
    ["make it quieter", /- 10\)$/, "quieter.", false],
    ["lower the volume", /- 10\)$/, "quieter.", false],
    ["unpause the music", /to play$/, "playing.", true],
    ["mute the music", /^set volume output muted true$/, "muted.", true],
    ["unmute the sound", /^set volume output muted false$/, "unmuted.", true],
    ["play on apple music", /^if application "Music" is running then tell application "Music" to play$/, "playing.", true],
  ];
  for (const [said, script, spoken, idempotent] of TABLE) {
    const r = parseReflex(said);
    assert.ok(r, `${JSON.stringify(said)} should be a media reflex`);
    assert.equal(r.kind, "media", said);
    assert.equal(r.tool, "applescript", said);
    assert.match(String(r.input["script"]), script, said);
    assert.equal(r.said, spoken, said);
    assert.equal(r.idempotent, idempotent, `${said}: idempotent`);
    assert.equal(r.prefire, false, `${said}: waits for the word`);
    assert.equal(classifyAppleScript({ script: String(r.input["script"]) }).verdict, "run", `${said}: the policy runs it without a question`);
    assert.ok(!FOCUS_APPLESCRIPT.test(String(r.input["script"])), `${said}: background-safe, no keystroke or click`);
  }
  for (const s of ["play with fire", "next", "previous", "stop the music", "turn it up", "mute", "play the video", "pause for a second", "skip the intro"]) assert.notEqual(parseReflex(s)?.kind, "media", `${s}: not a media row`);
  assert.equal(parseReflex("play with fire"), undefined);
  // One-word rows fire from the ear with no wake word: room talk. Only "play" and "pause" (DECISIONS' two) stay bare.
  for (const s of ["skip", "resume", "unpause", "louder", "quieter", "softer", "skip.", "louder!"]) assert.equal(parseReflex(s), undefined, `${s}: a bare word is room talk, not a media row`);
  assert.equal(parseReflex("play")!.kind, "media");
  assert.equal(parseReflex("pause")!.kind, "media");
});

test("window rows: minimise, hide and full screen are shortcuts with an inverse; the clock row answers without a tool", () => {
  assert.deepEqual([parseReflex("minimize this window")!.kind, parseReflex("minimize this window")!.input], ["window", { text: "cmd+m" }]);
  assert.deepEqual(parseReflex("minimise the window")!.input, { text: "cmd+m" });
  assert.deepEqual(parseReflex("hide this window")!.input, { text: "cmd+h" });
  const full = parseReflex("full screen")!;
  assert.deepEqual([full.kind, full.tool, full.input, full.said, full.idempotent], ["window", "key", { text: "ctrl+cmd+f" }, "full screen.", false]);
  assert.equal(parseReflex("exit full screen")!.said, "left full screen.");
  assert.equal(parseReflex("make it full screen")!.kind, "window");
  for (const s of ["minimize", "hide", "full screen mode please open it", "close the window and the tab"]) assert.notEqual(parseReflex(s)?.kind, "window", s);
  assert.equal(parseReflex("close this window")!.kind, "close_window", "the close row is unchanged");

  const at = new Date(2026, 8, 13, 16, 52).getTime();
  const time = parseReflex("what time is it", { now: () => at })!;
  assert.deepEqual([time.kind, time.tool, time.meta, time.idempotent, time.prefire], ["say", "say", true, true, false]);
  assert.equal(time.said, "it's 4:52 pm.");
  assert.equal(time.input["text"], time.said);
  assert.equal(parseReflex("Jarhead, what's the time?", { now: () => at })!.said, "it's 4:52 pm.");
  assert.equal(parseReflex("what's the date", { now: () => at })!.said, "it's Sunday, September 13.");
  assert.equal(parseReflex("what day is it today", { now: () => at })!.kind, "say");
  assert.match(parseReflex("what time is it")!.said, /^it's \d{1,2}:\d{2} [ap]m\.$/, "without a clock, the real one");
  for (const s of ["what time is the meeting", "what is the time zone", "time"]) assert.equal(parseReflex(s), undefined, s);
});

test("thread verbs: status / list / stop / pause / resume against the LIVE names the caller gives, meta and idempotent, never without the names; 'stop' alone stays the interrupt's", () => {
  const ctx = { threadNames: ["Slack", "Spotify"] };
  const TABLE: ReadonlyArray<readonly [string, string, Record<string, unknown>]> = [
    ["what is spotify doing", "thread_status", { name: "Spotify" }],
    ["what's slack up to", "thread_status", { name: "Slack" }],
    ["how is the spotify one going", "thread_status", { name: "Spotify" }],
    ["how's slack doing", "thread_status", { name: "Slack" }],
    ["is slack done", "thread_status", { name: "Slack" }],
    ["is the spotify thread still working", "thread_status", { name: "Spotify" }],
    ["where's spotify", "thread_status", { name: "Spotify" }],
    ["what is spotify working on right now", "thread_status", { name: "Spotify" }],
    ["stop the slack one", "thread_stop", { name: "Slack" }],
    ["stop slack", "thread_stop", { name: "Slack" }],
    ["cancel spotify", "thread_stop", { name: "Spotify" }],
    ["kill the slack thread", "thread_stop", { name: "Slack" }],
    ["pause spotify", "thread_pause", { name: "Spotify" }],
    ["hold the slack one", "thread_pause", { name: "Slack" }],
    ["resume spotify", "thread_resume", { name: "Spotify" }],
    ["carry on slack", "thread_resume", { name: "Slack" }],
    ["continue with the spotify one", "thread_resume", { name: "Spotify" }],
    ["what's running", "thread_list", {}],
    ["what are you doing", "thread_list", {}],
    ["how many things are running", "thread_list", {}],
    ["status", "thread_list", {}],
  ];
  for (const [said, kind, input] of TABLE) {
    for (const wrapped of [said, `Jarhead, ${said} please.`, `um, ${said}`]) {
      const r = parseReflex(wrapped, ctx);
      assert.ok(r, `${JSON.stringify(wrapped)} should be a thread verb`);
      assert.equal(r.kind, kind, wrapped);
      assert.equal(r.tool, kind, wrapped);
      assert.deepEqual(r.input, input, wrapped);
      assert.equal(r.meta, true, wrapped);
      assert.equal(r.prefire, false, wrapped);
      assert.equal(r.idempotent, true, wrapped);
      assert.equal(r.said, "", `${wrapped}: spoken from the result`);
    }
  }
  assert.equal(parseReflex("stop the slack one", ctx)!.label, "stop Slack", "the name as the table spells it");
  // Without the names nothing parses as a thread verb: the names come from the table, never a list.
  for (const [said] of TABLE) {
    const bare = parseReflex(said);
    assert.ok(!bare || !String(bare.kind).startsWith("thread_"), `${said}: no names, no thread verb (got ${bare?.kind})`);
  }
  assert.equal(parseReflex("stop slack"), undefined);
  assert.equal(parseReflex("stop the mail one", ctx), undefined, "Mail is not live");
  assert.equal(parseReflex("what's running", { threadNames: [] }), undefined, "no live thread and no wake word: room talk");
  assert.equal(parseReflex("jarhead what's running", { threadNames: [] })?.kind, "thread_list", "named: answered (nothing running)");
  // Negatives pinned by the design.
  for (const s of ["stop", "stop it", "cancel", "open slack", "slack me later", "what is spotify", "spotify", "tell slack to hurry", "is slack a good app"]) {
    const r = parseReflex(s, ctx);
    assert.ok(!r || !String(r.kind).startsWith("thread_"), `${s}: not a thread verb (got ${JSON.stringify(r)})`);
  }
  assert.equal(parseReflex("stop", ctx), undefined, "'stop' alone is the interrupt's, unchanged");
  assert.equal(parseReflex("open slack", ctx)!.kind, "open_app");
  assert.equal(parseReflex("what is the time", ctx)!.kind, "say");
  // A live name wins over the music row; without the thread the music row takes it.
  assert.equal(parseReflex("pause spotify", ctx)!.kind, "thread_pause");
  assert.equal(parseReflex("pause spotify")!.kind, "media");
  // Case-insensitive, punctuation and a two-word name.
  assert.deepEqual(parseReflex("Stop The SLACK One!", ctx)!.input, { name: "Slack" });
  assert.deepEqual(parseReflex("what is the mail app doing", { threadNames: ["Mail app"] })!.input, { name: "Mail app" });
});

test("every new row passes the policy with verdict run and names nothing irreversible; the ReflexRunner answers say and meta rows without the hands, and reads the names from its option", async () => {
  const ctx = { threadNames: ["Slack", "Spotify"], now: () => 0 };
  const rows = ["um, okay, scroll down", "play", "pause the music", "next track", "mute the music", "minimize this window", "full screen", "what time is it", "what is spotify doing", "stop the slack one", "pause spotify", "resume slack", "what's running"].map((s) => parseReflex(s, ctx)!);
  for (const r of rows) {
    assert.ok(r, "parses");
    if (r.tool === "key") assert.equal(classifyAction({ kind: "key", app: "Finder", text: String(r.input["text"]) }).verdict, "run", r.label);
    if (r.tool === "applescript") assert.equal(classifyAppleScript({ script: String(r.input["script"]) }).verdict, "run", r.label);
    assert.equal(classifyAction({ kind: "left_click", app: "Finder", target: r.label }).verdict, "run", `${r.label}: the label is not an irreversible word`);
    assert.ok(!/\b(send|delete|remove|pay|buy|publish|submit|erase|transfer|sign out|log out|shutdown|restart)\b/i.test(`${r.label} ${r.said} ${JSON.stringify(r.input)}`), `${r.label}: no destructive verb`);
  }

  const hands = new FakeHands();
  const { runner } = makeRunner({}, hands);
  const ran: string[] = [];
  const origRun = runner.run.bind(runner);
  runner.run = async (name, input) => {
    ran.push(name);
    return origRun(name, input);
  };
  let names: readonly string[] = ["Slack", "Spotify"];
  const answered: string[] = [];
  const reflexes = new ReflexRunner({ runner, frontmostApp: async () => "Finder", threadNames: () => names, now: () => new Date(2026, 8, 13, 9, 5).getTime(), meta: (reflex) => (answered.push(reflex.label), { kind: "text", text: `${String(reflex.input["name"] ?? "")}: on step 4, 9 seconds in.` }) });
  const status = reflexes.match("what is spotify doing")!;
  assert.equal(status.kind, "thread_status", "the runner supplies the live names");
  const out = await reflexes.run(status);
  assert.deepEqual([out.ok, out.result], [true, { kind: "text", text: "Spotify: on step 4, 9 seconds in." }]);
  assert.deepEqual(answered, ["status of Spotify"]);
  assert.deepEqual(ran, [], "no tool ran for a meta row");
  const time = await reflexes.run(reflexes.match("what time is it")!);
  assert.deepEqual(time.result, { kind: "text", text: "it's 9:05 am." });
  assert.deepEqual(ran, [], "the clock row runs no tool either");
  names = [];
  assert.equal(reflexes.match("what is spotify doing"), undefined, "Spotify ended: its name is gone from the grammar");
  assert.equal(reflexes.matchTail("let me see. what is slack doing"), undefined);
  names = ["Slack"];
  assert.equal(reflexes.matchTail("let me see. what is slack doing")?.reflex.kind, "thread_status");
  // Without the engine's meta hook the pseudo tool is refused by the runner and the brain takes it.
  const plain = new ReflexRunner({ runner, frontmostApp: async () => "Finder", threadNames: () => ["Slack"] });
  const refused = await plain.run(plain.match("stop the slack one")!);
  assert.equal(refused.ok, false);
  assert.match((refused.result as { message: string }).message, /unknown tool thread_stop/);
});
