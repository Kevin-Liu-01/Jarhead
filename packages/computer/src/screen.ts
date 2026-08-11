import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";

/**
 * Screen capture via the `screencapture` CLI.
 *
 * On this machine screencapture is currently TCC-blocked: it exits nonzero
 * with "could not create image from display" instead of prompting, because a
 * headless shell has nowhere to show the prompt. That exact phrase is the
 * detection signal, and it maps to a typed error whose message names the
 * Settings pane — a silent nonzero exit here cost real debugging time in the
 * mic pipeline, so this failure gets first-class treatment.
 */

export class ScreenPermissionError extends Error {
  constructor(detail: string) {
    super(
      `Screen Recording access denied. Grant your terminal in System Settings → Privacy & Security → ` +
        `Screen & System Audio Recording, then restart the terminal and retry. (screencapture: ${detail})`,
    );
    this.name = "ScreenPermissionError";
  }
}

export interface CaptureOptions {
  readonly timeoutMs?: number | undefined;
}

export interface Capture {
  readonly path: string;
  readonly ms: number;
}

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;

async function capture(args: readonly string[], timeoutMs: number): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-screen-"));
  const path = join(dir, "capture.png");
  const res = await run("screencapture", [...args, path], { timeoutMs });
  if (/could not create image/i.test(res.stderr)) throw new ScreenPermissionError(res.stderr.trim());
  if (res.code !== 0) throw new Error(`screencapture exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
  if (!existsSync(path)) throw new Error(`screencapture exited 0 but wrote nothing to ${path}`);
  return { path, ms: res.ms };
}

/** Full display. `-x` suppresses the shutter sound so captures stay silent during a voice turn. */
export async function captureScreen(opts: CaptureOptions = {}): Promise<Capture> {
  return capture(["-x", "-t", "png"], opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
}

export async function captureRegion(region: Region, opts: CaptureOptions = {}): Promise<Capture> {
  return capture(["-x", "-t", "png", "-R", buildRegionArg(region)], opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
}

/** `windowId` is a CGWindowID, e.g. from a CGWindowList dump — not an AX path. */
export async function captureWindow(windowId: number, opts: CaptureOptions = {}): Promise<Capture> {
  if (!Number.isInteger(windowId) || windowId <= 0) {
    throw new Error(`windowId must be a positive integer CGWindowID, got ${windowId}`);
  }
  return capture(["-x", "-t", "png", "-l", String(windowId)], opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
}

export function buildRegionArg(region: Region): string {
  for (const [name, v] of Object.entries(region)) {
    if (!Number.isFinite(v)) throw new Error(`region.${name} must be finite, got ${v}`);
  }
  if (region.w <= 0 || region.h <= 0) {
    throw new Error(`region must have positive width and height, got ${region.w}x${region.h}`);
  }
  return `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.w)},${Math.round(region.h)}`;
}

function assertMaxWidth(maxWidth: number): void {
  if (!Number.isInteger(maxWidth) || maxWidth <= 0) {
    throw new Error(`maxWidth must be a positive integer, got ${maxWidth}`);
  }
}

export function downscaledPathFor(input: string, maxWidth: number): string {
  return `${input.replace(/\.[A-Za-z0-9]+$/, "")}.w${maxWidth}.png`;
}

export function downscaleArgs(input: string, output: string, maxWidth: number): readonly string[] {
  assertMaxWidth(maxWidth);
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", input,
    // min() so a frame already narrower than the cap is left alone (never
    // upscale); -2 keeps the height even, which some encoders require and
    // costs nothing for screenshots.
    "-vf", `scale='min(${maxWidth},iw)':-2`,
    "-frames:v", "1",
    output,
  ];
}

/**
 * Shrink a retina capture before it goes anywhere near a vision model.
 *
 * A 5K screenshot is ~15MP of tokens the model mostly ignores; ~1280px wide
 * keeps UI text legible while cutting the payload by an order of magnitude.
 */
export async function downscale(path: string, maxWidth: number, opts: CaptureOptions = {}): Promise<Capture> {
  assertMaxWidth(maxWidth);
  const output = downscaledPathFor(path, maxWidth);
  // ffmpeg's established failure mode on this machine is hanging, not
  // erroring (see packages/voice/src/mic.ts). File-to-file scaling should
  // never touch a TCC'd device, but the timeout rule is universal.
  const res = await run("ffmpeg", [...downscaleArgs(path, output, maxWidth)], {
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  if (res.code !== 0) throw new Error(`ffmpeg exited ${res.code}: ${res.stderr.trim().slice(0, 200)}`);
  if (!existsSync(output)) throw new Error(`ffmpeg exited 0 but wrote nothing to ${output}`);
  return { path: output, ms: res.ms };
}
