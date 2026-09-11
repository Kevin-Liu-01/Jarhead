import { HANDS_OFF_APPS, classifyAction, logger } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import type { ToolRunner } from "./runner.ts";

/**
 * Reflexes: the one-step commands that need no reasoning.
 *
 * "scroll down", "press enter", "open Safari", "close this window", "go back",
 * "type hello", "screenshot this", "click Save", "select all", "new tab", "zoom
 * in", "go to github.com", "circle that", "start dictating" — a brain would take a
 * second or more to decide what a person decides in none. Two sources ask this
 * table: the engine's on-device ear (partials ~100–200 ms behind Kevin's speech,
 * the 250 ms path) and the Delegator on Live's transcript and delegations (the
 * slower, authoritative source). Both run a match through the same ToolRunner as
 * every brain call (policy, ledger, confirmation handshake included). Anything the
 * table does not match goes to the brain as before, and a reflex that errors falls
 * through to the brain too — the attempt is on the ledger, the task is not lost.
 *
 * Conservative by construction: the WHOLE utterance must be the command (after
 * the wake word and politeness are stripped), so "scroll down to the footer and
 * click save" is the brain's, and "click <text>" first asks the policy whether a
 * control with that name may be clicked without a question — a Send or a Delete
 * is left to the brain, which knows how to ask.
 */

const log = logger("brain.reflex");

export type ReflexKind =
  | "scroll"
  | "page"
  | "key"
  | "edit"
  | "type"
  | "open_app"
  | "close_window"
  | "back"
  | "forward"
  | "reload"
  | "tab"
  | "zoom"
  | "go_to"
  | "screenshot"
  | "click"
  | "double_click"
  | "circle"
  | "dictate_start"
  | "dictate_stop";

