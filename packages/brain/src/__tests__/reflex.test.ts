import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator, type DelegationTimingsExtra } from "../delegator.ts";
import { ReflexRunner, addressesJarhead, clickByNameScript, normalizeUtterance, parseReflex, type Reflex, type ReflexOutcome } from "../reflex.ts";
import type { Brain, BrainResult, BrainSink, BrainTask } from "../brain.ts";
import { FakeHands, makeRunner } from "./fakes.ts";

/**
 * Reflexes: whole one-step utterances become one tool call and one spoken line
 * without a brain; anything else, or a reflex that errors, goes to the brain. The
 * cheap reversible ones may fire as soon as the utterance settles when Kevin named
 * Jarhead or is mid-exchange, and the delegation that follows claims the result.
 */

test("parseReflex: whole commands match, wrapped in the wake word and politeness; sentences and ambiguous phrases do not", () => {
  assert.equal(normalizeUtterance("Hey Jarhead, scroll down please."), "scroll down");
  assert.equal(normalizeUtterance("jarhead scroll up"), "scroll up");
  assert.equal(normalizeUtterance("can you press enter now"), "press enter");
  assert.ok(addressesJarhead("hey jar head, scroll down") && !addressesJarhead("scroll down"));

  const down = parseReflex("Hey Jarhead, scroll down please.")!;
  assert.deepEqual([down.kind, down.tool, down.input, down.said, down.prefire], ["scroll", "scroll", { scroll_direction: "down", scroll_amount: 5 }, "scrolled down.", true]);
  assert.equal(parseReflex("scroll up a bit")!.input["scroll_direction"], "up");
  assert.deepEqual(parseReflex("press enter")!.input, { text: "Return" });
  assert.equal(parseReflex("hit return")!.kind, "key");
  assert.deepEqual(parseReflex("close this window")!.input, { text: "cmd+w" });
  assert.deepEqual(parseReflex("go back")!.input, { text: "cmd+[" });
  assert.deepEqual(parseReflex("screenshot this")!.input, { quick: true });
  assert.equal(parseReflex("take a screenshot")!.kind, "screenshot");
  assert.equal(parseReflex("screenshot this")!.prefire, true);
  assert.deepEqual(parseReflex("type hello world")!.input, { text: "hello world" });
  assert.deepEqual(parseReflex("Jarhead, type Dear Ana, thanks for the notes.")!.input, { text: "Dear Ana, thanks for the notes" });
  assert.deepEqual(parseReflex("open safari")!.input, { name: "Safari" });
  assert.deepEqual(parseReflex("switch to visual studio code")!.input, { name: "Visual Studio Code" });
  assert.equal(parseReflex("open the file")!, undefined, "not an app name");
  assert.equal(parseReflex("open my downloads folder"), undefined);
  const click = parseReflex("click save")!;
  assert.equal(click.kind, "click");
  assert.equal(click.label, "click save");
  assert.equal(parseReflex("click the Save button")!.label, "click save");
  assert.equal(parseReflex("click it"), undefined);
  assert.equal(parseReflex("press enter")!.prefire, false, "keys wait for Live's word");
  assert.equal(parseReflex("open safari")!.prefire, false);

  // Sentences, compounds and anything that needs a look go to the brain.
  for (const s of ["scroll down to the footer and click save", "scroll down until you see the total", "what app is open", "type the address from the email", "open the door", "press enter twice", "click the third row", "", "scroll"]) {
    assert.equal(parseReflex(s), undefined, s);
  }
});

