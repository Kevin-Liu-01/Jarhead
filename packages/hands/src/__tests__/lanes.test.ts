import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset, ConfirmationState, type ConfirmationGrant } from "../toolset.ts";
import { ConfirmationDesk, queuedText, spokenQuestion } from "../lanes.ts";
import { FakeHands } from "../fake.ts";

/**
 * The desk: one question floor for every hand. Two lanes ask → one root pending, the
 * other queued and silent; a yes lands only the floor's action; the next question is
 * promoted and spoken once with its hand's name; Kevin moving on drops floor and queue;
 * grants are the conversation's (every lane), and never for the policy's never-grant apps.
 */

function world(): { clock: { t: number }; root: ConfirmationState; desk: ConfirmationDesk; spoken: { name: string; question: string }[]; rows: ConfirmationGrant[]; record: (g: ConfirmationGrant) => void } {
  const clock = { t: 1_000_000 };
  const now = (): number => clock.t;
  const root = new ConfirmationState(3 * 60_000, now);
  const spoken: { name: string; question: string }[] = [];
  const desk = new ConfirmationDesk(root, (name, question) => spoken.push({ name, question }), now);
  const rows: ConfirmationGrant[] = [];
  return { clock, root, desk, spoken, rows, record: (g) => rows.push(g) };
}

/** A toolset on a lane, with Send under the pointer in `app` by default (a destructive verb: asks, never grants). */
function laneToolset(desk: ConfirmationDesk, id: string, name: string, app: string, clock: { t: number }): { ts: ComputerToolset; hands: FakeHands } {
  const hands = new FakeHands();
  hands.now = () => clock.t;
  hands.frontApp = app;
  hands.frontBundle = `com.example.${app.toLowerCase().replace(/\s+/g, "")}`;
  hands.frontPid = 7;
  hands.elementTitle = "Send";
  const ts = new ComputerToolset({ hands, confirmations: desk.lane(id, name), now: () => clock.t });
  return { ts, hands };
}

