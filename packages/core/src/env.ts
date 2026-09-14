import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAIN_KINDS, SECRET_KEYS, type BrainKind, type Effort, type SecretKey } from "@jarhead/protocol";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file rather than cwd so every entry point agrees. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Where a key came from, so the doctor can say so when one of them is stale. */
export type KeySource = "state-dir" | "shell" | "none";

const sources = new Map<string, KeySource>();

/**
 * Keys Jarhead owns. For these the env file WINS over the shell: a stale
 * OPENAI_API_KEY exported by ~/.zshrc must not shadow the key Kevin put in
 * ~/.jarhead/env on purpose. Everything else keeps dotenv convention (shell wins).
 */
const OWNED_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JARHEAD_BRAIN_API_KEY", "JARHEAD_BRAIN_BASE_URL",
  "JARHEAD_BRAIN", "JARHEAD_BRAIN_MODEL", "JARHEAD_VOICE", "JARHEAD_LIVE_MODEL", "JARHEAD_MEMORY_MODEL",
]);

/** Minimal dotenv: KEY=VALUE lines, no interpolation. */
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key || value === "") continue;
    if (OWNED_KEYS.has(key) || process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      sources.set(key, "state-dir");
    }
  }
}

let loaded = false;

/**
 * Idempotent. One file is read: <stateDir>/env (~/.jarhead/env). For Jarhead's own
 * keys it wins over the shell; for everything else the shell wins (dotenv
 * convention). The repo holds no env files.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const key of OWNED_KEYS) if (process.env[key]) sources.set(key, "shell");
  loadDotenv(join(stateDirFromEnv(), "env"));
}

/** Which source supplied a key (after loadEnv). */
export function keySource(key: string): KeySource {
  loadEnv();
  return sources.get(key) ?? (process.env[key] ? "shell" : "none");
}

function stateDirFromEnv(): string {
  return expandHome(process.env["JARHEAD_STATE_DIR"] || "~/.jarhead");
}

/** Path of the state-dir env file (secrets live here, mode 0600). */
export function envFilePath(): string {
  return join(stateDirFromEnv(), "env");
}

/**
 * Write secrets into the state-dir env file: existing lines for other keys and
 * comments are kept, `null` removes a key, the file is written atomically with
 * mode 0600, and the running process picks the new values up immediately (they
 * are OWNED_KEYS, so the file wins over a stale shell export).
 */
export function writeEnvSecrets(patch: Partial<Record<SecretKey, string | null>>): void {
  const path = envFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const allowed = new Set<string>(SECRET_KEYS);
  const pending = new Map<string, string | null>();
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) throw new Error(`refusing to write ${k}: not a secret key`);
    if (v !== undefined) pending.set(k, v === null ? null : v.trim());
  }
  const out: string[] = [];
  for (const raw of existing) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    const key = !line || line.startsWith("#") || eq === -1 ? undefined : line.slice(0, eq).trim();
    if (key !== undefined && pending.has(key)) {
      const v = pending.get(key);
      if (v) out.push(`${key}=${v}`);
      pending.delete(key);
      continue;
    }
    out.push(raw);
  }
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  for (const [k, v] of pending) if (v) out.push(`${k}=${v}`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${out.join("\n")}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v.trim() === "") {
      delete process.env[k];
      sources.delete(k);
    } else {
      process.env[k] = v.trim();
      sources.set(k, "state-dir");
    }
  }
}

/** Which secrets are configured, without exposing them. */
export function secretsPresent(): { openai: boolean; anthropic: boolean; brainApiKey: boolean } {
  loadEnv();
  return {
    openai: Boolean(process.env["OPENAI_API_KEY"]),
    anthropic: Boolean(process.env["ANTHROPIC_API_KEY"]),
    brainApiKey: Boolean(process.env["JARHEAD_BRAIN_API_KEY"]),
  };
}

export interface JarheadConfig {
  readonly openaiApiKey: string | undefined;
  /** Optional; the default brain (Claude Code) does not need it. */
  readonly anthropicApiKey: string | undefined;
  readonly liveModel: string;
  readonly liveVoice: string;
  readonly brain: BrainKind;
  readonly brainModel: string;
  readonly brainEffort: Effort;
  /** openai-compatible brain: server base URL and its key (falls back to OPENAI_API_KEY). */
  readonly brainBaseUrl: string | undefined;
  readonly brainApiKey: string | undefined;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly idleSleepMinutes: number;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly claudeBin: string | undefined;
  /** Codex CLI override; otherwise PATH, then the copy bundled in ChatGPT.app / Codex.app. */
  readonly codexBin: string | undefined;
  readonly handsBin: string;
  /**
   * The Responses model the memory extractor calls (Kevin's OpenAI key; dollars, never
   * the ChatGPT plan). Undefined = the memory package's default, a mini-class id the
   * doctor picks once from a free `GET /v1/models`. Memory never uses Codex.
   */
  readonly memoryModel: string | undefined;
}

const BRAINS: readonly BrainKind[] = BRAIN_KINDS;
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function readConfig(): JarheadConfig {
  loadEnv();
  const env = process.env;
  const stateDir = stateDirFromEnv();
  const brain = env["JARHEAD_BRAIN"] as BrainKind | undefined;
  const effort = env["JARHEAD_BRAIN_EFFORT"] as Effort | undefined;
  const level = env["JARHEAD_LOG_LEVEL"];
  return {
    openaiApiKey: env["OPENAI_API_KEY"] || undefined,
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    liveModel: env["JARHEAD_LIVE_MODEL"] || "gpt-live-1",
    liveVoice: env["JARHEAD_VOICE"] || "ballad",
    brain: brain !== undefined && BRAINS.includes(brain) ? brain : "auto",
    brainModel: env["JARHEAD_BRAIN_MODEL"] || "",
    codexBin: env["JARHEAD_CODEX_BIN"] || undefined,
    brainEffort: effort !== undefined && EFFORTS.includes(effort) ? effort : "medium",
    brainBaseUrl: env["JARHEAD_BRAIN_BASE_URL"] || undefined,
    brainApiKey: env["JARHEAD_BRAIN_API_KEY"] || env["OPENAI_API_KEY"] || undefined,
    stateDir,
    socketPath: env["JARHEAD_SOCKET"] || join(stateDir, "jarhead.sock"),
    idleSleepMinutes: Number(env["JARHEAD_IDLE_SLEEP_MINUTES"] || 10),
    logLevel: level === "debug" || level === "warn" || level === "error" ? level : "info",
    claudeBin: env["JARHEAD_CLAUDE_BIN"] || undefined,
    handsBin: env["JARHEAD_HANDS_BIN"] || join(REPO_ROOT, "build", "jarhead-hands"),
    memoryModel: env["JARHEAD_MEMORY_MODEL"] || undefined,
  };
}
