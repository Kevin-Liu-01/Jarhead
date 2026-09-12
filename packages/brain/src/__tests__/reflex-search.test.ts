import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset, ConfirmationState, type NativeHands } from "@jarhead/hands";
import { AgentRegistry } from "@jarhead/agents";
import { ToolRunner } from "../runner.ts";
import { APP_SEARCH_SHORTCUTS, ReflexRunner, SEARCH_APPS, SEARCH_SITES, parseReflex, titleMentions, type Reflex } from "../reflex.ts";
import { makeSink } from "./fakes.ts";

/**
 * The search reflex (REDESIGN §12, "search <where> for <what>"): a multi-step batch
 * planned from what is in front — focus the app if it is not up, the search field by
 * accessibility or the app's / site's shortcut, select all, type, Return — every step
 * through the gated toolset, stopping at the first refusal, question or error and
 * reporting how far it got; a site the front tab is not on goes to the brain. Before
 * a key goes out the focus is read back: the words go only into a text field of the
 * app the reflex meant.
 */

/** Hands whose front window, text inputs and focused field the test sets. */
class SearchHands implements NativeHands {
  ready = true;
  ops: { op: string; params: Record<string, unknown> }[] = [];
  frontApp = "Google Chrome";
  title = "Design system — Kevin's Wiki";
  /** Text inputs on the front window's tree by label; `find_element {role: field|pagefield}` answers from these. */
  fields: { label: string; addressBar?: boolean }[] = [{ label: "Search the wiki" }];
  secure = false;
  /** What is focused now: the page body until a click or a shortcut moves it. */
  focusedRole = "AXWebArea";
  focusedTitle = "";
  /** Where a click on a field lands the focus, and where a shortcut does (a shortcut that does nothing in this mode: leave "AXWebArea"). */
  focusAfterClick = "AXTextField";
  focusAfterShortcut = "AXTextField";
  /** focus_app fails for apps not in this list. */
  running = ["Google Chrome", "Finder", "Notion", "Slack", "Terminal", "Visual Studio Code"];
  /** focus_app is accepted but the front app does not change (activation has not landed). */
  stickyFront = false;
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.ops.push({ op, params });
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "frontmost":
        return { app: this.frontApp, pid: 1, window: { title: this.title, x: 0, y: 0, w: 1200, h: 800, windowId: 1 } } as T;
      case "focus_app": {
        const name = String(params["name"]);
        if (!this.running.includes(name)) throw Object.assign(new Error(`no running application named ${name}`), { detail: { code: "not_found" } });
        if (!this.stickyFront) this.frontApp = name;
        return { app: name, pid: 2, activated: true } as T;
      }
      case "find_element": {
        const name = String(params["name"] ?? "").toLowerCase();
        const role = String(params["role"] ?? "");
        const hits = this.fields.filter((f) => f.label.toLowerCase().split(/\s+/).includes(name) && !(role === "pagefield" && f.addressBar));
        const el = (f: { label: string }) => ({ i: 4, depth: 3, role: "AXTextField", title: f.label, app: this.frontApp, score: 1, label: f.label, x: 300, y: 80, w: 240, h: 28, center: { x: 420, y: 94 }, pressable: false });
        return { app: String(params["app"] ?? this.frontApp), window: this.title, found: hits.length > 0, unique: hits.length === 1, candidates: hits.length, tier: hits.length ? "contains" : "none", ...(hits[0] ? { element: el(hits[0]) } : {}), ...(hits.length > 1 ? { others: hits.slice(1).map(el) } : {}), cached: true, treeMs: 4, nodes: 120, truncated: false, ms: 2 } as T;
      }
      case "element_at":
        return { role: "AXTextField", title: this.fields[0]?.label ?? "", frame: { x: 300, y: 80, w: 240, h: 28 }, app: this.frontApp } as T;
      case "focused_text":
        return { role: this.focusedRole, title: this.focusedTitle, secure: this.secure, app: this.frontApp, frame: { x: 300, y: 80, w: 240, h: 28 } } as T;
      case "click":
        this.focusedRole = this.focusAfterClick;
        return {} as T;
      case "key": {
        const combo = String(params["combo"] ?? "");
        if (combo !== "cmd+a" && combo.toLowerCase() !== "return") this.focusedRole = this.focusAfterShortcut;
        return {} as T;
      }
      case "cursor":
        return { x: 400, y: 300 } as T;
      default:
        return {} as T;
    }
  }
  named(op: string): Record<string, unknown>[] {
    return this.ops.filter((o) => o.op === op).map((o) => o.params);
  }
  /** The acting ops in order, compact. */
  acted(): string[] {
    return this.ops
      .filter((o) => ["focus_app", "click", "key", "type"].includes(o.op))
      .map((o) => (o.op === "key" ? `key ${String(o.params["combo"])}` : o.op === "type" ? `type ${String(o.params["text"])}` : o.op === "focus_app" ? `focus ${String(o.params["name"])}` : "click"));
  }
}

