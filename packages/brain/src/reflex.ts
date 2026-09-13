import { HANDS_OFF_APPS, classifyAction, classifyAppleScript, logger } from "@jarhead/core";
import { ACTING_MEMBERS, type ToolResult } from "@jarhead/hands";
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
 * the wake word, the fillers and politeness are stripped), so "scroll down to the
 * footer and click save" is the brain's, and "click <text>" first asks the policy
 * whether a control with that name may be clicked without a question — a Send or a
 * Delete is left to the brain, which knows how to ask. `parseReflexTail` is the one
 * relaxation, for the way Kevin actually talks (0 of 119 production requests parsed
 * whole; his utterances start with "um", "yeah," and end with the command): the LAST
 * clause alone, and only for a kind that is harmless to repeat.
 *
 * Meta rows (`meta: true`) act on Jarhead, not the Mac: the thread verbs ("what is
 * Spotify doing", "stop the Slack one") are answered from the engine's thread table
 * and "what time is it" from the clock — zero generations, never held while a task
 * runs, spoken from the result. Their names come from the caller (`ctx.threadNames`,
 * the LIVE threads), never a static list.
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
  | "dictate_stop"
  | "search"
  | "sleep"
  /** Play / pause / next / previous / volume by Apple event to the music app (background-safe; policy must say run). */
  | "media"
  /** Minimise, hide, full screen: a shortcut with an obvious inverse. */
  | "window"
  /** Jarhead answers from what it knows (the clock); no tool. */
  | "say"
  | "thread_status"
  | "thread_list"
  | "thread_stop"
  | "thread_pause"
  | "thread_resume";

/** What the caller knows that the grammar does not: the live thread names, the clock. */
export interface ReflexContext {
  /** The LIVE threads' names from the table; the thread verbs match only these. Absent or empty: no thread verb parses. */
  readonly threadNames?: readonly string[] | undefined;
  /** The clock for "what time is it" (default Date.now). */
  readonly now?: (() => number) | undefined;
}

/** One tool call of an ordered batch, and what it did once it ran ("focused Safari", "clicked the search field"). */
export interface ReflexStep {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly did: string;
}

export interface Reflex {
  readonly kind: ReflexKind;
  /** The tool to run and its input. Engine-level kinds (circle, dictation) name a pseudo tool the engine handles itself. */
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /**
   * An ordered batch instead of one call: run in order through the runner, stopping
   * at the first needs-confirmation, refusal or error, and the outcome says how far
   * it got. A kind whose steps depend on what is in front (search) plans them at run
   * time; `tool` / `input` then only name the plan.
   */
  readonly steps?: readonly ReflexStep[];
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
  /**
   * About Jarhead, not the Mac (a thread's status, a stop by name, the time): answered
   * by the engine from what it knows, never held while a task runs, and the RESULT text
   * is what the voice says (`said` is empty until then).
   */
  readonly meta?: boolean;
}

/** Wake words and politeness that may wrap a command without changing it. */
const WAKE = /^(?:(?:hey|ok|okay|yo)[,\s]+)?(?:jarhead|jar head|jarred|jared|jar-head)[,.!\s]*/i;
const POLITE_HEAD = /^(?:(?:please|now|just|can you|could you|would you|go ahead and|and|then|okay|ok)[,\s]+)+/i;
const POLITE_TAIL = /(?:[,\s]+(?:please|now|for me|thanks|thank you|jarhead|jar head))+$/i;
/**
 * What Kevin's utterances start with before the command (heard rows, 09-10..12: "um",
 * "oh", "yeah,", "awesome.", "[chuckle]") — the ear's list and a few more; exported so
 * the ear and the `reflex-miss` miner strip the same words (one list, not three). Each
 * needs a separator after it AND words after that, so a bare "yes", "okay" or "okay."
 * is left whole for the yes gate (a lone filler is not a head, it is the utterance).
 * Not "right": "right click save" is a command of its own, and stripping the word would
 * turn it into a left click. The ear's stop test reads through `normalizeUtterance`, so
 * this list is also what may precede a stop word: "oh stop", "actually, cancel" cut
 * (pinned in reflex-grammar.test.ts as a decision, not a side effect).
 */
export const FILLER_HEAD = /^(?:(?:um+|uh+|erm|hmm+|so|like|okay|ok|alright|all right|hey|yeah|yes|yep|oh|awesome|great|nice|cool|well|basically|actually|anyway)[,.!\s]+)+(?=\S)/i;
/** Transcriber tags in the words ("[chuckle]", "(laughs)"): never part of a command. */
const TAGS = /\s*[[(](?:chuckles?|laughs?|laughter|sighs?|coughs?|inaudible|pause|music|noise|clears throat|crosstalk)[\])]\s*/gi;

/** The head of an utterance stripped: tags, fillers, the wake word, fillers again ("jarhead, um, scroll down"), politeness. Case kept. */
function stripHead(text: string): string {
  let t = text.replace(TAGS, " ").trim().replace(/\s+/g, " ");
  // Fillers, the wake word and politeness come in any order ("alright then, um, jarhead, please …"): peel until nothing peels.
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(FILLER_HEAD, "").replace(WAKE, "").replace(POLITE_HEAD, "");
    if (t === before) break;
  }
  return t;
}

/** The utterance with the wake word, fillers, politeness, and punctuation removed; lowercase. */
export function normalizeUtterance(text: string): string {
  let t = stripHead(text);
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
/**
 * The dismissals (Kevin's request 2: "go to sleep or shut off or things like that are
 * cues to return to dock and go to sleep"). The whole utterance, anchored, so a
 * negation ("don't go to sleep"), a trailing clause ("turn yourself off after this",
 * "that is all wrong") or an object ("shut down my Mac", "turn off the lights") never
 * matches. Bare "shut down", "sleep", "night" and "stop" are not cues: "stop" is the
 * interrupt, the others are too common in room talk. Judged BEFORE the OPEN row —
 * at f6c3b40 "go to sleep" read as `open_app Sleep` and "go to bed" as `open_app Bed`.
 */
const SLEEP = /^(?:go (?:back )?to (?:sleep|bed)|back to sleep|sleep now|shut off|shut yourself (?:off|down)|turn (?:yourself|your self) off|power (?:down|off)|good ?night(?: night)?|night night|that(?:'s| is| will be|'ll be) all(?: for (?:now|today|tonight))?|that'?s it for (?:now|today|tonight)|(?:you(?:'re| are) )?dismissed|you (?:can|may) rest(?: now)?|stand down|go dormant)$/;
/** The politeness tail without "now": "sleep now" is a cue only with its "now", which `normalizeUtterance` strips. */
const POLITE_TAIL_KEEP_NOW = /(?:[,\s]+(?:please|for me|thanks|thank you|jarhead|jar head))+$/i;

