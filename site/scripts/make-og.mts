#!/usr/bin/env tsx
/**
 * public/og-field.png: the field and the orb of the OG image, 1200 × 630, dark only.
 * `app/og.png/route.tsx` lays the words over it at build with `ImageResponse`; this file
 * is the part satori cannot draw (a dithered field, a dithered orb, a cell-sampled face).
 *
 * The banner's recipe (scripts/make-banner.ts), at the OG size: the `INK_STOPS` field on
 * the diagonal `fu = 0.5 + ((fx − 0.5) + (fy − 0.5)) / 2`, five bands of 8 px Bayer cells;
 * the orb (radius 210 px, centre (300, 315)) from `orbGeometry` / `orbInside` with the
 * face's gleam above the eyes and the three-level glow spilling onto the field; the `^ ^`
 * from `faceMask` on the same 8 px cells (26 cells per R: chevrons of about 8 × 6 cells in
 * a 2-cell ink box). The threshold is sampled per cell and the geometry per pixel, so the
 * disc's edge stays crisp while the dither stays chunky; the face is two flat fills and
 * never dithers. Deterministic: run it twice and the bytes match.
 *
 * Run from the repo root (the import below reads the repo's own renderer):
 *   pnpm exec tsx site/scripts/make-og.mts [siteDir]
 * It writes only `<siteDir>/public/og-field.png`; siteDir defaults to `site/`. Commit the
 * output; Vercel needs nothing outside `site/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BAYER8, FACE, INK_STOPS, ORB, encodePng, faceMask, orbGeometry, orbGlow, orbInside, quantiseDither, rampAt, type RGB } from "../../scripts/dither.ts";

const W = 1200;
const H = 630;
const CELL = 8;
const BANDS = 5;
const ORB_RADIUS = 210;
const ORB_X = 300;
const ORB_Y = 315;

function renderOgField(): Buffer {
  const px = Buffer.alloc(W * H * 4);
  // `ORB.r` is the orb's radius in bodyR units: pick bodyR so the disc is ORB_RADIUS px.
  const bodyR = ORB_RADIUS / ORB.r;
  const bands = ORB.bands(W);
  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  // The face on the field's own cell grid; a cell is glyph, box or orb.
  const face = faceMask(cols, rows, CELL, ORB_X, ORB_Y, ORB_RADIUS);

  for (let y = 0; y < H; y++) {
    const cellRow = (Math.floor(y / CELL) % 8) * 8;
    const faceRow = Math.floor(y / CELL) * cols;
    const fy = (y + 0.5) / H;
    const sy = (y + 0.5 - ORB_Y) / bodyR;
    for (let x = 0; x < W; x++) {
      const t = BAYER8[cellRow + (Math.floor(x / CELL) % 8)] ?? 0.5;
      // The field: the diagonal parameter spans the whole box, 0 at the upper left, 1 at the lower right.
      const fx = (x + 0.5) / W;
      const fu = 0.5 + (fx - 0.5 + (fy - 0.5)) / 2;
      const field: RGB = rampAt(INK_STOPS, quantiseDither(fu, BANDS, t));
      // The orb over it, and the face over the orb (inside the disc only).
      const g = orbGeometry((x + 0.5 - ORB_X) / bodyR, sy);
      let col = g.sd <= 0 ? orbInside(g, bands, t, FACE.gleam) : orbGlow(g, field, t);
      if (g.sd <= 0) {
        const hit = face[faceRow + Math.floor(x / CELL)];
        if (hit === 1) col = FACE.ink;
        else if (hit === 2) col = FACE.box;
      }
      const i = (y * W + x) * 4;
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = 255;
    }
  }
  return px;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const siteDir = resolve(process.argv[2] ?? join(here, ".."));
  const out = join(siteDir, "public", "og-field.png");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(W, renderOgField(), H));
  console.log(`  ${out} (${W}×${H})`);
}

main();
