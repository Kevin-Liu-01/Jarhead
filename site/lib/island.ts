/**
 * The island's ink and its instruments (UI/Orb/NotchInk.swift render(_:), NotchPanel.swift drawSweep and drawLevelTrace).
 *
 * The ink: the island is the notch grown, one black silhouette from the page's top edge (the band over the bar is pure
 * black, styles/site.css .top-band), and the orb's blue pours out of that black into the body, as the app's island does:
 * deepest under the notch, falling away diagonally over the wings to the outer corners, so the black reads as poured
 * into the blue and never as a strip laid along the top. Under it the orb ramp runs diagonally (pale toward the face's
 * corner, the deep blue at the far one) with the icon's pale-cyan highlight at the left end, and a slight vignette lets
 * the words read to the edges, the light falling toward the foot (FOOT_SHADE). Every kind wears it, asleep included: the
 * island is one material, as the app's is.
 *
 * Two quantities per 1.5 island px cell (the app's 1.5 pt, so the grain is the same share of the island docked as open)
 * and ONE threshold per cell (the 8×8 Bayer tile): where the cell is on the ramp `u`
 * (the highlight folded in, BANDS steps) and how much light it keeps `k` (the vignette folded in, LIGHT steps), its
 * colour the ramp's band times the light's step. Both round the same way on the threshold: a cell that steps toward the
 * deep end also steps toward the black (the light on `1 - t`), so the two errors add into one crosshatch, as the installed
 * app's did; rounded against each other they cancelled into vertical streaks and lost most of the grain. The light going
 * (the pour, the vignette) also walks the ramp toward its deep end, so the black pools through navy, never through a muddy
 * teal (the pale cyan dimmed). The app's island stacked four dithers (ramp, highlight, black, vignette) whose steps
 * crossed; here two, on one threshold, so every step edge runs with the pour and the ramp, and the field is calm. The first rows under the band are black outright, so the join never
 * shows a dithered fringe. One buffer pixel per cell; the canvas covers the whole body (rounded up a cell) and the body's
 * own rounded clip trims it, so the ink meets the contour with no frame of black; it is upscaled with image-rendering:
 * pixelated by the caller's CSS.
 */
import { BAYER8, ORB_STOPS, cellCss, clamp01, lut, smoothstep, type RGB } from "@/lib/dither";

/** The ramp's steps (the app's five, one more so the blues step gently) and the black's. */
const BANDS = 6;
const LIGHT = 6;
/** The ramp across the body (0 the pale end … 1 the deep end): BIAS at the top-left, BIAS + SPAN at the bottom-right. */
const BIAS = 0.16;
const SPAN = 0.84;
const ACROSS = 0.68;
const DOWN = 0.32;
/** The pour: the notch's half-width, and how far down the black reaches under it and at the island's ends (of the height). */
const NOTCH_HALF = 92.5;
const UNDER = 0.76;
const ENDS = 0.26;
/** The highlight: the icon's pale-cyan spot at the left end, a third of the way down, and its pull to the pale end. */
const HL_X = 2;
const HL_Y = 0.36;
const HL_SIGMA = 20;
const HL = 0.45;
/** The vignette's depth, from 0.55 of the way to an edge. */
const VIGNETTE = 0.24;
/** The rows under the band kept black (island px). */
const SOLID = 2;
/**
 * The light falls toward the foot: by FOOT_SHADE from FOOT_TOP island px above the body's bottom edge (under the middle
 * beat) to FOOT_FULL above it (the foot's words), so the foot's 0.72 clause and 0.92 noun clear 4.5:1 over the ramp's pale
 * end, where they fell to 2.5:1, and the Say box's placeholder with them. A long fall, never a band: over the seam's 12 px
 * alone it read as a dark footer bar. Its light going walks the ramp to navy there too.
 */
const FOOT_SHADE = 0.35;
const FOOT_TOP = 90;
const FOOT_FULL = 20;

interface Buf { n: number; m: number; img: ImageData; px: Uint32Array; g: CanvasRenderingContext2D }
const bufs = new WeakMap<HTMLCanvasElement, Buf>();
const RAMP = lut(ORB_STOPS, BANDS);

interface IslandInkOptions {
  width: number;
  height: number;
  /** Cell size in the canvas's own CSS px (default 1.5 CSS px on screen). */
  cell?: number;
}