function makeReflexes(hands: SearchHands, now: () => number = Date.now): { reflexes: ReflexRunner; runner: ToolRunner; confirmations: ConfirmationState } {
  const confirmations = new ConfirmationState();
  const toolset = new ComputerToolset({ hands, confirmations });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([], 0), stateDir: "/tmp/jh-reflex-search-never-written" });
  return { reflexes: new ReflexRunner({ runner, frontmostApp: async () => hands.frontApp, now }), runner, confirmations };
}

const search = (u: string): Reflex => {
  const r = parseReflex(u);
  assert.ok(r, `"${u}" is a reflex`);
  assert.equal(r.kind, "search", u);
  return r;
};
const notSearch = (u: string): void => assert.notEqual(parseReflex(u)?.kind, "search", `"${u}" is not a search reflex`);

test("grammar: search <where> for <what>, search for <what> in|on <where>, look up / find <what> in <where>; the wake word and politeness wrapped; this page / here; <what> keeps Kevin's case and may itself say 'in'", () => {
  assert.deepEqual(search("search the wiki for design").input, { where: "wiki", what: "design", here: false });
  assert.deepEqual(search("Hey Jarhead, search the wiki for design please.").input, { where: "wiki", what: "design", here: false });
  assert.deepEqual(search("search google for how to make a for loop").input, { where: "google", what: "how to make a for loop", here: false });
  assert.deepEqual(search("search for design in the wiki").input, { where: "wiki", what: "design", here: false });
  assert.deepEqual(search('search for "the best coffee in seattle" on google').input, { where: "google", what: "the best coffee in seattle", here: false });
  assert.deepEqual(search("search for coffee in seattle on google").input, { where: "google", what: "coffee in seattle", here: false });
  assert.deepEqual(search("look up design tokens in notion").input, { where: "notion", what: "design tokens", here: false });
  assert.deepEqual(search("lookup Jarhead on GitHub").input, { where: "github", what: "Jarhead", here: false });
  assert.deepEqual(search("find readme in finder").input, { where: "finder", what: "readme", here: false });
  assert.deepEqual(search("search this page for design").input, { where: "this page", what: "design", here: true });
  assert.deepEqual(search("find design on this page").input, { where: "this page", what: "design", here: true });
  assert.deepEqual(search("search here for design").input, { where: "here", what: "design", here: true });
  assert.deepEqual(search('search youtube for "lofi beats"').input, { where: "youtube", what: "lofi beats", here: false });
  assert.deepEqual(search("search google for rock and roll").input, { where: "google", what: "rock and roll", here: false }, "'and' between words is words");
  assert.deepEqual(search("search google for salt and pepper").input, { where: "google", what: "salt and pepper", here: false });
  const r = search("search the wiki for design");
  assert.deepEqual([r.tool, r.prefire, r.idempotent, r.said, r.label], ["search", false, false, 'searched the wiki for "design".', "search wiki for design"]);
  assert.equal(search("search this page for design").said, 'searched this page for "design".');
  // Not searches: no place, a stand-in for the words, a stand-in for the place, over-long, other commands.
  for (const s of ["search for design", "search", "search the wiki", "search the wiki for it", "search for that in google", "find my keys", "search for design in it", "look up", "click search", "type search the wiki for design", `search google for ${"a".repeat(81)}`]) notSearch(s);
  assert.equal(parseReflex("type search the wiki for design")!.kind, "type", "a typed sentence stays a type");
  assert.ok(titleMentions("kevin/jarhead: voice-first Mac assistant · GitHub", SEARCH_SITES["github"]!));
  assert.ok(titleMentions("Home / X", SEARCH_SITES["x"]!) && titleMentions("lofi - YouTube", SEARCH_SITES["youtube"]!) && titleMentions("Design — Kevin's Wiki", SEARCH_SITES["wiki"]!));
  assert.ok(!titleMentions("Xcode — main.swift", SEARCH_SITES["x"]!) && !titleMentions("Inbox", SEARCH_SITES["wiki"]!));
  assert.equal(SEARCH_APPS["vs code"], "Visual Studio Code");
  assert.equal(APP_SEARCH_SHORTCUTS["finder"]?.combo, "cmd+f");
});