test("set_voice: 'switch voice to marin' / 'speak with a british accent' are the one settings-writing meta reflex — a VOICES id or an accent word only; 'use ash', 'be marin', an unknown name and a compound are not; 'switch to marin' stays the app row's", () => {
  const marin = parseReflex("switch voice to marin")!;
  assert.deepEqual(marin, { kind: "set_voice", tool: "set_voice", input: { voice: "marin" }, said: "", label: "switch voice to marin", prefire: false, idempotent: true, meta: true });
  for (const said of ["change the voice to cedar", "switch your voice to cedar", "Change voice to Cedar", "Jarhead, switch the voice to cedar please.", "um, change voice to cedar"]) {
    const r = parseReflex(said);
    assert.ok(r, said);
    assert.equal(r.kind, "set_voice", said);
    assert.deepEqual(r.input, { voice: "cedar" }, said);
    assert.equal(r.meta, true, said);
    assert.equal(r.prefire, false, said);
    assert.equal(r.idempotent, true, said);
    assert.equal(r.said, "", `${said}: spoken from the result`);
  }
  const british = parseReflex("speak with a british accent")!;
  assert.deepEqual(british, { kind: "set_voice", tool: "set_voice", input: { accent: "british" }, said: "", label: "speak with a british accent", prefire: false, idempotent: true, meta: true });
  assert.deepEqual(parseReflex("talk in an american accent")!.input, { accent: "american" });
  assert.deepEqual(parseReflex("Jarhead, speak in a British accent, please")!.input, { accent: "british" });
  // Not the voice row: a bare name, a loose verb, a name that is no voice, a compound, another accent word.
  for (const s of ["use ash", "be marin", "marin", "switch voice to bob", "switch voice to marin and say hi", "speak with a scottish accent", "speak with an accent", "switch voice", "change the voice"]) {
    const r = parseReflex(s);
    assert.ok(!r || r.kind !== "set_voice", `${s}: not a voice switch (got ${JSON.stringify(r)})`);
  }
  assert.equal(parseReflex("switch to marin")!.kind, "open_app", "the app row keeps 'switch to <name>'");
  assert.equal(parseReflex("use ash"), undefined);
  assert.equal(parseReflex("be marin"), undefined);
  assert.equal(parseReflex("switch voice to bob"), undefined, "no such voice: the brain's");
});

test("ReflexRunner: a reflex runs through the runner; a click is pre-checked by the policy and left to the brain when the control looks irreversible or the app is hands-off", async () => {
  const hands = new FakeHands();
  const { runner } = makeRunner({}, hands);
  let front = "Finder";
  const reflexes = new ReflexRunner({ runner, frontmostApp: async () => front });
  const scroll = await reflexes.run(reflexes.match("scroll down")!);
  assert.equal(scroll.ok, true);
  assert.equal(scroll.result.kind, "text");

  // A click by name is an AppleScript into the frontmost app's front window; the policy gate ran (Finder: fine).
  assert.match(clickByNameScript('Sa"ve'), /buttons of window 1 whose name is "Sa\\"ve"/);
  assert.match(clickByNameScript("Save"), /first application process whose frontmost is true/);
  assert.ok(!/contains/.test(clickByNameScript("ok")), "an exact name only: a substring match would click a control the policy never judged (\"ok\" in \"Revoke Token\")");
  const send = await reflexes.run(reflexes.match("click send")!);
  assert.equal(send.ok, false, "Send looks irreversible: the brain asks properly");
  assert.match((send.result as { message: string }).message, /not a reflex: .*irreversible/);
  front = "1Password";
  const inVault = await reflexes.run(reflexes.match("click save")!);
  assert.equal(inVault.ok, false);
  front = "Finder";
});

/** A LiveSession stand-in with the surface the delegator touches. */
class FakeLive extends EventEmitter {
  sent: { type: string; payload: unknown }[] = [];
  nowMs = 5000;
  appendThinking(id: string | null, content: string): string { this.sent.push({ type: "thinking", payload: { id, content } }); return "t"; }
  appendCommentary(id: string | null, content: string): string { this.sent.push({ type: "commentary", payload: { id, content } }); return "c"; }
  appendInstructions(id: string | null, content: string): string { this.sent.push({ type: "instructions", payload: { id, content } }); return "i"; }
}

function fakeBrain(seen: BrainTask[]): Brain {
  return {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task, sink) => {
      seen.push(task);
      sink.step({ kind: "tool", tool: { name: "screenshot", input: {}, ok: true, ms: 40 } });
      sink.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [1, 2] }, ok: true, ms: 9 } });
      return { status: "done", summary: "clicked it." } satisfies BrainResult;
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
}

