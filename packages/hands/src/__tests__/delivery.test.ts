import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { ComputerToolset, ConfirmationState, GRANT_TTL_MS, HOLD_ID, STALE_FRAME, type ConfirmationGrant } from "../toolset.ts";
import { NativeHandsProcess, TYPE_CANCEL_SIGNAL, type NativeHands, type TypeResult } from "../native.ts";

/**
 * K5 (2026-09-12): hands that deliver like a careful person and confirm like one.
 *   - the stale-frame guard: a coordinate action aimed at a screenshot the screen has moved on from
 *   - conversation-scoped grants: a yes to a repeatable question, kept for the chain, never for a destructive verb
 *   - the presence gate as the toolset feeds it: locked screen, wrong app, Kevin not recent
 *   - the type member: the helper's delivery report, the failure that names the field, the stop mid-word
 */

/** Canned helper: every probe reports the current `config` hash and `locked`; `type` answers with `typeResult` or throws `typeError`. */
class FakeHands implements NativeHands {
  ready = true;
  calls: { op: string; params: Record<string, unknown> }[] = [];
  config = "cfg-1";
  locked = false;
  frontApp = "Mail";
  frontBundle: string | undefined = "com.apple.mail";
  elementTitle = "Search";
  elementRole = "AXButton";
  elementApp: string | undefined;
  focusedApp: string | undefined = "Mail";
  secure = false;
  typeResult: TypeResult = { characters: 5, events: 5, via: "ax", attempts: 1, verified: true, field: 'the "Subject" text field in Mail' };
  typeError: Error | undefined;
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params });
    switch (op) {
      case "screenshot":
        return { displayId: 1, pngBase64: "AAAA", width: 1000, height: 500, points: { x: 0, y: 0, w: 2000, h: 1000 }, scale: 0.5, frameId: 7, config: this.config } as T;
      case "cursor":
        return { x: 100, y: 100 } as T;
      case "frontmost":
        return { app: this.frontApp, ...(this.frontBundle ? { bundleId: this.frontBundle } : {}), pid: 1, window: null, locked: this.locked } as T;
      case "element_at":
        return { role: this.elementRole, title: this.elementTitle, ...(this.elementApp ? { app: this.elementApp } : {}), config: this.config, locked: this.locked } as T;
      case "focused_text":
        return { role: "AXTextField", title: "Subject", secure: this.secure, app: this.focusedApp, frame: { x: 10, y: 10, w: 200, h: 20 }, config: this.config, locked: this.locked } as T;
      case "type":
        if (this.typeError) throw this.typeError;
        return this.typeResult as T;
      default:
        return {} as T;
    }
  }
}

// ------------------------------------------------------------------ stale frames ---

