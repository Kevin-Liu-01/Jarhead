import { DRAW_SHAPES, type DrawShape } from "./definitions.ts";

/**
 * Speech and visuals landing together.
 *
 * The failure mode this file exists to prevent: the model plans "the export
 * button is here" plus an arrow, the arrow appears, three seconds of tool
 * plumbing pass, and THEN the sentence plays — or worse, the whole narration
 * plays and the arrows arrive afterwards like a slideshow that lost sync. A
 * Choreography pins each visual to the sentence that mentions it, and the
 * runner fires the visual at the START of its beat: a visual that leads the
 * words slightly reads as pointing, while one that trails reads as lag.
 *
 * Everything here is pure or injected, so ordering is provable in tests with
 * no display, no audio, and no clock.
 */

export type Command =
  | { readonly kind: "point"; readonly x: number; readonly y: number; readonly label: string | undefined }
  | {
      readonly kind: "draw";
      readonly shape: DrawShape;
      readonly x: number;
      readonly y: number;
      readonly label: string | undefined;
    }
  | {
      readonly kind: "highlight";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly label: string | undefined;
    }
  | {
      readonly kind: "path";
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
    }
  | { readonly kind: "clear" };

export interface Beat {
  readonly say: string | undefined;
  readonly show: readonly Command[] | undefined;
  readonly waitMs: number | undefined;
}

export interface Cue {
  /** The phrase the narration uses for this visual; matched case-insensitively. */
  readonly mention: string;
  readonly command: Command;
}

/** The tools the runner performs as `show` commands; teach.ts must not execute these a second time. */
export const VISUAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "point_at",
  "draw",
  "highlight_region",
  "show_path",
  "clear_annotations",
]);

function numOf(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strOf(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * A visual tool call as a Cue, or undefined for non-visual tools and malformed
 * inputs. Planning is best-effort — the executor is the enforcement point for
 * bad inputs, and a plan must never throw over one broken call in a turn that
 * also contains good ones.
 */
export function visualCue(name: string, input: unknown): Cue | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;

  switch (name) {
    case "point_at": {
      const x = numOf(obj, "x");
      const y = numOf(obj, "y");
      if (x === undefined || y === undefined) return undefined;
      const label = strOf(obj, "label");
      return { mention: label ?? "", command: { kind: "point", x, y, label } };
    }
    case "draw": {
      const x = numOf(obj, "x");
      const y = numOf(obj, "y");
      const shape = strOf(obj, "shape");
      if (x === undefined || y === undefined || shape === undefined) return undefined;
      if (!(DRAW_SHAPES as readonly string[]).includes(shape)) return undefined;
      const label = strOf(obj, "label");
      return { mention: label ?? "", command: { kind: "draw", shape: shape as DrawShape, x, y, label } };
    }
    case "highlight_region": {
      const x = numOf(obj, "x");
      const y = numOf(obj, "y");
      const w = numOf(obj, "w");
      const h = numOf(obj, "h");
      if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
      const label = strOf(obj, "label");
      return { mention: label ?? "", command: { kind: "highlight", x, y, w, h, label } };
    }
    case "show_path": {
      const fromX = numOf(obj, "fromX");
      const fromY = numOf(obj, "fromY");
      const toX = numOf(obj, "toX");
      const toY = numOf(obj, "toY");
      if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) return undefined;
      // Trails are rarely named in narration, so the empty mention parks the
      // trail on the first sentence, where leading still reads as intent.
      return { mention: "", command: { kind: "path", fromX, fromY, toX, toY } };
    }
    case "clear_annotations":
      return { mention: "", command: { kind: "clear" } };
    default:
      return undefined;
  }
}

