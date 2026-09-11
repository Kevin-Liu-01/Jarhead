// Builds the native jarhead-hands helper (packages/hands/native/*.swift) into build/jarhead-hands.
// Run with `pnpm build:hands` from the repo root. Exits non-zero on failure.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = join(repoRoot, "packages", "hands", "native");
const buildDir = join(repoRoot, "build");
const outputPath = join(buildDir, "jarhead-hands");

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

function main(): void {
  if (process.platform !== "darwin") {
    throw new Error(`jarhead-hands is macOS-only (platform is ${process.platform})`);
  }

  const sources = readdirSync(nativeDir)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(nativeDir, name));
  if (sources.length === 0) {
    throw new Error(`no Swift sources found in ${nativeDir}`);
  }

  mkdirSync(buildDir, { recursive: true });

  const started = performance.now();
  const swiftcArgs = [
    "-O",
    "-swift-version",
    "5",
    "-target",
    "arm64-apple-macos14.0",
    "-module-name",
    "JarheadHands",
    "-o",
    outputPath,
    ...sources,
  ];
  console.log(`[build-hands] swiftc ${swiftcArgs.slice(0, -sources.length).join(" ")} ${sources.length} sources`);
  execFileSync("swiftc", swiftcArgs, { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", outputPath], { stdio: "inherit" });

  const elapsed = performance.now() - started;
  const size = statSync(outputPath).size;
  console.log(`[build-hands] output: ${outputPath}`);
  console.log(`[build-hands] size: ${formatBytes(size)} (${size} bytes)`);
  console.log(`[build-hands] build time: ${(elapsed / 1000).toFixed(1)} s`);
}

try {
  main();
} catch (error) {
  console.error(`[build-hands] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
