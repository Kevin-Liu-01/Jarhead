import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator, type DelegationTimingsExtra, type DelegatorWorkers, type WorkerFloor } from "../delegator.ts";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "../brain.ts";
import { parseReflex } from "../reflex.ts";

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

// ------------------------------------------------------------------ workers ---

/**
 * The engine's WorkerPool as the delegator sees it, scripted: how many workers each
 * delegation has alive, a drain the test resolves by hand, who holds the question
 * floor, and what a resume was asked for.
 */
class FakePool implements DelegatorWorkers {
  alive = new Map<string, number>();
  floor: WorkerFloor | undefined;
  resumed: string[] = [];
  drains: Array<{ id: string; resolve: () => void; aborted: boolean }> = [];
  drain(id: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { id, resolve, aborted: false };
      this.drains.push(entry);
      signal.addEventListener("abort", () => { entry.aborted = true; resolve(); }, { once: true });
    });
  }
  running(id?: string): number {
    if (id !== undefined) return this.alive.get(id) ?? 0;
    let n = 0;
    for (const v of this.alive.values()) n += v;
    return n;
  }
  async resume(workerId: string): Promise<void> {
    this.resumed.push(workerId);
  }
  floorLane(): WorkerFloor | undefined {
    return this.floor;
  }
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("workers: the split line is spoken once and counts as the voiced tool; worker steps land on the parent tagged and stamp no marks; a finish line reaches Live exactly once; the parent drains after its brain is done and finishes when the workers do", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  let clock = 100_000;
  let d!: Delegator;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (_task, sink) => {
      const parent = d.active!.id;
      sink.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 9 } });
      // worker_start: the pool registers the worker and speaks the split (as the engine's WorkerAwareRunner does), then the step lands.
      pool.alive.set(parent, 1);
      d.splitLine(parent, "Spotify");
      d.splitLine(parent, "Spotify"); // a second call is not a second line
      sink.step({ kind: "tool", tool: { name: "worker_start", input: { name: "Spotify", task: "play Focus", lane: "background" }, ok: true, ms: 12 } });
      // The main brain's own first action: no "Opening Slack." — the split line was the task's voiced line.
      sink.step({ kind: "tool", tool: { name: "open_app", input: { name: "Slack" }, ok: true, ms: 40 } });
      // The worker acts meanwhile: its steps are the parent's, tagged, and never stamp the parent's marks.
      d.workerStep(parent, "Spotify", { kind: "tool", tool: { name: "applescript", input: { script: 'tell application "Spotify" to play' }, ok: true, ms: 900 } });
      d.workerStep(parent, "Spotify", { kind: "thinking", text: "playing it" });
      return { status: "done", summary: "Sent." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), workers: pool, now: () => ++clock, commentaryCoalesceMs: 0, voiceFirstTool: true });
  const phases: string[] = [];
  d.on("phase", (p) => phases.push(p));
  transcript.push({ speaker: "kevin", delta: "tell ben on slack i'm late and play focus on spotify", startMs: 0, endMs: 2000 });
  live.nowMs = 2000;
  live.emit("delegation", "item_1", "client", 2000);
  await tick();
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  assert.deepEqual(spoken(), ["Spotify alongside.", "Sent."], "one split line, then the summary; the first-tool line did not follow the split");
  const parent = d.all()[0]!;
  assert.equal(parent.status, "running", "the brain is done but a hand is not: the delegation drains, still open");
  assert.equal(d.draining?.id, parent.id);
  assert.equal(d.active?.id, parent.id, "active = running ?? draining");
  assert.ok(parent.steps.some((s) => s.kind === "note" && /the brain is done; 1 hand still working; draining/.test(s.text ?? "")), parent.steps.map((s) => s.text).join(" | "));
  assert.deepEqual(parent.steps.filter((s) => s.worker).map((s) => `${s.worker}:${s.kind}:${s.tool?.name ?? s.text}`), ["Spotify:tool:applescript", "Spotify:thinking:playing it"], "worker steps carry the worker's name");
  const t = parent.timings as DelegationTimingsExtra;
  assert.equal(t.firstActionAt, parent.steps.find((s) => s.tool?.name === "open_app")!.at, "the main brain's open_app is the first action, not the worker's applescript");
  assert.deepEqual(t.toolRoundTripMs, [9, 12, 40], "the worker's 900 ms round trip is not the main brain's");
  assert.ok(!phases.includes("idle"), "not idle while draining");
  assert.equal(d.announceSleep(5), false, "a draining delegation is not idle");

  // The worker finishes: its one line, through the parent, exactly once — while the parent's brain is long gone.
  d.workerSay(parent.id, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(spoken(), ["Spotify alongside.", "Sent.", "Spotify: playing Focus."]);
  assert.deepEqual(d.all()[0]!.steps.filter((s) => s.kind === "commentary" && s.worker).map((s) => s.text), ["Spotify: playing Focus."]);
  assert.equal(pool.drains.length, 1);
  pool.alive.set(parent.id, 0);
  pool.drains[0]!.resolve();
  await tick();
  assert.equal(d.all()[0]!.status, "done");
  assert.equal(d.all()[0]!.summary, "Sent.");
  assert.equal(d.active, undefined);
  assert.equal(d.draining, undefined);
  assert.equal(phases.at(-1), "idle");
  assert.equal(spoken().length, 3, "nothing more was said at the finish");
  // A line for a delegation that is neither running nor draining goes nowhere.
  d.workerSay(parent.id, "Spotify", "late");
  d.workerStep(parent.id, "Spotify", { kind: "note", text: "late" });
  assert.equal(spoken().length, 3);
  assert.equal(d.all()[0]!.steps.filter((s) => s.text === "late").length, 0);
  d.dispose();
});