export interface Reflex {
  readonly kind: ReflexKind;
  /** The tool to run and its input. Engine-level kinds (circle, dictation) name a pseudo tool the engine handles itself. */
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
   * (The ear is a different matter: it acts on Kevin's own words as they arrive.)
   */
  readonly prefire: boolean;
  /** Doing it twice is harmless (a scroll, a screenshot, opening an app that is open): a duplicate from the slower source costs nothing. */
  readonly idempotent: boolean;
  /** Only meaningful with a browser in front (its shortcuts): the runner checks the frontmost app first. */
  readonly browserOnly?: boolean;
}

/** Wake words and politeness that may wrap a command without changing it. */
const WAKE = /^(?:(?:hey|ok|okay|yo)[,\s]+)?(?:jarhead|jar head|jarred|jared|jar-head)[,.!\s]*/i;
const POLITE_HEAD = /^(?:(?:please|now|just|can you|could you|would you|go ahead and|and|then|okay|ok)[,\s]+)+/i;
const POLITE_TAIL = /(?:[,\s]+(?:please|now|for me|thanks|thank you|jarhead|jar head))+$/i;

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

/**
 * The utterance has clearly ended: the transcriber closed it with punctuation, or
 * it ends in a word people put after a command and never before more of it.
 */
export function endsTerminally(text: string): boolean {
  const t = text.trim();
  return /[.!?…]["')\]]?$/.test(t) || /\b(please|now|thanks|thank you|jarhead|jar head)$/i.test(t);
}

/** "one point five" → keep; "google dot com" → "google.com". */
function spokenDots(s: string): string {
  return s.replace(/\b([a-z0-9-]+) dot ([a-z]{2,})\b/g, "$1.$2").replace(/\b([a-z0-9-]+) dot ([a-z]{2,})\b/g, "$1.$2");
}

const SCROLL = /^(?:scroll|swipe) (up|down|left|right)(?: (a (?:bit|little)|a lot|more|again|some|to the (?:top|bottom|end|start)))?$/;
const SCROLL_TO = /^scroll to the (top|bottom|end|start)$/;
const PAGE = /^page (up|down)$/;
const KEY = /^(?:press|hit|tap) (?:the )?(enter|return|escape|esc|tab|space|spacebar|delete|backspace)(?: key)?$/;
const SELECT_ALL = /^select all$/;
const EDIT = /^(copy|cut|paste|undo|redo)(?: (this|that|it))?$/;
const NEW_TAB = /^(?:open (?:a )?)?new tab$/;
const CLOSE_TAB = /^close (?:this |the |that )?tab$/;
const NEXT_TAB = /^next tab$/;
const PREV_TAB = /^(?:previous|prev|last) tab$/;
const RELOAD = /^(?:reload|refresh)(?: (?:the |this )?page)?$/;
const BACK = /^(?:go |navigate )?back$/;
const FORWARD = /^(?:go |navigate )?forward$/;
const ZOOM = /^zoom (in|out)$/;
const ZOOM_RESET = /^(?:reset zoom|actual size|zoom reset)$/;
const TYPE = /^(?:type|write) (.+)$/;
const OPEN = /^(?:open|launch|switch to|go to) ([a-z0-9][a-z0-9 .+'/:-]{0,60})$/;
const CLOSE = /^close (?:this|the|that) (?:window)$/;
const SHOT = /^(?:take a )?(?:screenshot|screen shot|capture)(?: (?:this|that|the screen|my screen|it))?$/;
const CIRCLE = /^(?:circle|highlight|outline) (?:that|this|it|here)(?: (?:one|for me))?$/;
const DICTATE_START = /^(?:start|begin) (?:dictating|dictation)$|^(?:dictation mode|take dictation|dictate)$/;
const DICTATE_STOP = /^(?:stop|end|finish) (?:dictating|dictation)$|^(?:end|exit) dictation mode$/;
/** At most four words: a control's name, not a description of where to find it. */
const CLICK = /^(?:click|press|tap|hit)(?: on)?(?: the)? ([a-z0-9][a-z0-9.&'-]*(?: [a-z0-9.&'-]+){0,3}?)(?: (?:button|link|tab|checkbox|menu|icon))?$/;
const DOUBLE_CLICK = /^double[- ]?click(?: on)?(?: the)? ([a-z0-9][a-z0-9.&'-]*(?: [a-z0-9.&'-]+){0,3}?)(?: (?:button|link|tab|checkbox|menu|icon|file|folder))?$/;
/** "type the address from the email" describes something to look up; only literal words are typed by reflex. */
const DESCRIBES = /^(?:the|a|an|my|that|this|it|what|whatever|something|everything|his|her|their|our|your)\b/;
/** Pronouns and positions need a look; key names are keys, not controls ("press enter twice" is the brain's). */
const NOT_A_LABEL = /^(?:it|this|that|here|there|enter|return|escape|esc|tab|space|delete|backspace|shift|command|cmd|option|control|ctrl|first|second|third|fourth|fifth|last|top|bottom|left|right|other|blue|red|green|big|small|ok button)\b/;
/** "click the thing" / "click the one": a stand-in for a control Kevin is looking at, not its name — on its own or ending a phrase ("the blue one"). */
const STANDS_IN = /^(?:thing|one|it|this|that|here|there)$|\b(?:row|item|link|icon|thing|one|cell|line|field|box|tab|button)$/;

/** Sites a bare "go to X" may mean: the word Kevin says → the address. Apps win when the word is also an app (Slack, Notion…). */
const SITES: Readonly<Record<string, string>> = {
  google: "https://www.google.com/",
  gmail: "https://mail.google.com/",
  "google docs": "https://docs.google.com/",
  "google drive": "https://drive.google.com/",
  "google calendar": "https://calendar.google.com/",
  youtube: "https://www.youtube.com/",
  github: "https://github.com/",
  twitter: "https://x.com/",
  x: "https://x.com/",
  reddit: "https://www.reddit.com/",
  "hacker news": "https://news.ycombinator.com/",
  wikipedia: "https://en.wikipedia.org/",
  amazon: "https://www.amazon.com/",
  netflix: "https://www.netflix.com/",
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  linkedin: "https://www.linkedin.com/",
  vercel: "https://vercel.com/",
  localhost: "http://localhost:3000/",
};

/** A spoken address: "github.com", "github.com/kevin", "localhost:3000", "https://…". */
function urlOf(raw: string): string | undefined {
  // "localhost 3000" / "localhost port 3000" is an address with a port.
  const s = spokenDots(raw.trim()).replace(/^localhost(?: port)? (\d{2,5})$/, "localhost:$1").replace(/\s+/g, "").replace(/\/+$/, "");
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return `http://${s}/`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s)) return `https://${s}${/\//.test(s.split(/[?#]/)[0] ?? "") ? "" : "/"}`;
  return undefined;
}