test("grammar: a query that carries a second instruction is the brain's whole; 'find <the thing> in <where>' that describes rather than names words, or names a place the reflex does not know, is not a search", () => {
  // A sentence the ear would otherwise type whole, dropping the second half silently.
  for (const s of [
    "search the wiki for design and then open the first result",
    "search the wiki for design, then read me the first result",
    "search the wiki for design then open the first result",
    "search google for cats and tell me the top result",
    "search github for reflexes and click the first one",
    "look up design tokens in notion and then read them to me",
    "search google for design; after that open the second link",
  ]) notSearch(s);
  // Everyday "find X in Y" that is not a search command.
  for (const s of [
    "find the bug in the code",
    "find the error in the terminal",
    "find out what time it is in tokyo",
    "look up how many people live in china",
    "search for a new job in seattle",
    "find the readme in finder",
    "search for the best coffee in seattle on google",
    "find my file in finder",
    "find that message in slack",
  ]) notSearch(s);
  // Quoted words are words, wherever they are said.
  assert.deepEqual(search('find "the bug" in the code').input, { where: "code", what: "the bug", here: false });
  assert.deepEqual(search('search google for "design and then some"').input, { where: "google", what: "design and then some", here: false });
  // Form A keeps its literal query: "search X for Y" is unambiguous syntax.
  assert.deepEqual(search("search the wiki for the design page").input, { where: "wiki", what: "the design page", here: false });
});

test("search: the front browser tab is on the site → the page's search field (never the address bar) is clicked, the focus is read back, select all, the words typed, Return; the outcome says what it did and speaks it", async () => {
  const hands = new SearchHands();
  hands.fields = [{ label: "Address and search bar", addressBar: true }, { label: "Search the wiki" }];
  const { reflexes } = makeReflexes(hands);
  const out = await reflexes.run(search("search the wiki for design"));
  assert.equal(out.ok, true, out.did);
  assert.deepEqual(hands.acted(), ["click", "key cmd+a", "type design", "key Return"]);
  assert.equal(hands.named("find_element")[0]?.["role"], "pagefield", "a site search asks for a page field, not the omnibox");
  assert.equal(out.did, 'typed "design" into the search field of Google Chrome and pressed Return');
  assert.equal(out.reflex.said, 'typed "design" into the search field of Google Chrome and pressed Return.', "the spoken line is the landing, not the grammar's guess");
  assert.deepEqual(out.progress, { done: 4, total: 4 });
  assert.ok(typeof out.dispatchedAt === "number", "dispatched at the click");
  assert.ok(hands.ops.findIndex((o) => o.op === "focused_text") < hands.ops.findIndex((o) => o.op === "key"), "the focus was read before the first key");
});

