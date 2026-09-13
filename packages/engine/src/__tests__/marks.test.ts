import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession } from "@jarhead/live";
import type { Brain, BrainTask } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import type { OverlayCommand } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { FakeMemoryService, noShell } from "./world.ts";

/**
 * The marks lifecycle: mark.add records a ScreenMark at once (asleep or awake),
 * tells the voice when one is open, screenshots the region through the hands
 * with Jarhead's own windows left out, hands the pending marks to the next
 * delegation (waiting for a capture still in flight), gives them back when the
 * brain never took the task, keeps consumed ones two minutes after the handover,
 * drops forgotten ones after fifteen, caps at six. The hands are a stand-in (no
 * helper binary), Live is a stand-in (no socket), the brain records what it was given.
 */

/** Just enough LiveSession for wake(), a delegation, and sleep(). */
class FakeLive extends EventEmitter {
  instructions: string[] = [];
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  nowMs = 1000;
  async start(): Promise<{ id: string; expires_at: number }> {
    this.currentState = "started";
    this.session = { id: "sess_1", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
  }
  appendInstructions(_id: string | null, content: string): string {
    this.instructions.push(content);
    return "i";
  }
  appendThinking(): string {
    return "t";
  }
  appendCommentary(): string {
    return "c";
  }
  appendAudio(): void {}
  mute(): string {
    return "m";
  }
  unmute(): string {
    return "u";
  }
  createResponseItem(): void {}
  createResponse(): void {}
  close(): void {
    this.currentState = "closed";
    this.emit("closed", "client_closed", 0);
  }
}

const PNG = Buffer.from("PNG-REGION");

interface World {
  dir: string;
  engine: Engine;
  live: FakeLive;
  tasks: BrainTask[];
  overlays: OverlayCommand[];
  zooms: Record<string, unknown>[];
  /** Every hands op and Live note in the order they happened. */
  timeline: string[];
  hands: { failZoom: boolean; holdZoom: (() => void) | undefined };
  brain: { fail: boolean };
  clock: { t: number };
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "jh-marks-engine-"));
  const config: JarheadConfig = {
    ...readConfig(),
    openaiApiKey: "sk-test-not-used",
    brain: "auto",
    brainModel: "",
    brainBaseUrl: undefined,
    anthropicApiKey: undefined,
    claudeBin: undefined,
    codexBin: undefined,
    handsBin: join(dir, "no-hands"),
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  const tasks: BrainTask[] = [];
  const brainState = { fail: false };
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async (task) => {
      tasks.push(task);
      return brainState.fail ? { status: "failed", error: "already handling a task" } : { status: "done", summary: "done." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const live = new FakeLive();
  const timeline: string[] = [];
  const origAppend = live.appendInstructions.bind(live);
  live.appendInstructions = (id, content) => {
    timeline.push("live-note");
    return origAppend(id, content);
  };
  const clock = { t: 1_757_500_000_000 };
  // Every engine in a test runs over the memory stand-in: the real service would build an OpenAI embedder over the fake key.
  const engine = new Engine({ config, connectors: [], brain, makeLive: () => live as unknown as LiveSession, now: () => clock.t, exec: noShell, memory: { service: new FakeMemoryService() } });
  const overlays: OverlayCommand[] = [];
  engine.on("overlay", (c) => {
    overlays.push(c);
    timeline.push(`overlay:${c.cmd}`);
  });
  // No helper binary in this world: the resident helper's request() is replaced with a stand-in
  // that answers `zoom` (what mark.add asks for) and nothing else. `holdZoom` keeps a capture
  // in flight until the test lets it go.
  const zooms: Record<string, unknown>[] = [];
  const hands: World["hands"] = { failZoom: false, holdZoom: undefined };
  (engine.hands as unknown as { request: (op: string, params?: Record<string, unknown>) => Promise<unknown> }).request = async (op, params = {}) => {
    timeline.push(`hands:${op}`);
    if (op === "zoom" && !hands.failZoom) {
      zooms.push(params);
      if (hands.holdZoom) await new Promise<void>((release) => (hands.holdZoom = release));
      return { displayId: 1, pngBase64: PNG.toString("base64"), width: 200, height: 100, points: { x: params["x"], y: params["y"], w: params["w"], h: params["h"] }, scale: 2 };
    }
    throw new Error(`no hands for ${op}`);
  };
  return { dir, engine, live, tasks, overlays, zooms, timeline, hands, brain: brainState, clock };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

test("marks: circled regions are recorded at once, captured without Jarhead's windows, handed to the next task, then aged out", async () => {
  const w = world();
  const { engine, live, tasks, overlays, zooms, timeline } = w;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.currentPhase, "asleep");

    // Asleep: the mark is still recorded, with its screenshot; nobody is told (no session). The
    // sender drew this stroke on the layer itself, so the engine does not echo it a second time.
    const stroke = [{ x: 10, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }];
    await engine.command({ type: "mark.add", rect: { x: 10, y: 20, w: 100, h: 50 }, path: stroke });
    let marks = engine.snapshot().marks;
    assert.equal(marks.length, 1);
    const first = marks[0]!;
    assert.match(first.id, /^mark_/);
    assert.deepEqual(first.rect, { x: 10, y: 20, w: 100, h: 50 });
    assert.deepEqual(first.path, stroke);
    assert.equal(first.consumed, false);
    assert.equal(first.at, w.clock.t);
    assert.ok(first.screenshotPath?.startsWith("shots/") && first.screenshotPath.endsWith(`${first.id}.png`), `relative, like tool screenshots: ${first.screenshotPath}`);
    assert.deepEqual(readFileSync(join(engine.config.stateDir, first.screenshotPath!)), PNG);
    assert.deepEqual(zooms, [{ x: 10, y: 20, w: 100, h: 50, maxLongEdge: 2000, excludePids: [process.pid] }], "the hands' zoom op captures exactly the circled rect, with Jarhead's own windows left out like every capture");
    // The stand-in has no element_at / windows, so nothing to snap to: the stroke's own box stands. The
    // sender drew the stroke itself (no echo); the blob then outlines the box by hand.
    assert.deepEqual(overlays.map((o) => o.cmd), ["orb.trace"], "a stroke that came with the command was drawn by its sender; the only overlay is the blob's outline");
    const outline = overlays[0] as Extract<OverlayCommand, { cmd: "orb.trace" }>;
    assert.equal(outline.closed, true);
    assert.equal(outline.tone, "mark");
    assert.equal(outline.reason, "mark");
    assert.equal(outline.label, undefined, "nothing known about what was circled: no label");
    assert.ok(outline.points.length >= 16 && outline.points.every((pt) => pt.x >= 10 - 1e-6 && pt.x <= 110 + 1e-6 && pt.y >= 20 - 1e-6 && pt.y <= 70 + 1e-6), "a rounded frame within the box");
    assert.deepEqual(timeline.filter((t) => t.startsWith("hands:")), ["hands:element_at", "hands:windows", "hands:zoom"], "the snap probes run before the capture");
    assert.deepEqual(live.instructions, [], "asleep: nothing to tell");

    // A right-to-left box gives a negative size; it is normalised and, with no path, its outline
    // is echoed — after the capture, so the echo is never in the shot.
    timeline.length = 0;
    overlays.length = 0;
    await engine.command({ type: "mark.add", rect: { x: 200, y: 100, w: -50, h: -20 } });
    marks = engine.snapshot().marks;
    assert.equal(marks.length, 2);
    assert.deepEqual(marks[1]!.rect, { x: 150, y: 80, w: 50, h: 20 });
    assert.equal(marks[1]!.path, undefined);
    assert.deepEqual(overlays.map((o) => o.cmd), ["stroke", "orb.trace"], "a bare box: its outline echoed once the capture is done, then the blob's trace");
    assert.equal((overlays[0] as { points: readonly unknown[]; tone: string; ttlMs: number }).points.length, 5);
    assert.equal((overlays[0] as { tone: string }).tone, "mark");
    assert.deepEqual(timeline, ["hands:element_at", "hands:windows", "hands:zoom", "overlay:stroke", "overlay:orb.trace"]);

    // When the hands cannot capture (no helper, no Screen Recording) the mark still counts, without pixels.
    w.hands.failZoom = true;
    await engine.command({ type: "mark.add", rect: { x: 0, y: 0, w: 10, h: 10 } });
    w.hands.failZoom = false;
    marks = engine.snapshot().marks;
    assert.equal(marks.length, 3);
    assert.equal(marks[2]!.screenshotPath, undefined);

    // Awake: the voice hears about a new mark right away — before the capture, not after it.
    // (The clock jumps minutes at a time below; idle sleep must not end the session meanwhile.)
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    assert.equal(engine.currentPhase, "listening");
    timeline.length = 0;
    await engine.command({ type: "mark.add", rect: { x: 300.4, y: 400.6, w: 80, h: 40 }, path: [{ x: 300, y: 400 }, { x: 380, y: 440 }] });
    assert.deepEqual(live.instructions, ["Kevin just circled a region of his screen (80×40 at 300,401). The brain will see the image with the next task; acknowledge briefly if he is asking about it."]);
    assert.deepEqual(timeline, ["live-note", "hands:element_at", "hands:windows", "hands:zoom", "overlay:orb.trace"]);
    marks = engine.snapshot().marks;
    assert.equal(marks.length, 4);
    assert.ok(marks.every((m) => !m.consumed));

    // The next delegation carries every pending mark that has pixels, as absolute paths, and consumes them all.
    live.emit("delegation", "item_1", "client", 1000);
    await settle();
    assert.equal(tasks.length, 1);
    const attachments = tasks[0]!.attachments ?? [];
    assert.deepEqual(
      attachments.map((a) => a.path),
      [marks[0]!, marks[1]!, marks[3]!].map((m) => join(engine.config.stateDir, m.screenshotPath!)),
    );
    assert.ok(attachments.every((a) => existsSync(a.path) && a.mediaType === "image/png"));
    assert.equal(attachments[0]!.note, "Kevin circled this region of his screen: 10,20 100×50 (global points)");
    assert.equal(attachments[2]!.note, "Kevin circled this region of his screen: 300,401 80×40 (global points)");
    marks = engine.snapshot().marks;
    assert.equal(marks.length, 4, "consumed marks stay for the Console");
    assert.ok(marks.every((m) => m.consumed));

    // A second delegation gets nothing: the marks were consumed.
    live.emit("delegation", "item_2", "client", 2000);
    await settle();
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1]!.attachments, undefined);

    // Consumed marks age out two minutes after the handover, not after they were drawn: circled
    // long ago, consumed just now, still shown.
    w.clock.t += 121_000;
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.snapshot().marks.length, 0, "handed over two minutes ago: gone");
    await engine.command({ type: "mark.add", rect: { x: 1, y: 1, w: 2, h: 2 } });
    w.clock.t += 10 * 60_000; // circled ten minutes ago, still pending
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.snapshot().marks.length, 1);
    live.emit("delegation", "item_3", "client", 3000);
    await settle();
    assert.equal(tasks.length, 3);
    assert.equal(tasks[2]!.attachments?.length, 1);
    assert.equal(tasks[2]!.attachments![0]!.note, "Kevin circled this region of his screen: 1,1 2×2 (global points), circled 10 min ago", "the brain hears how old the circle is");
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.snapshot().marks.length, 1, "consumed just now: kept for the Console although drawn ten minutes ago");
    assert.equal(engine.snapshot().marks[0]!.consumed, true);
    w.clock.t += 121_000;
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.snapshot().marks.length, 0);

    // A mark nobody asks about does not live forever: fifteen minutes, then it leaves rather
    // than ride into an unrelated task as "this".
    await engine.command({ type: "mark.add", rect: { x: 2, y: 2, w: 2, h: 2 } });
    w.clock.t += 14 * 60_000;
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.snapshot().marks.length, 1);
    w.clock.t += 61_000;
    (engine as unknown as { tick(): void }).tick();
    assert.equal(engine.snapshot().marks.length, 0);

    // The brain never took the task (restarting, busy): the marks are pending again and ride with the next one.
    await engine.command({ type: "mark.add", rect: { x: 3, y: 3, w: 2, h: 2 } });
    w.brain.fail = true;
    live.emit("delegation", "item_4", "client", 4000);
    await settle();
    assert.equal(tasks.length, 4);
    assert.equal(tasks[3]!.attachments?.length, 1);
    assert.equal(engine.snapshot().marks[0]!.consumed, false, "released: the brain never got to work");
    w.brain.fail = false;
    live.emit("delegation", "item_5", "client", 5000);
    await settle();
    assert.equal(tasks.length, 5);
    assert.equal(tasks[4]!.attachments?.length, 1);
    assert.equal(engine.snapshot().marks[0]!.consumed, true);
    await engine.command({ type: "mark.clear" });

    // At most six are kept, newest last.
    for (let i = 0; i < 8; i++) await engine.command({ type: "mark.add", rect: { x: i, y: i, w: 5, h: 5 } });
    marks = engine.snapshot().marks;
    assert.equal(marks.length, 6);
    assert.deepEqual(marks[5]!.rect, { x: 7, y: 7, w: 5, h: 5 });

    // mark.clear drops everything.
    await engine.command({ type: "mark.clear" });
    assert.deepEqual(engine.snapshot().marks, []);
  } finally {
    await engine.stop();
  }
});

