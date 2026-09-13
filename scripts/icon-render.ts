import {
  ACCENT,
  BAYER8,
  FACE,
  INK,
  LIFT,
  LISTENING,
  ORB,
  PAPER,
  clamp01,
  faceMask,
  faceMaskSmall,
  lerp3,
  orbGeometry,
  orbGlow,
  orbInside,
  rampAt,
  smoothstep,
  type FaceCell,
  type Gleam,
  type RGB,
  type Stops,
} from "./dither.ts";

/**
 * The Dock icon as pixels — pure: no file is read or written here. `make-icon.ts` is
 * the I/O around it (the iconset, iconutil, the README's copy, the contact strip) and
 * `scripts/__tests__/icon.test.ts` pins what this file renders, so a change to the mark
 * is a change that a test sees before the Dock does.
 *
 * The mark: a deep ink Apple squircle holding the orb WEARING THE BLOB'S `^ ^` — Kevin's
 * reference gradient, pale cyan at the upper left through the listening cyan and the
 * accent blues to a deep blue at the lower right (no violet), with a glassy sheen at the
 * upper-left rim and a sphere shade toward the rim — over a glow of the orb's own colour
 * spilling onto the ink. The face (`FACE` in scripts/dither.ts) is two flat-paper
 * chevrons boxed one cell deep in flat ink at the blob's proportions: eye row 0.30 R
 * above the centre, the pair ≈ 30 % of the orb's width. The orb is 32.5 cells across at
 * every size from 64 up (cell = size / 64), so ONE cell pattern serves 64 … 1024; 32 and
 * 16 are hand bitmaps (a 3 × 2 chevron with a ring; a dot pair with its shadow). The
 * in-app 14 pt `JarheadMark` stays faceless: below the Dock's 32 px class a face reads as
 * a status, not a creature (`faceFor`).
 * Every shaded surface is quantised into a few bands and dithered with the 8×8 Bayer
 * matrix, at EVERY size: 5 bands from 1024 down to 16, cells of whole device pixels
 * (16 px at 1024, 4 px at 256 — 2 pt at Dock size — 1 px at 64 and below), so the 16 and
 * 32 px Dock and menu renders carry the same grain as the big one rather than
 * collapsing into a smooth ramp (2026-09-11: "make the icon and any gradients or
 * designs be dithered"). The notch island's gradient (apps/mac/.../UI/Dither.swift)
 * and the README banner (scripts/make-banner.ts) share the tile, the palette and the
 * band count through scripts/dither.ts. A paper hairline at 0.16 alpha sits just inside
 * the edge (the line law, whispered; none at 16).
 */

/** Everything a maintainer would tune, in one place. Distances are in bodyR units. */
export const P = {
  body: 0.82, // squircle half-extent as a fraction of the canvas half-size
  squircleN: 4.2, // superellipse exponent (Apple-ish)
  cellDiv: 64, // dither cell = size / cellDiv px (16 @1024, 4 @256 — 2 pt at Dock size — 1 @64 and below)
  // The threshold tile: the classic 8×8 Bayer matrix (UI/Dither.swift's default), or the
  // old void-and-cluster grain. Kevin (2026-09-12): blue noise at a pixel "just looks smooth".
  pattern: "bayer8" as "bayer8" | "blueNoise",
  blob: {
    r: 0.4, // base radius
    aspect: 1.12, // horizontal stretch — the product's blob is a wide cloud, not a ball
    x: 0.0,
    y: -0.05, // optical centre: a touch above geometric centre
    // [frequency, amplitude, phase] — low harmonics make it amorphous, not lumpy
    harmonics: [
      [3, 0.06, 1.4],
      [4, 0.035, 3.0],
      [2, 0.05, 0.6],
      [7, 0.012, 2.2],
    ] as ReadonlyArray<readonly [number, number, number]>,
  },
  edgeW: 0.05, // half-width of the blob's core→rim transition
  glowAmp: 0.64, // glow intensity at the blob boundary (tone space, 1 = paper)
  glowLen: 0.27, // e-folding length of the glow falloff — corners must reach ink
  glowPow: 1.25, // >1 = soft shoulder, faster tail (edges stay grainy, corners go ink)
  deepMix: 0.32, // deep tone = ink→accent at this fraction
  liftWhisper: 0.18, // lift tone tinted toward the listening phase colour by this much
  ring: { inset: 0.045, alpha: 0.16 }, // hairline: inset from the squircle edge, paper alpha (none at 16)
  coreDither: { minSize: 128, threshold: 0.93 }, // sparse lift cells inside the paper core, like the orb's glyph interior
  lightBias: 0.03, // glow reaches further toward the upper-left (light from the upper left, always)
  noise: { size: 64, sigma: 1.5, seed: 7, initialFill: 0.1 }, // void-and-cluster tile
};

