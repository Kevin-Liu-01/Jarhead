import { run, RunTimeoutError } from "./exec.ts";
import {
  AxPermissionError,
  escapeAppleScriptString,
  pressByPath,
  runAppleScript,
  type AxElement,
} from "./ax.ts";

/**
 * Input synthesis, all through subprocesses.
 *
 * Backend split, decided once and cached:
 * - Pointer gestures use `cliclick` when installed (one binary, real cursor
 *   ownership) and otherwise fall back to JXA — `osascript -l JavaScript`
 *   with the ObjC bridge posting CGEvents, which is the only pure-osascript
 *   way to move the cursor; System Events has no verb for it. cliclick is
 *   NOT installed on this machine today, so the JXA path is the one that
 *   actually runs.
 * - Scrolling is always JXA: cliclick has no scroll command.
 * - Typing and key combos always go through System Events `keystroke`, so
 *   there is exactly one text-escaping boundary instead of two (cliclick's
 *   `t:` has its own quoting rules).
 *
 * One sharp edge: CGEventPost silently drops events when the Accessibility
 * grant is missing — no error, the click just doesn't happen. axAvailable()
 * is the preflight for that; nothing here can detect it after the fact.
 *
 * Nothing in this file belongs on the live voice path; these are tool calls
 * the agent awaits between sentences, not during them.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface TimedPoint {
  readonly x: number;
  readonly y: number;
  readonly atMs: number;
}

export class InputUnavailableError extends Error {
  constructor() {
    super(
      "No input backend available: neither cliclick nor osascript is on PATH. " +
        "`brew install cliclick` restores the preferred pointer path.",
    );
    this.name = "InputUnavailableError";
  }
}

export type PointerBackend = "cliclick" | "jxa";

let cachedBackend: PointerBackend | undefined;

/** Detected once per process; a missing binary does not come back mid-session. */
export async function pointerBackend(): Promise<PointerBackend> {
  if (cachedBackend !== undefined) return cachedBackend;
  if (await binaryExists("cliclick")) cachedBackend = "cliclick";
  else if (await binaryExists("osascript")) cachedBackend = "jxa";
  else throw new InputUnavailableError();
  return cachedBackend;
}

async function binaryExists(name: string): Promise<boolean> {
  try {
    return (await run("/usr/bin/which", [name], { timeoutMs: 2_000 })).code === 0;
  } catch {
    return false;
  }
}

async function sh(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const res = await run(command, args, { timeoutMs });
  if (res.code !== 0) throw new Error(`${command} exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
  return res.stdout;
}

async function runJxa(script: string, timeoutMs: number): Promise<string> {
  const res = await run("osascript", ["-l", "JavaScript", "-e", script], { timeoutMs });
  if (res.code !== 0) throw new Error(`osascript (JXA) failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
  return res.stdout.replace(/\n$/, "");
}

function assertFinite(what: string, ...values: readonly number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error(`${what} needs finite coordinates, got ${values.join(",")}`);
  }
}

/**
 * The glide plan for moveTo, as pure data so tests can prove it monotonic and
 * exact. Ease-in-out cubic: a slow start so the motion reads as intentional
 * and a slow landing so the target is obvious before anything gets clicked —
 * the whole point of not teleporting is that Kevin can see it coming.
 */
export function easedSteps(from: Point, to: Point, durationMs: number): readonly TimedPoint[] {
  const tx = Math.round(to.x);
  const ty = Math.round(to.y);
  if (durationMs <= 0) return [{ x: tx, y: ty, atMs: 0 }];
  const fx = Math.round(from.x);
  const fy = Math.round(from.y);
  // ~60Hz, capped so a slow glide doesn't become a 500-argument cliclick call.
  const count = Math.min(60, Math.max(2, Math.floor(durationMs / 16)));
  const steps: TimedPoint[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const k = t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2;
    steps.push({
      x: Math.round(fx + (tx - fx) * k),
      y: Math.round(fy + (ty - fy) * k),
      atMs: Math.round(durationMs * t),
    });
  }
  return steps;
}

/**
 * cliclick cannot express a negative absolute coordinate.
 *
 * Its `m:`/`c:` syntax treats a leading sign as RELATIVE, so `m:1000,-500`
 * means "y minus 500", not "y = -500". Measured on this machine: two identical
 * `m:1000,-500` calls landed at y=-378779 then y=-379279, drifting exactly -500
 * each time. Kevin runs displays above the primary one, so the menu bar sits at
 * y=-2160 and negative absolute coordinates are the normal case, not an edge
 * case — this silently walked the cursor into oblivion.
 *
 * CGEvent has no such ambiguity, so anything negative goes through JXA.
 */