test("stale frame: a coordinate action refuses when the display configuration hash moved on; a new screenshot re-arms it; click_element by name is unaffected", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  const shot = await ts.run("screenshot", {});
  assert.equal(shot.kind, "image");
  assert.match((shot as { note?: string }).note ?? "", /frame 7/);
  assert.equal(ts.screen.last?.config, "cfg-1");

  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text", "same configuration: the click runs");
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 1);

  // A dialog came up / an app switched: the probe reports another hash.
  hands.config = "cfg-2";
  for (const [member, input] of [
    ["left_click", { coordinate: [100, 100] }],
    ["right_click", { coordinate: [100, 100] }],
    ["double_click", { coordinate: [100, 100] }],
    ["left_click_drag", { start_coordinate: [10, 10], coordinate: [100, 100] }],
    ["scroll", { coordinate: [100, 100], scroll_direction: "down", scroll_amount: 2 }],
  ] as const) {
    const r = await ts.run(member, input);
    assert.equal(r.kind, "error", member);
    assert.equal((r as { message: string }).message, STALE_FRAME, member);
  }
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 1, "no click went out");
  assert.equal(hands.calls.filter((c) => c.op === "drag").length, 0);
  assert.equal(hands.calls.filter((c) => c.op === "scroll").length, 0);

  // Not aimed at the screenshot: type, key, scroll-at-the-cursor and mouse_move are not held.
  assert.equal((await ts.run("scroll", { scroll_direction: "down" })).kind, "text");
  assert.equal((await ts.run("type", { text: "hello" })).kind, "text");
  assert.equal((await ts.run("key", { text: "Return" })).kind, "text");

  // click_element clicks a control by name on the live tree — no screenshot involved.
  hands.request = (async (op: string, params: Record<string, unknown> = {}) => {
    hands.calls.push({ op, params });
    if (op === "find_element") return { app: "Mail", window: "Inbox", found: true, unique: true, candidates: 1, tier: "exact", element: { i: 1, depth: 1, role: "AXButton", title: "Reply", app: "Mail", score: 1, label: "Reply", x: 500, y: 400, w: 60, h: 24, center: { x: 530, y: 412 } }, cached: true, treeMs: 1, nodes: 3, truncated: false, ms: 1 };
    if (op === "frontmost") return { app: "Mail", bundleId: "com.apple.mail", pid: 1, window: null };
    if (op === "element_at") return { role: "AXButton", title: "Reply", app: "Mail", frame: { x: 500, y: 400, w: 60, h: 24 }, config: "cfg-3" };
    return {};
  }) as FakeHands["request"];
  // "Reply" is a destructive verb (leaves the machine): it asks, but for the right reason, not the frame.
  const r = await ts.run("click_element", { name: "Reply" });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /Reply/);

  // A new screenshot takes the new configuration and coordinates work again.
  hands.request = FakeHands.prototype.request;
  hands.config = "cfg-2";
  await ts.run("screenshot", {});
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
});

test("stale frame: a helper or a fallback that reports no hash means no guard (never a false refusal)", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  // An older helper: the probe carries no config.
  const orig = hands.request.bind(hands);
  hands.request = (async (op: string, params: Record<string, unknown> = {}) => {
    const r = (await orig(op, params)) as Record<string, unknown>;
    if (op === "element_at") delete r["config"];
    return r;
  }) as FakeHands["request"];
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  assert.ok(ts.screen.sameConfig(undefined));
});

// ------------------------------------------------------------------------ grants ---

