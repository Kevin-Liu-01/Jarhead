#!/usr/bin/env tsx
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";

/**
 * Generate the Dock icon: build/Jarhead.icns, build/icon.png (a 1024 preview),
 * docs/media/icon.png (the README's 256) and apps/mac/Resources/preview-icon-sizes.png
 * (a contact strip of the 16 … 256 renders, the small ones blown up 4× beside them,
 * so the dither can be checked by eye).
 *
 * Written as raw pixels rather than shipping a binary asset: an .icns needs
 * seven sizes, and a hand-drawn one would either be a blurry upscale or a file
 * nobody can regenerate. Deterministic and editable — change `P` / `ORB` and re-run.
 *
 * The mark: a deep ink Apple squircle holding the orb — Kevin's reference gradient,
 * pale cyan at the upper left through the listening cyan and the accent blues to a
 * deep blue at the lower right (no violet), with a glassy highlight and a sphere
 * shade toward the rim — over a glow of the orb's own colour spilling onto the ink.
 * Every shaded surface is quantised into a few bands and dithered with the 8×8 Bayer
 * matrix, at EVERY size: 5 bands from 1024 down to 16, cells of whole device pixels
 * (16 px at 1024, 4 px at 256 — 2 pt at Dock size — 1 px at 64 and below), so the 16 and
 * 32 px Dock and menu renders carry the same grain as the big one rather than
 * collapsing into a smooth ramp (2026-09-11: "make the icon and any gradients or
 * designs be dithered"). The notch island's gradient (apps/mac/.../UI/Dither.swift)
 * shares the tile, the palette and the band count. A paper hairline at 0.16 alpha
 * sits just inside the edge (the line law, whispered; none at 16).
 */


type RGB = readonly [number, number, number];

// Prototemplate canon.
const INK: RGB = [7, 7, 7]; // #070707
const ACCENT: RGB = [47, 92, 224]; // #2f5ce0
const LIFT: RGB = [91, 130, 255]; // #5b82ff
const PAPER: RGB = [255, 255, 255]; // #ffffff
const LISTENING: RGB = [90, 215, 255]; // #5ad7ff — the one allowed phase whisper

/** Everything a maintainer would tune, in one place. Distances are in bodyR units. */
const P = {
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

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Smooth 0→1 across `edge`, so nothing in the icon has a hard aliased boundary. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

const DEEP: RGB = lerp3(INK, ACCENT, P.deepMix);
const LIFT_W: RGB = lerp3(LIFT, LISTENING, P.liftWhisper);
const STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, INK],
  [0.25, DEEP],
  [0.5, ACCENT],
  [0.75, LIFT_W],
  [1, PAPER],
];

/** Piecewise-linear tone ramp; at 4 levels it lands exactly on the five canon tones. */
function ramp(u: number): RGB {
  if (u <= 0) return INK;
  for (let i = 1; i < STOPS.length; i++) {
    const hi = STOPS[i];
    const lo = STOPS[i - 1];
    if (!hi || !lo) break;
    const [u1, c1] = hi;
    if (u <= u1) {
      const [u0, c0] = lo;
      return lerp3(c0, c1, (u - u0) / (u1 - u0));
    }
  }
  return PAPER;
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
 * phase 3 pick the same pixel, so both phases share one loop.
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

/** The 8×8 Bayer matrix as thresholds in (0,1): (rank + 0.5) / 64, row-major — the same numbers as `Dither.bayer8`. */
const BAYER8: Float32Array = Float32Array.from(
  [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ],
  (r) => (r + 0.5) / 64,
);

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

// The orb's own gradient, Kevin's reference: light cyan at the upper left through
// the accent blues to a deep blue at the lower right (no violet — his call),
// dithered into visible bands, with a glassy highlight.
const ORB_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, [160, 240, 255]],        // pale cyan (listening, lit)
  [0.24, LISTENING],           // #5ad7ff
  [0.5, LIFT],                 // #5b82ff
  [0.74, ACCENT],              // #2f5ce0
  [1, [24, 58, 168]],          // deep accent — blue all the way, no violet
];

function orbRamp(u: number): RGB {
  if (u <= 0) return ORB_STOPS[0]?.[1] ?? INK;
  for (let i = 1; i < ORB_STOPS.length; i++) {
    const hi = ORB_STOPS[i];
    const lo = ORB_STOPS[i - 1];
    if (!hi || !lo) break;
    if (u <= hi[0]) return lerp3(lo[1], hi[1], (u - lo[0]) / (hi[0] - lo[0]));
  }
  return ORB_STOPS[ORB_STOPS.length - 1]?.[1] ?? PAPER;
}

