import { AUTOMATION_GRACE_MS, type AutomationClauses, type AutomationKind, type AutomationWhen, type ClockTime, type Recurrence, type SystemEvent, type Weekday } from "@jarhead/protocol";

/**
 * When an automation fires — the clock arithmetic, pure, so the CLI can parse a phrase
 * without a daemon and the engine's tick() can ask "what is next" without a model.
 *
 *   parseWhen     Kevin's phrase → AutomationWhen (pass 1: a time, tomorrow, in N, weekdays /
 *                 daily / weekends / named days at a time, every N h/min); monthly is refused
 *   nextFire      the next instant a `when` fires after an instant
 *   describe      a `when` in words, the phrase where one was kept
 *   inQuiet       whether an instant is inside quiet hours (wraps midnight)
 *   quietEnds     when the current quiet spell ends
 *   inWindow      whether a row's window and days admit an instant
 *   graceFor      how late a kind may still fire (the contract's table)
 *   snoozeDefault the one Snooze press's minutes for a kind
 *
 * Every date is LOCAL: the Mac's clock, the zone the process runs in. A ClockTime is
 * re-resolved on each date it is asked about, so a 02:30 on the night the clocks spring
 * forward (no such minute) rolls to 03:00, and a 01:30 on the night they fall back (two
 * such minutes) fires once, on the first.
 */

