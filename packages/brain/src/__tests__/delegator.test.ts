import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator, type DelegationTimingsExtra } from "../delegator.ts";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "../brain.ts";

/**
 * The delegator's latency work: the eyes' pre-warm shot rides as the first
 * attachment without counting as the brain's first tool; commentary bursts are
 * coalesced into one append but the first line of a quiet moment goes at once
 * and the finish flushes; a cancel drops what was held.
 */

class FakeLive extends EventEmitter {
  sent: { type: string; payload: { id: string | null; content: string } }[] = [];
  nowMs = 5000;
  appendThinking(id: string | null, content: string): string { this.sent.push({ type: "thinking", payload: { id, content } }); return "t"; }
  appendCommentary(id: string | null, content: string): string { this.sent.push({ type: "commentary", payload: { id, content } }); return "c"; }
  appendInstructions(id: string | null, content: string): string { this.sent.push({ type: "instructions", payload: { id, content } }); return "i"; }
}

test("delegator: the eyes' shot is the first attachment and never the brain's first tool; commentary is coalesced, first line at once, flushed on finish, dropped on cancel", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  let hold: ((r: BrainResult) => void) | undefined;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task, sink) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        hold = resolve;
        sink.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 18 } });
        sink.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
        sink.commentary("Opening the file.");
        sink.commentary("It is a spreadsheet.");
        sink.commentary("Three tabs.");
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  let clock = 100_000;
  const eyesCalls: number[] = [];
  const eyes = async (sink: BrainSink): Promise<BrainAttachment | undefined> => {
    eyesCalls.push(clock);
    // The engine's runner records the shot in the delegation while the sink is attached.
    sink.step({ kind: "tool", tool: { name: "screenshot", input: { quick: true }, ok: true, ms: 61 }, screenshotPath: "shots/x.png" });
    clock += 61;
    return { path: "/shots/x.png", mediaType: "image/png", note: "the screen right now", kind: "screen" };
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), eyes, now: () => clock, commentaryCoalesceMs: 600 });

  transcript.push({ speaker: "kevin", delta: "open the budget", startMs: 0, endMs: 900 });
  live.emit("delegation", "item_1", "client", 900);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 1);
  assert.equal(eyesCalls.length, 1, "one shot per delegation");
  assert.deepEqual(seen[0]!.attachments?.map((a) => a.kind), ["screen"], "the screen rides as the first attachment");
  const running = d.all()[0]!;
  assert.deepEqual(running.steps.map((s) => `${s.kind}:${s.tool?.name ?? ""}`), ["tool:screenshot", "tool:frontmost_app", "tool:left_click", "commentary:", "commentary:", "commentary:"]);
  const t = running.timings as DelegationTimingsExtra;
  assert.equal(t.eyesMs, 61);
  assert.equal(t.firstToolAt, running.steps[1]!.at, "the brain's frontmost_app is the first tool, not the eyes' shot");
  assert.equal(t.firstActionAt, running.steps[2]!.at, "the click is the first action");
  assert.deepEqual(t.toolRoundTripMs, [18, 7], "the eyes' round trip is kept apart (eyesMs)");

  // Commentary: the first line went out at once; the two that followed within the window are held.
  assert.deepEqual(live.sent.map((s) => s.payload.content), ["Opening the file."]);
  hold!({ status: "done", summary: "Three tabs." });
  await new Promise((r) => setTimeout(r, 20));
  // finish() flushed the held lines as one append; the summary was already spoken (last commentary), so nothing more.
  assert.deepEqual(live.sent.map((s) => s.payload.content), ["Opening the file.", "It is a spreadsheet. Three tabs."]);
  assert.equal(d.all()[0]!.status, "done");

  // A cancel drops held commentary: nothing more is said after "stop".
  live.sent.length = 0;
  clock += 10_000;
  live.nowMs = 3000;
  transcript.push({ speaker: "kevin", delta: " open the other one", startMs: 2500, endMs: 3000 });
  live.emit("delegation", "item_2", "client", 3000);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Opening the file."]);
  await d.cancel("Kevin pressed stop");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Opening the file."], "the held lines were dropped");
  assert.equal(d.all()[1]!.status, "cancelled");
  assert.equal(d.all()[1]!.summary, "Kevin pressed stop");
  assert.ok(live.sent.some((s) => s.type === "instructions" && /cancelled/.test(s.payload.content)));
  d.dispose();
});

