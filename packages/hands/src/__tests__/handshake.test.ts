import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionContext, Decision } from "@jarhead/core";
import { ComputerToolset, ConfirmationState, YES_PATTERN, isAffirmative } from "../toolset.ts";
import { ConfirmationDesk } from "../lanes.ts";
import { FakeHands } from "../fake.ts";

/** FakeHands plus `find_element`: one control on the front window, with a frame (global points). */
class TreeHands extends FakeHands {
  control = { label: "Delete", role: "AXButton", x: 500, y: 400, w: 60, h: 24 };
  override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (op !== "find_element") return super.request<T>(op, params);
    this.calls.push({ op, params, at: this.now() });
    const c = this.control;
    const element = { i: 1, depth: 1, role: c.role, title: c.label, app: this.frontApp, score: 1, label: c.label, x: c.x, y: c.y, w: c.w, h: c.h, center: { x: c.x + c.w / 2, y: c.y + c.h / 2 } };
    return { app: this.frontApp, window: "Inbox", found: true, unique: true, candidates: 1, tier: "exact", element, cached: true, treeMs: 1, nodes: 3, truncated: false, ms: 1 } as T;
  }
}

/**
 * W1-4, the handshake (launch triage 2026-10-05). The audit's reproductions, adopted:
 * rails R3 / R5 / R6 / R7 and reflex RF-3 / RF-4 / RF-8, plus the desk and expired-yes
 * halves of TH-1. Each failed on 6b3f35f.
 *
 * - A yes is a whole yes: "Yeah, no, don't send it" is not one (RAIL-2).
 * - Every key tool is gated: hold_key and scroll meet the policy like key and click (RAIL-6 / RF-3).
 * - open_app and focus_app obey their verdict (RAIL-10 / RF-4).
 * - A yes covers that action once: the same member, the same target words, the same arguments (RAIL-7).
 * - A late yes re-asks instead of landing nothing, and the desk never drops a thread's question (TH-1).
 *
 * The review of the first cut (2026-10-05) added: a scroll is not judged by the words under
 * it; a yes binds to the control's frame and to click_element's button and count; a read of
 * the floor never promotes (so a yes never arms a question spoken in the same breath); a yes
 * armed in time lands a slow re-run for LANDS_WITHIN_MS.
 */

// ------------------------------------------------------------------ RAIL-2: the yes

/** Whole-utterance affirmatives: each arms a pending question. */
const YES: readonly string[] = [
  "yes",
  "Yes.",
  "YES!",
  "yeah",
  "Yep, go ahead.",
  "Sure, do it.",
  "Okay, send it.",
  "yes please",
  "Go ahead and send it.",
  "Jarhead, yes.",
  "uh, yes, go for it",
  "That's fine.",
];

/** Everything else: each leaves the question unanswered (asked again, never landed). */
const NOT_YES: readonly string[] = [
  "Yeah, no, don't send it.",
  "Okay wait, stop",
  "Sure, but not to Ben",
  "Do it later",
  "Send it to Sarah instead",
  "Yes? What's the question?",
  "no",
  "Yes, but actually cancel it",
  "ok not yet",
  "yesterday's email",
  "okay so what's next",
  "please",
];

test("RAIL-2: a yes is the whole utterance; 12 affirmatives and 12 negatives, pinned, and YES_PATTERN agrees with isAffirmative", () => {
  assert.equal(YES.length + NOT_YES.length, 24);
  const missed = YES.filter((s) => !isAffirmative(s));
  assert.deepEqual(missed, [], `these are a yes: ${JSON.stringify(missed)}`);
  const leaked = NOT_YES.filter((s) => isAffirmative(s));
  assert.deepEqual(leaked, [], `these are not a yes: ${JSON.stringify(leaked)}`);
  for (const s of [...YES, ...NOT_YES]) assert.equal(YES_PATTERN.test(s), isAffirmative(s), s);
  assert.equal(YES_PATTERN.flags.includes("g"), false, "no lastIndex state between calls");
  assert.equal(isAffirmative(`yes${" ".repeat(10_000)}x`), false, "a long line answers quickly and is not a yes");
});

