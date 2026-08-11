#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarvis/core";

/**
 * Package Jarvis.app.
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
const APP = join(OUT, "Jarvis.app");

const electronDist = join(REPO_ROOT, "node_modules", "electron", "dist", "Electron.app");
if (!existsSync(electronDist)) {
  console.error(`Electron not found at ${electronDist}. Run: pnpm add -D -w electron`);
  process.exit(1);
}

// --- stage the app source ---------------------------------------------------
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
copyFileSync(join(REPO_ROOT, "packages", "app", "main.js"), join(STAGE, "main.js"));
copyFileSync(join(OUT, "icon.png"), join(STAGE, "icon.png"));
copyFileSync(join(OUT, "iconTemplate.png"), join(STAGE, "iconTemplate.png"));
copyFileSync(join(OUT, "iconTemplate@2x.png"), join(STAGE, "iconTemplate@2x.png"));
writeFileSync(join(STAGE, "repo-path.json"), `${JSON.stringify({ repo: REPO_ROOT }, null, 2)}\n`);
writeFileSync(
  join(STAGE, "package.json"),
  `${JSON.stringify({ name: "jarvis", productName: "Jarvis", version: "0.1.0", main: "main.js" }, null, 2)}\n`,
);

// --- clone the Electron bundle ---------------------------------------------
rmSync(APP, { recursive: true, force: true });
cpSync(electronDist, APP, { recursive: true, verbatimSymlinks: true });

const contents = join(APP, "Contents");
const resources = join(contents, "Resources");

// Electron's default app is a placeholder; ours replaces it.
rmSync(join(resources, "default_app.asar"), { force: true });
cpSync(STAGE, join(resources, "app"), { recursive: true });
copyFileSync(join(OUT, "Jarvis.icns"), join(resources, "electron.icns"));

// Renaming the executable is what makes the process show as "Jarvis" rather
// than "Electron" in Activity Monitor, the Dock and every TCC prompt.
const macos = join(contents, "MacOS");
execFileSync("mv", [join(macos, "Electron"), join(macos, "Jarvis")]);

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jarvis</string>
  <key>CFBundleDisplayName</key><string>Jarvis</string>
  <key>CFBundleExecutable</key><string>Jarvis</string>
  <key>CFBundleIdentifier</key><string>com.kevinliu.jarvis</string>
  <key>CFBundleIconFile</key><string>electron.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Jarvis listens when you hold the hotkey, so it can answer out loud.</string>
  <key>NSCameraUsageDescription</key>
  <string>Jarvis does not use the camera.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Jarvis reads the accessibility tree to find and point at buttons on screen.</string>
  <key>NSSystemAdministrationUsageDescription</key>
  <string>Jarvis needs accessibility access to move the cursor and click for you.</string>
</dict>
</plist>
`;
writeFileSync(join(contents, "Info.plist"), plist);

// An ad-hoc signature is enough to launch locally, but TCC grants are keyed to
// the signature — so they are lost on every rebuild unless a stable identity is
// used. That is the price of not having an Apple Developer certificate.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP], { stdio: "inherit" });

console.log(`\n  built ${APP}`);
console.log(`  repo baked in: ${REPO_ROOT}`);
console.log(`\n  install:  cp -R "${APP}" /Applications/`);
console.log(`  run:      open -a Jarvis\n`);
