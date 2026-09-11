import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DisplayInfo, ScreenshotResult } from "./native.ts";
import { fitScale, type ShotBudget } from "./screen.ts";

/**
 * Screenshots without ScreenCaptureKit.
 *
 * The native helper's capture needs the Screen Recording grant for whichever
 * app launched it. From a terminal that has not been granted, `screencapture`
 * still works (it carries its own entitlement), so this path keeps the eyes
 * open in development and doubles as the recovery route if SCK ever breaks.
 * Slower (~250 ms) and it cannot exclude Jarhead's own windows.
 */

function run(cmd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr.toString().trim() || err.message}`));
      else resolve(stdout.toString());
    });
  });
}

/** screencapture's -D index: 1 is the main display, then the rest in list order. */
export function screencaptureIndex(displays: readonly DisplayInfo[], displayId: number): number {
  const main = displays.find((d) => d.main);
  if (main && main.id === displayId) return 1;
  const others = displays.filter((d) => !d.main);
  const i = others.findIndex((d) => d.id === displayId);
  return i < 0 ? 1 : i + 2;
}

export async function screencaptureFallback(displays: readonly DisplayInfo[], displayId: number, budget: ShotBudget): Promise<ScreenshotResult> {
  const display = displays.find((d) => d.id === displayId) ?? displays.find((d) => d.main) ?? displays[0];
  if (!display) throw new Error("no displays");
  const dir = mkdtempSync(join(tmpdir(), "jh-shot-"));
  const raw = join(dir, "raw.png");
  try {
    await run("screencapture", ["-x", "-C", "-t", "png", "-D", String(screencaptureIndex(displays, display.id)), raw], 8000);
    const rawW = Math.round(display.w * display.scale);
    const rawH = Math.round(display.h * display.scale);
    const scale = fitScale(rawW, rawH, budget);
    let path = raw;
    let width = rawW;
    let height = rawH;
    if (scale < 1) {
      width = Math.round(rawW * scale);
      height = Math.round(rawH * scale);
      path = join(dir, "small.png");
      await run("sips", ["-z", String(height), String(width), raw, "--out", path], 8000);
    }
    const png = readFileSync(path);
    return {
      displayId: display.id,
      pngBase64: png.toString("base64"),
      width,
      height,
      points: { x: display.x, y: display.y, w: display.w, h: display.h },
      scale: width / display.w,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