// ------------------------------------------------------------------ RAIL-6 / RF-3: hold_key and scroll

test("RAIL-6 / RF-3 (rails R3): hold_key into a password field is refused like key, and posts nothing", async () => {
  const hands = new FakeHands();
  hands.frontApp = "1Password";
  hands.secure = true;
  const ts = new ComputerToolset({ hands });
  const key = await ts.run("key", { text: "cmd+delete" });
  assert.equal(key.kind, "error", "key into a password field is refused (control)");
  const held = await ts.run("hold_key", { text: "cmd+delete", duration: 0.2 });
  assert.equal(held.kind, "error");
  assert.match((held as { message: string }).message, /^refused: .*password field/);
  assert.equal(hands.posted.filter((p) => p.op === "hold_key").length, 0, "nothing posted");
});

test("RF-3: hold_key in a hands-off app (1Password) asks like key; never grantable; the yes holds it once, judged against the front app, and at most 10 s", async () => {
  const hands = new FakeHands();
  hands.frontApp = "1Password";
  hands.apps.set("1Password", 900);
  hands.frontPid = 900;
  const confirmations = new ConfirmationState();
  const ts = new ComputerToolset({ hands, confirmations });
  const asked = await ts.run("hold_key", { text: "cmd+backspace", duration: 60 });
  assert.equal(asked.kind, "needs-confirmation", JSON.stringify(asked));
  assert.equal(confirmations.pending?.grantable, undefined, "a key press is never grantable");
  assert.equal(hands.posted.length, 0);
  assert.ok(confirmations.arm());
  assert.equal((await ts.run("hold_key", { text: "cmd+backspace", duration: 60 })).kind, "text");
  const held = hands.posted.filter((p) => p.op === "hold_key");
  assert.equal(held.length, 1);
  assert.equal(held[0]!.params["durationMs"], 10_000, "clamped to the helper's 10 s");
  assert.deepEqual(held[0]!.params["expectFront"], { pid: 900 }, "the app the gate judged must still be in front");
  assert.equal((await ts.run("hold_key", { text: "cmd+backspace", duration: 60 })).kind, "needs-confirmation", "the yes was spent");
});

test("RF-3 (scroll): a scroll in System Settings asks before it moves anything; elsewhere it runs, judged against the front app", async () => {
  const hands = new FakeHands();
  hands.frontApp = "System Settings";
  hands.apps.set("System Settings", 950);
  hands.frontPid = 950;
  const ts = new ComputerToolset({ hands });
  const r = await ts.run("scroll", { scroll_direction: "down", scroll_amount: 3 });
  assert.equal(r.kind, "needs-confirmation", JSON.stringify(r));
  assert.equal(hands.posted.length, 0, "nothing scrolled");
  hands.frontApp = "Notes";
  hands.frontPid = 100;
  assert.equal((await ts.run("scroll", { scroll_direction: "down", scroll_amount: 3 })).kind, "text");
  assert.deepEqual(hands.posted.at(-1)?.params["expectFront"], { pid: 100 });
});

