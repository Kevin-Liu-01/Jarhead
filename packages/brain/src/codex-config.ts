import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "@jarhead/core";

/**
 * The `-c key=value` overrides both Codex entry points share: the `jarhead` MCP
 * server (Jarhead's tools over the bridge), the prompt blocks Codex would add for
 * a coding session and Jarhead does not want (`codexPromptTrimArgs`), and, for
 * the app-server, which of the user's own MCP servers to switch off — `codex
 * app-server` has no `--ignore-user-config`, so the CODEX_HOME config.toml loads
 * and Kevin's computer-use, browser and REPL servers would let Codex act on the
 * Mac around Jarhead's policy. Since 2026-09-12 that CODEX_HOME is Jarhead's own
 * (`prepareCodexHome`), so the disabling is a belt for the fallback case only.
 */

const log = logger("brain.codex");

export const CODEX_MCP_SERVER = "jarhead";

// ------------------------------------------------------------ a private home

/** The folder under the state dir that is Jarhead's CODEX_HOME. */
export const CODEX_HOME_DIRNAME = "codex-home";

export interface CodexHomeOptions {
  /** Jarhead's state dir (~/.jarhead); the home is `<stateDir>/codex-home`. */
  readonly stateDir: string;
  /** Kevin's real Codex home (his login, his model line): ~/.codex by default. */
  readonly sourceHome: string;
}

export interface CodexHome {
  /** What CODEX_HOME should be. */
  readonly path: string;
  /** True when it is the private home; false when it fell back to `sourceHome`. */
  readonly isolated: boolean;
  /** One human line: what was built, or why the fallback. */
  readonly detail: string;
}

/** The `model = "…"` lines at the top of a config.toml (before its first table), by key. */
export function codexConfigTopLevel(text: string, keys: readonly string[]): Record<string, string> {
  const top = text.split(/^\s*\[/m)[0] ?? "";
  const out: Record<string, string> = {};
  for (const key of keys) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"`, "m").exec(top);
    if (m?.[1] !== undefined) out[key] = m[1];
  }
  return out;
}

/** The model lines Jarhead copies from Kevin's config.toml — and nothing else. */
export const CODEX_HOME_COPIED_KEYS = ["model", "model_reasoning_effort", "service_tier"] as const;

/**
 * Build (or refresh) Jarhead's own CODEX_HOME and say which home to use.
 *
 * Why: every fresh thread inherited everything in Kevin's ~/.codex — the skills
 * catalog (~8.4k tokens: 260 of 718 skills listed and a budget warning per turn),
 * his global AGENTS.md (~0.7k tokens pointing at a wiki checkout that no longer
 * exists: 13 bootstrap calls and 22.5 s of one wiki-search delegation), the
 * plugin marketplaces and the `notify` hook. Measured with `codex debug
 * prompt-input` (2026-09-12): the extra developer blocks were 39.2k chars in his
 * home and 2.7k in this one (with `codexPromptTrimArgs`).
 *
 * What is in it: `auth.json` is a symlink to the real one, so his ChatGPT login
 * is shared and a token refresh writes through to the real file (Codex writes
 * auth.json in place — truncate and write — so the link survives; a Codex that
 * one day renames a temp file over it would leave a regular file here, which
 * the next start moves aside as `auth.json.stray-<ts>` and re-links, with a
 * warning); a `config.toml` Jarhead writes with the model lines copied from his
 * (model, model_reasoning_effort, service_tier) and nothing else — no plugins, no
 * marketplaces, no notify, no MCP servers; no AGENTS.md; an empty `skills/`
 * (Codex still finds ~/.agents/skills through $HOME and adds its own bundled
 * `.system` skills here, which is why `skills.include_instructions=false` rides
 * in the argv). Falls back to the source home when it has no auth.json to link,
 * with the reason in `detail`. Never writes into the source home.
 */
export function prepareCodexHome(o: CodexHomeOptions): CodexHome {
  const auth = join(o.sourceHome, "auth.json");
  if (!existsSync(auth)) return { path: o.sourceHome, isolated: false, detail: `no auth.json at ${o.sourceHome} to link; using it as CODEX_HOME as is` };
  const home = join(o.stateDir, CODEX_HOME_DIRNAME);
  // CODEX_HOME already pointing at this very folder: linking auth.json onto itself would eat the login.
  if (samePath(home, o.sourceHome)) return { path: o.sourceHome, isolated: false, detail: `${o.sourceHome} is already the private home; using it as is` };
  try {
    mkdirSync(join(home, "skills"), { recursive: true });
    // auth.json → the real one. A regular file here is a Codex that replaced the link
    // (rename over it): moved aside, never deleted — its tokens may be the newer ones.
    const link = join(home, "auth.json");
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(link);
    } catch {
      st = undefined;
    }
    if (st && !(st.isSymbolicLink() && safeReadlink(link) === auth)) {
      if (st.isSymbolicLink()) rmSync(link, { force: true });
      else {
        const stray = `${link}.stray-${Date.now()}`;
        renameSync(link, stray);
        log.warn(`${link} was a regular file, not the link to ${auth}: moved to ${stray} and re-linked; if Codex refreshed its tokens there, sign in to Codex again`);
      }
      st = undefined;
    }
    if (!st) symlinkSync(auth, link);
    // No AGENTS.md of anyone's.
    rmSync(join(home, "AGENTS.md"), { force: true });
    // A config.toml of Jarhead's: the model lines from Kevin's, nothing else.
    let source = "";
    try {
      source = readFileSync(join(o.sourceHome, "config.toml"), "utf8");
    } catch {
      source = "";
    }
    const copied = codexConfigTopLevel(source, CODEX_HOME_COPIED_KEYS);
    const lines = [
      "# Written by Jarhead (packages/brain/src/codex-config.ts) at every brain start; edits here are lost.",
      `# Kevin's own Codex config is ${join(o.sourceHome, "config.toml")}; only its model lines are copied.`,
      "# No plugins, marketplaces, notify hook, MCP servers or skills belong here: Jarhead's tools arrive as -c overrides.",
      ...CODEX_HOME_COPIED_KEYS.filter((k) => copied[k] !== undefined).map((k) => `${k} = ${toml(copied[k]!)}`),
      "",
    ];
    const wanted = lines.join("\n");
    const configPath = join(home, "config.toml");
    let current: string | undefined;
    try {
      current = readFileSync(configPath, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== wanted) {
      const tmp = `${configPath}.${process.pid}.tmp`;
      writeFileSync(tmp, wanted, { mode: 0o600 });
      renameSync(tmp, configPath);
    }
    const model = copied["model"] ? `model ${copied["model"]}` : "Codex's default model";
    return { path: home, isolated: true, detail: `private CODEX_HOME ${home}: auth.json → ${auth}, ${model} from ${o.sourceHome}, no AGENTS.md, no skills` };
  } catch (e) {
    return { path: o.sourceHome, isolated: false, detail: `could not build ${home} (${(e as Error).message}); using ${o.sourceHome} as CODEX_HOME` };
  }
}