export function renderIslandInk(canvas: HTMLCanvasElement, o: IslandInkOptions): void {
  const cell = o.cell ?? cellCss(1.5);
  const W = o.width;
  const H = o.height;
  // rounded up: the canvas covers the body to its edges (the body clips the excess), so no black shows past the ink
  const n = Math.max(1, Math.ceil(W / cell));
  const m = Math.max(1, Math.ceil(H / cell));
  let b = bufs.get(canvas);
  if (!b || b.n !== n || b.m !== m) {
    canvas.width = n;
    canvas.height = m;
    const g = canvas.getContext("2d");
    if (!g) return;
    const img = g.createImageData(n, m);
    b = { n, m, img, px: new Uint32Array(img.data.buffer), g };
    bufs.set(canvas, b);
  }
  canvas.style.width = `${n * cell}px`;
  canvas.style.height = `${m * cell}px`;
  const half = Math.min(W / 2, NOTCH_HALF);
  const wing = Math.max(1, W / 2 - half);
  const hx = HL_X;
  const hy = HL_Y * H;
  const sig2 = 2 * HL_SIGMA * HL_SIGMA;
  const px = b.px;
  for (let y = 0; y < m; y++) {
    const yPt = (y + 0.5) * cell;
    const fy = yPt / H;
    const row = (y & 7) * 8;
    const vy = Math.abs(fy - 0.5) * 2 * 0.9;
    const hlRow = HL * Math.exp(-((yPt - hy) ** 2) / sig2);
    const foot = 1 - FOOT_SHADE * smoothstep(H - FOOT_TOP, H - FOOT_FULL, yPt);
    for (let x = 0; x < n; x++) {
      const t = BAYER8[row + (x & 7)]!;
      let c: RGB = [0, 0, 0];
      let k = 0;
      if (yPt >= SOLID) {
        const xPt = (x + 0.5) * cell;
        const fx = xPt / W;
        const reach = UNDER + (ENDS - UNDER) * smoothstep(0, 1, clamp01((Math.abs(xPt - W / 2) - half) / wing));
        const lit = smoothstep(0, reach, fy) * (1 - VIGNETTE * smoothstep(0.55, 1, Math.max(Math.abs(fx - 0.5) * 2, vy))) * foot;
        let u = BIAS + SPAN * (ACROSS * fx + DOWN * fy);
        u -= u * hlRow * Math.exp(-((xPt - hx) ** 2) / sig2);
        u = 1 - (1 - clamp01(u)) * lit;
        c = RAMP[Math.min(BANDS, Math.floor(u * BANDS + t))]!;
        k = Math.min(LIGHT, Math.floor(clamp01(lit) * LIGHT + 1 - t)) / LIGHT;
      }
      px[y * n + x] = (255 << 24) | ((Math.round(c[2] * k) & 255) << 16) | ((Math.round(c[1] * k) & 255) << 8) | (Math.round(c[0] * k) & 255);
    }
  }
  b.g.putImageData(b.img, 0, 0);
}

/**
 * The ink's pixels as renderIslandInk last drew them on `canvas` (little-endian ABGR, row-major, the canvas's own size),
 * or null before it has: the face drawn over the ink keeps its own copy from these, never reading the canvas back.
 */
export function inkPixels(canvas: HTMLCanvasElement): Uint32Array | null {
  return bufs.get(canvas)?.px ?? null;
}

