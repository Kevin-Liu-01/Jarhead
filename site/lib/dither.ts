/**
 * The dither material (Dither.swift, scripts/dither.ts; facts-orb.md §1, §4): the classic 8×8 Bayer
 * tile, the five ramps, the ordered quantiser, and the canvas renderers every shaded surface on the
 * site shares. Flat fills stay flat; anything that shades is banded and dithered so the pattern is
 * seen. Pure functions: no DOM beyond the canvas passed in, one ImageData per render.
 */

export type RGB = readonly [number, number, number];
export type Stops = ReadonlyArray<readonly [number, RGB]>;

/** The raw ranks (0…63) of the 8×8 Bayer matrix, row-major (Dither.swift:127; dither.ts:50-59). */
const BAYER8_RANKS: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/** The matrix as thresholds in (0,1): (rank + 0.5) / 64. */
export const BAYER8: Float32Array = Float32Array.from(BAYER8_RANKS, (r) => (r + 0.5) / 64);

/** The orb: pale cyan upper-left through the accent blues to a deep blue, no violet (Dither.swift:60-66). */
export const ORB_STOPS: Stops = [
  [0, [160, 240, 255]],
  [0.24, [90, 215, 255]],
  [0.5, [91, 130, 255]],
  [0.74, [47, 92, 224]],
  [1, [24, 58, 168]],
];

/** The quiet mark: the orb's five bands in titanium's hue, for a conversation that is over (Dither.swift:72-78). */
export const QUIET_STOPS: Stops = [
  [0, [169, 173, 181]],
  [0.24, [138, 143, 152]],
  [0.5, [102, 106, 114]],
  [0.74, [70, 74, 81]],
  [1, [46, 49, 55]],
];

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function mix3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Piecewise-linear colour at `u` along the stops: the first colour at or before the first stop, the last past the last. */
export function rampAt(stops: Stops, u: number): RGB {
  const first = stops[0];
  if (!first) return [7, 7, 7];
  if (u <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i];
    const lo = stops[i - 1];
    if (!hi || !lo) break;
    if (u <= hi[0]) return mix3(lo[1], hi[1], (u - lo[0]) / (hi[0] - lo[0]));
  }
  return stops[stops.length - 1]?.[1] ?? [255, 255, 255];
}

/** The ramp sampled at bands + 1 levels: a pixel is a lookup. */
export function lut(stops: Stops, bands: number): RGB[] {
  const out: RGB[] = [];
  for (let i = 0; i <= bands; i++) out.push(rampAt(stops, i / bands));
  return out;
}

/** The ordered quantiser: min(levels, floor(clamp01(v) · levels + t)) / levels. */
export function quantise(v: number, levels: number, t: number): number {
  return Math.min(levels, Math.floor(clamp01(v) * levels + t)) / levels;
}

/** A cell of `pt` points in CSS px, whole device pixels: max(1, round(dpr · pt)) / dpr. */
export function cellCss(pt: number, dpr?: number): number {
  const d = dpr ?? (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  return Math.max(1, Math.round(d * pt)) / d;
}

/**
 * Calls `fn` whenever the device pixel ratio changes (the window moves to another display, the browser zooms), so a
 * canvas sized in device px can re-size; the query is re-armed at each new ratio. Returns the unsubscribe.
 */
export function watchDpr(fn: () => void): () => void {
  if (typeof window === "undefined" || typeof matchMedia !== "function") return () => undefined;
  let mq: MediaQueryList | null = null;
  function arm(): void {
    mq?.removeEventListener("change", changed);
    mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", changed);
  }
  function changed(): void {
    arm();
    fn();
  }
  arm();
  return () => mq?.removeEventListener("change", changed);
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)`, `rgba(…)` → RGB (alpha dropped). Anything else → ink. */
export function parseColor(css: string): RGB {
  const s = css.trim();
  if (s.startsWith("#")) {
    const x = s.slice(1);
    if (x.length === 3 || x.length === 4) {
      return [parseInt((x[0] ?? "0").repeat(2), 16), parseInt((x[1] ?? "0").repeat(2), 16), parseInt((x[2] ?? "0").repeat(2), 16)];
    }
    if (x.length >= 6) return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [7, 7, 7];
}

/** Little-endian ABGR for a Uint32 view of ImageData. */
function pack(c: RGB, alpha = 255): number {
  return ((alpha << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext("2d");
}

/**
 * A meter (Dither.swift:937-1015): a flat track, a flat fill and an 8-cell Bayer leading edge, in 1.5 px
 * cells (6 px tall = 4 rows). Cell (i, j) of the edge is fill iff BAYER8[j·8+i] ≥ (i + .5) / 8.
 */
export function renderMeter(
  canvas: HTMLCanvasElement,
  o: { width: number; height: number; fraction: number; fill: RGB; track: RGB },
): void {
  const cell = cellCss(1.5);
  const nx = Math.max(1, Math.round(o.width / cell));
  const ny = Math.max(1, Math.round(o.height / cell));
  canvas.width = nx;
  canvas.height = ny;
  canvas.style.width = `${o.width}px`;
  canvas.style.height = `${o.height}px`;
  const g = context(canvas);
  if (!g) return;
  const img = g.createImageData(nx, ny);
  const px = new Uint32Array(img.data.buffer);
  const F = pack(o.fill);
  const T = pack(o.track);
  const fillCells = Math.floor(clamp01(o.fraction) * nx);
  const edgeStart = fillCells - 8;
  for (let y = 0; y < ny; y++) {
    const row = (y & 7) * 8;
    const base = y * nx;
    for (let x = 0; x < nx; x++) {
      let on = x < fillCells;
      if (on && x >= edgeStart) {
        const i = x - edgeStart;
        on = (BAYER8[row + (i & 7)] ?? 0) >= (i + 0.5) / 8;
      }
      px[base + x] = on ? F : T;
    }
  }
  g.putImageData(img, 0, 0);
}

const GLYPH_RAMP = " .:-=+*#%@";

/**
 * The loading ramp (Dither.swift:1017-1046): one glyph per tile cell, glyph = ramp[((rank + 8·frame) % 64) · 10 / 64],
 * frame 0…7 at 8 fps. Still: "." below rank 32, "#" above. Returns one string per row.
 */
export function ditherGlyphs(cols: number, rows: number, frame: number, still?: boolean): string[] {
  const out: string[] = [];
  const f = ((Math.floor(frame) % 8) + 8) % 8;
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      const rank = BAYER8_RANKS[(y & 7) * 8 + (x & 7)] ?? 0;
      if (still) line += rank < 32 ? "." : "#";
      else line += GLYPH_RAMP[Math.floor((((rank + 8 * f) % 64) * 10) / 64)] ?? " ";
    }
    out.push(line);
  }
  return out;
}