test("search: a site on the front tab with no page field and no site shortcut (the wiki, Notion's site, Gmail) is the brain's — the address bar is never the fallback for a site", async () => {
  const hands = new SearchHands();
  hands.fields = [{ label: "Address and search bar", addressBar: true }];
  const { reflexes } = makeReflexes(hands);
  const wiki = await reflexes.run(search("search the wiki for design"));
  assert.equal(wiki.ok, false, wiki.did);
  assert.deepEqual(hands.acted(), [], "not a keystroke");
  assert.equal(wiki.result.kind, "error");
  assert.match(wiki.did ?? "", /^did 0 steps; stopped at click_element: no search field on the front window of Google Chrome \(no control named "search".*\) and no search shortcut known for wiki/);

  for (const [title, words] of [
    ["Roadmap — Notion", "search notion for design"],
    ["Inbox (3) - kevin@example.com - Gmail", "search gmail for receipts"],
    ["ChatGPT", "look up the answer in chatgpt"],
  ] as const) {
    const h = new SearchHands();
    h.title = title;
    h.fields = [{ label: "Address and search bar", addressBar: true }];
    const r = parseReflex(words);
    if (!r) continue; // "look up the answer …" describes; not a reflex at all
    const out = await makeReflexes(h).reflexes.run(r);
    assert.equal(out.ok, false, `${words}: ${out.did}`);
    assert.deepEqual(h.acted(), [], words);
  }
  assert.equal(parseReflex("look up the answer in chatgpt"), undefined, "'the answer' describes");

  // <where> names the browser itself: its address bar IS its search — by the tree when it is exposed, by ⌘L when not.
  const chrome = new SearchHands();
  chrome.title = "Design system — Kevin's Wiki";
  chrome.fields = [{ label: "Address and search bar", addressBar: true }];
  const omnibox = await makeReflexes(chrome).reflexes.run(search("search chrome for design tokens"));
  assert.equal(omnibox.ok, true, omnibox.did);
  assert.deepEqual(chrome.acted(), ["click", "key cmd+a", "type design tokens", "key Return"]);
  assert.equal(chrome.named("find_element")[0]?.["role"], "field", "the browser's own search may be its address bar");
  const bare = new SearchHands();
  bare.title = "Design system — Kevin's Wiki";
  bare.fields = [];
  const bar = await makeReflexes(bare).reflexes.run(search("search chrome for design tokens"));
  assert.equal(bar.ok, true, bar.did);
  assert.deepEqual(bare.acted(), ["key cmd+l", "key cmd+a", "type design tokens", "key Return"]);
  assert.match(bar.did ?? "", /into the address bar of Google Chrome and pressed Return/);
});

test("search: no search field by accessibility → the site's shortcut ('/' on GitHub) or the app's (⌘F in Finder); a palette shortcut (Notion ⌘K) types without Return; 'this page' is find in page", async () => {
  const hands = new SearchHands();
  hands.title = "kevin/jarhead · GitHub";
  hands.fields = [{ label: "Address and search bar", addressBar: true }];
  const { reflexes } = makeReflexes(hands);
  // (Not "… for jarhead": a trailing wake word is politeness to the normaliser and is stripped.)
  const gh = await reflexes.run(search("search github for reflexes"));
  assert.equal(gh.ok, true, gh.did);
  assert.deepEqual(hands.acted(), ["key /", "key cmd+a", "type reflexes", "key Return"]);
  assert.match(gh.did ?? "", /GitHub's search.*pressed Return/);
  assert.match(gh.did ?? "", /no search field on the front window/, "the finding rides along so the brain does not repeat the walk");

  hands.ops.length = 0;
  hands.frontApp = "Finder";
  hands.title = "Desktop";
  hands.fields = [];
  hands.focusedRole = "AXWebArea";
  const fd = await reflexes.run(search("search finder for readme"));
  assert.equal(fd.ok, true, fd.did);
  assert.deepEqual(hands.acted(), ["key cmd+f", "key cmd+a", "type readme", "key Return"]);

  hands.ops.length = 0;
  hands.frontApp = "Notion";
  hands.focusedRole = "AXWebArea";
  const nt = await reflexes.run(search("look up design tokens in notion"));
  assert.equal(nt.ok, true, nt.did);
  assert.deepEqual(hands.acted(), ["key cmd+k", "key cmd+a", "type design tokens"], "a palette opens the first hit on Return: no Return");

  hands.ops.length = 0;
  hands.frontApp = "Google Chrome";
  hands.title = "Some page";
  hands.focusedRole = "AXWebArea";
  const here = await reflexes.run(search("search this page for design"));
  assert.equal(here.ok, true);
  assert.deepEqual(hands.acted(), ["key cmd+f", "key cmd+a", "type design", "key Return"], "this page: find in page, no tree walk");
  assert.equal(hands.named("find_element").length, 0);
});

test("search: '/' is a character while a text input is focused (a comment draft) — the batch stops before it; a shortcut that moved the focus into nothing that takes text stops before ⌘A", async () => {
  const draft = new SearchHands();
  draft.title = "Fix reflexes · Pull Request #12 · kevin/jarhead · GitHub";
  draft.fields = [{ label: "Address and search bar", addressBar: true }];
  draft.focusedRole = "AXTextArea";
  draft.focusedTitle = "Add a comment";
  const { reflexes } = makeReflexes(draft);
  const out = await reflexes.run(search("search github for reflexes"));
  assert.equal(out.ok, false, out.did);
  assert.deepEqual(draft.acted(), [], "not a keystroke into the draft");
  assert.match(out.did ?? "", /stopped at key: a text input \(AXTextArea "Add a comment"\) is focused in Google Chrome; "\/" would be typed into it/);

  // Finder ⌘F did not land in a field (a mode where the shortcut does nothing): nothing typed.
  const fd = new SearchHands();
  fd.frontApp = "Finder";
  fd.title = "Desktop";
  fd.fields = [];
  fd.focusAfterShortcut = "AXWebArea";
  const r2 = makeReflexes(fd).reflexes;
  const miss = await r2.run(search("search finder for readme"));
  assert.equal(miss.ok, false, miss.did);
  assert.deepEqual(fd.acted(), ["key cmd+f"], "the shortcut went out; no ⌘A, no words");
  assert.match(miss.did ?? "", /stopped at read_focused_text: the focus after the Finder search field is AXWebArea, not a text field/);
  assert.equal(fd.named("focused_text").length >= 2, true, "looked once more after a beat before giving up");

  // The focus is in a field of another app: the words would land there.
  const other = new SearchHands();
  other.frontApp = "Finder";
  other.title = "Desktop";
  other.fields = [];
  const origin = other.request.bind(other);
  other.request = async <T>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (op === "focused_text") return { role: "AXTextField", secure: false, app: "Slack", frame: null } as T;
    return origin<T>(op, params);
  };
  const stray = await makeReflexes(other).reflexes.run(search("search finder for readme"));
  assert.equal(stray.ok, false);
  assert.deepEqual(other.acted(), ["key cmd+f"]);
  assert.match(stray.did ?? "", /stopped at read_focused_text: the focus is in Slack, not Finder/);
});

