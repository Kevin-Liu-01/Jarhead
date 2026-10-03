/**
 * A token's value as the token sheet declares it (app/globals.css), for the server's few places that need a colour as a
 * string: the theme-color the boot script stamps, the manifest, the OG image and the blob's build-time stills. One
 * source, so no raw colour lives outside the sheet. Server-only (it reads the file at build; a literal path, so the build
 * traces it).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHEET = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

/** The value of `name` in the light sheet (`:root`) or the dark one (`html[data-theme="dark"]`). */
export function token(name: `--jh-${string}`, theme: "light" | "dark" = "light"): string {
  const head = theme === "dark" ? 'html[data-theme="dark"] {' : ":root {";
  const at = SHEET.indexOf(head);
  const block = at < 0 ? "" : SHEET.slice(at, SHEET.indexOf("\n}", at));
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  if (!m?.[1]) throw new Error(`tokens: no ${name} in the ${theme} sheet`);
  return m[1].trim();
}
