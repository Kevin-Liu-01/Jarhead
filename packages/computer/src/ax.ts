import { run, RunTimeoutError } from "./exec.ts";

/**
 * The accessibility tree over `osascript` + System Events.
 *
 * Kevin chose all-TypeScript, so there is no AXUIElement binding here; System
 * Events is the pure-CLI route to AX and is verified working on this machine.
 * Two hazards shape everything in this file:
 *
 * 1. System Events blocks indefinitely on a hung app, so every script runs
 *    with a hard timeout (exec.ts enforces it structurally).
 * 2. App names and element titles come from the screen and get embedded in
 *    AppleScript source. That is an injection boundary: a window title
 *    containing a quote must not be able to close the string literal and
 *    start executing script. Everything user-shaped passes through
 *    escapeAppleScriptString(), and element paths are index-only by
 *    construction so nothing textual ever round-trips back into a reference.
 *
 * Electron apps (Cursor, Chrome, Slack, Discord — most of Kevin's desktop)
 * publish an almost-empty AX tree by default. That is not an error: queries
 * return empty results and axAvailable() names the situation so callers can
 * fall back to screenshots.
 */

export class AxPermissionError extends Error {
  constructor(detail: string) {
    super(
      `Accessibility access denied. Grant your terminal in System Settings → Privacy & Security → ` +
        `Accessibility, and accept the Automation prompt for System Events, then retry. (osascript: ${detail})`,
    );
    this.name = "AxPermissionError";
  }
}

// -1719 is "not allowed assistive access", -1743 is a refused Automation
// consent, 1002 is "not allowed to send keystrokes". The phrases vary by
// macOS release; the codes do not.
const DENIED =
  /not allowed assistive access|not authorized to send apple events|not allowed to send keystrokes|\(-1719\)|\(-1743\)|\(1002\)/i;

export const DEFAULT_OSA_TIMEOUT_MS = 8_000;

export async function runAppleScript(script: string, timeoutMs = DEFAULT_OSA_TIMEOUT_MS): Promise<string> {
  const res = await run("osascript", ["-e", script], { timeoutMs });
  if (res.code !== 0) {
    const detail = res.stderr.trim().slice(0, 300);
    if (DENIED.test(detail)) throw new AxPermissionError(detail);
    throw new Error(`osascript failed (exit ${res.code}): ${detail}`);
  }
  return res.stdout.replace(/\n$/, "");
}

/**
 * The injection boundary. Backslashes first, or escaping a quote would
 * produce a sequence the second replace re-breaks. AppleScript 2.0 string
 * literals understand \\ \" \n \r \t, so a title with any of those lands as
 * data, never as syntax.
 */
export function escapeAppleScriptString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

// Field/record separators for script output. Control bytes because window
// titles legitimately contain commas, newlines, and every printable
// delimiter someone might otherwise pick.
const FS = "\u001f";
const RS = "\u001e";

export interface AxPoint {
  readonly x: number;
  readonly y: number;
}

export interface AxSize {
  readonly w: number;
  readonly h: number;
}

export interface FrontmostApp {
  readonly name: string;
  readonly pid: number;
}

export interface WindowInfo {
  readonly title: string;
  readonly position: AxPoint | undefined;
  readonly size: AxSize | undefined;
}

export interface AxElement {
  readonly app: string;
  readonly role: string;
  readonly title: string;
  readonly position: AxPoint | undefined;
  readonly size: AxSize | undefined;
  /** Index-only path from the window/menu-bar root, e.g. "/w/1/3". See pathToReference(). */
  readonly path: string;
}

export async function frontmostApp(timeoutMs = DEFAULT_OSA_TIMEOUT_MS): Promise<FrontmostApp> {
  const out = await runAppleScript(
    `tell application "System Events" to tell (first process whose frontmost is true) to return name & (character id 31) & (unix id as text)`,
    timeoutMs,
  );
  const parts = out.split(FS);
  const name = parts[0];
  const pid = Number(parts[1]);
  if (name === undefined || name.length === 0 || !Number.isFinite(pid)) {
    throw new Error(`unexpected frontmost-app reply: ${JSON.stringify(out)}`);
  }
  return { name, pid };
}

export function buildListWindowsScript(appName: string): string {
  const app = escapeAppleScriptString(appName);
  return [
    `set FS to character id 31`,
    `set RS to character id 30`,
    `set out to ""`,
    `tell application "System Events"`,
    `  tell application process "${app}"`,
    `    repeat with w in windows`,
    `      set t to ""`,
    `      try`,
    `        set t to name of w`,
    `      end try`,
    `      if t is missing value then set t to ""`,
    `      set geom to FS & FS & FS`,
    `      try`,
    `        set {px, py} to position of w`,
    `        set {sw, sh} to size of w`,
    `        set geom to (px as text) & FS & (py as text) & FS & (sw as text) & FS & (sh as text)`,
    `      end try`,
    `      set out to out & t & FS & geom & RS`,
    `    end repeat`,
    `  end tell`,
    `end tell`,
    `return out`,
  ].join("\n");
}

