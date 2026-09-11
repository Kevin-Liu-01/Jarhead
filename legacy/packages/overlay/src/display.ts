/**
 * Multi-display awareness — pure geometry over display rectangles.
 *
 * macOS arranges displays in one global coordinate space where a screen left
 * of or above the primary has negative origin coordinates. Electron's `screen`
 * module and the AX tree both speak that space, so no conversion happens here:
 * just containment, nearest-display selection, and clamping. The functions
 * take display lists as arguments (rather than reading `screen` themselves) so
 * they stay testable without Electron; main.ts supplies the live list.
 */

import type { Point } from "./pointer.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface DisplayInfo {
  readonly id: number;
  readonly bounds: Rect;
  readonly workArea: Rect;
}

/** Right and bottom edges are exclusive, matching how displays tile: a point on a shared edge belongs to exactly one screen. */
export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
  );
}

export function displayContaining(displays: readonly DisplayInfo[], point: Point): DisplayInfo | undefined {
  return displays.find((d) => containsPoint(d.bounds, point));
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function squaredDistanceToRect(rect: Rect, point: Point): number {
  const dx = point.x - clamp(point.x, rect.x, rect.x + rect.width - 1);
  const dy = point.y - clamp(point.y, rect.y, rect.y + rect.height - 1);
  return dx * dx + dy * dy;
}

/**
 * Containing display, or failing that the closest one. Non-aligned displays
 * leave dead zones in the global space, and a flyTo target one pixel into a
 * dead zone should land on the nearest screen — not abort the gesture.
 */
export function nearestDisplay(displays: readonly DisplayInfo[], point: Point): DisplayInfo {
  const containing = displayContaining(displays, point);
  if (containing) return containing;

  let best: DisplayInfo | undefined;
  let bestDistance = Infinity;
  for (const display of displays) {
    const d = squaredDistanceToRect(display.bounds, point);
    if (d < bestDistance) {
      bestDistance = d;
      best = display;
    }
  }
  if (!best) throw new Error("no displays reported — cannot place the overlay");
  return best;
}

/** Top-left that puts the window's anchor pixel (the buddy's pointer tip) on the target. */
export function windowTopLeftFor(target: Point, anchor: Point): Point {
  return { x: Math.round(target.x - anchor.x), y: Math.round(target.y - anchor.y) };
}

/**
 * Keeps the whole window on the display containing (or nearest to) the target.
 * The work area, not the raw bounds: a buddy parked under the menu bar or the
 * Dock is technically on screen and practically invisible.
 */
export function clampToWorkArea(topLeft: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: clamp(topLeft.x, workArea.x, Math.max(workArea.x, maxX)),
    y: clamp(topLeft.y, workArea.y, Math.max(workArea.y, maxY)),
  };
}