test("workers: two finish lines inside the coalesce window become one append; the fallback channel tells the voice to say the line now", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  let clock = 100_000;
  let d!: Delegator;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async () => {
      pool.alive.set(d.active!.id, 2);
      return { status: "done", summary: "Both started." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), workers: pool, now: () => clock, commentaryCoalesceMs: 50 });
  transcript.push({ speaker: "kevin", delta: "do both", startMs: 0, endMs: 900 });
  live.nowMs = 900;
  live.emit("delegation", "item_1", "client", 900);
  await tick();
  const id = d.all()[0]!.id;
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  assert.deepEqual(spoken(), ["Both started."]);
  d.workerSay(id, "Spotify", "Spotify: playing Focus.");
  d.workerSay(id, "Slack", "Slack: sent.");
  assert.deepEqual(spoken(), ["Both started."], "held: within the window of the summary");
  await tick(120);
  assert.deepEqual(spoken(), ["Both started.", "Spotify: playing Focus. Slack: sent."], "one append for the two");
  pool.alive.set(id, 0);
  pool.drains[0]!.resolve();
  await tick();
  assert.equal(d.all()[0]!.status, "done");

  // JARHEAD_WORKER_SAY=instructions: the probe's fallback — the voice is told to say it now.
  const live2 = new FakeLive();
  const pool2 = new FakePool();
  let d2!: Delegator;
  const brain2: Brain = { ...brain, handle: async () => { pool2.alive.set(d2.active!.id, 1); return { status: "done" }; } };
  d2 = new Delegator({ live: live2 as unknown as LiveSession, transcript: new Transcript(() => 0), brain: brain2, confirmations: new ConfirmationState(), workers: pool2, now: () => clock, commentaryCoalesceMs: 0, workerSayChannel: "instructions" });
  live2.emit("delegation", "item_9", "client", 900);
  await tick();
  d2.workerSay(d2.all()[0]!.id, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(live2.sent.map((s) => `${s.type}:${s.payload.id}:${s.payload.content}`), ['instructions:null:A hand finished. Tell Kevin now in one short sentence: "Spotify: playing Focus.". Then wait.']);
  d.dispose();
  d2.dispose();
});

