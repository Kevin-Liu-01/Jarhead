#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarvis/core";

/**
 * Package Jarhead.app.
 *
 * The bundle is a thin face: Dock icon, tray, hotkey, overlay. Everything heavy
 * stays in this repo and is shelled out to, so the .app does not have to carry
 * tsx, esbuild and the whole TypeScript tree. The repo path is written into the
 * bundle at build time — this is a personal app on one machine, not something
 * being distributed.
 *
 * Note on permissions: the bundle is its own TCC identity. Grants given to the
 * terminal do NOT carry over, so macOS will prompt again on first use of the
 * mic, screen and accessibility. The Info.plist usage strings below are what
 * those prompts show.
 */

const OUT = join(REPO_ROOT, "build");
const STAGE = join(OUT, "app-src");
const APP = join(OUT, "Jarhead.app");

const electronDist = join(REPO_ROOT, "node_modules", "electron", "dist", "Electron.app");
if (!existsSync(electronDist)) {
  console.error(`Electron not found at ${electronDist}. Run: pnpm add -D -w electron`);
  process.exit(1);
}

// --- stage the app source ---------------------------------------------------
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const file of ["main.js", "window-bounds.js", "contacts.js"]) {
  copyFileSync(join(REPO_ROOT, "packages", "app", file), join(STAGE, file));
}
copyFileSync(join(OUT, "icon.png"), join(STAGE, "icon.png"));
copyFileSync(join(OUT, "iconTemplate.png"), join(STAGE, "iconTemplate.png"));
copyFileSync(join(OUT, "iconTemplate@2x.png"), join(STAGE, "iconTemplate@2x.png"));
writeFileSync(join(STAGE, "repo-path.json"), `${JSON.stringify({ repo: REPO_ROOT }, null, 2)}\n`);
writeFileSync(
  join(STAGE, "package.json"),
  `${JSON.stringify({ name: "jarhead", productName: "Jarhead", version: "0.1.0", main: "main.js" }, null, 2)}\n`,
);

// --- clone the Electron bundle ---------------------------------------------
rmSync(APP, { recursive: true, force: true });
cpSync(electronDist, APP, { recursive: true, verbatimSymlinks: true });

const contents = join(APP, "Contents");
const resources = join(contents, "Resources");

// Electron's default app is a placeholder; ours replaces it.
rmSync(join(resources, "default_app.asar"), { force: true });
cpSync(STAGE, join(resources, "app"), { recursive: true });
copyFileSync(join(OUT, "Jarhead.icns"), join(resources, "electron.icns"));

// Renaming the executable is what makes the process show as "Jarhead" rather
// than "Electron" in Activity Monitor, the Dock and every TCC prompt.
const macos = join(contents, "MacOS");
execFileSync("mv", [join(macos, "Electron"), join(macos, "Jarhead")]);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jarhead</string>
  <key>CFBundleDisplayName</key><string>Jarhead</string>
  <key>CFBundleExecutable</key><string>Jarhead</string>
  <!-- Deliberately still ".jarvis" after the rename to Jarhead: TCC keys its
       grants to the bundle identifier, so changing this string would silently
       revoke Microphone, Screen Recording and Accessibility and make Kevin
       approve all three again. The identifier is invisible; the name is not. -->
  <key>CFBundleIdentifier</key><string>com.kevinliu.jarvis</string>
  <key>CFBundleIconFile</key><string>electron.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Jarhead listens when you say "hey jarhead", so it can answer out loud.</string>
  <key>NSCameraUsageDescription</key>
  <string>Jarhead does not use the camera.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Jarhead reads the accessibility tree to find and point at buttons on screen.</string>
  <key>NSSystemAdministrationUsageDescription</key>
  <string>Jarhead needs accessibility access to move the cursor and click for you.</string>
</dict>
</plist>
`;
writeFileSync(join(contents, "Info.plist"), plist);

/**
 * Sign with a stable identity when one exists, ad-hoc otherwise.
 *
 * This is the whole TCC story. macOS keys Screen Recording, Accessibility and
 * Microphone grants to the code signature, so an ad-hoc build invalidates every
 * grant each time it is rebuilt — you re-approve three prompts after every
 * change. A real certificate makes the identity stable and the grants stick.
 *
 * Set JARVIS_SIGN_IDENTITY to pin one explicitly; otherwise the first Apple
 * identity found wins, preferring Developer ID (distributable) over Apple
 * Development (this machine only).
 */
function pickIdentity(): string | undefined {
  const pinned = process.env["JARVIS_SIGN_IDENTITY"];
  if (pinned) return pinned;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const names = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    // Preference order is about distribution, not about whether grants stick:
    // ANY stable identity keeps TCC happy across rebuilds, including a
    // self-signed one. Developer ID is only needed to run on other machines.
    return (
      names.find((n) => n.startsWith("Developer ID Application")) ??
      names.find((n) => n.startsWith("Apple Development")) ??
      names.find((n) => n.startsWith("Apple Distribution")) ??
      names[0]
    );
  } catch {
    return undefined;
  }
}

const identity = pickIdentity();
const entitlements = join(REPO_ROOT, "build-config", "entitlements.plist");

if (identity) {
  // Sign inside-out: nested helpers and frameworks first, the outer bundle last.
  // --deep is documented as unreliable for exactly this and Apple advises against
  // it for real signing.
  const nested = execFileSync(
    "find",
    [APP, "-type", "f", "-name", "*.dylib", "-o", "-type", "d", "-name", "*.framework", "-o", "-type", "d", "-name", "*.app"],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== APP)
    .sort((a, b) => b.length - a.length); // deepest first

  for (const path of nested) {
    execFileSync("codesign", [
      "--force", "--timestamp", "--options", "runtime",
      "--entitlements", entitlements,
      "--sign", identity, path,
    ]);
  }
  execFileSync("codesign", [
    "--force", "--timestamp", "--options", "runtime",
    "--entitlements", entitlements,
    "--sign", identity, APP,
  ], { stdio: "inherit" });
} else {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP], { stdio: "inherit" });
}

execFileSync("codesign", ["--verify", "--strict", APP], { stdio: "inherit" });

console.log(`\n  built ${APP}`);
console.log(`  repo baked in: ${REPO_ROOT}`);
console.log(`  signed with:   ${identity ?? "ad-hoc (TCC grants reset on every rebuild)"}`);
if (!identity) {
  console.log(`\n  For grants that survive rebuilds, see "Signing" in README.md.`);
}
console.log(`\n  install:  cp -R "${APP}" /Applications/`);
console.log(`  run:      open -a Jarhead\n`);
