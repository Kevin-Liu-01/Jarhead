#!/usr/bin/env tsx
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarvis/core";

/**
 * Generate the Dock icon.
 *
 * Written as raw pixels rather than shipping a binary asset: an .icns needs
 * eight sizes, and a hand-drawn one would either be a blurry upscale or a file
 * nobody can regenerate. This is deterministic and editable — change the numbers
 * and re-run.
 *
 * The mark is the listening ring: a soft-edged circle with a brighter arc, which
 * reads at 32px in the Dock as well as at 1024.
 */

const BG_TOP: RGB = [18, 20, 28];
const BG_BOTTOM: RGB = [11, 12, 18];
const RING: RGB = [122, 162, 255];
const GLOW: RGB = [64, 92, 168];

type RGB = readonly [number, number, number];

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Smooth 0→1 across `edge`, so nothing in the icon has a hard aliased boundary. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function renderRgba(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2;

  // macOS icons are a squircle inset from the canvas, not edge-to-edge.
  const bodyR = r * 0.82;
  const corner = bodyR * 0.62;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;

      // Superellipse: |dx|^n + |dy|^n = bodyR^n approximates Apple's squircle.
      const n = 4.2;
      const sq = (Math.abs(dx) / bodyR) ** n + (Math.abs(dy) / bodyR) ** n;
      const inBody = 1 - smoothstep(0.92, 1.06, sq);

      const vertical = (y / size + 0.15) * 0.9;
      let [rr, gg, bb] = mix(BG_TOP, BG_BOTTOM, Math.min(1, vertical));

      const dist = Math.hypot(dx, dy);

      // Glow under the ring so it does not look pasted onto the background.
      const glow = Math.exp(-((dist - r * 0.42) ** 2) / (2 * (r * 0.2) ** 2)) * 0.55;
      [rr, gg, bb] = mix([rr, gg, bb], GLOW, glow);

      // The ring itself: a band, brightest at the top-left where light falls.
      const band = 1 - smoothstep(0, r * 0.075, Math.abs(dist - r * 0.42));
      if (band > 0) {
        const angle = Math.atan2(dy, dx);
        const lit = 0.55 + 0.45 * Math.cos(angle + Math.PI * 0.75);
        [rr, gg, bb] = mix([rr, gg, bb], RING, band * (0.35 + 0.65 * lit));
      }

      // Center dot — the "it heard you" pip.
      const dot = 1 - smoothstep(r * 0.1, r * 0.14, dist);
      if (dot > 0) [rr, gg, bb] = mix([rr, gg, bb], RING, dot);

      const i = (y * size + x) * 4;
      px[i] = rr;
      px[i + 1] = gg;
      px[i + 2] = bb;
      px[i + 3] = Math.round(255 * inBody);
      void corner;
    }
  }
  return px;
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

/**
 * The menu-bar icon is a TEMPLATE image: macOS only reads its alpha channel and
 * paints the result itself, so it must be black-plus-alpha. Handing it the
 * full-colour icon produced a solid filled blob in the menu bar, because every
 * opaque pixel of the squircle became silhouette. Here the body is transparent
 * and only the ring and pip carry alpha.
 */
function renderTemplateRgba(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - c, y - c);
      const ring = 1 - smoothstep(0, Math.max(1, r * 0.14), Math.abs(dist - r * 0.62));
      const dot = 1 - smoothstep(r * 0.14, r * 0.22, dist);
      const a = Math.min(1, ring + dot);
      const i = (y * size + x) * 4;
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
      px[i + 3] = Math.round(255 * a);
    }
  }
  return px;
}

const SIZES = [16, 32, 64, 128, 256, 512, 1024] as const;

const iconset = join(REPO_ROOT, "build", "Jarhead.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

for (const size of SIZES) {
  const png = encodePng(size, renderRgba(size));
  // iconutil wants both @1x and @2x names; the @2x of N is the 2N render.
  if (size <= 512) writeFileSync(join(iconset, `icon_${size}x${size}.png`), png);
  if (size >= 32) writeFileSync(join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png);
}

const icns = join(REPO_ROOT, "build", "Jarhead.icns");
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
writeFileSync(join(REPO_ROOT, "build", "icon.png"), encodePng(1024, renderRgba(1024)));
writeFileSync(join(REPO_ROOT, "build", "iconTemplate.png"), encodePng(22, renderTemplateRgba(22)));
writeFileSync(join(REPO_ROOT, "build", "iconTemplate@2x.png"), encodePng(44, renderTemplateRgba(44)));

console.log(`  ${icns}`);
console.log(`  ${join(REPO_ROOT, "build", "icon.png")}`);
console.log(`  ${join(REPO_ROOT, "build", "iconTemplate.png")} (+ @2x)`);