test("workers: a new request parks the running parent as draining instead of cancelling its workers; a yes while a worker holds the floor resumes that worker and supersedes nothing; stop is heard while only workers run; a cut cancels the draining parent too", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  const confirmations = new ConfirmationState();
  let clock = 100_000;
  let d!: Delegator;
  const holds: Array<(r: BrainResult) => void> = [];
  let cancels = 0;
  const seen: BrainTask[] = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        holds.push(resolve);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      cancels++;
    },
    stop: async () => undefined,
  };
  const stops: string[] = [];
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, workers: pool, now: () => ++clock, commentaryCoalesceMs: 0, onStop: (reason) => stops.push(reason) });

  // 1. The parent: its brain starts a worker and keeps going.
  transcript.push({ speaker: "kevin", delta: "tell ben on slack i'm late and play focus on spotify", startMs: 0, endMs: 2000 });
  live.nowMs = 2000;
  live.emit("delegation", "item_1", "client", 2000);
  await tick();
  const parentId = d.active!.id;
  pool.alive.set(parentId, 1);
  d.splitLine(parentId, "Spotify");

  // 2. Kevin asks for something else while the brain runs: that turn ends, the worker carries on under the parked record.
  transcript.push({ speaker: "kevin", delta: " what time is it", startMs: 5000, endMs: 5800 });
  live.nowMs = 5800;
  live.emit("delegation", "item_2", "client", 5800);
  await tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.request, "what time is it", "the request window moved past the parked parent's words");
  assert.equal(cancels, 1, "the brain's turn was cancelled");
  assert.equal(d.active?.id, d.all()[1]!.id, "the new request runs");
  assert.equal(d.draining?.id, parentId, "the parent drains");
  assert.equal(d.all()[0]!.status, "running", "still open on the timeline");
  assert.ok(d.all()[0]!.steps.some((s) => s.kind === "note" && /Kevin asked something else; the workers carry on; draining/.test(s.text ?? "")));
  assert.equal(pool.drains.length, 1);
  assert.equal(pool.drains[0]!.aborted, false, "the supersede did not abort the drain: only a cut verb ends workers");
  // The worker's line still lands on the parked parent.
  d.workerSay(parentId, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Spotify alongside.", "Spotify: playing Focus."]);

  // 3. A worker asks (the desk put its question on the root); Kevin says yes: the yes is armed for that worker
  //    and it resumes — the running turn ("what time is it") is untouched.
  confirmations.ask("send the message in Slack", "click_element", { name: "Send" });
  pool.floor = { id: "w_slack", name: "Slack" };
  pool.alive.set(parentId, 2);
  transcript.push({ speaker: "kevin", delta: " yes", startMs: 9000, endMs: 9300 });
  live.nowMs = 9300;
  live.emit("delegation", "item_3", "client", 9300);
  await tick();
  assert.deepEqual(pool.resumed, ["w_slack"]);
  assert.equal(seen.length, 2, "no brain task for the yes");
  assert.equal(cancels, 1, "the running turn was not superseded");
  assert.equal(d.active?.id, d.all()[1]!.id, "…and still runs");
  const relay = d.all()[2]!;
  assert.equal(relay.status, "done");
  assert.equal(relay.summary, "relayed the yes to Slack");
  assert.equal(relay.request, "yes");
  assert.ok(relay.steps.some((s) => s.worker === "Slack" && /yes for Slack's question/.test(s.text ?? "")));
  assert.equal(confirmations.consume("click_element", { name: "Send" }), true, "the yes was armed on the root for the worker's exact action");
  pool.floor = undefined;

  // 4. The running turn finishes with no workers of its own: done; the parent still drains, so nothing is idle.
  const phases: string[] = [];
  d.on("phase", (p) => phases.push(p));
  holds[1]!({ status: "done", summary: "Three o'clock." });
  await tick();
  assert.equal(d.all()[1]!.status, "done");
  assert.equal(d.active?.id, parentId, "the draining parent is what is active now");
  assert.ok(!phases.includes("idle"));
  assert.equal(d.announceSleep(5), false);

  // 5. "stop" while only workers run reaches the engine's stop, as it does while a brain runs.
  live.emit("inputTranscript", " stop");
  await tick();
  assert.deepEqual(stops, ["Kevin said stop"]);

  // 6. The cut: the draining parent is cancelled too, its drain wait ends, nothing more is said for it.
  d.workerSay(parentId, "Spotify", "late line");
  await d.cancel("Kevin said stop", { quiet: true });
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "Kevin said stop");
  assert.equal(pool.drains[0]!.aborted, true, "the cut ended the wait");
  assert.equal(d.active, undefined);
  assert.equal(d.draining, undefined);
  assert.equal(phases.at(-1), "idle");
  assert.equal(cancels, 1, "no brain turn was running: nothing to cancel there");
  assert.ok(!live.sent.some((s) => s.type === "instructions"), "quiet: the engine speaks for the stop");
  await tick();
  assert.equal(d.all()[0]!.status, "cancelled", "the drain resolving after the cut changes nothing");
  d.dispose();
});

