import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { Delegator, NAMED_STOP_FRAGMENT_ECHO_MS, STOP_NAME_WAIT_MS, type DelegationTimingsExtra, type DelegatorThreads, type ThreadFloor } from "../delegator.ts";
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
  const question = 'About to run "python edit_file.py" in ~/Documents. It edits a file outside the scratch folders. Ask Kevin to confirm out loud, then stop; do not retry until Kevin says yes.';
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

// ------------------------------------------------------------------ threads ---

/**
 * The engine's threads (the table and the scheduler) as the delegator sees them, scripted:
 * the live names for the grammar, how many spawned threads each delegation has alive, a
 * drain the test resolves by hand, who holds the question floor, what a resume was asked
 * for, and what the verbs did. `new FakeThreads([])` is an engine with no thread live.
 */
class FakeThreads implements DelegatorThreads {
  names: string[];
  stopped: string[] = [];
  paused: string[] = [];
  followUps: { id: string; request: string; items: number; marks: number }[] = [];
  /** The overflow rule's hooks (Settings.threadOverflow = "spawn"): what was spawned, and which apps a live thread claims. */
  spawned: { parent: string; name: string; task: string }[] = [];
  claimed: string[] = [];
  mode: "supersede" | "spawn" = "supersede";
  alive = new Map<string, number>();
  floor: ThreadFloor | undefined;
  resumed: string[] = [];
  drains: Array<{ id: string; resolve: () => void; aborted: boolean }> = [];
  constructor(names: string[] = ["Spotify", "Slack"]) {
    this.names = names;
  }
  liveNames(): readonly string[] {
    return this.names;
  }
  /** The ones stopped here still answer to their name for a while (the table's linger). */
  recentNames(): readonly string[] {
    return this.stopped;
  }
  overflow(): "supersede" | "spawn" {
    return this.mode;
  }
  appClaimed(app: string): boolean {
    return this.claimed.some((a) => a.toLowerCase() === app.toLowerCase());
  }
  spawn(parent: string, name: string, task: string): boolean {
    this.spawned.push({ parent, name, task });
    this.names.push(name);
    return true;
  }
  byNameLive(name: string): { readonly id: string; readonly name: string } | undefined {
    const n = this.names.find((x) => x.toLowerCase() === name.toLowerCase());
    return n ? { id: `t_${n.toLowerCase()}`, name: n } : undefined;
  }
  statusLine(name?: string): string {
    return name ? `${name} is working — 3 seconds in` : `Two threads: ${this.names.join(" working, ")} working`;
  }
  async followUp(id: string, request: string, o: { readonly items?: readonly unknown[] | undefined; readonly marks?: readonly unknown[] | undefined }): Promise<boolean> {
    this.followUps.push({ id, request, items: o.items?.length ?? 0, marks: o.marks?.length ?? 0 });
    return true;
  }
  async stopNamed(name: string): Promise<boolean> {
    if (!this.byNameLive(name)) return false;
    this.stopped.push(name);
    this.names = this.names.filter((n) => n.toLowerCase() !== name.toLowerCase());
    return true;
  }
  floorThread(): ThreadFloor | undefined {
    return this.floor;
  }
  async pauseNamed(name: string): Promise<boolean> {
    this.paused.push(name);
    return this.byNameLive(name) !== undefined;
  }
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
  async resume(threadId: string): Promise<void> {
    this.resumed.push(threadId);
  }
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("threads: the split line is spoken once and counts as the voiced tool; a finish line reaches Live exactly once; the parent drains after its brain is done and finishes when the threads do", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
  let clock = 100_000;
  let d!: Delegator;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (_task, sink) => {
      const parent = d.active!.id;
      sink.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 9 } });
      // thread_start: the scheduler admits the thread and speaks the split (as the engine's lane runner does), then the step lands.
      pool.alive.set(parent, 1);
      d.splitLine(parent, "Spotify");
      d.splitLine(parent, "Spotify"); // a second call is not a second line
      sink.step({ kind: "tool", tool: { name: "thread_start", input: { name: "Spotify", task: "play Focus", lane: "background" }, ok: true, ms: 12 } });
      // The main brain's own first action: no "Opening Slack." — the split line was the task's voiced line.
      sink.step({ kind: "tool", tool: { name: "open_app", input: { name: "Slack" }, ok: true, ms: 40 } });
      return { status: "done", summary: "Sent." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads: pool, now: () => ++clock, commentaryCoalesceMs: 0, voiceFirstTool: true });
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
  const t = parent.timings as DelegationTimingsExtra;
  assert.equal(t.firstActionAt, parent.steps.find((s) => s.tool?.name === "open_app")!.at, "the main brain's open_app is the first action; thread_start is a silent tool");
  assert.deepEqual(t.toolRoundTripMs, [9, 12, 40]);
  assert.ok(!phases.includes("idle"), "not idle while draining");
  assert.equal(d.announceSleep(5), false, "a draining delegation is not idle");

  // The thread finishes: its one line, through the parent, exactly once — while the parent's brain is long gone.
  d.threadSay(parent.id, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(spoken(), ["Spotify alongside.", "Sent.", "Spotify: playing Focus."]);
  assert.deepEqual(d.all()[0]!.steps.filter((s) => s.kind === "commentary" && s.thread).map((s) => `${s.thread}: ${s.text}`), ["Spotify: Spotify: playing Focus."], "the line is on the timeline, tagged with the thread's name");
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
  // A thread's line for a parent that finished DONE is still owed to Kevin: it lands on the kept record and
  // reaches Live on the append id that record had — never dropped.
  d.threadSay(parent.id, "Spotify", "late");
  await tick();
  assert.deepEqual(spoken().slice(3), ["late"], "spoken once, after the slot closed");
  assert.equal(live.sent.filter((s) => s.type === "commentary").at(-1)?.payload.id, "item_1", "on the parent's own Live id");
  assert.equal(d.all()[0]!.steps.filter((s) => s.kind === "commentary" && s.text === "late").length, 1, "on the parent's record");
  d.dispose();
});

