import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerToolset, ConfirmationState } from "@jarhead/hands";
import { AgentRegistry } from "@jarhead/agents";
import { Transcript, type LiveSession } from "@jarhead/live";
import type { OverlayCommand, Rect, ScreenMark } from "@jarhead/protocol";
import { ToolRunner, resultText, traceDurationMs } from "../runner.ts";
import { Delegator } from "../delegator.ts";
import { AnthropicBrain } from "../anthropic.ts";
import { OpenAICompatibleBrain } from "../compatible.ts";
import { ResponsesBrain, progressLine } from "../responses.ts";
import { ClaudeBrain, zodShape } from "../claude.ts";
import type { SdkLike, SdkMessage, SdkQuery, SdkUserMessage } from "@jarhead/agents";
import { ALL_TOOL_SPECS, DRAW_SPECS, specByName } from "../tools.ts";
import { attachmentsPreamble, attachmentsRecap, loadAttachments, markNote } from "../attachments.ts";
import { delegationPrompt, historyPrompt } from "../anthropic.ts";
import { brainSystemPrompt, type Brain, type BrainAttachment, type BrainTask } from "../brain.ts";
import { FakeHands, fakeServer, makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * Kevin circles a region → the delegator hands it to the brain → the brain
 * shows it to the model; and the other way round: a brain draws on the screen
 * and the hands fly the blob to where they act. Everything here runs against
 * the fakes; no overlay, no Live session, no real screen.
 */

/** A LiveSession stand-in with the surface the delegator and the responses brain touch. */
class FakeLive extends EventEmitter {
  sent: { type: string; payload: unknown }[] = [];
  nowMs = 5000;
  appendThinking(id: string | null, content: string): string {
    this.sent.push({ type: "thinking", payload: { id, content } });
    return "t";
  }
  appendCommentary(id: string | null, content: string): string {
    this.sent.push({ type: "commentary", payload: { id, content } });
    return "c";
  }
  appendInstructions(id: string | null, content: string): string {
    this.sent.push({ type: "instructions", payload: { id, content } });
    return "i";
  }
  createResponseItem(item: unknown): void {
    this.sent.push({ type: "item", payload: item });
  }
  createResponse(): void {
    this.sent.push({ type: "response.create", payload: undefined });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from("PNG-A");
const REGION: Rect = { x: 10.4, y: 20, w: 100, h: 50.6 };
const NOTE = "Kevin circled this region of the screen: 10,20 100×51 (global points)";

/** A state dir with one mark screenshot in it, and the attachment that points at it. */
function markFixture(): { dir: string; attachment: BrainAttachment; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), "jh-marks-"));
  const rel = join("shots", "2026-09-10", "mark_1.png");
  mkdirSync(join(dir, "shots", "2026-09-10"), { recursive: true });
  writeFileSync(join(dir, rel), PNG);
  return { dir, rel, attachment: { path: join(dir, rel), mediaType: "image/png", note: markNote(REGION) } };
}

function withAttachments(task: BrainTask, attachments: readonly BrainAttachment[]): BrainTask {
  return { ...task, attachments };
}

