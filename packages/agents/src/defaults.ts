import type { AgentConnector } from "./types.ts";
import { ClaudeCodeConnector } from "./claude-code/connector.ts";
import { SessionsConnector } from "./sessions/connector.ts";

export interface DefaultConnectorOptions {
  readonly claudeModel?: string | undefined;
  readonly claudeBin?: string | undefined;
}

/**
 * The connectors Jarhead ships with, built the same way by the app and the CLI.
 * Sessions first: the agent sessions already on this Mac (Claude Code, Codex,
 * other CLIs found on disk or running) are the agents Kevin means. Claude Code
 * is how a session is continued headlessly. Nothing here is tied to one tool; the
 * herdr and T3 Code connectors were removed 2026-09-10 (git history before 1ff11e2).
 */
export function defaultConnectors(opts: DefaultConnectorOptions = {}): AgentConnector[] {
  return [
    new SessionsConnector({ dropApiKey: true }),
    new ClaudeCodeConnector({
      ...(opts.claudeModel ? { model: opts.claudeModel } : {}),
      ...(opts.claudeBin ? { pathToClaudeCodeExecutable: opts.claudeBin } : {}),
      dropApiKey: true,
    }),
  ];
}