test("search: an app that is not in front is focused first and must be seen in front before a key goes out; one that never comes up stops the batch; one that is not running stops at step 1", async () => {
  const hands = new SearchHands();
  hands.frontApp = "Google Chrome";
  hands.fields = [{ label: "Search" }];
  const { reflexes } = makeReflexes(hands);
  const out = await reflexes.run(search("search notion for design"));
  assert.equal(out.ok, true, out.did);
  assert.deepEqual(hands.acted(), ["focus Notion", "click", "key cmd+a", "type design", "key Return"]);
  assert.ok(hands.ops.some((o) => o.op === "focus_app") && hands.named("find_element")[0]?.["app"] === "Notion", "the tree asked for is Notion's");
  assert.match(out.did ?? "", /^typed "design" into the search field of Notion/);

  // Activation asked for but not landed: Chrome stays in front. Nothing may be typed into it.
  const lag = new SearchHands();
  lag.stickyFront = true;
  lag.fields = [{ label: "Search" }];
  for (const words of ["search notion for design", "search slack for standup", "search terminal for error"]) {
    lag.ops.length = 0;
    const o = await makeReflexes(lag).reflexes.run(search(words));
    assert.equal(o.ok, false, `${words}: ${o.did}`);
    assert.deepEqual(
      lag.acted().filter((a) => !a.startsWith("focus")),
      [],
      `${words}: not a keystroke while Chrome is in front`,
    );
    assert.match(o.did ?? "", /stopped at focus_app: \w[\w ]* did not come to the front \(Google Chrome is\)/);
    assert.equal(lag.named("frontmost").length >= 3, true, "looked twice after the focus, a beat apart");
  }

  hands.ops.length = 0;
  hands.frontApp = "Google Chrome";
  const gone = await reflexes.run(search("search cursor for readme"));
  assert.equal(gone.ok, false);
  assert.deepEqual(hands.acted(), ["focus Cursor"], "nothing after the failed focus");
  assert.match(gone.did ?? "", /^did 0 steps; stopped at focus_app: .*no running application named Cursor/);
  assert.equal(gone.result.kind, "error");
});