/** The apps a bare "open X" may name: a single capitalised word or two, not a sentence. */
function appName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.split(" ").length > 3) return undefined;
  if (/\b(the|a|my|file|folder|door|window|tab|link|page|it|this|that|website|site|url|settings)\b/.test(name)) return undefined;
  if (/[/:]/.test(name)) return undefined;
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

const key = (kind: ReflexKind, combo: string, said: string, label: string, extra: Partial<Reflex> = {}): Reflex => ({ kind, tool: "key", input: { text: combo }, said, label, prefire: false, idempotent: false, ...extra });

/** Parse one utterance; undefined when it is not a whole, unambiguous one-step command. */
export function parseReflex(utterance: string): Reflex | undefined {
  const t = normalizeUtterance(utterance);
  if (!t || t.length > 120) return undefined;
  let m: RegExpExecArray | null;
  // Dictation first: "stop dictating" must never read as a stop or a "dictating" of anything.
  if (DICTATE_START.test(t)) return { kind: "dictate_start", tool: "dictate", input: { on: true }, said: "dictating.", label: "start dictating", prefire: false, idempotent: true };
  if (DICTATE_STOP.test(t)) return { kind: "dictate_stop", tool: "dictate", input: { on: false }, said: "done dictating.", label: "stop dictating", prefire: false, idempotent: true };
  if ((m = SCROLL.exec(t))) {
    const dir = m[1] as "up" | "down" | "left" | "right";
    const tail = m[2] ?? "";
    if (/^to the (top|start)$/.test(tail) || (dir === "up" && /^to the/.test(tail))) return key("scroll", "cmd+Up", "scrolled to the top.", "scroll to the top", { idempotent: true, prefire: true });
    if (/^to the (bottom|end)$/.test(tail)) return key("scroll", "cmd+Down", "scrolled to the bottom.", "scroll to the bottom", { idempotent: true, prefire: true });
    const amount = /^a (bit|little)$/.test(tail) ? 2 : tail === "a lot" ? 15 : 5;
    return { kind: "scroll", tool: "scroll", input: { scroll_direction: dir, scroll_amount: amount }, said: `scrolled ${dir}.`, label: `scroll ${dir}${tail ? ` ${tail}` : ""}`, prefire: true, idempotent: true };
  }
  if ((m = SCROLL_TO.exec(t))) {
    const top = m[1] === "top" || m[1] === "start";
    return key("scroll", top ? "cmd+Up" : "cmd+Down", `scrolled to the ${top ? "top" : "bottom"}.`, `scroll to the ${top ? "top" : "bottom"}`, { idempotent: true, prefire: true });
  }
  if ((m = PAGE.exec(t))) return key("page", m[1] === "up" ? "Page_Up" : "Page_Down", `paged ${m[1]}.`, `page ${m[1]}`, { idempotent: true, prefire: true });
  if ((m = KEY.exec(t))) {
    const name = m[1] as string;
    const combo = /^(enter|return)$/.test(name) ? "Return" : /^esc/.test(name) ? "Escape" : name === "tab" ? "Tab" : /^space/.test(name) ? "space" : "Delete";
    const spoken = /^(enter|return)$/.test(name) ? "enter" : /^esc/.test(name) ? "escape" : name === "tab" ? "tab" : /^space/.test(name) ? "space" : "delete";
    return key("key", combo, `pressed ${spoken}.`, `press ${spoken}`);
  }
  if (SELECT_ALL.test(t)) return key("edit", "cmd+a", "selected all.", "select all", { idempotent: true });
  if ((m = EDIT.exec(t))) {
    const verb = m[1] as "copy" | "cut" | "paste" | "undo" | "redo";
    // "copy that" is also how people say "understood"; only a bare copy or "copy this" counts.
    if (verb === "copy" && m[2] === "that") return undefined;
    const combos = { copy: "cmd+c", cut: "cmd+x", paste: "cmd+v", undo: "cmd+z", redo: "cmd+shift+z" } as const;
    const saids = { copy: "copied.", cut: "cut.", paste: "pasted.", undo: "undone.", redo: "redone." } as const;
    return key("edit", combos[verb], saids[verb], verb, { idempotent: verb === "copy" });
  }
  if (NEW_TAB.test(t)) return key("tab", "cmd+t", "new tab.", "new tab", { browserOnly: true });
  if (CLOSE_TAB.test(t)) return key("tab", "cmd+w", "closed the tab.", "close tab", { browserOnly: true });
  if (NEXT_TAB.test(t)) return key("tab", "ctrl+Tab", "next tab.", "next tab", { browserOnly: true });
  if (PREV_TAB.test(t)) return key("tab", "ctrl+shift+Tab", "previous tab.", "previous tab", { browserOnly: true });
  if (RELOAD.test(t)) return key("reload", "cmd+r", "reloaded.", "reload", { browserOnly: true, idempotent: true });
  if (BACK.test(t)) return key("back", "cmd+[", "went back.", "go back", { browserOnly: true });
  if (FORWARD.test(t)) return key("forward", "cmd+]", "went forward.", "go forward", { browserOnly: true });
  if ((m = ZOOM.exec(t))) return key("zoom", m[1] === "in" ? "cmd+=" : "cmd+-", `zoomed ${m[1]}.`, `zoom ${m[1]}`);
  if (ZOOM_RESET.test(t)) return key("zoom", "cmd+0", "zoom reset.", "reset zoom", { idempotent: true });
  if (CLOSE.test(t)) return key("close_window", "cmd+w", "closed it.", "close window");
  if (SHOT.test(t)) return { kind: "screenshot", tool: "screenshot", input: { quick: true }, said: "got it.", label: "screenshot", prefire: true, idempotent: true };
  if (CIRCLE.test(t)) return { kind: "circle", tool: "circle", input: {}, said: "circled it.", label: "circle that", prefire: true, idempotent: true };
  if ((m = TYPE.exec(t))) {
    // The words as heard, first letter as Kevin would type it; the voice transcript is lowercase.
    const text = utterance.trim().replace(WAKE, "").replace(POLITE_HEAD, "").replace(/^(?:type|write)\s+/i, "").replace(/[.!?,;:]+$/, "").replace(POLITE_TAIL, "").replace(/[.!?,;:]+$/, "").trim();
    if (!text || text.length > 200 || DESCRIBES.test(text.toLowerCase())) return undefined;
    return { kind: "type", tool: "type", input: { text }, said: `typed "${text.slice(0, 40)}".`, label: `type ${text.slice(0, 40)}`, prefire: false, idempotent: false };
  }
  if ((m = DOUBLE_CLICK.exec(t))) {
    const target = (m[1] ?? "").trim();
    if (!target || NOT_A_LABEL.test(target) || !isLabel(target, t)) return undefined;
    return { kind: "double_click", tool: "click_element", input: { name: target, count: 2 }, said: `double-clicked ${target}.`, label: `double-click ${target}`, prefire: false, idempotent: false };
  }
  if ((m = OPEN.exec(t))) {
    const raw = m[1] ?? "";
    const goTo = /^go to /.test(t);
    // "go to github.com" / "go to hacker news" navigate; "go to Safari" / "open Slack" open the app.
    const url = urlOf(raw) ?? (goTo ? SITES[spokenDots(raw.trim()).toLowerCase()] : undefined);
    if (url) return { kind: "go_to", tool: "go_to", input: { url }, said: `going to ${url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}.`, label: `go to ${url}`, prefire: false, idempotent: true };
    const name = appName(raw);
    if (!name) return undefined;
    return { kind: "open_app", tool: "open_app", input: { name }, said: `opened ${name}.`, label: `open ${name}`, prefire: false, idempotent: true };
  }
  if ((m = CLICK.exec(t))) {
    const target = (m[1] ?? "").trim();
    if (!target || NOT_A_LABEL.test(target) || !isLabel(target, t)) return undefined;
    return { kind: "click", tool: "click_element", input: { name: target }, said: `clicked ${target}.`, label: `click ${target}`, prefire: false, idempotent: false };
  }
  return undefined;
}

