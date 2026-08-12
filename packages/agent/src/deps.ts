import {
  classify,
  click,
  frontmostApp,
  listWindows,
  moveTo,
  cursorPosition,
  type AxElement,
} from "@jarvis/computer";
import { AnnotateClient, type ShapeSpec } from "@jarvis/annotate";
import { Brain } from "@jarvis/voice";
import type { ToolDeps } from "@jarvis/tools";
import { lookAtScreen } from "./eyes.ts";
import { locate } from "./pointing.ts";

/**
 * The real implementations behind the tool loop.
 *
 * Deliberately app-agnostic: nothing here knows what Discord or Chrome is. The
 * only questions asked are "what windows exist", "where is the thing that looks
 * like X", and "what is under this point" — which is what makes the same six
 * tools work on any application, including ones that did not exist when this
 * was written.
 *
 * Finding is a deterministic ladder, not a guess:
 *
 *   1. accessibility tree — exact element frames, survives layout changes
 *   2. vision on a window crop — coordinates as fractions, remapped
 *
 * Step 1 is preferred every time because it is exact. It is also unavailable on
 * most of Kevin's desktop, since Chromium apps publish nothing useful, so step 2
 * is the ordinary path rather than the exception. `via` on the result says which
 * one answered, and the model is told to trust them differently.
 */

export interface AgentToolDepsOptions {
  readonly anthropicApiKey: string;
  /** Injected so a turn can share one client instead of reconnecting per draw. */
  readonly annotate?: AnnotateClient;
  readonly log?: (line: string) => void;
}

export function makeToolDeps(opts: AgentToolDepsOptions): ToolDeps {
  const brain = new Brain(opts.anthropicApiKey);
  const annotate = opts.annotate ?? new AnnotateClient();
  const log = opts.log ?? ((): void => undefined);

  /**
   * Drawing must never take a turn down with it.
   *
   * The annotation layer only exists when the Dock app is running; from a bare
   * CLI there is no socket at all. A missing arrow is cosmetic, so every draw
   * swallows its failure and says so in the log rather than failing the tool.
   */
  const draw = async (fn: () => Promise<void>, what: string): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      log(`annotation skipped (${what}): ${(e as Error).message}`);
    }
  };

  return {
    eyes: {
      lookAt: async (question: string) => {
        const timeline = new (await import("./timeline.ts")).Timeline();
        const result = await lookAtScreen(question, { brain, makeSpeaker: silentSpeaker }, timeline);
        return result.answer;
      },
    },

    finder: {
      find: async (description: string) => {
        const outcome = await locate(description, brain);
        if (!outcome.target) {
          return { target: undefined, degraded: outcome.degraded ?? "not found on screen" };
        }
        const t = outcome.target;
        return {
          target: {
            x: t.x,
            y: t.y,
            label: t.label,
            via: t.via,
            // The accessibility tree gives exact frames, so there is nothing to
            // caveat. Vision gives a fraction of a window and is bad at knowing
            // when it is wrong, so its estimate travels with the result.
            confidence: t.via === "vision" ? (t.note ?? "estimated from a screenshot") : undefined,
          },
          degraded: undefined,
        };
      },
    },

    cursor: {
      moveTo: (x, y, durationMs) => moveTo(x, y, { durationMs }),
      clickAt: (x, y) => click(x, y),
      position: () => cursorPosition(),
    },

    annotator: {
      draw: async (shape, x, y, label) => {
        await draw(
          () => annotate.send({ cmd: "draw", id: idFor(shape, x, y), x, y, shape: specFor(shape) }),
          shape,
        );
        if (label) await drawLabel(annotate, draw, label, x, y);
      },
      highlight: async (x, y, w, h, label) => {
        // A box is anchored at its top-left, so the tool's centre-ish x/y is
        // shifted back by half the size — otherwise the highlight sits down and
        // right of the thing it is supposed to surround.
        await draw(
          () =>
            annotate.send({
              cmd: "draw",
              id: idFor("box", x, y),
              x: x - w / 2,
              y: y - h / 2,
              shape: { kind: "box", w: cells(w, CELL_W), h: cells(h, CELL_H) },
            }),
          "box",
        );
        if (label) await drawLabel(annotate, draw, label, x, y - h / 2);
      },
      path: (fromX, fromY, toX, toY) =>
        draw(() => annotate.send({ cmd: "trail", from: { x: fromX, y: fromY }, to: { x: toX, y: toY } }), "trail"),
      clear: () => draw(() => annotate.send({ cmd: "clear" }), "clear"),
    },

    windows: {
      list: async () => {
        const front = await frontmostApp();
        const wins = await listWindows(front.name);
        // Only the frontmost app's windows are enumerable through the
        // accessibility API without walking every process, which costs seconds.
        // The model is told this is the focused app, not the whole desktop.
        return wins.map((w) => ({ app: front.name, title: w.title, frontmost: true }));
      },
    },

    policy: {
      classifyClick: async (x: number, y: number) => {
        // The policy wants to know WHAT is being clicked, not just where, so the
        // element under the point is resolved first. When nothing resolves the
        // target stays unknown, which classify() treats as more dangerous — the
        // fail-closed direction.
        let target = "";
        let app = "";
        try {
          const front = await frontmostApp();
          app = front.name;
          const el = await elementUnder(x, y);
          target = el?.title || el?.role || "";
        } catch {
          // Unknown app and target: classify() is strictest in that case.
        }
        const decision = classify({ kind: "click", app, target, focusedWindow: false });
        return { level: decision.level, reason: decision.reason };
      },
    },
  };
}

