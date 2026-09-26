/**
 * Every literal the kit speaks, on one table (AGENTS.md:814 "every literal on a …Words enum"). The tips follow
 * HelpCopy's shape (UI/HelpCopy.swift:9-23): a name of ≤ 2 words, a hint that is one line, verb first, no full stop,
 * ≤ 60 characters, the shortcut last as a keycap and never inside the hint, never "you", "your" or "Kevin". The app
 * allows one em dash per hint (HelpCopy.swift:10); the site allows none (SPACE.md), so the app's hints are joined
 * with ` · ` here. `violations()` is the twin of HelpCopy.violations (UI/HelpCopy.swift:114-125) plus the dash rule.
 */
export interface Tip {
  readonly name: string;
  readonly hint: string;
  readonly key?: string;
}

/** The app's entries the site may borrow, verbatim except the dash (UI/HelpCopy.swift:27-97). */
export const TIPS = {
  go: { name: "Go", hint: "Open the live session", key: "⌘P" },
  pause: { name: "Pause", hint: "Close the session · the context stays", key: "⌘P" },
  stop: { name: "Stop", hint: "Stop this turn · the threads carry on", key: "⌥⌘." },
  stopAll: { name: "Stop all", hint: "Stop everything · close the session, sleep", key: "⌘." },
  stopSpent: { name: "Stopped", hint: "Stopped · nothing running", key: "⌘." },
  search: { name: "Search", hint: "Find a line in every conversation", key: "⌘F" },
  circle: { name: "Circle", hint: "Circle something · needs Screen Recording", key: "⌥⇧C" },
  mute: { name: "Mute", hint: "Stop sending · the session and the mic stay open" },
  send: { name: "Send", hint: "Send the line", key: "⏎" },
  allow: { name: "Allow", hint: "Yes · a click, never Return" },
  deny: { name: "Deny", hint: "No · the question is dropped" },
  restore: { name: "Restore", hint: "Back from the Trash" },
  snooze: { name: "Snooze", hint: "Snooze · rings again in 10 min", key: "⌥⇧S" },
  trash: { name: "Trash", hint: "Move to Trash · hidden, restorable, never deleted" },
  recording: { name: "Recording", hint: "Hand back the mic, guard the echo · apps keep their sound", key: "⌥⇧R" },
  voice: { name: "Voice", hint: "Voice and accent · a pick is free; Switch now hears it" },
  switchNow: { name: "Switch now", hint: "Pause, then resume on the new voice · one restart" },
  more: { name: "More", hint: "More" },
  clear: { name: "Clear", hint: "Clear" },
  // the site's own, in the same shape
  copy: { name: "Copy", hint: "Copy the line" },
  copied: { name: "Copied", hint: "Copied · on the clipboard" },
  github: { name: "GitHub", hint: "Open the repo" },
} as const satisfies Record<string, Tip>;

export type TipName = keyof typeof TIPS;

/** ConsoleBadge.Word (ConsoleBadge.swift:10-29, 86-91): the word as written, its tone. Every resting word is lowercase; Ready is the one capital. */
export const BADGE_WORDS = {
  fits: { word: "fits", tone: "rest" },
  loaded: { word: "loaded", tone: "rest" },
  saved: { word: "saved", tone: "rest" },
  auto: { word: "auto", tone: "rest" },
  default: { word: "default", tone: "rest" },
  noKey: { word: "no key", tone: "rest" },
  thisMac: { word: "this Mac", tone: "rest" },
  ready: { word: "Ready", tone: "rest" },
  allOk: { word: "all ok", tone: "rest" },
  noTools: { word: "no tools", tone: "rest" },
  snoozed: { word: "snoozed", tone: "rest" },
  deferred: { word: "deferred", tone: "rest" },
  tight: { word: "tight", tone: "speaking" },
  asks: { word: "asks", tone: "speaking" },
  off: { word: "off", tone: "speaking" },
  billed: { word: "billed", tone: "speaking" },
  ringing: { word: "ringing", tone: "speaking" },
  tooBig: { word: "too big", tone: "error" },
  failed: { word: "failed", tone: "error" },
} as const;

/** `missing(3)` → "3 missing", `asking(1)` → "1 asks" (ConsoleBadge.swift:14-15, 88). */
export const missing = (n: number) => ({ word: `${n} missing`, tone: "speaking" as const });
export const asking = (n: number) => ({ word: `${n} asks`, tone: "speaking" as const });

/** The phases' words and hints (ConsoleTheme.swift:120-131), two clauses at most. */
export const PHASE_WORDS = {
  asleep: { label: "Asleep", hint: "No live session. Nothing billed." },
  connecting: { label: "Connecting", hint: "Opening the live session." },
  listening: { label: "Listening", hint: "Mic is hot." },
  speaking: { label: "Speaking", hint: "Jarhead is talking." },
  thinking: { label: "Thinking", hint: "The brain is working." },
  acting: { label: "Acting", hint: "Jarhead is using the computer." },
  muted: { label: "Muted", hint: "Mic muted. Session open." },
  paused: { label: "Paused", hint: "Paused. Session closed, meter stopped; Go resumes with the context." },
  error: { label: "Error", hint: "Something broke. See problems." },
} as const;

/** HelpCopy's rules as checks; empty means every tip is honest. */
export function violations(tips: Record<string, Tip> = TIPS): string[] {
  const out: string[] = [];
  for (const [id, t] of Object.entries(tips)) {
    if (t.hint.length > 60) out.push(`${id}: over 60 characters`);
    if (t.hint.endsWith(".")) out.push(`${id}: ends with a full stop`);
    if (t.hint.includes("\n")) out.push(`${id}: more than one line`);
    if (t.hint.includes("\u2014")) out.push(`${id}: has an em dash`);
    if (t.key && t.hint.includes(t.key)) out.push(`${id}: the key is inside the hint`);
    if (/\b(you|your)\b/i.test(t.hint)) out.push(`${id}: says you`);
    if (/\bKevin\b/.test(t.hint)) out.push(`${id}: names Kevin`);
    if (t.name.trim().split(/\s+/).length > 2) out.push(`${id}: the name is over two words`);
  }
  return out;
}