test("threads: two finish lines inside the coalesce window become one append", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
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
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads: pool, now: () => clock, commentaryCoalesceMs: 50 });
  transcript.push({ speaker: "kevin", delta: "do both", startMs: 0, endMs: 900 });
  live.nowMs = 900;
  live.emit("delegation", "item_1", "client", 900);
  await tick();
  const id = d.all()[0]!.id;
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  assert.deepEqual(spoken(), ["Both started."]);
  d.threadSay(id, "Spotify", "Spotify: playing Focus.");
  d.threadSay(id, "Slack", "Slack: sent.");
  assert.deepEqual(spoken(), ["Both started."], "held: within the window of the summary");
  await tick(120);
  assert.deepEqual(spoken(), ["Both started.", "Spotify: playing Focus. Slack: sent."], "one append for the two");
  assert.ok(!live.sent.some((s) => s.type === "instructions"), "commentary is the one channel a thread's line takes");
  pool.alive.set(id, 0);
  pool.drains[0]!.resolve();
  await tick();
  assert.equal(d.all()[0]!.status, "done");
  d.dispose();
});

test("threads: a new request parks the running parent as draining instead of cancelling its threads; a yes while a thread holds the floor resumes that thread and supersedes nothing (main's own floor is no relay); stop is heard while only threads run; a cut cancels the draining parent too", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
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
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, threads: pool, now: () => ++clock, commentaryCoalesceMs: 0, onStop: (reason) => stops.push(reason) });

  // 1. The parent: its brain starts a thread and keeps going.
  transcript.push({ speaker: "kevin", delta: "tell ben on slack i'm late and play focus on spotify", startMs: 0, endMs: 2000 });
  live.nowMs = 2000;
  live.emit("delegation", "item_1", "client", 2000);
  await tick();
  const parentId = d.active!.id;
  pool.alive.set(parentId, 1);
  d.splitLine(parentId, "Spotify");

  // 2. Kevin asks for something else while the brain runs: that turn ends, the thread carries on under the parked record.
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
  assert.ok(d.all()[0]!.steps.some((s) => s.kind === "note" && /Kevin asked something else; the threads carry on; draining/.test(s.text ?? "")));
  assert.equal(pool.drains.length, 1);
  assert.equal(pool.drains[0]!.aborted, false, "the supersede did not abort the drain: only a cut verb ends threads");
  // The thread's line still lands on the parked parent.
  d.threadSay(parentId, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content), ["Spotify alongside.", "Spotify: playing Focus."]);

  // 3. A thread asks (the desk put its question on the root); Kevin says yes: the yes is armed for that thread
  //    and it resumes — the running turn ("what time is it") is untouched.
  confirmations.ask("send the message in Slack", "click_element", { name: "Send" });
  pool.floor = { id: "t_slack", name: "Slack" };
  pool.alive.set(parentId, 2);
  transcript.push({ speaker: "kevin", delta: " yes", startMs: 9000, endMs: 9300 });
  live.nowMs = 9300;
  live.emit("delegation", "item_3", "client", 9300);
  await tick();
  assert.deepEqual(pool.resumed, ["t_slack"]);
  assert.equal(seen.length, 2, "no brain task for the yes");
  assert.equal(cancels, 1, "the running turn was not superseded");
  assert.equal(d.active?.id, d.all()[1]!.id, "…and still runs");
  const relay = d.all()[2]!;
  assert.equal(relay.status, "done");
  assert.equal(relay.summary, "relayed the yes to Slack");
  assert.equal(relay.request, "yes");
  assert.ok(relay.steps.some((s) => s.thread === "Slack" && /yes for Slack's question/.test(s.text ?? "")));
  assert.equal(confirmations.consume("click_element", { name: "Send" }), true, "the yes was armed on the root for the thread's exact action");
  pool.floor = undefined;

  // 4. The running turn finishes with no threads of its own: done; the parent still drains, so nothing is idle.
  const phases: string[] = [];
  d.on("phase", (p) => phases.push(p));
  holds[1]!({ status: "done", summary: "Three o'clock." });
  await tick();
  assert.equal(d.all()[1]!.status, "done");
  assert.equal(d.active?.id, parentId, "the draining parent is what is active now");
  assert.ok(!phases.includes("idle"));
  assert.equal(d.announceSleep(5), false);

  // 5. "stop" while only threads run reaches the engine's stop, as it does while a brain runs.
  live.emit("inputTranscript", " stop");
  await tick();
  assert.deepEqual(stops, ["Kevin said stop"]);

  // 6. The cut: the draining parent is cancelled too, its drain wait ends, nothing more is said for it.
  d.threadSay(parentId, "Spotify", "late line");
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

test("threads: without an engine's threads nothing changes — a new request supersedes as before, and the thread methods are inert", async () => {
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
  d.threadSay(id, "Spotify", "Spotify: done.");
  transcript.push({ speaker: "kevin", delta: " open safari", startMs: 3000, endMs: 3800 });
  live.nowMs = 3800;
  live.emit("delegation", "item_2", "client", 3800);
  await tick();
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "superseded by a new request");
  assert.equal(d.draining, undefined, "no threads: nothing drains");
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
  const pool = new FakeThreads([]);
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
  d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads: pool, now: () => ++clock, commentaryCoalesceMs: 0, onSleep });
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
  d.threadSay(a, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(spoken(), ["Started."], "a late line for the cancelled parent goes nowhere");
  d.dispose();
});

