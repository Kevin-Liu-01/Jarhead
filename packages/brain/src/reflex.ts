import { HANDS_OFF_APPS, classifyAction, logger } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import type { ToolRunner } from "./runner.ts";

/**
 * Reflexes: the one-step commands that need no reasoning.
 *
 * "scroll down", "press enter", "open Safari", "close this window", "go back",
 * "type hello", "screenshot this", "click Save" — a brain would take a second or
 * more to decide what a person decides in none. The delegator asks this table
 * first; a match runs through the same ToolRunner as everything else (policy,
 * ledger, confirmation handshake included) and the delegation finishes at once
 * with one spoken line. Anything the table does not match goes to the brain as
 * before, and a reflex that errors falls through to the brain too — the attempt is
 * on the ledger, the task is not lost.
 *
 * Conservative by construction: the WHOLE utterance must be the command (after
 * the wake word and politeness are stripped), so "scroll down to the footer and
 * click save" is the brain's, and "click <text>" first asks the policy whether a
 * control with that name may be clicked without a question — a Send or a Delete
 * is left to the brain, which knows how to ask.
 */

const log = logger("brain.reflex");

export type ReflexKind = "scroll" | "key" | "type" | "open_app" | "close_window" | "back" | "screenshot" | "click";

export interface Reflex {
  readonly kind: ReflexKind;
  /** The tool to run and its input. */
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** What the voice says once it ran ("scrolled down."). */
  readonly said: string;
  /** For the ledger and the log: the command as understood. */
  readonly label: string;
  /**
   * Safe to run before Live has even delegated (Kevin's utterance settled and no
   * delegation yet): only the reversible, look-only-ish ones. Everything else
   * waits for the delegation, which is Live's word that Kevin was talking to it.
   */
  readonly prefire: boolean;
}

/** Wake words and politeness that may wrap a command without changing it. */
const WAKE = /^(?:(?:hey|ok|okay|yo)[,\s]+)?(?:jarhead|jar head|jarred|jared|jar-head)[,.!\s]*/i;
const POLITE_HEAD = /^(?:(?:please|now|just|can you|could you|would you|go ahead and|and)[,\s]+)+/i;
const POLITE_TAIL = /(?:[,\s]+(?:please|now|for me|thanks|thank you))+$/i;

/** The utterance with the wake word, politeness, and punctuation removed; lowercase. */
export function normalizeUtterance(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  t = t.replace(WAKE, "");
  t = t.replace(POLITE_HEAD, "");
  t = t.replace(/[.!?,;:]+$/g, "");
  t = t.replace(POLITE_TAIL, "");
  t = t.replace(/[.!?,;:]+$/g, "").trim();
  return t.toLowerCase();
}

/** Whether the words name Jarhead — a reflex may fire ahead of the delegation only then (or mid-exchange). */
export function addressesJarhead(text: string): boolean {
  return /\b(jarhead|jar head|jarred|jared)\b/i.test(text);
}

const SCROLL = /^(?:scroll|page) (up|down)(?: (?:a (?:bit|little)|more|again|some))?$/;
const ENTER = /^(?:press|hit|tap) (?:enter|return)$/;
const TYPE = /^type (.+)$/;
const OPEN = /^(?:open|launch|switch to|go to) ([a-z0-9][a-z0-9 .+'-]{0,40})$/;
const CLOSE = /^close (?:this|the|that) (?:window|tab)$/;
const BACK = /^(?:go|navigate) back$/;
const SHOT = /^(?:take a )?(?:screenshot|screen shot|capture)(?: (?:this|that|the screen|my screen|it))?$/;
/** At most three words: a control's name, not a description of where to find it. */
const CLICK = /^(?:click|press|tap|hit)(?: on)?(?: the)? ([a-z0-9][a-z0-9.&'-]*(?: [a-z0-9.&'-]+){0,2}?)(?: button)?$/;
/** "type the address from the email" describes something to look up; only literal words are typed by reflex. */
const DESCRIBES = /^(?:the|a|an|my|that|this|it|what|whatever|something|everything|his|her|their|our|your)\b/;

/** The apps a bare "open X" may name: a single capitalised word or two, not a sentence. */
function appName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.split(" ").length > 3) return undefined;
  if (/\b(the|a|my|file|folder|door|window|tab|link|page|it|this|that|website|site|url)\b/.test(name)) return undefined;
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse one utterance; undefined when it is not a whole, unambiguous one-step command. */
export function parseReflex(utterance: string): Reflex | undefined {
  const t = normalizeUtterance(utterance);
  if (!t || t.length > 80) return undefined;
  let m: RegExpExecArray | null;
  if ((m = SCROLL.exec(t))) {
    const dir = m[1] as "up" | "down";
    return { kind: "scroll", tool: "scroll", input: { scroll_direction: dir, scroll_amount: 5 }, said: `scrolled ${dir}.`, label: `scroll ${dir}`, prefire: true };
  }
  if (ENTER.test(t)) return { kind: "key", tool: "key", input: { text: "Return" }, said: "pressed enter.", label: "press enter", prefire: false };
  if (CLOSE.test(t)) return { kind: "close_window", tool: "key", input: { text: "cmd+w" }, said: "closed it.", label: "close window", prefire: false };
  if (BACK.test(t)) return { kind: "back", tool: "key", input: { text: "cmd+[" }, said: "went back.", label: "go back", prefire: false };
  if (SHOT.test(t)) return { kind: "screenshot", tool: "screenshot", input: { quick: true }, said: "got it.", label: "screenshot", prefire: true };
  if ((m = TYPE.exec(t))) {
    // The words as heard, first letter as Kevin would type it; the voice transcript is lowercase.
    const text = utterance.trim().replace(WAKE, "").replace(POLITE_HEAD, "").replace(/^type\s+/i, "").replace(POLITE_TAIL, "").replace(/[.!?]+$/, "").trim();
    if (!text || text.length > 200 || DESCRIBES.test(text.toLowerCase())) return undefined;
    return { kind: "type", tool: "type", input: { text }, said: `typed "${text.slice(0, 40)}".`, label: `type ${text.slice(0, 40)}`, prefire: false };
  }
  if ((m = OPEN.exec(t))) {
    const name = appName(m[1] ?? "");
    if (!name) return undefined;
    return { kind: "open_app", tool: "open_app", input: { name }, said: `opened ${name}.`, label: `open ${name}`, prefire: false };
  }
  if ((m = CLICK.exec(t))) {
    const target = (m[1] ?? "").trim();
    // Pronouns need a look; key names are keys, not controls ("press enter twice" is the brain's).
    if (!target || /^(?:it|this|that|here|there|enter|return|escape|esc|tab|space|delete|backspace|shift|command|cmd|option|control|ctrl|first|second|third|fourth|fifth|last|next|previous|top|bottom|left|right|other|blue|red|green|big|small)\b/.test(target)) return undefined;
    if (/\b(?:row|item|link|icon|thing|one|cell|line|field|box|tab|button)$/.test(target) && target.split(" ").length > 1) return undefined;
    return { kind: "click", tool: "applescript", input: {}, said: `clicked ${target}.`, label: `click ${target}`, prefire: false };
  }
  return undefined;
}

