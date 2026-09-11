import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrail } from "../layout.ts";
import {
  DIRECTIONS,
  arrow,
  box,
  bracket,
  circle,
  compose,
  crosshair,
  directionOf,
  label,
  renderShape,
  trail,
  trailOrigin,
  underline,
  type Grid,
} from "../shapes.ts";

function assertWellFormed(grid: Grid, name: string): void {
  assert.equal(grid.rows.length, grid.h, `${name}: h matches row count`);
  for (const row of grid.rows) assert.equal(row.length, grid.w, `${name}: every row is exactly w chars`);
}

test("arrows point the right way — exact glyph rows for all 8 directions", () => {
  assert.deepEqual(arrow("E", 4).rows, ["───▶"]);
  assert.deepEqual(arrow("W", 4).rows, ["◀───"]);
  assert.deepEqual(arrow("N", 3).rows, ["▲", "│", "│"]);
  assert.deepEqual(arrow("S", 3).rows, ["│", "│", "▼"]);
  // Diagonals: the head sits in the corner the arrow points at, and the
  // shaft runs the matching diagonal back from it.
  assert.deepEqual(arrow("NE", 3).rows, ["  ↗", " ╱ ", "╱  "]);
  assert.deepEqual(arrow("SE", 3).rows, ["╲  ", " ╲ ", "  ↘"]);
  assert.deepEqual(arrow("SW", 3).rows, ["  ╱", " ╱ ", "↙  "]);
  assert.deepEqual(arrow("NW", 3).rows, ["↖  ", " ╲ ", "  ╲"]);
});

test("arrow dimensions: cardinals are 1×n lines, diagonals are n×n squares", () => {
  for (const direction of DIRECTIONS) {
    const a = arrow(direction, 6);
    assertWellFormed(a, `arrow ${direction}`);
    if (direction === "E" || direction === "W") {
      assert.equal(a.w, 6);
      assert.equal(a.h, 1);
    } else if (direction === "N" || direction === "S") {
      assert.equal(a.w, 1);
      assert.equal(a.h, 6);
    } else {
      assert.equal(a.w, 6);
      assert.equal(a.h, 6);
    }
  }
  // A degenerate length still yields a head plus one shaft cell.
  assert.deepEqual(arrow("E", 0).rows, ["─▶"]);
});

test("circle sizes with the cell aspect: taller cells need more columns", () => {
  const square = circle(3, 1);
  const tall = circle(3, 2);
  assertWellFormed(square, "circle aspect 1");
  assertWellFormed(tall, "circle aspect 2");
  // Rows depend only on the radius; columns stretch by the aspect so the
  // ring stays round in pixels.
  assert.equal(square.h, 7);
  assert.equal(tall.h, 7);
  assert.equal(square.w, 7);
  assert.equal(tall.w, 13);
});

test("circle is a ring, not a disc, and the rim is closed at the extremes", () => {
  for (const aspect of [1, 1.7, 2.2]) {
    const g = circle(4, aspect);
    const midRow = (g.h - 1) / 2;
    const midCol = (g.w - 1) / 2;
    // Centre and its neighbourhood stay empty so the target underneath shows.
    assert.equal(g.rows[midRow]?.[midCol], " ", `aspect ${aspect}: centre is transparent`);
    assert.equal(g.rows[midRow]?.[midCol + 1], " ", `aspect ${aspect}: interior is transparent`);
    // The four extreme points exist and use the glyph matching the rim's
    // slope there: flat top/bottom, steep sides.
    assert.equal(g.rows[0]?.[midCol], "─", `aspect ${aspect}: top rim`);
    assert.equal(g.rows[g.h - 1]?.[midCol], "─", `aspect ${aspect}: bottom rim`);
    assert.equal(g.rows[midRow]?.[0], "│", `aspect ${aspect}: left rim`);
    assert.equal(g.rows[midRow]?.[g.w - 1], "│", `aspect ${aspect}: right rim`);
  }
});

test("circle survives a garbage aspect by falling back, not by drawing a line", () => {
  const g = circle(2, Number.NaN);
  assertWellFormed(g, "circle NaN aspect");
  assert.ok(g.w > g.h, "fallback aspect still widens the ring");
});

test("box is an outline with a transparent interior", () => {
  const g = box(5, 4);
  assert.deepEqual(g.rows, ["┌───┐", "│   │", "│   │", "└───┘"]);
  assert.equal(g.w, 5);
  assert.equal(g.h, 4);
});

test("bracket opens toward the span it marks", () => {
  assert.deepEqual(bracket("left", 4).rows, ["┌─", "│ ", "│ ", "└─"]);
  assert.deepEqual(bracket("right", 3).rows, ["─┐", " │", "─┘"]);
  assertWellFormed(bracket("left", 7), "bracket");
});

