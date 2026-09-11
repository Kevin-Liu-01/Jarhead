/**
 * ASCII drawing primitives — pure functions from parameters to a character
 * grid.
 *
 * Everything visible on the annotation layer is born here, in cell space,
 * with no idea that pixels or displays exist. That split is what makes the
 * layer testable: the renderer only positions and fades <pre> blocks, so
 * every judgement call — which glyph points north-east, how a circle
 * compensates for tall cells, what wins when shapes overlap — lives in this
 * file where node:test can see it.
 *
 * Invariant: every row of a Grid is exactly `w` characters. Ragged rows made
 * compose() and the renderer each grow their own padding logic; one invariant
 * here is cheaper than two workarounds there.
 */

export interface Grid {
  readonly rows: readonly string[];
  readonly w: number;
  readonly h: number;
}

export const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && (DIRECTIONS as readonly string[]).includes(value);
}

export type BracketSide = "left" | "right";

function blank(w: number, h: number): string[][] {
  const cells: string[][] = [];
  for (let y = 0; y < h; y++) cells.push(new Array<string>(w).fill(" "));
  return cells;
}

function put(cells: string[][], x: number, y: number, ch: string): void {
  const row = cells[y];
  if (row && x >= 0 && x < row.length) row[x] = ch;
}

function toGrid(cells: readonly (readonly string[])[]): Grid {
  const rows = cells.map((row) => row.join(""));
  return { rows, w: cells[0]?.length ?? 0, h: rows.length };
}

/**
 * Head glyphs per direction. Cardinals use the solid triangles because they
 * still read as arrowheads at 12px; the diagonal triangles (◤◥◣◢) do not —
 * they read as clipped corners — so diagonals use real arrow glyphs instead.
 */
const HEAD: Record<Direction, string> = {
  N: "▲",
  NE: "↗",
  E: "▶",
  SE: "↘",
  S: "▼",
  SW: "↙",
  W: "◀",
  NW: "↖",
};

/**
 * An arrow of `length` cells pointing `direction`.
 *
 * Diagonal shafts are the box-drawing diagonals ╱ and ╲ rather than / and \
 * because the box-drawing pair spans the full cell, so consecutive cells
 * join into one continuous stroke instead of a dashed stair-step.
 */
export function arrow(direction: Direction, length: number): Grid {
  // A head with no shaft is just a triangle floating in space; two cells is
  // the smallest thing that still reads as "arrow".
  const n = Math.max(2, Math.floor(length));
  const head = HEAD[direction];
  const shaft = (count: number, glyph: string): string[] => Array.from({ length: count }, () => glyph);

  switch (direction) {
    case "E":
      return { rows: ["─".repeat(n - 1) + head], w: n, h: 1 };
    case "W":
      return { rows: [head + "─".repeat(n - 1)], w: n, h: 1 };
    case "S":
      return { rows: [...shaft(n - 1, "│"), head], w: 1, h: n };
    case "N":
      return { rows: [head, ...shaft(n - 1, "│")], w: 1, h: n };
    case "NE": {
      const cells = blank(n, n);
      put(cells, n - 1, 0, head);
      for (let i = 1; i < n; i++) put(cells, n - 1 - i, i, "╱");
      return toGrid(cells);
    }
    case "SW": {
      const cells = blank(n, n);
      for (let i = 0; i < n - 1; i++) put(cells, n - 1 - i, i, "╱");
      put(cells, 0, n - 1, head);
      return toGrid(cells);
    }
    case "SE": {
      const cells = blank(n, n);
      for (let i = 0; i < n - 1; i++) put(cells, i, i, "╲");
      put(cells, n - 1, n - 1, head);
      return toGrid(cells);
    }
    case "NW": {
      const cells = blank(n, n);
      put(cells, 0, 0, head);
      for (let i = 1; i < n; i++) put(cells, i, i, "╲");
      return toGrid(cells);
    }
  }
}

/**
 * A ring — never filled, because a circle exists to point at something and a
 * filled disc would hide it.
 *
 * `aspect` is cell height over width, measured by the renderer the same way
 * overlay.js measures it. It must be a parameter: hardcoding the ratio in the
 * overlay produced a blob stretched nearly 2:1, and the same mistake here
 * would draw eggs. The radius counts rows; columns get radius × aspect so the
 * ring is round in pixels.
 *
 * Each cell's glyph comes from the rim's tangent there (─ where it runs
 * flat, │ where it runs steep, ╱╲ between), which is what makes a grid of
 * glyphs read as a smooth curve instead of a blocky diamond. The rim is
 * traced in two passes — the exact left/right cell for every row, then the
 * exact top/bottom cell for every column — because stepping an angle around
 * the ellipse instead smeared the steep sides two cells thick wherever
 * consecutive samples straddled a rounding boundary.
 */
