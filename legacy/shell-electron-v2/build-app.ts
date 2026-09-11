#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";

/**
 * Package Jarhead.app.
 *
 * The bundle is Electron plus a two-line launcher that points at this checkout;
 * the code runs from the repo through tsx, so a rebuild is `git pull`. The app
 * exists for what only an app can have: a Dock icon, and a stable TCC identity
 * for the microphone, screen recording, and accessibility grants.
 */

const OUT = join(REPO_ROOT, "build");
const STAGE = join(OUT, "app-src");
const APP = join(OUT, "JarheadElectron.app"); // the native bundle owns build/Jarhead.app
const electronDist = join(REPO_ROOT, "node_modules", "electron", "dist", "Electron.app");
if (!existsSync(electronDist)) {
  console.error(`Electron not found at ${electronDist}. Run: pnpm install`);
  process.exit(1);
}
for (const f of ["icon.png", "Jarhead.icns"]) {
  if (!existsSync(join(OUT, f))) {
    console.error(`missing ${join(OUT, f)}; run pnpm build:icon first`);
    process.exit(1);
  }
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
writeFileSync(
  join(STAGE, "main.js"),
  `// Jarhead launcher: the app runs from the checkout so a rebuild is a git pull.\nconst repo = ${JSON.stringify(REPO_ROOT)};\nprocess.chdir(repo);\nrequire(repo + "/packages/shell/src/electron-entry.cjs");\n`,
);
writeFileSync(join(STAGE, "package.json"), `${JSON.stringify({ name: "jarhead", productName: "Jarhead", version: "2.0.0", main: "main.js" }, null, 2)}\n`);

rmSync(APP, { recursive: true, force: true });
cpSync(electronDist, APP, { recursive: true, verbatimSymlinks: true });
const contents = join(APP, "Contents");
const resources = join(contents, "Resources");
rmSync(join(resources, "default_app.asar"), { force: true });
cpSync(STAGE, join(resources, "app"), { recursive: true });
copyFileSync(join(OUT, "Jarhead.icns"), join(resources, "electron.icns"));
execFileSync("mv", [join(contents, "MacOS", "Electron"), join(contents, "MacOS", "Jarhead")]);

writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jarhead</string>
  <key>CFBundleDisplayName</key><string>Jarhead</string>
  <key>CFBundleExecutable</key><string>Jarhead</string>
  <!-- Kept from v1 on purpose: TCC keys grants to this identifier. -->
  <key>CFBundleIdentifier</key><string>com.kevinliu.jarvis</string>
  <key>CFBundleIconFile</key><string>electron.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0.0</string>
  <key>CFBundleVersion</key><string>2.0.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Jarhead listens so you can talk to it.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Jarhead reads the accessibility tree to find controls on screen.</string>
  <key>NSSystemAdministrationUsageDescription</key>
  <string>Jarhead needs accessibility access to move the cursor, click, and type for you.</string>
</dict>
</plist>
`,
);

function pickIdentity(): string | undefined {
  const pinned = process.env["JARHEAD_SIGN_IDENTITY"];
  if (pinned) return pinned;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const names = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    return names.find((n) => n.startsWith("Developer ID Application")) ?? names.find((n) => n.startsWith("Apple Development")) ?? names[0];
  } catch {
    return undefined;
  }
}

const identity = pickIdentity();
const entitlements = join(REPO_ROOT, "build-config", "entitlements.plist");
if (identity) {
  const nested = execFileSync("find", [APP, "-type", "f", "-name", "*.dylib", "-o", "-type", "d", "-name", "*.framework", "-o", "-type", "d", "-name", "*.app"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== APP)
    .sort((a, b) => b.length - a.length);
  for (const path of nested) execFileSync("codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, path]);
  execFileSync("codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, APP], { stdio: "inherit" });
} else {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP], { stdio: "inherit" });
}
execFileSync("codesign", ["--verify", "--strict", APP], { stdio: "inherit" });

console.log(`\n  built ${APP}\n  runs from: ${REPO_ROOT}\n  signed with: ${identity ?? "ad-hoc (TCC grants reset on every rebuild)"}\n\n  install:  cp -R "${APP}" /Applications/\n  run:      open -a Jarhead\n`);