test("threads: park over park — a second parent parked while an older one drains leaves the older one draining; each closes only when its own hands are done, each finish line is spoken once, idle only when the last has drained", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
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
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
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

  // B: its brain starts Slack and is still running when…
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

  // A's thread finishes: its one line, on A, exactly once.
  d.threadSay(a, "Spotify", "Spotify: playing Focus.");
  assert.deepEqual(spoken(), ["Spotify alongside.", "A done.", "Slack alongside.", "Spotify: playing Focus."]);
  assert.ok(d.all()[0]!.steps.some((s) => s.thread === "Spotify" && s.text === "Spotify: playing Focus."));
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
  d.threadSay(b, "Slack", "Slack: sent.");
  pool.alive.set(b, 0);
  pool.drains[1]!.resolve();
  await tick();
  assert.equal(d.all()[1]!.status, "cancelled", "B's own turn was cut by the third request; the record says so");
  assert.equal(d.all()[1]!.summary, "Kevin asked something else; the threads carried on");
  assert.deepEqual(spoken(), ["Spotify alongside.", "A done.", "Slack alongside.", "Spotify: playing Focus.", "Three o'clock.", "Slack: sent."], "every finish line once, none lost");
  assert.equal(d.active, undefined);
  assert.equal(d.draining, undefined);
  assert.equal(phases.at(-1), "idle");
  assert.equal(phases.filter((p) => p === "idle").length, 1, "idle once, at the very end");
  d.dispose();
});

test("threads: a yes while the scheduler names a floor thread but the root holds no question (dropped, or past its TTL) is no relay — it supersedes the running turn and the brain gets the word like any request", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
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
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, threads: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
  transcript.push({ speaker: "kevin", delta: "tell ben i'm late", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  // The desk's floor still points at Slack's question, but the root has none (the pending was dropped or expired).
  pool.floor = { id: "t_slack", name: "Slack" };
  assert.equal(confirmations.pending, undefined);
  transcript.push({ speaker: "kevin", delta: " yes", startMs: 5000, endMs: 5300 });
  live.nowMs = 5300;
  live.emit("delegation", "item_2", "client", 5300);
  await tick();
  assert.deepEqual(pool.resumed, [], "nothing to arm: no thread is resumed on a stale floor");
  assert.equal(cancels, 1, "today's path: the running turn is superseded");
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "superseded by a new request");
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.request, "yes");
  assert.equal(seen[1]!.confirmation, false, "a yes with nothing pending is words for the brain, not an armed confirmation");
  await d.cancel("done", { quiet: true });
  d.dispose();
});