const ORB = {
  r: 0.62,            // orb radius in bodyR units — fills most of the squircle, like the reference
  x: 0.0,
  y: 0.0,
  // Kevin (2026-09-12): "make the logo more of a perfect circle" — no harmonics: the Dock orb is a true circle.
  harmonics: [] as ReadonlyArray<readonly [number, number, number]>,
  // Dither band count: five at every size — the same as UI/Dither.swift — so each band
  // step is a wide zone the Bayer pattern has to carry (seven read as a plain ramp).
  bands: (_size: number) => 5,
  highlight: { x: -0.36, y: -0.4, sigma: 0.3, amp: 0.9 }, // glassy top-left spot (orb units)
  rimDarken: 0.42,    // sphere shading toward the lower-right edge
  glowAmp: 0.5, glowLen: 0.28, glowPow: 1.3, // dithered glow spilling onto the ink
  glowLevels: 3,      // the glow's steps, every size (16 below 128 px used to read smooth)
};

/** Signed distance to the orb boundary (+ outside), and the diagonal gradient parameter. */
function orbGeometry(u: number, v: number): { sd: number; diag: number; d: number; R: number; nx: number; ny: number } {
  const bx = u - ORB.x;
  const by = v - ORB.y;
  const d = Math.hypot(bx, by);
  const th = Math.atan2(by, bx);
  let R = 1;
  for (const [f, a, ph] of ORB.harmonics) R += a * Math.sin(f * th + ph);
  R *= ORB.r;
  const nx = bx / ORB.r;
  const ny = by / ORB.r;
  const diag = clamp01(0.5 + (nx + ny) / 2.6);
  return { sd: d - R, diag, d, R, nx, ny };
}

export function renderRgba(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2;
  const bodyR = r * P.body;
  const cell = Math.max(1, Math.round(size / P.cellDiv));
  const bands = ORB.bands(size);
  const { tile, size: nz } = getTile();
  const ringW = Math.max(1, size / 512);
  const ringInsetPx = Math.max(size <= 64 ? 1 : 2, P.ring.inset * bodyR);
  const drawRing = size > 16;

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
      const sx = (x + 0.5 - c) / bodyR;
      const sy = (y + 0.5 - c) / bodyR;
      const t = tile[(cy % nz) * nz + (cx % nz)] ?? 0.5;
      const g = orbGeometry(sx, sy);

      let col: RGB;
      if (g.sd <= 0) {
        // Inside: the gradient, quantised into dithered bands; then sphere shading and a highlight.
        const q = Math.min(bands, Math.floor(g.diag * bands + t)) / bands;
        col = orbRamp(q);
        const rim = smoothstep(0.55, 1.0, g.d / g.R) * clamp01(0.5 + (g.nx + g.ny) / 2) * ORB.rimDarken;
        col = lerp3(col, [8, 26, 96], quantiseDither(rim, 6, t));
        const hx = g.nx - ORB.highlight.x;
        const hy = g.ny - ORB.highlight.y;
        const hl = ORB.highlight.amp * Math.exp(-(hx * hx + hy * hy) / (2 * ORB.highlight.sigma * ORB.highlight.sigma));
        col = lerp3(col, PAPER, quantiseDither(hl, 8, t));
      } else {
        // Outside: ink, with a dithered glow in the orb's local colour.
        const glow = ORB.glowAmp * Math.exp(-((g.sd / ORB.glowLen) ** ORB.glowPow));
        const q = quantiseDither(glow, ORB.glowLevels, t);
        col = lerp3(INK, orbRamp(g.diag), q);
      }

      if (drawRing) {
        const ring = clamp01(ringW / 2 + 0.5 - Math.abs(inset - ringInsetPx));
        if (ring > 0) col = lerp3(col, PAPER, P.ring.alpha * ring);
      }
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = Math.round(255 * cov);
    }
  }
  return px;
}

