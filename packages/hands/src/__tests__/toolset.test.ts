import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset, ConfirmationState } from "../toolset.ts";
import { Screen, fitScale } from "../screen.ts";
import type { NativeHands } from "../native.ts";

class FakeHands implements NativeHands {
  ready = true;
  calls: { op: string; params: Record<string, unknown> }[] = [];
  elementTitle = "Search";
  secure = false;
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params });
    switch (op) {
      case "screenshot":
        return { displayId: 5, pngBase64: "AAAA", width: 2000, height: 562, points: { x: -1685, y: -1440, w: 5120, h: 1440 }, scale: 2000 / 5120 } as T;
      case "zoom":
        return { displayId: 5, pngBase64: "BBBB", width: 400, height: 200, points: { x: 0, y: 0, w: 200, h: 100 }, scale: 2 } as T;
      case "cursor":
        return { x: 100, y: -700 } as T;
      case "frontmost":
        return { app: "Mail", pid: 1, window: null } as T;
      case "element_at":
        return { role: "AXButton", title: this.elementTitle } as T;
      case "focused_text":
        return { role: "AXTextField", subrole: this.secure ? "AXSecureTextField" : undefined, secure: this.secure, app: "Mail" } as T;
      default:
        return {} as T;
    }
  }
}

test("screenshot pixels map back to global points on a display above the primary", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  const shot = await ts.run("screenshot", {});
  assert.equal(shot.kind, "image");
  // pixel (1000, 281) is the centre of the 2000x562 image → centre of the display rect
  const p = ts.screen.toPoints(1000, 281);
  assert.ok(Math.abs(p.x - (-1685 + 2560)) < 1);
  assert.ok(Math.abs(p.y - (-1440 + 720)) < 1);
  await ts.run("mouse_move", { coordinate: [1000, 281] });
  const move = hands.calls.find((c) => c.op === "move");
  assert.ok(move && Math.abs((move.params["x"] as number) - 875) < 1 && Math.abs((move.params["y"] as number) + 720) < 1);
});

test("coordinates without a screenshot are an error, not a crash", async () => {
  const ts = new ComputerToolset({ hands: new FakeHands() });
  const r = await ts.run("left_click", { coordinate: [10, 10] });
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /screenshot/);
});

test("an ordinary click runs; a Send button asks, and yes unlocks exactly that click once", async () => {
  const hands = new FakeHands();
  const pulses: string[] = [];
  const ts = new ComputerToolset({ hands, annotate: (c) => pulses.push(c.cmd) });
  await ts.run("screenshot", {});

  hands.elementTitle = "Search";
  assert.equal((await ts.run("left_click", { coordinate: [100, 100] })).kind, "text");
  assert.deepEqual(pulses, ["orb.fly", "click-pulse"], "the blob flies to the click, then the click pulses");

  hands.elementTitle = "Send";
  const asked = await ts.run("left_click", { coordinate: [500, 300] });
  assert.equal(asked.kind, "needs-confirmation");
  assert.match((asked as { question: string }).question, /Send/);
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 1, "the click did not happen");

  // Kevin says yes → the brain arms the confirmation → the same click runs.
  assert.ok(ts.confirmations.arm());
  assert.equal((await ts.run("left_click", { coordinate: [505, 302] })).kind, "text");
  assert.equal(hands.calls.filter((c) => c.op === "click").length, 2);

  // But the yes is spent: a second Send click asks again.
  assert.equal((await ts.run("left_click", { coordinate: [505, 302] })).kind, "needs-confirmation");
});

test("a yes for one action does not unlock a different one", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  hands.elementTitle = "Delete";
  assert.equal((await ts.run("left_click", { coordinate: [10, 10] })).kind, "needs-confirmation");
  ts.confirmations.arm();
  hands.elementTitle = "Publish";
  assert.equal((await ts.run("left_click", { coordinate: [900, 400] })).kind, "needs-confirmation");
});

test("typing into a password field is refused", async () => {
  const hands = new FakeHands();
  hands.secure = true;
  const ts = new ComputerToolset({ hands });
  const r = await ts.run("type", { text: "hunter2" });
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /password/);
  assert.equal(hands.calls.filter((c) => c.op === "type").length, 0);
});

test("scroll converts clicks to pixels with the right sign", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  await ts.run("scroll", { coordinate: [1000, 281], scroll_direction: "down", scroll_amount: 3 });
  const s = hands.calls.find((c) => c.op === "scroll");
  assert.equal(s?.params["dy"], -180);
  assert.equal(s?.params["dx"], 0);
  await ts.run("scroll", { scroll_direction: "left", scroll_amount: 1 });
  assert.equal(hands.calls.filter((c) => c.op === "scroll")[1]?.params["dx"], 60);
});

test("zoom maps a screenshot region to a global rect", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  const r = await ts.run("zoom", { region: [0, 0, 1000, 281] });
  assert.equal(r.kind, "image");
  const z = hands.calls.find((c) => c.op === "zoom")?.params ?? {};
  assert.ok(Math.abs((z["x"] as number) + 1685) < 1 && Math.abs((z["w"] as number) - 2560) < 1);
  assert.equal((await ts.run("zoom", { region: [1, 2] })).kind, "error");
});

test("confirmation state expires", () => {
  let t = 0;
  const c = new ConfirmationState(1000, () => t);
  c.ask("send", "left_click", { coordinate: [1, 1] });
  t = 2000;
  assert.equal(c.arm(), undefined);
});

test("fitScale never upscales and respects both limits", () => {
  assert.equal(fitScale(800, 600), 1);
  const s = fitScale(3456, 2234, { maxLongEdge: 2000, maxPixels: 2_500_000 });
  assert.ok(3456 * s <= 2000.0001);
  assert.ok(3456 * s * 2234 * s <= 2_500_000.1);
  const screen = new Screen();
  assert.throws(() => screen.toPoints(1, 1));
});

test("screenshot: quick: true asks the helper for the 1280-pixel budget and says so; the gate's probes go out together and only the ones the member needs", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  const quick = await ts.run("screenshot", { quick: true });
  assert.equal(quick.kind, "image");
  assert.match((quick as { note: string }).note, /\(quick budget\)$/);
  const req = hands.calls.find((c) => c.op === "screenshot")!.params;
  assert.equal(req["maxLongEdge"], 1280);
  assert.equal(req["maxPixels"], 1_100_000);
  const full = hands.calls.filter((c) => c.op === "screenshot");
  await ts.run("screenshot", {});
  assert.equal(hands.calls.filter((c) => c.op === "screenshot")[full.length]!.params["maxLongEdge"], 2000, "the default budget is unchanged");

  // A click probes frontmost + element_at; a key press probes frontmost + focused_text; a scroll probes nothing.
  hands.calls.length = 0;
  await ts.run("left_click", { coordinate: [100, 100] });
  assert.deepEqual(hands.calls.map((c) => c.op).filter((op) => op !== "click"), ["frontmost", "element_at"]);
  hands.calls.length = 0;
  await ts.run("key", { text: "Return" });
  assert.deepEqual(hands.calls.map((c) => c.op).filter((op) => op !== "key"), ["frontmost", "focused_text"]);
  hands.calls.length = 0;
  await ts.run("scroll", { scroll_direction: "down", scroll_amount: 2 });
  assert.deepEqual(hands.calls.map((c) => c.op), ["scroll"]);
});