test("threads: a yes while the main brain's own question holds the floor (\"Jarhead\") is no relay — nothing is resumed; the yes is armed and the brain gets the word as ever", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
  const confirmations = new ConfirmationState();
  let clock = 100_000;
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, threads: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
  transcript.push({ speaker: "kevin", delta: "reply to ben", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  confirmations.ask("send the reply", "click_element", { name: "Send" });
  pool.floor = { id: "main", name: "Jarhead" };
  transcript.push({ speaker: "kevin", delta: " yes", startMs: 5000, endMs: 5300 });
  live.nowMs = 5300;
  live.emit("delegation", "item_2", "client", 5300);
  await tick();
  assert.deepEqual(pool.resumed, [], "main is never resumed through the floor");
  assert.equal(brain.cancels, 1, "the yes is the brain's: the running turn is superseded as for any request");
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.request, "yes");
  assert.equal(seen[1]!.confirmation, true, "armed on the root: the next attempt of the exact action goes through");
  assert.equal(d.all().length, 2, "no relay record");
  await d.cancel("done", { quiet: true });
  d.dispose();
});

test("parkRunning: parking a running turn by hand ends it — the turn's signal is aborted and the brain's cancel awaited, its later result is discarded for the given one, and the record closes with that when the hands drain", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const pool = new FakeThreads([]);
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
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads: pool, now: () => ++clock, commentaryCoalesceMs: 0 });
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

// ---------------------------------------------------------------- threads (pass 4)
// The Delegator's view of the threads: a thread verb is answered from the table before the supersede, words
// addressed to a live thread by name are a follow-up on ITS brain, a stop word with two threads live waits
// STOP_NAME_WAIT_MS for a name, the records are indexed (O(1) per step past 200 pushes).

/** A brain that holds every task until the abort signal (the running turn the verbs must not touch). */
function holdingBrain(seen: BrainTask[]): Brain & { cancels: number } {
  const b = {
    kind: "fake",
    cancels: 0,
    start: async () => ({ ready: true, detail: "" }),
    handle: (task: BrainTask) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      b.cancels++;
    },
    stop: async () => undefined,
  };
  return b;
}

test("threads (b′): 'what is spotify doing' while a brain turn runs is an aside answered from the table — one spoken line, brain.handle not called again, the running slot untouched; 'stop the slack one' stops Slack only and never cancels the turn; 'pause spotify' pauses; a status question about a name that is not live goes to the brain as today", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const threads = new FakeThreads();
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => ++clock, commentaryCoalesceMs: 0 });
  const spoken = (): string[] => live.sent.filter((s) => s.type === "commentary").map((s) => s.payload.content);
  transcript.push({ speaker: "kevin", delta: "tell ben on slack and play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  assert.equal(seen.length, 1);
  const running = d.active!.id;

  transcript.push({ speaker: "kevin", delta: "what is spotify doing", startMs: 5000, endMs: 5900 });
  live.nowMs = 5900;
  live.emit("delegation", "item_2", "client", 5900);
  await tick();
  assert.equal(seen.length, 1, "no generation");
  assert.equal(brain.cancels, 0, "the running turn was not superseded");
  assert.equal(d.active?.id, running);
  const aside = d.all().find((x) => x.liveId === "item_2")!;
  assert.equal(aside.status, "done");
  assert.equal(aside.summary, "Spotify is working — 3 seconds in");
  assert.ok((aside.timings as DelegationTimingsExtra).reflex, "answered without a model: marked as a reflex");
  assert.deepEqual(spoken(), ["Spotify is working — 3 seconds in"]);

  transcript.push({ speaker: "kevin", delta: "stop the slack one", startMs: 8000, endMs: 8900 });
  live.nowMs = 8900;
  live.emit("delegation", "item_3", "client", 8900);
  await tick();
  assert.deepEqual(threads.stopped, ["Slack"]);
  assert.equal(brain.cancels, 0);
  assert.equal(d.active?.id, running);
  assert.equal(d.all().find((x) => x.liveId === "item_3")!.status, "done");
  assert.deepEqual(spoken(), ["Spotify is working — 3 seconds in"], "the scheduler speaks '<Name> stopped.' itself: nothing here");

  transcript.push({ speaker: "kevin", delta: "jarhead pause spotify", startMs: 11000, endMs: 11900 });
  live.nowMs = 11900;
  live.emit("delegation", "item_4", "client", 11900);
  await tick();
  assert.deepEqual(threads.paused, ["Spotify"]);
  assert.equal(spoken().at(-1), "Spotify paused.");
  assert.equal(brain.cancels, 0);

  // Not a live name: not a verb — the brain gets the words (and supersedes the running turn, as any request does).
  transcript.push({ speaker: "kevin", delta: "what is mail doing", startMs: 14000, endMs: 14900 });
  live.nowMs = 14900;
  live.emit("delegation", "item_5", "client", 14900);
  await tick();
  assert.equal(seen.length, 2, "the brain took it");
  assert.equal(brain.cancels, 1);
  assert.equal(seen[1]!.request, "what is mail doing");
  d.dispose();
});