test("label wraps by words, hard-breaks oversized words, and stays bounded", () => {
  const g = label("point at the settings icon", 10);
  assertWellFormed(g, "label");
  assert.ok(g.w <= 10);
  assert.deepEqual(
    g.rows.map((r) => r.trimEnd()),
    ["point at", "the", "settings", "icon"],
  );

  const broken = label("supercalifragilistic", 6);
  assert.ok(broken.rows.every((r) => r.length <= 6));
  assert.equal(broken.rows.map((r) => r.trimEnd()).join(""), "supercalifragilistic");
});

test("underline spans the requested width", () => {
  const g = underline(8);
  assert.deepEqual(g.rows, ["~~~~~~~~"]);
  assert.equal(g.h, 1);
});

test("crosshair keeps its centre open so the marked point stays visible", () => {
  const g = crosshair(5);
  assert.deepEqual(g.rows, ["  │  ", "  │  ", "── ──", "  │  ", "  │  "]);
  // An even size is bumped to odd — a seam between cells cannot mark a point.
  assert.equal(crosshair(6).w, 7);
});

test("compose overlays later parts but spaces never erase what is beneath", () => {
  const base = underline(5);
  const over: Grid = { rows: [" X "], w: 3, h: 1 };
  const merged = compose([
    { grid: base, x: 0, y: 0 },
    { grid: over, x: 0, y: 0 },
  ]);
  // X painted over the middle; the spaces flanking it left the tildes alone.
  assert.deepEqual(merged.rows, ["~X~~~"]);

  // Non-space glyphs do overwrite.
  const solid = compose([
    { grid: underline(3), x: 0, y: 0 },
    { grid: { rows: ["ABC"], w: 3, h: 1 }, x: 0, y: 0 },
  ]);
  assert.deepEqual(solid.rows, ["ABC"]);
});

test("compose handles negative offsets by growing the bounding box", () => {
  const merged = compose([
    { grid: { rows: ["ab"], w: 2, h: 1 }, x: 0, y: 0 },
    { grid: { rows: ["Z"], w: 1, h: 1 }, x: -2, y: -1 },
  ]);
  assert.equal(merged.w, 4);
  assert.equal(merged.h, 2);
  assert.deepEqual(merged.rows, ["Z   ", "  ab"]);
  assert.deepEqual(compose([]).rows, []);
});

test("directionOf maps screen-space deltas (y down) to octants", () => {
  assert.equal(directionOf(10, 0), "E");
  assert.equal(directionOf(10, 10), "SE");
  assert.equal(directionOf(0, 10), "S");
  assert.equal(directionOf(-10, 10), "SW");
  assert.equal(directionOf(-10, 0), "W");
  assert.equal(directionOf(-10, -10), "NW");
  assert.equal(directionOf(0, -10), "N");
  assert.equal(directionOf(10, -10), "NE");
});

test("trail is dotted, ends in a head pointing the travel direction, and handles negative deltas", () => {
  const east = trail(6, 0);
  assert.equal(east.h, 1);
  assert.equal(east.rows[0]?.[0], "·");
  assert.equal(east.rows[0]?.[6], "▶");
  // Dotted: at least one gap between the dots.
  assert.ok(east.rows[0]?.includes(" "), "a solid line is not a trail");

  const upLeft = trail(-4, -4);
  assert.deepEqual(trailOrigin(-4, -4), { x: 4, y: 4 });
  // Start dot at the origin cell (bottom-right for an up-left move), head at
  // the far corner.
  assert.equal(upLeft.rows[4]?.[4], "·");
  assert.equal(upLeft.rows[0]?.[0], "↖");
});

test("renderShape dispatches every spec kind to its drawing function", () => {
  assert.deepEqual(renderShape({ kind: "arrow", direction: "E", length: 4 }, 1.7).rows, ["───▶"]);
  assert.equal(renderShape({ kind: "circle", radius: 3 }, 2).w, 13);
  assert.equal(renderShape({ kind: "box", w: 4, h: 3 }, 1.7).h, 3);
  assert.equal(renderShape({ kind: "bracket", side: "right", height: 5 }, 1.7).w, 2);
  assert.equal(renderShape({ kind: "label", text: "hi there", maxWidth: 3 }, 1.7).h, 3);
  assert.equal(renderShape({ kind: "underline", width: 6 }, 1.7).w, 6);
  assert.equal(renderShape({ kind: "crosshair", size: 5 }, 1.7).w, 5);
});

test("the trail head points where the trail visually goes, not where it goes in cells", () => {
  // Cells are ~1.7x taller than wide, so a square cell delta is a steep climb on
  // screen. Choosing the glyph from raw cell deltas pointed it noticeably wrong.
  const square = trail(20, -10, 1);
  const real = trail(20, -10, 1.7);
  const headOf = (g: ReturnType<typeof trail>): string =>
    g.rows.join("").split("").find((c) => c !== " " && c !== "·") ?? "";
  assert.notEqual(headOf(square), headOf(real), "aspect must change the chosen head glyph");
});

test("a degenerate cell size cannot allocate an infinite grid", () => {
  const plan = planTrail({ x: 0, y: 0 }, { x: 500, y: 500 }, { width: 0, height: 0 });
  assert.ok(plan.grid.rows.length < 5, "should degrade to an empty trail, not explode");
});