export function circle(radiusCells: number, aspect: number): Grid {
  const r = Math.max(1, Math.floor(radiusCells));
  // 1.7 is the overlay's measured fallback for the same font stack — only
  // reached if a caller passes garbage before metrics arrive.
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.7;
  const rx = Math.max(1, Math.round(r * a));
  const cells = blank(rx * 2 + 1, r * 2 + 1);

  // (ct, st) is the unit-circle point; the tangent is judged in pixel space,
  // where the ellipse is a true circle again, so the glyph matches the slope
  // the eye actually sees.
  const glyphAt = (ct: number, st: number): string => {
    const steep = Math.abs(ct) / Math.max(1e-9, Math.abs(st));
    // Octant thresholds: tan(67.5°) ≈ 2.414, tan(22.5°) ≈ 0.414.
    return steep > 2.414 ? "│" : steep < 0.414 ? "─" : -st * ct > 0 ? "╲" : "╱";
  };

  for (let y = 0; y <= 2 * r; y++) {
    const st = (y - r) / r;
    const ct = Math.sqrt(Math.max(0, 1 - st * st));
    const dx = Math.round(ct * rx);
    put(cells, rx - dx, y, glyphAt(-ct, st));
    put(cells, rx + dx, y, glyphAt(ct, st));
  }
  for (let x = 0; x <= 2 * rx; x++) {
    const ct = (x - rx) / rx;
    const st = Math.sqrt(Math.max(0, 1 - ct * ct));
    const dy = Math.round(st * r);
    put(cells, x, r - dy, glyphAt(ct, -st));
    put(cells, x, r + dy, glyphAt(ct, st));
  }
  return toGrid(cells);
}

/** A rectangle outline. The interior is spaces, which compose() and the transparent renderer both treat as "leave what is underneath". */
export function box(w: number, h: number): Grid {
  const bw = Math.max(2, Math.floor(w));
  const bh = Math.max(2, Math.floor(h));
  const mid = "│" + " ".repeat(bw - 2) + "│";
  return {
    rows: [
      "┌" + "─".repeat(bw - 2) + "┐",
      ...Array.from({ length: bh - 2 }, () => mid),
      "└" + "─".repeat(bw - 2) + "┘",
    ],
    w: bw,
    h: bh,
  };
}

/**
 * A square bracket marking a vertical span, opening toward the content: a
 * "left" bracket sits to the left of what it marks, stubs pointing right.
 */
export function bracket(side: BracketSide, height: number): Grid {
  const bh = Math.max(2, Math.floor(height));
  const rows: string[] = [];
  for (let y = 0; y < bh; y++) {
    const edge = y === 0 ? "top" : y === bh - 1 ? "bottom" : "mid";
    if (side === "left") rows.push(edge === "top" ? "┌─" : edge === "bottom" ? "└─" : "│ ");
    else rows.push(edge === "top" ? "─┐" : edge === "bottom" ? "─┘" : " │");
  }
  return { rows, w: 2, h: bh };
}

/** Word-wrapped text, greedy, with words longer than the budget hard-broken rather than overflowing. */
export function label(text: string, maxWidth: number): Grid {
  const max = Math.max(1, Math.floor(maxWidth));
  const rows: string[] = [];
  let line = "";
  const flush = (): void => {
    if (line.length > 0) rows.push(line);
    line = "";
  };
  for (let word of text.split(/\s+/).filter((part) => part.length > 0)) {
    while (word.length > max) {
      flush();
      rows.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (word.length === 0) continue;
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= max) line += " " + word;
    else {
      flush();
      line = word;
    }
  }
  flush();
  const w = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return { rows: rows.map((row) => row.padEnd(w, " ")), w, h: rows.length };
}

/** A squiggle for marking text on screen — a tilde run, the proofreader's underline. */
export function underline(width: number): Grid {
  const w = Math.max(1, Math.floor(width));
  return { rows: ["~".repeat(w)], w, h: 1 };
}

/**
 * A crosshair with an open centre. The centre cell stays blank on purpose:
 * this shape means "your cursor is HERE", and a glyph on the exact point
 * would cover the very pixel it is calling out.
 */
export function crosshair(size: number): Grid {
  const wanted = Math.max(3, Math.floor(size));
  // Forced odd so a true centre cell exists; an even crosshair marks a seam
  // between four cells, none of which is the point.
  const s = wanted % 2 === 0 ? wanted + 1 : wanted;
  const mid = (s - 1) / 2;
  const cells = blank(s, s);
  for (let i = 0; i < s; i++) {
    if (i === mid) continue;
    put(cells, mid, i, "│");
    put(cells, i, mid, "─");
  }
  return toGrid(cells);
}