test("workers: without a pool nothing changes — a new request supersedes as before, and the worker methods are inert", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  let cancels = 0;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task) => new Promise<BrainResult>((resolve) => task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })),
    cancel: async () => {
      cancels++;
    },
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), commentaryCoalesceMs: 0 });
  transcript.push({ speaker: "kevin", delta: "open slack", startMs: 0, endMs: 900 });
  live.nowMs = 900;
  live.emit("delegation", "item_1", "client", 900);
  await tick();
  const id = d.active!.id;
  d.splitLine(id, "Spotify");
  d.workerSay(id, "Spotify", "Spotify: done.");
  transcript.push({ speaker: "kevin", delta: " open safari", startMs: 3000, endMs: 3800 });
  live.nowMs = 3800;
  live.emit("delegation", "item_2", "client", 3800);
  await tick();
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "superseded by a new request");
  assert.equal(d.draining, undefined, "no workers: nothing drains");
  assert.equal(cancels, 1);
  // The lines were spoken while it ran (they are Jarhead's own), then the supersede dropped nothing more.
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Spotify alongside.", "Spotify: done."]);
  await d.cancel("done", { quiet: true });
  d.dispose();
});

// -------------------------------------------------------------------- sleep ---

test("sleep cue: a dismissal through Live goes to onSleep with Kevin's words, before anything running is superseded, and never to the brain; judged on the whole request, or on an addressed last utterance after room talk — never on a bare closer behind a task; a look-alike command keeps its own path; without onSleep the words are the brain's", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  let clock = 100_000;
  const seen: BrainTask[] = [];
  let cancels = 0;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      cancels++;
    },
    stop: async () => undefined,
  };
  const slept: string[] = [];
  let d!: Delegator;
  // The engine's fallAsleep: the sleep row, the cut (which cancels the delegator), the close.
  const onSleep = (phrase: string): void => {
    slept.push(phrase);
    void d.cancel("going to sleep", { quiet: true });
  };
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => ++clock, commentaryCoalesceMs: 0, onSleep, reflexes: { match: (u) => parseReflex(u), run: async (reflex) => ({ reflex, result: { kind: "text", text: "OK" }, ms: 1, ok: true }) } });

  // A task runs; Kevin dismisses Jarhead mid-task.
  transcript.push({ speaker: "kevin", delta: "open slack and find ben", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  assert.equal(seen.length, 1);
  transcript.push({ speaker: "kevin", delta: " Jarhead, go to sleep.", startMs: 6000, endMs: 6900 });
  live.nowMs = 6900;
  live.emit("delegation", "item_2", "client", 6900);
  await tick();
  assert.deepEqual(slept, ["Jarhead, go to sleep."], "Kevin's words, as heard, for the sleep row");
  assert.equal(seen.length, 1, "the cue never reached the brain");
  const cue = d.all()[1]!;
  assert.equal(cue.status, "done");
  assert.equal(cue.summary, "going to sleep");
  assert.equal(cue.request, "Jarhead, go to sleep.");
  assert.equal((cue.timings as DelegationTimingsExtra).reflex, true, "grammar-answered, like a reflex");
  assert.ok(cue.steps.some((s) => s.kind === "note" && /sleep cue: "Jarhead, go to sleep\."/.test(s.text ?? "")));
  // The engine's cut, not a supersede, ended the running task.
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "going to sleep");
  assert.equal(cancels, 1);
  assert.ok(!live.sent.some((s) => s.type === "commentary"), "the delegator says nothing for a dismissal: the engine's farewell is the word");

  // Room talk before an ADDRESSED cue is context, not a reason to miss it: the last utterance names Jarhead.
  transcript.push({ speaker: "kevin", delta: " what a day", startMs: 20_000, endMs: 20_700 });
  transcript.push({ speaker: "kevin", delta: " jarhead, that will be all, thanks", startMs: 23_000, endMs: 24_000 });
  live.nowMs = 24_000;
  live.emit("delegation", "item_3", "client", 24_000);
  await tick();
  assert.deepEqual(slept.at(-1), "jarhead, that will be all, thanks");
  assert.equal(seen.length, 1);

  // A command that shares a word is not a cue: "go to slack" is the open_app reflex, "turn off the lights" the brain's.
  transcript.push({ speaker: "kevin", delta: " jarhead go to slack", startMs: 30_000, endMs: 30_800 });
  live.nowMs = 30_800;
  live.emit("delegation", "item_4", "client", 30_800);
  await tick();
  assert.equal(slept.length, 2);
  assert.equal(d.all()[3]!.summary, "opened Slack.", "the open_app reflex, as before");
  transcript.push({ speaker: "kevin", delta: " turn off the lights", startMs: 40_000, endMs: 40_800 });
  live.nowMs = 40_800;
  live.emit("delegation", "item_5", "client", 40_800);
  await tick();
  assert.equal(slept.length, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.request, "turn off the lights", "a task for the brain");
  await d.cancel("done", { quiet: true });

  // Nothing running. A real request and then a bare closer as a second breath, delegated together:
  // the brain gets it WHOLE. Judged on the last utterance alone this slept Jarhead and dropped Ben's
  // message. (While a task runs the window starts at Live's now and carries the last utterance only —
  // f6c3b40's rule, untouched here.)
  transcript.push({ speaker: "kevin", delta: " jarhead send ben a message that i'm running late", startMs: 50_000, endMs: 52_000 });
  transcript.push({ speaker: "kevin", delta: " that's all", startMs: 53_800, endMs: 54_400 });
  assert.equal(transcript.since(49_000, "kevin").length, 2, "two utterances (the gap is past the merge window)");
  live.nowMs = 54_400;
  live.emit("delegation", "item_6", "client", 54_400);
  await tick();
  assert.equal(slept.length, 2, "no sleep for a closer that rides behind a task");
  assert.equal(seen.length, 3);
  assert.equal(seen[2]!.request, "jarhead send ben a message that i'm running late that's all", "the task, closer included, is the brain's");
  assert.equal(d.all().at(-1)!.status, "running");
  await d.cancel("done", { quiet: true });
  d.dispose();

  // Without onSleep wired, a dismissal is the brain's like any other request (the reflex table never runs it).
  const live2 = new FakeLive();
  const transcript2 = new Transcript(() => 0);
  const seen2: BrainTask[] = [];
  const brain2: Brain = { ...brain, handle: async (task) => { seen2.push(task); return { status: "done" }; } };
  const d2 = new Delegator({ live: live2 as unknown as LiveSession, transcript: transcript2, brain: brain2, confirmations: new ConfirmationState(), reflexes: { match: (u) => new ReflexRunnerLike().match(u), run: async (reflex) => ({ reflex, result: { kind: "text", text: "OK" }, ms: 1, ok: true }) } });
  transcript2.push({ speaker: "kevin", delta: "go to sleep", startMs: 0, endMs: 700 });
  live2.emit("delegation", "item_1", "client", 700);
  await tick();
  assert.equal(seen2[0]?.request, "go to sleep");
  d2.dispose();
});