test("delegator: pending marks ride with the next task as absolute paths and are consumed, pixels or not; a failed task releases them", async () => {
  const { dir, rel } = markFixture();
  assert.equal(markNote(REGION), NOTE);
  const marks: ScreenMark[] = [
    { id: "mark_1", rect: REGION, at: 1, screenshotPath: rel, consumed: false },
    // The hands could not capture this one: no pixels, but it still goes away with the task.
    { id: "mark_2", rect: { x: 0, y: 0, w: 5, h: 5 }, at: 2, consumed: false },
    // Already handed to an earlier task: not offered again.
    { id: "mark_3", rect: { x: 1, y: 1, w: 1, h: 1 }, at: 3, screenshotPath: "shots/old.png", consumed: true },
  ];
  const consumed: string[][] = [];
  const released: string[][] = [];
  let settledCalls = 0;
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  transcript.push({ speaker: "kevin", delta: "what is this", startMs: 0, endMs: 600 });
  const seen: BrainTask[] = [];
  let answer: () => Promise<{ status: "done" | "failed"; summary?: string; error?: string }> = async () => ({ status: "done", summary: "the Save button." });
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task) => {
      seen.push(task);
      return answer();
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const setConsumed = (ids: readonly string[], value: boolean): void => {
    for (const id of ids) {
      const i = marks.findIndex((m) => m.id === id);
      if (i >= 0) marks[i] = { ...marks[i]!, consumed: value };
    }
  };
  new Delegator({
    live: live as unknown as LiveSession,
    transcript,
    brain,
    confirmations: new ConfirmationState(),
    now: () => 5000, // the marks are seconds old: no age in the note
    marks: {
      pending: () => marks.filter((m) => !m.consumed),
      consume: (ids) => {
        consumed.push([...ids]);
        setConsumed(ids, true);
      },
      release: (ids) => {
        released.push([...ids]);
        setConsumed(ids, false);
      },
      settled: async () => {
        settledCalls++;
        await sleep(5);
      },
      stateDir: dir,
    },
  });

  live.emit("delegation", "item_1", "client", 600);
  await sleep(30);
  assert.deepEqual(seen[0]?.attachments, [{ path: join(dir, rel), mediaType: "image/png", note: NOTE, kind: "mark" }]);
  assert.deepEqual(consumed, [["mark_1", "mark_2"]], "every pending mark is consumed, only the one with pixels is attached");
  assert.equal(settledCalls, 1, "an in-flight capture is waited for before the marks are taken");
  assert.deepEqual(released, []);

  // Nothing pending → no attachments field at all, nothing consumed, and no waiting either.
  transcript.push({ speaker: "kevin", delta: " and now?", startMs: 700, endMs: 1200 });
  live.emit("delegation", "item_2", "client", 1200);
  await sleep(30);
  assert.equal(seen.length, 2);
  assert.equal("attachments" in seen[1]!, false);
  assert.equal(consumed.length, 1);
  assert.equal(settledCalls, 1);

  // The brain never took the task (restarting, busy): the marks are pending again for the next one.
  marks.push({ id: "mark_4", rect: REGION, at: 4, screenshotPath: rel, consumed: false });
  answer = async () => ({ status: "failed", error: "the brain is restarting" });
  transcript.push({ speaker: "kevin", delta: " and this?", startMs: 1300, endMs: 1800 });
  live.emit("delegation", "item_3", "client", 1800);
  await sleep(30);
  assert.equal(seen.length, 3);
  assert.equal(seen[2]!.attachments?.length, 1);
  assert.deepEqual(consumed[1], ["mark_4"]);
  assert.deepEqual(released, [["mark_4"]], "a failed task gives the marks back");
  assert.equal(marks.find((m) => m.id === "mark_4")!.consumed, false);
  answer = async () => ({ status: "done", summary: "ok." });
  transcript.push({ speaker: "kevin", delta: " again", startMs: 1900, endMs: 2200 });
  live.emit("delegation", "item_4", "client", 2200);
  await sleep(30);
  assert.equal(seen[3]!.attachments?.length, 1, "and they ride with the next task");
  assert.deepEqual(consumed[2], ["mark_4"]);

  // The brains read the pixels through loadAttachments; a vanished file is skipped, not fatal.
  const loaded = loadAttachments(withAttachments(makeTask("x"), [seen[0]!.attachments![0]!, { path: join(dir, "gone.png"), mediaType: "image/png", note: "gone" }]));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.pngBase64, PNG.toString("base64"));
  assert.equal(loaded[0]!.note, NOTE);
  assert.match(attachmentsPreamble(seen[0]!.attachments), /^Attached image 1: Kevin circled this region of the screen: 10,20 100×51 \(global points\)\n/);
  assert.equal(attachmentsPreamble(undefined), "");
  assert.equal(attachmentsPreamble([]), "");

  // The note carries the circle's age once it is a minute or more old.
  assert.equal(markNote(REGION, 59_000), NOTE);
  assert.equal(markNote(REGION, 3 * 60_000), `${NOTE}, circled 3 min ago`);
  assert.equal(markNote(REGION, 5 * 3_600_000), `${NOTE}, circled 5 h ago`);

  // The prompt numbers the images that really go in; the history version names the regions without claiming pixels.
  const two: BrainAttachment[] = [seen[0]!.attachments![0]!, { path: join(dir, "gone.png"), mediaType: "image/png", note: "Kevin circled this region of the screen: 0,0 5×5 (global points)" }];
  const task = withAttachments(makeTask("what is this"), two);
  assert.match(delegationPrompt(task), /Attached image 1: .*10,20 100×51.*\nAttached image 2: .*0,0 5×5/);
  const onlyLoaded = delegationPrompt(task, "Kevin", loadAttachments(task));
  assert.match(onlyLoaded, /Attached image 1: .*10,20 100×51/);
  assert.ok(!onlyLoaded.includes("Attached image 2"), onlyLoaded);
  assert.ok(!onlyLoaded.includes("0,0 5×5"), onlyLoaded);
  const history = historyPrompt(task);
  assert.equal(history, `Kevin said: "what is this"\n\n${NOTE}\nKevin circled this region of the screen: 0,0 5×5 (global points)`);
  assert.equal(attachmentsRecap(undefined), "");
  assert.equal(historyPrompt(makeTask("plain")), delegationPrompt(makeTask("plain")));
});

