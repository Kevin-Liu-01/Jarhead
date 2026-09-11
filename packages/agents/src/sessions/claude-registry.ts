import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, parseTimestamp, str } from "./store.ts";

/**
 * Claude Code's registry of running sessions: ~/.claude/sessions/<pid>.json, one file
 * per live process, written by the CLI itself (2.1.x):
 *
 *   {"pid":4555,"sessionId":"6b7a12a4-…","cwd":"/Users/kevinliu/…","startedAt":1789078969434,
 *    "procStart":"Thu Sep 10 22:22:49 2026","version":"2.1.260","kind":"interactive",
 *    "entrypoint":"claude-desktop"|"cli","name":"scratch-…-77",...}
 *
 * Next to each sits a `<pid>.<hash>.key` secret, which is never read. Files outlive
 * crashed processes, so an entry counts only while its pid is alive; the caller decides
 * that from its own ps snapshot. This is the exact pid ↔ session mapping that cwd and
 * start-time heuristics can only approximate.
 */

export interface SessionOwner {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly startedAt: number | undefined;
  /** "interactive" for a TUI or Desktop pane; other values are headless runs. */
  readonly kind: string | undefined;
  /** "cli" (a terminal), "claude-desktop", or another host. */
  readonly entrypoint: string | undefined;
}

export function defaultClaudeSessionsDir(home: string): string {
  return join(home, ".claude", "sessions");
}

const ENTRY_FILE = /^\d+\.json$/;

/** Every well-formed <pid>.json under `dir`; missing dir or unreadable entries are just absent. Never throws. */
export async function readClaudeRegistry(dir: string): Promise<SessionOwner[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => ENTRY_FILE.test(n));
  } catch {
    return [];
  }
  const entries = await Promise.all(
    names.map(async (n): Promise<SessionOwner | undefined> => {
      try {
        return parseRegistryEntry(await readFile(join(dir, n), "utf8"));
      } catch {
        return undefined;
      }
    }),
  );
  return entries.filter((e): e is SessionOwner => e !== undefined);
}

/** Pure: one registry file's text → owner, or undefined when pid or sessionId is missing. */
export function parseRegistryEntry(text: string): SessionOwner | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(v)) return undefined;
  const pid = v["pid"];
  const sessionId = str(v["sessionId"]);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !sessionId) return undefined;
  return {
    pid,
    sessionId,
    cwd: str(v["cwd"]),
    startedAt: parseTimestamp(v["startedAt"]),
    kind: str(v["kind"]),
    entrypoint: str(v["entrypoint"]),
  };
}