/** The seven renders an .icns holds. */
export const SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

/** Orb radius in icon cells on the 64-cell grid: 64 · P.body · ORB.r / 2 = 16.2688, the same at every size ≥ 64. */
export const ICON_CELLS_PER_R = (64 * P.body * ORB.r) / 2;

/** How the face is drawn, by the orb's diameter in device pixels. */
export type FaceClass = "chevron" | "mini" | "dots" | "none";

/**
 * ≥ 32 px across → the cell chevron; 16–31 → the 3 × 2 hand bitmap; 8–15 → the dot pair
 * (or nothing, `FACE.at16`); smaller → nothing. The orb is 0.5084 · size px across, so the
 * icon's 64 … 1024 are chevrons, 32 is mini, 16 is dots.
 */
export function faceFor(size: number): FaceClass {
  const orbPx = 2 * ORB.r * P.body * (size / 2);
  if (orbPx >= 32) return "chevron";
  if (orbPx >= 16) return "mini";
  if (orbPx >= 8) return FACE.at16 === "dots" ? "dots" : "none";
  return "none";
}

/** No face pixel's centre sits farther from the orb's centre than this many R: the tile stays a circle. */
export const FACE_MAX_R = 0.82;

/** The files whose change means the icns must be rendered again (scripts/, relative to the repo root). */
export const ICON_SOURCES: readonly string[] = ["make-icon.ts", "icon-render.ts", "dither.ts"];

/**
 * Is a built file stale against its sources, by mtime: missing (`undefined`), or older than
 * any source that exists. `scripts/build-mac.ts` asks this before packaging the icns — it
 * used to rebuild only a MISSING icns, and the Dock showed a pre-Bayer, pre-circle orb for
 * days. Pure so the rule is testable without running the build.
 */
export function staleAgainst(builtMs: number | undefined, sourcesMs: readonly (number | undefined)[]): boolean {
  if (builtMs === undefined) return true;
  return sourcesMs.some((ms) => ms !== undefined && ms > builtMs);
}

const DEEP: RGB = lerp3(INK, ACCENT, P.deepMix);
const LIFT_W: RGB = lerp3(LIFT, LISTENING, P.liftWhisper);
/** The squircle field's tone ramp; at 4 levels it lands exactly on the five canon tones. */
const STOPS: Stops = [
  [0, INK],
  [0.25, DEEP],
  [0.5, ACCENT],
  [0.75, LIFT_W],
  [1, PAPER],
];

function ramp(u: number): RGB {
  return rampAt(STOPS, u);
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ulichney's void-and-cluster: a tileable blue-noise threshold array in [0,1).
 * Deterministic (seeded), ~50ms for 64x64. Under a toroidal Gaussian the
 * "largest void" rule of phase 2 and the "tightest cluster of zeros" rule of
 * phase 3 pick the same pixel, so both phases share one loop. Kept for reference
 * (`P.pattern = "blueNoise"`); the icon ships on the Bayer matrix.
 */
function voidAndCluster(n: number, sigma: number, seed: number, fill: number): Float32Array {
  const N = n * n;
  const rnd = mulberry32(seed);
  const kern = new Float32Array(N);
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      const wx = Math.min(dx, n - dx);
      const wy = Math.min(dy, n - dy);
      kern[dy * n + dx] = Math.exp(-(wx * wx + wy * wy) / (2 * sigma * sigma));
    }
  }
  const E = new Float64Array(N);
  const on = new Uint8Array(N);
  const add = (p: number, sign: number) => {
    const px = p % n;
    const py = (p - px) / n;
    for (let y = 0; y < n; y++) {
      const krow = ((y - py + n) % n) * n;
      const orow = y * n;
      for (let x = 0; x < n; x++) E[orow + x] = (E[orow + x] ?? 0) + sign * (kern[krow + ((x - px + n) % n)] ?? 0);
    }
  };
  const tightest = () => {
    let best = -1;
    let bv = -Infinity;
    for (let i = 0; i < N; i++) {
      const e = E[i] ?? 0;
      if (on[i] && e > bv) (bv = e), (best = i);
    }
    return best;
  };
  const largestVoid = () => {
    let best = -1;
    let bv = Infinity;
    for (let i = 0; i < N; i++) {
      const e = E[i] ?? 0;
      if (!on[i] && e < bv) (bv = e), (best = i);
    }
    return best;
  };

  let count = 0;
  const target = Math.max(1, Math.floor(N * fill));
  while (count < target) {
    const p = Math.floor(rnd() * N);
    if (!on[p]) (on[p] = 1), add(p, 1), count++;
  }
  // Relax the initial pattern until removing the tightest cluster and filling
  // the largest void would put the same pixel back.
  for (let i = 0; i < N; i++) {
    const c = tightest();
    on[c] = 0;
    add(c, -1);
    const v = largestVoid();
    if (v === c) {
      on[c] = 1;
      add(c, 1);
      break;
    }
    on[v] = 1;
    add(v, 1);
  }
  const rank = new Int32Array(N).fill(-1);
  const initialOn = on.slice();
  const initialE = E.slice();
  for (let r = count - 1; r >= 0; r--) {
    const c = tightest();
    rank[c] = r;
    on[c] = 0;
    add(c, -1);
  }
  on.set(initialOn);
  E.set(initialE);
  for (let r = count; r < N; r++) {
    const v = largestVoid();
    rank[v] = r;
    on[v] = 1;
    add(v, 1);
  }
  const t = new Float32Array(N);
  for (let i = 0; i < N; i++) t[i] = ((rank[i] ?? 0) + 0.5) / N;
  return t;
}