test("threads (b″): 'spotify, skip this song' is a follow-up on Spotify's brain with Kevin's words and his circled marks — the main turn is not superseded; 'tell slack to send it' too; a request that merely mentions an app ('open slack', 'slack me later') is the brain's", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const threads = new FakeThreads();
  let clock = 100_000;
  const marks = { pending: () => [{ id: "m1", rect: { x: 1, y: 2, w: 3, h: 4 }, at: 99_000, consumed: false, screenshotPath: "shots/m1.png" }], consume: () => undefined, release: () => undefined, stateDir: "/tmp" };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, marks, now: () => ++clock, commentaryCoalesceMs: 0 });
  transcript.push({ speaker: "kevin", delta: "tell ben on slack and play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  assert.equal(seen.length, 1);

  transcript.push({ speaker: "kevin", delta: "spotify, skip this song", startMs: 5000, endMs: 5900 });
  live.nowMs = 5900;
  live.emit("delegation", "item_2", "client", 5900);
  await tick();
  assert.deepEqual(threads.followUps, [{ id: "t_spotify", request: "skip this song", items: 1, marks: 1 }]);
  assert.equal(brain.cancels, 0);
  assert.equal(seen.length, 1);
  assert.equal(d.all().find((x) => x.liveId === "item_2")!.summary, "passed to Spotify");

  transcript.push({ speaker: "kevin", delta: "tell slack to send it now", startMs: 8000, endMs: 8900 });
  live.nowMs = 8900;
  live.emit("delegation", "item_3", "client", 8900);
  await tick();
  assert.equal(threads.followUps.length, 2);
  assert.equal(threads.followUps[1]!.id, "t_slack");
  assert.equal(threads.followUps[1]!.request, "send it");
  assert.equal(brain.cancels, 0);

  // Mentions, not addresses: the brain's, as before (a supersede).
  for (const [i, words] of ["open slack", "slack me later"].entries()) {
    transcript.push({ speaker: "kevin", delta: words, startMs: 11000 + i * 3000, endMs: 11900 + i * 3000 });
    live.nowMs = 11900 + i * 3000;
    live.emit("delegation", `item_m${i}`, "client", live.nowMs);
    await tick();
  }
  assert.equal(threads.followUps.length, 2, "no follow-up for a mention");
  assert.equal(seen.length, 3, "the brain took both");
  d.dispose();
});

test("threads: a stop word with ≥ 2 threads live gates the speech at once and cuts the work only after STOP_NAME_WAIT_MS unless a name follows — 'stop … the slack one' stops Slack alone and cancels no turn; with one thread the cut is on the fragment, as before", async () => {
  assert.equal(STOP_NAME_WAIT_MS, 350);
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const threads = new FakeThreads();
  let clock = 100_000;
  const stops: string[] = [];
  let gates = 0;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => ++clock, commentaryCoalesceMs: 0, onStop: (r) => void stops.push(r), onGateSpeech: () => void gates++, stopNameWaitMs: 60 });
  transcript.push({ speaker: "kevin", delta: "tell ben on slack and play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  assert.equal(seen.length, 1);

  // Two threads live: the fragment "stop" gates the speech, cuts nothing; "the slack one" names the thread.
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.equal(gates, 1, "speech gated on the stop word");
  assert.deepEqual(stops, [], "the work waits for a name");
  live.emit("inputTranscript", " the slack one");
  await tick(0);
  assert.deepEqual(threads.stopped, ["Slack"]);
  await tick(100);
  assert.deepEqual(stops, [], "the timer was cancelled by the name: nothing cut");
  assert.equal(brain.cancels, 0);
  assert.equal(d.active?.liveId, "item_1");

  // One thread live now: a bare stop is today's cut, on the fragment.
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.deepEqual(stops, ["Kevin said stop"]);
  assert.equal(gates, 1, "no separate gate: the engine's interrupt gates and cuts at once");

  // Two again, no name: the cut lands when the window closes.
  threads.names = ["Spotify", "Mail"];
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.equal(gates, 2);
  assert.equal(stops.length, 1);
  await tick(90);
  assert.equal(stops.length, 2, "cut after the window");
  d.dispose();
});