test("grants: a recorded yes to the hands-off question opens that app for that class for the conversation; a bare yes keeps nothing; a destructive control or a switch in it still asks; a cut suspends the grants and the same chain's resume wakes them; another chain drops them", async () => {
  let clock = 1_000_000;
  const confirmations = new ConfirmationState(3 * 60_000, () => clock);
  const rows: ConfirmationGrant[] = [];
  const record = (g: ConfirmationGrant): void => {
    rows.push(g);
  };
  const hands = new FakeHands();
  hands.frontApp = "1Password";
  hands.frontBundle = "com.1password.1password";
  hands.focusedApp = "1Password";
  hands.elementTitle = "Copy";
  const ts = new ComputerToolset({ hands, confirmations, now: () => clock });
  await ts.run("screenshot", {});

  // The question names what a yes keeps.
  const asked = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(asked.kind, "needs-confirmation");
  assert.match((asked as { question: string }).question, /A yes also covers clicks in 1Password for the rest of this conversation; destructive controls, settings and switches still ask/);
  assert.deepEqual(confirmations.pending?.grantable, { app: "com.1password.1password", actionClass: "click" });
  assert.equal(confirmations.activeGrants.length, 0, "nothing granted before the yes");

  // A yes nobody records (the typed yes today) arms the one action and keeps nothing: no grant without its row.
  const bare = confirmations.arm();
  assert.ok(bare, "armed");
  assert.equal(bare?.grant, undefined, "no recorder, no grant");
  assert.deepEqual(bare?.grantable, { app: "com.1password.1password", actionClass: "click" }, "the caller can see what a recorded yes would have kept");
  assert.equal(confirmations.activeGrants.length, 0);
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text", "the one-shot yes runs it");
  assert.equal((await ts.run("left_click", { coordinate: [300, 200] })).kind, "needs-confirmation", "and the next click asks again");

  // Kevin says yes and the caller records it: the arm issues the grant (on the yes, not on the retry), row first.
  const armed = confirmations.arm(record);
  assert.ok(armed?.grant);
  assert.equal(armed?.grant?.app, "com.1password.1password");
  assert.equal(armed?.grant?.actionClass, "click");
  assert.equal(armed?.grant?.until, clock + GRANT_TTL_MS);
  assert.equal(GRANT_TTL_MS, 20 * 60_000, "a conversation-shaped ceiling, not a shift");
  assert.deepEqual(rows, [armed!.grant], "the row was written as the grant was born");
  assert.ok(confirmations.granted("com.1password.1password", "click"));
  assert.ok(confirmations.granted("COM.1PASSWORD.1PASSWORD", "Click"), "case-folded key");
  assert.ok(!confirmations.granted("com.1password.1password", "type"), "another class asks");
  assert.ok(!confirmations.granted("com.apple.mail", "click"), "another app asks");

  // The confirmed click runs (the one-shot yes), and so does the next one (the grant): one question, two clicks.
  assert.equal((await ts.run("left_click", { coordinate: [300, 200] })).kind, "text");
  assert.equal((await ts.run("left_click", { coordinate: [320, 200] })).kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 3);

  // Typing there is another class: it asks, and its own recorded yes grants "type".
  const typeAsk = await ts.run("type", { text: "github" });
  assert.equal(typeAsk.kind, "needs-confirmation");
  assert.equal(confirmations.arm(record)?.grant?.actionClass, "type");
  assert.equal((await ts.run("type", { text: "github" })).kind, "text");
  assert.equal((await ts.run("type", { text: "again" })).kind, "text", "granted: no second question");
  // A key press is not typing: under both grants it asks on its own.
  hands.elementTitle = "Login item";
  assert.equal((await ts.run("key", { text: "cmd+delete" })).kind, "needs-confirmation", "cmd+delete in 1Password asks whatever was granted");
  assert.equal(confirmations.pending?.grantable, undefined, "and its yes would keep nothing");
  confirmations.dropQuestion();

  // A destructive control under a granted click keeps asking, every time, and its yes leaves no grant.
  hands.elementTitle = "Delete";
  const del = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(del.kind, "needs-confirmation");
  assert.equal(confirmations.pending?.grantable, undefined, "no class on a destructive verb");
  assert.equal(confirmations.arm(record)?.grant, undefined);
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text", "the one-shot yes");
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "needs-confirmation", "asks again");
  confirmations.dropQuestion();
  // So does a switch: the grant opened the app, not its settings.
  hands.elementTitle = "Autofill";
  hands.elementRole = "AXCheckBox";
  const toggle = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(toggle.kind, "needs-confirmation");
  assert.match((toggle as { question: string }).question, /check ?box control/);
  assert.equal(confirmations.pending?.grantable, undefined);
  confirmations.dropQuestion();
  hands.elementRole = "AXButton";
  assert.equal(rows.length, 2, "two grants, two rows");

  // Moving on from a question (`dropQuestion`) touches no grant.
  hands.elementTitle = "Copy";
  assert.equal(confirmations.activeGrants.length, 2);
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text");

  // A cut (`clear`: the engine's stop or pause) suspends the grants: nothing runs on them.
  confirmations.clear();
  assert.equal(confirmations.activeGrants.length, 0, "asleep");
  assert.ok(!confirmations.granted("com.1password.1password", "click"));
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "needs-confirmation", "after a cut the click asks again");
  confirmations.dropQuestion();

  // The same chain resuming wakes them (a pause and its resume are one conversation) …
  confirmations.beginConversation("");
  assert.equal(confirmations.activeGrants.length, 2, "awake");
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  // … a different chain ends them.
  confirmations.beginConversation("sess_1");
  assert.equal(confirmations.activeGrants.length, 0, "another conversation: gone");
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "needs-confirmation");
});