/** Sunday first, as `Date.getDay()` numbers them. */
export const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_WORK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKDAY_END: readonly Weekday[] = ["sat", "sun"];
const WEEKDAY_ALL: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** What a one-shot phrase must clear to count as "next": a time said at 07:00:00 for 07:00 is tomorrow's. */
export const PARSE_LEAD_MS = 60_000;
/** The shortest interval a phrase may set. */
export const INTERVAL_MIN_MS = 60_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The local wall clock of an instant as the contract's "HH:mm". */
export function clockOf(ms: number): ClockTime {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` as ClockTime;
}

/** The local weekday of an instant. */
export function weekdayOf(ms: number): Weekday {
  return WEEKDAYS[new Date(ms).getDay()] ?? "sun";
}

/** "HH:mm" → minutes since local midnight; undefined for a malformed string. */
function minutesOf(t: ClockTime): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return undefined;
  return hh * 60 + mm;
}

/** Local midnight of the instant's date, `plusDays` later. */
function dayStart(ms: number, plusDays = 0): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays, 0, 0, 0, 0);
}

/**
 * The instant of a ClockTime on a local date. A minute the clocks skip (02:30 on the
 * spring-forward night: the Date lands at 03:30) rolls to the first minute after the gap
 * (03:00); a minute that happens twice resolves to its first occurrence (the ECMAScript rule).
 */
export function atClock(day: Date, t: ClockTime): number {
  const mins = minutesOf(t) ?? 0;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0);
  if (d.getHours() === hh && d.getMinutes() === mm) return d.getTime();
  // Skipped: walk forward minute by minute from the asked time until the clock reads a real minute.
  let probe = d.getTime() - 60 * 60_000;
  for (let i = 0; i < 180; i++) {
    probe += 60_000;
    const p = new Date(probe);
    const read = p.getHours() * 60 + p.getMinutes();
    if (read > mins || p.getDate() !== day.getDate()) return probe;
  }
  return d.getTime();
}

// ------------------------------------------------------------------ parsing ---

export type ParsedWhen = AutomationWhen | { readonly error: string };

const HOUR_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const DAY_WORDS: Readonly<Record<string, Weekday>> = {
  mon: "mon", monday: "mon", mondays: "mon", tue: "tue", tues: "tue", tuesday: "tue", tuesdays: "tue", wed: "wed", weds: "wed", wednesday: "wed", wednesdays: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu", thursdays: "thu", fri: "fri", friday: "fri", fridays: "fri", sat: "sat", saturday: "sat", saturdays: "sat", sun: "sun", sunday: "sun", sundays: "sun",
};
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};
const SKIP_WORDS = new Set(["at", "on", "every", "each", "and", "the", "a", "an", "o'clock", "oclock", "please", "alarm", "for", "me", "wake", "up", "this"]);
const NOT_YET = /\b(monthly|month|months|1st|2nd|3rd|\d+th|first|second|third|fourth|last|year|yearly|annually)\b/;
const err = (error: string): { readonly error: string } => ({ error });

interface Clock {
  readonly hh: number;
  readonly mm: number;
  /** A colon form, an am/pm, noon or midnight: the hour is what it says. Otherwise "seven" may mean 19:00. */
  readonly exact: boolean;
}

/** A duration phrase: "12 minutes", "2 h", "1 h 30 min", "an hour", "half an hour". */
function parseDuration(text: string): number | undefined {
  const t = text.trim().replace(/\ban?\b/g, "1").replace(/\bhalf 1 (hour|hr|h)\b/, "30 min");
  let total = 0;
  let rest = t;
  for (let guard = 0; guard < 4 && rest; guard++) {
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)(?:\s+(?:and\s+)?|$)/.exec(rest);
    if (!m) return undefined;
    const unit = UNIT_MS[m[2] ?? ""];
    if (unit === undefined) return undefined;
    total += Number(m[1]) * unit;
    rest = rest.slice(m[0].length);
  }
  return rest ? undefined : total;
}

/** A time token: "7", "7:10", "07:10", "7am", "7pm", "seven", "noon", "midnight"; `next` may be a trailing am/pm word. */
function parseClock(tok: string, next: string | undefined): { readonly clock: Clock; readonly used: number } | undefined {
  if (tok === "noon") return { clock: { hh: 12, mm: 0, exact: true }, used: 1 };
  if (tok === "midnight") return { clock: { hh: 0, mm: 0, exact: true }, used: 1 };
  const meridian = (w: string | undefined): "am" | "pm" | undefined => (w === "am" || w === "a.m." ? "am" : w === "pm" || w === "p.m." ? "pm" : undefined);
  const word = HOUR_WORDS[tok];
  const m = word !== undefined ? { hh: word, mm: 0, colon: false, ap: undefined as "am" | "pm" | undefined } : (() => {
    const r = /^(\d{1,2})(?::(\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/.exec(tok);
    if (!r) return undefined;
    return { hh: Number(r[1]), mm: r[2] === undefined ? 0 : Number(r[2]), colon: r[2] !== undefined, ap: meridian(r[3]) };
  })();
  if (!m) return undefined;
  let used = 1;
  let ap = m.ap;
  if (!ap && meridian(next)) {
    ap = meridian(next);
    used = 2;
  }
  let hh = m.hh;
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  if (hh > 23 || m.mm > 59) return undefined;
  return { clock: { hh, mm: m.mm, exact: m.colon || ap !== undefined }, used };
}

function clockTime(c: Clock): ClockTime {
  return `${pad2(c.hh)}:${pad2(c.mm)}` as ClockTime;
}

/** The recurrence's phrase, normalised: "weekdays 09:00" · "daily 18:00" · "weekends 10:30" · "mon,wed 07:10". */
function weeklyPhrase(days: readonly Weekday[], at: ClockTime): string {
  const set = new Set(days);
  const same = (want: readonly Weekday[]): boolean => want.length === set.size && want.every((d) => set.has(d));
  if (same(WEEKDAY_ALL)) return `daily ${at}`;
  if (same(WEEKDAY_WORK)) return `weekdays ${at}`;
  if (same(WEEKDAY_END)) return `weekends ${at}`;
  return `${WEEKDAY_ALL.filter((d) => set.has(d)).join(",")} ${at}`;
}

/** "every 2 h" · "every 45 min" · "every 90 s". */
function intervalPhrase(everyMs: number): string {
  return `every ${durationWords(everyMs)}`;
}

/** "2 h" · "45 min" · "1 h 30 min" · "1 min 30 s" · "45 s" — hours, minutes and seconds, each only when non-zero. */
function durationWords(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return parts.length ? parts.join(" ") : "0 s";
}

/**
 * Kevin's phrase → when it fires. Pass 1: "7:10" · "at seven" · "tomorrow 07:10" · "in 12 minutes" ·
 * "weekdays 09:00" · "daily 18:00" · "weekends 10:30" · "mon,wed 07:10" · "every 2 h" · "every 45 min".
 * A bare hour with no am/pm ("at seven") is the next 07:00 or 19:00 at least PARSE_LEAD_MS away; a
 * colon form is the hour it says, today if still ahead, else tomorrow. Monthly phrases are pass 2:
 * "not yet — say the date". Words it does not know are named in the error, never guessed.
 */
export function parseWhen(phrase: string, now: number): ParsedWhen {
  const p = phrase.trim().toLowerCase().replace(/[,;]+/g, " ").replace(/&/g, " and ").replace(/\s+/g, " ");
  if (!p) return err("say when: a time, 'in 12 minutes', 'weekdays 09:00' or 'every 2 h'");
  if (NOT_YET.test(p)) return err("not yet — say the date");

  const inM = /^in (.+)$/.exec(p);
  if (inM) {
    const ms = parseDuration(inM[1] ?? "");
    if (ms === undefined) return err(`didn't catch the duration in "${phrase.trim()}"; say "in 12 minutes" or "in 2 hours"`);
    if (ms < 1_000) return err("a timer needs at least a second");
    return { kind: "in", ms: Math.round(ms) };
  }

  const everyM = /^every (\d+(?:\.\d+)?|an?|half an?) ?([a-z]+)(.*)$/.exec(p);
  if (everyM && UNIT_MS[everyM[2] ?? ""] !== undefined) {
    const ms = parseDuration(`${everyM[1]} ${everyM[2]}${everyM[3] ?? ""}`);
    if (ms === undefined) return err(`didn't catch the interval in "${phrase.trim()}"; say "every 2 h" or "every 45 min"`);
    if (ms < INTERVAL_MIN_MS) return err("an interval needs at least a minute");
    return { kind: "every", every: { kind: "interval", everyMs: Math.round(ms), anchorAt: now }, phrase: intervalPhrase(Math.round(ms)) };
  }

  const words = p.split(" ");
  const days = new Set<Weekday>();
  let clock: Clock | undefined;
  let date: "today" | "tonight" | "tomorrow" | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (SKIP_WORDS.has(w)) continue;
    if (w === "tomorrow") {
      date = "tomorrow";
      continue;
    }
    if (w === "today") {
      date = "today";
      continue;
    }
    if (w === "tonight" || w === "evening") {
      date = "tonight";
      continue;
    }
    if (w === "weekdays" || w === "weekday") {
      for (const d of WEEKDAY_WORK) days.add(d);
      continue;
    }
    if (w === "weekends" || w === "weekend") {
      for (const d of WEEKDAY_END) days.add(d);
      continue;
    }
    if (w === "daily" || w === "everyday" || w === "day" || w === "days") {
      for (const d of WEEKDAY_ALL) days.add(d);
      continue;
    }
    const day = DAY_WORDS[w];
    if (day) {
      days.add(day);
      continue;
    }
    const c = parseClock(w, words[i + 1]);
    if (c) {
      if (clock) return err(`two times in "${phrase.trim()}"; say one`);
      clock = c.clock;
      i += c.used - 1;
      continue;
    }
    return err(`didn't catch "${w}" in "${phrase.trim()}"`);
  }
  if (!clock) return err(days.size ? "say a time too: 'weekdays 09:00'" : `didn't catch a time in "${phrase.trim()}"`);

  if (days.size) {
    if (date) return err("a day of the week and 'tomorrow' don't go together; say one");
    const at = clockTime(clock);
    const list = WEEKDAY_ALL.filter((d) => days.has(d));
    return { kind: "every", every: { kind: "weekly", days: list, at }, phrase: weeklyPhrase(list, at) };
  }

  const lead = now + PARSE_LEAD_MS;
  if (date === "tomorrow") return { kind: "at", at: atClock(dayStart(now, 1), clockTime(clock)) };
  if (date === "today" || date === "tonight") {
    // A bare hour on a named day has its 12-hour twin too: "today at nine" said at 14:00 is 21:00; "tonight at seven" is 19:00 —
    // tonight takes the evening reading outright. An exact time ("today 07:10", "tonight 7am") is what it says.
    const twin = !clock.exact && clock.hh <= 12;
    const evening = date === "tonight" && twin && clock.hh < 12;
    const clocks: ClockTime[] = evening ? [clockTime({ ...clock, hh: clock.hh + 12 })] : twin ? [clockTime(clock), clockTime({ ...clock, hh: (clock.hh + 12) % 24 })] : [clockTime(clock)];
    let best: number | undefined;
    for (const t of clocks) {
      const at = atClock(dayStart(now), t);
      if (at >= lead && (best === undefined || at < best)) best = at;
    }
    return best !== undefined ? { kind: "at", at: best } : err(`${clocks[clocks.length - 1] ?? clockTime(clock)} has passed today`);
  }
  // No date: the next occurrence at least a minute away — of the hour said, or (no am/pm, a bare hour) its 12-hour twin too.
  const clocks: ClockTime[] = clock.exact || clock.hh > 12 ? [clockTime(clock)] : [clockTime(clock), clockTime({ ...clock, hh: (clock.hh + 12) % 24 })];
  let best: number | undefined;
  for (const plus of [0, 1]) {
    for (const t of clocks) {
      const at = atClock(dayStart(now, plus), t);
      if (at >= lead && (best === undefined || at < best)) best = at;
    }
  }
  return best === undefined ? err(`didn't find a next ${clockTime(clock)}`) : { kind: "at", at: best };
}

