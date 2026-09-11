import { DRAW_SHAPES, TOOL_NAMES, type DrawShape } from "./definitions.ts";

/**
 * Executes one tool call against injected capabilities.
 *
 * Nothing here may throw. A thrown error propagates out of the tool loop and
 * kills the whole model turn — and a killed turn, to Kevin, is silence. So
 * every failure (bad input, missing element, refused click, a dependency that
 * blew up) is folded into a result the model can read and react to, exactly
 * the way findElementsDetailed treats an AX timeout as an empty result rather
 * than an error.
 *
 * Every dependency is an interface. The real wiring — @jarvis/agent's eyes and
 * pointing, @jarvis/computer's input and policy, the overlay's annotation
 * client — happens in the integrator, because importing those here would close
 * the dependency cycle back through @jarvis/live. The interfaces also mean the
 * whole executor runs under test with fakes and no display.
 */

export interface ScreenEyes {
  /** Capture + vision. Returns what the model saw, already phrased for Kevin. */
  lookAt(question: string): Promise<string>;
}

export interface FoundElement {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly via: "accessibility" | "vision";
  /** Only set for vision, which is bad at estimating its own accuracy. */
  readonly confidence: string | undefined;
}

export interface FindOutcome {
  readonly target: FoundElement | undefined;
  /** Why the search came back empty, when it did. */
  readonly degraded: string | undefined;
}

export interface ElementFinder {
  find(description: string): Promise<FindOutcome>;
}

export interface Cursor {
  moveTo(x: number, y: number, durationMs: number): Promise<void>;
  clickAt(x: number, y: number): Promise<void>;
  /** Exact pointer location. Deterministic, unlike anything read off a screenshot. */
  position(): Promise<{ readonly x: number; readonly y: number }>;
}

export interface Annotator {
  draw(shape: DrawShape, x: number, y: number, label: string | undefined): Promise<void>;
  highlight(x: number, y: number, w: number, h: number, label: string | undefined): Promise<void>;
  path(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  clear(): Promise<void>;
}

export interface OpenWindow {
  readonly app: string;
  readonly title: string;
  readonly frontmost: boolean;
}

export interface WindowLister {
  list(): Promise<readonly OpenWindow[]>;
}

export interface ClickJudgement {
  /**
   * Deliberately `string`, not the ConfirmLevel union: the executor must
   * survive a policy implementation that returns nonsense, and typing this as
   * the union would let the compiler promise something the boundary cannot.
   */
  readonly level: string;
  readonly reason: string;
}

export interface ClickPolicy {
  /** The implementation knows the frontmost app and target; the executor only knows coordinates. */
  classifyClick(x: number, y: number): Promise<ClickJudgement>;
}

export interface ToolDeps {
  readonly eyes: ScreenEyes;
  readonly finder: ElementFinder;
  readonly cursor: Cursor;
  readonly annotator: Annotator;
  readonly windows: WindowLister;
  readonly policy: ClickPolicy;
}

export type ToolOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

/** Matches pointing.ts's glide: slow enough that Kevin's eye can follow it to the target. */
const POINT_GLIDE_MS = 700;

/**
 * The click gate is fail-closed, mirroring policy.ts: only these two levels
 * may run, and any level this set has never heard of — including one from a
 * buggy or hostile policy implementation — is refused. New levels must be
 * admitted here on purpose, not by default.
 */
const RUNNABLE_CLICK_LEVELS: ReadonlySet<string> = new Set(["always-allowed", "pre-approvable"]);

class ToolInputError extends Error {}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("tool input must be a JSON object");
  }
  return input as Record<string, unknown>;
}

// Finite is the only constraint on coordinates. Non-negative would be wrong:
// the second display's menu bar sits at y=-2160 on this machine.
function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolInputError(`"${key}" must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function posNum(obj: Record<string, unknown>, key: string): number {
  const v = num(obj, key);
  if (v <= 0) throw new ToolInputError(`"${key}" must be positive, got ${v}`);
  return v;
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ToolInputError(`"${key}" must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ToolInputError(`"${key}" must be a string when present`);
  return v;
}