/** Quantise `v` (0..1) to `levels` steps with the tile's threshold `t`, returning the stepped 0..1 value. */
function quantiseDither(v: number, levels: number, t: number): number {
  return Math.min(levels, Math.floor(clamp01(v) * levels + t)) / levels;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal PNG encoder: 8-bit RGBA, filter type 0 on every scanline. Square when `height` is omitted. */
export function encodePng(width: number, rgba: Buffer, height = width): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A canvas to paste renders on: the Console's raised ground, opaque. */
class Strip {
  readonly px: Buffer;
  constructor(readonly width: number, readonly height: number, ground: RGB = [0x10, 0x10, 0x10]) {
    this.px = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.px[i * 4] = ground[0];
      this.px[i * 4 + 1] = ground[1];
      this.px[i * 4 + 2] = ground[2];
      this.px[i * 4 + 3] = 255;
    }
  }
  /** Source-over `rgba` (size×size) at (x, y), each source pixel `zoom`× (nearest: the dither stays crisp). */
  paste(rgba: Buffer, size: number, x0: number, y0: number, zoom = 1): void {
    for (let sy = 0; sy < size; sy++) {
      for (let sx = 0; sx < size; sx++) {
        const s = (sy * size + sx) * 4;
        const a = (rgba[s + 3] ?? 0) / 255;
        if (a <= 0) continue;
        for (let zy = 0; zy < zoom; zy++) {
          for (let zx = 0; zx < zoom; zx++) {
            const x = x0 + sx * zoom + zx;
            const y = y0 + sy * zoom + zy;
            if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
            const d = (y * this.width + x) * 4;
            for (let c = 0; c < 3; c++) this.px[d + c] = Math.round((rgba[s + c] ?? 0) * a + (this.px[d + c] ?? 0) * (1 - a));
            this.px[d + 3] = 255;
          }
        }
      }
    }
  }
}

const SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

const iconset = join(REPO_ROOT, "build", "Jarhead.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const renders = new Map<number, Buffer>();
for (const size of SIZES) {
  const rgba = renderRgba(size);
  renders.set(size, rgba);
  // Corners must be fully transparent and the centre fully opaque at every size.
  if (rgba[3] !== 0 || rgba[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3] !== 255) {
    throw new Error(`icon ${size}: silhouette check failed`);
  }
  const png = encodePng(size, rgba);
  // iconutil wants both @1x and @2x names; the @2x of N is the 2N render.
  if (size <= 512) writeFileSync(join(iconset, `icon_${size}x${size}.png`), png);
  if (size >= 32) writeFileSync(join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png);
}

const icns = join(REPO_ROOT, "build", "Jarhead.icns");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
writeFileSync(join(REPO_ROOT, "build", "icon.png"), encodePng(1024, renders.get(1024) ?? renderRgba(1024)));
// The README's icon: the 256 render, as the Dock shows it at 2× on a 128 pt tile.
const mediaIcon = join(REPO_ROOT, "docs", "media", "icon.png");
writeFileSync(mediaIcon, encodePng(256, renders.get(256) ?? renderRgba(256)));

// The contact strip: 16 / 32 / 64 / 128 / 256 at 1:1 along the top, then the 16, 32
// and 64 blown up 4× (nearest neighbour) underneath, so the grain in the small
// renders can be judged at a glance — every one must show the dither and still read
// as the orb.
const pad = 24;
const stripSizes = [16, 32, 64, 128, 256] as const;
const zoomed = [16, 32, 64] as const;
const zoom = 4;
const rowW = stripSizes.reduce((w, s) => w + s + pad, pad);
const zoomW = zoomed.reduce((w, s) => w + s * zoom + pad, pad);
const stripW = Math.max(rowW, zoomW);
const stripH = pad + 256 + pad + 64 * zoom + pad;
const strip = new Strip(stripW, stripH);
let x = pad;
for (const s of stripSizes) {
  strip.paste(renders.get(s) ?? renderRgba(s), s, x, pad + 256 - s);
  x += s + pad;
}
x = pad;
for (const s of zoomed) {
  strip.paste(renders.get(s) ?? renderRgba(s), s, x, pad + 256 + pad + 64 * zoom - s * zoom, zoom);
  x += s * zoom + pad;
}
const stripPath = join(REPO_ROOT, "apps", "mac", "Resources", "preview-icon-sizes.png");
writeFileSync(stripPath, encodePng(stripW, strip.px, stripH));

console.log(`  ${icns}`);
console.log(`  ${join(REPO_ROOT, "build", "icon.png")}`);
console.log(`  ${mediaIcon}`);
console.log(`  ${stripPath}`);