test("search: a click_element problem that is not 'no such field' (the app is not in front, the field is covered) stops the batch instead of falling to a shortcut", async () => {
  const hands = new SearchHands();
  hands.frontApp = "Finder";
  hands.title = "Desktop";
  hands.fields = [{ label: "Search" }];
  // The tree says Finder, but by the time of the click Chrome is in front (the toolset's own front check).
  const origin = hands.request.bind(hands);
  let finds = 0;
  hands.request = async <T>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (op === "find_element") finds++;
    if (op === "frontmost" && finds > 0) return { app: "Google Chrome", pid: 9, window: { title: "Some page", x: 0, y: 0, w: 1200, h: 800, windowId: 2 } } as T;
    return origin<T>(op, params);
  };
  const out = await makeReflexes(hands).reflexes.run(search("search finder for readme"));
  assert.equal(out.ok, false, out.did);
  assert.deepEqual(hands.acted(), [], "no ⌘F into Chrome");
  assert.match(out.did ?? "", /stopped at click_element: "Search" is in Finder, but Google Chrome is in front/);
});

test("search: a site the front tab is not on, or named with no browser in front, is left to the brain without a keystroke; an unknown place too", async () => {
  const hands = new SearchHands();
  hands.title = "Inbox — Gmail";
  const { reflexes } = makeReflexes(hands);
  const off = await reflexes.run(search("search the wiki for design"));
  assert.equal(off.ok, false);
  assert.match((off.result as { message: string }).message, /^not a reflex: Google Chrome's front tab \("Inbox — Gmail"\) is not on wiki; the brain navigates/);
  assert.deepEqual(hands.acted(), []);

  hands.frontApp = "Finder";
  const noBrowser = await reflexes.run(search("search youtube for lofi"));
  assert.equal(noBrowser.ok, false);
  assert.match((noBrowser.result as { message: string }).message, /is a site and Finder is in front, not a browser/);

  const unknown = await reflexes.run(search("search the internet for cats"));
  assert.equal(unknown.ok, false, "\"internet\" is guessed as an app, which is not running: the brain takes it");
  assert.deepEqual(hands.acted(), ["focus Internet"]);
});

test("search: a password field stops the batch at the focus read — not one key goes into it; a hands-off app asks and the question is the answer", async () => {
  const hands = new SearchHands();
  hands.fields = [{ label: "Search the wiki" }];
  hands.secure = true;
  const { reflexes } = makeReflexes(hands);
  const out = await reflexes.run(search("search the wiki for design"));
  assert.equal(out.ok, false);
  assert.deepEqual(hands.acted(), ["click"], "the click went out; the focus read said password field; no ⌘A, nothing typed, no Return");
  assert.match(out.did ?? "", /^did 1 step \(clicked the search field of Google Chrome\); stopped at read_focused_text: the focused field is a password field/);
  assert.equal(out.result.kind, "error");
  assert.deepEqual(out.progress, { done: 1, total: 1 });

  const vault = new SearchHands();
  vault.frontApp = "1Password";
  vault.running.push("1Password");
  vault.fields = [{ label: "Search" }];
  const r2 = makeReflexes(vault).reflexes;
  const asked = await r2.run(search("search 1password for github"));
  assert.equal(asked.result.kind, "needs-confirmation", "the click into a hands-off app asks; the delegator relays it, the ear drops it");
  assert.equal(asked.ok, true);
  assert.match(asked.did ?? "", /stopped at click_element: needs a yes/);
  assert.deepEqual(vault.acted(), [], "nothing acted");
});

test("search: a second run of the same words while the first is in flight joins it — across the ear's lowercase and Live's capitals — and both outcomes say so; a failure a moment ago is answered at once with its findings, not retried", async () => {
  const hands = new SearchHands();
  hands.fields = [{ label: "Search the wiki" }];
  const waiters: (() => void)[] = [];
  const original = hands.request.bind(hands);
  hands.request = async <T>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (op === "type") await new Promise<void>((r) => waiters.push(r));
    return original<T>(op, params);
  };
  const clock = { t: 1_000_000 };
  const { reflexes } = makeReflexes(hands, () => clock.t);
  const first = reflexes.run(search("search the wiki for design"));
  await new Promise((r) => setTimeout(r, 30));
  const second = reflexes.run(search("Jarhead, search the wiki for Design."));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(waiters.length, 1, "one batch is waiting inside type — the second joined it");
  for (const w of waiters.splice(0)) w();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.deepEqual(b, a, "the second caller got the first run's outcome");
  assert.equal(a.shared, true, "both know a second caller shares it");
  assert.equal(hands.acted().filter((x) => x.startsWith("type")).length, 1, "typed once");
  assert.equal(hands.acted().filter((x) => x === "key Return").length, 1, "one Return");

  // Alone: not shared.
  hands.ops.length = 0;
  hands.focusedRole = "AXWebArea";
  const alone = reflexes.run(search("search the wiki for tokens"));
  await new Promise((r) => setTimeout(r, 30));
  for (const w of waiters.splice(0)) w();
  assert.equal((await alone).shared, undefined);

  // A failure: the same words within 4 s come back at once, with what was found, without a second walk.
  hands.ops.length = 0;
  hands.title = "Inbox — Gmail";
  const miss = await reflexes.run(search("search the wiki for design"));
  assert.equal(miss.ok, false);
  const walks = hands.named("frontmost").length;
  clock.t += 500;
  const again = await reflexes.run(search("Search the wiki for Design"));
  assert.equal(again.ok, false);
  assert.equal(hands.named("frontmost").length, walks, "no second look, whatever the case");
  assert.match((again.result as { message: string }).message, /not on wiki.*\(tried 500 ms ago on the ear's words; not retried\)/);
  clock.t += 4000;
  await reflexes.run(search("search the wiki for design"));
  assert.equal(hands.named("frontmost").length, walks + 1, "after the hold it is tried again");
});

test("search: a joined run that ends in a question leaves the pending confirmation for the caller that relays it", async () => {
  const vault = new SearchHands();
  vault.frontApp = "1Password";
  vault.running.push("1Password");
  vault.fields = [{ label: "Search" }];
  const waiters: (() => void)[] = [];
  const original = vault.request.bind(vault);
  vault.request = async <T>(op: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (op === "find_element") await new Promise<void>((r) => waiters.push(r));
    return original<T>(op, params);
  };
  const { reflexes, confirmations } = makeReflexes(vault);
  const ear = reflexes.run(search("search 1password for github"));
  await new Promise((r) => setTimeout(r, 20));
  const live = reflexes.run(search("Jarhead, search 1Password for GitHub."));
  await new Promise((r) => setTimeout(r, 20));
  for (const w of waiters.splice(0)) w();
  const [a, b] = await Promise.all([ear, live]);
  assert.equal(a.result.kind, "needs-confirmation");
  assert.equal(a.shared, true, "the ear knows the delegation joined: it must not clear this pending");
  assert.equal(b.shared, true);
  assert.ok(confirmations.pending, "the question is still pending for Kevin's yes");
  assert.equal(confirmations.pending?.id, (a.result as { pendingId: string }).pendingId);
});

test("a static steps[] batch runs in order through the runner and stops at the first error, reporting how far it got", async () => {
  const hands = new SearchHands();
  const { reflexes, runner } = makeReflexes(hands);
  const sinkLog = makeSink();
  runner.attach(sinkLog.sink);
  const batch: Reflex = {
    kind: "key",
    tool: "key",
    input: { text: "cmd+a" },
    said: "done.",
    label: "select all then copy",
    prefire: false,
    idempotent: false,
    steps: [
      { tool: "key", input: { text: "cmd+a" }, did: "selected all" },
      { tool: "key", input: { text: "cmd+c" }, did: "copied" },
    ],
  };
  const ok = await reflexes.run(batch);
  assert.equal(ok.ok, true);
  assert.equal(ok.did, "selected all, copied");
  assert.deepEqual(hands.acted(), ["key cmd+a", "key cmd+c"]);
  assert.equal(sinkLog.steps.filter((s) => s.startsWith("tool:key")).length, 2, "each step is on the timeline");
  const bad: Reflex = { ...batch, label: "select all then nothing", steps: [{ tool: "key", input: { text: "cmd+a" }, did: "selected all" }, { tool: "key", input: {}, did: "pressed nothing" }, { tool: "key", input: { text: "cmd+c" }, did: "copied" }] };
  const stopped = await reflexes.run(bad);
  assert.equal(stopped.ok, false);
  assert.match(stopped.did ?? "", /^did 1 step \(selected all\); stopped at key: key needs text/);
  assert.equal(hands.acted().length, 3, "the third step never ran");
  runner.attach(undefined);
});