export function cliclickCanExpress(...coords: readonly number[]): boolean {
  return coords.every((c) => Math.round(c) >= 0);
}

export async function cursorPosition(): Promise<Point> {
  if ((await pointerBackend()) === "cliclick") {
    const out = await sh("cliclick", ["p"], 3_000);
    const m = /(-?\d+),\s*(-?\d+)/.exec(out);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new Error(`could not parse cliclick position output: ${JSON.stringify(out)}`);
    }
    return { x: Number(m[1]), y: Number(m[2]) };
  }
  // CGEventCreate(NULL) captures the current cursor location in CG's
  // top-left-origin coordinates — unlike NSEvent.mouseLocation, which is
  // bottom-left and would need a per-screen flip.
  const out = await runJxa(
    [
      `ObjC.import("CoreGraphics");`,
      `const e = $.CGEventCreate($());`,
      `const p = $.CGEventGetLocation(e);`,
      `JSON.stringify({ x: p.x, y: p.y });`,
    ].join("\n"),
    4_000,
  );
  const p = JSON.parse(out) as { x: number; y: number };
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export interface MoveOptions {
  readonly durationMs?: number | undefined;
}

export async function moveTo(x: number, y: number, opts: MoveOptions = {}): Promise<void> {
  assertFinite("moveTo", x, y);
  const durationMs = opts.durationMs ?? 350;
  const from = await cursorPosition();
  const steps = easedSteps(from, { x, y }, durationMs);
  const waitMs = Math.max(1, Math.round(durationMs / steps.length));
  const timeoutMs = durationMs + 5_000;
  const allNonNegative = cliclickCanExpress(from.x, from.y, x, y);
  if ((await pointerBackend()) === "cliclick" && allNonNegative) {
    // One process for the whole gesture: -w sleeps between the m: commands.
    await sh("cliclick", ["-w", String(waitMs), ...steps.map((s) => `m:${s.x},${s.y}`)], timeoutMs);
    return;
  }
  await runJxa(
    [
      `ObjC.import("CoreGraphics");`,
      `const pts = ${JSON.stringify(steps.map((s) => [s.x, s.y]))};`,
      `for (const [x, y] of pts) {`,
      `  const e = $.CGEventCreateMouseEvent($(), 5, { x, y }, 0); // 5 = kCGEventMouseMoved`,
      `  $.CGEventPost(0, e); // 0 = kCGHIDEventTap`,
      `  delay(${(waitMs / 1000).toFixed(4)});`,
      `}`,
      `"ok";`,
    ].join("\n"),
    timeoutMs,
  );
}

export async function click(x: number, y: number): Promise<void> {
  await pointerClick(x, y, "left", 1);
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await pointerClick(x, y, "left", 2);
}

export async function rightClick(x: number, y: number): Promise<void> {
  await pointerClick(x, y, "right", 1);
}

async function pointerClick(x: number, y: number, button: "left" | "right", clicks: 1 | 2): Promise<void> {
  assertFinite("click", x, y);
  const cx = Math.round(x);
  const cy = Math.round(y);
  if ((await pointerBackend()) === "cliclick" && cliclickCanExpress(cx, cy)) {
    const cmd = button === "right" ? "rc" : clicks === 2 ? "dc" : "c";
    await sh("cliclick", [`${cmd}:${cx},${cy}`], 5_000);
    return;
  }
  // kCGEventLeftMouseDown/Up = 1/2, Right = 3/4; kCGMouseButtonLeft/Right = 0/2.
  const spec = button === "left" ? { down: 1, up: 2, btn: 0 } : { down: 3, up: 4, btn: 2 };
  await runJxa(
    [
      `ObjC.import("CoreGraphics");`,
      `const press = (state) => {`,
      `  const d = $.CGEventCreateMouseEvent($(), ${spec.down}, { x: ${cx}, y: ${cy} }, ${spec.btn});`,
      `  $.CGEventSetIntegerValueField(d, 1, state); // 1 = kCGMouseEventClickState`,
      `  $.CGEventPost(0, d);`,
      `  const u = $.CGEventCreateMouseEvent($(), ${spec.up}, { x: ${cx}, y: ${cy} }, ${spec.btn});`,
      `  $.CGEventSetIntegerValueField(u, 1, state);`,
      `  $.CGEventPost(0, u);`,
      `};`,
      `press(1);`,
      clicks === 2 ? `delay(0.05); press(2);` : ``,
      `"ok";`,
    ].join("\n"),
    5_000,
  );
}

