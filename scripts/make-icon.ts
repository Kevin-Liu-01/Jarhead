#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";
import { Strip, encodePng } from "./dither.ts";
import { SIZES, checkIcon, renderIcon } from "./icon-render.ts";

/**
 * Generate the Dock icon: build/Jarhead.icns, build/icon.png (a 1024 preview),
 * docs/media/icon.png (the README's 256) and the contact strip of the 16 … 256 renders
 * with the small ones blown up 4× beside them (apps/mac/Resources/preview-icon-sizes.png
 * and its README copy docs/media/icon-sizes.png), so the dither and the face can be
 * checked by eye — the mark is the orb wearing the blob's `^ ^`.
 *
 * Written as raw pixels rather than shipping a binary asset: an .icns needs
 * seven sizes, and a hand-drawn one would either be a blurry upscale or a file
 * nobody can regenerate. Deterministic and editable — change `P` (scripts/icon-render.ts)
 * or `ORB` (scripts/dither.ts) and re-run. The pixels themselves come from
 * `renderIcon` in scripts/icon-render.ts, which is pure and pinned by
 * scripts/__tests__/icon.test.ts; this file only writes them where they belong.
 */

/** The 1024 render's RGBA — kept for callers that imported it from here. */
export function renderRgba(size: number): Buffer {
  return renderIcon(size).px;
}

const iconset = join(REPO_ROOT, "build", "Jarhead.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const renders = new Map<number, Buffer>();
for (const size of SIZES) {
  const r = renderIcon(size);
  // Corners must be fully transparent and the centre fully opaque at every size.
  checkIcon(r);
  const rgba = r.px;
  renders.set(size, rgba);
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
const stripPng = encodePng(stripW, strip.px, stripH);
writeFileSync(stripPath, stripPng);
// The README shows the same strip; written here too so the two never drift by one forgotten
// `scripts/make-readme-shots.sh icon` (which keeps copying it — idempotent).
const mediaStrip = join(REPO_ROOT, "docs", "media", "icon-sizes.png");
writeFileSync(mediaStrip, stripPng);

console.log(`  ${icns}`);
console.log(`  ${join(REPO_ROOT, "build", "icon.png")}`);
console.log(`  ${mediaIcon}`);
console.log(`  ${stripPath}`);
console.log(`  ${mediaStrip}`);