test("grants: the ceiling — a grant nobody ended expires at `until`; a resume under the same chain keeps it; a cut then another chain drops it; endConversation ends everything", () => {
  let clock = 5_000;
  const c = new ConfirmationState(60_000, () => clock, 1_000);
  const record = (): void => undefined;
  c.beginConversation("root");
  c.ask("click Copy in 1Password", "left_click", { coordinate: [1, 1] }, { app: "com.1password", actionClass: "click" });
  assert.ok(c.arm(record)?.grant);
  assert.ok(c.granted("com.1password", "click"));
  c.beginConversation("root");
  assert.ok(c.granted("com.1password", "click"), "the same chain (a resume) keeps it");
  c.clear();
  assert.ok(!c.granted("com.1password", "click"), "a cut suspends it");
  c.beginConversation("root");
  assert.ok(c.granted("com.1password", "click"), "the same chain resuming wakes it");
  clock += 999;
  assert.ok(c.granted("com.1password", "click"));
  clock += 2;
  assert.ok(!c.granted("com.1password", "click"), "past the ceiling");
  assert.equal(c.activeGrants.length, 0);

  c.ask("type in 1Password", "type", { text: "x" }, { app: "com.1password", actionClass: "type" });
  c.arm(record);
  assert.ok(c.granted("com.1password", "type"));
  c.endConversation();
  assert.ok(!c.granted("com.1password", "type"));
  assert.equal(c.pending, undefined);
  c.ask("type in 1Password", "type", { text: "x" }, { app: "com.1password", actionClass: "type" });
  c.arm(record);
  c.clear();
  c.beginConversation("other");
  assert.ok(!c.granted("com.1password", "type"), "a new chain ends the standing yes, suspended or not");
  assert.equal(c.conversationId, "other");
  assert.equal(c.activeGrants.length, 0);
  // An expired question leaves no grant.
  c.ask("type in 1Password", "type", { text: "x" }, { app: "com.1password", actionClass: "type" });
  clock += 61_000;
  assert.equal(c.arm(record), undefined);
  assert.ok(!c.granted("com.1password", "type"));
});

// ---------------------------------------------------------------------- presence ---

test("presence: a locked screen or the wrong app in front holds a confirm-tier action in Mail (the hands know both); Kevin recent comes from the engine's presenceAt", async () => {
  let clock = 1_000_000;
  let presenceAt: number | undefined = clock - 5_000;
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands, now: () => clock, presenceAt: () => presenceAt });
  await ts.run("screenshot", {});

  // Send in Mail with Kevin there: the ordinary question.
  hands.elementTitle = "Send";
  let r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /looks irreversible/);
  assert.doesNotMatch((r as { question: string }).question, /back at the Mac/);

  // He said yes, then the screen locked before the click: nothing lands, and the line says why — and what.
  ts.confirmations.arm();
  hands.locked = true;
  r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /^Not now: about to left click on "Send · AXButton" in Mail — .*screen is locked/);
  assert.match((r as { question: string }).question, /I'll do this when you're back at the Mac/);
  assert.doesNotMatch((r as { question: string }).question, /confirm out loud/, "a hold is not a question");
  assert.equal((r as { pendingId: string }).pendingId, HOLD_ID);
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 0);
  // The hold registered nothing: the yes was spent on the hold, and a bare "yes" now arms nothing.
  assert.equal(ts.confirmations.pending, undefined, "a hold is not a pending question");
  assert.equal(ts.confirmations.arm(), undefined, "nothing for a yes to arm");
  hands.locked = false;
  // Back at the Mac, the action comes through the gate whole and asks its own question (Send looks irreversible).
  r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /^About to left click on "Send · AXButton" in Mail\. "Send · AXButton" looks irreversible/);
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 0, "a click Kevin never confirmed does not land");
  ts.confirmations.dropQuestion();

  // The point is in Mail but Slack is in front: the wrong-app leg.
  hands.frontApp = "Slack";
  hands.frontBundle = "com.tinyspeck.slackmacgap";
  hands.elementApp = "Mail";
  hands.elementTitle = "Send";
  r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /not the app in front/);
  hands.frontApp = "Mail";
  hands.frontBundle = "com.apple.mail";
  hands.elementApp = "Mail";

  // Kevin has not spoken for a minute.
  presenceAt = clock - 61_000;
  r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /has not said anything for a minute/);
  assert.equal(ts.confirmations.pending, undefined, "the hold posed no question");
  // He is back and the model retries: the real question is posed now, and only his yes to THAT lands the click.
  presenceAt = clock - 1_000;
  r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /looks irreversible/);
  assert.ok(ts.confirmations.pending, "now there is a question");
  ts.confirmations.arm();
  r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 1);

  // A plain click in Mail while he is away runs: the gate holds only what would ask anyway.
  presenceAt = clock - 600_000;
  hands.locked = true;
  hands.elementTitle = "Search";
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  // Typing into Mail's Subject field while locked: a plain run too. A password field: refused, not held.
  assert.equal((await ts.run("type", { text: "hello" })).kind, "text");
  hands.secure = true;
  const refused = await ts.run("type", { text: "hunter2" });
  assert.equal(refused.kind, "error");
  assert.match((refused as { message: string }).message, /password/);
});