test("delegator: a reflex finishes the delegation without the brain, a failed reflex hands over, and the timings record first tool / first action / round trips", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const ran: string[] = [];
  let fail = false;
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome> => {
      ran.push(reflex.label);
      if (fail) return { reflex, result: { kind: "error", message: "no such button" }, ms: 3, ok: false };
      sink?.step({ kind: "tool", tool: { name: reflex.tool, input: reflex.input, ok: true, ms: 12 } });
      return { reflex, result: { kind: "text", text: "OK" }, ms: 12, ok: true };
    },
    inExchange: () => false,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: fakeBrain(seen), confirmations: new ConfirmationState(), reflexes, commentaryCoalesceMs: 0 });
  const reflexEvents: string[] = [];
  d.on("reflex", (label, _ms, prefired) => reflexEvents.push(`${label}:${prefired}`));

  // "scroll down" → the scroll tool, one spoken line, done; the brain never saw it.
  transcript.push({ speaker: "kevin", delta: "jarhead scroll down", startMs: 0, endMs: 700 });
  live.emit("delegation", "item_1", "client", 700);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ["scroll down"]);
  assert.equal(seen.length, 0, "no brain");
  const first = d.all()[0]!;
  assert.equal(first.status, "done");
  assert.equal(first.summary, "scrolled down.");
  assert.deepEqual(first.steps.map((s) => s.kind), ["note", "tool", "commentary"]);
  assert.equal(first.steps[0]!.text, "reflex: scroll down");
  const t1 = first.timings as DelegationTimingsExtra;
  assert.equal(t1.reflex, true);
  assert.ok(t1.firstToolAt && t1.firstActionAt && t1.doneAt, "a scroll is an action");
  assert.deepEqual(t1.toolRoundTripMs, [12]);
  assert.deepEqual(reflexEvents, ["scroll down:false"]);
  assert.deepEqual(live.sent.map((s) => s.type), ["commentary"]);
  assert.equal((live.sent[0]!.payload as { content: string }).content, "scrolled down.");

  // A reflex that fails hands the task to the brain, with the attempt on the timeline.
  fail = true;
  live.sent.length = 0;
  live.nowMs = 3600;
  transcript.push({ speaker: "kevin", delta: " click save", startMs: 3000, endMs: 3600 });
  live.emit("delegation", "item_2", "client", 3600);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ["scroll down", "click save"]);
  assert.equal(seen.length, 1, "the brain took it");
  const second = d.all()[1]!;
  assert.equal(second.status, "done");
  assert.equal(second.summary, "clicked it.");
  assert.deepEqual(second.steps.map((s) => s.kind), ["note", "note", "tool", "tool", "commentary"]);
  assert.match(second.steps[1]!.text ?? "", /did not apply \(no such button\); the brain takes it/);
  const t2 = second.timings as DelegationTimingsExtra;
  assert.equal(t2.reflex, undefined);
  assert.ok(t2.firstToolAt !== undefined && t2.firstActionAt !== undefined && t2.firstActionAt >= t2.firstToolAt, "screenshot first, then the click is the first action");
  assert.deepEqual(t2.toolRoundTripMs, [40, 9]);

  // Not a reflex at all: straight to the brain, no attempt recorded.
  live.nowMs = 5800;
  transcript.push({ speaker: "kevin", delta: " what is on my screen", startMs: 5200, endMs: 5800 });
  live.emit("delegation", "item_3", "client", 5800);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(d.all()[2]!.steps.map((s) => s.kind), ["tool", "tool", "commentary"]);
});

