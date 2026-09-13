#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";
import { BAYER8, INK_STOPS, ORB, encodePng, orbGeometry, orbGlow, orbInside, quantiseDither, rampAt, type RGB } from "./dither.ts";

/**
 * The README banner: docs/media/banner.png, 2560×800 px. The README shows it at
 * width="1280", so one 8 px cell is 4 CSS px — the app's 2 pt dither cell on a Retina
 * display — and the grain survives the browser (a 1280×400 file would be bilinear-blurred
 * on Retina and lose it; Kevin's "1280×400" is honoured as the displayed size).
 *
 * The field is the ink ramp (`INK_STOPS`: ink → raised ink → the accent), diagonal from
 * the upper left to the lower right — "an ink field that pools toward the accent" — in
 * five bands of 8 px Bayer cells. Over it sits the icon's orb (scripts/dither.ts `ORB`:
 * harmonics [], the `ORB_STOPS` diagonal ramp in five bands, the highlight, the rim
 * shade), radius 288 px at the centre, its three-level glow composited over the field.
 * Opaque, no wordmark (the README's <h1> is the wordmark), no hairline. Deterministic:
 * run it twice and the bytes match. The threshold is sampled per cell and the geometry
 * per pixel (the icon's rule), so the disc's edge stays crisp while the dither stays
 * chunky.
 */

const W = 2560;
const H = 800;
const CELL = 8;
const BANDS = 5;
const ORB_RADIUS = 288;

export function renderBanner(): Buffer {
  const px = Buffer.alloc(W * H * 4);
  const cx = W / 2;
  const cy = H / 2;
  // `ORB.r` is the orb's radius in bodyR units: pick bodyR so the disc is ORB_RADIUS px.
  const bodyR = ORB_RADIUS / ORB.r;
  const bands = ORB.bands(W);

  for (let y = 0; y < H; y++) {
    const cellRow = (Math.floor(y / CELL) % 8) * 8;
    const fy = (y + 0.5) / H;
    const sy = (y + 0.5 - cy) / bodyR;
    for (let x = 0; x < W; x++) {
      const t = BAYER8[cellRow + (Math.floor(x / CELL) % 8)] ?? 0.5;
      // The field: the diagonal parameter spans the whole box, 0 at the upper left, 1 at the lower right.
      const fx = (x + 0.5) / W;
      const fu = 0.5 + (fx - 0.5 + (fy - 0.5)) / 2;
      const field: RGB = rampAt(INK_STOPS, quantiseDither(fu, BANDS, t));
      // The orb over it.
      const g = orbGeometry((x + 0.5 - cx) / bodyR, sy);
      const col = g.sd <= 0 ? orbInside(g, bands, t) : orbGlow(g, field, t);
      const i = (y * W + x) * 4;
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = 255;
    }
  }
  return px;
}

const out = join(REPO_ROOT, "docs", "media", "banner.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodePng(W, renderBanner(), H));
console.log(`  ${out} (${W}×${H})`);