export async function listWindows(appName: string, timeoutMs = DEFAULT_OSA_TIMEOUT_MS): Promise<readonly WindowInfo[]> {
  const raw = await runAppleScript(buildListWindowsScript(appName), timeoutMs);
  const out: WindowInfo[] = [];
  for (const row of raw.split(RS)) {
    if (row.length === 0) continue;
    const f = row.split(FS);
    if (f.length !== 5) continue; // a title contained our separator bytes; drop rather than misparse
    out.push({
      title: f[0] ?? "",
      position: parsePoint(f[1], f[2]),
      size: parseSize(f[3], f[4]),
    });
  }
  return out;
}

function parsePoint(x: string | undefined, y: string | undefined): AxPoint | undefined {
  if (x === undefined || y === undefined || x === "" || y === "") return undefined;
  const px = Number(x);
  const py = Number(y);
  return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : undefined;
}

function parseSize(w: string | undefined, h: string | undefined): AxSize | undefined {
  const p = parsePoint(w, h);
  return p === undefined ? undefined : { w: p.x, h: p.y };
}

/**
 * Breadth-first walk of the frontmost window plus the menu bar, emitting one
 * record per element with its index path.
 *
 * Two shapes of this script matter for speed, both learned the hard way:
 * iterative with an explicit stack (AppleScript handler recursion inside a
 * tell block is slow and miserable to escape correctly), and properties
 * fetched in bulk — `role of UI elements of el` is ONE Apple Event for the
 * whole sibling list, where per-child fetches are one event each. Electron
 * AX trees answer property events lazily and slowly; the per-child version
 * blew a 15s timeout on a 120-element cap against a Chromium app on this
 * machine, the bulk version walks the same tree in well under a second.
 */
export function buildWalkScript(appName: string, maxElements: number): string {
  if (!Number.isInteger(maxElements) || maxElements <= 0) {
    throw new Error(`maxElements must be a positive integer, got ${maxElements}`);
  }
  const app = escapeAppleScriptString(appName);
  return [
    `set FS to character id 31`,
    `set RS to character id 30`,
    `set out to ""`,
    `set visited to 0`,
    `tell application "System Events"`,
    `  tell application process "${app}"`,
    `    set stack to {}`,
    `    if (count of windows) > 0 then set stack to {{window 1, "/w"}}`,
    `    try`,
    `      set stack to stack & {{menu bar 1, "/m"}}`,
    `    end try`,
    `    repeat while (count of stack) > 0 and visited < ${maxElements}`,
    `      set pair to item 1 of stack`,
    `      set stack to rest of stack`,
    `      set el to item 1 of pair`,
    `      set base to item 2 of pair`,
    `      set kids to {}`,
    `      try`,
    `        set kids to UI elements of el`,
    `      end try`,
    `      set kidCount to count of kids`,
    `      if kidCount > 0 then`,
    `        set rlist to {}`,
    `        set tlist to {}`,
    `        set plist to {}`,
    `        set slist to {}`,
    `        try`,
    `          set rlist to role of UI elements of el`,
    `        end try`,
    `        try`,
    `          set tlist to name of UI elements of el`,
    `        end try`,
    `        try`,
    `          set plist to position of UI elements of el`,
    `        end try`,
    `        try`,
    `          set slist to size of UI elements of el`,
    `        end try`,
    `        repeat with i from 1 to kidCount`,
    `          if visited is greater than or equal to ${maxElements} then exit repeat`,
    `          set visited to visited + 1`,
    `          set kidPath to base & "/" & i`,
    `          set r to ""`,
    `          if (count of rlist) is greater than or equal to i then set r to item i of rlist`,
    `          if r is missing value then set r to ""`,
    `          set t to ""`,
    `          if (count of tlist) is greater than or equal to i then set t to item i of tlist`,
    `          if t is missing value then set t to ""`,
    `          set geom to FS & FS & FS`,
    `          if (count of plist) is greater than or equal to i and (count of slist) is greater than or equal to i then`,
    `            set p to item i of plist`,
    `            set s to item i of slist`,
    `            if p is not missing value and s is not missing value then`,
    `              set geom to ((item 1 of p) as text) & FS & ((item 2 of p) as text) & FS & ((item 1 of s) as text) & FS & ((item 2 of s) as text)`,
    `            end if`,
    `          end if`,
    `          set out to out & r & FS & t & FS & geom & FS & kidPath & RS`,
    `          set stack to stack & {{item i of kids, kidPath}}`,
    `        end repeat`,
    `      end if`,
    `    end repeat`,
    `  end tell`,
    `end tell`,
    `return out`,
  ].join("\n");
}