test("RF-3 (scroll, review): a scroll aimed at a point is judged by its app, not by the words under it; text that says Reply, Sign up or Delete scrolls; System Settings still asks, and its yes lands that scroll once", async () => {
  const hands = new FakeHands();
  hands.apps.set("Safari", 500);
  hands.frontApp = "Safari";
  hands.frontPid = 500;
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  const ran: Record<string, string> = {};
  hands.elementRole = "AXStaticText";
  for (const words of ["Sign up for our newsletter", "Merge pull request", "Reply", "Share", "Delete"]) {
    hands.elementTitle = words;
    ran[words] = (await ts.run("scroll", { coordinate: [500, 300], scroll_direction: "down", scroll_amount: 3 })).kind;
  }
  assert.deepEqual(ran, { "Sign up for our newsletter": "text", "Merge pull request": "text", Reply: "text", Share: "text", Delete: "text" });
  assert.equal(ts.confirmations.pending, undefined, "nothing was asked");
  // Mail, over its Reply button: a scroll, not a click.
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  hands.elementTitle = "Reply";
  hands.elementRole = "AXButton";
  await ts.run("screenshot", {});
  assert.equal((await ts.run("scroll", { coordinate: [500, 300], scroll_direction: "down" })).kind, "text");
  assert.equal((await ts.run("left_click", { coordinate: [500, 300] })).kind, "needs-confirmation", "the click on Reply still asks (control)");
  ts.confirmations.dropQuestion();
  // System Settings: hands-off, so a scroll asks wherever it points, and the yes lands that scroll once.
  hands.apps.set("System Settings", 950);
  hands.frontApp = "System Settings";
  hands.frontPid = 950;
  hands.elementTitle = "Wi-Fi";
  await ts.run("screenshot", {});
  const before = hands.posted.length;
  assert.equal((await ts.run("scroll", { coordinate: [500, 300], scroll_direction: "down" })).kind, "needs-confirmation");
  assert.equal(hands.posted.length, before, "nothing scrolled");
  ts.confirmations.arm();
  assert.equal((await ts.run("scroll", { coordinate: [500, 300], scroll_direction: "down" })).kind, "text");
  assert.equal(hands.posted.length, before + 1);
  assert.equal((await ts.run("scroll", { coordinate: [500, 300], scroll_direction: "down" })).kind, "needs-confirmation", "the yes was spent");
});

test("RF-3 (scroll, review): with Kevin away, a scroll in Slack over a Send button is not held (it was never a question); a click on it is", async () => {
  const hands = new FakeHands();
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  hands.elementTitle = "Send";
  const ts = new ComputerToolset({ hands, presenceAt: () => 0, now: () => 10 * 60_000 });
  await ts.run("screenshot", {});
  assert.equal((await ts.run("scroll", { coordinate: [500, 300], scroll_direction: "up" })).kind, "text");
  const click = await ts.run("left_click", { coordinate: [500, 300] });
  assert.equal(click.kind, "needs-confirmation");
  assert.equal((click as { pendingId: string }).pendingId, "hold", "held for Kevin, not asked");
});

// ------------------------------------------------------------------ RAIL-10 / RF-4: open_app and focus_app

test("RAIL-10 / RF-4 (rails R7): open_app and focus_app obey a refuse; nothing is opened or fronted", async () => {
  const hands = new FakeHands();
  const decisions: Decision[] = [];
  const refuse = (ctx: ActionContext): Decision => (ctx.kind === "open_app" || ctx.kind === "focus_app" ? { verdict: "refuse", reason: "test: refused" } : { verdict: "run", reason: "ok" });
  const ts = new ComputerToolset({ hands, policy: refuse, onAction: (e) => e.decision && decisions.push(e.decision) });
  const opened = await ts.run("open_app", { name: "Terminal" });
  const focused = await ts.run("focus_app", { name: "Slack" });
  assert.equal(opened.kind, "error");
  assert.equal(focused.kind, "error");
  assert.deepEqual(decisions.map((d) => d.verdict), ["refuse", "refuse"]);
  assert.equal(hands.named("open_app").length, 0);
  assert.equal(hands.named("focus_app").length, 0);
  assert.equal(hands.frontApp, "Notes");
});