// ---------------------------------------------------------------- next fire ---

function nextWeekly(r: Extract<Recurrence, { kind: "weekly" }>, after: number): number | undefined {
  if (r.days.length === 0) return undefined;
  const want = new Set(r.days);
  for (let plus = 0; plus <= 8; plus++) {
    const day = dayStart(after, plus);
    if (!want.has(WEEKDAYS[day.getDay()] ?? "sun")) continue;
    const at = atClock(day, r.at);
    if (at > after) return at;
  }
  return undefined;
}

function nextInterval(r: Extract<Recurrence, { kind: "interval" }>, after: number): number | undefined {
  if (!(r.everyMs > 0)) return undefined;
  if (r.anchorAt > after) return r.anchorAt;
  const k = Math.floor((after - r.anchorAt) / r.everyMs) + 1;
  return r.anchorAt + k * r.everyMs;
}

/** The `nth` weekday of a local month (nth -1 = the last); undefined when the month lacks it. */
function nthWeekday(year: number, month: number, nth: 1 | 2 | 3 | 4 | -1, weekday: Weekday): Date | undefined {
  const idx = WEEKDAYS.indexOf(weekday);
  if (nth === -1) {
    const last = new Date(year, month + 1, 0);
    const back = (last.getDay() - idx + 7) % 7;
    return new Date(year, month, last.getDate() - back);
  }
  const first = new Date(year, month, 1);
  const forward = (idx - first.getDay() + 7) % 7;
  const d = new Date(year, month, 1 + forward + (nth - 1) * 7);
  return d.getMonth() === month ? d : undefined;
}