/**
 * A click target is a control's name, not a stand-in for one. "thing", "one" and
 * the pronouns are never names; a phrase ending in a generic noun ("the blue
 * one", "the second row", "the settings icon") describes where to look, and so
 * does "the" plus a generic noun on its own ("click the link": the one Kevin is
 * looking at). A bare generic noun may be a literal label ("click Link" — a
 * control called exactly that; the helper matches exact names).
 */
function isLabel(target: string, utterance: string): boolean {
  if (/^(?:thing|one|it|this|that|here|there)$/.test(target)) return false;
  if (!STANDS_IN.test(target)) return true;
  if (target.split(" ").length > 1) return false;
  return !new RegExp(`\\bthe ${target}$`).test(utterance);
}

/**
 * System Events finds a control by its name in the frontmost app's front window.
 * Kept as the fallback for a helper without `find_element`; the name is a literal,
 * escaped, and the match is exact (AppleScript's `is` ignores case by default): the
 * policy judged the word Kevin said, so the control clicked must carry exactly
 * that name — a substring match ("ok" in "Revoke Token") would click a control
 * nobody judged.
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

// ------------------------------------------------------------------ similarity

/** Edit distance between two short strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? 0;
}

/** 1 for identical strings, 0 for nothing in common: 1 − edits / longer length. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

// ------------------------------------------------------------- reconciliation

/** A reflex that ran (or was dropped) on the ear's words, remembered so the slower source does not redo it. */
export interface FiredReflex {
  readonly id: string;
  /** The normalised words it answered. */
  readonly phrase: string;
  readonly reflex: Reflex;
  readonly source: "ear" | "live";
  /** Wall clock: when the app heard the words, when the grammar matched, when the tool was issued, when it answered. */
  readonly earAt: number;
  readonly matchedAt: number;
  readonly dispatchedAt: number;
  doneAt?: number;
  ok?: boolean;
  /** Claimed by a delegation or a transcript utterance already; a second claimant is not "already done". */
  claimed?: boolean;
}