export interface WalkOptions {
  readonly timeoutMs?: number | undefined;
  /** Each element costs several Apple Events; the cap keeps a deep tree bounded in time, not just count. */
  readonly maxElements?: number | undefined;
}

/**
 * Bounds chosen from a measured failure, not taste.
 *
 * Chrome blew through a 400-element cap and a 15s timeout: reaching 400 elements
 * in a Chromium tree costs thousands of Apple Events, and Kevin's desktop is
 * mostly Chromium (Chrome, Cursor, Slack, Discord). A cap that is only ever hit
 * by the apps we most need to degrade on is not a useful cap. 120 elements in 6s
 * covers native apps comfortably and gives up on Chromium fast enough that the
 * vision fallback stays inside a conversational pause.
 */
const MAX_ELEMENTS = 120;
const WALK_TIMEOUT_MS = 6_000;

export interface WalkOutcome {
  readonly elements: readonly AxElement[];
  /** Set when the tree was too slow or too hostile to read — caller should use vision. */
  readonly degraded: string | undefined;
}

async function walkElements(appName: string, opts: WalkOptions): Promise<AxElement[]> {
  const raw = await runAppleScript(
    buildWalkScript(appName, opts.maxElements ?? MAX_ELEMENTS),
    opts.timeoutMs ?? WALK_TIMEOUT_MS,
  );
  const out: AxElement[] = [];
  for (const row of raw.split(RS)) {
    if (row.length === 0) continue;
    const f = row.split(FS);
    if (f.length !== 7) continue;
    out.push({
      app: appName,
      role: f[0] ?? "",
      title: f[1] ?? "",
      position: parsePoint(f[2], f[3]),
      size: parseSize(f[4], f[5]),
      path: f[6] ?? "",
    });
  }
  return out;
}

export interface ElementFilter {
  readonly role?: string | undefined;
  readonly titleContains?: string | undefined;
}

// The actionable subset: things worth clicking, toggling, or typing into.
const DEFAULT_ROLES: ReadonlySet<string> = new Set([
  "axbutton",
  "axmenuitem",
  "axmenubaritem",
  "axtextfield",
  "axtextarea",
  "axcheckbox",
  "axradiobutton",
  "axpopupbutton",
  "axlink",
]);

function normalizeRole(role: string): string {
  const r = role.toLowerCase().replace(/[\s_-]/g, "");
  return r.startsWith("ax") ? r : `ax${r}`;
}

/**
 * Interactive elements of the app's frontmost window (and menu bar).
 *
 * An empty result is a real answer, not a failure: Electron apps expose
 * next to nothing, and callers degrade to screenshots. Use axAvailable() to
 * tell that apart from a missing permission.
 */
export async function findElements(
  appName: string,
  filter: ElementFilter = {},
  opts: WalkOptions = {},
): Promise<readonly AxElement[]> {
  return (await findElementsDetailed(appName, filter, opts)).elements;
}

/**
 * Same walk, but says WHY the result was empty.
 *
 * A timeout here is an ordinary, expected outcome rather than an error: Chromium
 * apps routinely exceed any budget worth spending on a voice turn. Throwing
 * would crash the turn; returning empty with a reason lets the caller fall
 * straight through to the vision path, which is the documented design.
 */
export async function findElementsDetailed(
  appName: string,
  filter: ElementFilter = {},
  opts: WalkOptions = {},
): Promise<WalkOutcome> {
  let all: AxElement[];
  try {
    all = await walkElements(appName, opts);
  } catch (e) {
    if (e instanceof RunTimeoutError) {
      return {
        elements: [],
        degraded: `${appName}'s accessibility tree did not answer in ${opts.timeoutMs ?? WALK_TIMEOUT_MS}ms — use vision`,
      };
    }
    throw e;
  }

  const wantRole = filter.role === undefined ? undefined : normalizeRole(filter.role);
  const needle = filter.titleContains?.toLowerCase();
  const matched = all.filter((el) => {
    const role = normalizeRole(el.role);
    if (wantRole !== undefined) {
      if (role !== wantRole) return false;
    } else if (!DEFAULT_ROLES.has(role)) {
      return false;
    }
    return needle === undefined || el.title.toLowerCase().includes(needle);
  });

  return { elements: matched, degraded: undefined };
}

/**
 * Best-guess element under a screen point: the smallest element whose bounds
 * contain it. System Events has no hit-test verb, so this reuses the walk —
 * smallest-area wins because containers always enclose their children.
 */
