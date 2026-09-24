// Copies the installer next to the page so /install.sh is the same file as scripts/install.sh.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "scripts", "install.sh");
const out = join(here, "..", "public", "install.sh");
if (!existsSync(src)) {
  console.error(`copy-install: ${src} is missing; the checkout must include the repo root`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
copyFileSync(src, out);
console.log(`copy-install: ${out}`);