/**
 * Octant of a delta in screen coordinates, where y grows DOWNWARD — so
 * positive dy is S, and the second display's targets (negative y on this
 * machine) need no special casing because only the delta matters.
 */
export function directionOf(dx: number, dy: number): Direction {
  const OCTANTS: readonly Direction[] = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
  const index = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  return OCTANTS[index] ?? "E";
}

/**
 * A dotted path across `dx × dy` cells, ending in a directional head:
 * "move from here to there". Dots on every other step because a solid line
 * reads as a wall or an underline; gaps are what read as motion.
 *
 * The grid's own origin is its top-left, so a leftward or upward trail
 * starts mid-grid — trailOrigin() reports where, and layout.planTrail() does
 * the pixel arithmetic.
 */
export function trail(dxCells: number, dyCells: number, aspect = 1): Grid {
  const dx = Math.round(dxCells);
  const dy = Math.round(dyCells);
  const start = trailOrigin(dx, dy);
  const cells = blank(Math.abs(dx) + 1, Math.abs(dy) + 1);
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i += 2) {
    put(cells, Math.round(start.x + (dx * i) / steps), Math.round(start.y + (dy * i) / steps), "·");
  }
  // The head's direction is a VISUAL question, so it has to be asked in pixels.
  // Cells are ~1.7x taller than wide here, so a 10x10-cell delta looks like a
  // steep climb on screen, not a 45° diagonal — choosing the glyph from raw cell
  // deltas pointed the arrow noticeably wrong on anything off-axis.
  put(cells, start.x + dx, start.y + dy, HEAD[directionOf(dx * aspect, dy)]);
  return toGrid(cells);
}

/** Where the trail's starting point sits inside trail()'s grid, in cells. */
export function trailOrigin(dxCells: number, dyCells: number): { readonly x: number; readonly y: number } {
  const dx = Math.round(dxCells);
  const dy = Math.round(dyCells);
  return { x: dx < 0 ? -dx : 0, y: dy < 0 ? -dy : 0 };
}

export interface PlacedGrid {
  readonly grid: Grid;
  readonly x: number;
  readonly y: number;
}

/**
 * Merge positioned grids into one. Later parts draw over earlier ones, but a
 * SPACE never erases what is beneath it — blanks are transparency, not paint.
 * Without that rule a label's padding would punch holes in the circle it sits
 * on, and every composite would need hand-fitted bounding boxes.
 *
 * Offsets may be negative; the result is translated to its own bounding box.
 */
export function compose(parts: readonly PlacedGrid[]): Grid {
  if (parts.length === 0) return { rows: [], w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of parts) {
    minX = Math.min(minX, part.x);
    minY = Math.min(minY, part.y);
    maxX = Math.max(maxX, part.x + part.grid.w);
    maxY = Math.max(maxY, part.y + part.grid.h);
  }
  const cells = blank(maxX - minX, maxY - minY);
  for (const part of parts) {
    part.grid.rows.forEach((rowText, y) => {
      // Array.from, not charAt: label text is arbitrary model output, and
      // indexing through a surrogate pair would paint garbage halves.
      Array.from(rowText).forEach((ch, x) => {
        if (ch !== " ") put(cells, part.x - minX + x, part.y - minY + y, ch);
      });
    });
  }
  return toGrid(cells);
}

/**
 * The shape vocabulary the wire protocol speaks. One discriminated union
 * shared by protocol.ts (validation) and renderShape (drawing) so a shape
 * cannot exist that parses but does not render.
 */
export type ShapeSpec =
  | { readonly kind: "arrow"; readonly direction: Direction; readonly length: number }
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "box"; readonly w: number; readonly h: number }
  | { readonly kind: "bracket"; readonly side: BracketSide; readonly height: number }
  | { readonly kind: "label"; readonly text: string; readonly maxWidth: number }
  | { readonly kind: "underline"; readonly width: number }
  | { readonly kind: "crosshair"; readonly size: number };

/** Spec to grid. `aspect` comes from the renderer's measurement; only the circle needs it, but it is threaded here so callers never special-case. */
export function renderShape(spec: ShapeSpec, aspect: number): Grid {
  switch (spec.kind) {
    case "arrow":
      return arrow(spec.direction, spec.length);
    case "circle":
      return circle(spec.radius, aspect);
    case "box":
      return box(spec.w, spec.h);
    case "bracket":
      return bracket(spec.side, spec.height);
    case "label":
      return label(spec.text, spec.maxWidth);
    case "underline":
      return underline(spec.width);
    case "crosshair":
      return crosshair(spec.size);
  }
}
