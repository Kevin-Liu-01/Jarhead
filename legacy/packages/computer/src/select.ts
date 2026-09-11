import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./exec.ts";
import { AxPermissionError, elementAt, frontmostApp, runAppleScript, type AxElement } from "./ax.ts";
import { cursorPosition } from "./input.ts";
import { captureRegion, type Region } from "./screen.ts";

/**
 * "Select stuff and tell it stuff": one bundle of everything the screen can
 * say about what Kevin has selected right now, pinned as context for the next
 * voice turn.
 *
 * This runs several subprocesses back to back, so it is strictly a
 * between-turns tool — the agent grabs the bundle before the turn's audio
 * path starts, never during it.
 */

export interface SelectionBundle {
  readonly app: string;
  readonly text: string | undefined;
  readonly textSource: "ax" | "clipboard" | "none";
  readonly elementUnderCursor: AxElement | undefined;
  readonly screenshotPath: string | undefined;
  readonly screenshotError: string | undefined;
  readonly capturedAt: string;
  readonly ms: number;
}

export interface SelectOptions {
  /** Also grab a region screenshot into the bundle. Fails soft if TCC-blocked. */
  readonly region?: Region | undefined;
  /** Per-subprocess cap, not a total budget; every step is individually bounded. */
  readonly timeoutMs?: number | undefined;
}

// Static script, no user input, so no escaping needed here. AXSelectedText on
// the focused element is the clean path; most Electron apps never publish it,
// which is why the clipboard fallback exists at all.
const AX_SELECTED_TEXT = [
  `tell application "System Events"`,
  `  tell (first process whose frontmost is true)`,
  `    set el to value of attribute "AXFocusedUIElement"`,
  `    if el is missing value then return ""`,
  `    set sel to value of attribute "AXSelectedText" of el`,
  `    if sel is missing value then return ""`,
  `    return sel`,
  `  end tell`,
  `end tell`,
].join("\n");

export async function captureSelection(opts: SelectOptions = {}): Promise<SelectionBundle> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? 6_000;

  // Permission failures propagate: without Accessibility nothing below can
  // work, and the error message names the Settings pane to open.
  const front = await frontmostApp(timeoutMs);

  let text: string | undefined;
  let textSource: SelectionBundle["textSource"] = "none";
  try {
    const sel = await runAppleScript(AX_SELECTED_TEXT, timeoutMs);
    if (sel.length > 0) {
      text = sel;
      textSource = "ax";
    }
  } catch (e) {
    if (e instanceof AxPermissionError) throw e;
    // No AXSelectedText is the common case, not a failure; the clipboard is next.
  }

  if (text === undefined) {
    try {
      const copied = await copySelectionViaClipboard(timeoutMs);
      if (copied !== undefined) {
        text = copied;
        textSource = "clipboard";
      }
    } catch {
      // No selection is a valid answer; the bundle just carries less.
    }
  }

  let elementUnderCursor: AxElement | undefined;
  try {
    const at = await cursorPosition();
    elementUnderCursor = await elementAt(at.x, at.y, { timeoutMs });
  } catch {
    elementUnderCursor = undefined;
  }

  let screenshotPath: string | undefined;
  let screenshotError: string | undefined;
  if (opts.region !== undefined) {
    try {
      screenshotPath = (await captureRegion(opts.region)).path;
    } catch (e) {
      // A TCC-blocked screenshot shouldn't sink the whole bundle; the text
      // and element are still useful, and the message says how to fix it.
      screenshotError = (e as Error).message;
    }
  }

  return {
    app: front.name,
    text,
    textSource,
    elementUnderCursor,
    screenshotPath,
    screenshotError,
    capturedAt: new Date(startedAt).toISOString(),
    ms: Date.now() - startedAt,
  };
}

async function copySelectionViaClipboard(timeoutMs: number): Promise<string | undefined> {
  const prev = (await run("pbpaste", [], { timeoutMs })).stdout;
  await runAppleScript(`tell application "System Events" to keystroke "c" using command down`, timeoutMs);
  // ⌘C lands asynchronously; reading sooner than ~150ms races the app's
  // pasteboard write and returns the old contents.
  await sleep(180);
  const copied = (await run("pbpaste", [], { timeoutMs })).stdout;
  // Restore unconditionally. pbpaste/pbcopy only round-trip plain text, so a
  // rich clipboard degrades to its text form — the accepted cost of having no
  // native pasteboard API in an all-TypeScript build.
  await run("pbcopy", [], { timeoutMs, stdin: prev });
  // Identical contents means ⌘C copied nothing (there was no selection) — or
  // the selection happened to equal the old clipboard, which is indistinguishable.
  if (copied.length === 0 || copied === prev) return undefined;
  return copied;
}