function nextMonthly(r: Extract<Recurrence, { kind: "monthly" }>, after: number): number | undefined {
  const base = new Date(after);
  for (let plus = 0; plus <= 13; plus++) {
    const day = nthWeekday(base.getFullYear(), base.getMonth() + plus, r.nth, r.weekday);
    if (!day) continue;
    const at = atClock(day, r.at);
    if (at > after) return at;
  }
  return undefined;
}

function nextMonthday(r: Extract<Recurrence, { kind: "monthday" }>, after: number): number | undefined {
  if (!(r.day >= 1 && r.day <= 31)) return undefined;
  const base = new Date(after);
  for (let plus = 0; plus <= 13; plus++) {
    const d = new Date(base.getFullYear(), base.getMonth() + plus, r.day);
    if (d.getDate() !== r.day) continue; // the month is shorter than `day`
    const at = atClock(d, r.at);
    if (at > after) return at;
  }
  return undefined;
}

/**
 * The next instant `when` fires strictly after `after`: `at` once, `in` at createdAt + ms (once),
 * `every` by its recurrence (a weekly walks ≤ 8 days, an interval is anchorAt + k·everyMs), `on`
 * never (a watcher waits for its signal). Undefined = nothing ahead.
 */
export function nextFire(when: AutomationWhen, after: number, createdAt: number): number | undefined {
  switch (when.kind) {
    case "at":
      return when.at > after ? when.at : undefined;
    case "in": {
      const at = createdAt + when.ms;
      return at > after ? at : undefined;
    }
    case "every":
      return nextRecurrence(when.every, after);
    case "on":
      return undefined;
  }
}

function nextRecurrence(r: Recurrence, after: number): number | undefined {
  switch (r.kind) {
    case "weekly":
      return nextWeekly(r, after);
    case "interval":
      return nextInterval(r, after);
    case "monthly":
      return nextMonthly(r, after);
    case "monthday":
      return nextMonthday(r, after);
  }
}

