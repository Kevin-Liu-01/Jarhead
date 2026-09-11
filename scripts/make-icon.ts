#!/usr/bin/env tsx
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";

/**
 * Generate the Dock icon: build/Jarhead.icns (+ build/icon.png as a 1024 preview).
 *
 * Written as raw pixels rather than shipping a binary asset: an .icns needs
 * seven sizes, and a hand-drawn one would either be a blurry upscale or a file
 * nobody can regenerate. Deterministic and editable — change `P` and re-run.
 *
 * The mark (chosen from a three-design panel on 2026-09-10): a deep ink Apple
 * squircle holding the Jarhead blob — an amorphous paper-white silhouette of low
 * harmonics, the product's orb — with a radial accent glow behind it. The whole
 * field is quantised to the five canon tones (ink → deep → accent → lift → paper)
 * and dithered with a seeded void-and-cluster blue-noise tile, so the falloff
 * reads as organic grain rather than a grid at 128–1024 and collapses into a clean
 * gradient at 32 and 16. Cells are whole device pixels at every size. A paper
 * hairline at 0.16 alpha sits just inside the edge (the line law, whispered), the
 * lift tone carries a whisper of the listening cyan, the glow leans toward the
 * upper left, and the paper core carries a sparse scatter of lift cells so it has
 * the interior density of the ASCII orb.
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
  cellDiv: 128, // dither cell = size / cellDiv px (8 @1024, 4 @512, 1 @128)
  /** Tone steps. 4 steps = the five canon tones; more steps = smoother gradient at small sizes. */
  levels: (size: number) => (size >= 128 ? 4 : size >= 64 ? 24 : size >= 32 ? 16 : 32),
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

// The orb's own gradient, Kevin's reference: light cyan at the upper left, through
// the accent blues, to violet at the lower right — the product's phase colours in
// one sweep — dithered into visible bands, with a glassy highlight.
const ORB_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [0, [150, 236, 255]],        // pale cyan (listening, lit)
  [0.22, LISTENING],           // #5ad7ff
  [0.48, LIFT],                // #5b82ff
  [0.7, ACCENT],               // #2f5ce0
  [0.86, [124, 92, 235]],      // violet
  [1, [176, 120, 255]],        // #b48cff-ish, thinking
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
  harmonics: [[3, 0.025, 1.4], [2, 0.02, 0.6], [5, 0.008, 2.2]] as ReadonlyArray<readonly [number, number, number]>,
  bands: (size: number) => (size >= 256 ? 6 : size >= 128 ? 9 : size >= 64 ? 24 : 48), // dither band count (fewer = the dither shows)
  highlight: { x: -0.36, y: -0.4, sigma: 0.3, amp: 0.9 }, // glassy top-left spot (orb units)
  rimDarken: 0.42,    // sphere shading toward the lower-right edge
  glowAmp: 0.5, glowLen: 0.28, glowPow: 1.3, // dithered glow spilling onto the ink
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
  const noise = getNoise();
  const nz = P.noise.size;
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
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const sx = ((cx + 0.5) * cell - c) / bodyR;
      const sy = ((cy + 0.5) * cell - c) / bodyR;
      const t = noise[(cy % nz) * nz + (cx % nz)] ?? 0.5;
      const g = orbGeometry(sx, sy);

      let col: RGB;
      if (g.sd <= 0) {
        // Inside: the gradient, quantised into dithered bands; then sphere shading and a highlight.
        const q = Math.min(bands, Math.floor(g.diag * bands + t)) / bands;
        col = orbRamp(q);
        const rim = smoothstep(0.55, 1.0, g.d / g.R) * clamp01(0.5 + (g.nx + g.ny) / 2) * ORB.rimDarken;
        col = lerp3(col, [30, 18, 70], quantiseDither(rim, 6, t));
        const hx = g.nx - ORB.highlight.x;
        const hy = g.ny - ORB.highlight.y;
        const hl = ORB.highlight.amp * Math.exp(-(hx * hx + hy * hy) / (2 * ORB.highlight.sigma * ORB.highlight.sigma));
        col = lerp3(col, PAPER, quantiseDither(hl, 8, t));
      } else {
        // Outside: ink, with a dithered glow in the orb's local colour.
        const glow = ORB.glowAmp * Math.exp(-((g.sd / ORB.glowLen) ** ORB.glowPow));
        const q = quantiseDither(glow, size >= 128 ? 3 : 16, t);
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

/** Quantise `v` (0..1) to `levels` steps with the blue-noise threshold `t`, returning the stepped 0..1 value. */
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

/** Minimal PNG encoder: 8-bit RGBA, filter type 0 on every scanline. */
export function encodePng(size: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

const iconset = join(REPO_ROOT, "build", "Jarhead.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

for (const size of SIZES) {
  const rgba = renderRgba(size);
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
writeFileSync(join(REPO_ROOT, "build", "icon.png"), encodePng(1024, renderRgba(1024)));

console.log(`  ${icns}`);
console.log(`  ${join(REPO_ROOT, "build", "icon.png")}`);