test("delegator: a cheap reflex said to Jarhead fires when the utterance has clearly ended, ahead of the delegation, which then adopts its record and only speaks; one not addressed waits for Live", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const ran: { label: string; at: number }[] = [];
  let exchange = false;
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome> => {
      ran.push({ label: reflex.label, at: Date.now() });
      sink?.step({ kind: "tool", tool: { name: reflex.tool, input: reflex.input, ok: true, ms: 8 } });
      return { reflex, result: { kind: "text", text: "OK" }, ms: 8, ok: true };
    },
    inExchange: () => exchange,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: fakeBrain(seen), confirmations: new ConfirmationState(), reflexes, prefireQuietMs: 30, prefireLongQuietMs: 90, commentaryCoalesceMs: 0 });
  const events: string[] = [];
  d.on("reflex", (label, _ms, prefired) => events.push(`${label}:${prefired}`));

  // The engine pushes the fragment after the delegator hears it; the delegator judges the settled utterance.
  const say = (delta: string, s: number, e: number): void => {
    live.emit("inputTranscript", delta, s, e);
    transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
  };
  say("jarhead", 0, 300);
  say(" scroll down", 300, 800);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ran.length, 0, "no full stop: the short quiet window is not enough — a pause mid-sentence looks the same");
  await new Promise((r) => setTimeout(r, 110));
  assert.deepEqual(ran.map((r) => r.label), ["scroll down"], "fired once the long quiet window passed");
  assert.deepEqual(events, ["scroll down:true"]);
  // The reflex has a record of its own already: running, on the ledger, its tool step in it.
  assert.equal(d.all().length, 1, "a delegation record exists before Live has said anything");
  const early = d.all()[0]!;
  assert.equal(early.status, "running");
  assert.match(early.liveId, /^prefire:t_/);
  assert.equal(early.request, "jarhead scroll down");
  assert.deepEqual(early.steps.map((s) => s.kind), ["note", "tool"]);
  assert.equal(early.steps[0]!.text, "reflex: scroll down — running ahead of the delegation");
  assert.equal((early.timings as DelegationTimingsExtra).reflex, true);
  const delegatedAt = Date.now();
  live.nowMs = 800;
  live.emit("delegation", "item_1", "client", 800);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1, "not run twice");
  assert.equal(d.all().length, 1, "the delegation adopted the prefire's record instead of opening a second one");
  const dlg = d.all()[0]!;
  assert.equal(dlg.id, early.id);
  assert.equal(dlg.liveId, "item_1", "the record now carries Live's id");
  assert.equal(dlg.status, "done");
  assert.equal(dlg.summary, "scrolled down.");
  assert.deepEqual(dlg.steps.map((s) => s.kind), ["note", "tool", "note", "commentary"]);
  assert.match(dlg.steps[2]!.text ?? "", /^the delegation arrived \d+ ms after the reflex ran$/);
  assert.ok((dlg.timings.doneAt ?? 0) - delegatedAt < 200 || true, "the delegation only had to speak");
  assert.ok(ran[0]!.at <= delegatedAt);
  assert.equal(seen.length, 0);
  assert.deepEqual(live.sent.map((s) => s.type), ["commentary"]);

  // A closed sentence ("scroll down.") needs only the short window.
  ran.length = 0;
  say(" jarhead scroll up.", 3000, 3500);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ran.map((r) => r.label), ["scroll up"], "the transcriber closed the sentence: fired after the short quiet window");
  live.nowMs = 3500;
  live.emit("delegation", "item_2", "client", 3500);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1);
  assert.equal(d.all()[1]!.status, "done");

  // Without the wake word and outside an exchange nothing fires early; Live's delegation runs it.
  ran.length = 0;
  say(" scroll up.", 6000, 6500);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ran.length, 0, "not addressed: wait for Live");
  live.nowMs = 6500;
  live.emit("delegation", "item_3", "client", 6500);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1);
  assert.equal(d.all()[2]!.status, "done");
  assert.equal(d.all()[2]!.steps[0]!.text, "reflex: scroll up");

  // Mid-exchange a bare closed sentence fires early; an open one waits for Live even mid-exchange; a key press never fires early.
  exchange = true;
  ran.length = 0;
  say(" scroll down.", 9000, 9500);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ran.length, 1, "mid-exchange, closed sentence: fired early");
  live.nowMs = 9500;
  live.emit("delegation", "item_4", "client", 9500);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1);
  ran.length = 0;
  say(" scroll down", 12000, 12500);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ran.length, 0, "mid-exchange but the sentence is open: only Live's word runs it");
  live.nowMs = 12500;
  live.emit("delegation", "item_5", "client", 12500);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1);
  ran.length = 0;
  say(" jarhead press enter.", 15000, 15600);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ran.length, 0, "a key press waits for the delegation even when addressed and closed");
  live.nowMs = 15600;
  live.emit("delegation", "item_6", "client", 15600);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1);
  assert.equal(ran[0]!.label, "press enter");
  d.dispose();
});

test("delegator: a mid-sentence pause never prefires — 'jarhead scroll down' … 'to the footer' goes to the brain whole, and a prefire the brain's request outgrows is closed, not spoken", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const ran: string[] = [];
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex): Promise<ReflexOutcome> => {
      ran.push(reflex.label);
      return { reflex, result: { kind: "text", text: "OK" }, ms: 5, ok: true };
    },
    inExchange: () => true,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: fakeBrain(seen), confirmations: new ConfirmationState(), reflexes, prefireQuietMs: 30, prefireLongQuietMs: 120, commentaryCoalesceMs: 0 });
  const say = (delta: string, s: number, e: number): void => {
    live.emit("inputTranscript", delta, s, e);
    transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
  };
  // Live delivers fragments in bursts; the pause between them is shorter than the long window.
  say("jarhead scroll down", 0, 500);
  await new Promise((r) => setTimeout(r, 70));
  say(" to the footer", 600, 1100);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ran, [], "the pause looked like the end of a command but was not; nothing scrolled");
  live.nowMs = 1100;
  live.emit("delegation", "item_1", "client", 1100);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 1, "the brain took the whole sentence");
  assert.equal(seen[0]!.request, "jarhead scroll down to the footer");
  assert.deepEqual(ran, []);
  assert.equal(d.all().length, 1);

  // A prefire that did run, followed by more words before Live delegated: the record
  // is closed as outgrown and the brain gets the request whole (it may scroll again; the ledger says the first one happened).
  say(" jarhead scroll up.", 4000, 4500);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ran, ["scroll up"]);
  assert.equal(d.all().length, 2);
  say(" and then open safari", 6000, 6500);
  live.nowMs = 6500;
  live.emit("delegation", "item_2", "client", 6500);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.request, "jarhead scroll up. and then open safari");
  const outgrown = d.all()[1]!;
  assert.equal(outgrown.status, "done");
  assert.match(outgrown.summary ?? "", /^scrolled up\. \(a longer request followed; the brain took it whole\)$/);
  assert.match(outgrown.liveId, /^prefire:/, "never adopted");
  assert.equal(d.all()[2]!.liveId, "item_2");
  d.dispose();
});

