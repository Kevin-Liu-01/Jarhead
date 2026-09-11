import type { Rect } from "@jarhead/protocol";
import type { ScreenshotResult } from "./native.ts";

/**
 * The model reasons in the pixel space of the last full screenshot it saw; the
 * helper acts in global points. This is the one place the two meet.
 *
 * Kept as an object rather than free functions because the mapping is stateful:
 * a click issued after a screenshot of display 5 must map through display 5's
 * rect, even if the cursor has since moved to display 1.
 */
export interface ScreenMapping {
  readonly displayId: number;
  readonly points: Rect;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface ShotBudget {
  /** Longest image edge in pixels. Claude Opus 5 accepts up to 2576. */
  readonly maxLongEdge: number;
  /** Total pixels. Claude Opus 5 accepts ~3.75 MP; smaller is faster and cheaper. */
  readonly maxPixels: number;
}

export const DEFAULT_SHOT_BUDGET: ShotBudget = { maxLongEdge: 2000, maxPixels: 2_500_000 };

/**
 * The quick budget: what a screenshot costs when the point is to act now, not to
 * read small print — the pre-warm shot handed to a brain as its task begins, a
 * reflex "screenshot this", the bench. A 1280-pixel long edge is a quarter of the
 * pixels of the default and encodes in roughly a third of the time; zoom is there
 * for anything that needs the full budget.
 */
export const QUICK_SHOT_BUDGET: ShotBudget = { maxLongEdge: 1280, maxPixels: 1_100_000 };

export class Screen {
  private mapping: ScreenMapping | undefined;

  get last(): ScreenMapping | undefined {
    return this.mapping;
  }

  remember(shot: ScreenshotResult): ScreenMapping {
    this.mapping = { displayId: shot.displayId, points: shot.points, width: shot.width, height: shot.height, scale: shot.scale };
    return this.mapping;
  }

  /** Image pixel → global point. Throws when no screenshot has been taken yet. */
  toPoints(px: number, py: number): { x: number; y: number } {
    const m = this.mapping;
    if (!m) throw new Error("no screenshot yet: take a screenshot before using coordinates");
    return { x: m.points.x + px / m.scale, y: m.points.y + py / m.scale };
  }

  /** Global point → image pixel of the last screenshot (for drawing/annotating). */
  fromPoints(x: number, y: number): { x: number; y: number } {
    const m = this.mapping;
    if (!m) throw new Error("no screenshot yet");
    return { x: (x - m.points.x) * m.scale, y: (y - m.points.y) * m.scale };
  }

  /** A [x0,y0,x1,y1] image region → global rect, clamped to the screenshot. */
  regionToRect(region: readonly number[]): Rect {
    const m = this.mapping;
    if (!m) throw new Error("no screenshot yet: take a screenshot before zooming");
    const [ax = 0, ay = 0, bx = 0, by = 0] = region;
    const x0 = Math.max(0, Math.min(ax, bx));
    const y0 = Math.max(0, Math.min(ay, by));
    const x1 = Math.min(m.width, Math.max(ax, bx));
    const y1 = Math.min(m.height, Math.max(ay, by));
    const a = this.toPoints(x0, y0);
    const b = this.toPoints(x1, y1);
    return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
  }
}

/** Scale factor so an image of w×h pixels fits the budget. Never upscales. */
export function fitScale(w: number, h: number, budget: ShotBudget = DEFAULT_SHOT_BUDGET): number {
  const long = Math.max(w, h);
  const byEdge = budget.maxLongEdge / long;
  const byArea = Math.sqrt(budget.maxPixels / (w * h));
  return Math.min(1, byEdge, byArea);
}