test("runner: the show_* tools map screenshot pixels to global points and put shapes on the overlay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-draw-"));
  const overlays: OverlayCommand[] = [];
  const toolset = new ComputerToolset({ hands: new FakeHands(), confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([], 0), stateDir: dir, overlay: (c) => overlays.push(c) });
  const steps: string[] = [];
  runner.attach({ thinking: () => undefined, commentary: () => undefined, step: (s) => steps.push(`${s.kind}:${s.tool?.name ?? ""}`), screenshot: () => undefined });

  // Before any screenshot the numbers are global points as given. By default the blob
  // draws the shape by hand: an orb.trace along the shape's points; `quick` stamps it.
  let r = await runner.run("show_circle", { x: 300, y: 200, radius: 40, label: "here" });
  assert.equal(r.result.kind, "text");
  assert.match(resultText(r.result), /^drew a circle at 300,200 \(global points\), radius 40; the blob is drawing it; fades in 6 s$/);
  const traced = overlays[0] as Extract<OverlayCommand, { cmd: "orb.trace" }>;
  assert.equal(traced.cmd, "orb.trace");
  assert.equal(traced.points.length, 40, "a circle is sampled to 40 points");
  assert.equal(traced.closed, true);
  assert.equal(traced.label, "here");
  assert.equal(traced.tone, "accent");
  assert.equal(traced.reason, "show_circle");
  assert.deepEqual(traced.points[0], { x: 300, y: 160 }, "starts at the top");
  assert.ok(traced.points.every((pt) => Math.abs(Math.hypot(pt.x - 300, pt.y - 200) - 40) < 1e-6), "every point is on the circle");
  r = await runner.run("show_circle", { x: 300, y: 200, radius: 40, label: "here", quick: true });
  assert.deepEqual(overlays[1], { cmd: "circle", x: 300, y: 200, radius: 40, label: "here", tone: "accent" }, "quick: an instant stamp");
  assert.match(resultText(r.result), /stamped; fades in 6 s$/);

  // After a screenshot (FakeHands: 100x50 px covering 200x100 points → 0.5 px per point) pixels become points through the same mapping the clicks use.
  await runner.run("screenshot", {});
  r = await runner.run("show_circle", { x: 50, y: 25, radius: 10, ttlMs: 2000, quick: true });
  assert.deepEqual(overlays[2], { cmd: "circle", x: 100, y: 50, radius: 20, ttlMs: 2000, tone: "accent" });
  assert.match(resultText(r.result), /fades in 2 s/);
  await runner.run("show_arrow", { from: [0, 0], to: [50, 25], label: "drag it here", quick: true });
  assert.deepEqual(overlays[3], { cmd: "arrow", from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, label: "drag it here", tone: "accent" });
  // A traced arrow: the shaft is dragged as a line, the head stamped once the trace should have landed.
  await runner.run("show_arrow", { from: [0, 0], to: [50, 25], label: "drag it here" });
  assert.deepEqual(overlays[4], { cmd: "orb.trace", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }], closed: false, tone: "accent", reason: "show_arrow" });
  assert.equal(overlays.length, 5, "the head waits for the trace");
  await new Promise((res) => setTimeout(res, traceDurationMs([{ x: 0, y: 0 }, { x: 100, y: 50 }]) + 80));
  const head = overlays[5] as Extract<OverlayCommand, { cmd: "arrow" }>;
  assert.equal(head.cmd, "arrow");
  assert.deepEqual(head.to, { x: 100, y: 50 });
  assert.equal(head.label, "drag it here");
  assert.ok(Math.abs(Math.hypot(head.from.x - 100, head.from.y - 50) - 28) < 1e-6, "the head's shaft is 28 points long, ending at the tip");
  await runner.run("show_rect", { rect: [10, 10, 20, 5], quick: true });
  assert.deepEqual(overlays[6], { cmd: "rect", rect: { x: 20, y: 20, w: 40, h: 10 }, tone: "accent" });
  await runner.run("show_rect", { rect: [10, 10, 20, 5] });
  assert.deepEqual(overlays[7], { cmd: "orb.trace", points: [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 30 }, { x: 20, y: 30 }], closed: true, tone: "accent", reason: "show_rect" }, "a rect is its corners, closed");
  await runner.run("show_text", { x: 5, y: 5, text: "start here", ttlMs: 100 }); // too short to see; clamped up; always instant
  assert.deepEqual(overlays[8], { cmd: "text", x: 10, y: 10, text: "start here", ttlMs: 500, tone: "accent" });
  await runner.run("show_stroke", { points: [[0, 0], [10, 0], [10, 10]], ttl_ms: 600_000, quick: true }); // and clamped down
  assert.deepEqual(overlays[9], { cmd: "stroke", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], ttlMs: 60_000, tone: "accent" });
  await runner.run("show_stroke", { points: [[0, 0], [10, 0], [10, 10]] });
  assert.deepEqual(overlays[10], { cmd: "orb.trace", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], closed: false, tone: "accent", reason: "show_stroke" }, "a stroke is traced as given");
  r = await runner.run("show_clear", {});
  assert.deepEqual(overlays[11], { cmd: "clear" });
  assert.equal(resultText(r.result), "cleared the drawings");

  // Bad input is an error the model can read, not a crash, and draws nothing.
  assert.equal((await runner.run("show_stroke", { points: [[1, 2]] })).result.kind, "error");
  assert.equal((await runner.run("show_arrow", { from: [1], to: [2, 3] })).result.kind, "error");
  assert.equal((await runner.run("show_circle", { x: "a", y: 1, radius: 2 })).result.kind, "error");
  assert.equal((await runner.run("show_rect", { rect: [1, 2, 3] })).result.kind, "error");
  assert.equal((await runner.run("show_text", { x: 1, y: 2, text: "  " })).result.kind, "error");
  assert.equal(overlays.length, 12);
  assert.ok(steps.includes("tool:show_circle") && steps.includes("error:show_stroke"), steps.join(" | "));
  // Every drawing tool but show_text and show_clear takes `quick`.
  for (const name of ["show_circle", "show_arrow", "show_rect", "show_stroke"]) assert.ok("quick" in specByName(name)!.parameters.properties, `${name} has quick`);
  assert.ok(!("quick" in specByName("show_text")!.parameters.properties));

  // The specs are in the shared table (every brain sees them), the thinking channel has words for them, and the standing orders mention drawing.
  for (const s of DRAW_SPECS) assert.equal(specByName(s.name), s);
  assert.deepEqual(ALL_TOOL_SPECS.filter((s) => s.name.startsWith("show_")).map((s) => s.name), ["show_circle", "show_arrow", "show_rect", "show_text", "show_stroke", "show_clear"]);
  assert.equal(progressLine("show_circle", {}), "Drawing on the screen.");
  assert.equal(progressLine("show_clear", {}), "Clearing the drawings.");
  assert.match(brainSystemPrompt(), /show_circle, show_arrow, show_rect, show_text and show_stroke/);
  // show_stroke's [[x, y], …] survives the trip into zod for the Agent SDK.
  const shape = zodShape(specByName("show_stroke")!);
  assert.deepEqual(shape["points"]!.parse([[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
  assert.throws(() => shape["points"]!.parse([1, 2]));
  assert.equal(Object.keys(zodShape(specByName("show_circle")!)).sort().join(","), "label,quick,radius,ttlMs,x,y");

  // Without an overlay hook (a runner-only engine) the tool still answers instead of failing.
  const { runner: bare } = makeRunner();
  assert.equal((await bare.run("show_clear", {})).result.kind, "text");
});

/** FakeHands plus what the toolset asks around actions: a zoom result, a focused element with a frame. */
class ActingHands extends FakeHands {
  frame: Rect | null = null;
  override async request<T>(op: string, params?: Record<string, unknown>): Promise<T> {
    if (op === "zoom") return { displayId: 1, pngBase64: PNG.toString("base64"), width: 20, height: 10, points: params, scale: 0.2 } as T;
    if (op === "focused_text") return { role: "AXTextField", secure: false, app: "Notes", frame: this.frame } as T;
    return super.request<T>(op);
  }
}

test("toolset: the blob flies to clicks, drags, scrolls, presses and typing; a drag is traced and a zoom frames its region", async () => {
  const hands = new ActingHands();
  const cmds: OverlayCommand[] = [];
  const ts = new ComputerToolset({ hands, confirmations: new ConfirmationState(), annotate: (c) => cmds.push(c) });
  await ts.run("screenshot", {});
  assert.deepEqual(cmds.slice(), [], "a full screenshot has no region to frame");

  assert.equal((await ts.run("left_click", { coordinate: [50, 25] })).kind, "text");
  assert.deepEqual(cmds.slice(), [
    { cmd: "orb.fly", x: 100, y: 50, dwellMs: 1500, reason: "left_click" },
    { cmd: "click-pulse", x: 100, y: 50 },
  ]);
  cmds.length = 0;

  assert.equal((await ts.run("double_click", { coordinate: [50, 25] })).kind, "text");
  assert.equal(cmds[0]?.cmd, "orb.fly");
  assert.equal((cmds[0] as { reason?: string }).reason, "double_click");
  cmds.length = 0;

  assert.equal((await ts.run("left_click_drag", { start_coordinate: [0, 0], coordinate: [50, 25] })).kind, "text");
  assert.deepEqual(cmds.slice(), [
    { cmd: "orb.fly", x: 0, y: 0, dwellMs: 1500, reason: "left_click_drag" },
    { cmd: "path", from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, ttlMs: 1500 },
  ]);
  cmds.length = 0;

  assert.equal((await ts.run("scroll", { coordinate: [10, 10], scroll_direction: "down", scroll_amount: 2 })).kind, "text");
  assert.deepEqual(cmds.slice(), [{ cmd: "orb.fly", x: 20, y: 20, dwellMs: 1500, reason: "scroll" }]);
  cmds.length = 0;
  assert.equal((await ts.run("scroll", { scroll_direction: "down", scroll_amount: 2 })).kind, "text");
  assert.deepEqual(cmds.slice(), [], "a scroll without a point has nowhere to fly");

  assert.equal((await ts.run("zoom", { region: [0, 0, 50, 25] })).kind, "image");
  assert.deepEqual(cmds.slice(), [{ cmd: "rect", rect: { x: 0, y: 0, w: 100, h: 50 }, ttlMs: 1500, tone: "accent" }]);
  cmds.length = 0;

  hands.frame = { x: 300, y: 400, w: 100, h: 20 };
  assert.equal((await ts.run("type", { text: "hello" })).kind, "text");
  assert.deepEqual(cmds.slice(), [{ cmd: "orb.fly", x: 350, y: 410, dwellMs: 1500, reason: "type" }], "typing flies to the focused element when accessibility knows its frame");
  cmds.length = 0;
  hands.frame = null;
  assert.equal((await ts.run("type", { text: "hello" })).kind, "text");
  assert.deepEqual(cmds.slice(), [], "no frame, no flight");

  assert.equal((await ts.run("left_mouse_down", {})).kind, "text");
  assert.deepEqual(cmds.slice(), [{ cmd: "orb.fly", x: 10, y: 10, dwellMs: 1500, reason: "left_mouse_down" }], "a press lands under the pointer");
  cmds.length = 0;
  assert.equal((await ts.run("left_mouse_up", {})).kind, "text");

  await ts.run("key", { text: "Return" });
  await ts.run("frontmost_app", {});
  await ts.run("list_windows", {});
  await ts.run("cursor_position", {});
  assert.deepEqual(cmds.slice(), [], "keys and read-only ops move nothing");
});

const MODEL_INFO = { id: "claude-opus-5", type: "model", display_name: "Claude Opus 5", created_at: "2026-04-01T00:00:00Z" };
function anthropicMessage(content: unknown[], stop_reason: string): unknown {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content, stop_reason, stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } };
}