let noiseTile: Float32Array | null = null;
function getNoise(): Float32Array {
  if (!noiseTile) noiseTile = voidAndCluster(P.noise.size, P.noise.sigma, P.noise.seed, P.noise.initialFill);
  return noiseTile;
}

/** The active threshold tile and its side. */
function getTile(): { tile: Float32Array; size: number } {
  return P.pattern === "bayer8" ? { tile: BAYER8, size: 8 } : { tile: getNoise(), size: P.noise.size };
}

/** Tone-space intensity (0 = ink, 1 = paper) at a point given in bodyR units from the canvas centre. */
function field(u: number, v: number): number {
  const bx = (u - P.blob.x) / P.blob.aspect;
  const by = v - P.blob.y;
  const d = Math.hypot(bx, by);
  const th = Math.atan2(by, bx);
  let R = 1;
  for (const [f, a, ph] of P.blob.harmonics) R += a * Math.sin(f * th + ph);
  R *= P.blob.r;
  const sd = d - R; // approximate signed distance to the blob boundary, +ve outside
  const core = 1 - smoothstep(-P.edgeW, P.edgeW, sd);
  // Light from the upper left: the halo reaches a little further that way.
  const toward = d > 0 ? (-bx - by) / (d * Math.SQRT2) : 0;
  const len = P.glowLen + P.lightBias * toward;
  const glow = P.glowAmp * Math.exp(-((Math.max(0, sd) / len) ** P.glowPow));
  return Math.max(core, glow);
}

/**
 * Superellipse coverage helper: returns the distance (px) from the pixel to
 * the squircle boundary along its own ray, +ve inside. |dx|^n + |dy|^n = bodyR^n.
 */
function squircleInset(dx: number, dy: number, bodyR: number, n: number): number {
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return bodyR;
  const ct = Math.abs(dx) / dist;
  const st = Math.abs(dy) / dist;
  const rb = bodyR / Math.pow(ct ** n + st ** n, 1 / n);
  return rb - dist;
}

export interface IconRender {
  readonly size: number;
  /** RGBA, size × size × 4. */
  readonly px: Buffer;
  /** Per pixel: 0 orb / ground, 1 a glyph pixel (PAPER), 2 a box pixel (INK). */
  readonly mask: Uint8Array;
}

export interface RenderOptions {
  /** Draw the face (default true). */
  readonly face?: boolean;
  /** The orb's sheen; default `FACE.gleam` with the face, `ORB.highlight` without. */
  readonly highlight?: Gleam;
}

/**
 * One size of the icon as RGBA pixels plus the face mask. Deterministic: the same size
 * renders the same bytes. The orb's centre is the canvas centre, size / 2 — a pixel's
 * centre is x + 0.5, so both the squircle (`x − (size − 1) / 2`) and the orb (`x + 0.5 −
 * size / 2`) measure from the same point; the orb used to measure from (size − 1) / 2 and
 * sat half a pixel up-left of the squircle, which no face can mirror across.
 */