test("RAIL-10 / RF-4: open_app \"Send to Kindle\" is a confirm in policy.ts: it asks, and Kevin's yes opens it once", async () => {
  const hands = new FakeHands();
  const seen: ActionContext[] = [];
  const ts = new ComputerToolset({ hands, policy: (ctx) => (seen.push(ctx), (ctx.confirmed ? { verdict: "run", reason: "confirmed" } : /send/i.test(ctx.target ?? "") ? { verdict: "confirm", reason: "test: asks" } : { verdict: "run", reason: "ok" })) });
  const asked = await ts.run("open_app", { name: "Send to Kindle" });
  assert.equal(asked.kind, "needs-confirmation", JSON.stringify(asked));
  assert.equal(hands.named("open_app").length, 0);
  assert.equal(seen[0]?.app, "Send to Kindle", "the app is the target the table judges");
  assert.ok(ts.confirmations.arm());
  assert.equal((await ts.run("open_app", { name: "Send to Kindle" })).kind, "text");
  assert.equal(hands.named("open_app").length, 1);
  assert.equal((await ts.run("open_app", { name: "Send to Kindle" })).kind, "needs-confirmation", "the yes was spent");
  // The real table agrees.
  const real = new ComputerToolset({ hands: new FakeHands() });
  assert.equal((await real.run("open_app", { name: "Send to Kindle" })).kind, "needs-confirmation");
  assert.equal((await real.run("open_app", { name: "Safari" })).kind, "text");
});

// ------------------------------------------------------------------ RAIL-7: a yes covers that action once

test("RAIL-7 (rails R5): a yes to click Send is not spent on Delete Account 30 px away", async () => {
  const hands = new FakeHands();
  hands.apps.set("Mail", 400);
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  hands.elementTitle = "Send";
  const asked = await ts.run("left_click", { coordinate: [500, 300] });
  assert.equal(asked.kind, "needs-confirmation");
  assert.equal(ts.confirmations.pending?.target, "Mail · Send · AXButton", "the judged words are on the question");
  ts.confirmations.arm();
  hands.elementTitle = "Delete Account";
  const r = await ts.run("left_click", { coordinate: [530, 330] });
  assert.equal(r.kind, "needs-confirmation", "the yes for Send does not land on Delete Account");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 0);
  // The same control, re-aimed inside the tolerance: the yes lands it, once.
  ts.confirmations.arm();
  assert.equal((await ts.run("left_click", { coordinate: [505, 302] })).kind, "text");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 1);
});

test("RAIL-7: the arguments must match whole — a plain click's yes is not a cmd+click's, and a yes to type in 1Password is not spent in Bitwarden", async () => {
  const hands = new FakeHands();
  hands.apps.set("Mail", 400);
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  hands.elementTitle = "Send";
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  assert.equal((await ts.run("left_click", { coordinate: [500, 300] })).kind, "needs-confirmation");
  ts.confirmations.arm();
  assert.equal((await ts.run("left_click", { coordinate: [500, 300], text: "cmd" })).kind, "needs-confirmation", "a modifier is another action");
  assert.equal(hands.posted.length, 0);
  ts.confirmations.dropQuestion();

  // A yes to type in 1Password (a hands-off app: asks) does not type into another app's field with the same role.
  const typing = new FakeHands();
  typing.apps.set("1Password", 900);
  typing.frontApp = "1Password";
  typing.frontPid = 900;
  typing.focusedTitle = undefined;
  const tt = new ComputerToolset({ hands: typing });
  assert.equal((await tt.run("type", { text: "hello" })).kind, "needs-confirmation");
  tt.confirmations.arm();
  typing.apps.set("Bitwarden", 901);
  typing.frontApp = "Bitwarden";
  typing.frontPid = 901;
  assert.equal((await tt.run("type", { text: "hello" })).kind, "needs-confirmation", "the yes was for 1Password");
  assert.equal(typing.posted.length, 0);
});

