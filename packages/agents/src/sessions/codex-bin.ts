import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { isRecord, str } from "./store.ts";

/**
 * Where the agent CLIs live on this Mac.
 *
 * None of them can be assumed to be on PATH: Kevin's Codex is the copy bundled inside
 * ChatGPT.app (Codex Desktop), Claude Code installs itself under ~/.local/bin, and the
 * daemon may run with a launchd PATH that has neither. So every runner and the health
 * check ask here, and the answer says where the binary came from — the difference
 * between "Codex 0.153.4 (ChatGPT.app)" and "codex not found: looked in …" is what
 * Kevin needs to hear when something is off.
 *
 * Order for codex: JARHEAD_CODEX_BIN → PATH → /Applications/ChatGPT.app → /Applications/
 * Codex.app → ~/.codex/bin → nvm / homebrew / ~/.local/bin. The other tools follow the
 * same shape with their own well-known homes.
 */

export type CliTool = "codex" | "claude" | "gemini" | "opencode" | "cursor-agent" | "amp";

export interface FoundCli {
  readonly tool: CliTool;
  readonly path: string;
  /** Short label of the place it was found: "ChatGPT.app", "PATH", "JARHEAD_CODEX_BIN", "~/.local/bin"… */
  readonly origin: string;
}

export interface CliCandidate {
  readonly path: string;
  readonly origin: string;
}

export interface FindCliOptions {
  /** Environment to read the override variable and PATH from. Default process.env. */
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Where .app bundles live. Default /Applications. */
  readonly applicationsDir?: string;
  /** System-wide bin dirs searched last. Default homebrew and /usr/local/bin; tests pass []. */
  readonly systemDirs?: readonly string[];
}

const DEFAULT_SYSTEM_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

/** JARHEAD_CODEX_BIN, JARHEAD_CLAUDE_BIN, JARHEAD_CURSOR_AGENT_BIN… */
export function overrideVar(tool: CliTool): string {
  return `JARHEAD_${tool.toUpperCase().replace(/-/g, "_")}_BIN`;
}

/** Ordered places to look, most specific first; `origin` labels each for the "looked in" text. */
export async function cliCandidates(tool: CliTool, opts: FindCliOptions = {}): Promise<CliCandidate[]> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const apps = opts.applicationsDir ?? "/Applications";
  const out: CliCandidate[] = [];
  const override = env[overrideVar(tool)]?.trim();
  if (override) out.push({ path: expandTilde(override, home), origin: overrideVar(tool) });
  for (const dir of (env["PATH"] ?? "").split(delimiter)) if (dir) out.push({ path: join(dir, tool), origin: "PATH" });
  if (tool === "codex") {
    out.push({ path: join(apps, "ChatGPT.app", "Contents", "Resources", "codex"), origin: "ChatGPT.app" });
    out.push({ path: join(apps, "Codex.app", "Contents", "Resources", "codex"), origin: "Codex.app" });
    out.push({ path: join(home, ".codex", "bin", "codex"), origin: "~/.codex/bin" });
  }
  if (tool === "claude") {
    out.push({ path: join(home, ".local", "bin", "claude"), origin: "~/.local/bin" });
    out.push({ path: join(home, ".claude", "local", "claude"), origin: "~/.claude/local" });
  }
  if (tool === "opencode") out.push({ path: join(home, ".opencode", "bin", "opencode"), origin: "~/.opencode/bin" });
  if (tool === "cursor-agent") out.push({ path: join(home, ".local", "bin", "cursor-agent"), origin: "~/.local/bin" });
  for (const dir of await nvmBinDirs(home)) out.push({ path: join(dir, tool), origin: "nvm" });
  out.push({ path: join(home, ".bun", "bin", tool), origin: "~/.bun/bin" });
  for (const dir of opts.systemDirs ?? DEFAULT_SYSTEM_DIRS) out.push({ path: join(dir, tool), origin: dir === "/opt/homebrew/bin" ? "homebrew" : dir });
  out.push({ path: join(home, ".local", "bin", tool), origin: "~/.local/bin" });
  // One entry per path, first origin wins.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

/** The first candidate that is an executable file. */
export async function findCli(tool: CliTool, opts: FindCliOptions = {}): Promise<FoundCli | undefined> {
  for (const c of await cliCandidates(tool, opts)) {
    if (await isExecutable(c.path)) return { tool, path: c.path, origin: c.origin };
  }
  return undefined;
}