test("threads: a cut while the name window is open ends the window — cancel() (a pressed Stop, the ear's own cut, a pause) clears the timer and onStop is not fired a second time when it would have run out", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const threads = new FakeThreads();
  let clock = 100_000;
  const stops: string[] = [];
  let gates = 0;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => ++clock, commentaryCoalesceMs: 0, onStop: (r) => void stops.push(r), onGateSpeech: () => void gates++, stopNameWaitMs: 60 });
  transcript.push({ speaker: "kevin", delta: "tell ben on slack and play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  // The stop word with two threads live: the window opens.
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.equal(gates, 1);
  assert.deepEqual(stops, []);
  // A cut lands first (the engine's cutEverything reaches cancel(); the ear's timer or Kevin's Stop button asked for it).
  await d.cancel("Kevin pressed stop", { quiet: true });
  assert.equal(d.active?.id, undefined);
  assert.equal(d.all().find((x) => x.liveId === "item_1")!.status, "cancelled");
  await tick(120);
  assert.deepEqual(stops, [], "the window's timer was cleared by the cut: no second cut, no second stop row");
  // Kevin's next words are a new request, untouched by any late timer.
  transcript.push({ speaker: "kevin", delta: "open mail", startMs: 5000, endMs: 5900 });
  live.nowMs = 5900;
  live.emit("delegation", "item_2", "client", 5900);
  await tick();
  assert.equal(seen.length, 2);
  await tick(120);
  assert.equal(d.active?.liveId, "item_2", "still running: nothing cut it");
  assert.deepEqual(stops, []);
  d.dispose();
});

test("threads: Live's fragments echoing the ear's named stop cut nothing — a stop word within NAMED_STOP_FRAGMENT_ECHO_MS of the ear's 'stop the slack one' (noteNamedStop via ear) opens the name window with one thread live, 'the slack one' parses through the recent names, and an empty window closes quiet; the fragment path's own named stop is no echo, and after the window a bare stop is a stop again", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const threads = new FakeThreads();
  let clock = 100_000;
  const stops: string[] = [];
  let gates = 0;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => clock, commentaryCoalesceMs: 0, onStop: (r) => void stops.push(r), onGateSpeech: () => void gates++, stopNameWaitMs: 60 });
  transcript.push({ speaker: "kevin", delta: "tell ben on slack and play focus on spotify", startMs: 0, endMs: 1500 });
  live.nowMs = 1500;
  live.emit("delegation", "item_1", "client", 1500);
  await tick();
  assert.equal(seen.length, 1);

  // The ear stopped Slack on its partial (the engine's stopNamed tells the delegator); one thread is live now.
  threads.names = ["Spotify"];
  threads.stopped = ["Slack"];
  d.noteNamedStop("Slack", "ear");
  assert.equal(d.namedStopEcho("ear"), true);
  clock += 300;
  // Live's transcription of the same words arrives as fragments: " stop" — with one thread live, the OLD rule would cut everything.
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.equal(gates, 1, "the speech is gated (Kevin did say stop)");
  assert.equal(stops.length, 0, "the work is not cut: the name window opened on the echo");
  clock += 100;
  live.emit("inputTranscript", " the slack one");
  await tick(0);
  assert.deepEqual(threads.stopped, ["Slack"], "Slack was already stopped: the scheduler answers false, nothing else is stopped");
  await tick(100);
  assert.equal(stops.length, 0, "the name closed the window; no late cut");
  assert.equal(brain.cancels, 0);
  assert.equal(d.active?.liveId, "item_1", "the main turn carries on");

  // The echo again, this time with NO name following: the window runs out quiet.
  clock += 200;
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.equal(gates, 2);
  await tick(100);
  assert.equal(stops.length, 0, "an empty window after the ear's named stop is Live's echo: nothing cut");
  assert.equal(d.active?.liveId, "item_1");

  // Past the echo window, a bare stop with one thread live is today's cut, on the fragment.
  clock += NAMED_STOP_FRAGMENT_ECHO_MS;
  assert.equal(d.namedStopEcho("ear"), false);
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.deepEqual(stops, ["Kevin said stop"]);

  // The fragment path's OWN named stop is never an echo: a bare stop after it cuts at once.
  const d2 = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads: Object.assign(new FakeThreads(), { names: ["Spotify", "Slack"] }), now: () => clock, commentaryCoalesceMs: 0, onStop: (r) => void stops.push(r), onGateSpeech: () => void gates++, stopNameWaitMs: 60 });
  d.dispose();
  transcript.push({ speaker: "kevin", delta: "and check my mail", startMs: 9000, endMs: 9900 });
  live.nowMs = 9900;
  live.emit("delegation", "item_2", "client", 9900);
  await tick();
  live.emit("inputTranscript", " stop");
  await tick(0);
  live.emit("inputTranscript", " the slack one");
  await tick(0);
  assert.equal(d2.namedStopEcho("live"), true);
  assert.equal(d2.namedStopEcho("ear"), false, "its own word is not the ear's echo");
  clock += 100;
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.deepEqual(stops, ["Kevin said stop", "Kevin said stop"], "one thread live, no echo: cut on the fragment");
  d2.dispose();
});

