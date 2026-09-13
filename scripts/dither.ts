/**
 * The dither material, shared by the pictures this repo renders: the Dock icon
 * (`make-icon.ts`) and the README banner (`make-banner.ts`). Side-effect free.
 *
 * It mirrors `apps/mac/Sources/Jarhead/UI/Dither.swift`: the Prototemplate colours,
 * the orb's ramp (`ORB_STOPS` = `Dither.orbStops`), the ink ramp (`INK_STOPS` =
 * `Dither.inkStops`), the classic 8×8 Bayer matrix (`BAYER8_RANKS` / `BAYER8` =
 * `Dither.bayer8Ranks` / `Dither.bayer8`), the piecewise-linear ramp and the ordered
 * quantiser, plus the orb's geometry and shading constants and a minimal PNG encoder.
 * Every shaded surface in a picture is quantised into a few bands and dithered with the
 * matrix in cells of whole pixels — the threshold sampled per cell, the geometry per
 * pixel — so the silhouettes stay crisp while the pattern stays chunky.
 */

import { deflateSync } from "node:zlib";

export type RGB = readonly [number, number, number];

// Prototemplate canon.
export const INK: RGB = [7, 7, 7]; // #070707
export const ACCENT: RGB = [47, 92, 224]; // #2f5ce0
export const LIFT: RGB = [91, 130, 255]; // #5b82ff
export const PAPER: RGB = [255, 255, 255]; // #ffffff
export const LISTENING: RGB = [90, 215, 255]; // #5ad7ff — the one allowed phase whisper

/** A colour stop: `u` in 0…1 along the ramp, then the colour. */
export type Stops = ReadonlyArray<readonly [number, RGB]>;

// The orb's own gradient, Kevin's reference: light cyan at the upper left through
// the accent blues to a deep blue at the lower right (no violet — his call),
// dithered into visible bands, with a glassy highlight. `Dither.orbStops`.
export const ORB_STOPS: Stops = [
  [0, [160, 240, 255]], // pale cyan (listening, lit)
  [0.24, LISTENING], // #5ad7ff
  [0.5, LIFT], // #5b82ff
  [0.74, ACCENT], // #2f5ce0
  [1, [24, 58, 168]], // deep accent — blue all the way, no violet
];

/** Ink to the accent through raised ink: a shaded ground rather than a coloured one. `Dither.inkStops`. */
export const INK_STOPS: Stops = [
  [0, INK],
  [0.5, [16, 16, 16]], // #101010, raised ink
  [1, ACCENT],
];

/** The raw ranks (0…63) of the 8×8 Bayer matrix, row-major — `Dither.bayer8Ranks`. */
export const BAYER8_RANKS: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/** The matrix as thresholds in (0,1): (rank + 0.5) / 64, row-major — the same numbers as `Dither.bayer8`. */
export const BAYER8: Float32Array = Float32Array.from(BAYER8_RANKS, (r) => (r + 0.5) / 64);

/** The matrix's threshold for a pixel in `cell`-px cells. */
export function bayerThreshold(x: number, y: number, cell: number): number {
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  return BAYER8[(cy % 8) * 8 + (cx % 8)] ?? 0.5;
}

export function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Smooth 0→1 across `edge`, so nothing shaded has a hard aliased boundary. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Piecewise-linear colour at `u` along `stops`: the first colour at or before the first
 * stop, the last past the last — `Dither.ramp(_:stops:)`.
 */
export function rampAt(stops: Stops, u: number): RGB {
  const first = stops[0];
  if (!first) return INK;
  if (u <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i];
    const lo = stops[i - 1];
    if (!hi || !lo) break;
    if (u <= hi[0]) return lerp3(lo[1], hi[1], (u - lo[0]) / (hi[0] - lo[0]));
  }
  return stops[stops.length - 1]?.[1] ?? PAPER;
}