/** "codex not found: looked in JARHEAD_CODEX_BIN (unset), PATH, ChatGPT.app, Codex.app, ~/.codex/bin, nvm, homebrew, ~/.local/bin". */
export async function notFoundText(tool: CliTool, opts: FindCliOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const origins: string[] = [];
  const variable = overrideVar(tool);
  origins.push(env[variable]?.trim() ? variable : `${variable} (unset)`);
  for (const c of await cliCandidates(tool, opts)) {
    if (c.origin === variable) continue;
    if (!origins.includes(c.origin)) origins.push(c.origin);
  }
  return `${tool} not found: looked in ${origins.join(", ")}`;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function nvmBinDirs(home: string): Promise<string[]> {
  const root = join(home, ".nvm", "versions", "node");
  try {
    const versions = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    // Newest version first so a stale install does not shadow the current one.
    versions.sort((a, b) => compareVersions(b, a));
    return versions.map((v) => join(root, v, "bin"));
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function expandTilde(p: string, home: string): string {
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

// ------------------------------------------------------------------ version ---

export type VersionExec = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const defaultVersionExec: VersionExec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(err);
      else resolve(`${stdout}${stderr}`);
    });
  });

const versionCache = new Map<string, Promise<string | undefined>>();

/**
 * `<bin> --version`, reduced to the version number ("codex-cli 0.153.4" → "0.153.4",
 * "2.1.263 (Claude Code)" → "2.1.263"). Three-second cap; a binary that hangs or has no
 * --version yields undefined. Cached per path for the life of the process.
 */
export function cliVersion(path: string, opts: { readonly exec?: VersionExec; readonly timeoutMs?: number } = {}): Promise<string | undefined> {
  const cached = versionCache.get(path);
  if (cached) return cached;
  const exec = opts.exec ?? defaultVersionExec;
  const p = exec(path, ["--version"], opts.timeoutMs ?? 3_000)
    .then((out) => parseVersion(out))
    .catch(() => undefined);
  versionCache.set(path, p);
  return p;
}

export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(output)?.[1];
}

/** Tests: forget cached versions. */
export function clearCliCache(): void {
  versionCache.clear();
}

// --------------------------------------------------------------------- auth ---

export interface CodexAuth {
  readonly signedIn: boolean;
  /** "chatgpt" for a ChatGPT login (tokens in auth.json), "api-key" for an OPENAI_API_KEY in auth.json, "env-key" for one in the environment. */
  readonly how: "chatgpt" | "api-key" | "env-key" | undefined;
  /** Why not, when not signed in: "~/.codex/auth.json missing", "no tokens in ~/.codex/auth.json". */
  readonly reason: string | undefined;
}

/**
 * Is Codex signed in? ~/.codex/auth.json holds {"auth_mode":"chatgpt","tokens":{…}} after
 * a ChatGPT login or {"OPENAI_API_KEY":"…"} after `codex login --with-api-key`; an
 * OPENAI_API_KEY in the environment also works. Presence only — token values are never
 * read past the check that they are non-empty strings, and never returned.
 */
export async function readCodexAuth(codexRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<CodexAuth> {
  const path = join(codexRoot, "auth.json");
  const shown = `~/.codex/${basename(path)}`;
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      v = undefined;
    }
    if (isRecord(v)) {
      const tokens = v["tokens"];
      const hasTokens = isRecord(tokens) && ["access_token", "refresh_token", "id_token"].some((k) => Boolean(str(tokens[k])));
      if (hasTokens) return { signedIn: true, how: "chatgpt", reason: undefined };
      if (str(v["OPENAI_API_KEY"])) return { signedIn: true, how: "api-key", reason: undefined };
      if (env["OPENAI_API_KEY"]) return { signedIn: true, how: "env-key", reason: undefined };
      return { signedIn: false, how: undefined, reason: `not signed in (no tokens in ${shown})` };
    }
    if (env["OPENAI_API_KEY"]) return { signedIn: true, how: "env-key", reason: undefined };
    return { signedIn: false, how: undefined, reason: `not signed in (${shown} is not valid JSON)` };
  }
  if (env["OPENAI_API_KEY"]) return { signedIn: true, how: "env-key", reason: undefined };
  return { signedIn: false, how: undefined, reason: `not signed in (${shown} missing)` };
}