/** Positive dy scrolls up, matching CGEvent's wheel convention. Values are pixels. */
export async function scroll(dx: number, dy: number): Promise<void> {
  assertFinite("scroll", dx, dy);
  // Fail with the clear no-backend error before touching osascript directly.
  await pointerBackend();
  // Always JXA: cliclick has no scroll command. The header for
  // CGEventCreateScrollWheelEvent is variadic, so the signature must be
  // pinned to two wheels before the bridge will call it.
  await runJxa(
    [
      `ObjC.import("CoreGraphics");`,
      `ObjC.bindFunction("CGEventCreateScrollWheelEvent", ["id", ["id", "uint32", "uint32", "int32", "int32"]]);`,
      `const e = $.CGEventCreateScrollWheelEvent($(), 0, 2, ${Math.trunc(dy)}, ${Math.trunc(dx)}); // 0 = pixel units; wheel1 is vertical`,
      `$.CGEventPost(0, e);`,
      `"ok";`,
    ].join("\n"),
    5_000,
  );
}

export function buildTypeScript(text: string): string {
  return `tell application "System Events" to keystroke "${escapeAppleScriptString(text)}"`;
}

/** Types into whatever holds focus. policy.ts classifies this always-confirm for a reason. */
export async function type(text: string): Promise<void> {
  if (text.length === 0) return;
  // keystroke throughput is roughly a character a frame; scale the cap with length.
  await runAppleScript(buildTypeScript(text), Math.max(6_000, 2_000 + text.length * 30));
}

const MODIFIERS: Readonly<Record<string, string>> = {
  cmd: "command down",
  command: "command down",
  ctrl: "control down",
  control: "control down",
  alt: "option down",
  opt: "option down",
  option: "option down",
  shift: "shift down",
};

// System Events virtual key codes for keys `keystroke` cannot express.
const KEY_CODES: Readonly<Record<string, number>> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export function buildKeyScript(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const keyPart = parts[parts.length - 1];
  if (keyPart === undefined) throw new Error(`empty key combo ${JSON.stringify(combo)}`);
  const mods = parts.slice(0, -1).map((m) => {
    const mapped = MODIFIERS[m];
    if (mapped === undefined) throw new Error(`unknown modifier "${m}" in ${JSON.stringify(combo)}`);
    return mapped;
  });
  const using = mods.length > 0 ? ` using {${mods.join(", ")}}` : "";
  const code = KEY_CODES[keyPart];
  if (code !== undefined) return `tell application "System Events" to key code ${code}${using}`;
  if (keyPart.length === 1) {
    return `tell application "System Events" to keystroke "${escapeAppleScriptString(keyPart)}"${using}`;
  }
  throw new Error(`unknown key "${keyPart}" in ${JSON.stringify(combo)}`);
}

/** e.g. `key("cmd+shift+p")`, `key("enter")`. */
export async function key(combo: string): Promise<void> {
  await runAppleScript(buildKeyScript(combo), 5_000);
}

export interface PressOutcome {
  readonly via: "ax" | "coordinates";
}

/**
 * Press an element found by ax.ts. AX first because AXPress survives layout
 * shifts between observing and acting; the pixel center is the fallback for
 * elements whose press action the app never wired up.
 */
export async function pressElement(element: AxElement): Promise<PressOutcome> {
  try {
    await pressByPath(element.app, element.path);
    return { via: "ax" };
  } catch (e) {
    // A coordinate click needs the same grant; retrying would just fail slower.
    if (e instanceof AxPermissionError) throw e;
    // A timeout means we stopped waiting, NOT that the press did not land.
    // Falling through to a coordinate click here can press the same button
    // twice — send a message, buy a thing, delete a thing, twice. Refuse.
    if (e instanceof RunTimeoutError) {
      throw new Error(
        `pressing ${JSON.stringify(element.title || element.role)} timed out; ` +
          `not retrying by coordinates because the first press may have landed`,
      );
    }
    if (element.position !== undefined && element.size !== undefined) {
      await click(element.position.x + element.size.w / 2, element.position.y + element.size.h / 2);
      return { via: "coordinates" };
    }
    throw e;
  }
}
