#!/usr/bin/env tsx
/**
 * Jarvis preflight. Checks the things that fail silently:
 * keys, the wiki link, macOS TCC grants, and the audio/model toolchain.
 *
 * Exits non-zero if anything marked `required` fails, so `pnpm run check`
 * can gate on it. Advisory checks never fail the build.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readConfig, REPO_ROOT } from "@jarvis/core";
import { checkWikiLink, probeWikiPackages } from "@jarvis/wiki-bridge";

type Status = "ok" | "warn" | "fail";

interface Check {
  readonly group: string;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly required: boolean;
  readonly fix?: string;
}

const checks: Check[] = [];

function add(c: Check): void {
  checks.push(c);
}

function sh(cmd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- keys ----

const cfg = readConfig();

add({
  group: "keys",
  name: "ANTHROPIC_API_KEY",
  status: cfg.anthropicApiKey ? "ok" : "fail",
  detail: cfg.anthropicApiKey ? "present" : "missing",
  required: true,
  fix: "export ANTHROPIC_API_KEY=... in your shell, or set it in .env.local",
});

add({
  group: "keys",
  name: "ELEVENLABS_API_KEY",
  status: cfg.elevenLabsApiKey ? "ok" : "fail",
  detail: cfg.elevenLabsApiKey ? "present" : "missing",
  required: true,
  fix: "set ELEVENLABS_API_KEY in .env.local",
});

add({
  group: "keys",
  name: "ELEVENLABS_VOICE_ID",
  status: cfg.elevenLabsVoiceId ? "ok" : "warn",
  detail: cfg.elevenLabsVoiceId ?? "unset — Jarvis has no voice picked yet",
  required: false,
  fix: "pick a voice at elevenlabs.io/app/voice-library, or clone one, then set ELEVENLABS_VOICE_ID",
});

add({
  group: "keys",
  name: "STT",
  status: cfg.deepgramApiKey ? "ok" : "warn",
  detail: cfg.deepgramApiKey ? "cloud fallback configured" : "on-device only (macOS SpeechAnalyzer / Parakeet)",
  required: false,
});

// ------------------------------------------------------------ wiki link ----

const wiki = checkWikiLink(cfg.kevinWikiRoot);

add({
  group: "wiki",
  name: "checkout",
  status: wiki.present ? "ok" : "fail",
  detail: wiki.present ? `${wiki.root} (branch: ${wiki.branch ?? "unknown"})` : `not found at ${wiki.root}`,
  required: true,
  fix: "set KEVIN_WIKI_ROOT in .env.local to the live wiki checkout",
});

add({
  group: "wiki",
  name: "required paths",
  status: wiki.missing.length === 0 ? "ok" : "warn",
  detail: wiki.missing.length === 0 ? `all ${9} present` : `missing: ${wiki.missing.join(", ")}`,
  required: false,
});

for (const probe of await probeWikiPackages()) {
  add({
    group: "wiki",
    name: probe.name,
    status: probe.ok ? "ok" : "fail",
    detail: probe.detail,
    required: true,
    fix: "pnpm install in ~/jarvis, and pnpm install in the wiki repo",
  });
}

// ------------------------------------------------------------- macOS TCC ----
//
// There is no supported API to query TCC grants without triggering a prompt.
// We read the user's TCC database directly, which requires Full Disk Access
// for the calling terminal. If we can't read it, we say so rather than guess.

const TCC_DB = `${process.env["HOME"]}/Library/Application Support/com.apple.TCC/TCC.db`;
const TCC_SERVICES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["kTCCServiceMicrophone", "Microphone", true],
  ["kTCCServiceScreenCapture", "Screen Recording", false],
  ["kTCCServiceAccessibility", "Accessibility", false],
  ["kTCCServiceListenEvent", "Input Monitoring", false],
];

const tccReadable = sh("sqlite3", [TCC_DB, "SELECT 1 LIMIT 1;"]) !== undefined;

if (!tccReadable) {
  add({
    group: "permissions",
    name: "TCC database",
    status: "warn",
    detail: "unreadable — cannot verify grants from here",
    required: false,
    fix: "grant Full Disk Access to your terminal, or just let the app prompt at first use",
  });
} else {
  for (const [service, label, requiredNow] of TCC_SERVICES) {
    const rows = sh("sqlite3", [TCC_DB, `SELECT client,auth_value FROM access WHERE service='${service}';`]);
    const granted = (rows ?? "").split("\n").filter((r) => r.endsWith("|2"));
    add({
      group: "permissions",
      name: label,
      status: granted.length > 0 ? "ok" : requiredNow ? "warn" : "warn",
      detail: granted.length > 0 ? `${granted.length} client(s) granted` : "no client granted yet",
      required: false,
      fix: `System Settings → Privacy & Security → ${label}`,
    });
  }
}

// ------------------------------------------------------------ toolchain ----

const nodeMajor = Number(process.versions.node.split(".")[0]);
add({
  group: "toolchain",
  name: "node",
  status: nodeMajor >= 24 ? "ok" : "fail",
  detail: process.versions.node,
  required: true,
  fix: "nvm use 24",
});

for (const [bin, args, required, why] of [
  ["ffmpeg", ["-version"], true, "mic capture via avfoundation"],
  ["ffplay", ["-version"], true, "streaming audio playback — ships with ffmpeg"],
  ["qmd", ["--version"], false, `"what do I know about X" search`],
  ["cmake", ["--version"], false, "only needed if you build whisper.cpp locally"],
] as const) {
  const out = sh(bin, [...args]);
  add({
    group: "toolchain",
    name: bin,
    status: out ? "ok" : required ? "fail" : "warn",
    detail: out ? (out.split("\n")[0] ?? "present").slice(0, 60) : `missing — ${why}`,
    required,
    fix: `brew install ${bin}`,
  });
}

const swVers = sh("sw_vers", ["-productVersion"]) ?? "unknown";
const macMajor = Number(swVers.split(".")[0]);
add({
  group: "toolchain",
  name: "macOS",
  status: macMajor >= 26 ? "ok" : "warn",
  detail: macMajor >= 26 ? `${swVers} — on-device SpeechAnalyzer available` : `${swVers} — no SpeechAnalyzer, STT needs whisper.cpp or a cloud key`,
  required: false,
});

add({
  group: "toolchain",
  name: "state dir",
  status: existsSync(cfg.stateDir) ? "ok" : "warn",
  detail: existsSync(cfg.stateDir) ? cfg.stateDir : `${cfg.stateDir} (created on first run)`,
  required: false,
});

// --------------------------------------------------------------- report ----

const ICON: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘" };
const groups = [...new Set(checks.map((c) => c.group))];

console.log(`\njarvis doctor  ·  ${REPO_ROOT}\n`);

for (const g of groups) {
  console.log(`  ${g}`);
  for (const c of checks.filter((x) => x.group === g)) {
    console.log(`    ${ICON[c.status]} ${c.name.padEnd(30)} ${c.detail}`);
  }
  console.log("");
}

const failures = checks.filter((c) => c.status === "fail");
const warnings = checks.filter((c) => c.status === "warn");

if (warnings.length > 0) {
  console.log("  next steps");
  for (const w of warnings.filter((x) => x.fix)) console.log(`    · ${w.name}: ${w.fix}`);
  console.log("");
}

if (failures.length > 0) {
  console.log("  blocking");
  for (const f of failures) console.log(`    · ${f.name}: ${f.fix ?? f.detail}`);
  console.log("");
}

const blocking = failures.filter((f) => f.required);
console.log(
  `  ${checks.filter((c) => c.status === "ok").length} ok · ${warnings.length} warn · ${failures.length} fail\n`,
);
process.exit(blocking.length > 0 ? 1 : 0);