export type Reconciliation =
  /** The words are the fired phrase (normalised, or this alike): the delegation is already done. */
  | { readonly kind: "done"; readonly fired: FiredReflex; readonly similarity: number }
  /**
   * The words END with the fired phrase but say more ("read me the headline scroll
   * down"): the reflex did the tail, the rest is still the brain's. Never "done".
   */
  | { readonly kind: "partial"; readonly fired: FiredReflex; readonly similarity: number }
  /**
   * Same command, materially different words: the reflex acted on something else
   * than Kevin said. `undone` is set by the engine once it has tried to take the
   * action back (⌘Z for a typed text); false means the effect stands and the brain
   * must not repeat the command on top of it.
   */
  | { readonly kind: "mismatch"; readonly fired: FiredReflex; readonly similarity: number; readonly undone?: boolean };

/** Words match when one is the other or they are this alike (edit distance over the longer length). */
export const RECONCILE_THRESHOLD = 0.8;

/**
 * The fired reflexes of the last few seconds, and the question the slower source
 * asks of them: "did the ear already do these words?"
 */
export class FiredReflexes {
  private readonly fired: FiredReflex[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 4000,
  ) {}

  record(f: FiredReflex): void {
    this.prune();
    this.fired.push(f);
    if (this.fired.length > 20) this.fired.splice(0, this.fired.length - 20);
  }

  /** Every fired reflex still within the window, oldest first. */
  recent(): readonly FiredReflex[] {
    this.prune();
    return this.fired;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    while (this.fired.length && (this.fired[0]?.dispatchedAt ?? 0) < cutoff) this.fired.shift();
  }

  /**
   * The unclaimed fired reflex these words are about, if any: "done" when the
   * words match, "partial" when they end with the phrase but say more, "mismatch"
   * when the command is the same but the words differ materially (a different
   * text typed, a different label). **Claims** the match: the caller is taking
   * the reflex as its own, and a second claimant is not "already done".
   */
  reconcile(utterance: string): Reconciliation | undefined {
    const best = this.find(utterance);
    if (best) best.fired.claimed = true;
    return best;
  }

  /**
   * The same question without the claim — for a look ahead of the delegation
   * (the Delegator's prefire check). A peek must never claim: the delegation
   * that follows is the one that has to find the reflex, or it runs it again.
   */
  peek(utterance: string): Reconciliation | undefined {
    return this.find(utterance);
  }