test("the press is gated: mouse_move + left_mouse_down + left_mouse_up on Send asks like a click, refuses on a stale frame, and lands nothing until the yes; mouse_move is the aim and stays free", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  hands.elementTitle = "Send";

  // Aim, then press: the press asks for Send.
  assert.equal((await ts.run("mouse_move", { coordinate: [100, 100] })).kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "move").length, 1, "the aim goes out");
  let r = await ts.run("left_mouse_down", {});
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /About to left mouse down on "Send · AXButton" in Mail\. "Send · AXButton" looks irreversible/);
  assert.equal(hands.calls.filter((c) => c.op === "mouse_down").length, 0, "no press went out");
  // The release alone is nothing: it goes out (there is nothing pressed) and clicks nothing.
  assert.equal((await ts.run("left_mouse_up", {})).kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "mouse_up").length, 1);

  // The yes runs the press, once.
  ts.confirmations.arm();
  assert.equal((await ts.run("left_mouse_down", {})).kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "mouse_down").length, 1);
  assert.equal((await ts.run("left_mouse_down", {})).kind, "needs-confirmation", "asks again");
  ts.confirmations.dropQuestion();

  // The stale-frame guard covers the press too: an ordinary control, but the screen moved on.
  hands.elementTitle = "Search";
  hands.config = "cfg-9";
  r = await ts.run("left_mouse_down", {});
  assert.equal(r.kind, "error");
  assert.equal((r as { message: string }).message, STALE_FRAME);
  assert.equal(hands.calls.filter((c) => c.op === "mouse_down").length, 1);
  await ts.run("screenshot", {});
  assert.equal((await ts.run("left_mouse_down", {})).kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "mouse_down").length, 2);

  // A locked screen holds a press on Send in Mail like a click (the presence gate).
  hands.elementTitle = "Send";
  hands.locked = true;
  r = await ts.run("left_mouse_down", {});
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /^Not now: about to left mouse down on "Send · AXButton" in Mail/);
  assert.equal((r as { pendingId: string }).pendingId, HOLD_ID);
  assert.equal(hands.calls.filter((c) => c.op === "mouse_down").length, 2);
});

test("presence: without presenceAt wired, the recent leg is unknown and holds nothing; the other legs still do", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  hands.elementTitle = "Send";
  ts.confirmations.ask("click Send in Mail", "left_click", { coordinate: [100, 100] });
  ts.confirmations.arm();
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text", "no presenceAt: the yes runs");
  hands.locked = true;
  const r = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(r.kind, "needs-confirmation");
  assert.match((r as { question: string }).question, /screen is locked/);
});

// -------------------------------------------------------------------------- type ---