// ----------------------------------------------------------------- describe ---

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES: Readonly<Record<Weekday, string>> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

/** A local instant in words: "07:10 · Tue 15 Sep". */
export function describeInstant(ms: number): string {
  const d = new Date(ms);
  return `${clockOf(ms)} · ${DAY_NAMES[weekdayOf(ms)]} ${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
}

/** A system event in words: "when a file lands in ~/Downloads (*.pdf)". */
export function describeEvent(e: SystemEvent): string {
  switch (e.kind) {
    case "folder.file":
      return `when a file lands in ${e.path}${e.glob ? ` (${e.glob})` : ""}`;
    case "download.done":
      return `when a download finishes${e.glob ? ` (${e.glob})` : ""}`;
    case "app.launch":
      return `when ${e.app} launches`;
    case "app.quit":
      return `when ${e.app} quits`;
    case "mac.wake":
      return "when the Mac wakes";
    case "screen.unlock":
      return "when the screen unlocks";
    case "display.connected":
      return "when a display connects";
    case "display.disconnected":
      return "when a display disconnects";
    case "recipe.red":
      return `when recipe ${e.recipe} goes red (checked every ${e.everySeconds} s)`;
    case "agent.status":
      return `when ${e.agent ?? "an agent"} is ${e.status}`;
    default:
      return "when a signal this build does not know arrives";
  }
}

/**
 * A `when` in words. A recurrence set from a phrase keeps that phrase, normalised
 * ("weekdays 09:00", "every 2 h"), so `parseWhen(describe(w), now)` gives `w` back.
 */
export function describe(when: AutomationWhen): string {
  switch (when.kind) {
    case "at":
      return describeInstant(when.at);
    case "in":
      return `in ${durationWords(when.ms)}`;
    case "every":
      return when.phrase || describeRecurrence(when.every);
    case "on":
      return describeEvent(when.on);
  }
}

function describeRecurrence(r: Recurrence): string {
  switch (r.kind) {
    case "weekly":
      return weeklyPhrase(r.days, r.at);
    case "interval":
      return intervalPhrase(r.everyMs);
    case "monthly":
      return `the ${r.nth === -1 ? "last" : ["", "first", "second", "third", "fourth"][r.nth] ?? ""} ${DAY_NAMES[r.weekday]} of the month ${r.at}`;
    case "monthday":
      return `the ${r.day}${ordinal(r.day)} of the month ${r.at}`;
  }
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

// ------------------------------------------------------- quiet hours, window ---

type Span = { readonly from: ClockTime; readonly to: ClockTime };

/** Whether the instant's local minute lies in [from, to), wrapping midnight when to ≤ from; an empty span admits nothing. */
function inSpan(span: Span, now: number): boolean {
  const from = minutesOf(span.from);
  const to = minutesOf(span.to);
  if (from === undefined || to === undefined || from === to) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** Whether `now` is inside quiet hours; no quiet hours set = never. */
export function inQuiet(q: Span | undefined, now: number): boolean {
  return q !== undefined && inSpan(q, now);
}

/** When the quiet spell `now` sits in ends (the `to` clock, today or tomorrow); undefined when `now` is not quiet. */
export function quietEnds(q: Span | undefined, now: number): number | undefined {
  if (!inQuiet(q, now) || q === undefined) return undefined;
  const today = atClock(dayStart(now), q.to);
  return today > now ? today : atClock(dayStart(now, 1), q.to);
}

/** Whether a row's clauses admit `now`: inside its `window` (wraps midnight) and on one of its `days`; no clause = always. */
export function inWindow(clauses: Pick<AutomationClauses, "window" | "days">, now: number): boolean {
  if (clauses.days && !clauses.days.includes(weekdayOf(now))) return false;
  return clauses.window === undefined || inSpan(clauses.window, now);
}

/** How late a one-shot of this kind may still fire after the daemon comes back; routines and watchers never fire late. */
export function graceFor(kind: AutomationKind): number {
  return AUTOMATION_GRACE_MS[kind];
}

/** The island's one Snooze press: timers snooze 5 minutes, everything else Settings.automations.snoozeMinutes. */
export function snoozeDefault(kind: AutomationKind, snoozeMinutes: number): number {
  return kind === "timer" ? 5 : snoozeMinutes;
}
