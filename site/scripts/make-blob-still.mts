/**
 * Renders public/blob-still.png: the 300 px blue orb wearing `O O` with its listening halo, on
 * nothing (transparent), at 2× for Retina (600 px, 3 px cells = 1.5 CSS px). The blob's host paints
 * it as its background so no-JS and pre-paint show the resting blob (design.md §5, Fallbacks).
 *
 * Run by hand from the repo root, read-only against the repo's PNG encoder; commit the PNG:
 *   pnpm exec tsx site/scripts/make-blob-still.mts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderOrb } from "../lib/orb.ts";
import { encodePng } from "../../scripts/dither.ts";

const here = dirname(fileURLToPath(import.meta.url));
const size = 600;
const img = renderOrb({
  size,
  cell: 3,
  face: "OO",
  halo: { color: [90, 215, 255], glow: 0.6, backing: null }, // --jh-listening, listening's glow .60, no dark backing
});
const rgba = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
const out = join(here, "..", "public", "blob-still.png");
writeFileSync(out, encodePng(size, rgba, size));
console.log(`blob-still: ${out} (${size}×${size}, cell 3)`);
