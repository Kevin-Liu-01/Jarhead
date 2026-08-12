import { readFileSync } from "node:fs";
import {
  captureRegion,
  downscale,
  findElementsDetailed,
  frontmostApp,
  listWindows,
  moveTo,
  type AxElement,
} from "@jarvis/computer";
import type { Brain } from "@jarvis/voice";
import { withOverlayHidden } from "./capture.ts";

/**
 * Point at a thing on screen, AX-first with a vision fallback.
 *
 * The fallback is not a nicety. Measured on this machine: Claude's accessibility
 * tree does not answer inside 6s, and Chrome needs 4.6s to yield 104 mostly
 * untitled elements. Most of Kevin's desktop is Chromium (Chrome, Cursor, Slack,
 * Discord), so the "fallback" is the ordinary path and AX is the lucky one.
 *
 * Vision coordinates are asked for as fractions of the captured WINDOW, not the
 * display, for two reasons: a window crop is a smaller image so the model's
 * relative error costs fewer pixels, and remapping through the window origin
 * handles displays at negative coordinates without any special casing — the
 * menu bar here sits at y=-2160.
 */

export interface PointTarget {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly via: "accessibility" | "vision";
  /** Only set for vision: the model's own confidence, which it is bad at. */
  readonly note: string | undefined;
}

export interface LocateOutcome {
  readonly target: PointTarget | undefined;
  readonly axMs: number;
  readonly visionMs: number | undefined;
  readonly degraded: string | undefined;
}

function centerOf(el: AxElement): { x: number; y: number } | undefined {
  if (!el.position) return undefined;
  return {
    x: el.position.x + (el.size ? el.size.w / 2 : 0),
    y: el.position.y + (el.size ? el.size.h / 2 : 0),
  };
}

/** Model replies with fractions of the image, or nulls when it cannot see it. */
interface VisionReply {
  readonly x: number | null;
  readonly y: number | null;
  readonly what: string | null;
}