test("marks: a delegation that fires while the region is still being captured waits for the pixels instead of missing the mark", async () => {
  const w = world();
  const { engine, live, tasks } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");

    // Hold the capture: the mark is already in the snapshot, without pixels, and the voice knows.
    w.hands.holdZoom = () => undefined;
    const adding = engine.command({ type: "mark.add", rect: { x: 10, y: 20, w: 100, h: 50 }, path: [{ x: 10, y: 20 }, { x: 110, y: 70 }] });
    await settle();
    let marks = engine.snapshot().marks;
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.screenshotPath, undefined, "registered before the capture lands");
    assert.equal(live.instructions.length, 1);

    // Kevin asks while the hands are still working: the task waits for the capture.
    live.emit("delegation", "item_1", "client", 1000);
    await settle();
    assert.equal(tasks.length, 0, "the brain is not started until the region has its pixels");
    assert.equal(engine.snapshot().marks[0]!.consumed, false);

    // The capture lands: the mark gets its screenshot in place and the task goes out with it.
    w.hands.holdZoom!();
    w.hands.holdZoom = undefined;
    await adding;
    await settle();
    assert.equal(tasks.length, 1);
    marks = engine.snapshot().marks;
    assert.ok(marks[0]!.screenshotPath, "filled in place");
    assert.equal(marks[0]!.consumed, true);
    assert.deepEqual(tasks[0]!.attachments?.map((a) => a.path), [join(engine.config.stateDir, marks[0]!.screenshotPath!)]);
    assert.deepEqual(readFileSync(tasks[0]!.attachments![0]!.path), PNG);
  } finally {
    w.hands.holdZoom?.();
    await engine.stop();
  }
});

