/**
 * Placement — pure geometry over global screen pixels.
 *
 * Same coordinate space as display.ts in the overlay: macOS puts every
 * display in one plane where a screen above or left of the primary has
 * negative origins (the second display here starts at y=-2160). All the math
 * below is translation-invariant for exactly that reason — nothing may
 * assume (0,0) is a corner of anything.
 */

import { directionOf, trail, trailOrigin, type Direction, type Grid } from "./shapes.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One monospace cell in pixels, as measured by the renderer. */
export interface CellSize {
  readonly width: number;
  readonly height: number;
}

export type PlacementSide = "right" | "left" | "below" | "above";

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly side: PlacementSide;
}

/** Breathing room between an annotation and its target, so the two never read as one blob. */
const GAP = 12;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Choose where to put an annotation of `size` relative to `target` so it
 * stays fully on `screen` and never covers the target — a label sitting on
 * top of the thing it explains is worse than no label.
 *
 * Sides are tried right, left, below, above: reading order first, then the
 * vertical fallbacks. Only the free axis is clamped per candidate; the side
 * axis is what guarantees separation from the target, so clamping it would
 * quietly reintroduce the overlap this function exists to prevent.
 */
export function placeNear(target: Rect, size: Size, screen: Rect): Placement {
  const cx = (x: number): number => clamp(x, screen.x, screen.x + screen.width - size.width);
  const cy = (y: number): number => clamp(y, screen.y, screen.y + screen.height - size.height);
  const midX = target.x + (target.width - size.width) / 2;
  const midY = target.y + (target.height - size.height) / 2;

  const candidates: readonly Placement[] = [
    { side: "right", x: target.x + target.width + GAP, y: cy(midY) },
    { side: "left", x: target.x - GAP - size.width, y: cy(midY) },
    { side: "below", x: cx(midX), y: target.y + target.height + GAP },
    { side: "above", x: cx(midX), y: target.y - GAP - size.height },
  ];
  for (const candidate of candidates) {
    const fits =
      candidate.x >= screen.x &&
      candidate.x + size.width <= screen.x + screen.width &&
      candidate.y >= screen.y &&
      candidate.y + size.height <= screen.y + screen.height;
    if (fits) return candidate;
  }

  // No side has room (an annotation nearly as big as the screen). Staying on
  // screen beats staying off the target: clamp the preferred side fully in,
  // overlap and all, because a half-visible label is the one truly useless
  // outcome.
  return { side: "right", x: cx(target.x + target.width + GAP), y: cy(midY) };
}

export interface ArrowPlan {
  readonly direction: Direction;
  /**
   * Where the head sits inside the arrow's bounding box, as fractions of its
   * size. Multiply by the rendered box in pixels and subtract from the target
   * point to get the box's top-left — that is what pins the TIP to the
   * target, for any arrow length, instead of pinning the box corner and
   * letting the tip drift with length.
   */
  readonly headAnchor: Point;
}

const HEAD_ANCHOR: Record<Direction, Point> = {
  N: { x: 0.5, y: 0 },
  NE: { x: 1, y: 0 },
  E: { x: 1, y: 0.5 },
  SE: { x: 1, y: 1 },
  S: { x: 0.5, y: 1 },
  SW: { x: 0, y: 1 },
  W: { x: 0, y: 0.5 },
  NW: { x: 0, y: 0 },
};

/**
 * Plan an arrow that points from `from` (say, a label) at `to` (the target):
 * the octant picks which glyph set actually points the right way, and the
 * anchor says which corner of the rendered grid to pin to the target.
 */
export function arrowToward(from: Point, to: Point): ArrowPlan {
  const direction = directionOf(to.x - from.x, to.y - from.y);
  return { direction, headAnchor: HEAD_ANCHOR[direction] };
}

export function pixelsToCells(px: Point, cell: CellSize): Point {
  if (cell.width <= 0 || cell.height <= 0) throw new Error("cell size must be positive — measure it first");
  return { x: Math.round(px.x / cell.width), y: Math.round(px.y / cell.height) };
}

export function cellsToPixels(cells: Point, cell: CellSize): Point {
  return { x: cells.x * cell.width, y: cells.y * cell.height };
}

export interface TrailPlan {
  readonly grid: Grid;
  /** Global pixel top-left for the rendered grid. */
  readonly x: number;
  readonly y: number;
}

/**
 * A "move from here to there" trail between two global pixel points. Bridges
 * the two coordinate systems: shapes.trail() lives in cells with its own
 * top-left origin, and this converts through the measured cell so the dots
 * genuinely start at `from` — including when `to` is up-left of it and the
 * start is therefore mid-grid.
 */
export function planTrail(from: Point, to: Point, cell: CellSize): TrailPlan {
  // Same guard pixelsToCells has: a zero or negative cell size means the metrics
  // probe has not reported yet, and dividing by it yields Infinity cells and an
  // attempt to allocate an infinite grid.
  if (!(cell.width > 0) || !(cell.height > 0)) {
    return { grid: trail(0, 0), x: from.x, y: from.y };
  }
  const dx = Math.round((to.x - from.x) / cell.width);
  const dy = Math.round((to.y - from.y) / cell.height);
  const origin = trailOrigin(dx, dy);
  return {
    // Aspect passed through so the head points where the trail visually goes,
    // not where it goes in cell space.
    grid: trail(dx, dy, cell.height / cell.width),
    x: from.x - origin.x * cell.width,
    y: from.y - origin.y * cell.height,
  };
}