test("two lanes ask: the first is the root's pending, the second is queued with a queued_<n> id, nothing armed, nothing spoken", async () => {
  const { clock, root, desk, spoken } = world();
  const slack = laneToolset(desk, "jarhead", "Jarhead", "Slack", clock);
  const spotify = laneToolset(desk, "w_1", "Spotify", "Spotify", clock);
  await slack.ts.run("screenshot", {});
  await spotify.ts.run("screenshot", {});

  const a = await slack.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(a.kind, "needs-confirmation");
  assert.match((a as { pendingId: string }).pendingId, /^confirm_/);
  assert.equal(root.pending?.id, (a as { pendingId: string }).pendingId, "the first question is the root's");
  assert.equal(desk.floor?.laneId, "jarhead");

  const b = await spotify.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(b.kind, "needs-confirmation");
  assert.match((b as { pendingId: string }).pendingId, /^queued_1$/);
  assert.equal(root.pending?.id, (a as { pendingId: string }).pendingId, "the root still holds the first question — nothing overwritten");
  assert.equal(desk.queued.length, 1);
  assert.equal(desk.queued[0]?.laneName, "Spotify");
  assert.deepEqual(spoken, [], "a queued question is not spoken over the one on the floor");
  assert.equal(root.arm() !== undefined, true, "a yes arms the floor's question");
  // The lane's view: Jarhead's pending is the root's; Spotify's is its queued stub.
  assert.equal(desk.lane("jarhead", "Jarhead").pending?.id, root.pending?.id);
  assert.equal(desk.lane("w_1", "Spotify").pending?.id, "queued_1");
  assert.equal(desk.lane("w_1", "Spotify").pending?.description, queuedText({ laneName: "Jarhead", description: desk.floor!.description }));
  // The rendered result tells the second brain to stop and wait, not retry.
  const rendered = desk.render(b);
  assert.equal(rendered.kind, "needs-confirmation");
  assert.match((rendered as { question: string }).question, /^Queued behind Jarhead's question: left click on "Send · AXButton" in Slack\. Kevin will be asked after that one; stop and wait \(thread_wait\), do not retry$/);
  assert.equal(desk.render(a), a, "a floor question renders as it is");
});

test("consume is false for a non-floor lane even with the same member and target; the floor's lane spends the yes, then the next question is promoted and spoken once, naming its thread", async () => {
  const { clock, root, desk, spoken } = world();
  const slack = laneToolset(desk, "jarhead", "Jarhead", "Slack", clock);
  const spotify = laneToolset(desk, "w_1", "Spotify", "Spotify", clock);
  await slack.ts.run("screenshot", {});
  await spotify.ts.run("screenshot", {});
  assert.equal((await slack.ts.run("left_click", { coordinate: [100, 100] })).kind, "needs-confirmation");
  assert.equal((await spotify.ts.run("left_click", { coordinate: [100, 100] })).kind, "needs-confirmation");

  // Kevin: "yes" — the Delegator arms the root.
  assert.ok(root.arm());
  // Spotify retries the very same action: not its yes.
  assert.equal(desk.lane("w_1", "Spotify").consume("left_click", { coordinate: [100, 100] }), false);
  const stillQueued = await spotify.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(stillQueued.kind, "needs-confirmation", "asks again, and lands nothing");
  assert.equal((stillQueued as { pendingId: string }).pendingId, "queued_2", "a retry replaces its queued question, it does not multiply");
  assert.equal(desk.queued.length, 1);
  assert.equal(spotify.hands.posted.length, 0, "no click went out on Spotify's lane");
  assert.ok(root.pending, "and the floor's question is still armed for its own lane");

  // Jarhead's retry is the one the yes was for.
  const clicked = await slack.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(clicked.kind, "text");
  assert.equal(slack.hands.posted.filter((c) => c.op === "click").length, 1);

  // The floor cleared: Spotify's question is on the root now and was spoken once, with its name.
  assert.equal(desk.floor?.laneId, "w_1");
  assert.equal(desk.queued.length, 0);
  assert.match(root.pending?.id ?? "", /^confirm_/);
  assert.deepEqual(spoken, [{ name: "Spotify", question: 'left click on "Send" in Spotify' }]);
  assert.equal(spokenQuestion('left click on "Send · AXButton" in Spotify'), 'left click on "Send" in Spotify');
  // Kevin's yes now lands Spotify's click and nobody else's.
  assert.ok(root.arm());
  assert.equal(desk.lane("jarhead", "Jarhead").consume("left_click", { coordinate: [100, 100] }), false);
  assert.equal((await spotify.ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  assert.equal(spotify.hands.posted.filter((c) => c.op === "click").length, 1);
  assert.equal(spoken.length, 1, "spoken once");
  assert.equal(desk.floorLane(), undefined);
  assert.equal(root.pending, undefined);
});

test("dropQuestion (Kevin moved on) drops the floor AND the queue — through a lane, or directly on the root as the Delegator, the ear reflex and dictation do it; clear (a cut) does too and suspends the grants", () => {
  const { root, desk, spoken } = world();
  const a = desk.lane("jarhead", "Jarhead");
  const b = desk.lane("w_1", "Spotify");
  const c = desk.lane("w_2", "Slack");
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  b.ask("play Focus in Spotify", "click_element", { name: "Play" });
  c.ask('type "hi" in Slack', "type", { text: "hi" });
  assert.equal(desk.queued.length, 2);
  desk.lane("w_1", "Spotify").dropQuestion();
  assert.equal(root.pending, undefined);
  assert.equal(desk.floorLane(), undefined);
  assert.equal(desk.queued.length, 0, "everything behind the floor went with it");
  assert.equal(desk.promote(), undefined);
  assert.deepEqual(spoken, []);

  // The engine dropped the root directly (the Delegator is wired to the root): the floor heals and the queue goes with it —
  // Kevin moved on from the question that was spoken; nobody's unspoken question comes up behind his back at the next tick.
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  b.ask("play Focus in Spotify", "click_element", { name: "Play" });
  root.dropQuestion();
  assert.equal(desk.floorLane(), undefined, "the root's question is gone, so is the floor");
  assert.equal(desk.queuedCount, 0, "and the queue behind it");
  assert.equal(desk.promote(), undefined);
  assert.deepEqual(spoken, []);
  assert.equal(b.pending, undefined);

  // A cut.
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  c.ask('type "hi" in Slack', "type", { text: "hi" });
  assert.equal(desk.queuedCount, 1);
  b.clear();
  assert.equal(root.pending, undefined);
  assert.equal(desk.queued.length, 0);
  assert.equal(desk.floorLane(), undefined);
});

test("the main lane queues too: with a thread's question on the floor, Jarhead's own gated action gets a queued_<n> id whose toolset text is still the policy's (the runner renders the queued one), nothing is spoken, and Kevin's yes arms the thread's question", async () => {
  const { clock, root, desk, spoken } = world();
  const spotify = laneToolset(desk, "w_1", "Spotify", "Spotify", clock);
  const slack = laneToolset(desk, "jarhead", "Jarhead", "Slack", clock);
  await spotify.ts.run("screenshot", {});
  await slack.ts.run("screenshot", {});
  const first = await spotify.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(first.kind, "needs-confirmation");
  assert.equal(desk.floorLane(), "w_1");

  const mine = await slack.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(mine.kind, "needs-confirmation");
  assert.equal((mine as { pendingId: string }).pendingId, "queued_1");
  assert.doesNotMatch((mine as { question: string }).question, /^Queued behind/, "the gate builds the question from the policy decision: the desk cannot reach it");
  assert.match((desk.render(mine) as { question: string }).question, /^Queued behind Spotify's question: left click on "Send · AXButton" in Spotify\. Kevin will be asked after that one; stop and wait \(thread_wait\), do not retry$/);
  assert.deepEqual(spoken, [], "Kevin hears one question");
  assert.equal(root.pending?.id, (first as { pendingId: string }).pendingId, "the thread's question is the one on the root");
  // Kevin: "yes" — the Delegator arms the root: the thread's question, not Jarhead's.
  assert.equal(root.arm()?.id, (first as { pendingId: string }).pendingId);
  assert.equal(desk.lane("jarhead", "Jarhead").consume("left_click", { coordinate: [100, 100] }), false, "not Jarhead's yes");
  assert.equal((await spotify.ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  assert.equal(spotify.hands.posted.filter((c) => c.op === "click").length, 1);
  assert.equal(slack.hands.posted.length, 0);
  // Then Jarhead's own question comes up, spoken once under its name.
  assert.equal(desk.floorLane(), "jarhead");
  assert.deepEqual(spoken, [{ name: "Jarhead", question: 'left click on "Send" in Slack' }]);
});

test("grants are the conversation's: a recorded yes in one lane is granted() in every lane; System Settings is never grantable in any lane; a destructive verb leaves no grant", async () => {
  const { clock, root, desk, rows, record } = world();
  const a = laneToolset(desk, "jarhead", "Jarhead", "1Password", clock);
  const b = laneToolset(desk, "w_1", "Vault", "1Password", clock);
  a.hands.elementTitle = "Copy";
  b.hands.elementTitle = "Copy";
  await a.ts.run("screenshot", {});
  await b.ts.run("screenshot", {});

  // The hands-off app asks in lane A, with a grantable question.
  const asked = await a.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(asked.kind, "needs-confirmation");
  assert.match((asked as { question: string }).question, /A yes also covers clicks in 1Password/);
  assert.equal(root.pending?.grantable?.actionClass, "click");
  // Kevin's recorded yes: the grant is the root's.
  const armed = root.arm(record);
  assert.ok(armed?.grant);
  assert.equal(rows.length, 1);
  assert.equal((await a.ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  // Lane B never asked and never said anything: the standing yes covers it too.
  assert.ok(desk.lane("w_1", "Vault").granted(armed!.grant!.app, "click"));
  assert.equal((await b.ts.run("left_click", { coordinate: [300, 200] })).kind, "text", "granted in lane B");
  assert.equal(b.hands.posted.filter((c) => c.op === "click").length, 1);
  assert.equal(desk.lane("w_1", "Vault").activeGrants.length, 1);
  assert.equal(desk.lane("jarhead", "Jarhead").conversationId, root.conversationId);

  // System Settings: the policy hands no class to grant, in any lane.
  const settings = laneToolset(desk, "w_2", "Settings", "System Settings", clock);
  settings.hands.frontBundle = "com.apple.systempreferences";
  settings.hands.elementTitle = "Allow";
  await settings.ts.run("screenshot", {});
  const s = await settings.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(s.kind, "needs-confirmation");
  assert.doesNotMatch((s as { question: string }).question, /A yes also covers/);
  assert.equal(root.pending?.grantable, undefined, "nothing to grant");
  assert.equal(root.arm(record)?.grant, undefined);
  assert.ok(!desk.lane("w_2", "Settings").granted("com.apple.systempreferences", "click"));
  assert.ok(!desk.lane("jarhead", "Jarhead").granted("com.apple.systempreferences", "click"));
  assert.equal((await settings.ts.run("left_click", { coordinate: [100, 100] })).kind, "text", "the one-shot yes runs it");
  assert.equal((await settings.ts.run("left_click", { coordinate: [100, 100] })).kind, "needs-confirmation", "and it asks again");
  assert.equal(rows.length, 1, "no second grant row");
  desk.dropQuestion();

  // A destructive verb (Send) in the granted app: asks every time, its yes keeps nothing, in lane B as in A.
  b.hands.elementTitle = "Send";
  const send = await b.ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(send.kind, "needs-confirmation");
  assert.equal(root.pending?.grantable, undefined);
  assert.equal(root.arm(record)?.grant, undefined);
  assert.equal(rows.length, 1);
  // endConversation from any lane ends every standing yes.
  desk.lane("w_1", "Vault").endConversation();
  assert.equal(root.activeGrants.length, 0);
  assert.equal(root.pending, undefined);
  assert.ok(!desk.lane("jarhead", "Jarhead").granted(armed!.grant!.app, "click"));
});

test("TTL: a floor question that expired unanswered takes the queue with it; a queued question older than the TTL is dropped by promote, not re-asked; a lane's own drop promotes the next; a lane that ended takes its queued question with it; one lane object per id", () => {
  const { clock, root, desk, spoken } = world();
  const a = desk.lane("jarhead", "Jarhead");
  const b = desk.lane("w_1", "Spotify");
  assert.equal(desk.lane("w_1", "Spotify"), b, "the same object on every call");
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  clock.t += 2 * 60_000;
  b.ask("play Focus in Spotify", "click_element", { name: "Play" });
  clock.t += 60_000 + 1;
  assert.equal(root.arm(), undefined, "the root's question expired: a late yes lands nothing");
  assert.equal(desk.floorLane(), undefined);
  assert.equal(desk.queuedCount, 0, "Kevin never answered the one before it: Spotify's is not asked out of nowhere");
  assert.equal(desk.promote(), undefined);
  assert.deepEqual(spoken, []);
  assert.equal(a.onFloor, false);
  assert.equal(b.onFloor, false);
  assert.equal(desk.pendingOf("w_1"), undefined, "Spotify has nothing waiting any more");
  // A queued question that waited past the TTL is dropped when its turn comes, not re-asked.
  const d = desk.lane("w_3", "Mail");
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  d.ask("archive the thread in Mail", "click_element", { name: "Archive" });
  clock.t += 3 * 60_000 + 1;
  desk.drop("jarhead"); // Jarhead's question goes its own way; the next would come up — Mail's waited as long as the TTL
  assert.equal(desk.floorLane(), undefined, "Mail's was dropped, not asked");
  assert.equal(desk.queuedCount, 0);
  assert.deepEqual(spoken, []);
  // A lane's own drop takes only its question; the next comes up.
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  b.ask("play Focus in Spotify", "click_element", { name: "Play" });
  d.ask("archive the thread in Mail", "click_element", { name: "Archive" });
  desk.drop("jarhead");
  assert.equal(desk.floorLane(), "w_1", "Spotify's came up");
  assert.equal(desk.queuedCount, 1);
  assert.equal(spoken.length, 1);
  assert.equal(b.onFloor, true);
  assert.equal(b.waiting?.id, root.pending?.id);
  b.pending = undefined; // the base's idiom for "gone": this lane's only
  assert.equal(desk.floorLane(), "w_3");
  assert.equal(spoken.length, 2);
  desk.dropQuestion();
  // Slack queues behind Jarhead, then its thread ends: nothing of its stays; Jarhead's question does.
  a.ask("send the message in Mail", "left_click", { coordinate: [1, 1] });
  const c = desk.lane("w_2", "Slack");
  c.ask('type "hi" in Slack', "type", { text: "hi" });
  assert.equal(c.queuedQuestion?.laneName, "Slack");
  desk.forget("w_2");
  assert.equal(desk.queued.length, 0);
  assert.equal(desk.floorLane(), "jarhead");
  assert.notEqual(desk.lane("w_2", "Slack"), c, "a forgotten lane is a new object next time");
});