/** Hands whose accessibility probes answer from a script: what is under the centroid, which windows are up. */
class SnapHands implements NativeHands {
  ready = true;
  element: unknown = {};
  windows: unknown[] = [];
  zooms: Record<string, unknown>[] = [];
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "element_at":
        return this.element as T;
      case "windows":
        return { windows: this.windows } as T;
      case "zoom":
        this.zooms.push(params);
        return { displayId: 1, pngBase64: PNG.toString("base64"), width: 10, height: 10, points: { x: params["x"], y: params["y"], w: params["w"], h: params["h"] }, scale: 2 } as T;
      default:
        throw new Error(`no hands for ${op}`);
    }
  }
}

/** A roughly circular stroke around a rect, 24 points, in global coordinates. */
function strokeAround(r: { x: number; y: number; w: number; h: number }, pad = 10): { x: number; y: number }[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2 + pad;
  const ry = r.h / 2 + pad;
  return Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
}

function bboxOf(pts: readonly { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

test("marks: the stroke snaps to the LARGEST frame mostly inside it — a circled dialog is the dialog, not the label under the centroid; a circled button is the button; a window barely touched leaves the box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-marks-snap-"));
  const config: JarheadConfig = {
    ...readConfig(),
    openaiApiKey: "sk-test-not-used",
    brain: "auto",
    brainModel: "",
    brainBaseUrl: undefined,
    anthropicApiKey: undefined,
    claudeBin: undefined,
    codexBin: undefined,
    handsBin: join(dir, "no-hands"),
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  const brain: Brain = { kind: "fake", start: async () => ({ ready: true, detail: "fake" }), handle: async () => ({ status: "done", summary: "done." }), cancel: async () => undefined, stop: async () => undefined };
  const hands = new SnapHands();
  const engine = new Engine({ config, connectors: [], brain, hands, makeLive: () => new FakeLive() as unknown as LiveSession, exec: noShell, memory: { service: new FakeMemoryService() } });
  const overlays: OverlayCommand[] = [];
  engine.on("overlay", (c) => overlays.push(c));
  const near = (a: number, b: number, tol = 1): boolean => Math.abs(a - b) <= tol;
  try {
    await engine.start();
    await engine.ready();

    // A circled dialog: element_at at the centroid is a label inside it; the dialog window is what Kevin surrounded.
    const dialog = { windowId: 2, pid: 2, app: "Finder", title: "Move to Trash?", x: 320, y: 320, w: 560, h: 360, layer: 0 };
    hands.element = { role: "AXStaticText", title: "Are you sure?", frame: { x: 500, y: 480, w: 200, h: 40 }, app: "Finder" };
    hands.windows = [{ windowId: 1, pid: 1, app: "Finder", title: "Desktop", x: 0, y: 0, w: 1440, h: 900, layer: 0 }, dialog];
    let path = strokeAround(dialog, 20);
    await engine.command({ type: "mark.add", rect: bboxOf(path), path });
    let m = engine.snapshot().marks[0]!;
    assert.deepEqual(m.rect, { x: 320, y: 320, w: 560, h: 360 }, "the dialog, not the label");
    assert.deepEqual(m.element, { role: "AXWindow", title: "Move to Trash?", app: "Finder" });
    assert.equal(hands.zooms[0]!["w"], 560, "the screenshot is of the dialog");
    let trace = overlays.find((o) => o.cmd === "orb.trace") as Extract<OverlayCommand, { cmd: "orb.trace" }>;
    assert.equal(trace.label, "Move to Trash?");
    let b = bboxOf(trace.points);
    assert.ok(near(b.x, 320) && near(b.y, 320) && near(b.w, 560) && near(b.h, 360), `the blob outlines the dialog: ${JSON.stringify(b)}`);
    await engine.command({ type: "mark.clear" });
    overlays.length = 0;

    // A circled button: the window around it fails the coverage test; the button is the largest fit.
    const button = { x: 100, y: 100, w: 80, h: 30 };
    hands.element = { role: "AXButton", title: "Save", frame: button, app: "Notes" };
    hands.windows = [{ windowId: 1, pid: 1, app: "Notes", title: "Untitled", x: 0, y: 0, w: 1440, h: 900, layer: 0 }];
    path = strokeAround(button);
    await engine.command({ type: "mark.add", rect: bboxOf(path), path });
    m = engine.snapshot().marks[0]!;
    assert.deepEqual(m.rect, button);
    assert.deepEqual(m.element, { role: "AXButton", title: "Save", app: "Notes" });
    trace = overlays.find((o) => o.cmd === "orb.trace") as Extract<OverlayCommand, { cmd: "orb.trace" }>;
    assert.equal(trace.label, "Save");
    b = bboxOf(trace.points);
    assert.ok(near(b.x, 100) && near(b.w, 80) && near(b.h, 30), `the blob outlines the button: ${JSON.stringify(b)}`);
    await engine.command({ type: "mark.clear" });
    overlays.length = 0;

    // A stroke in the middle of a huge window: nothing fits; the stroke's own box stands, the app noted.
    hands.element = { role: "AXGroup", frame: { x: 0, y: 0, w: 1440, h: 900 }, app: "Notes" };
    path = strokeAround({ x: 200, y: 200, w: 150, h: 100 });
    const bbox = bboxOf(path);
    await engine.command({ type: "mark.add", rect: bbox, path });
    m = engine.snapshot().marks[0]!;
    assert.ok(near(m.rect.x, bbox.x) && near(m.rect.w, bbox.w), `the box stands: ${JSON.stringify(m.rect)}`);
    assert.deepEqual(m.element, { app: "Notes" });
    trace = overlays.find((o) => o.cmd === "orb.trace") as Extract<OverlayCommand, { cmd: "orb.trace" }>;
    assert.equal(trace.label, "Notes");
    await engine.command({ type: "mark.clear" });
    overlays.length = 0;

    // Global coordinates: a mark on the display above (negative y) keeps negative y in rect, zoom and trace.
    const above = { x: 100, y: -500, w: 80, h: 30 };
    hands.element = { role: "AXButton", title: "Send", frame: above, app: "Mail" };
    hands.windows = [{ windowId: 1, pid: 1, app: "Mail", title: "New Message", x: 0, y: -900, w: 1440, h: 900, layer: 0 }];
    hands.zooms.length = 0;
    path = strokeAround(above);
    await engine.command({ type: "mark.add", rect: bboxOf(path), path });
    m = engine.snapshot().marks[0]!;
    assert.deepEqual(m.rect, above);
    assert.equal(hands.zooms[0]!["y"], -500);
    trace = overlays.find((o) => o.cmd === "orb.trace") as Extract<OverlayCommand, { cmd: "orb.trace" }>;
    b = bboxOf(trace.points);
    assert.ok(near(b.y, -500) && near(b.h, 30), `trace in global points: ${JSON.stringify(b)}`);
  } finally {
    await engine.stop();
  }
});
