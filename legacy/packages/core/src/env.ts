import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file rather than cwd so scripts work from anywhere. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

/** Minimal dotenv: no interpolation, no export syntax. Shell env always wins. */
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key || value === "") continue;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

let loaded = false;

/** Idempotent. Call before reading config. */
export function loadEnv(): void {
  if (loaded) return;
  loadDotenv(join(REPO_ROOT, ".env.local"));
  loadDotenv(join(REPO_ROOT, ".env"));
  loaded = true;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export interface JarvisConfig {
  readonly anthropicApiKey: string | undefined;
  readonly elevenLabsApiKey: string | undefined;
  readonly elevenLabsVoiceId: string | undefined;
  readonly elevenLabsModelId: string;
  readonly deepgramApiKey: string | undefined;
  readonly kevinWikiRoot: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly logLevel: string;
}

export function readConfig(): JarvisConfig {
  loadEnv();
  const env = process.env;
  return {
    anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
    elevenLabsApiKey: env["ELEVENLABS_API_KEY"] || undefined,
    elevenLabsVoiceId: env["ELEVENLABS_VOICE_ID"] || undefined,
    elevenLabsModelId: env["ELEVENLABS_MODEL_ID"] || "eleven_flash_v2_5",
    deepgramApiKey: env["DEEPGRAM_API_KEY"] || undefined,
    kevinWikiRoot: expandHome(
      env["KEVIN_WIKI_ROOT"] || "/Users/kevinliu/repos/kevin-wiki-rebuild",
    ),
    stateDir: expandHome(env["JARVIS_STATE_DIR"] || "~/.jarvis"),
    socketPath: env["JARVIS_SOCKET"] || "/tmp/jarvisd.sock",
    logLevel: env["JARVIS_LOG_LEVEL"] || "info",
  };
}
