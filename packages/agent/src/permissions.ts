import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * macOS permission probing.
 *
 * There is no supported API to ask "do I have Screen Recording?" without
 * triggering a prompt, so each permission is probed by attempting the cheapest
 * possible real operation and reading the failure. That is the only honest way
 * to report status.
 *
 * The awkward part is that TCC is granted to the *hosting application* — the
 * terminal, not to Jarvis — so these results describe whatever process tree
 * this is running in. Once Jarvis ships as a signed .app it gets its own
 * identity and its own grants.
 */

export type PermissionState = "granted" | "denied" | "unknown";

export interface PermissionCheck {
  readonly id: "microphone" | "screen" | "accessibility";
  readonly label: string;
  readonly state: PermissionState;
  readonly detail: string;
  /** What stops working without it. */
  readonly unlocks: string;
  /** Deep link into the right System Settings pane. */
  readonly settingsUrl: string;
}

const PANE = "x-apple.systempreferences:com.apple.preference.security";

/**
 * Screen Recording. `screencapture` prints "could not create image from
 * display" and exits nonzero when TCC has not granted it — a distinct signal
 * from a genuine failure, so it is matched specifically.
 */
async function checkScreen(): Promise<PermissionCheck> {
  const base = {
    id: "screen",
    label: "Screen Recording",
    unlocks: "seeing your screen, pointing at things, select-and-ask",
    settingsUrl: `${PANE}?Privacy_ScreenCapture`,
  } as const;

  try {
    await run("screencapture", ["-x", "-t", "png", "/tmp/jarvis-permcheck.png"], { timeout: 8000 });
    return { ...base, state: "granted", detail: "captured a frame" };
  } catch (e) {
    const text = `${(e as { stderr?: string }).stderr ?? ""}${(e as Error).message}`;
    if (/could not create image/i.test(text)) {
      return { ...base, state: "denied", detail: "TCC is blocking display capture" };
    }
    return { ...base, state: "unknown", detail: text.split("\n")[0]?.slice(0, 90) ?? "probe failed" };
  }
}

/**
 * Accessibility. One grant covers two different needs — reading the UI tree via
 * System Events, and synthesizing input via cliclick — so both are probed.
 *
 * The System Events probe deliberately queries a window's UI elements rather
 * than the process list. Listing processes succeeds WITHOUT the grant, which
 * makes it a useless signal and an easy way to convince yourself accessibility
 * works when it does not. Real element access fails with -25211 / -1719.
 */
async function checkAccessibility(): Promise<PermissionCheck> {
  const base = {
    id: "accessibility",
    label: "Accessibility",
    unlocks: "reading the UI tree, moving the cursor, clicking, typing",
    settingsUrl: `${PANE}?Privacy_Accessibility`,
  } as const;

  const script =
    'tell application "System Events" to tell (first process whose frontmost is true) to return count of windows';

  let axReads = false;
  let axDetail = "";
  try {
    await run("osascript", ["-e", script], { timeout: 6000 });
    axReads = true;
  } catch (e) {
    const text = `${(e as { stderr?: string }).stderr ?? ""}${(e as Error).message}`;
    axDetail = /assistive access|-25211|-1719/i.test(text)
      ? "System Events denied assistive access"
      : (text.split("\n")[0]?.slice(0, 60) ?? "osascript failed");
  }

  let canClick = false;
  let clickDetail = "";
  try {
    const { stdout, stderr } = await run("cliclick", ["p"], { timeout: 6000 });
    canClick = !/Accessibility privileges not enabled/i.test(`${stdout}${stderr}`);
    if (!canClick) clickDetail = "cliclick has no privileges";
  } catch (e) {
    const text = `${(e as { stderr?: string }).stderr ?? ""}${(e as Error).message}`;
    clickDetail = /not found|ENOENT/i.test(text)
      ? "cliclick not installed (brew install cliclick)"
      : "cliclick has no privileges";
  }

  if (axReads && canClick) {
    return { ...base, state: "granted", detail: "reads the UI tree and can click" };
  }
  if (!axReads && !canClick) {
    return { ...base, state: "denied", detail: axDetail || clickDetail };
  }
  return {
    ...base,
    state: "denied",
    detail: axReads ? `tree ok, but ${clickDetail}` : `clicking ok, but ${axDetail}`,
  };
}

/**
 * Microphone. This one cannot be probed safely the obvious way: without the
 * grant, ffmpeg does not error — it hangs forever. So the probe is a race
 * against a timer, and a timeout is itself the evidence of denial.
 */
async function checkMicrophone(device: number): Promise<PermissionCheck> {
  const base = {
    id: "microphone",
    label: "Microphone",
    unlocks: "hearing you at all",
    settingsUrl: `${PANE}?Privacy_Microphone`,
  } as const;

  try {
    await run(
      "ffmpeg",
      ["-hide_banner", "-f", "avfoundation", "-i", `:${device}`, "-t", "0.3", "-f", "null", "-"],
      { timeout: 5000 },
    );
    return { ...base, state: "granted", detail: "captured audio" };
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; stderr?: string };
    if (err.killed || err.signal === "SIGTERM") {
      return { ...base, state: "denied", detail: "ffmpeg hung — the prompt never appeared" };
    }
    const text = `${err.stderr ?? ""}${(e as Error).message}`;
    if (/Operation not permitted|Input\/output error/i.test(text)) {
      return { ...base, state: "denied", detail: "avfoundation refused the device" };
    }
    return { ...base, state: "unknown", detail: text.split("\n")[0]?.slice(0, 90) ?? "probe failed" };
  }
}

export async function checkAll(micDevice = 1): Promise<PermissionCheck[]> {
  // Run in parallel — the microphone probe alone can burn 5s on its timeout.
  return Promise.all([checkMicrophone(micDevice), checkScreen(), checkAccessibility()]);
}

/** Open the System Settings pane for a permission. */
export async function openSettings(check: PermissionCheck): Promise<void> {
  await run("open", [check.settingsUrl], { timeout: 5000 });
}
