import type { ToolDeps } from "../executor.ts";

/**
 * A full ToolDeps of happy-path fakes, plus a flat call log so tests can
 * assert both WHAT ran and in what ORDER. Not a .test.ts file, so the test
 * runner's glob skips it.
 */
export function fakeDeps(overrides: Partial<ToolDeps> = {}): { readonly deps: ToolDeps; readonly calls: string[] } {
  const calls: string[] = [];
  const deps: ToolDeps = {
    eyes: {
      lookAt: async (question) => {
        calls.push(`look:${question}`);
        return "a text editor with a save dialog open";
      },
    },
    finder: {
      find: async (description) => {
        calls.push(`find:${description}`);
        return {
          // Negative y on purpose: coordinates from the display above the
          // primary must survive the whole pipeline.
          target: { x: 100, y: -200, label: description, via: "vision", confidence: "fraction 0.4,0.2" },
          degraded: undefined,
        };
      },
    },
    cursor: {
      moveTo: async (x, y) => {
        calls.push(`move:${x},${y}`);
      },
      clickAt: async (x, y) => {
        calls.push(`click:${x},${y}`);
      },
      // Negative y on purpose: the display above the primary is where most of
      // the coordinate bugs in this repo have lived.
      position: async () => {
        calls.push("position");
        return { x: 4242, y: -1337 };
      },
    },
    annotator: {
      draw: async (shape, x, y, label) => {
        calls.push(`draw:${shape}:${x},${y}:${label ?? ""}`);
      },
      highlight: async (x, y, w, h, label) => {
        calls.push(`highlight:${x},${y},${w},${h}:${label ?? ""}`);
      },
      path: async (fromX, fromY, toX, toY) => {
        calls.push(`path:${fromX},${fromY}->${toX},${toY}`);
      },
      clear: async () => {
        calls.push("clear-annotations");
      },
    },
    windows: {
      list: async () => {
        calls.push("list-windows");
        return [{ app: "Notes", title: "Untitled", frontmost: true }];
      },
    },
    policy: {
      classifyClick: async () => ({ level: "pre-approvable", reason: "focused window, pre-approved" }),
    },
    ...overrides,
  };
  return { deps, calls };
}
