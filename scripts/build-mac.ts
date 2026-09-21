#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";
import { JARHEAD_BUNDLE_ID, compareTrees, defaultExec, performInstall, probeTarget, runHygiene, type InstallIO } from "@jarhead/install";
import { ICON_SOURCES, staleAgainst } from "./icon-render.ts";
import { chooseIdentity, identityLine, identityNames, type IdentityChoice } from "./sign-identity.ts";

/**
 * Package the native macOS app: build/Jarhead.app.
 *
 * The bundle holds the Swift binary and the jarhead-hands helper; the daemon still
 * runs from this checkout through tsx (Contents/Resources/jarhead.json says where),
 * so a rebuild of the engine is `git pull`. The bundle exists for what only a bundle
 * can have: a Dock icon and a stable TCC identity for the microphone, screen
 * recording and accessibility grants (the helper inherits it because the app is its
 * responsible process).
 *
 * JARHEAD_BUILD_ONLY=1 stops after the stage bundle is signed and `codesign --verify
 * --strict` passes: the summary names the stage and nothing under /Applications is read or
 * written (no snapshot, rsync, install verification, parity, inode check, hygiene or
 * relink). CI runs the icon, the release build and the signing this way; so can a dry run.
 * JARHEAD_SIGN_IDENTITY pins the signing identity (`-` = ad-hoc); without it the order is
 * scripts/sign-identity.ts's, and the pick is printed before the first codesign call.
 */

const OUT = join(REPO_ROOT, "build");
/** The bundle is assembled and signed here, then installed; build/Jarhead.app becomes a symlink. */
const STAGE_APP = join(OUT, "stage", "Jarhead.app");
const APP = STAGE_APP;
const INSTALLED = "/Applications/Jarhead.app";
const LINK = join(OUT, "Jarhead.app");
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
if (iconIsStale(icns)) run("pnpm", ["build:icon"]);
need(icns, "pnpm build:icon failed");

/**
 * The bundle freezes a copy of the icns too, so rebuild it whenever its renderer is newer.
 * It used to be built only when MISSING: build/Jarhead.icns dated from before the Bayer
 * and round-orb changes and the Dock showed that stale tile for days.
 */
function iconIsStale(file: string): boolean {
  const mtime = (p: string): number | undefined => (existsSync(p) ? statSync(p).mtimeMs : undefined);
  return staleAgainst(mtime(file), ICON_SOURCES.map((f) => mtime(join(REPO_ROOT, "scripts", f))));
}

need(join(RESOURCES_SRC, "Info.plist"), "apps/mac/Resources/Info.plist is part of the repo");
need(join(RESOURCES_SRC, "entitlements.plist"), "apps/mac/Resources/entitlements.plist is part of the repo");

// 2. Build the Swift package.
run("swift", ["build", "-c", "release", "--package-path", MAC]);
const binDir = run("swift", ["build", "-c", "release", "--package-path", MAC, "--show-bin-path"], { quiet: true }).trim();
const binary = join(binDir, "Jarhead");
need(binary, "swift build produced no Jarhead binary");

// 3. Assemble the bundle (in a staging dir; the only launchable copy lives in /Applications).
rmSync(join(OUT, "stage"), { recursive: true, force: true });
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
// keys them to the code hash, which changes every build. The order (pinned → Apple
// Development → Developer ID → a name for this app → a Code Signing name → the first
// listed → ad-hoc) is chooseIdentity's, pinned by scripts/__tests__/sign-identity.test.ts;
// the pick is printed before anything is signed. It used to fall to whatever certificate
// the keychain listed first, and said so only in the summary after signing.
function pickIdentity(): IdentityChoice {
  const pinned = process.env["JARHEAD_SIGN_IDENTITY"];
  let names: string[] = [];
  if (!pinned) {
    try {
      names = identityNames(execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }));
    } catch {
      // no keychain to ask (a headless runner): ad-hoc
    }
  }
  return chooseIdentity(names, pinned);
}

const entitlements = join(RESOURCES_SRC, "entitlements.plist");
const chosen = pickIdentity();
const identity = chosen.identity;
console.log(identityLine(chosen));
const sign = identity ?? "-";
// Timestamps only make sense for Apple-issued certificates (and need the network).
const appleIssued = identity !== undefined && /^(Apple Development|Developer ID Application)/.test(identity);
const common = identity ? ["--force", ...(appleIssued ? ["--timestamp"] : []), "--options", "runtime"] : ["--force"];
run("codesign", [...common, "--sign", sign, join(macos, "jarhead-hands")]);
run("codesign", [...common, "--entitlements", entitlements, "--sign", sign, APP]);
run("codesign", ["--verify", "--strict", "--verbose=1", APP]);
const signedLine = identity ?? "ad-hoc (TCC grants reset on every rebuild; create a code-signing certificate in Keychain Access or set JARHEAD_SIGN_IDENTITY)";

