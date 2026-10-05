import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A tiny signed bundle for the ad-hoc install tests (adhoc-install.test.ts here, and the
 * doctor's rows in packages/cli's install-doctor.test.ts): two Mach-O copies of
 * /usr/bin/true laid out like Jarhead.app (the app and a nested jarhead-hands), an
 * Info.plist with a bundle id that is not Jarhead's, signed the way scripts/build-mac.ts
 * signs when the keychain lists no identity. Everything lives under the caller's temp
 * root; nothing under /Applications, ~/.jarhead or the checkout is touched.
 */

export const ADHOC_BUNDLE_ID = "com.example.jarhead-adhoc-install";
export const ENTITLEMENTS = fileURLToPath(new URL("../../../../apps/mac/Resources/entitlements.plist", import.meta.url));

/** The real codesign and a Mach-O to copy: a Mac with Xcode's command line tools. */
export function canSignAdhoc(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/codesign") && existsSync("/usr/bin/true");
}

/** Lays out `<root>/build/stage/AdhocJarhead.app`. `build` lands in Resources, so two builds differ in their cdhash. */
export function makeStage(root: string, build: string): string {
  const app = join(root, "build", "stage", "AdhocJarhead.app");
  const macos = join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  for (const name of ["AdhocJarhead", "jarhead-hands"]) {
    copyFileSync("/usr/bin/true", join(macos, name));
    chmodSync(join(macos, name), 0o755);
  }
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${ADHOC_BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>AdhocJarhead</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");
  writeFileSync(join(app, "Contents", "Resources", "build.txt"), `${build}\n`);
  return app;
}

/**
 * build-mac.ts step 4 with `sign` = "-" (ad-hoc): the helper first, then the app with the
 * entitlements, then the stage's own strict verify. An identity would add the hardened
 * runtime; ad-hoc signs with `--force` alone, exactly as build-mac.ts does.
 */
export function signLikeBuildMac(app: string, identity: string | undefined): void {
  const sign = identity ?? "-";
  const common = identity ? ["--force", "--options", "runtime"] : ["--force"];
  execFileSync("/usr/bin/codesign", [...common, "--sign", sign, join(app, "Contents", "MacOS", "jarhead-hands")], { stdio: "pipe" });
  execFileSync("/usr/bin/codesign", [...common, "--entitlements", ENTITLEMENTS, "--sign", sign, app], { stdio: "pipe" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=1", app], { stdio: "pipe" });
}