/** A brain that holds every task and hands its sink out, so the test can land steps (an acting one stamps firstActionAt). */
function steppingBrain(seen: BrainTask[], sinks: BrainSink[]): Brain & { cancels: number } {
  const b = {
    kind: "fake",
    cancels: 0,
    start: async () => ({ ready: true, detail: "" }),
    handle: (task: BrainTask, sink: BrainSink) =>
      new Promise<BrainResult>((resolve) => {
        seen.push(task);
        sinks.push(sink);
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      b.cancels++;
    },
    stop: async () => undefined,
  };
  return b;
}

test("threads (overflow, Settings.threadOverflow = 'spawn'): a request naming an app the running turn has not touched becomes a thread of its own ONLY once that turn has acted (firstActionAt), never on a correction ('no, in chrome'), never for an app a live thread claims or a live thread's own name, and the running turn is never superseded by a spawn; the default 'supersede' is today's path", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const sinks: BrainSink[] = [];
  const brain = steppingBrain(seen, sinks);
  const threads = new FakeThreads();
  threads.names = [];
  threads.mode = "spawn";
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), threads, now: () => ++clock, commentaryCoalesceMs: 0 });
  const say = (text: string, startMs: number, id: string): void => {
    transcript.push({ speaker: "kevin", delta: text, startMs, endMs: startMs + 900 });
    live.nowMs = startMs + 900;
    live.emit("delegation", id, "client", live.nowMs);
  };
  say("tell ben on slack that i'm late", 0, "item_1");
  await tick();
  assert.equal(seen.length, 1);
  // Nothing acted yet: a request for another app supersedes, as today (a correction of the request is likelier than a split).
  say("play focus on spotify", 3000, "item_2");
  await tick();
  assert.equal(brain.cancels, 1, "superseded: the turn had not acted");
  assert.equal(seen.length, 2);
  assert.equal(threads.spawned.length, 0);
  const running = d.active!;
  assert.equal(running.liveId, "item_2");
  // The running turn acts (an acting tool, ok): firstActionAt is stamped on it.
  sinks[1]!.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
  assert.ok((d.active!.timings as DelegationTimingsExtra).firstActionAt !== undefined);
  // Now a request naming an untouched app is a thread of its own: the running turn goes on.
  say("open mail and check the inbox", 6000, "item_3");
  await tick();
  assert.deepEqual(threads.spawned, [{ parent: running.id, name: "Mail", task: "open mail and check the inbox" }]);
  assert.equal(brain.cancels, 1, "not superseded");
  assert.equal(seen.length, 2, "no generation on the main brain");
  assert.equal(d.active?.id, running.id);
  const aside = d.all().find((x) => x.liveId === "item_3")!;
  assert.equal(aside.status, "done");
  assert.equal(aside.summary, "Mail alongside");
  assert.ok(aside.steps.some((s) => s.kind === "note" && /overflow: the request names Mail/.test(s.text ?? "")));
  // A correction that names another app is the running task's, not a thread: it supersedes as any request does.
  say("no, in chrome", 9000, "item_4");
  await tick();
  assert.equal(threads.spawned.length, 1, "a correction never spawns");
  assert.equal(brain.cancels, 2);
  assert.equal(seen.length, 3);
  sinks[2]!.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
  // An app a live thread already claims, or a live thread's own name, is that thread's business: no second thread for it.
  threads.claimed = ["Discord"];
  say("check discord for me", 12000, "item_5");
  await tick();
  assert.equal(threads.spawned.length, 1, "claimed app: no spawn");
  assert.equal(brain.cancels, 3, "superseded as today");
  sinks[3]!.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
  say("open mail again", 15000, "item_6");
  await tick();
  assert.equal(threads.spawned.length, 1, "Mail is a live thread's name: no second Mail");
  assert.equal(brain.cancels, 4);
  // The default: supersede, whatever the request names.
  threads.mode = "supersede";
  sinks[4]!.step({ kind: "tool", tool: { name: "left_click", input: { coordinate: [3, 4] }, ok: true, ms: 7 } });
  say("open notes", 18000, "item_7");
  await tick();
  assert.equal(threads.spawned.length, 1, "supersede: today's path");
  assert.equal(brain.cancels, 5);
  d.dispose();
});