// JARHEAD_BUILD_ONLY=1: the signed, verified stage is the product. Nothing below runs —
// no snapshot, rsync, install verification, parity, inode check, hygiene or relink — and
// nothing under /Applications is read or written. CI exercises icon → release build →
// sign → verify this way (check.yml, ad-hoc); a dry run on a Mac with an install uses it too.
if (process.env["JARHEAD_BUILD_ONLY"] === "1") {
  const stagedSize = statSync(join(macos, "Jarhead")).size;
  console.log(`
  built      ${APP} (JARHEAD_BUILD_ONLY=1: signed and verified, not installed)
  binary     ${(stagedSize / (1024 * 1024)).toFixed(1)} MiB
  signed     ${signedLine}
`);
  process.exit(0);
}

// 5. Install IN PLACE. Exactly one launchable Jarhead exists on this Mac — /Applications —
// so the Dock, LaunchServices' recents and TCC never see two identities. Its directory
// is never recreated: the Dock's pinned tile keeps a bookmark keyed on that directory's
// inode, and rm + cp gave it a new one every build (the first cause of a second Dock
// tile; the second was jarhead-hands checking in as a Foreground app from the same
// bundle — fixed in the helper's main.swift with setActivationPolicy(.prohibited), and
// named by the one-Jarhead line below when a helper still does).
// rsync renames each changed file over the old name (never --inplace: the running app
// keeps its mapped, signed Mach-O), --delete-after drops what the stage no longer has,
// and it is the INSTALLED copy that is verified. build/Jarhead.app stays a symlink to it.
// A rollback snapshot is opt-in: JARHEAD_INSTALL_SNAPSHOT=1 archives the installed bundle
// to build/previous/Jarhead.app.zip before the rsync and prints the ditto/rsync line that
// puts it back. It is a zip, never a directory — LaunchServices registers any directory
// holding an Info.plist as a bundle, a second Jarhead. Without the flag nothing is
// snapshotted: the install is in place and keeps the inode, so the rollback is
// `git checkout <previous> && pnpm build:mac`.
// The order (plan → snapshot → rsync → verify → parity → inode → unstage → relink) and
// every fail path live in performInstall, pinned by install-bundle.test.ts with a
// scripted exec; this file only supplies the real commands and filesystem.
const PREVIOUS = process.env["JARHEAD_INSTALL_SNAPSHOT"] === "1" ? join(OUT, "previous", "Jarhead.app.zip") : undefined;
const io: InstallIO = {
  exec: (cmd, args) => {
    console.log(`[build-mac] ${cmd} ${args.join(" ")}`);
    return defaultExec(cmd, args, { timeoutMs: 120_000 });
  },
  probe: probeTarget,
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
  rmTree: (p) => rmSync(p, { recursive: true, force: true }),
  relink: (target, link) => {
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) rmSync(link, { recursive: true, force: true });
    } catch {
      // nothing there
    }
    symlinkSync(target, link);
  },
  compare: compareTrees,
  warn: (line) => console.warn(`[build-mac] ${line}`),
};
const outcome = performInstall({ stage: APP, installed: INSTALLED, ...(PREVIOUS !== undefined ? { previous: PREVIOUS } : {}), link: LINK, cleanup: join(OUT, "stage"), bundleId: JARHEAD_BUNDLE_ID, uid: process.getuid?.() ?? -1 }, io);
if (!outcome.ok) {
  console.error(`[build-mac] ${outcome.what}`);
  for (const l of outcome.lines) console.error(`           ${l}`);
  console.error(`           the signed stage is kept at ${APP} for inspection`);
  process.exit(1);
}
const installNote = outcome.line;

// 6. One Jarhead: refresh the LaunchServices record, unregister stale Jarhead bundle
// paths (the database only — nothing in the Trash is touched), and READ the Dock. The
// Dock is only rewritten by `pnpm jarhead dock --fix` or JARHEAD_INSTALL_HYGIENE=fix;
// JARHEAD_INSTALL_HYGIENE=0 skips the whole pass (headless CI, or a Dock left alone).
const hygiene = process.env["JARHEAD_INSTALL_HYGIENE"];
let oneJarhead = "one jarhead  skipped (JARHEAD_INSTALL_HYGIENE=0)";
if (hygiene !== "0") oneJarhead = runHygiene({ mode: hygiene === "fix" ? "fix" : "install", log: (line) => console.log(`[build-mac] ${line}`) }).line;

const size = statSync(join(INSTALLED, "Contents", "MacOS", "Jarhead")).size;
console.log(`
  built      ${INSTALLED}
  binary     ${(size / (1024 * 1024)).toFixed(1)} MiB
  daemon     ${manifest.node} ${manifest.tsx} ${manifest.daemon}
  signed     ${signedLine}

  ${installNote}
  ${oneJarhead}
  link:      build/Jarhead.app → ${INSTALLED}${outcome.rollback ? `\n  ${outcome.rollback}` : ""}
  run:       open -a Jarhead
  logs:      tail -f ~/.jarhead/daemon.log
`);