/** Little-endian ABGR with alpha, for a Uint32 view of ImageData. */
function rgba(c: RGB, a: number): number {
  return ((Math.round(clamp01(a) * 255) << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
}

function sized(canvas: HTMLCanvasElement, w: number, h: number, cell: number): { nx: number; ny: number; img: ImageData; px: Uint32Array; g: CanvasRenderingContext2D } | null {
  const nx = Math.max(1, Math.round(w / cell));
  const ny = Math.max(1, Math.round(h / cell));
  if (canvas.width !== nx) canvas.width = nx;
  if (canvas.height !== ny) canvas.height = ny;
  canvas.style.width = `${nx * cell}px`;
  canvas.style.height = `${ny * cell}px`;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const img = g.createImageData(nx, ny);
  return { nx, ny, img, px: new Uint32Array(img.data.buffer), g };
}

/**
 * The instruments' one grammar (NotchPanel.swift drawSweep, drawLevelTrace): one-cell ticks on a three-cell pitch, the
 * newest two cells in from the right end, in the paper alone (never the phase or the mark tone, so no instrument reads as a
 * loose coloured bar), and no rule drawn across the island while nothing moves.
 */
export const TICK_PITCH = 3;
const TICK_INSET = 2;
/** The trace's lead: the dotted midline at its newest end while the voice is silent, LEAD ticks long, fading out from RULE. */
const RULE = 0.26;
const LEAD = 8;
/** The words' own alpha (styles/desk.css --desk-white-72): the sweep's ticks are set at it. */
export const TEXT_ALPHA = 0.72;
/**
 * A level under which the voice is silence: the trace draws nothing there but its lead. Judged on the level, never on cells,
 * so silence looks the same at the hero and docked, at every DPR (NotchPanel.swift traceSilence).
 */
export const SILENCE = 0.1;
/** The working sweep's swell, a fraction of its strip either side of its middle (NotchPanel.swift sweepHalf). */
const SWEEP_HALF = 0.2;

/**
 * The working sweep (NotchPanel.swift drawSweep): a swell of ticks up to three cells tall at `at` along its short strip (0
 * the left end … 1 the right), tallest and brightest in its middle, falling away either side at the words' alpha: a small
 * wave crossing under the words, never a bar and never a rule.
 */
export function renderSweep(canvas: HTMLCanvasElement, o: { width: number; at: number; cell: number; on: RGB }): void {
  const s = sized(canvas, o.width, 3 * o.cell, o.cell);
  if (!s) return;
  const { nx, px } = s;
  px.fill(0);
  const centre = SWEEP_HALF + clamp01(o.at) * (1 - 2 * SWEEP_HALF);
  for (let x = TICK_INSET; x < nx; x += TICK_PITCH) {
    const d = Math.abs((x + 0.5) / nx - centre) / SWEEP_HALF;
    if (d >= 1) continue;
    const w = 0.5 + 0.5 * Math.cos(Math.PI * d);
    const cells = Math.round(3 * w);
    if (cells <= 0) continue;
    const c = rgba(o.on, TEXT_ALPHA * (0.45 + 0.55 * w));
    // centred in the strip's three cells: one cell in the middle row, two from the top, three the whole height
    const top = cells === 3 ? 0 : cells === 2 ? 0 : 1;
    for (let y = top; y < top + cells; y++) px[y * nx + x] = c;
  }
  s.g.putImageData(s.img, 0, 0);
}

/**
 * The level trace (NotchPanel.swift's drawLevelTrace, in the hero's slot while it listens): the last levels as bars
 * centred on the midline, newest at the right, each as tall as its level; silence (a level under SILENCE) draws nothing
 * but a short dotted lead at the newest end, so a quiet trace shows a live cursor, never a rule; a lone level between two
 * silent ones is silence too, so no stray tick stands between two phrases. The newest three grow in;
 * the older half settles to 40 % of its height and thins out through the Bayer tile toward the left, so the trail fades
 * as a voice does, never as faint full-height scratches.
 */
export function renderLevelTrace(canvas: HTMLCanvasElement, o: { width: number; height: number; cell: number; levels: ArrayLike<number>; on: RGB }): void {
  const s = sized(canvas, o.width, o.height, o.cell);
  if (!s) return;
  const { nx, ny, px } = s;
  px.fill(0);
  const mid = Math.floor(ny / 2);
  const bars = Math.floor((nx - TICK_INSET + TICK_PITCH - 1) / TICK_PITCH);
  const L = o.levels.length;
  const at = (i: number): number => (i >= 0 && i < L ? clamp01(o.levels[L - 1 - i] ?? 0) : 0);
  for (let i = 0; i < bars; i++) {
    const x = nx - 1 - TICK_INSET - i * TICK_PITCH;
    if (x < 0) break;
    const level = at(i);
    const age = i / bars;
    const grow = Math.min(1, (i + 1) / 3);
    const settle = 1 - 0.6 * smoothstep(0.5, 1, age);
    // a lone level over silence between two silent ones is a click, not a voice: it reads as a stray tick, so it is silence
    const lone = at(i + 1) < SILENCE && (i === 0 || at(i - 1) < SILENCE);
    const half = level < SILENCE || lone ? 0 : (level * ny * grow * settle) / 2;
    // silence, or a level too short for a cell either side of the midline: the lead, at the newest end only
    if (half < 1) {
      if (i < LEAD) px[mid * nx + x] = rgba(o.on, (RULE * (LEAD - i)) / LEAD);
      continue;
    }
    const cover = 1 - 0.6 * smoothstep(0.55, 1, age);
    const c = rgba(o.on, 0.84 - 0.38 * smoothstep(0.3, 1, age));
    const top = Math.max(0, Math.round(mid + 0.5 - half));
    const bot = Math.min(ny, Math.round(mid + 0.5 + half));
    for (let y = top; y < bot; y++) if ((BAYER8[(y & 7) * 8 + (x & 7)] ?? 1) < cover) px[y * nx + x] = c;
  }
  s.g.putImageData(s.img, 0, 0);
}