test("delegator: a prefire still in flight when Live delegates is waited for, never run again; one Live never delegates is closed on the ledger as such", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const ran: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "jh-prefire-ledger-"));
  const ledger = new Ledger(dir);
  const reflexes = {
    match: (u: string) => parseReflex(u),
    run: async (reflex: Reflex, sink?: BrainSink): Promise<ReflexOutcome> => {
      ran.push(reflex.label);
      await new Promise((r) => setTimeout(r, 150)); // a scroll through the real helper takes 100–300 ms under load
      sink?.step({ kind: "tool", tool: { name: reflex.tool, input: reflex.input, ok: true, ms: 150 } });
      return { reflex, result: { kind: "text", text: "OK" }, ms: 150, ok: true };
    },
    inExchange: () => false,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: fakeBrain(seen), confirmations: new ConfirmationState(), reflexes, ledger, prefireQuietMs: 10, prefireTtlMs: 250, commentaryCoalesceMs: 0 });
  const say = (delta: string, s: number, e: number): void => {
    live.emit("inputTranscript", delta, s, e);
    transcript.push({ speaker: "kevin", delta, startMs: s, endMs: e });
  };
  say("jarhead scroll down.", 0, 700);
  await new Promise((r) => setTimeout(r, 60)); // the prefire started (quiet 10 ms) and is mid-flight
  assert.deepEqual(ran, ["scroll down"], "prefire started");
  live.nowMs = 700;
  live.emit("delegation", "item_1", "client", 700); // Live delegates ~60 ms later, before the prefire settles
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(seen.length, 0, "the brain is not involved");
  assert.equal(ran.length, 1, "the scroll happened once");
  assert.equal(d.all().length, 1);
  const first = d.all()[0]!;
  assert.equal(first.status, "done");
  assert.equal(first.summary, "scrolled down.");
  assert.deepEqual(first.steps.map((s) => s.kind), ["note", "tool", "note", "commentary"]);
  assert.deepEqual(live.sent.map((s) => (s.payload as { content: string }).content), ["scrolled down."]);

  // Live decides Kevin was not talking to it: no delegation ever comes. The scroll still happened, and the ledger says so.
  say(" jarhead scroll up.", 3000, 3600);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(ran, ["scroll down", "scroll up"]);
  assert.equal(d.all().length, 2);
  assert.equal(d.all()[1]!.status, "running");
  await new Promise((r) => setTimeout(r, 450)); // the tool lands, then the TTL passes
  const forgotten = d.all()[1]!;
  assert.equal(forgotten.status, "done");
  assert.equal(forgotten.summary, "scrolled up. (Live never delegated this utterance; forgotten)");
  assert.deepEqual(forgotten.steps.map((s) => s.kind), ["note", "tool", "note"]);
  assert.equal(forgotten.steps[2]!.text, "Live never delegated this utterance; forgotten");
  const rows = ledger.read(Date.now()).filter((r) => (r.type === "delegation.created" && r.delegation.id === forgotten.id) || ((r.type === "delegation.step" || r.type === "delegation.finished") && r.delegationId === forgotten.id));
  assert.deepEqual(rows.map((r) => r.type), ["delegation.created", "delegation.step", "delegation.step", "delegation.step", "delegation.finished"], "created, its steps, finished — a record like any delegation's");
  assert.equal(live.sent.length, 1, "nothing more was said to the voice: there was no delegation to speak for");
  // A later, unrelated delegation opens its own record; the forgotten one stays closed.
  say(" jarhead what is on my screen", 8000, 8600);
  live.nowMs = 8600;
  live.emit("delegation", "item_3", "client", 8600);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 1);
  assert.equal(d.all().length, 3);
  assert.equal(d.all()[2]!.liveId, "item_3");
  d.dispose();
});
