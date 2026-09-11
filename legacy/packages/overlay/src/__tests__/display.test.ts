import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampToWorkArea,
  containsPoint,
  displayContaining,
  nearestDisplay,
  windowTopLeftFor,
  type DisplayInfo,
  type Rect,
} from "../display.ts";

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

// A realistic macOS arrangement: primary at origin, a larger display to the
// left with a negative origin and a vertical offset (so there is a dead zone
// between the two in global coordinates).
const PRIMARY: DisplayInfo = { id: 1, bounds: rect(0, 0, 1512, 982), workArea: rect(0, 25, 1512, 957) };
const LEFT: DisplayInfo = { id: 2, bounds: rect(-2560, -300, 2560, 1440), workArea: rect(-2560, -275, 2560, 1415) };
const DISPLAYS = [PRIMARY, LEFT];

test("displayContaining resolves points across a negative-origin arrangement", () => {
  assert.equal(displayContaining(DISPLAYS, { x: 500, y: 500 })?.id, 1);
  assert.equal(displayContaining(DISPLAYS, { x: -1000, y: -100 })?.id, 2);
  assert.equal(displayContaining(DISPLAYS, { x: 9999, y: 9999 }), undefined);
});

test("shared edges belong to exactly one display", () => {
  // x = 0 is the primary's left edge and one past the left display's right edge.
  assert.equal(containsPoint(PRIMARY.bounds, { x: 0, y: 100 }), true);
  assert.equal(containsPoint(LEFT.bounds, { x: 0, y: 100 }), false);
  // Right/bottom edges are exclusive.
  assert.equal(containsPoint(PRIMARY.bounds, { x: 1512, y: 100 }), false);
});

test("nearestDisplay falls back to the closest screen for dead-zone points", () => {
  // Below the left display's bottom edge (y=1140) but left of the primary:
  // a real dead zone in this arrangement.
  assert.equal(nearestDisplay(DISPLAYS, { x: -2000, y: 1200 }).id, 2);
  // Just under the primary instead.
  assert.equal(nearestDisplay(DISPLAYS, { x: 700, y: 1200 }).id, 1);
  // Contained points still resolve by containment.
  assert.equal(nearestDisplay(DISPLAYS, { x: -1, y: 0 }).id, 2);
});

test("nearestDisplay refuses an empty display list loudly", () => {
  assert.throws(() => nearestDisplay([], { x: 0, y: 0 }), /no displays/);
});

test("windowTopLeftFor puts the anchor pixel on the target", () => {
  const topLeft = windowTopLeftFor({ x: 800, y: 600 }, { x: 140, y: 196 });
  assert.deepEqual(topLeft, { x: 660, y: 404 });
});

test("clampToWorkArea keeps the whole window on screen", () => {
  const size = { width: 280, height: 220 };
  // A target near the primary's bottom-right corner would hang the window off
  // both edges without clamping.
  const clamped = clampToWorkArea({ x: 1400, y: 900 }, size, PRIMARY.workArea);
  assert.deepEqual(clamped, { x: 1512 - 280, y: 25 + 957 - 220 });
  // Above the work area (under the menu bar) clamps down.
  const underMenuBar = clampToWorkArea({ x: 100, y: 0 }, size, PRIMARY.workArea);
  assert.deepEqual(underMenuBar, { x: 100, y: 25 });
  // Already inside: untouched.
  const inside = clampToWorkArea({ x: 400, y: 400 }, size, PRIMARY.workArea);
  assert.deepEqual(inside, { x: 400, y: 400 });
});