test("anthropic brain: circled regions go in as base64 image blocks ahead of the words", async () => {
  const { attachment } = markFixture();
  const server = await fakeServer((req) => (req.method === "GET" ? { status: 200, json: MODEL_INFO } : { status: 200, json: anthropicMessage([{ type: "text", text: "That is the Save button." }], "end_turn") }));
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, maxRetries: 0 });
    await brain.start();
    const result = await brain.handle(withAttachments(makeTask("what is this"), [attachment]), makeSink().sink);
    assert.equal(result.status, "done");
    assert.equal(result.summary, "That is the Save button.");
    const body = server.seen[1]!.body as { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> }> };
    const content = body.messages[0]!.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    assert.equal(content[1]!.type, "text");
    assert.match(content[1]!.text!, /Kevin said: "what is this"\n\nAttached image 1: Kevin circled this region of the screen: 10,20 100×51 \(global points\)/);

    // No attachments → the plain string turn, and the earlier exchange is carried as text only.
    await brain.handle(makeTask("and now?"), makeSink().sink);
    const second = server.seen[2]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(second.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(typeof second.messages[0]!.content, "string", "history keeps the words, not the pixels");
    assert.equal(second.messages[0]!.content, `Kevin said: "what is this"\n\n${NOTE}`, "and names the region without claiming an attached image");
    assert.equal(typeof second.messages[2]!.content, "string");
    await brain.stop();
  } finally {
    await server.close();
  }
});