  private find(utterance: string): Reconciliation | undefined {
    this.prune();
    const got = normalizeUtterance(utterance);
    if (!got) return undefined;
    const rank = { done: 3, partial: 2, mismatch: 1 } as const;
    let best: Reconciliation | undefined;
    const better = (c: Reconciliation): boolean => !best || rank[c.kind] > rank[best.kind] || (rank[c.kind] === rank[best.kind] && c.similarity > best.similarity);
    for (const f of this.fired) {
      if (f.claimed) continue;
      const want = f.phrase;
      const sim = got === want ? 1 : similarity(got, want);
      if (sim >= RECONCILE_THRESHOLD) {
        const c: Reconciliation = { kind: "done", fired: f, similarity: sim };
        if (better(c)) best = c;
        continue;
      }
      // Ends with the phrase, whole words, but says more: the reflex did the tail only.
      if (got.endsWith(` ${want}`)) {
        const c: Reconciliation = { kind: "partial", fired: f, similarity: sim };
        if (better(c)) best = c;
        continue;
      }
      // The same head word ("type …", "click …", "open …") with other words after it.
      const head = (s: string): string => s.split(" ")[0] ?? "";
      if (head(got) === head(want) && parseReflex(got)?.kind === f.reflex.kind) {
        const c: Reconciliation = { kind: "mismatch", fired: f, similarity: sim };
        if (better(c)) best = c;
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------- runner

export interface ReflexOutcome {
  readonly reflex: Reflex;
  readonly result: ToolResult;
  /** ms the tool took, as the runner measured it. */
  readonly ms: number;
  /** True when the reflex did what it said; false means the brain should take the task. */
  readonly ok: boolean;
  /** Wall clock when the tool was issued to the runner. */
  readonly dispatchedAt?: number;
}

export interface ReflexRunnerOptions {
  readonly runner: ToolRunner;
  /** The frontmost app, for the pre-checks (the toolset's own gate runs again inside). */
  readonly frontmostApp?: () => Promise<string>;
  /** True when a browser is in front (browser-only reflexes need one). Defaults to a name check on `frontmostApp`. */
  readonly browserInFront?: () => Promise<boolean>;
  readonly now?: () => number;
}

/** Browsers whose shortcuts the tab / reload / back reflexes drive. */
export const BROWSER_APPS = /^(google chrome|google chrome canary|chromium|brave browser|microsoft edge|vivaldi|arc|opera|safari|safari technology preview|firefox|firefox developer edition|zen|orion|dia)$/i;

/**
 * Runs a reflex through the runner. The runner's own gates apply as for any brain
 * call; the click reflex adds a pre-check so a Send/Delete never even starts here,
 * and the browser-only ones check that a browser is in front.
 */
export class ReflexRunner {
  private readonly now: () => number;

  constructor(private readonly opts: ReflexRunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The reflex for an utterance, or undefined. Pure; cheap enough to call on every transcript fragment. */
  match(utterance: string): Reflex | undefined {
    return parseReflex(utterance);
  }

  private async frontmost(): Promise<string> {
    return (await this.opts.frontmostApp?.().catch(() => "")) ?? "";
  }

  async run(reflex: Reflex): Promise<ReflexOutcome> {
    const notReflex = (why: string): ReflexOutcome => {
      log.info(`reflex "${reflex.label}" left to the brain: ${why}`);
      return { reflex, result: { kind: "error", message: `not a reflex: ${why}` }, ms: 0, ok: false };
    };
    if (reflex.browserOnly) {
      const inFront = this.opts.browserInFront ? await this.opts.browserInFront().catch(() => false) : BROWSER_APPS.test(await this.frontmost());
      if (!inFront) return notReflex("no browser in front");
    }
    if (reflex.kind === "click" || reflex.kind === "double_click") {
      const target = String(reflex.input["name"] ?? "");
      const app = await this.frontmost();
      const decision = classifyAction({ kind: "left_click", app, target });
      if (decision.verdict !== "run" || HANDS_OFF_APPS.test(app)) return notReflex(decision.reason);
    }
    if (reflex.kind === "go_to") {
      // A browser in front navigates its tab; otherwise the default browser opens the address.
      const app = await this.frontmost();
      const dispatchedAt = this.now();
      const outcome = BROWSER_APPS.test(app) ? await this.opts.runner.run("browser_navigate", { url: reflex.input["url"], app }) : await this.opts.runner.run("open_url", { url: reflex.input["url"] });
      const ok = outcome.result.kind !== "error";
      if (!ok) log.info(`reflex "${reflex.label}" failed (${(outcome.result as { message: string }).message}); the brain takes it`);
      return { reflex, result: outcome.result, ms: outcome.ms, ok, dispatchedAt };
    }
    const dispatchedAt = this.now();
    const outcome = await this.opts.runner.run(reflex.tool, reflex.input);
    const r = outcome.result;
    // A confirmation question is not a failure — the runner recorded the handshake;
    // the delegator relays the question. An error means the brain takes over.
    const ok = r.kind !== "error";
    if (!ok) log.info(`reflex "${reflex.label}" failed (${r.message}); the brain takes it`);
    return { reflex, result: r, ms: outcome.ms, ok, dispatchedAt };
  }
}
