#!/usr/bin/env tsx
/**
 * The site's favicon set, from the Dock icon's own renderer (scripts/icon-render.ts): the
 * same orb, the same face rule, the same grain, so the tab and the Dock never drift.
 *
 *   app/icon.png                 32   the 3 × 2 mini face (Next emits <link rel="icon">)
 *   public/favicon-16.png        16   faceless: a dot pair with its shadow (no face below the Dock's 32 px class)
 *   app/apple-icon.png          180   flattened on ink: iOS paints transparency black; the squircle keeps its corners
 *   public/icon-192.png         192   transparent, manifest purpose "any"
 *   public/icon-512.png         512   transparent, manifest purpose "any"
 *   public/icon-192-maskable.png 192  on ink, the squircle at 80 % of the canvas (the maskable safe zone)
 *   public/icon-512-maskable.png 512  the same at 512
 *   public/favicon.ico   48, 32, 16   one ICO of transparent PNGs (Google wants a 48 px multiple); 48 is the 192 render
 *                                    averaged 4 × 4, since the renderer draws no face at 48
 *
 * Every render passes `checkIcon` (corners clear, centre opaque, the face flat and mirrored)
 * before it is written. Deterministic: regenerate only when scripts/{icon-render,dither}.ts
 * change, and commit the output.
 *
 * Run from the repo root (the imports below read the repo's own renderer):
 *   pnpm exec tsx site/scripts/make-icons.mts [siteDir]
 * It writes only into `<siteDir>/app` and `<siteDir>/public`; siteDir defaults to `site/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INK, Strip, encodePng, type RGB } from "../../scripts/dither.ts";
import { checkIcon, renderIcon } from "../../scripts/icon-render.ts";

/** The maskable pair: the squircle scaled to this fraction of the canvas, the rest ink. */
const MASKABLE_SCALE = 0.8;

/** One render, checked. */
function icon(size: number): Buffer {
  const r = renderIcon(size);
  checkIcon(r);
  return r.px;
}

/** The transparent tile as a PNG. */
function transparent(size: number): Buffer {
  return encodePng(size, icon(size));
}

/** The tile source-over an opaque ground of the same size. */
function flattened(size: number, ground: RGB): Buffer {
  const strip = new Strip(size, size, ground);
  strip.paste(icon(size), size, 0, 0);
  return encodePng(size, strip.px);
}

/**
 * The tile at `scale` of the canvas, centred on an opaque ground. The inner size snaps to a
 * multiple of both 2 and its own dither cell (`round(inner / 64)` px), so the orb's centre
 * sits on a pixel boundary and the cell grid mirrors about it: 154 at 192, 408 at 512.
 */
function maskable(size: number, scale: number, ground: RGB): Buffer {
  const want = size * scale;
  const cell = Math.max(1, Math.round(want / 64));
  const step = cell % 2 === 0 ? cell : 2 * cell;
  const inner = Math.round(want / step) * step;
  const offset = Math.round((size - inner) / 2);
  const strip = new Strip(size, size, ground);
  strip.paste(icon(inner), inner, offset, offset);
  return encodePng(size, strip.px);
}

/**
 * A transparent tile at a size the renderer draws no face for, such as 48 (hand bitmaps at 16 and 32; the chevrons hold
 * on the 64-cell grid, and a 96 render bends them): the render at `factor` times the size, box-averaged factor × factor
 * in premultiplied alpha. At 48 that is the 192 render (the 64-cell pattern in 3 px cells) over 4: softer than the
 * hand-drawn sizes, the same face.
 */
function averaged(size: number, factor: number): Buffer {
  const big = icon(factor * size);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((factor * y + dy) * factor * size + factor * x + dx) * 4;
          const alpha = big[i + 3] ?? 0;
          r += (big[i] ?? 0) * alpha;
          g += (big[i + 1] ?? 0) * alpha;
          b += (big[i + 2] ?? 0) * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (factor * factor));
    }
  }
  return encodePng(size, out);
}

/**
 * An ICO of PNG entries, largest first (a reader that takes the first entry gets the biggest): the 6-byte ICONDIR, one
 * 16-byte ICONDIRENTRY per image, then the PNGs themselves.
 */
function ico(images: ReadonlyArray<{ readonly size: number; readonly png: Buffer }>): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); // type 1: icon (the reserved word before it stays 0)
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  for (const [i, { size, png }] of images.entries()) {
    const entry = 6 + 16 * i;
    head.writeUInt8(size % 256, entry); // width; 0 means 256
    head.writeUInt8(size % 256, entry + 1); // height
    head.writeUInt16LE(1, entry + 4); // colour planes (palette size and reserved stay 0)
    head.writeUInt16LE(32, entry + 6); // bits per pixel
    head.writeUInt32LE(png.length, entry + 8);
    head.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  return Buffer.concat([head, ...images.map(({ png }) => png)]);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const siteDir = resolve(process.argv[2] ?? join(here, ".."));
  const files: ReadonlyArray<readonly [string, () => Buffer]> = [
    ["app/icon.png", () => transparent(32)],
    ["public/favicon-16.png", () => transparent(16)],
    ["app/apple-icon.png", () => flattened(180, INK)],
    ["public/icon-192.png", () => transparent(192)],
    ["public/icon-512.png", () => transparent(512)],
    ["public/icon-192-maskable.png", () => maskable(192, MASKABLE_SCALE, INK)],
    ["public/icon-512-maskable.png", () => maskable(512, MASKABLE_SCALE, INK)],
    [
      "public/favicon.ico",
      () => ico([{ size: 48, png: averaged(48, 4) }, { size: 32, png: transparent(32) }, { size: 16, png: transparent(16) }]),
    ],
  ];
  for (const [rel, render] of files) {
    const out = join(siteDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, render());
    console.log(`  ${out}`);
  }
}

main();