/**
 * System Events finds a control by its name in the frontmost app's front window.
 * Buttons, menu items and checkboxes are what a person names out loud; anything
 * else is the brain's job (it can look). The name is a literal, escaped, and the
 * match is exact (AppleScript's `is` ignores case by default): the policy judged
 * the word Kevin said, so the control clicked must carry exactly that name — a
 * substring match ("ok" in "Revoke Token") would click a control nobody judged.
 */
export function clickByNameScript(target: string): string {
  const name = JSON.stringify(target);
  return [
    `tell application "System Events"`,
    `  set frontApp to first application process whose frontmost is true`,
    `  tell frontApp`,
    `    set hits to (buttons of window 1 whose name is ${name}) & (buttons of window 1 whose description is ${name}) & (checkboxes of window 1 whose name is ${name})`,
    `    if (count of hits) is 0 then error "no control named " & ${name} & " in the front window of " & (name of frontApp)`,
    `    click item 1 of hits`,
    `    return "clicked " & ${name} & " in " & (name of frontApp)`,
    `  end tell`,
    `end tell`,
  ].join("\n");
}

export interface ReflexOutcome {
  readonly reflex: Reflex;
  readonly result: ToolResult;
  /** ms the tool took, as the runner measured it. */
  readonly ms: number;
  /** True when the reflex did what it said; false means the brain should take the task. */
  readonly ok: boolean;
}

export interface ReflexRunnerOptions {
  readonly runner: ToolRunner;
  /** The frontmost app, for the click pre-check (the toolset's own gate runs again inside). */
  readonly frontmostApp?: () => Promise<string>;
}

/**
 * Runs a reflex through the runner. The runner's own gates apply as for any brain
 * call; the click reflex adds a pre-check so a Send/Delete never even starts here.
 */
export class ReflexRunner {
  constructor(private readonly opts: ReflexRunnerOptions) {}

  /** The reflex for an utterance, or undefined. Pure; cheap enough to call on every transcript fragment. */
  match(utterance: string): Reflex | undefined {
    return parseReflex(utterance);
  }

  async run(reflex: Reflex): Promise<ReflexOutcome> {
    let tool = reflex.tool;
    let input = reflex.input;
    if (reflex.kind === "click") {
      const target = reflex.label.replace(/^click /, "");
      const app = (await this.opts.frontmostApp?.().catch(() => "")) ?? "";
      const decision = classifyAction({ kind: "left_click", app, target });
      if (decision.verdict !== "run" || HANDS_OFF_APPS.test(app)) {
        log.info(`reflex "${reflex.label}" left to the brain: ${decision.reason}`);
        return { reflex, result: { kind: "error", message: `not a reflex: ${decision.reason}` }, ms: 0, ok: false };
      }
      tool = "applescript";
      input = { script: clickByNameScript(target) };
    }
    const outcome = await this.opts.runner.run(tool, input);
    const r = outcome.result;
    // A confirmation question is not a failure — the runner recorded the handshake;
    // the delegator relays the question. An error means the brain takes over.
    const ok = r.kind !== "error";
    if (!ok) log.info(`reflex "${reflex.label}" failed (${r.message}); the brain takes it`);
    return { reflex, result: r, ms: outcome.ms, ok };
  }
}
