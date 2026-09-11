#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";

/**
 * Package the native macOS app: build/Jarhead.app.
 *
 * The bundle holds the Swift binary and the jarhead-hands helper; the daemon still
 * runs from this checkout through tsx (Contents/Resources/jarhead.json says where),
 * so a rebuild of the engine is `git pull`. The bundle exists for what only a bundle
 * can have: a Dock icon and a stable TCC identity for the microphone, screen
 * recording and accessibility grants (the helper inherits it because the app is its
 * responsible process).
 */

const OUT = join(REPO_ROOT, "build");
const APP = join(OUT, "Jarhead.app");
const MAC = join(REPO_ROOT, "apps", "mac");
const RESOURCES_SRC = join(MAC, "Resources");

function run(cmd: string, args: readonly string[], opts: { cwd?: string; quiet?: boolean } = {}): string {
  console.log(`[build-mac] ${cmd} ${args.join(" ")}`);
  const out = execFileSync(cmd, [...args], { cwd: opts.cwd ?? REPO_ROOT, encoding: "utf8", stdio: opts.quiet ? ["ignore", "pipe", "inherit"] : ["ignore", "inherit", "inherit"] });
  return typeof out === "string" ? out : "";
}

function need(path: string, hint: string): void {
  if (!existsSync(path)) {
    console.error(`[build-mac] missing ${path}; ${hint}`);
    process.exit(1);
  }
}

// 1. Prerequisites we can produce ourselves.
const hands = join(OUT, "jarhead-hands");
if (handsIsStale(hands)) run("pnpm", ["build:hands"]);
need(hands, "pnpm build:hands failed");

/** The bundle freezes a copy of the helper, so rebuild it whenever its sources are newer. */
function handsIsStale(bin: string): boolean {
  if (!existsSync(bin)) return true;
  const built = statSync(bin).mtimeMs;
  const nativeDir = join(REPO_ROOT, "packages", "hands", "native");
  const sources = readdirSync(nativeDir).filter((f) => f.endsWith(".swift")).map((f) => join(nativeDir, f));
  sources.push(join(REPO_ROOT, "scripts", "build-hands.ts"));
  return sources.some((f) => statSync(f).mtimeMs > built);
}

const icns = join(OUT, "Jarhead.icns");
if (!existsSync(icns)) run("pnpm", ["build:icon"]);
need(icns, "pnpm build:icon failed");

need(join(RESOURCES_SRC, "Info.plist"), "apps/mac/Resources/Info.plist is part of the repo");
need(join(RESOURCES_SRC, "entitlements.plist"), "apps/mac/Resources/entitlements.plist is part of the repo");

// 2. Build the Swift package.
run("swift", ["build", "-c", "release", "--package-path", MAC]);
const binDir = run("swift", ["build", "-c", "release", "--package-path", MAC, "--show-bin-path"], { quiet: true }).trim();
const binary = join(binDir, "Jarhead");
need(binary, "swift build produced no Jarhead binary");

// 3. Assemble the bundle.
rmSync(APP, { recursive: true, force: true });
const contents = join(APP, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });

copyFileSync(binary, join(macos, "Jarhead"));
chmodSync(join(macos, "Jarhead"), 0o755);
copyFileSync(hands, join(macos, "jarhead-hands"));
chmodSync(join(macos, "jarhead-hands"), 0o755);
copyFileSync(icns, join(resources, "Jarhead.icns"));
copyFileSync(join(RESOURCES_SRC, "Info.plist"), join(contents, "Info.plist"));
writeFileSync(join(contents, "PkgInfo"), "APPL????");

const manifest = {
  repo: REPO_ROOT,
  node: process.execPath,
  tsx: join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
  daemon: join(REPO_ROOT, "packages", "daemon", "src", "main.ts"),
};
for (const [k, v] of Object.entries(manifest)) need(v, `jarhead.json field "${k}" points nowhere; run pnpm install`);
writeFileSync(join(resources, "jarhead.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 4. Sign: helper first, then the app. Any real identity (Apple-issued or a local
// self-signed certificate) gives the bundle a designated requirement that survives
// rebuilds, so TCC keeps the microphone/screen/accessibility grants. Ad-hoc signing
// keys them to the code hash, which changes every build.
function pickIdentity(): string | undefined {
  const pinned = process.env["JARHEAD_SIGN_IDENTITY"];
  if (pinned) return pinned === "-" ? undefined : pinned;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const names = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").filter(Boolean);
    return (
      names.find((n) => n.startsWith("Apple Development")) ??
      names.find((n) => n.startsWith("Developer ID Application")) ??
      names[0]
    );
  } catch {
    return undefined;
  }
}

const entitlements = join(RESOURCES_SRC, "entitlements.plist");
const identity = pickIdentity();
const sign = identity ?? "-";
// Timestamps only make sense for Apple-issued certificates (and need the network).
const appleIssued = identity !== undefined && /^(Apple Development|Developer ID Application)/.test(identity);
const common = identity ? ["--force", ...(appleIssued ? ["--timestamp"] : []), "--options", "runtime"] : ["--force"];
run("codesign", [...common, "--sign", sign, join(macos, "jarhead-hands")]);
run("codesign", [...common, "--entitlements", entitlements, "--sign", sign, APP]);
run("codesign", ["--verify", "--strict", "--verbose=1", APP]);

// An installed copy is kept identical to the fresh build, so the Dock entry, the
// /Applications entry and TCC all see the same bundle.
const installed = "/Applications/Jarhead.app";
let installNote = `install:   cp -R "${APP}" /Applications/`;
if (existsSync(installed)) {
  rmSync(installed, { recursive: true, force: true });
  execFileSync("cp", ["-R", APP, "/Applications/"]);
  installNote = `installed  ${installed} (refreshed)`;
}

const size = statSync(join(macos, "Jarhead")).size;
console.log(`
  built      ${APP}
  binary     ${(size / (1024 * 1024)).toFixed(1)} MiB
  daemon     ${manifest.node} ${manifest.tsx} ${manifest.daemon}
  signed     ${identity ?? "ad-hoc (TCC grants reset on every rebuild; create a code-signing certificate in Keychain Access or set JARHEAD_SIGN_IDENTITY)"}

  ${installNote}
  run:       open -a Jarhead
  logs:      tail -f ~/.jarhead/daemon.log
`);