/** Quantise `v` (0..1) to `levels` steps with the tile's threshold `t`, returning the stepped 0..1 value — `Dither.quantise`. */
export function quantiseDither(v: number, levels: number, t: number): number {
  return Math.min(levels, Math.floor(clamp01(v) * levels + t)) / levels;
}

/** The orb: geometry in bodyR units and the shading a maintainer would tune, in one place. */
export const ORB = {
  r: 0.62, // orb radius in bodyR units — fills most of the squircle, like the reference
  x: 0.0,
  y: 0.0,
  // Kevin (2026-09-12): "make the logo more of a perfect circle" — no harmonics: the Dock orb is a true circle.
  harmonics: [] as ReadonlyArray<readonly [number, number, number]>,
  // Dither band count: five at every size — the same as UI/Dither.swift — so each band
  // step is a wide zone the Bayer pattern has to carry (seven read as a plain ramp).
  bands: (_size: number) => 5,
  highlight: { x: -0.36, y: -0.4, sigma: 0.3, amp: 0.9 }, // glassy top-left spot (orb units)
  rimDarken: 0.42, // sphere shading toward the lower-right edge
  rimTone: [8, 26, 96] as RGB, // what the rim shades toward
  rimLevels: 6, // the rim shade's dither steps
  highlightLevels: 8, // the highlight's dither steps
  glowAmp: 0.5,
  glowLen: 0.28,
  glowPow: 1.3, // dithered glow spilling onto the ink
  glowLevels: 3, // the glow's steps, every size (16 below 128 px used to read smooth)
};

/** The orb's ramp at `u`. */
export function orbRamp(u: number): RGB {
  return rampAt(ORB_STOPS, u);
}

export interface OrbGeometry {
  /** Signed distance to the orb boundary in bodyR units, + outside. */
  sd: number;
  /** The diagonal gradient parameter, 0 at the upper left of the orb → 1 at the lower right. */
  diag: number;
  d: number;
  R: number;
  nx: number;
  ny: number;
}

/** Signed distance to the orb boundary (+ outside), and the diagonal gradient parameter, at a point in bodyR units from the centre. */
export function orbGeometry(u: number, v: number): OrbGeometry {
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

/**
 * The orb's colour at a point INSIDE it (`g.sd <= 0`): the gradient quantised into `bands`
 * dithered bands, then the sphere shade toward the rim and the glassy highlight, both
 * dithered with the same threshold `t`.
 */
export function orbInside(g: OrbGeometry, bands: number, t: number): RGB {
  const q = Math.min(bands, Math.floor(g.diag * bands + t)) / bands;
  let col = orbRamp(q);
  const rim = smoothstep(0.55, 1.0, g.d / g.R) * clamp01(0.5 + (g.nx + g.ny) / 2) * ORB.rimDarken;
  col = lerp3(col, ORB.rimTone, quantiseDither(rim, ORB.rimLevels, t));
  const hx = g.nx - ORB.highlight.x;
  const hy = g.ny - ORB.highlight.y;
  const hl = ORB.highlight.amp * Math.exp(-(hx * hx + hy * hy) / (2 * ORB.highlight.sigma * ORB.highlight.sigma));
  return lerp3(col, PAPER, quantiseDither(hl, ORB.highlightLevels, t));
}

/**
 * The orb's glow at a point OUTSIDE it: `ground` lifted toward the orb's local colour by the
 * dithered glow (`ORB.glowLevels` steps) — what spills onto the ink around the disc.
 */
export function orbGlow(g: OrbGeometry, ground: RGB, t: number): RGB {
  const glow = ORB.glowAmp * Math.exp(-((g.sd / ORB.glowLen) ** ORB.glowPow));
  const q = quantiseDither(glow, ORB.glowLevels, t);
  return lerp3(ground, orbRamp(g.diag), q);
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

/** Minimal PNG encoder: 8-bit RGBA, filter type 0 on every scanline. Square when `height` is omitted. Deterministic. */
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
export class Strip {
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