test("delegator: narration at the level of intent — the first action is voiced as it lands without the tool's name, per-click lines and lines naming a tool stay on the timeline, state changes and the summary are spoken; announceSleep is one instruction, none while a task runs", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  let hold: ((r: BrainResult) => void) | undefined;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task, sink) =>
      new Promise<BrainResult>((resolve) => {
        hold = resolve;
        sink.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 3 } }); // a look: silent
        sink.step({ kind: "tool", tool: { name: "open_app", input: { name: "Numbers" }, ok: true, ms: 40 } }); // the first action: voiced as it lands
        sink.commentary("Clicking the Invoices tab."); // per click, after something was voiced: timeline only
        sink.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
        sink.commentary("Found the invoice."); // a state change: spoken
        sink.commentary("Pressing Return."); // per click: timeline
        sink.commentary("I will use read_focused_text to check the field."); // names a tool: timeline
        sink.commentary("Typing the amount."); // a state change (not in the per-click list): spoken
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => clock, commentaryCoalesceMs: 0, voiceFirstTool: true });
  assert.equal(Delegator.narrationVerdict("Clicking Save.", false), "speak", "the task's first words pass whatever their shape");
  assert.equal(Delegator.narrationVerdict("Clicking Save.", true), "timeline");
  assert.equal(Delegator.narrationVerdict("Calling click_element on Save.", false), "timeline", "a tool's name never reaches the voice");
  assert.equal(Delegator.narrationVerdict("Renamed my_report.txt.", true), "speak", "Kevin's own identifiers are not tool names");
  assert.equal(Delegator.narrationVerdict("Typed the amount.", true), "speak");
  assert.equal(Delegator.narrationVerdict("Send it to dana@example.com?", true), "speak", "a question is for Kevin");
  assert.equal(Delegator.narrationVerdict('About to run "python edit_file.py". Say yes and I will.', true), "speak", "the handshake's words pass even naming a tool");
  assert.equal(Delegator.narrationVerdict("Pressing Send will post it; confirm.", true), "speak");
  assert.equal(Delegator.narrationVerdict("Calling click_element on Save.", true, true), "speak", "once a confirmation is pending nothing is gated");

  assert.equal(d.announceSleep(5), true);
  assert.deepEqual(live.sent.map((s) => `${s.type}:${s.payload.content}`), ["instructions:Nothing has been said for a while: you are going to sleep in about 5 seconds. Say so in one short clause (\"going to sleep\") and then stay quiet."]);
  assert.equal(d.sleepAnnounced, true);
  assert.equal(d.announceSleep(5), false, "one announcement per idle stretch");
  assert.equal(live.sent.length, 1, "…so the voice is not told twice");
  live.emit("inputTranscript", "file ");
  assert.equal(d.sleepAnnounced, false, "Kevin spoke: the stretch is over");
  assert.equal(d.announceSleep(5), true, "…and the next one announces again");
  live.sent.length = 0;

  transcript.push({ speaker: "kevin", delta: "file the invoice", startMs: 0, endMs: 900 });
  live.emit("delegation", "item_1", "client", 900);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.sleepAnnounced, false, "a task started: the announcement is void");
  assert.equal(d.announceSleep(5), false);
  const spoken = () => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  assert.deepEqual(spoken(), ["Opening Numbers.", "Found the invoice.", "Typing the amount."], "one clause per state change; the first action as it landed");
  assert.equal(live.sent.filter((s) => s.type === "instructions").length, 0, "no sleep announcement while a task runs");
  const running = d.all()[0]!;
  assert.deepEqual(running.steps.filter((s) => s.kind === "commentary").map((s) => s.text), ["Opening Numbers.", "Clicking the Invoices tab.", "Found the invoice.", "Pressing Return.", "I will use read_focused_text to check the field.", "Typing the amount."], "the Console keeps every line");
  hold!({ status: "done", summary: "Filed the invoice under April." });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(spoken().at(-1), "Filed the invoice under April.", "the summary is the answer: never gated");
  assert.equal(d.all()[0]!.status, "done");
  d.dispose();
});

test("delegator: a confirmation question relayed as commentary is spoken even when it names a tool or reads as a click — Kevin has to hear it to answer", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  let hold: ((r: BrainResult) => void) | undefined;
  const question = 'About to run "python edit_file.py" in ~/Documents. It edits a file outside the scratch folders. Ask Kevin to confirm out loud, then stop; do not retry until he says yes.';
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task, sink) =>
      new Promise<BrainResult>((resolve) => {
        hold = resolve;
        sink.step({ kind: "tool", tool: { name: "open_app", input: { name: "Terminal" }, ok: true, ms: 40 } }); // voiced as it lands
        sink.commentary("I will use run_shell for this."); // names a tool, nothing pending: timeline
        sink.step({ kind: "confirm", text: question }); // the runner's needs-confirmation, as responses.ts records it
        sink.commentary("Pressing Return would run python edit_file.py in Documents. Should I?"); // speak_progress relaying the question: spoken
        sink.commentary("Clicking Run needs your yes."); // per click, names nothing, but a confirmation is pending: spoken
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => clock, commentaryCoalesceMs: 0, voiceFirstTool: true });
  transcript.push({ speaker: "kevin", delta: "fix the script", startMs: 0, endMs: 900 });
  live.emit("delegation", "item_1", "client", 900);
  await new Promise((r) => setTimeout(r, 20));
  const spoken = () => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  assert.deepEqual(spoken(), ["Opening Terminal.", "Pressing Return would run python edit_file.py in Documents. Should I?", "Clicking Run needs your yes."], "the question reaches the voice; the tool-naming line before it did not");
  assert.equal(d.all()[0]!.status, "awaiting-confirmation");
  hold!({ status: "done", summary: "Say yes and I will run it." });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spoken().at(-1), "Say yes and I will run it.");
  assert.equal(d.all()[0]!.status, "awaiting-confirmation", "the handshake stays pending for his yes");
  d.dispose();
});
