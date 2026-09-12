import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset, ConfirmationState } from "../toolset.ts";
import { QUICK_SHOT_BUDGET, Screen, fitScale, fitSize } from "../screen.ts";
import type { NativeHands } from "../native.ts";

class FakeHands implements NativeHands {
  ready = true;
  calls: { op: string; params: Record<string, unknown> }[] = [];
  elementTitle = "Search";
  elementRole = "AXButton";
  elementApp: string | undefined;
  elementFrame: { x: number; y: number; w: number; h: number } | undefined;
  secure = false;
  /** find_element: which app the tree belongs to (undefined = nothing found). */
  foundApp: string | undefined;
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params });
    switch (op) {
      case "find_element": {
        if (!this.foundApp) return { app: "Mail", window: "Inbox", found: false, unique: false, candidates: 0, tier: "none", cached: true, treeMs: 1, nodes: 3, truncated: false, ms: 1 } as T;
        const label = String(params["name"]);
        return { app: this.foundApp, window: "Inbox", found: true, unique: true, candidates: 1, tier: "exact", element: { i: 1, depth: 2, role: "AXButton", title: label, app: this.foundApp, score: 1, label, x: 500, y: 400, w: 60, h: 24, center: { x: 530, y: 412 }, pressable: true }, cached: true, treeMs: 1, nodes: 3, truncated: false, ms: 1 } as T;
      }
      case "screenshot":
        return { displayId: 5, pngBase64: "AAAA", width: 2000, height: 562, points: { x: -1685, y: -1440, w: 5120, h: 1440 }, scale: 2000 / 5120 } as T;
      case "zoom":
        return { displayId: 5, pngBase64: "BBBB", width: 400, height: 200, points: { x: 0, y: 0, w: 200, h: 100 }, scale: 2 } as T;
      case "cursor":
        return { x: 100, y: -700 } as T;
      case "frontmost":
        return { app: "Mail", pid: 1, window: null } as T;
      case "element_at":
        return { role: this.elementRole, title: this.elementTitle, ...(this.elementApp ? { app: this.elementApp } : {}), ...(this.elementFrame ? { frame: this.elementFrame } : {}) } as T;
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

test("the quick budget: the pixel cap decides the shape — a 5120×1440 ultrawide comes out ~1977×556 (legible), 16:10 Retina displays ~1300×830, and a 2000 long edge never upscales", () => {
  // Within a pixel of the helper's own rounding (it produced 1978×556 and 1304×843 on Kevin's displays).
  const near = (got: { width: number; height: number }, w: number, h: number, what: string): void => {
    assert.ok(Math.abs(got.width - w) <= 1 && Math.abs(got.height - h) <= 1, `${what}: ${got.width}x${got.height} ≈ ${w}x${h}`);
  };
  near(fitSize(5120, 1440, QUICK_SHOT_BUDGET), 1978, 556, "5120x1440 ultrawide");
  near(fitSize(3456, 2234, QUICK_SHOT_BUDGET), 1304, 843, "14-inch Retina");
  near(fitSize(2560, 1600, QUICK_SHOT_BUDGET), 1327, 829, "16:10");
  assert.deepEqual(fitSize(1280, 800, QUICK_SHOT_BUDGET), { width: 1280, height: 800 }, "a small display is left alone");
  for (const [w, h] of [[5120, 1440], [3456, 2234], [2560, 1600], [6016, 3384]] as const) {
    const s = fitSize(w, h, QUICK_SHOT_BUDGET);
    assert.ok(s.width * s.height <= QUICK_SHOT_BUDGET.maxPixels * 1.001, `${w}x${h} stays under the pixel cap`);
    assert.ok(Math.max(s.width, s.height) <= QUICK_SHOT_BUDGET.maxLongEdge, `${w}x${h} stays under the long edge`);
  }
  assert.equal(QUICK_SHOT_BUDGET.maxLongEdge, 2000);
  assert.equal(QUICK_SHOT_BUDGET.maxPixels, 1_100_000);
});

test("screenshot: quick: true asks the helper for the quick budget (2000 long edge, ~1.1 MP) and says so; the gate's probes go out together and only the ones the member needs", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  const quick = await ts.run("screenshot", { quick: true });
  assert.equal(quick.kind, "image");
  assert.match((quick as { note: string }).note, /\(quick budget\)$/);
  const req = hands.calls.find((c) => c.op === "screenshot")!.params;
  assert.equal(req["maxLongEdge"], 2000);
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

test("click_element: the named control's app must be the one in front, and the element under its point must be that control — a background app's tree, a covering control, or a control of another app under the point clicks nothing", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  const clicks = (): number => hands.calls.filter((c) => c.op === "click").length;

  // The tree is Slack's (an `app` argument, or a browser behind another window); Mail is in front.
  hands.foundApp = "Slack";
  const behind = await ts.run("click_element", { name: "Save", app: "Slack" });
  assert.equal(behind.kind, "error");
  assert.match((behind as { message: string }).message, /Slack, but Mail is in front/);
  assert.equal(clicks(), 0, "no global click into whatever is on top");

  // Mail's own control, and the point holds its label (static text inside the button's frame, found at 500,400 60x24): clicked.
  hands.foundApp = "Mail";
  hands.elementRole = "AXStaticText";
  hands.elementTitle = "Save";
  hands.elementFrame = { x: 512, y: 405, w: 36, h: 14 };
  assert.equal((await ts.run("click_element", { name: "Save" })).kind, "text");
  assert.equal(clicks(), 1);
  assert.deepEqual(hands.calls.filter((c) => c.op === "frontmost" || c.op === "element_at").map((c) => c.op).slice(-2), ["frontmost", "element_at"], "one frontmost and one element_at probe per click");

  // A sheet's button over the point since the tree was built — its frame is its own, and "Don't Save" is not "Save" however the words compare: nothing.
  hands.elementRole = "AXButton";
  hands.elementTitle = "Don't Save";
  hands.elementFrame = { x: 480, y: 380, w: 120, h: 60 };
  const covered = await ts.run("click_element", { name: "Save" });
  assert.equal(covered.kind, "error");
  assert.match((covered as { message: string }).message, /covered at its point \(530,412\) by AXButton "Don't Save"/);
  assert.equal(clicks(), 1);

  // The point belongs to another app entirely.
  hands.elementTitle = "Save";
  hands.elementApp = "Finder";
  const other = await ts.run("click_element", { name: "Save" });
  assert.equal(other.kind, "error");
  assert.match((other as { message: string }).message, /covered by Finder/);
  assert.equal(clicks(), 1);

  // The button's own icon inside its frame (an image with a different description) is fine; the words still reach the policy.
  hands.elementApp = undefined;
  hands.elementRole = "AXImage";
  hands.elementTitle = "floppy disk";
  hands.elementFrame = { x: 504, y: 404, w: 16, h: 16 };
  assert.equal((await ts.run("click_element", { name: "Save" })).kind, "text");
  assert.equal(clicks(), 2);
  hands.elementTitle = "Send";
  hands.elementRole = "AXStaticText";
  const asks = await ts.run("click_element", { name: "Save" });
  assert.equal(asks.kind, "needs-confirmation", "a Send under the point is judged even though the tree said Save");
  assert.equal(clicks(), 2);

  // No frames to compare (an app that reports none): a differently named control under the point is a cover; static text is not.
  hands.elementFrame = undefined;
  hands.elementTitle = "Cancel";
  hands.elementRole = "AXButton";
  assert.match(((await ts.run("click_element", { name: "Save" })) as { message: string }).message, /not what is under its point: AXButton "Cancel"/);
  hands.elementRole = "AXStaticText";
  hands.elementTitle = "Save changes";
  assert.equal((await ts.run("click_element", { name: "Save" })).kind, "text");
  assert.equal(clicks(), 3);
});