function sentencesOf(text: string): readonly string[] {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

// Articles and glue words carry no signal about WHICH sentence mentions a
// visual — "the" appears in all of them.
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "at",
  "and",
  "or",
  "is",
  "it",
  "its",
  "this",
  "that",
  "your",
  "my",
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Whole-phrase match first, then all-content-words: the model labels an arrow
 * "export button" but narrates "the button that says Export", and demanding
 * the exact phrase would push that arrow onto the wrong sentence.
 */
function mentions(sentence: string, mention: string): boolean {
  const s = ` ${normalize(sentence)} `;
  const m = normalize(mention);
  if (m.length === 0) return false;
  if (s.includes(` ${m} `)) return true;
  const words = m.split(" ").filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return words.length > 0 && words.every((w) => s.includes(` ${w} `));
}

/**
 * Split narration into sentences and attach each cue to the first sentence
 * that mentions it, so the arrow appears exactly as the words about it are
 * spoken. A cue nothing mentions still has to appear sometime; it goes on the
 * FIRST beat, because early-and-leading is the failure mode that still reads
 * as pointing.
 */
export function beatsFromNarration(text: string, cues: readonly Cue[]): readonly Beat[] {
  const sentences = sentencesOf(text);
  if (sentences.length === 0) {
    if (cues.length === 0) return [];
    return [{ say: undefined, show: cues.map((c) => c.command), waitMs: undefined }];
  }

  const shows: Command[][] = sentences.map(() => []);
  const unmatched: Command[] = [];
  for (const cue of cues) {
    const idx = sentences.findIndex((s) => mentions(s, cue.mention));
    if (idx >= 0) shows[idx]?.push(cue.command);
    else unmatched.push(cue.command);
  }
  shows[0]?.unshift(...unmatched);

  return sentences.map((say, i) => {
    const show = shows[i] ?? [];
    return { say, show: show.length > 0 ? show : undefined, waitMs: undefined };
  });
}

/** One content block of a model turn, the two kinds a choreography cares about. */
export type ModelBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly input: unknown };

/**
 * A model turn's blocks as beats. Text accumulates until visual tool calls
 * arrive; each narration-plus-visuals group is choreographed together, so a
 * turn shaped "para, arrow, arrow, para, highlight" becomes two synced groups
 * rather than one big paragraph with every visual stapled to the front.
 * Non-visual tools (look, find, click, list) are not shown — they are actions
 * the caller executes, not annotations.
 */
export function planFromToolCalls(blocks: readonly ModelBlock[]): readonly Beat[] {
  const beats: Beat[] = [];
  let text = "";
  let cues: Cue[] = [];

  const flush = (): void => {
    if (text.trim().length === 0 && cues.length === 0) return;
    beats.push(...beatsFromNarration(text, cues));
    text = "";
    cues = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      // Text after visuals starts a new group; text after text is the model
      // splitting one narration across blocks.
      if (cues.length > 0) flush();
      text = text.length > 0 ? `${text} ${block.text}` : block.text;
    } else {
      const cue = visualCue(block.name, block.input);
      if (cue) cues.push(cue);
    }
  }
  flush();
  return beats;
}

export interface ChoreographyIO {
  readonly speak: (text: string) => Promise<void>;
  readonly show: (commands: readonly Command[]) => void | Promise<void>;
  readonly clear: () => void | Promise<void>;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface ChoreographyResult {
  readonly completed: boolean;
  readonly beatsRun: number;
  readonly elapsedMs: number;
}

/**
 * A dropped arrow is cosmetic; a failed one crashing the narration is not.
 *
 * Takes a THUNK rather than a promise so the call itself happens inside the
 * catch. Passing `fire(io.show(...))` let a synchronous throw escape before fire
 * ever ran — and in the finally block it would also have masked whatever error
 * was already unwinding.
 */
function fire(effect: () => void | Promise<void>): void {
  try {
    void Promise.resolve(effect()).catch(() => undefined);
  } catch {
    // Swallowed on purpose: see above.
  }
}

/**
 * Run beats in order. The visual fires at the start of its beat and is NOT
 * awaited; speech IS awaited, so narration never overlaps itself and the next
 * beat's visual cannot jump ahead of the current sentence. The abort check
 * sits between beats — cutting audio mid-sentence is the speaker's job (it
 * owns the audio handle), not this scheduler's.
 */
export async function runChoreography(beats: readonly Beat[], io: ChoreographyIO): Promise<ChoreographyResult> {
  const now = io.now ?? Date.now;
  // The default wait has to honour the abort signal, or a beat with a long
  // waitMs would keep narrating after Kevin has already interrupted — the abort
  // check only sits between beats.
  const wait =
    io.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish(): void {
          clearTimeout(timer);
          io.signal?.removeEventListener("abort", finish);
          resolve();
        }
        io.signal?.addEventListener("abort", finish, { once: true });
      }));
  const startedAt = now();
  let beatsRun = 0;

  try {
    for (const beat of beats) {
      if (io.signal?.aborted) break;
      if (beat.show !== undefined && beat.show.length > 0) fire(() => io.show(beat.show ?? []));
      if (beat.say !== undefined && beat.say.length > 0) await io.speak(beat.say);
      if (beat.waitMs !== undefined && beat.waitMs > 0) await wait(beat.waitMs);
      beatsRun++;
    }
  } finally {
    // Annotations must not outlive the narration — a stale arrow over a screen
    // that has since changed is worse than no arrow. This runs on abort too:
    // Kevin interrupting means he is done with the pointing.
    fire(() => io.clear());
  }

  return { completed: beatsRun === beats.length, beatsRun, elapsedMs: now() - startedAt };
}