test("type: the result says how the text was delivered and where; the failure names the field and says the text is on the clipboard; a stop mid-word says how far it got", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });

  let r = await ts.run("type", { text: "hello" });
  assert.equal(r.kind, "text");
  assert.equal((r as { text: string }).text, 'typed 5 characters by accessibility insertion into the "Subject" text field in Mail (verified)');
  const sent = hands.calls.find((c) => c.op === "type");
  assert.deepEqual(sent?.params, { text: "hello", expectFront: { pid: 1 } }, "no strategy unless asked; the front app the gate saw rides along");

  hands.typeResult = { characters: 5, events: 5, via: "keystrokes", attempts: 2, verified: false };
  r = await ts.run("type", { text: "hello", strategy: "keystrokes" });
  assert.equal((r as { text: string }).text, 'typed 5 characters by keystrokes into the "Subject" text field in Mail (not verifiable in this field, 2 attempts)');
  assert.deepEqual(hands.calls.filter((c) => c.op === "type").at(-1)?.params, { text: "hello", strategy: "keystrokes", expectFront: { pid: 1 } });

  hands.typeResult = { characters: 5, events: 1, via: "paste", attempts: 3, verified: true, field: "the note in Notes" };
  r = await ts.run("type", { text: "hello" });
  assert.equal((r as { text: string }).text, "typed 5 characters by paste (clipboard restored) into the note in Notes (verified, 3 attempts)");

  hands.typeResult = { characters: 2, events: 2, via: "keystrokes", attempts: 1, cancelled: true, field: "the note in Notes" };
  r = await ts.run("type", { text: "hello" });
  assert.equal((r as { text: string }).text, "stopped after 2 of 5 characters in the note in Notes");

  // The helper's failure comes through in its own words, without the error code in front.
  hands.typeError = Object.assign(new Error("internal: could not type"), { name: "NativeRequestError", detail: { code: "internal", message: 'could not type into the "Subject" text field in Mail after 3 attempts (keystrokes: nothing landed; paste: nothing landed); the text is on the clipboard — one ⌘V in the right field pastes it' } });
  Object.setPrototypeOf(hands.typeError, (await import("../native.ts")).NativeRequestError.prototype);
  r = await ts.run("type", { text: "hello" });
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /^could not type into the "Subject" text field in Mail after 3 attempts/);
  assert.match((r as { message: string }).message, /text is on the clipboard/);

  // An unknown strategy is dropped, not forwarded.
  hands.typeError = undefined;
  hands.typeResult = { characters: 1, events: 1, via: "ax", attempts: 1, verified: true };
  await ts.run("type", { text: "x", strategy: "telepathy" });
  assert.deepEqual(hands.calls.filter((c) => c.op === "type").at(-1)?.params, { text: "x", expectFront: { pid: 1 } });
});

// ------------------------------------------------------------- Kevin's hands win ---

test("expectFront: every gated acting op carries the pid the gate's own frontmost probe saw, so the helper posts nothing if the front app moved; ungated ops carry none", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  hands.elementTitle = "Search";
  const sent = (op: string): Record<string, unknown> | undefined => hands.calls.filter((c) => c.op === op).at(-1)?.params;

  await ts.run("left_click", { coordinate: [100, 100] });
  assert.deepEqual(sent("click")?.["expectFront"], { pid: 1 });
  await ts.run("left_mouse_down", {});
  assert.deepEqual(sent("mouse_down")?.["expectFront"], { pid: 1 });
  await ts.run("left_click_drag", { start_coordinate: [10, 10], coordinate: [100, 100] });
  assert.deepEqual(sent("drag")?.["expectFront"], { pid: 1 });
  await ts.run("type", { text: "hello" });
  assert.deepEqual(sent("type"), { text: "hello", expectFront: { pid: 1 } });
  await ts.run("key", { text: "Return" });
  assert.deepEqual(sent("key")?.["expectFront"], { pid: 1 });
  // No gate, no probe, no expectation.
  await ts.run("left_mouse_up", {});
  assert.equal(sent("mouse_up")?.["expectFront"], undefined);
  await ts.run("scroll", { scroll_direction: "down" });
  assert.equal(sent("scroll")?.["expectFront"], undefined);
  await ts.run("hold_key", { text: "shift", duration: 0 });
  assert.equal(sent("hold_key")?.["expectFront"], undefined);
  await ts.run("mouse_move", { coordinate: [5, 5] });
  assert.equal(sent("move")?.["expectFront"], undefined);

  // A probe that failed (no frontmost): no expectation rather than a wrong one.
  const orig = hands.request.bind(hands);
  hands.request = (async (op: string, params: Record<string, unknown> = {}) => {
    if (op === "frontmost") throw new Error("no frontmost application");
    return orig(op, params);
  }) as FakeHands["request"];
  await ts.run("type", { text: "x" });
  assert.deepEqual(sent("type"), { text: "x" });
  hands.request = FakeHands.prototype.request;

  // click_element: the pid from its own underPoint probe.
  hands.request = (async (op: string, params: Record<string, unknown> = {}) => {
    hands.calls.push({ op, params });
    if (op === "find_element") return { app: "Mail", window: "Inbox", found: true, unique: true, candidates: 1, tier: "exact", element: { i: 1, depth: 1, role: "AXButton", title: "Save", app: "Mail", score: 1, label: "Save", x: 500, y: 400, w: 60, h: 24, center: { x: 530, y: 412 } }, cached: true, treeMs: 1, nodes: 3, truncated: false, ms: 1 };
    if (op === "frontmost") return { app: "Mail", bundleId: "com.apple.mail", pid: 42, window: null };
    if (op === "element_at") return { role: "AXStaticText", title: "Save", app: "Mail", frame: { x: 512, y: 405, w: 36, h: 14 } };
    return {};
  }) as FakeHands["request"];
  assert.equal((await ts.run("click_element", { name: "Save" })).kind, "text");
  assert.deepEqual(sent("click")?.["expectFront"], { pid: 42 });
});