function shapeOf(obj: Record<string, unknown>): DrawShape {
  const shape = str(obj, "shape");
  if (!(DRAW_SHAPES as readonly string[]).includes(shape)) {
    throw new ToolInputError(`unknown shape ${JSON.stringify(shape)}; expected one of ${DRAW_SHAPES.join(", ")}`);
  }
  return shape as DrawShape;
}

type Handler = (input: Record<string, unknown>, deps: ToolDeps) => Promise<unknown>;

const HANDLERS = {
  look_at_screen: async (input, deps) => {
    return { seen: await deps.eyes.lookAt(str(input, "question")) };
  },

  find_on_screen: async (input, deps) => {
    const outcome = await deps.finder.find(str(input, "description"));
    if (!outcome.target) {
      // Not found is an answer, not an error: the model should tell Kevin or
      // try a different description, not treat the turn as broken.
      return { found: false, why: outcome.degraded ?? "not visible on the current screen" };
    }
    return { found: true, ...outcome.target };
  },

  point_at: async (input, deps) => {
    const x = num(input, "x");
    const y = num(input, "y");
    const label = str(input, "label");
    await deps.cursor.moveTo(x, y, POINT_GLIDE_MS);
    await deps.annotator.draw("arrow", x, y, label);
    return { pointed: true, x, y, label };
  },

  draw: async (input, deps) => {
    const shape = shapeOf(input);
    const x = num(input, "x");
    const y = num(input, "y");
    await deps.annotator.draw(shape, x, y, optStr(input, "label"));
    return { drawn: shape, x, y };
  },

  highlight_region: async (input, deps) => {
    const x = num(input, "x");
    const y = num(input, "y");
    const w = posNum(input, "w");
    const h = posNum(input, "h");
    await deps.annotator.highlight(x, y, w, h, optStr(input, "label"));
    return { highlighted: true, x, y, w, h };
  },

  show_path: async (input, deps) => {
    const fromX = num(input, "fromX");
    const fromY = num(input, "fromY");
    const toX = num(input, "toX");
    const toY = num(input, "toY");
    await deps.annotator.path(fromX, fromY, toX, toY);
    return { shown: true };
  },

  clear_annotations: async (_input, deps) => {
    await deps.annotator.clear();
    return { cleared: true };
  },

  click_at: async (input, deps) => {
    const x = num(input, "x");
    const y = num(input, "y");
    const judgement = await deps.policy.classifyClick(x, y);
    if (!RUNNABLE_CLICK_LEVELS.has(judgement.level)) {
      throw new ToolInputError(
        `click at (${x}, ${y}) refused (${judgement.level}): ${judgement.reason}. ` +
          `This needs Kevin's spoken confirmation — tell him what you want to click and why, ` +
          `then wait for his yes. Do not retry this call until he confirms.`,
      );
    }
    await deps.cursor.clickAt(x, y);
    return { clicked: true, x, y, level: judgement.level };
  },

  list_windows: async (_input, deps) => {
    return { windows: await deps.windows.list() };
  },

  /**
   * The deterministic answer to "where is my cursor".
   *
   * Worth its own tool rather than folding into look_at_screen: a screenshot may
   * not contain the pointer at all (screencapture omits it without -C), so vision
   * would confidently report it missing. This reads the system pointer.
   */
  cursor_position: async (_input, deps) => {
    const p = await deps.cursor.position();
    return { x: p.x, y: p.y };
  },
} as const satisfies Record<(typeof TOOL_NAMES)[number], Handler>;

/** Exported so definitions.test.ts can prove the two files never drift apart. */
export const EXECUTABLE_TOOL_NAMES: readonly string[] = Object.keys(HANDLERS);

export async function executeTool(name: string, input: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  const handler: Handler | undefined = (HANDLERS as Record<string, Handler>)[name];
  if (handler === undefined) {
    return { ok: false, error: `unknown tool "${name}"; available: ${EXECUTABLE_TOOL_NAMES.join(", ")}` };
  }
  try {
    return { ok: true, result: await handler(record(input), deps) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