export function renderIcon(size: number, opts: RenderOptions = {}): IconRender {
  const face = opts.face ?? true;
  const highlight = opts.highlight ?? (face ? FACE.gleam : ORB.highlight);
  const px = Buffer.alloc(size * size * 4);
  const mask = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  const centre = size / 2;
  const r = size / 2;
  const bodyR = r * P.body;
  const R = ORB.r * bodyR;
  const cell = Math.max(1, Math.round(size / P.cellDiv));
  const bands = ORB.bands(size);
  const { tile, size: nz } = getTile();
  const ringW = Math.max(1, size / 512);
  const ringInsetPx = Math.max(size <= 64 ? 1 : 2, P.ring.inset * bodyR);
  const drawRing = size > 16;
  // The face as a mask: one cell pattern at 64 and up (cells of size / 64 px), a hand bitmap at 32 and 16.
  const cls = face ? faceFor(size) : "none";
  const cols = Math.ceil(size / cell);
  const faceCells: Uint8Array | undefined = cls === "chevron" ? faceMask(cols, cols, cell, centre, centre, R) : cls === "mini" ? faceMaskSmall(32) : cls === "dots" ? faceMaskSmall(16) : undefined;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const inset = squircleInset(dx, dy, bodyR, P.squircleN);
      const cov = clamp01(inset + 0.5);
      const i = (y * size + x) * 4;
      if (cov <= 0) {
        px[i + 3] = 0;
        continue;
      }
      // The threshold is per cell (the Bayer block), the geometry per pixel: the orb's
      // silhouette and highlight stay crisp while the dither stays chunky.
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const sx = dx / bodyR;
      const sy = dy / bodyR;
      const t = tile[(cy % nz) * nz + (cx % nz)] ?? 0.5;
      const g = orbGeometry(sx, sy);

      // Inside: the gradient, quantised into dithered bands; then sphere shading and the
      // sheen. Outside: ink, with a dithered glow in the orb's local colour.
      let col: RGB = g.sd <= 0 ? orbInside(g, bands, t, highlight) : orbGlow(g, INK, t);

      // The face, flat, inside the orb only: paper for a glyph cell, ink for its box.
      let hit: FaceCell = 0;
      if (faceCells && g.sd <= 0) {
        hit = (cls === "chevron" ? faceCells[cy * cols + cx] : faceCells[y * size + x]) as FaceCell;
        if (hit === 1) col = FACE.ink;
        else if (hit === 2) col = FACE.box;
        mask[y * size + x] = hit;
      }

      if (drawRing && hit === 0) {
        const ring = clamp01(ringW / 2 + 0.5 - Math.abs(inset - ringInsetPx));
        if (ring > 0) col = lerp3(col, PAPER, P.ring.alpha * ring);
      }
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = Math.round(255 * cov);
    }
  }
  return { size, px, mask };
}

/**
 * What every render must satisfy; throws with the size named. The silhouette: corners
 * fully transparent, the centre fully opaque. The face: every glyph pixel exactly PAPER
 * and every box pixel exactly INK (flat fills flat, the ring never tints them), the mask
 * mirror-symmetric about the vertical axis (0 asymmetric pixels — the orb centre sits on
 * a pixel boundary), and every face pixel's centre within `FACE_MAX_R` of the orb's
 * centre (the tile is still a circle).
 */
export function checkIcon(r: IconRender): void {
  const { size, px, mask } = r;
  if (px[3] !== 0 || px[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3] !== 255) {
    throw new Error(`icon ${size}: silhouette check failed`);
  }
  const R = ORB.r * (size / 2) * P.body;
  const bound = FACE_MAX_R;
  let asymmetric = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const m = mask[y * size + x] ?? 0;
      if (m !== (mask[y * size + (size - 1 - x)] ?? 0)) asymmetric++;
      if (m === 0) continue;
      const i = (y * size + x) * 4;
      const want = m === 1 ? FACE.ink : FACE.box;
      if (px[i] !== want[0] || px[i + 1] !== want[1] || px[i + 2] !== want[2]) throw new Error(`icon ${size}: face pixel (${x},${y}) is not flat ${m === 1 ? "PAPER" : "INK"}`);
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / R;
      if (d >= bound) throw new Error(`icon ${size}: face pixel (${x},${y}) at ${d.toFixed(3)} R is outside ${bound} R`);
    }
  }
  if (asymmetric) throw new Error(`icon ${size}: ${asymmetric} face pixel(s) have no mirror`);
}

/** The mask over a rectangle of cells as text: `#` glyph, `+` box, `.` orb — what the tests pin and a reviewer reads. */
export function asciiMask(r: IconRender, x0: number, x1: number, y0: number, y1: number): string[] {
  const rows: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let s = "";
    for (let x = x0; x <= x1; x++) {
      const m = r.mask[y * r.size + x];
      s += m === 1 ? "#" : m === 2 ? "+" : ".";
    }
    rows.push(s);
  }
  return rows;
}

// `field` and `ramp` describe the older squircle-field mark (the tone-space blob over
// the five canon tones); they are kept so the mark can be brought back by hand.
void field;
void ramp;