test("RAIL-7 (review): a yes to row 1's Delete is not spent on row 2's Delete 30 px lower (same label and role, another frame); a re-aim inside row 1's Delete lands it once", async () => {
  const hands = new FakeHands();
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  hands.elementTitle = "Delete";
  hands.elementFrame = { x: 500, y: 400, w: 60, h: 24 };
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  assert.equal((await ts.run("left_click", { coordinate: [265, 206] })).kind, "needs-confirmation");
  assert.equal(ts.confirmations.pending?.target, "Mail · Delete · AXButton · [500,400 60x24]", "the frame is part of what was judged");
  ts.confirmations.arm();
  hands.elementFrame = { x: 500, y: 436, w: 60, h: 24 };
  assert.equal((await ts.run("left_click", { coordinate: [265, 221] })).kind, "needs-confirmation", "row 2's Delete is another action");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 0);

  // Row 1's own Delete, asked, confirmed, re-aimed a few pixels inside it: one click.
  hands.elementFrame = { x: 500, y: 400, w: 60, h: 24 };
  assert.equal((await ts.run("left_click", { coordinate: [265, 206] })).kind, "needs-confirmation");
  ts.confirmations.arm();
  hands.elementFrame = { x: 500.4, y: 399.8, w: 60, h: 24 };
  assert.equal((await ts.run("left_click", { coordinate: [268, 207] })).kind, "text", "the same control, its frame rounded the same");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 1);

  // No frame from the helper: the words and the 40 px tolerance decide, as before.
  hands.elementFrame = undefined;
  assert.equal((await ts.run("left_click", { coordinate: [265, 206] })).kind, "needs-confirmation");
  assert.equal(ts.confirmations.pending?.target, "Mail · Delete · AXButton");
  ts.confirmations.arm();
  assert.equal((await ts.run("left_click", { coordinate: [270, 210] })).kind, "text");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 2);
});

test("RAIL-7 (review): click_element binds the yes to its button and count: a yes to one click on Delete is not a double click or a right click", async () => {
  const hands = new TreeHands();
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  hands.elementTitle = "Delete";
  hands.elementFrame = { x: 500, y: 400, w: 60, h: 24 };
  const ts = new ComputerToolset({ hands });
  const asked = await ts.run("click_element", { name: "Delete" });
  assert.equal(asked.kind, "needs-confirmation");
  assert.match((asked as { question: string }).question, /About to click "Delete" in Mail/);
  ts.confirmations.arm();
  const twice = await ts.run("click_element", { name: "Delete", count: 2 });
  assert.equal(twice.kind, "needs-confirmation", "a double click is another action");
  assert.match((twice as { question: string }).question, /About to double click "Delete" in Mail/);
  ts.confirmations.arm();
  assert.equal((await ts.run("click_element", { name: "Delete", button: "right", count: 2 })).kind, "needs-confirmation", "a right double click is another again");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 0);
  ts.confirmations.arm();
  assert.equal((await ts.run("click_element", { name: "Delete", count: 2, button: "right" })).kind, "text", "the same click, its arguments in any order");
  const clicks = hands.posted.filter((p) => p.op === "click");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]!.params["count"], 2);
  assert.equal(clicks[0]!.params["button"], "right");

  // The control moved (a row went away above it): the yes for the old frame lands nothing.
  assert.equal((await ts.run("click_element", { name: "Delete" })).kind, "needs-confirmation");
  ts.confirmations.arm();
  hands.control = { ...hands.control, y: 376 };
  hands.elementFrame = { x: 500, y: 376, w: 60, h: 24 };
  assert.equal((await ts.run("click_element", { name: "Delete" })).kind, "needs-confirmation");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 1);
});

// ------------------------------------------------------------------ TH-1: the expired yes

