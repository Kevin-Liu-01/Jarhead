import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * launchd installation for jarvisd.
 *
 * A LaunchAgent, not a LaunchDaemon: jarvisd needs Kevin's user session (his
 * state dir, his Keychain-adjacent env, eventually his TCC grants), and
 * gui/$UID is the domain where those live. Nothing here runs at import time —
 * generating the plist and shelling to launchctl only happen when the install
 * helpers are explicitly called.
 */

export const LAUNCHD_LABEL = "com.kevin.jarvisd";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DAEMON_ENTRY = join(HERE, "main.ts");

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface PlistOptions {
  readonly stateDir: string;
  /**
   * Absolute node binary. Defaults to the node running right now, because
   * launchd's PATH knows nothing about nvm/brew shims — a bare "node" in
   * ProgramArguments is the classic way this plist silently fails.
   */
  readonly nodePath?: string;
}

export function renderPlist(opts: PlistOptions): string {
  const node = opts.nodePath ?? process.execPath;
  const logDir = join(opts.stateDir, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(TSX_BIN)}</string>
    <string>${escapeXml(DAEMON_ENTRY)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(REPO_ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, "jarvisd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, "jarvisd.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function guiDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("no uid — launchd install only makes sense on macOS");
  return `gui/${uid}`;
}

export interface LaunchdResult {
  readonly plistPath: string;
  readonly command: string;
}

/**
 * Writes the plist and bootstraps it. Boots out any previous generation
 * first, because `launchctl bootstrap` refuses to load a label that is
 * already resident — without this, reinstalling after an edit always fails.
 *
 * KeepAlive.SuccessfulExit=false means launchd restarts jarvisd after a crash
 * but respects a clean stop: `{"cmd":"stop"}` exits 0 and stays stopped until
 * the next login or bootstrap.
 */
export function installLaunchAgent(opts: PlistOptions): LaunchdResult {
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(opts.stateDir, "logs"), { recursive: true });
  writeFileSync(path, renderPlist(opts));

  const domain = guiDomain();
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  } catch {
    // Not currently loaded — the common case on first install.
  }
  execFileSync("launchctl", ["bootstrap", domain, path], { stdio: "pipe" });
  return { plistPath: path, command: `launchctl bootstrap ${domain} ${path}` };
}

/** Boots the agent out and deletes the plist. Safe to call when not installed. */
export function uninstallLaunchAgent(): LaunchdResult {
  const path = plistPath();
  const domain = guiDomain();
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
  } catch {
    // Already stopped or never loaded; removing the plist is still right.
  }
  rmSync(path, { force: true });
  return { plistPath: path, command: `launchctl bootout ${domain}/${LAUNCHD_LABEL}` };
}