function parseVisionReply(text: string): VisionReply | undefined {
  // The model sometimes wraps JSON in prose or a fence despite instructions.
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as Partial<VisionReply>;
    return {
      x: typeof parsed.x === "number" ? parsed.x : null,
      y: typeof parsed.y === "number" ? parsed.y : null,
      what: typeof parsed.what === "string" ? parsed.what : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Apps whose accessibility tree has already proved useless this session.
 *
 * Without this, every point at a Chromium app pays the full AX budget before
 * falling back — measured at 4.2s of pure waste on Chrome, on top of the 1.4s
 * the vision path actually needs. An app does not grow an accessibility tree
 * mid-session, so one failure is enough to stop asking.
 */
const axHopeless = new Set<string>();

/** Exposed so a long-running daemon can forget after an app relaunch. */
export function resetAxCache(): void {
  axHopeless.clear();
}

/**
 * Budget for the accessibility attempt when vision is running alongside it.
 *
 * Sequential was costing 5.3s per lookup: ~4s waiting for a Chromium tree that
 * was never going to answer, and only then starting the 1.5s vision call. Since
 * most of Kevin's desktop is Chromium, that was the normal path, and a model
 * chaining two or three lookups turned into the "literal minutes" he hit.
 */
const AX_RACE_BUDGET_MS = 1200;

export async function locate(description: string, brain: Brain): Promise<LocateOutcome> {
  const app = await frontmostApp();

  // Both start NOW. Accessibility is still preferred when it answers — its
  // frames are exact — but nothing waits on it to fail first.
  const axStart = Date.now();
  const axAttempt = axHopeless.has(app.name)
    ? Promise.resolve({ elements: [] as readonly AxElement[], degraded: "cached: no usable tree" })
    : findElementsDetailed(app.name, description ? { titleContains: description } : {}, {
        timeoutMs: AX_RACE_BUDGET_MS,
      }).catch(() => ({ elements: [] as readonly AxElement[], degraded: "accessibility failed" }));

  const visionAttempt = visionLocate(app.name, description, brain);

  const walk = await axAttempt;
  const axMs = Date.now() - axStart;

  if (walk.elements.length === 0) axHopeless.add(app.name);

  for (const el of walk.elements) {
    const c = centerOf(el);
    if (c) {
      // Vision was started speculatively and is simply discarded. One extra
      // screenshot is a far better trade than four seconds of silence.
      void visionAttempt.catch(() => undefined);
      return {
        target: { x: c.x, y: c.y, label: el.title || el.role, via: "accessibility", note: undefined },
        axMs,
        visionMs: undefined,
        degraded: undefined,
      };
    }
  }

  return { ...(await visionAttempt), axMs };
}

/** The screenshot path, factored out so it can run alongside the accessibility one. */
async function visionLocate(
  appName: string,
  description: string,
  brain: Brain,
): Promise<Omit<LocateOutcome, "axMs">> {
  const app = { name: appName };
  const windows = await listWindows(app.name);
  const win = windows.find((w) => w.position !== undefined && w.size !== undefined);
  if (!win?.position || !win.size) {
    return {
      target: undefined,
      visionMs: undefined,
      degraded: `${app.name} exposes neither elements nor window bounds — nothing to point at`,
    };
  }

  const visionStart = Date.now();
  // Bound to locals because the closure below loses the narrowing on win.*.
  const bounds = { x: win.position.x, y: win.position.y, w: win.size.w, h: win.size.h };
  // Hidden for the same reason as the full-screen path: the buddy is often
  // sitting right over the window we are trying to read.
  const shot = await withOverlayHidden(() => captureRegion(bounds));
  const small = await downscale(shot.path, 1024);
  const sentPath = typeof small === "string" ? small : small.path;
  const base64 = readFileSync(sentPath).toString("base64");

  const result = await brain.streamAboutImage(
    `This is a screenshot of the "${app.name}" window.\n\n` +
      `Find: ${description || "the most likely thing a user would click next"}\n\n` +
      `Reply with ONLY a JSON object, no prose and no code fence:\n` +
      `{"x": <horizontal position as a fraction 0..1>, "y": <vertical position as a fraction 0..1>, "what": "<what you found>"}\n\n` +
      `Use the CENTER of the element. If it is not visible in this screenshot, reply ` +
      `{"x": null, "y": null, "what": null} — do not guess.`,
    { base64, mediaType: "image/png" },
    { onToken: () => undefined, maxTokens: 200, system: "You locate UI elements in screenshots and reply with strict JSON." },
  );
  const visionMs = Date.now() - visionStart;

  const reply = parseVisionReply(result.text);
  if (!reply || reply.x === null || reply.y === null) {
    return {
      target: undefined,
      visionMs,
      degraded: `not visible in the ${app.name} window${reply ? "" : ` (unparseable reply: ${result.text.slice(0, 80)})`}`,
    };
  }

  // Fractions are clamped: a model that returns 1.4 must not fling the cursor
  // onto another display.
  const fx = Math.min(1, Math.max(0, reply.x));
  const fy = Math.min(1, Math.max(0, reply.y));

  return {
    target: {
      x: win.position.x + fx * win.size.w,
      y: win.position.y + fy * win.size.h,
      label: reply.what ?? description,
      via: "vision",
      note: `fraction ${fx.toFixed(3)},${fy.toFixed(3)} of ${Math.round(win.size.w)}x${Math.round(win.size.h)} window`,
    },
    visionMs,
    degraded: undefined,
  };
}

/** Locate, then glide. Does not click — that is policy's decision, not this file's. */
export async function pointAt(description: string, brain: Brain, durationMs = 700): Promise<LocateOutcome> {
  const outcome = await locate(description, brain);
  if (outcome.target) await moveTo(outcome.target.x, outcome.target.y, { durationMs });
  return outcome;
}