test("TH-1: a yes after the TTL answers `expired`: nothing armed, no grant, the question stays on the floor, and the action asks again in place", () => {
  let t = 1_000_000;
  const root = new ConfirmationState(3 * 60_000, () => t);
  const spoken: string[] = [];
  const desk = new ConfirmationDesk(root, (name, q) => spoken.push(`${name}: ${q}`), () => t);
  const slack = desk.lane("t_slack", "Slack");
  const spotify = desk.lane("t_spotify", "Spotify");
  const asked = slack.ask('click "Send" in Slack', "click_element", { name: "Send" }, { app: "com.tinyspeck.slackmacgap", actionClass: "click" });
  spotify.ask('click "Play" in Spotify', "click_element", { name: "Play" });
  t += 4 * 60_000;
  assert.equal(root.expired, true);
  let grants = 0;
  const late = root.arm(() => grants++);
  assert.equal(late?.expired, true, "the caller hears `expired`, not silence");
  assert.equal(late?.id, asked.id);
  assert.equal(late?.grant, undefined);
  assert.equal(grants, 0, "an expired question issues no grant");
  assert.equal(slack.consume("click_element", { name: "Send" }), false, "and lands nothing");
  assert.equal(desk.floorLane(), "t_slack", "the floor stays Slack's: the yes was for Slack");
  assert.equal(desk.holds("t_slack"), false, "but it holds no answerable question");
  assert.equal(desk.holds("t_spotify"), false, "Spotify's waited past the TTL too");
  assert.deepEqual(spoken, [], "nobody else's question is spoken over Kevin's yes");
  // The thread re-runs its tool on the yes: the question is asked again on the same floor.
  const again = slack.ask('click "Send" in Slack', "click_element", { name: "Send" });
  assert.notEqual(again.id, asked.id);
  assert.equal(desk.floorLane(), "t_slack");
  assert.equal(desk.holds("t_slack"), true);
  assert.ok(root.arm() && !root.arm()!.expired, "a fresh yes arms it");
  assert.equal(slack.consume("click_element", { name: "Send" }), true);
});

test("TH-1 (review): a yes armed inside the TTL lands a slow re-run for 60 s past the arm, and the desk holds the question meanwhile; later, the yes is spent on nothing and the question waits for its re-ask", () => {
  let t = 0;
  const root = new ConfirmationState(3 * 60_000, () => t);
  const desk = new ConfirmationDesk(root, () => {}, () => t);
  const slack = desk.lane("t_slack", "Slack");
  // Asked at 0:00, yes at 2:55, the re-run lands at 3:05 (past the TTL, 10 s after the yes).
  slack.ask('click "Send" in Slack', "click_element", { name: "Send" });
  t = 175_000;
  const armed = root.arm();
  assert.ok(armed && !armed.expired);
  t = 185_000;
  assert.equal(root.expired, true);
  assert.equal(root.landing, true, "the yes is on its way");
  assert.equal(slack.landing, true, "and the lane on the floor sees it");
  assert.equal(desk.holds("t_slack"), true, "so a tick does not ask again under it");
  assert.equal(root.arm()?.expired, undefined, "a second yes after the TTL does not undo the first");
  assert.equal(slack.consume("click_element", { name: "Send" }), true, "the slow re-run lands, once");
  assert.equal(root.pending, undefined);

  // Asked again, yes at 2:55, the re-run only at 4:00 (65 s after the yes): too late.
  t = 1_000_000;
  slack.ask('click "Send" in Slack', "click_element", { name: "Send" });
  t += 175_000;
  assert.ok(root.arm() && root.landing);
  t += 65_000;
  assert.equal(root.landing, false);
  assert.equal(desk.holds("t_slack"), false, "the cue to ask again");
  assert.equal(slack.consume("click_element", { name: "Send" }), false);
  assert.ok(root.pending, "the question waits to be asked again");
  assert.equal(root.arm()?.expired, true);

  // A yes early in the TTL still lands anywhere inside it, however long the re-run takes (no new limit).
  t = 2_000_000;
  const c = new ConfirmationState(3 * 60_000, () => t);
  c.ask("send", "left_click", { coordinate: [1, 1] });
  t += 10_000;
  assert.ok(c.arm());
  t += 150_000;
  assert.equal(c.consume("left_click", { coordinate: [1, 1] }), true);
});

// ------------------------------------------------------------------ TH-1 / RF-8: the desk never drops a question