test("sleep cue: a dismissal while only a draining delegation exists goes to onSleep; the engine's cut then closes the draining record as cancelled and nothing more is said for it", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  let clock = 100_000;
  let d!: Delegator;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async () => {
      pool.alive.set(d.active!.id, 1);
      return { status: "done", summary: "Started." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const slept: string[] = [];
  const onSleep = (phrase: string): void => {
    slept.push(phrase);
    void d.cancel("going to sleep", { quiet: true });
  };
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), workers: pool, now: () => ++clock, commentaryCoalesceMs: 0, onSleep });
  const phases: string[] = [];
  d.on("phase", (p) => phases.push(p));
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  transcript.push({ speaker: "kevin", delta: "play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  const a = d.all()[0]!.id;
  assert.equal(d.draining?.id, a, "brain done, one hand working: draining, nothing running");
  assert.equal(d.active?.id, a);

  transcript.push({ speaker: "kevin", delta: " jarhead go to sleep", startMs: 6000, endMs: 6900 });
  live.nowMs = 6900;
  live.emit("delegation", "item_2", "client", 6900);
  await tick();
  assert.deepEqual(slept, ["jarhead go to sleep"]);
  assert.equal(d.all()[1]!.status, "done");
  assert.equal(d.all()[1]!.summary, "going to sleep");
  assert.equal(d.all()[0]!.status, "cancelled", "the engine's cut closed the draining record");
  assert.equal(d.all()[0]!.summary, "going to sleep");
  assert.equal(pool.drains[0]!.aborted, true, "the cut ended the drain wait");
  assert.equal(d.active, undefined);
  assert.equal(d.draining, undefined);
  assert.equal(phases.at(-1), "idle");
  assert.deepEqual(spoken(), ["Started."], "nothing spoken for the cue or the cut: the engine's farewell is the word");
  d.workerSay(a, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(spoken(), ["Started."], "a late line for the cancelled parent goes nowhere");
  d.dispose();
});

test("workers: park over park — a second parent parked while an older one drains leaves the older one draining; each closes only when its own hands are done, each finish line is spoken once, idle only when the last has drained", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  let clock = 100_000;
  const holds: Array<(r: BrainResult) => void> = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        holds.push(resolve);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), workers: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
  const phases: string[] = [];
  d.on("phase", (p) => phases.push(p));
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);

  // A: its brain starts Spotify and finishes; A drains.
  transcript.push({ speaker: "kevin", delta: "play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  const a = d.active!.id;
  pool.alive.set(a, 1);
  d.splitLine(a, "Spotify");
  holds[0]!({ status: "done", summary: "A done." });
  await tick();
  assert.equal(d.draining?.id, a);
  assert.equal(pool.drains.length, 1);

  // B: its brain starts Slack (the pool is at WORKER_MAX) and is still running when…
  transcript.push({ speaker: "kevin", delta: " tell ben i'm late", startMs: 5000, endMs: 5800 });
  live.nowMs = 5800;
  live.emit("delegation", "item_2", "client", 5800);
  await tick();
  const b = d.active!.id;
  assert.notEqual(b, a);
  pool.alive.set(b, 1);
  d.splitLine(b, "Slack");

  // …Kevin asks a third thing: B parks. A is NOT closed over it — its hand is still working.
  transcript.push({ speaker: "kevin", delta: " what time is it", startMs: 9000, endMs: 9600 });
  live.nowMs = 9600;
  live.emit("delegation", "item_3", "client", 9600);
  await tick();
  const c = d.active!.id;
  assert.deepEqual(d.all().map((x) => x.status), ["running", "running", "running"]);
  assert.equal(d.draining?.id, b, "the newest draining delegation is the one the engine compares with `active`");
  assert.equal(pool.drains.length, 2, "both drains are waited for");
  assert.equal(pool.drains[0]!.aborted, false);
  assert.ok(!d.all()[0]!.steps.some((s) => /parked over/.test(s.text ?? "")), "no 'parked over it': A keeps its record");

  // A's worker finishes: its one line, on A, exactly once; its late steps still land on A.
  d.workerSay(a, "Spotify", "Spotify: playing Focus.");
  d.workerStep(a, "Spotify", { kind: "note", text: "wrapping up" });
  assert.deepEqual(spoken(), ["Spotify alongside.", "A done.", "Slack alongside.", "Spotify: playing Focus."]);
  assert.ok(d.all()[0]!.steps.some((s) => s.worker === "Spotify" && s.text === "wrapping up"));
  pool.alive.set(a, 0);
  pool.drains[0]!.resolve();
  await tick();
  assert.equal(d.all()[0]!.status, "done", "A closes when ITS drain resolves");
  assert.equal(d.all()[0]!.summary, "A done.");
  assert.equal(d.all()[1]!.status, "running", "B still drains");
  assert.equal(d.active?.id, c);
  assert.ok(!phases.includes("idle"));

  // C finishes with no hands of its own: B is what is active until Slack is done.
  holds[2]!({ status: "done", summary: "Three o'clock." });
  await tick();
  assert.equal(d.all()[2]!.status, "done");
  assert.equal(d.active?.id, b);
  assert.equal(d.draining?.id, b);
  assert.ok(!phases.includes("idle"), "not idle while B drains");
  assert.equal(d.announceSleep(5), false);
  d.workerSay(b, "Slack", "Slack: sent.");
  pool.alive.set(b, 0);
  pool.drains[1]!.resolve();
  await tick();
  assert.equal(d.all()[1]!.status, "cancelled", "B's own turn was cut by the third request; the record says so");
  assert.equal(d.all()[1]!.summary, "Kevin asked something else; the workers carried on");
  assert.deepEqual(spoken(), ["Spotify alongside.", "A done.", "Slack alongside.", "Spotify: playing Focus.", "Three o'clock.", "Slack: sent."], "every finish line once, none lost");
  assert.equal(d.active, undefined);
  assert.equal(d.draining, undefined);
  assert.equal(phases.at(-1), "idle");
  assert.equal(phases.filter((p) => p === "idle").length, 1, "idle once, at the very end");
  d.dispose();
});

