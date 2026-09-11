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