test("TH-1 / RF-8: a question dropped straight on the root (the ear reflex's, Kevin moving on from Jarhead's) promotes the next queued one and speaks it once", () => {
  const spoken: string[] = [];
  const root = new ConfirmationState();
  const desk = new ConfirmationDesk(root, (name, q) => spoken.push(`${name}: ${q}`));
  const main = desk.lane("main", "Jarhead");
  const slack = desk.lane("t_slack", "Slack");
  const reflexQ = main.ask('click "Send" in Mail', "click_element", { name: "send" });
  const threadQ = slack.ask('left click on "Send · AXButton" in Slack', "left_click", { coordinate: [10, 10] });
  assert.ok(ConfirmationDesk.isQueuedId(threadQ.id));
  assert.equal(desk.holds("t_slack"), true, "queued counts as held");
  if (root.pending?.id === reflexQ.id) root.dropQuestion();
  assert.equal(desk.holds("t_slack"), true, "holds() reads; it promotes nothing");
  assert.deepEqual(spoken, []);
  desk.promote();
  assert.deepEqual(spoken, ['Slack: left click on "Send" in Slack'], "Slack's question is promoted and spoken");
  assert.equal(desk.floorLane(), "t_slack");
  assert.equal(desk.holds("t_slack"), true);
  assert.equal(desk.holds("main"), false);
  assert.equal(spoken.length, 1, "once");

  // A read of the floor heals it and promotes nothing; the next ask brings the one waiting up first.
  const third = desk.lane("t_mail", "Mail");
  third.ask("archive the thread in Mail", "click_element", { name: "Archive" });
  root.dropQuestion();
  assert.equal(desk.floorLane(), undefined, "a read speaks nothing");
  assert.equal(spoken.length, 1);
  const again = main.ask('click "Send" in Mail', "click_element", { name: "send" });
  assert.ok(ConfirmationDesk.isQueuedId(again.id), "Jarhead's new question waits behind Mail's, which was asked first");
  assert.equal(desk.floorLane(), "t_mail");
  assert.deepEqual(spoken.slice(1), ["Mail: archive the thread in Mail"]);
});

test("TH-1 (review): 'no wait', then 'yes, go ahead' before the engine's tick: the yes finds no floor and arms nothing, Slack's question is not spoken under it; the tick speaks it, and the next yes is Slack's", () => {
  const spoken: string[] = [];
  const root = new ConfirmationState();
  const desk = new ConfirmationDesk(root, (name, q) => spoken.push(`${name}: ${q}`));
  const main = desk.lane("main", "Jarhead");
  const slack = desk.lane("t_slack", "Slack");
  main.ask("send the reply in Mail", "left_click", { coordinate: [1, 1] });
  slack.ask('click "Send" in Slack', "click_element", { name: "Send" });
  // "No wait": the Delegator drops Jarhead's question on the root (Kevin moved on from it).
  root.dropQuestion();
  // "Yes, go ahead", inside the same tick: the Delegator reads the floor to route the yes, then arms the root.
  assert.equal(desk.floorLane(), undefined, "no floor to route the yes to");
  assert.equal(root.arm(), undefined, "nothing to arm: Kevin never heard Slack's question");
  assert.deepEqual(spoken, [], "and it is not spoken under his yes");
  assert.equal(slack.consume("click_element", { name: "Send" }), false);
  assert.equal(desk.holds("t_slack"), true, "Slack's question still waits");
  // The engine's tick.
  desk.promote();
  assert.deepEqual(spoken, ['Slack: click "Send" in Slack']);
  assert.equal(desk.floorLane(), "t_slack");
  // Kevin heard it; his next yes is Slack's, and lands once.
  const armed = root.arm();
  assert.ok(armed && !armed.expired);
  assert.equal(armed.description, 'click "Send" in Slack');
  assert.equal(slack.consume("click_element", { name: "Send" }), true);
  assert.equal(slack.consume("click_element", { name: "Send" }), false);
});

test("TH-1: a cut still takes the floor and the queue together, and speaks nothing", () => {
  const spoken: string[] = [];
  const root = new ConfirmationState();
  const desk = new ConfirmationDesk(root, (name, q) => spoken.push(`${name}: ${q}`));
  desk.lane("main", "Jarhead").ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  desk.lane("t_slack", "Slack").ask('type "hi" in Slack', "type", { text: "hi" });
  root.clear();
  desk.clear();
  assert.equal(desk.floorLane(), undefined);
  assert.equal(desk.queuedCount, 0);
  assert.equal(desk.holds("t_slack"), false);
  assert.deepEqual(spoken, []);
});