const MODELS = { object: "list", data: [{ id: "llama3.1:latest", object: "model" }] };
function completion(message: unknown): unknown {
  return { id: "chatcmpl_1", object: "chat.completion", model: "llama3.1", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

test("compatible brain: circled regions are image_url parts when the server takes images, a text note otherwise", async () => {
  const { attachment } = markFixture();
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 200, json: completion({ role: "assistant", content: "That is the Save button." }) }));
  try {
    const { runner } = makeRunner();
    const textOnly = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    assert.equal((await textOnly.start()).ready, true);
    assert.equal((await textOnly.handle(withAttachments(makeTask("what is this"), [attachment]), makeSink().sink)).status, "done");
    const t = server.seen[1]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(t.messages.map((m) => m.role), ["system", "user"]);
    assert.equal(typeof t.messages[1]!.content, "string");
    assert.match(String(t.messages[1]!.content), /Kevin said: "what is this"\n\nKevin circled this region of the screen: 10,20 100×51 \(global points\)\n\nThis server cannot receive images/);
    assert.ok(!String(t.messages[1]!.content).includes("Attached image"), "a text-only server is not told an image is attached");

    const withImages = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", capabilities: { images: true } });
    assert.equal((await withImages.start()).ready, true);
    assert.equal((await withImages.handle(withAttachments(makeTask("what is this"), [attachment]), makeSink().sink)).status, "done");
    const i = server.seen[3]!.body as { messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> }> };
    const parts = i.messages[1]!.content;
    assert.equal(parts.length, 3);
    assert.equal(parts[0]!.type, "text");
    assert.match(parts[0]!.text!, /Kevin said: "what is this"/);
    assert.deepEqual(parts[1], { type: "text", text: NOTE });
    assert.deepEqual(parts[2], { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "high" } });
    assert.match(parts[0]!.text!, /Attached image 1: /);

    // The next turn carries the earlier one as text that names the region but claims no image.
    assert.equal((await withImages.handle(makeTask("and now?"), makeSink().sink)).status, "done");
    const h = server.seen[4]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(h.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
    assert.equal(h.messages[1]!.content, `Kevin said: "what is this"\n\n${NOTE}`);
  } finally {
    await server.close();
  }
});

