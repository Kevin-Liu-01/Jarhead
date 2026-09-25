// Copies docs/media/* next to the page so every capture is served at /media/<file> as the repo's own bytes.
// public/media is gitignored; a symlink there (a builder's working copy) is left alone.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "docs", "media");
const out = resolve(here, "..", "public", "media");

if (existsSync(out) && lstatSync(out).isSymbolicLink()) {
  console.log(`copy-media: ${out} is a link; leaving it`);
  process.exit(0);
}
if (!existsSync(src)) {
  console.error(`copy-media: ${src} is missing; the checkout must include the repo root`);
  process.exit(1);
}
if (existsSync(out) && realpathSync(out) === realpathSync(src)) {
  console.log(`copy-media: ${out} is the source; nothing to do`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });
let n = 0;
for (const name of readdirSync(src)) {
  if (name.startsWith(".")) continue;
  const from = join(src, name);
  if (!lstatSync(from).isFile()) continue;
  copyFileSync(from, join(out, name));
  n += 1;
}
console.log(`copy-media: ${n} files → ${out}`);