test("workers: a yes while the pool names a floor worker but the root holds no question (dropped, or past its TTL) is no relay — it supersedes the running turn and the brain gets the word like any request", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  const confirmations = new ConfirmationState();
  let clock = 100_000;
  let cancels = 0;
  const seen: BrainTask[] = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      cancels++;
    },
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, workers: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
  transcript.push({ speaker: "kevin", delta: "tell ben i'm late", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  // The desk's floor still points at Slack's question, but the root has none (the pending was dropped or expired).
  pool.floor = { id: "w_slack", name: "Slack" };
  assert.equal(confirmations.pending, undefined);
  transcript.push({ speaker: "kevin", delta: " yes", startMs: 5000, endMs: 5300 });
  live.nowMs = 5300;
  live.emit("delegation", "item_2", "client", 5300);
  await tick();
  assert.deepEqual(pool.resumed, [], "nothing to arm: no worker is resumed on a stale floor");
  assert.equal(cancels, 1, "today's path: the running turn is superseded");
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "superseded by a new request");
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.request, "yes");
  assert.equal(seen[1]!.confirmation, false, "a yes with nothing pending is words for the brain, not an armed confirmation");
  await d.cancel("done", { quiet: true });
  d.dispose();
});

test("workers: a worker's question through workerStep is the worker's — the parent's status never flips to awaiting-confirmation and the main brain's per-click lines stay gated; the parent closes done", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  let clock = 100_000;
  let d!: Delegator;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (_task, sink) => {
      const parent = d.active!.id;
      sink.step({ kind: "tool", tool: { name: "open_app", input: { name: "Slack" }, ok: true, ms: 40 } }); // voiced as it lands
      pool.alive.set(parent, 1);
      d.workerStep(parent, "Spotify", { kind: "confirm", text: "play the playlist Focus? Ask Kevin to confirm out loud." });
      assert.equal(d.all()[0]!.status, "running", "a worker's confirm step does not flip the parent");
      sink.commentary("Clicking Send."); // per click after something was voiced: gated — a worker's question lifts no gate
      sink.commentary("Found Ben."); // a state change: spoken
      return { status: "done", summary: "Sent." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), workers: pool, now: () => ++clock, commentaryCoalesceMs: 0, voiceFirstTool: true });
  transcript.push({ speaker: "kevin", delta: "tell ben i'm late and play focus", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  assert.deepEqual(spoken(), ["Opening Slack.", "Found Ben.", "Sent."], "the per-click line stayed on the timeline");
  const parent = d.all()[0]!;
  assert.equal(parent.status, "running", "draining, not awaiting-confirmation");
  assert.deepEqual(parent.steps.filter((s) => s.kind === "confirm").map((s) => s.worker), ["Spotify"], "the question is on the timeline, tagged as the worker's");
  pool.alive.set(parent.id, 0);
  pool.drains[0]!.resolve();
  await tick();
  assert.equal(d.all()[0]!.status, "done", "a worker's pending question is the worker's, never the parent's awaiting-confirmation");
  d.dispose();
});