test("focus_moved: the helper's refusal before the first post is an error result (no click, no type result); a type stopped part way says the front app changed", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  const focusMoved = Object.assign(new Error("focus_moved: the front app is Safari (pid 9), not pid 1; nothing was posted"), { name: "NativeRequestError", detail: { code: "focus_moved", message: "the front app is Safari (pid 9), not pid 1; nothing was posted" } });
  Object.setPrototypeOf(focusMoved, (await import("../native.ts")).NativeRequestError.prototype);
  const orig = hands.request.bind(hands);
  hands.request = (async (op: string, params: Record<string, unknown> = {}) => {
    if (op === "click" || op === "type" || op === "key") {
      hands.calls.push({ op, params });
      throw focusMoved;
    }
    return orig(op, params);
  }) as FakeHands["request"];

  const click = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(click.kind, "error");
  assert.match((click as { message: string }).message, /^focus_moved: the front app is Safari \(pid 9\), not pid 1; nothing was posted$/);
  const typed = await ts.run("type", { text: "hello" });
  assert.equal(typed.kind, "error", "no type result to describe");
  assert.match((typed as { message: string }).message, /the front app is Safari .*nothing was posted/);
  const key = await ts.run("key", { text: "Return" });
  assert.equal(key.kind, "error");

  // Mid-text: the helper answers a cancelled result with the reason; the words say what happened.
  hands.request = FakeHands.prototype.request;
  hands.typeResult = { characters: 3, events: 3, via: "keystrokes", attempts: 1, cancelled: true, reason: "focus_moved", field: "the note in Notes" };
  const part = await ts.run("type", { text: "hello" });
  assert.equal(part.kind, "text");
  assert.equal((part as { text: string }).text, "stopped after 3 of 5 characters in the note in Notes: the front app changed, so the rest was not typed; look at the screen before typing again");
  // A plain stop (Kevin's) reads as before.
  hands.typeResult = { characters: 2, events: 2, via: "keystrokes", attempts: 1, cancelled: true, reason: "stop", field: "the note in Notes" };
  assert.equal(((await ts.run("type", { text: "hello" })) as { text: string }).text, "stopped after 2 of 5 characters in the note in Notes");
});