/** Whether the utterance is a dismissal: the normalised words, or the same with a trailing "now" kept. */
function isSleepCue(utterance: string, normalized: string): boolean {
  const fold = (s: string): string => s.replace(/[’‘]/g, "'");
  if (SLEEP.test(fold(normalized))) return true;
  const keptNow = fold(stripHead(utterance).replace(/[.!?,;:]+$/g, "").replace(POLITE_TAIL_KEEP_NOW, "").replace(/[.!?,;:]+$/g, "").trim().toLowerCase());
  return SLEEP.test(keptNow);
}
/** Minimise / hide: ⌘M and ⌘H, each with an obvious inverse (the Dock, a click on the app). */
const MINIMISE = /^(?:minimi[sz]e (?:this|the|that|the current) window|minimi[sz]e (?:it|this))$/;
const HIDE = /^hide (?:this|the|that|the current) (?:window|app)$/;
/** Full screen is a toggle (⌃⌘F), said either way. */
const FULL_SCREEN = /^(?:(?:enter |go |make it |toggle |make this |put (?:this|it) in )?full ?screen|(?:exit|leave) full ?screen)$/;
/** The clock: Jarhead answers, no tool, never a generation. */
const TIME = /^(?:what time is it(?: now| right now)?|what(?:'s| is) the time(?: now)?|do you have the time|got the time|time check)$/;
const DATE = /^(?:what(?:'s| is) (?:the|today's) date(?: today)?|what day is it(?: today)?|what(?:'s| is) today(?:'s date)?|what day of the week is it)$/;
/**
 * Media by Apple event to the music app: play / pause are idempotent, next / previous
 * and the volume steps have an inverse; nothing here touches the pointer or the
 * keyboard (not FOCUS_APPLESCRIPT), so a background thread could run them too. The
 * ear fires these with no wake word, so a ONE-WORD row is room talk that pauses the
 * music: bare "play" and "pause" are the two DECISIONS names and stay; bare "next",
 * "previous", "skip", "resume", "unpause", "louder", "quieter", "softer" are out — the
 * two-word forms ("skip this song", "resume the music", "volume up") carry them. "stop
 * the music" is left out on purpose: "stop" is the interrupt, whatever follows it.
 */
const MEDIA_PLAY = /^(?:play|play (?:the )?music|resume (?:the )?music|resume playback|unpause (?:the )?music|play it again|keep playing)(?: (?:on|in) (?:spotify|apple music|music))?$/;
const MEDIA_PAUSE = /^(?:pause|pause (?:the |this )?(?:music|song|track|playback)|pause it|pause (?:spotify|apple music|music))$/;
const MEDIA_NEXT = /^(?:skip (?:this|that|the|it)(?: (?:song|track))?|skip (?:the )?(?:song|track)|next (?:song|track)|play (?:the )?next (?:song|track)|skip (?:ahead|forward))$/;
const MEDIA_PREV = /^(?:previous (?:song|track)|last (?:song|track)|go back a (?:song|track)|play (?:the )?(?:previous|last) (?:song|track)|play that again|start (?:this|the) (?:song|track) (?:over|again))$/;
const MEDIA_VOLUME = /^(?:turn (?:the )?(?:volume|music|sound) (up|down)|volume (up|down)|(?:make it|a bit|a little) (louder)|(?:make it|a bit|a little) (quieter|softer)|(lower the volume|turn it down a bit))$/;
const MEDIA_MUTE = /^(mute|unmute) (?:the )?(?:music|spotify|sound|audio|volume|mac|speakers)$/;
const MEDIA_APPLE_MUSIC = /\b(?:apple music|music app|itunes)\b/;

/** The music app a media row drives: Apple Music only when named; Spotify otherwise (Kevin's). */
function mediaApp(normalized: string): "Spotify" | "Music" {
  return MEDIA_APPLE_MUSIC.test(normalized) ? "Music" : "Spotify";
}

/** `tell application "X" to <verb>` — only when the app is running: an Apple event to a closed app would launch it. */
function mediaScript(app: string, verb: string): string {
  return `if application "${app}" is running then tell application "${app}" to ${verb}`;
}

/**
 * A media row, or undefined: the utterance must be one of the media phrases whole AND the
 * policy must say `run` for the script — a confirm or a refuse drops the reflex here (the
 * brain path asks; a reflex never does).
 */
function parseMedia(t: string): Reflex | undefined {
  const app = mediaApp(t);
  let m: RegExpExecArray | null;
  const row = (verb: string, said: string, label: string, idempotent: boolean): Reflex | undefined => {
    const script = mediaScript(app, verb);
    if (classifyAppleScript({ script }).verdict !== "run") return undefined;
    return { kind: "media", tool: "applescript", input: { script }, said, label: `${label} (${app})`, prefire: false, idempotent };
  };
  if (MEDIA_PLAY.test(t)) return row("play", "playing.", "media play", true);
  if (MEDIA_PAUSE.test(t)) return row("pause", "paused.", "media pause", true);
  if (MEDIA_NEXT.test(t)) return row("next track", "next track.", "media next", false);
  if (MEDIA_PREV.test(t)) return row("previous track", "previous track.", "media previous", false);
  if ((m = MEDIA_VOLUME.exec(t))) {
    const up = m[1] === "up" || m[2] === "up" || m[3] !== undefined;
    return row(`set sound volume to (sound volume ${up ? "+" : "-"} 10)`, up ? "louder." : "quieter.", `media volume ${up ? "up" : "down"}`, false);
  }
  if ((m = MEDIA_MUTE.exec(t))) {
    const mute = m[1] === "mute";
    const script = `set volume output muted ${mute}`;
    if (classifyAppleScript({ script }).verdict !== "run") return undefined;
    return { kind: "media", tool: "applescript", input: { script }, said: mute ? "muted." : "unmuted.", label: mute ? "mute" : "unmute", prefire: false, idempotent: true };
  }
  return undefined;
}

/** "it's 4:52 pm." / "it's Saturday, September 13." from the clock, in Kevin's local time. */
function clockLine(kind: "time" | "date", nowMs: number): string {
  const d = new Date(nowMs);
  if (kind === "time") return `it's ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M$/i, (_s, ap: string) => ` ${ap.toLowerCase()}m`)}.`;
  return `it's ${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** `(?: (?:one|thread|hand|worker))?` — how Kevin may refer to a thread by its name. */
const THREAD_TAIL = "(?: (?:one|thread|hand|worker))?";
const THREAD_LIST = /^(?:what(?:'s| is) running|what are you (?:doing|working on|up to)(?: (?:right )?now)?|how many things are (?:running|going)|status|status report|what(?:'s| is) going on|what are the threads doing|list (?:the )?threads|what(?:'s| is) everyone doing)$/;

/**
 * The thread verbs, matched against the LIVE names the caller supplies: a status
 * question, a stop / pause / resume by name. Every row is meta (answered from the
 * table by the engine, spoken from the result), idempotent, never prefired. "stop"
 * alone is not here — it is the interrupt; "stop <live name>" is that thread's.
 */
function parseThreadVerb(t: string, utterance: string, ctx: ReflexContext | undefined): Reflex | undefined {
  const names = (ctx?.threadNames ?? []).map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (ctx?.threadNames !== undefined && THREAD_LIST.test(t) && (names.length > 0 || addressesJarhead(utterance))) {
    return { kind: "thread_list", tool: "thread_list", input: {}, said: "", label: "thread list", prefire: false, idempotent: true, meta: true };
  }
  if (names.length === 0) return undefined;
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n] as const));
  const alt = `(${[...byLower.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`;
  const rows: ReadonlyArray<readonly [ReflexKind, RegExp, string]> = [
    // "… right now" loses its "now" to the politeness tail before the grammar sees it: "right" alone is accepted too.
    ["thread_status", new RegExp(`^(?:what(?:'s| is) (?:the )?${alt}${THREAD_TAIL} (?:doing|up to|on|working on)(?: right now| now| right)?)$`), "status of"],
    ["thread_status", new RegExp(`^(?:how(?:'s| is) (?:the )?${alt}${THREAD_TAIL} (?:doing|going|coming along|getting on))$`), "status of"],
    ["thread_status", new RegExp(`^(?:is (?:the )?${alt}${THREAD_TAIL} (?:done|finished|done yet|finished yet|still (?:going|working|running|busy)))$`), "status of"],
    ["thread_status", new RegExp(`^(?:where(?:'s| is) (?:the )?${alt}${THREAD_TAIL}(?: at)?)$`), "status of"],
    ["thread_stop", new RegExp(`^(?:stop|cancel|kill|end) (?:the )?${alt}${THREAD_TAIL}$`), "stop"],
    ["thread_pause", new RegExp(`^(?:pause|hold) (?:the )?${alt}${THREAD_TAIL}$`), "pause"],
    ["thread_resume", new RegExp(`^(?:resume|continue|carry on|go on|unpause)(?: with)? (?:the )?${alt}${THREAD_TAIL}$`), "resume"],
  ];
  for (const [kind, re, verb] of rows) {
    const m = re.exec(t);
    if (!m) continue;
    const name = byLower.get((m[1] ?? "").toLowerCase());
    if (!name) continue;
    return { kind, tool: kind, input: { name }, said: "", label: `${verb} ${name}`, prefire: false, idempotent: true, meta: true };
  }
  return undefined;
}
/** At most four words: a control's name, not a description of where to find it. */
const CLICK = /^(?:click|press|tap|hit)(?: on)?(?: the)? ([a-z0-9][a-z0-9.&'-]*(?: [a-z0-9.&'-]+){0,3}?)(?: (?:button|link|tab|checkbox|menu|icon))?$/;
const DOUBLE_CLICK = /^double[- ]?click(?: on)?(?: the)? ([a-z0-9][a-z0-9.&'-]*(?: [a-z0-9.&'-]+){0,3}?)(?: (?:button|link|tab|checkbox|menu|icon|file|folder))?$/;
/**
 * "search <where> for <what>" / "search for <what> in|on <where>" / "look up <what>
 * in|on <where>" / "find <what> in|on <where>". <where> is an app, a site the front
 * browser tab shows, or "this page" / "here"; <what> is free text (≤ 80 chars, one
 * line). Case-insensitive so `<what>` keeps Kevin's own capitalisation from Live's
 * transcript (the ear's is lowercase anyway). Form A splits at the FIRST " for " (the
 * where comes first and is short); form B takes the LAST " in " / " on " (the what
 * may itself say "coffee in seattle").
 */
const SEARCH_WHERE = `((?:the |my )?[a-z0-9][a-z0-9.'-]*(?: [a-z0-9.'-]+){0,2})`;
const SEARCH_A = new RegExp(`^search (?:in |on |through |inside |within )?${SEARCH_WHERE} for (.+)$`, "i");
const SEARCH_B = new RegExp(`^(?:search for|look ?up|find|search) (.+) (?:in|on) ${SEARCH_WHERE}$`, "i");
/** "this page" / "here": a find-in-page in whatever is in front. */
const SEARCH_HERE = /^(?:this|the|the current) (?:page|tab|window|document|doc|file)$|^here$/;
/** A query that is a stand-in for something Kevin is looking at, not words to type. */
const SEARCH_NOT_A_QUERY = /^(?:it|that|this|those|these|them|him|her|the thing|the same|the same thing|what i (?:said|copied|mentioned))$/i;
/**
 * A query that carries a second instruction ("design and then open the first result",
 * "design, then read me the headline"): the words after the marker are a task, not
 * text to type, and a reflex that typed them all would drop the task silently (the
 * delegation reconciles as "already done"). The whole sentence is the brain's.
 */
const SEARCH_COMPOUND = /(?:^|[\s,;])(?:and then|then|after that|afterwards|next|and (?:open|read|click|tell|show|copy|paste|scroll|press|type|send|close|play|take|go|find|search|select|pick|summari[sz]e|give|get|put|make|check|see)\b)/i;
/** "find out what time it is …": "out" is not a word to type. */
const SEARCH_FIND_OUT = /^out\b/i;
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

/**
 * A spoken address: "github.com", "github.com/kevin", "localhost:3000", "https://…".
 * Words with a space in them are never one address: at 2633faf "go to github.com.
 * jarhead scroll down" collapsed into `https://github.com.jarheadscrolldown/` — a real
 * navigation to a garbage host. Refused here, the whole does not parse and the tail
 * ("jarhead scroll down") is the reflex.
 */
function urlOf(raw: string): string | undefined {
  // "localhost 3000" / "localhost port 3000" is an address with a port.
  const s = spokenDots(raw.trim()).replace(/^localhost(?: port)? (\d{2,5})$/, "localhost:$1").replace(/\/+$/, "");
  if (/\s/.test(s)) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return `http://${s}/`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s)) return `https://${s}${/\//.test(s.split(/[?#]/)[0] ?? "") ? "" : "/"}`;
  return undefined;
}

/**
 * The apps a bare "open X" may name: a single capitalised word or two, not a sentence.
 * "sleep" and "bed" never name one: the bare forms are the dismissal's (SLEEP), and a
 * longer "go to sleep mode" / "go to bed early" is the brain's, not a phantom app.
 */
function appName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.split(" ").length > 3) return undefined;
  if (/\b(the|a|my|file|folder|door|window|tab|link|page|it|this|that|website|site|url|settings|sleep|bed)\b/.test(name)) return undefined;
  if (/[/:]/.test(name)) return undefined;
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

const key = (kind: ReflexKind, combo: string, said: string, label: string, extra: Partial<Reflex> = {}): Reflex => ({ kind, tool: "key", input: { text: combo }, said, label, prefire: false, idempotent: false, ...extra });

/** Parse one utterance; undefined when it is not a whole, unambiguous one-step command. `ctx` carries the live thread names and the clock. */
export function parseReflex(utterance: string, ctx?: ReflexContext): Reflex | undefined {
  const t = normalizeUtterance(utterance);
  if (!t || t.length > 120) return undefined;
  let m: RegExpExecArray | null;
  // Dictation first: "stop dictating" must never read as a stop or a "dictating" of anything.
  if (DICTATE_START.test(t)) return { kind: "dictate_start", tool: "dictate", input: { on: true }, said: "dictating.", label: "start dictating", prefire: false, idempotent: true };
  if (DICTATE_STOP.test(t)) return { kind: "dictate_stop", tool: "dictate", input: { on: false }, said: "done dictating.", label: "stop dictating", prefire: false, idempotent: true };
  // The dismissal, before OPEN takes "go to sleep" for an app. Never a tool: `ReflexRunner.match`
  // leaves it out and the ear / the Delegator hand the phrase to the engine's one sleep function.
  if (isSleepCue(utterance, t)) return { kind: "sleep", tool: "sleep", input: { phrase: utterance.trim().replace(/\s+/g, " ") }, said: "night.", label: "go to sleep", prefire: false, idempotent: true };
  // The thread verbs, before anything else could take a live name ("pause spotify" is the
  // Spotify thread's while one is live; the music row's otherwise).
  {
    const thread = parseThreadVerb(t, utterance, ctx);
    if (thread) return thread;
  }
  if (TIME.test(t) || DATE.test(t)) {
    const text = clockLine(TIME.test(t) ? "time" : "date", (ctx?.now ?? Date.now)());
    return { kind: "say", tool: "say", input: { text }, said: text, label: TIME.test(t) ? "what time is it" : "what is the date", prefire: false, idempotent: true, meta: true };
  }
  {
    const media = parseMedia(t);
    if (media) return media;
  }
  if (MINIMISE.test(t)) return key("window", "cmd+m", "minimised.", "minimise window");
  if (HIDE.test(t)) return key("window", "cmd+h", "hidden.", "hide app");
  if (FULL_SCREEN.test(t)) return key("window", "ctrl+cmd+f", /^(?:exit|leave)/.test(t) ? "left full screen." : "full screen.", "full screen");
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
    const text = stripHead(utterance).replace(/^(?:type|write)\s+/i, "").replace(/[.!?,;:]+$/, "").replace(POLITE_TAIL, "").replace(/[.!?,;:]+$/, "").trim();
    if (!text || text.length > 200 || DESCRIBES.test(text.toLowerCase())) return undefined;
    return { kind: "type", tool: "type", input: { text }, said: `typed "${text.slice(0, 40)}".`, label: `type ${text.slice(0, 40)}`, prefire: false, idempotent: false };
  }
  if ((m = DOUBLE_CLICK.exec(t))) {
    const target = (m[1] ?? "").trim();
    if (!target || NOT_A_LABEL.test(target) || !isLabel(target, t)) return undefined;
    return { kind: "double_click", tool: "click_element", input: { name: target, count: 2 }, said: `double-clicked ${target}.`, label: `double-click ${target}`, prefire: false, idempotent: false };
  }
  {
    const search = parseSearch(utterance, t);
    if (search) return search;
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
 * The kinds a last clause may run on its own: harmless to repeat, or with an obvious
 * inverse, and never words to type or a control to click (the brain judges those whole).
 */
export const TAIL_KINDS: ReadonlySet<ReflexKind> = new Set<ReflexKind>(["scroll", "page", "screenshot", "circle", "zoom", "tab", "reload", "back", "forward", "open_app", "go_to", "media", "window", "say", "thread_status", "thread_list", "thread_stop", "thread_pause", "thread_resume"]);

/** Where a last clause may start: after a sentence's end, after "then" / "and then" / "after that", or at a wake word inside the words. */
const CLAUSE_END = /[.!?;…]+["')\]]?\s+/g;
const THEN_MARKER = /,?\s+(?:and then|then|after that|and now|now)\s+/gi;
const WAKE_INSIDE = /\b(?:hey\s+)?(?:jarhead|jar head|jarred|jared|jar-head)\b/gi;

/**
 * When the whole utterance is not a command, its LAST clause may be one: "yeah okay.
 * jarhead, scroll down" → scroll; "um so read me the headline, then page down" → page.
 * Only for TAIL_KINDS ("… then type hello" is the brain's). Returns the reflex with the
 * head it leaves to the brain, or undefined. The caller decides whether the words were
 * addressed to Jarhead (the wake word in the tail, or mid-exchange) before running it.
 */
export function parseReflexTail(utterance: string, ctx?: ReflexContext): { readonly reflex: Reflex; readonly head: string; readonly tail: string } | undefined {
  const text = utterance.replace(TAGS, " ").replace(/\s+/g, " ").trim();
  if (!text || parseReflex(text, ctx)) return undefined;
  // Each candidate: where the tail starts, and where the head ends (a sentence keeps its full stop; a "then" is nobody's).
  const last = (re: RegExp, headKeepsMatch: boolean): { tailAt: number; headEnd: number } | undefined => {
    let found: { tailAt: number; headEnd: number } | undefined;
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || m.index === 0) continue;
      const end = m.index + m[0].length;
      found = { tailAt: re === WAKE_INSIDE ? m.index : end, headEnd: headKeepsMatch ? end : m.index };
    }
    return found;
  };
  for (const c of [last(CLAUSE_END, true), last(THEN_MARKER, false), last(WAKE_INSIDE, false)]) {
    if (!c || c.tailAt >= text.length) continue;
    const tail = text.slice(c.tailAt).trim();
    if (!tail || tail.length >= text.length) continue;
    const reflex = parseReflex(tail, ctx);
    if (!reflex || !TAIL_KINDS.has(reflex.kind)) continue;
    return { reflex, head: text.slice(0, c.headEnd).trim().replace(/[,;]+$/, ""), tail };
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

// ------------------------------------------------------------------- search

/**
 * "search the wiki for design": a multi-step reflex. `where` is normalised (no
 * leading "the" / "my", lowercase); `what` keeps Kevin's case from the raw words.
 * The steps are planned when it runs (what is in front decides): see `ReflexRunner`.
 */
function parseSearch(utterance: string, normalized: string): Reflex | undefined {
  if (!/^(?:search|look ?up|find)\b/.test(normalized)) return undefined;
  // The same stripping `normalizeUtterance` does, case kept, so `what` is typed as Kevin said it.
  const raw = stripHead(utterance)
    .replace(/[.!?,;:]+$/g, "")
    .replace(POLITE_TAIL, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  let where: string;
  let what: string;
  let formB = false;
  let m = SEARCH_A.exec(raw);
  if (m) {
    where = m[1] ?? "";
    what = m[2] ?? "";
  } else if ((m = SEARCH_B.exec(raw))) {
    what = m[1] ?? "";
    where = m[2] ?? "";
    formB = true;
  } else return undefined;
  const whereSaid = where.trim().toLowerCase().replace(/\s+/g, " ");
  where = whereSaid.replace(/^(?:the|my) /, "");
  what = what.trim();
  // Quoted words are words: 'search for "the best coffee in seattle" on google' is literal.
  const quoted = /^["'“‘].+["'”’]$/.test(what);
  what = what.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (!where || !what || what.length > 80 || /[\r\n]/.test(what) || SEARCH_NOT_A_QUERY.test(what)) return undefined;
  // A second instruction after the query is a task for the brain, never text to type.
  if (!quoted && SEARCH_COMPOUND.test(what)) return undefined;
  // "search for X in it" / "find X in that": a place Kevin is looking at, not a name.
  if (/^(?:it|that|this|them|there)$/.test(where)) return undefined;
  const here = SEARCH_HERE.test(whereSaid) || SEARCH_HERE.test(where);
  if (formB && !quoted) {
    // "find <what> in <where>" is also how people describe things ("find the bug in the code",
    // "find out what time it is in tokyo", "search for a new job in seattle"): the place must be
    // one the reflex knows by name, and the words must be words to type, not a description.
    if (!here && !(where in SEARCH_APPS) && !(where in SEARCH_SITES)) return undefined;
    if (DESCRIBES.test(what.toLowerCase()) || SEARCH_FIND_OUT.test(what)) return undefined;
  }
  return {
    kind: "search",
    tool: "search",
    input: { where, what, here },
    said: `searched ${here ? "this page" : whereSaid} for "${what.slice(0, 60)}".`,
    label: `search ${here ? "this page" : where} for ${what.slice(0, 40)}`,
    prefire: false,
    idempotent: false,
  };
}

/** A keyboard shortcut that puts the cursor in an app's or a site's search field; `submit` says whether Return runs the search or would open the first result. */
export interface SearchShortcut {
  readonly combo: string;
  readonly submit: boolean;
  /** Where the words land ("the address bar"), for the report. */
  readonly what: string;
}

/** What Kevin calls an app → its name as macOS shows it (frontmost / focus_app compare on it). */
export const SEARCH_APPS: Readonly<Record<string, string>> = {
  safari: "Safari",
  chrome: "Google Chrome",
  "google chrome": "Google Chrome",
  arc: "Arc",
  firefox: "Firefox",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
  finder: "Finder",
  notion: "Notion",
  slack: "Slack",
  cursor: "Cursor",
  code: "Visual Studio Code",
  vscode: "Visual Studio Code",
  "vs code": "Visual Studio Code",
  "visual studio code": "Visual Studio Code",
  xcode: "Xcode",
  notes: "Notes",
  mail: "Mail",
  messages: "Messages",
  spotify: "Spotify",
  terminal: "Terminal",
  discord: "Discord",
  linear: "Linear",
  figma: "Figma",
  obsidian: "Obsidian",
  calendar: "Calendar",
  reminders: "Reminders",
  photos: "Photos",
  music: "Music",
  "app store": "App Store",
};

/**
 * Site words → what the browser window's title carries when the front tab is on that
 * site. A search reflex never navigates: a site the front tab is not on is the brain's.
 */
export const SEARCH_SITES: Readonly<Record<string, readonly string[]>> = {
  wiki: ["wiki"],
  google: ["google"],
  gmail: ["gmail"],
  youtube: ["youtube"],
  github: ["github"],
  twitter: ["twitter", "/ x"],
  x: ["/ x", "x.com"],
  reddit: ["reddit"],
  "hacker news": ["hacker news"],
  wikipedia: ["wikipedia"],
  amazon: ["amazon"],
  netflix: ["netflix"],
  chatgpt: ["chatgpt"],
  claude: ["claude"],
  linkedin: ["linkedin"],
  vercel: ["vercel"],
  notion: ["notion"],
  slack: ["slack"],
  linear: ["linear"],
  figma: ["figma"],
  discord: ["discord"],
  spotify: ["spotify"],
  "google docs": ["google docs"],
  "google drive": ["google drive"],
  "stack overflow": ["stack overflow"],
  npm: ["npm"],
  maps: ["google maps"],
  "google maps": ["google maps"],
};

/** The shortcut that focuses an app's own search, by the app's lowercase name; browsers get the address bar. */
export const APP_SEARCH_SHORTCUTS: Readonly<Record<string, SearchShortcut>> = {
  finder: { combo: "cmd+f", submit: true, what: "the Finder search field" },
  notion: { combo: "cmd+k", submit: false, what: "Notion's quick find" },
  slack: { combo: "cmd+g", submit: true, what: "Slack's search" },
  "visual studio code": { combo: "cmd+shift+f", submit: false, what: "the search across files" },
  cursor: { combo: "cmd+shift+f", submit: false, what: "the search across files" },
  xcode: { combo: "cmd+shift+f", submit: true, what: "find in workspace" },
  notes: { combo: "cmd+alt+f", submit: false, what: "the Notes search field" },
  mail: { combo: "cmd+alt+f", submit: true, what: "the Mail search field" },
  terminal: { combo: "cmd+f", submit: true, what: "find" },
  obsidian: { combo: "cmd+shift+f", submit: false, what: "the search in all files" },
  linear: { combo: "cmd+k", submit: false, what: "Linear's command palette" },
  spotify: { combo: "cmd+k", submit: false, what: "Spotify's search" },
};
const ADDRESS_BAR: SearchShortcut = { combo: "cmd+l", submit: true, what: "the address bar" };
/** On these sites a bare "/" focuses the search box. */
export const SITE_SEARCH_SHORTCUTS: Readonly<Record<string, SearchShortcut>> = {
  github: { combo: "/", submit: true, what: "GitHub's search" },
  google: { combo: "/", submit: true, what: "Google's search box" },
  youtube: { combo: "/", submit: true, what: "YouTube's search" },
  twitter: { combo: "/", submit: true, what: "the search on X" },
  x: { combo: "/", submit: true, what: "the search on X" },
};
export const FIND_IN_PAGE: SearchShortcut = { combo: "cmd+f", submit: true, what: "find in page" };

/** The window title names the site (whole word, case folded): "kevin/jarhead · GitHub", "cats - YouTube", "Home / X". */
export function titleMentions(title: string, words: readonly string[]): boolean {
  const t = ` ${title.toLowerCase().replace(/\s+/g, " ")} `;
  return words.some((w) => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:[^a-z0-9]|$)`).test(t));
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
  readonly source: "ear" | "live" | "typed";
  /** Wall clock: when the app heard the words, when the grammar matched, when the tool was issued, when it answered. */
  readonly earAt: number;
  readonly matchedAt: number;
  readonly dispatchedAt: number;
  doneAt?: number;
  ok?: boolean;
  /** What a multi-step reflex did, in words ("typed “design” into the search field of Safari and pressed Return"). */
  did?: string;
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
  /** Wall clock when the tool was issued to the runner (a batch: its first acting step). */
  readonly dispatchedAt?: number;
  /**
   * A batch's account of itself: what was done ("focused Notion; clicked the search
   * field; typed “design”; pressed Return"), or how far it got and where it stopped
   * ("did 2 steps (…); stopped at type: refused: …"). Reconciliation carries it so the
   * brain's delegation for the same words is finished without redoing any of it.
   */
  readonly did?: string;
  /** Steps run / steps planned, for a batch. */
  readonly progress?: { readonly done: number; readonly total: number };
  /**
   * Two callers got this outcome: a run of the same words joined the one in flight
   * (the ear's batch and Live's delegation for the same sentence). A question this
   * outcome asks belongs to both — the ear must not clear the pending confirmation
   * it would otherwise drop, because the delegation is about to relay it.
   */
  readonly shared?: boolean;
}

export interface ReflexRunnerOptions {
  readonly runner: ToolRunner;
  /** The frontmost app, for the pre-checks (the toolset's own gate runs again inside). */
  readonly frontmostApp?: () => Promise<string>;
  /** True when a browser is in front (browser-only reflexes need one). Defaults to a name check on `frontmostApp`. */
  readonly browserInFront?: () => Promise<boolean>;
  readonly now?: () => number;
  /** The LIVE threads' names from the engine's table, read per match; absent, no thread verb parses. */
  readonly threadNames?: (() => readonly string[]) | undefined;
  /**
   * The engine's answer for a meta reflex that names a pseudo tool (thread_status,
   * thread_list, thread_stop, thread_pause, thread_resume): from the table, no
   * hands, no generation. Absent, the pseudo tool goes to the runner and is refused as
   * unknown — the brain takes the words as today.
   */
  readonly meta?: ((reflex: Reflex) => Promise<ToolResult> | ToolResult) | undefined;
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
  /**
   * Multi-step reflexes in flight, by label. The ear fires a search ~450 ms after the
   * words and its batch runs for a few hundred ms; Live's delegation for the same words
   * can land in the middle and would run the batch again (typing the query twice).
   * A second run of the same label while one is in flight joins it.
   */
  private readonly inflight = new Map<string, { readonly promise: Promise<ReflexOutcome>; joined: boolean }>();
  /**
   * Multi-step reflexes that failed a moment ago, by label: the slower source asks for
   * the same words within seconds and gets the same answer — with what was found — at
   * once, instead of a second walk of the same window and the same refusal.
   */
  private readonly failures = new Map<string, { at: number; outcome: ReflexOutcome }>();
  static readonly FAILURE_HOLD_MS = 4000;

  /**
   * The key the join and the failure memory use. Case folded: the ear's partials are
   * lowercase and Live's transcript capitalises ("Design", "GitHub"), and the two must
   * meet on the same key or the query is typed twice.
   */
  private static batchKey(reflex: Reflex): string {
    return `${reflex.kind}:${reflex.label.toLowerCase()}`;
  }

  constructor(private readonly opts: ReflexRunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * The reflex for an utterance, or undefined. Pure; cheap enough to call on every
   * transcript fragment. A sleep cue is not a reflex to run: `parseReflex` still parses
   * it (the ear and the Delegator ask it directly), but nothing here runs it as a tool.
   */
  match(utterance: string, ctx?: ReflexContext): Reflex | undefined {
    const reflex = parseReflex(utterance, ctx ?? this.context());
    return reflex?.kind === "sleep" ? undefined : reflex;
  }

  /** The last clause of an utterance that is not a command whole (`parseReflexTail`), with the same names and clock. */
  matchTail(utterance: string, ctx?: ReflexContext): ReturnType<typeof parseReflexTail> {
    const got = parseReflexTail(utterance, ctx ?? this.context());
    return got?.reflex.kind === "sleep" ? undefined : got;
  }

  /** What the grammar needs from the engine right now: the live thread names, the clock. */
  private context(): ReflexContext {
    const names = this.opts.threadNames?.();
    return { ...(names !== undefined ? { threadNames: names } : {}), now: this.now };
  }

  private async frontmost(): Promise<string> {
    return (await this.opts.frontmostApp?.().catch(() => "")) ?? "";
  }

  /** The frontmost app and its front window's title, through the runner (one helper round trip). */
  private async frontmostWindow(): Promise<{ app: string; title: string }> {
    try {
      const r = await this.opts.runner.run("frontmost_app", {});
      if (r.result.kind === "text") {
        const f = JSON.parse(r.result.text) as { app?: string; window?: { title?: string } | null };
        return { app: f.app ?? "", title: f.window?.title ?? "" };
      }
    } catch {
      // fall through to the name alone
    }
    return { app: await this.frontmost(), title: "" };
  }

  async run(reflex: Reflex): Promise<ReflexOutcome> {
    if (reflex.kind === "search" || reflex.steps) {
      const key = ReflexRunner.batchKey(reflex);
      const running = this.inflight.get(key);
      if (running) {
        log.info(`reflex "${reflex.label}" is already in flight; joining it instead of running it again`);
        running.joined = true;
        return running.promise;
      }
      const failed = this.failures.get(key);
      if (failed && this.now() - failed.at < ReflexRunner.FAILURE_HOLD_MS && failed.outcome.result.kind === "error") {
        const message = `${failed.outcome.result.message} (tried ${this.now() - failed.at} ms ago on the ear's words; not retried)`;
        return { ...failed.outcome, ms: 0, result: { kind: "error", message } };
      }
      const entry = { promise: undefined as unknown as Promise<ReflexOutcome>, joined: false };
      // The wrapper runs when the batch settles — after any join that happened while it ran —
      // so both callers see `shared` when there were two of them.
      entry.promise = (reflex.kind === "search" ? this.runSearch(reflex) : this.runBatch(reflex, reflex.steps ?? [])).then((outcome) => {
        if (!outcome.ok) this.failures.set(key, { at: this.now(), outcome });
        else this.failures.delete(key);
        return entry.joined ? { ...outcome, shared: true } : outcome;
      });
      this.inflight.set(key, entry);
      try {
        return await entry.promise;
      } finally {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      }
    }
    return this.runOne(reflex);
  }

  private async runOne(reflex: Reflex): Promise<ReflexOutcome> {
    const notReflex = (why: string): ReflexOutcome => {
      log.info(`reflex "${reflex.label}" left to the brain: ${why}`);
      return { reflex, result: { kind: "error", message: `not a reflex: ${why}` }, ms: 0, ok: false };
    };
    // Jarhead answers from what it knows: the clock line is the result, no tool, no hands.
    if (reflex.kind === "say") return { reflex, result: { kind: "text", text: String(reflex.input["text"] ?? reflex.said) }, ms: 0, ok: true, dispatchedAt: this.now() };
    // A thread verb: the engine's table answers (the pseudo tool is not the runner's).
    if (reflex.meta && this.opts.meta) {
      const dispatchedAt = this.now();
      try {
        const result = await this.opts.meta(reflex);
        return { reflex, result, ms: this.now() - dispatchedAt, ok: result.kind !== "error", dispatchedAt };
      } catch (e) {
        return { reflex, result: { kind: "error", message: (e as Error).message }, ms: this.now() - dispatchedAt, ok: false, dispatchedAt };
      }
    }
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

  // ------------------------------------------------------------- batches

  /**
   * An ordered batch through the runner: each step's own gate applies (policy,
   * confirmation handshake, ledger). It stops at the first step that did not go
   * through — a `needs-confirmation` (the question is the answer, as for a single
   * step: `ok` stays true and the delegator relays it, the ear drops it), a refusal or
   * an error (`ok: false`, the brain takes the request) — and `did` says how far it got.
   */
  private async runBatch(reflex: Reflex, steps: readonly ReflexStep[]): Promise<ReflexOutcome> {
    const b = new Batch(reflex, this.opts.runner, this.now, steps.length);
    for (const step of steps) {
      const stopped = await b.step(step);
      if (stopped) return stopped;
    }
    return b.done();
  }

  /**
   * "search <where> for <what>", planned from what is in front:
   *   1. <where> names an app: `focus_app` it unless it is in front already. A site: the
   *      front browser tab must be on it (the window title says so), else the brain
   *      navigates — never a blind navigation from here. "this page" / "here": find in
   *      page in whatever is in front.
   *   2. the search field: `click_element {name: "search", role: "field"}` over the
   *      front window's accessibility tree (a text field whose label, description or
   *      placeholder says "search"); when there is none, the app's or site's standard
   *      shortcut (address bar ⌘L, Finder ⌘F, GitHub "/", Notion ⌘K …).
   *   3. select all, type <what>, Return (not for a palette that opens the first hit).
   * Every step is gated as a brain's would be: a password field refuses `type`, a
   * hands-off app asks — and the batch stops there and says so.
   */
  private async runSearch(reflex: Reflex): Promise<ReflexOutcome> {
    const where = String(reflex.input["where"] ?? "");
    const what = String(reflex.input["what"] ?? "");
    const here = reflex.input["here"] === true;
    const notReflex = (why: string): ReflexOutcome => {
      log.info(`reflex "${reflex.label}" left to the brain: ${why}`);
      return { reflex, result: { kind: "error", message: `not a reflex: ${why}` }, ms: 0, ok: false, did: `nothing done: ${why}` };
    };
    const front = await this.frontmostWindow();
    if (!front.app) return notReflex("could not tell which app is in front");

    let app = front.app;
    let shortcut: SearchShortcut | undefined;
    let tryField = true;
    // A site's search field is on the page: a browser's own address bar (which always says
    // "search") must not take the words — Google would get what the wiki should.
    let fieldRole = "field";
    // <where> is a site on the front tab: only the page's own field or the site's shortcut may
    // take the words. The address bar is the browser's search, chosen only when <where> IS
    // the browser ("search safari for …") — never as a fallback for a site.
    let siteSearch = false;
    const focus: ReflexStep[] = [];
    let mustFront: string | undefined;
    if (here) {
      shortcut = FIND_IN_PAGE;
      tryField = false;
    } else {
      const site = SEARCH_SITES[where];
      const asApp = SEARCH_APPS[where] ?? (site ? undefined : appName(where));
      const frontIsApp = asApp !== undefined && front.app.toLowerCase() === asApp.toLowerCase();
      const inBrowser = BROWSER_APPS.test(front.app);
      // In order: the app itself is in front; the front browser tab is on the site; the app
      // (also a site: Notion, Slack, Linear …) is focused; a site the tab is not on, or named
      // with no browser up, is the brain's — a search never navigates.
      if (frontIsApp) {
        app = asApp;
      } else if (site && inBrowser && titleMentions(front.title, site)) {
        shortcut = SITE_SEARCH_SHORTCUTS[where];
        fieldRole = "pagefield";
        siteSearch = true;
      } else if (asApp) {
        app = asApp;
        mustFront = asApp;
        // Activation lands a beat after the call; the tree and the type gate read the new front window then.
        focus.push({ tool: "focus_app", input: { name: asApp }, did: `focused ${asApp}` }, { tool: "wait", input: { duration: 0.12 }, did: "waited for it" });
      } else if (site && inBrowser) {
        return notReflex(`${front.app}'s front tab ("${front.title.slice(0, 60)}") is not on ${where}; the brain navigates there first`);
      } else if (site) {
        return notReflex(`${where} is a site and ${front.app} is in front, not a browser; the brain opens it`);
      } else {
        return notReflex(`"${where}" is not an app or a site the reflex knows`);
      }
      if (!shortcut && !siteSearch) shortcut = BROWSER_APPS.test(app) ? ADDRESS_BAR : APP_SEARCH_SHORTCUTS[app.toLowerCase()];
    }

    const b = new Batch(reflex, this.opts.runner, this.now);
    for (const step of focus) {
      const stopped = await b.step(step);
      if (stopped) return stopped;
    }
    if (mustFront) {
      // `focus_app` returns as soon as activation is asked for, not when it lands. Every
      // keystroke after this goes to whatever is in front, so the app must be seen there
      // first — once more after a beat for a slow (Electron) app — or nothing is typed.
      let now = await this.frontmostWindow();
      if (now.app.toLowerCase() !== mustFront.toLowerCase()) {
        const wait = await b.step({ tool: "wait", input: { duration: 0.1 }, did: "waited for it once more" });
        if (wait) return wait;
        now = await this.frontmostWindow();
      }
      if (now.app.toLowerCase() !== mustFront.toLowerCase()) return b.stop("focus_app", `${mustFront} did not come to the front (${now.app || "nothing"} is)`);
    }
    let landed = "";
    let submit = true;
    if (tryField) {
      // The one text field on the front window that is about search; the toolset checks
      // the app is in front and the point is the field before the click goes out. (The
      // helper's default 250 ms walk budget bounds the look; the toolset does not pass a
      // shorter one through.)
      const field = await b.step({ tool: "click_element", input: { name: "search", role: fieldRole, app }, did: `clicked the search field of ${app}` }, { soft: true });
      if (!field) landed = "the search field";
      else if (field.result.kind === "needs-confirmation") return field;
      else {
        const why = field.result.kind === "error" ? field.result.message : field.result.kind;
        // Only "the tree has no such field" falls to a shortcut. Anything else — the app is
        // not in front, the field is covered, the policy refused — says the keys would land
        // somewhere else, and the batch stops there.
        if (!NO_SUCH_FIELD.test(why)) return b.stop("click_element", why);
        if (!shortcut) return b.stop("click_element", `no search field on the front window of ${app} (${why.slice(0, 120)}) and no search shortcut known for ${siteSearch ? where : app}`);
        log.info(`reflex "${reflex.label}": no search field by accessibility (${why.slice(0, 100)}); ${shortcut.combo} instead`);
        b.note(`no search field on the front window of ${app} (${why.slice(0, 120)})`);
      }
    }
    if (!landed && shortcut) {
      if (shortcut.combo === "/") {
        // "/" is a shortcut only while nothing takes text; with a field or a textarea focused
        // (a comment draft) it is a character — and ⌘A + the words would replace the draft.
        const before = await b.focused({ soft: true });
        if (before.stopped) return before.stopped;
        if (before.field && TEXT_INPUT_ROLE.test(before.field.role)) return b.stop("key", `a text input (${before.field.role}${before.field.title ? ` "${before.field.title.slice(0, 40)}"` : ""}) is focused in ${app}; "/" would be typed into it`);
      }
      const key = await b.step({ tool: "key", input: { text: shortcut.combo }, did: `pressed ${shortcut.combo} for ${shortcut.what}` });
      if (key) return key;
      const wait = await b.step({ tool: "wait", input: { duration: 0.15 }, did: "waited for the field" });
      if (wait) return wait;
      landed = shortcut.what;
      submit = shortcut.submit;
    }
    // Before a key goes out: the focus must be in a text field of the app (a tool result, not
    // a hope — the click or the shortcut may have moved nothing). One more look after a beat.
    let f = await b.focused();
    if (f.stopped) return f.stopped;
    if (!f.field || !SEARCH_FIELD_ROLE.test(f.field.role) || (f.field.app && f.field.app.toLowerCase() !== app.toLowerCase())) {
      const wait = await b.step({ tool: "wait", input: { duration: 0.1 }, did: "waited for the focus" });
      if (wait) return wait;
      f = await b.focused();
      if (f.stopped) return f.stopped;
    }
    if (!f.field) return b.stop("read_focused_text", `nothing is focused after ${landed} in ${app}${f.error ? ` (${f.error.slice(0, 120)})` : ""}`);
    if (f.field.app && f.field.app.toLowerCase() !== app.toLowerCase()) return b.stop("read_focused_text", `the focus is in ${f.field.app}, not ${app}`);
    if (!SEARCH_FIELD_ROLE.test(f.field.role)) return b.stop("read_focused_text", `the focus after ${landed} is ${f.field.role}${f.field.title ? ` "${f.field.title.slice(0, 40)}"` : ""}, not a text field`);
    const tail: ReflexStep[] = [
      { tool: "key", input: { text: "cmd+a" }, did: "selected what was there" },
      { tool: "type", input: { text: what }, did: `typed "${what.slice(0, 60)}"` },
      ...(submit ? [{ tool: "key", input: { text: "Return" }, did: "pressed Return" }] : []),
    ];
    for (const step of tail) {
      const stopped = await b.step(step);
      if (stopped) return stopped;
    }
    const did = `typed "${what.slice(0, 60)}" into ${landed} of ${app}${submit ? " and pressed Return" : ""}`;
    return b.done(did, `${did}.`);
  }
}

/** `click_element`'s "nothing by that name" errors: the tree was searched and has no such field — a shortcut may still reach one. */
const NO_SUCH_FIELD = /^no control named |^\d+ controls could be /;
/** Roles words land in: focused, "/" is a character, and after a click or a shortcut the words go here. */
const TEXT_INPUT_ROLE = /^AX(?:TextField|TextArea|ComboBox|SearchField)$/;
/** Roles a search field has (a textarea is a draft, not a search). */
const SEARCH_FIELD_ROLE = /^AX(?:TextField|SearchField|ComboBox)$/;

/** What `read_focused_text` reported, as the batch reads it. */
interface FocusedField {
  readonly role: string;
  readonly title?: string;
  readonly app?: string;
  readonly secure: boolean;
}

/** The running account of a batch: steps done, ms, the first acting step's issue time, and the stop. */
class Batch {
  private readonly dids: string[] = [];
  private readonly notes: string[] = [];
  private ms = 0;
  private dispatchedAt: number | undefined;
  private last: ToolResult = { kind: "text", text: "OK" };
  private done_ = 0;

  constructor(
    private readonly reflex: Reflex,
    private readonly runner: ToolRunner,
    private readonly now: () => number,
    private total = 0,
  ) {}

  /** Run one step. Returns the outcome that ends the batch when the step did not go through (`soft`: an error is reported to the caller, not final), else undefined. */
  async step(step: ReflexStep, opts: { readonly soft?: boolean } = {}): Promise<ReflexOutcome | undefined> {
    if (this.dispatchedAt === undefined && ACTING_MEMBERS.has(step.tool)) this.dispatchedAt = this.now();
    this.total = Math.max(this.total, this.done_ + 1);
    const out = await this.runner.run(step.tool, step.input);
    this.ms += out.ms;
    this.last = out.result;
    if (out.result.kind === "needs-confirmation") {
      // The runner recorded the handshake; the question is the whole answer (the delegator relays it, the ear drops it).
      const did = `${this.soFar()}; stopped at ${step.tool}: needs a yes`;
      log.info(`reflex "${this.reflex.label}" ${did}`);
      return this.outcome(out.result, true, did);
    }
    if (out.result.kind === "error") {
      if (opts.soft) return this.outcome(out.result, false, this.soFar());
      return this.stop(step.tool, out.result.message);
    }
    this.dids.push(step.did);
    this.done_++;
    return undefined;
  }

  /** Something learned on the way that the brain should not learn again (a tree without the field). */
  note(text: string): void {
    this.notes.push(text);
  }

  /**
   * Where the focus is, by `read_focused_text` through the runner (on the ledger like
   * every step; not counted as one). A password field ends the batch here — not a
   * single key may go into it. `soft`: "nothing focused" is an answer, not a stop.
   */
  async focused(opts: { readonly soft?: boolean } = {}): Promise<{ readonly field?: FocusedField; readonly stopped?: ReflexOutcome; readonly error?: string }> {
    const out = await this.runner.run("read_focused_text", {});
    this.ms += out.ms;
    const r = out.result;
    if (r.kind === "needs-confirmation") return { stopped: this.outcome(r, true, `${this.soFar()}; stopped at read_focused_text: needs a yes`) };
    if (r.kind === "error") return opts.soft ? {} : { error: r.message };
    if (r.kind !== "text") return {};
    if (!r.text.startsWith("{")) {
      if (/password field/.test(r.text)) return { stopped: this.stop("read_focused_text", "the focused field is a password field") };
      return {};
    }
    try {
      const f = JSON.parse(r.text) as { role?: unknown; title?: unknown; app?: unknown };
      return { field: { role: typeof f.role === "string" ? f.role : "", ...(typeof f.title === "string" ? { title: f.title } : {}), ...(typeof f.app === "string" ? { app: f.app } : {}), secure: false } };
    } catch {
      return {};
    }
  }

  /** The batch ends here, undone: what was done, where it stopped, why. */
  stop(tool: string, why: string): ReflexOutcome {
    const did = `${this.soFar()}; stopped at ${tool}: ${why}`;
    log.info(`reflex "${this.reflex.label}" ${did}; the brain takes it`);
    return this.outcome({ kind: "error", message: did }, false, did);
  }

  /**
   * The batch ran through. `said` is what the voice says for it — built from where the
   * words landed, so the spoken claim is the tool results' account, not the grammar's
   * guess; the outcome's reflex carries it for the reconciliation.
   */
  done(did?: string, said?: string): ReflexOutcome {
    const text = did ?? (this.dids.length ? this.dids.join(", ") : "nothing to do");
    const outcome = this.outcome(this.last, true, this.notes.length ? `${text} (${this.notes.join("; ")})` : text);
    return said ? { ...outcome, reflex: { ...this.reflex, said } } : outcome;
  }

  private soFar(): string {
    const notes = this.notes.length ? `; ${this.notes.join("; ")}` : "";
    return `did ${this.done_} step${this.done_ === 1 ? "" : "s"}${this.dids.length ? ` (${this.dids.join("; ")})` : ""}${notes}`;
  }

  private outcome(result: ToolResult, ok: boolean, did: string): ReflexOutcome {
    return { reflex: this.reflex, result, ms: this.ms, ok, ...(this.dispatchedAt !== undefined ? { dispatchedAt: this.dispatchedAt } : {}), did, progress: { done: this.done_, total: Math.max(this.total, this.done_) } };
  }
}