test("parkRunning: parking a running turn by hand ends it — the turn's signal is aborted and the brain's cancel awaited, its later result is discarded for the given one, and the record closes with that when the hands drain", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakePool();
  let clock = 100_000;
  let cancels = 0;
  let aborted = false;
  const holds: Array<(r: BrainResult) => void> = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    // Settles only by hand: a brain that reports after its turn was parked.
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        holds.push(resolve);
        task.signal.addEventListener("abort", () => (aborted = true), { once: true });
      }),
    cancel: async () => {
      cancels++;
    },
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), workers: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
  await d.parkRunning("nothing runs");
  assert.equal(d.all().length, 0, "nothing to park: a no-op");
  transcript.push({ speaker: "kevin", delta: "play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  const id = d.active!.id;
  pool.alive.set(id, 1);
  await d.parkRunning("the engine ended the turn", { status: "done", summary: "Parked." });
  assert.equal(aborted, true, "the turn's signal was aborted");
  assert.equal(cancels, 1, "…and the brain's cancel awaited");
  assert.equal(d.draining?.id, id);
  assert.equal(d.active?.id, id, "nothing runs; it drains");
  assert.ok(d.all()[0]!.steps.some((s) => s.kind === "note" && s.text === "the engine ended the turn; draining"));
  // The brain reports late: discarded — not spoken, not the record's summary.
  holds[0]!({ status: "done", summary: "The brain's summary." });
  await tick();
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary"), [], "a parked turn's late summary is never spoken");
  assert.equal(d.all()[0]!.status, "running");
  pool.alive.set(id, 0);
  pool.drains[0]!.resolve();
  await tick();
  assert.equal(d.all()[0]!.status, "done");
  assert.equal(d.all()[0]!.summary, "Parked.", "the given result, not the brain's");
  assert.equal(d.active, undefined);
  d.dispose();
});

/** The engine's `matchReflex` shape: `ReflexRunner.match` leaves the sleep cue out, so nothing runs it as a tool. */
class ReflexRunnerLike {
  match(u: string) {
    const r = parseReflex(u);
    return r?.kind === "sleep" ? undefined : r;
  }
}