/** Stable per shape+position, so redrawing the same annotation replaces it. */
function idFor(shape: string, x: number, y: number): string {
  return `${shape}-${Math.round(x)}-${Math.round(y)}`;
}

/**
 * Approximate cell size for converting pixel sizes into character counts.
 *
 * The renderer measures the real value and the app caches it, but a bare CLI
 * invocation has no renderer to ask. Being a few percent off changes a box by a
 * character, which is invisible; refusing to draw without exact metrics would
 * not be.
 */
const CELL_W = 7;
const CELL_H = 12;

function cells(px: number, per: number): number {
  return Math.max(1, Math.round(px / per));
}

/**
 * The tool API takes a shape NAME; the wire protocol takes a full spec. Sizes
 * are fixed here rather than exposed, because a model choosing arrow lengths in
 * character cells produces arbitrary-looking annotations.
 */
function specFor(shape: string): ShapeSpec {
  switch (shape) {
    case "circle":
      return { kind: "circle", radius: 4 };
    case "underline":
      return { kind: "underline", width: 12 };
    case "crosshair":
      return { kind: "crosshair", size: 3 };
    case "arrow":
    default:
      // Points down-right, so it sits above-left of the target and does not
      // cover it — the same reason a cursor's hotspot is its tip.
      return { kind: "arrow", direction: "SE", length: 6 };
  }
}

/** Labels are their own annotation, offset so they never sit on the target. */
async function drawLabel(
  annotate: AnnotateClient,
  draw: (fn: () => Promise<void>, what: string) => Promise<void>,
  text: string,
  x: number,
  y: number,
): Promise<void> {
  await draw(
    () =>
      annotate.send({
        cmd: "draw",
        id: idFor("label", x, y),
        x: x + 14,
        y: y - 26,
        shape: { kind: "label", text, maxWidth: 28 },
      }),
    "label",
  );
}

async function elementUnder(x: number, y: number): Promise<AxElement | undefined> {
  const { elementAt } = await import("@jarvis/computer");
  try {
    return await elementAt(x, y);
  } catch {
    return undefined;
  }
}

/** lookAtScreen wants a Speaker; the tool path narrates separately. */
const silentSpeaker = (): never =>
  ({
    say: () => undefined,
    idle: async () => undefined,
    stop: () => undefined,
    spoken: [],
    firstAudioMs: undefined,
    firstAudioAt: undefined,
    charactersSpoken: 0,
  }) as never;
