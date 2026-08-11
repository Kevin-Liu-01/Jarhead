import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Which browser tools exist on this machine.
 *
 * A PATH scan with fs.accessSync instead of spawning `<tool> --version`:
 * three subprocesses at startup would cost ~100ms+ and browser-use has no
 * cheap version flag, while a stat is microseconds. Routing may consult this
 * on every utterance, so after the first call it must be a memory read.
 *
 * Plain HTTP fetch is built into Node and therefore always available; these
 * capabilities only gate *interactive* browser work. The point of checking up
 * front is that "agent-browser is not installed" should come out of routing
 * as a sentence, not out of a spawn ENOENT three layers deep.
 */

export interface BrowserCapabilities {
  readonly agentBrowser: boolean;
  readonly playwright: boolean;
  readonly browserUse: boolean;
}

export function hasBinary(name: string, pathVar: string | undefined = process.env.PATH): boolean {
  if (!pathVar) return false;
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this dir; keep walking.
    }
  }
  return false;
}

let cached: BrowserCapabilities | undefined;

/**
 * Cached for the process lifetime when scanning the real PATH. Installing a
 * tool mid-session means restarting Jarvis, which is fine — jarvisd restarts
 * are cheap and the alternative is stat-ing PATH on the voice path.
 */
export function detectBrowserTools(pathVar?: string): BrowserCapabilities {
  if (pathVar === undefined && cached) return cached;
  const caps: BrowserCapabilities = {
    agentBrowser: hasBinary("agent-browser", pathVar ?? process.env.PATH),
    playwright: hasBinary("playwright", pathVar ?? process.env.PATH),
    browserUse: hasBinary("browser-use", pathVar ?? process.env.PATH),
  };
  if (pathVar === undefined) cached = caps;
  return caps;
}

/** One sentence a voice assistant can actually say when asked what it can do. */
export function describeCapabilities(caps: BrowserCapabilities): string {
  const present = [
    caps.agentBrowser ? "agent-browser" : undefined,
    caps.playwright ? "playwright" : undefined,
    caps.browserUse ? "browser-use" : undefined,
  ].filter((t): t is string => t !== undefined);

  if (present.length === 0) {
    return (
      "No browser automation tools are installed. Plain HTTP fetch still works for reading pages; " +
      "install agent-browser (`brew install agent-browser`) for anything interactive."
    );
  }
  return `Browser tools available: ${present.join(", ")}. Plain HTTP fetch is always available.`;
}