export async function elementAt(x: number, y: number, opts: WalkOptions = {}): Promise<AxElement | undefined> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`elementAt needs finite coordinates, got ${x},${y}`);
  const front = await frontmostApp(opts.timeoutMs ?? DEFAULT_OSA_TIMEOUT_MS);
  let best: AxElement | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const el of await walkElements(front.name, opts)) {
    if (el.position === undefined || el.size === undefined) continue;
    if (x < el.position.x || y < el.position.y) continue;
    if (x > el.position.x + el.size.w || y > el.position.y + el.size.h) continue;
    const area = el.size.w * el.size.h;
    if (area < bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

export function buildShallowCountScript(appName: string): string {
  const app = escapeAppleScriptString(appName);
  return [
    `tell application "System Events"`,
    `  tell application process "${app}"`,
    `    if (count of windows) is 0 then return "-1"`,
    `    set n to 0`,
    `    set kids to {}`,
    `    try`,
    `      set kids to UI elements of window 1`,
    `    end try`,
    `    set n to count of kids`,
    `    repeat with k in kids`,
    `      try`,
    `        set n to n + (count of UI elements of k)`,
    `      end try`,
    `    end repeat`,
    `    return n as text`,
    `  end tell`,
    `end tell`,
  ].join("\n");
}

export interface AxAvailability {
  readonly status: "ok" | "not-permitted" | "no-tree" | "error";
  readonly detail: string;
}

/**
 * Preflight for everything else in this file. "not-permitted" means the
 * Accessibility grant is missing (fixable in Settings); "no-tree" means the
 * grant works but this app publishes nothing useful — the common case for
 * Kevin's Electron-heavy desktop, and a reason to use screenshots, not an
 * error to surface.
 */
export async function axAvailable(appName?: string): Promise<AxAvailability> {
  let frontName: string;
  try {
    frontName = await runAppleScript(
      `tell application "System Events" to return name of first process whose frontmost is true`,
      4_000,
    );
  } catch (e) {
    if (e instanceof AxPermissionError) return { status: "not-permitted", detail: e.message };
    if (e instanceof RunTimeoutError) {
      return { status: "error", detail: `System Events did not answer: ${e.message}` };
    }
    return { status: "error", detail: (e as Error).message };
  }
  if (appName === undefined) {
    return { status: "ok", detail: `System Events is answering; frontmost process is ${frontName}` };
  }

  try {
    const n = Number(await runAppleScript(buildShallowCountScript(appName), DEFAULT_OSA_TIMEOUT_MS));
    if (n === -1) return { status: "ok", detail: `${appName} has no windows open to inspect` };
    // A native window exposes at least its close/minimize/zoom buttons plus
    // content at the second level; a bare Chromium shell does not.
    if (!Number.isFinite(n) || n <= 3) {
      return {
        status: "no-tree",
        detail:
          `${appName} exposes only ${Math.max(n, 0)} element(s) — Electron/Chromium apps publish an ` +
          `almost-empty AX tree by default. Fall back to screenshots for this app.`,
      };
    }
    return { status: "ok", detail: `${appName} exposes ${n} elements at the top two levels` };
  } catch (e) {
    if (e instanceof AxPermissionError) return { status: "not-permitted", detail: e.message };
    return { status: "error", detail: (e as Error).message };
  }
}

const PATH_RE = /^\/(w|m)(\/\d+)+$/;

/**
 * Rebuild a System Events reference from an index path. The grammar is
 * numbers-only on purpose: paths travel through model output and tool
 * arguments, and an index can't smuggle script the way a title could.
 */
export function pathToReference(path: string): string {
  if (!PATH_RE.test(path)) {
    throw new Error(`invalid element path ${JSON.stringify(path)} — expected "/w/1/2"-style indexes only`);
  }
  const [, root, ...idxs] = path.split("/");
  let ref = root === "w" ? "window 1" : "menu bar 1";
  for (const i of idxs) ref = `UI element ${Number(i)} of ${ref}`;
  return ref;
}

/**
 * Press an element through AX rather than coordinates. AXPress is what the
 * app itself binds to the control, so it keeps working when the window has
 * moved or re-laid-out since the tree was captured.
 */
export async function pressByPath(appName: string, path: string, timeoutMs = DEFAULT_OSA_TIMEOUT_MS): Promise<void> {
  const ref = pathToReference(path);
  const script = [
    `tell application "System Events"`,
    `  tell application process "${escapeAppleScriptString(appName)}"`,
    `    set el to ${ref}`,
    `    try`,
    `      perform action "AXPress" of el`,
    `    on error`,
    `      click el`,
    `    end try`,
    `  end tell`,
    `end tell`,
  ].join("\n");
  await runAppleScript(script, timeoutMs);
}
