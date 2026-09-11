import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@jarhead/core";

/**
 * The `-c key=value` overrides both Codex entry points share: the `jarhead` MCP
 * server (Jarhead's tools over the bridge) and, for the app-server, which of
 * Kevin's own MCP servers to switch off — `codex app-server` has no
 * `--ignore-user-config`, so his config.toml loads and its computer-use, browser
 * and REPL servers would let Codex act on the Mac around Jarhead's policy.
 */

const log = logger("brain.codex");

export const CODEX_MCP_SERVER = "jarhead";

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
