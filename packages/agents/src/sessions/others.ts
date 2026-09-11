import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Presence-only detectors for agent tools whose session formats Jarhead does
 * not read yet. The Console can say "also found: gemini, opencode" so Kevin
 * knows what is on the machine; nothing here is parsed.
 */

export interface OtherTool {
  readonly name: string;
  /** Relative to home. */
  readonly dir: string;
}

export const OTHER_TOOLS: readonly OtherTool[] = [
  { name: "cursor", dir: ".cursor" },
  { name: "gemini", dir: ".gemini" },
  { name: "opencode", dir: join(".local", "share", "opencode") },
  { name: "amp", dir: ".amp" },
];

/** Names of the other tools whose home directory exists. Cheap: a handful of stats. */
export async function detectOthers(home = homedir(), tools: readonly OtherTool[] = OTHER_TOOLS): Promise<string[]> {
  const found = await Promise.all(
    tools.map(async (t) => {
      try {
        return (await stat(join(home, t.dir))).isDirectory() ? t.name : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return found.filter((n): n is string => n !== undefined);
}