function safeReadlink(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return resolve(a) === resolve(b) || real(a) === real(b);
}

/**
 * The prompt blocks a coding session gets and a voice assistant's brain pays
 * for at every request, switched off (measured with `codex debug prompt-input`
 * on 0.154, this Mac, 2026-09-12; chars of developer text):
 *   `<skills_instructions>` 26 954 → 0 (the catalog and its how-to; Codex finds
 *   ~/.agents/skills through $HOME whatever CODEX_HOME says, and `skills.agents`
 *   / `skills.config` per directory did nothing), `<permissions instructions>`
 *   3 829 (shell escalation, which Jarhead declines anyway), `<collaboration_mode>`
 *   245, `<recommended_plugins>` 1 807 (`features.plugins=false`). Kept:
 *   `<environment_context>` (~850: cwd, sandbox, date, timezone) and the
 *   `<multi_agent_role>` block (2 392 + 234), which no flag removes — it follows
 *   the model's `multi_agent_version`.
 */
export function codexPromptTrimArgs(): string[] {
  return ["-c", "skills.include_instructions=false", "-c", "include_permissions_instructions=false", "-c", "include_collaboration_mode_instructions=false", "-c", "features.plugins=false"];
}

/** A TOML basic string; JSON's escapes are a subset of TOML's. */
export function toml(value: string): string {
  return JSON.stringify(value);
}

export interface CodexMcpConfig {
  /** The node that runs the bridge (the daemon's own, by default). */
  readonly node: string;
  readonly tsxCli: string;
  readonly bridgePath: string;
  /** Where the bridge's tool.run messages go. */
  readonly socketPath: string;
  /** MCP server start / per-tool budgets, in seconds. */
  readonly startupTimeoutSec?: number | undefined;
  readonly toolTimeoutSec?: number | undefined;
}

/** The `-c` pairs that mount the bridge as the `jarhead` MCP server, in the order the exec argv always had them. */
export function codexMcpConfigArgs(o: CodexMcpConfig): string[] {
  return [
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.command=${toml(o.node)}`,
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.args=[${toml(o.tsxCli)}, ${toml(o.bridgePath)}]`,
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.env={JARHEAD_SOCKET=${toml(o.socketPath)}}`,
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.startup_timeout_sec=${o.startupTimeoutSec ?? 30}`,
    // agent_wait may take ten minutes.
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.tool_timeout_sec=${o.toolTimeoutSec ?? 660}`,
    // exec runs with approval policy "never" and the app-server thread is started the
    // same way; without this every MCP call is refused ("MCP tool call requires
    // approval, but approval policy is never").
    "-c",
    `mcp_servers.${CODEX_MCP_SERVER}.default_tools_approval_mode="approve"`,
  ];
}

/**
 * The MCP servers Kevin's config.toml declares (`[mcp_servers.<name>]`), by bare
 * name. Quoted names cannot be addressed through a `-c` dotted path (checked on
 * 0.153.4: `mcp_servers."x".enabled=false` fails with "invalid transport") and are
 * reported instead of guessed at.
 */
export function codexUserMcpServers(codexHome: string): { names: string[]; unaddressable: string[] } {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return { names: [], unaddressable: [] };
  }
  const names: string[] = [];
  const unaddressable: string[] = [];
  for (const m of text.matchAll(/^\s*\[mcp_servers\.([^\]\n]+)\]/gm)) {
    const raw = (m[1] ?? "").trim();
    if (raw.includes(".") && !/^"[^"]*"$/.test(raw)) continue; // a sub-table such as [mcp_servers.x.env]
    if (/^[A-Za-z0-9_-]+$/.test(raw)) names.push(raw);
    else unaddressable.push(raw.replace(/^"|"$/g, ""));
  }
  return { names, unaddressable };
}

/** `-c mcp_servers.<name>.enabled=false` for every server the user config declares, except Jarhead's own. */
export function codexDisableUserServersArgs(codexHome: string): string[] {
  const { names, unaddressable } = codexUserMcpServers(codexHome);
  if (unaddressable.length) log.warn(`config.toml declares MCP servers whose names a -c path cannot address (${unaddressable.join(", ")}); they stay enabled in the app-server`);
  return names.filter((n) => n !== CODEX_MCP_SERVER).flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]);
}