test("responses brain: circled regions ride as an input_image item with the first tool results, once, before the backend continues", async () => {
  const { attachment } = markFixture();
  const { runner } = makeRunner();
  const live = new FakeLive();
  const brain = new ResponsesBrain({ runner, model: "gpt-5.6-terra" });
  brain.bind(live as unknown as LiveSession);
  const done = brain.handle(withAttachments(makeTask("what is this"), [attachment]), makeSink().sink);

  live.emit("responseEvent", "item_1", { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "frontmost_app", arguments: "{}" } });
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  await sleep(30);
  assert.deepEqual(live.sent.map((s) => s.type), ["item", "item", "response.create"]);
  assert.equal((live.sent[0]!.payload as { type: string }).type, "function_call_output");
  assert.deepEqual(live.sent[1]!.payload, {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: NOTE },
      { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "high" },
    ],
  });

  // A second round of calls does not show it twice.
  live.emit("responseEvent", "item_1", { type: "response.output_item.done", item: { type: "function_call", call_id: "call_2", name: "frontmost_app", arguments: "{}" } });
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  await sleep(30);
  assert.deepEqual(live.sent.slice(3).map((s) => s.type), ["item", "response.create"]);
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  assert.equal((await done).status, "done");

  // With no attachments nothing extra is sent.
  const again = brain.handle(makeTask("and now?"), makeSink().sink);
  live.sent.length = 0;
  live.emit("responseEvent", "item_1", { type: "response.output_item.done", item: { type: "function_call", call_id: "call_3", name: "frontmost_app", arguments: "{}" } });
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  await sleep(30);
  assert.deepEqual(live.sent.map((s) => s.type), ["item", "response.create"]);
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  assert.equal((await again).status, "done");

  // The backend answers without a single tool call: the region is shown right after that answer and the
  // backend runs once more; only the completion after that finishes the delegation.
  const late = brain.handle(withAttachments(makeTask("what is this"), [attachment]), makeSink().sink);
  live.sent.length = 0;
  live.emit("responseEvent", "item_1", { type: "response.output_text.done", text: "What do you mean by this?" });
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  await sleep(30);
  assert.deepEqual(live.sent.map((s) => s.type), ["item", "response.create"]);
  const shown = live.sent[0]!.payload as { type: string; role: string; content: Array<{ type: string; text?: string; image_url?: string }> };
  assert.equal(shown.type, "message");
  assert.equal(shown.role, "user");
  assert.deepEqual(shown.content.slice(0, 2), [
    { type: "input_text", text: NOTE },
    { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}`, detail: "high" },
  ]);
  assert.equal(shown.content.length, 3);
  assert.match(shown.content[2]!.text!, /^You answered before seeing what Kevin circled\. Look at it now: if your answer changes or was missing what Kevin meant by "this"/);
  let settled = false;
  void late.then(() => (settled = true));
  await sleep(10);
  assert.equal(settled, false, "the delegation waits for the backend's second answer");
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  assert.equal((await late).status, "done");
  assert.equal(live.sent.length, 2, "the region is shown once");

  // A cancelled delegation shows nothing after the fact.
  const ac = new AbortController();
  const gone = brain.handle(withAttachments({ ...makeTask("what is this"), signal: ac.signal }, [attachment]), makeSink().sink);
  live.sent.length = 0;
  ac.abort();
  assert.equal((await gone).status, "cancelled");
  live.emit("responseEvent", "item_1", { type: "response.completed" });
  await sleep(10);
  assert.deepEqual(live.sent, []);
});

/** An Agent SDK stand-in: records every user message the session pushes and answers each with one assistant turn. */
class FakeSdk implements SdkLike {
  seen: SdkUserMessage[] = [];
  query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    const seen = this.seen;
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield { type: "system", subtype: "init", session_id: "s1", model: "fake" };
      for await (const msg of prompt) {
        seen.push(msg);
        yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "That is the Save button." }] }, parent_tool_use_id: null };
        yield { type: "result", subtype: "success", result: "That is the Save button.", is_error: false };
      }
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => undefined };
  }
}

test("claude brain: circled regions go in as image blocks of the user turn through the Agent SDK", async () => {
  const { attachment } = markFixture();
  const { runner } = makeRunner();
  const sdk = new FakeSdk();
  const brain = new ClaudeBrain({ runner, sdk, mcpFactory: async () => ({}), authProbe: async () => "valid" });
  try {
    const started = await brain.start();
    assert.equal(started.ready, true, started.detail);
    const result = await brain.handle(withAttachments(makeTask("what is this"), [attachment]), makeSink().sink);
    assert.equal(result.status, "done");
    assert.equal(result.summary, "That is the Save button.");
    assert.equal(sdk.seen.length, 1);
    const content = sdk.seen[0]!.message.content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    assert.equal(content[1]!.type, "text");
    assert.match(content[1]!.text!, /Kevin said: "what is this"\n\nAttached image 1: Kevin circled this region of the screen: 10,20 100×51 \(global points\)/);

    // Without attachments the turn is the plain string it always was.
    assert.equal((await brain.handle(makeTask("and now?"), makeSink().sink)).status, "done");
    assert.equal(sdk.seen[1]!.message.content, 'Kevin said: "and now?"');
  } finally {
    await brain.stop();
  }
});
