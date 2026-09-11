import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrowToward,
  cellsToPixels,
  pixelsToCells,
  placeNear,
  planTrail,
  type Rect,
  type Size,
} from "../layout.ts";

// Kevin's actual arrangement: primary at the origin, the second display
// ABOVE it, entirely at negative y (menu bar at y=-2160). Everything below
// must survive both.
const PRIMARY: Rect = { x: 0, y: 0, width: 1512, height: 982 };
const UPPER: Rect = { x: -640, y: -2160, width: 3840, height: 2160 };

const LABEL: Size = { width: 200, height: 60 };

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function assertOnScreenAndClear(target: Rect, screen: Rect, size: Size): void {
  const p = placeNear(target, size, screen);
  const rect: Rect = { x: p.x, y: p.y, width: size.width, height: size.height };
  assert.ok(rect.x >= screen.x && rect.x + rect.width <= screen.x + screen.width, `${p.side}: on screen horizontally`);
  assert.ok(rect.y >= screen.y && rect.y + rect.height <= screen.y + screen.height, `${p.side}: on screen vertically`);
  assert.ok(!intersects(rect, target), `${p.side}: does not cover the target`);
}

test("placeNear prefers the right side when there is room", () => {
  const target: Rect = { x: 400, y: 400, width: 100, height: 40 };
  const p = placeNear(target, LABEL, PRIMARY);
  assert.equal(p.side, "right");
  assert.equal(p.x, 512);
});

test("placeNear dodges all four screen edges", () => {
  // Flush against each edge of the primary display.
  assertOnScreenAndClear({ x: 1412, y: 400, width: 100, height: 40 }, PRIMARY, LABEL); // right edge
  assertOnScreenAndClear({ x: 0, y: 400, width: 100, height: 40 }, PRIMARY, LABEL); // left edge
  assertOnScreenAndClear({ x: 600, y: 942, width: 100, height: 40 }, PRIMARY, LABEL); // bottom edge
  assertOnScreenAndClear({ x: 600, y: 0, width: 100, height: 40 }, PRIMARY, LABEL); // top edge

  const nearRight = placeNear({ x: 1412, y: 400, width: 100, height: 40 }, LABEL, PRIMARY);
  assert.equal(nearRight.side, "left", "no room on the right pushes the label left");
});

test("placeNear handles the negative-origin display's edges and corners", () => {
  // The same four edges, but every coordinate is negative or near the
  // display's own (negative) origin — the case that has broken coordinate
  // math in this repo before.
  assertOnScreenAndClear({ x: -640, y: -1000, width: 120, height: 50 }, UPPER, LABEL); // left edge
  assertOnScreenAndClear({ x: 3080, y: -1000, width: 120, height: 50 }, UPPER, LABEL); // right edge
  assertOnScreenAndClear({ x: 1000, y: -2160, width: 120, height: 50 }, UPPER, LABEL); // top edge
  assertOnScreenAndClear({ x: 1000, y: -50, width: 120, height: 50 }, UPPER, LABEL); // bottom edge
  assertOnScreenAndClear({ x: -640, y: -2160, width: 120, height: 50 }, UPPER, LABEL); // top-left corner

  const corner = placeNear({ x: -640, y: -2160, width: 120, height: 50 }, LABEL, UPPER);
  assert.equal(corner.side, "right");
  assert.ok(corner.y >= UPPER.y, "clamped into the negative work area, not toward zero");
});

test("placeNear clamps on screen as a last resort when nothing fits cleanly", () => {
  const tiny: Rect = { x: 0, y: 0, width: 300, height: 200 };
  const huge: Size = { width: 280, height: 180 };
  const target: Rect = { x: 20, y: 20, width: 260, height: 160 };
  const p = placeNear(target, huge, tiny);
  assert.ok(p.x >= tiny.x && p.x + huge.width <= tiny.x + tiny.width, "still fully on screen");
  assert.ok(p.y >= tiny.y && p.y + huge.height <= tiny.y + tiny.height);
});

test("arrowToward picks the octant and the head anchor for all 8 directions", () => {
  const from = { x: -100, y: -100 };
  const cases: readonly [dx: number, dy: number, direction: string, ax: number, ay: number][] = [
    [50, 0, "E", 1, 0.5],
    [50, 50, "SE", 1, 1],
    [0, 50, "S", 0.5, 1],
    [-50, 50, "SW", 0, 1],
    [-50, 0, "W", 0, 0.5],
    [-50, -50, "NW", 0, 0],
    [0, -50, "N", 0.5, 0],
    [50, -50, "NE", 1, 0],
  ];
  for (const [dx, dy, direction, ax, ay] of cases) {
    const plan = arrowToward(from, { x: from.x + dx, y: from.y + dy });
    assert.equal(plan.direction, direction, `delta ${dx},${dy}`);
    assert.deepEqual(plan.headAnchor, { x: ax, y: ay }, `anchor for ${direction}`);
  }
});

test("pixel/cell conversion rounds symmetrically and survives negatives", () => {
  const cell = { width: 7, height: 14 };
  assert.deepEqual(pixelsToCells({ x: -35, y: -28 }, cell), { x: -5, y: -2 });
  assert.deepEqual(pixelsToCells({ x: 10, y: 20 }, cell), { x: 1, y: 1 });
  assert.deepEqual(cellsToPixels({ x: -5, y: -2 }, cell), { x: -35, y: -28 });
  assert.throws(() => pixelsToCells({ x: 0, y: 0 }, { width: 0, height: 14 }), /measure/);
});

test("planTrail starts the dots at `from`, even when the path runs up and left", () => {
  const cell = { width: 10, height: 20 };
  const rightward = planTrail({ x: 100, y: 100 }, { x: 170, y: 100 }, cell);
  assert.equal(rightward.x, 100);
  assert.equal(rightward.y, 100);
  assert.equal(rightward.grid.rows[0]?.[7], "▶");

  // Up-left across the display seam into negative coordinates: the grid's
  // top-left is the DESTINATION, so the origin shifts by the full span.
  const upLeft = planTrail({ x: 100, y: 100 }, { x: 20, y: -60 }, cell);
  assert.equal(upLeft.x, 20);
  assert.equal(upLeft.y, -60);
  assert.equal(upLeft.grid.rows[0]?.[0], "↖");
  assert.equal(upLeft.grid.rows[upLeft.grid.h - 1]?.[upLeft.grid.w - 1], "·");
});