test("threads: the records are indexed — 300 delegations keep the last 200, and a step on the newest still lands on it in O(1); `settled` fires once per record with its status", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  let sinkRef: BrainSink | undefined;
  let hold: ((r: BrainResult) => void) | undefined;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (_task, sink) =>
      new Promise<BrainResult>((resolve) => {
        sinkRef = sink;
        hold = resolve;
      }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => ++clock, commentaryCoalesceMs: 0 });
  const settled: string[] = [];
  const steps: string[] = [];
  d.on("settled", (id, status) => settled.push(`${id}:${status}`));
  d.on("step", (id, step) => steps.push(`${id}:${step.kind}`));
  for (let i = 0; i < 300; i++) {
    transcript.push({ speaker: "kevin", delta: `request ${i}`, startMs: i * 3000, endMs: i * 3000 + 900 });
    live.nowMs = i * 3000 + 900;
    live.emit("delegation", `item_${i}`, "client", live.nowMs);
    await tick(0);
    hold!({ status: "done", summary: `done ${i}` });
    await tick(0);
  }
  assert.equal(d.all().length, 200, "capped at 200");
  assert.equal(d.all()[0]!.request, "request 100");
  assert.equal(d.all()[199]!.request, "request 299");
  assert.equal(settled.length, 300, "one settled per record");
  assert.ok(settled.every((s) => s.endsWith(":done")));
  // A step on the newest lands on it (the index, not a walk).
  transcript.push({ speaker: "kevin", delta: "request 300", startMs: 900_000, endMs: 900_900 });
  live.nowMs = 900_900;
  live.emit("delegation", "item_300", "client", live.nowMs);
  await tick(0);
  const id = d.all().at(-1)!.id;
  sinkRef!.step({ kind: "tool", tool: { name: "frontmost_app", input: {}, ok: true, ms: 3 } });
  assert.equal(d.all().at(-1)!.steps.length, 1);
  assert.equal(d.all().at(-1)!.id, id);
  assert.equal(steps.at(-1), `${id}:tool`);
  hold!({ status: "done", summary: "done." });
  await tick(0);
  assert.equal(settled.at(-1), `${id}:done`);
  d.dispose();
});

// ------------------------------------------------------------ the user's name ---

test("the user's name: the empty-transcript request, the stop reason and the cancel instruction say the name the engine passes", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const brain = holdingBrain(seen);
  const stops: string[] = [];
  let clock = 100_000;
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState(), now: () => ++clock, commentaryCoalesceMs: 0, userName: () => "Sam", onStop: (r) => void stops.push(r) });
  live.emit("delegation", "item_1", "client", 900);
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.request, "(no transcript yet — ask what Sam wants)", "nothing heard yet: the fallback names the user");
  live.emit("inputTranscript", " stop");
  await tick(0);
  assert.deepEqual(stops, ["Sam said stop"], "the reason the engine records and the Console shows");
  await d.cancel("Sam said stop");
  await tick();
  assert.equal(d.all()[0]!.status, "cancelled");
  assert.equal(d.all()[0]!.summary, "Sam said stop");
  assert.ok(live.sent.some((s) => s.type === "instructions" && s.payload.content === "Sam cancelled the task. Acknowledge with one word and wait."), "the voice hears the name");
  assert.equal(live.sent.some((s) => /Kevin/.test(s.payload.content)), false);
  d.dispose();
});