test("busy: the helper's refusal keeps its code in front on every acting member (a runner retries it silently); dictation's ownDriver rides through type", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  const busy = Object.assign(new Error("busy: Kevin used the keyboard/mouse 300 ms ago; nothing was posted"), { name: "NativeRequestError", detail: { code: "busy", message: "Kevin used the keyboard/mouse 300 ms ago; nothing was posted" } });
  Object.setPrototypeOf(busy, (await import("../native.ts")).NativeRequestError.prototype);
  const orig = hands.request.bind(hands);
  hands.request = (async (op: string, params: Record<string, unknown> = {}) => {
    if (op === "click" || op === "type" || op === "key" || op === "scroll") {
      hands.calls.push({ op, params });
      if (params["ownDriver"] !== true) throw busy;
      return op === "type" ? hands.typeResult : {};
    }
    return orig(op, params);
  }) as FakeHands["request"];
  for (const [member, input] of [
    ["left_click", { coordinate: [100, 100] }],
    ["type", { text: "hello" }],
    ["key", { text: "Return" }],
    ["scroll", { scroll_direction: "down" }],
  ] as const) {
    const r = await ts.run(member, input);
    assert.equal(r.kind, "error", member);
    assert.match((r as { message: string }).message, /^busy: Kevin used the keyboard\/mouse 300 ms ago; nothing was posted$/, member);
  }
  const dictated = await ts.run("type", { text: "hello", ownDriver: true });
  assert.equal(dictated.kind, "text");
  assert.deepEqual(hands.calls.filter((c) => c.op === "type").at(-1)?.params, { text: "hello", ownDriver: true, expectFront: { pid: 1 } });
  // Not asked for: not forwarded.
  hands.request = FakeHands.prototype.request;
  await ts.run("type", { text: "x", ownDriver: "yes" });
  assert.deepEqual(hands.calls.filter((c) => c.op === "type").at(-1)?.params, { text: "x", expectFront: { pid: 1 } });
});

// ---------------------------------------------------------------- the stop signal ---

/** A stand-in child with a pid, so the client's out-of-band type cancel has somewhere to send its signal. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  seen: { id: string; op: string }[] = [];
  constructor(readonly pid: number) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) this.seen.push(JSON.parse(line) as { id: string; op: string });
    });
    setImmediate(() => this.emit("spawn"));
  }
  kill(): boolean {
    this.exitCode = 0;
    return true;
  }
}

async function seen(child: FakeChild, n: number, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (child.seen.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`only ${child.seen.length} of ${n} requests reached the helper within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("cancelPending sends the helper SIGURG only while a `type` is in flight (this process stands in for the helper; SIGURG is ignored by default)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-hands-"));
  const bin = join(dir, "hands");
  writeFileSync(bin, "#!/bin/sh\n");
  const signals: NodeJS.Signals[] = [];
  const onUrg = (): void => {
    signals.push(TYPE_CANCEL_SIGNAL);
  };
  process.on(TYPE_CANCEL_SIGNAL, onUrg);
  try {
    const child = new FakeChild(process.pid);
    const hands = new NativeHandsProcess({ binPath: bin, spawnImpl: (() => child as unknown as ChildProcess) as never });

    // A click in flight: no signal (a click that went out has landed; nothing to stop).
    const click = hands.request("click", { x: 1, y: 2 });
    await seen(child, 1);
    assert.equal(hands.cancelPending("stopped"), 1);
    await assert.rejects(click, /cancelled/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(signals.length, 0);

    // A type in flight: the signal goes out with the cancel, before the id is forgotten.
    const typing = hands.request("type", { text: "hello world" });
    await seen(child, 2);
    assert.equal(hands.cancelPending("stopped"), 1);
    await assert.rejects(typing, /cancelled/);
    const t0 = Date.now();
    while (signals.length === 0 && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(signals, [TYPE_CANCEL_SIGNAL]);

    // The helper's late answer for the cancelled type is dropped and the client stays usable.
    child.stdout.write(`${JSON.stringify({ id: child.seen[1]!.id, ok: true, result: { characters: 3, cancelled: true } })}\n`);
    const cursor = hands.request("cursor");
    await seen(child, 3);
    child.stdout.write(`${JSON.stringify({ id: child.seen[2]!.id, ok: true, result: { x: 1, y: 1 } })}\n`);
    assert.deepEqual(await cursor, { x: 1, y: 1 });
    hands.stop();
  } finally {
    process.off(TYPE_CANCEL_SIGNAL, onUrg);
  }
});
