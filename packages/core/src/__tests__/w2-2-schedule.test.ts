import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTOMATIONS, type AutomationWhen } from "@jarhead/protocol";
import { classifyAutomation, costLine } from "../policy.ts";
import { describe, parseWhen } from "../schedule.ts";

/**
 * W2-2 SL-16: parseWhen takes the phrasings the README and docs/AUTOMATIONS.md put in Kevin's
 * mouth (number words, "seven ten", nightly, mornings, "7.10", half past / quarter to, "an hour
 * and a half"). SL-18: the wake-brain cost line says how the brain is paid for.
 */

process.env.TZ = "America/New_York";

const local = (y: number, mo: number, d: number, hh: number, mm: number, ss = 0): number => new Date(y, mo - 1, d, hh, mm, ss, 0).getTime();
/** Mon 5 Oct 2026, 06:00 local: the audit's instant. */
const MON_0600 = local(2026, 10, 5, 6, 0);

function when(p: string, now = MON_0600): AutomationWhen {
  const w = parseWhen(p, now);
  assert.ok(!("error" in w), `"${p}" parses: ${"error" in w ? w.error : ""}`);
  return w;
}
const words = (p: string, now = MON_0600): string => describe(when(p, now));

test("SL-16: the audit's 26 phrases all parse, each to the row Kevin meant", () => {
  const table: readonly (readonly [string, string])[] = [
    ["at seven ten on weekdays", "weekdays 07:10"],
    ["seven ten weekdays", "weekdays 07:10"],
    ["weekdays at 7:10", "weekdays 07:10"],
    ["7:10 weekdays", "weekdays 07:10"],
    ["weekdays 07:10", "weekdays 07:10"],
    ["at 7:10am on weekdays", "weekdays 07:10"],
    ["in twelve minutes", "in 12 min"],
    ["in 12 minutes", "in 12 min"],
    ["twelve minutes", "in 12 min"],
    ["at three", "15:00 · Mon 5 Oct"],
    ["at 3", "15:00 · Mon 5 Oct"],
    ["at nine on weekdays", "weekdays 09:00"],
    ["every night at eleven", "daily 23:00"],
    ["nightly at 23:00", "daily 23:00"],
    ["nightly 23:00", "daily 23:00"],
    ["every day at 11pm", "daily 23:00"],
    ["at six", "18:00 · Mon 5 Oct"],
    ["every weekday at 9", "weekdays 09:00"],
    ["every morning at 7", "daily 07:00"],
    ["tomorrow morning at 7", "07:00 · Tue 6 Oct"],
    ["at 7.10", "07:10 · Mon 5 Oct"],
    ["in an hour and a half", "in 1 h 30 min"],
    ["in 1 hour 30 minutes", "in 1 h 30 min"],
    ["in ninety seconds", "in 1 min 30 s"],
    ["at half past seven", "07:30 · Mon 5 Oct"],
    ["quarter past 7", "07:15 · Mon 5 Oct"],
  ];
  assert.equal(table.length, 26);
  for (const [p, want] of table) assert.equal(words(p), want, p);
});

test("SL-16: the README's own sentences parse once the verb is gone", () => {
  assert.equal(words("wake me at seven ten on weekdays"), "weekdays 07:10");
  assert.equal(words("every night at eleven"), "daily 23:00");
  assert.equal(words("in twelve minutes"), "in 12 min");
});

test("SL-16: clock words — 'quarter to', 'ten past', 'seven oh five', 'seven forty-five', a bare hour's twin and 'in the evening'", () => {
  assert.equal(words("quarter to eight"), "07:45 · Mon 5 Oct");
  assert.equal(words("at ten past seven"), "07:10 · Mon 5 Oct");
  assert.equal(words("twenty to nine"), "08:40 · Mon 5 Oct");
  assert.equal(words("at seven oh five"), "07:05 · Mon 5 Oct");
  assert.equal(words("at seven forty-five"), "07:45 · Mon 5 Oct");
  assert.equal(words("at seven forty five pm"), "19:45 · Mon 5 Oct");
  assert.equal(words("at half past seven", local(2026, 10, 5, 8, 0)), "19:30 · Mon 5 Oct", "a bare clock has its evening twin");
  assert.equal(words("at 7 in the evening"), "19:00 · Mon 5 Oct");
  assert.equal(words("at 7 in the morning", local(2026, 10, 5, 8, 0)), "07:00 · Tue 6 Oct");
  assert.equal(words("tomorrow evening at 7"), "19:00 · Tue 6 Oct");
  assert.equal(words("weekday mornings at 7:30"), "weekdays 07:30");
  assert.equal(words("mornings at 6"), "daily 06:00");
  assert.equal(words("evenings at 6"), "daily 18:00");
  assert.equal(words("every evening at 9"), "daily 21:00");
  assert.equal(words("weekdays at 9 30"), "weekdays 09:30");
});

test("SL-16: durations in words", () => {
  assert.equal(words("in a minute and a half"), "in 1 min 30 s");
  assert.equal(words("in two and a half hours"), "in 2 h 30 min");
  assert.equal(words("in half an hour"), "in 30 min");
  assert.equal(words("in forty-five minutes"), "in 45 min");
  assert.equal(words("an hour and a half"), "in 1 h 30 min");
  assert.equal(words("every twenty minutes"), "every 20 min");
});

test("SL-16: what was refused stays refused, in its own words", () => {
  const error = (p: string): string => {
    const w = parseWhen(p, MON_0600);
    assert.ok("error" in w, `"${p}" is refused`);
    return w.error;
  };
  assert.match(error("at 7 and at 8"), /two times/);
  assert.match(error("in a while"), /didn't catch the duration/);
  assert.match(error("whenever"), /didn't catch "whenever"/);
  assert.match(error("at 7:60"), /didn't catch "7:60"/);
  assert.match(error("first monday 09:00"), /not yet — say the date/);
  assert.match(error("tonight 06:00"), /has passed today/, "an exact time keeps no evening twin");
  assert.match(error("morning"), /didn't catch a time/);
});

test("SL-16: the night keeps its small hours: two at night is 02:00, never 14:00", () => {
  assert.equal(words("every night at two"), "daily 02:00");
  assert.equal(words("nightly at 2"), "daily 02:00");
  assert.equal(words("every night at one"), "daily 01:00");
  assert.equal(words("every night at eleven"), "daily 23:00");
  assert.equal(words("nightly at 12"), "daily 00:00");
  assert.equal(words("every night at 11:30"), "daily 23:30");
  assert.equal(words("at two at night"), "02:00 · Tue 6 Oct");
  assert.equal(words("half past twelve at night"), "00:30 · Tue 6 Oct");
  assert.equal(words("every night at 2am"), "daily 02:00");
  assert.equal(words("every night at 11pm"), "daily 23:00");
});

test("SL-16: a named day's night runs into the next morning: 'tomorrow night at 2' said on Monday is Wednesday 02:00, 'tonight at 1' is Tuesday 01:00", () => {
  assert.equal(words("tomorrow night at 2"), "02:00 · Wed 7 Oct");
  assert.equal(words("tomorrow night at 11"), "23:00 · Tue 6 Oct");
  assert.equal(words("tonight at 1"), "01:00 · Tue 6 Oct");
  assert.equal(words("tonight at midnight"), "00:00 · Tue 6 Oct");
  assert.equal(words("tonight at 12"), "00:00 · Tue 6 Oct", "tonight's twelve is midnight, not noon");
  assert.equal(words("tonight at 7:30"), "19:30 · Mon 5 Oct");
  assert.equal(words("this evening at 12"), "00:00 · Tue 6 Oct");
});

test("SL-16: 'this morning' and 'this evening' are today's: a time already gone is refused, as before", () => {
  const error = (p: string, now: number): string => {
    const w = parseWhen(p, now);
    assert.ok("error" in w, `"${p}" is refused`);
    return w.error;
  };
  assert.match(error("this evening at 7", local(2026, 10, 5, 21, 0)), /19:00 has passed today/);
  assert.match(error("this evening at seven", local(2026, 10, 5, 21, 0)), /19:00 has passed today/);
  assert.match(error("this morning at 7", local(2026, 10, 5, 9, 0)), /07:00 has passed today/);
  assert.equal(words("this evening at 7"), "19:00 · Mon 5 Oct");
  assert.equal(words("this morning at 7"), "07:00 · Mon 5 Oct");
  assert.equal(words("this evening at 7:10"), "19:10 · Mon 5 Oct");
  assert.equal(words("evening at 7", local(2026, 10, 5, 21, 0)), "19:00 · Tue 6 Oct", "no 'this': the next evening's seven");
});

test("SL-16: a part of the day never moves a 24-hour time or an am/pm; one outside the part is refused", () => {
  const error = (p: string): string => {
    const w = parseWhen(p, MON_0600);
    assert.ok("error" in w, `"${p}" is refused`);
    return w.error;
  };
  assert.match(error("07:10 this evening"), /07:10 and 'evening' don't go together; say one/);
  assert.match(error("this evening 07:10"), /07:10 and 'evening' don't go together/);
  assert.match(error("nightly 07:00"), /07:00 and 'nightly' don't go together/);
  assert.match(error("every evening at 7am"), /07:00 and 'evening' don't go together/);
  assert.match(error("every morning at 19:00"), /19:00 and 'morning' don't go together/);
  assert.equal(words("every evening at 19:30"), "daily 19:30");
  assert.equal(words("nightly 23:00"), "daily 23:00");
  assert.equal(words("this evening 0:15"), "00:15 · Tue 6 Oct", "a 24-hour midnight hour is this evening's own, the night after it");
  assert.equal(words("every morning at 06:30"), "daily 06:30");
});

/** The refusal for a phrase said at `now`. */
function refused(p: string, now = MON_0600): string {
  const w = parseWhen(p, now);
  assert.ok("error" in w, `"${p}" is refused, not ${"error" in w ? "" : describe(w)}`);
  return w.error;
}

test("SL-16 (review): tonight keeps main's evening reading: 'tonight at 5' and 'at five tonight' are 17:00 today, 'tonight at four' 16:00", () => {
  assert.equal(words("tonight at 5"), "17:00 · Mon 5 Oct");
  assert.equal(words("at 5 tonight"), "17:00 · Mon 5 Oct");
  assert.equal(words("at five tonight"), "17:00 · Mon 5 Oct");
  assert.equal(words("tonight at four"), "16:00 · Mon 5 Oct");
  assert.equal(words("tonight at 4:30"), "16:30 · Mon 5 Oct");
  assert.equal(words("tonight at six"), "18:00 · Mon 5 Oct");
  assert.match(refused("tonight at 5", local(2026, 10, 5, 18, 0)), /17:00 has passed today/, "never moved to 05:00 the next morning");
  // The night's own hours: twelve is midnight, one to three the small hours after it.
  assert.equal(words("tonight at three"), "03:00 · Tue 6 Oct");
  assert.equal(words("tonight at 3:30"), "03:30 · Tue 6 Oct");
  assert.equal(words("tonight at two"), "02:00 · Tue 6 Oct");
  assert.equal(words("tonight at 12:30"), "00:30 · Tue 6 Oct");
  assert.equal(words("tonight at 5am"), "05:00 · Tue 6 Oct", "an am said is what it says");
});

test("SL-16 (review): four or five at night could be either side of dawn, so it is refused with both readings", () => {
  assert.match(refused("every night at five"), /^5 at night could be 05:00 or 17:00; say which$/);
  assert.match(refused("every night at four"), /^4 at night could be 04:00 or 16:00; say which$/);
  assert.match(refused("nightly at 4:30"), /^4:30 at night could be 04:30 or 16:30; say which$/);
  assert.match(refused("tomorrow night at 5"), /5 at night could be 05:00 or 17:00/);
  assert.match(refused("at five at night"), /5 at night could be 05:00 or 17:00/);
  assert.equal(words("every night at 5am"), "daily 05:00");
  assert.equal(words("nightly 04:30"), "daily 04:30");
  assert.equal(words("every night at three"), "daily 03:00");
  assert.equal(words("every night at six"), "daily 18:00");
  assert.equal(words("every evening at 5"), "daily 17:00", "the evening keeps its p.m.");
});

test("SL-16 (review): a named day's night runs into the next day: saturday night at midnight is sun 00:00", () => {
  assert.equal(words("every saturday night at midnight"), "sun 00:00");
  assert.equal(words("saturday night at 12"), "sun 00:00");
  assert.equal(words("saturday evening at 12"), "sun 00:00");
  assert.equal(words("friday night at 2"), "sat 02:00");
  assert.equal(words("every friday night at 1"), "sat 01:00");
  assert.equal(words("every friday night at 1am"), "sat 01:00");
  assert.equal(words("weekends nights at 1"), "mon,sun 01:00");
  assert.equal(words("weekend nights at 1"), "mon,sun 01:00");
  assert.equal(words("weekday nights at 1"), "tue,wed,thu,fri,sat 01:00");
  assert.equal(words("sunday night at 1"), "mon 01:00");
  assert.equal(words("every night at 2"), "daily 02:00", "every night is every night");
  // Before midnight the day is the one named; with no part, the day's own small hours.
  assert.equal(words("sunday night at 11"), "sun 23:00");
  assert.equal(words("friday night at 11:30"), "fri 23:30");
  assert.equal(words("every saturday at midnight"), "sat 00:00");
  assert.equal(words("saturday at 1am"), "sat 01:00");
});

test("SL-16 (review): a range is refused, never read as a clock: '9 to 5' is not 04:51", () => {
  assert.match(refused("weekdays 7 to 9"), /^"7 to 9" is a range, not a time; say one time$/);
  assert.match(refused("every day 9 to 5"), /"9 to 5" is a range/);
  assert.match(refused("at 7 to 9"), /"7 to 9" is a range/);
  assert.match(refused("9 before 5"), /"9 before 5" is a range/);
  assert.match(refused("15 to 8"), /"15 to 8" is a range/);
  assert.match(refused("at 7 to 9pm"), /"7 to 9pm" is a range/);
  // A clock's own minutes before the hour still read.
  assert.equal(words("five to nine"), "08:55 · Mon 5 Oct");
  assert.equal(words("ten to eight"), "07:50 · Mon 5 Oct");
  assert.equal(words("twenty to nine"), "08:40 · Mon 5 Oct");
  assert.equal(words("twenty five to nine"), "08:35 · Mon 5 Oct");
  assert.equal(words("quarter to eight"), "07:45 · Mon 5 Oct");
  assert.equal(words("13 minutes to 8"), "07:47 · Mon 5 Oct");
  assert.equal(words("ten minutes past seven"), "07:10 · Mon 5 Oct");
  assert.equal(words("9 past 5"), "17:09 · Mon 5 Oct", "past and after take any minute");
});

test("SL-16 (review): a count is refused, never read as the clock: 'every 2 nights' is not 02:00 daily", () => {
  assert.match(refused("every 2 nights"), /^"every 2 nights" is a count, not a time; say one, like "daily 23:00" or "every 2 h"$/);
  assert.match(refused("every 3 mornings"), /"every 3 mornings" is a count/);
  assert.match(refused("every two nights"), /"every 2 nights" is a count/);
  assert.match(refused("every 2 days"), /"every 2 days" is a count/);
  assert.match(refused("every 2 weeks"), /"every 2 weeks" is a count/);
  assert.match(refused("every 2 mondays"), /"every 2 mondays" is a count/);
  assert.match(refused("2 nights"), /"2 nights" is a count/);
  assert.match(refused("every 9"), /"every 9" is a count/);
  // An hour said after every, with its am/pm, its minutes or the words around it, is every day's.
  assert.equal(words("every 7am"), "daily 07:00");
  assert.equal(words("every 7 am"), "daily 07:00");
  assert.equal(words("every 7:10"), "daily 07:10");
  assert.equal(words("every 9 on weekdays"), "weekdays 09:00");
  assert.equal(words("every 9 at night"), "daily 21:00");
  assert.equal(words("every 2 hours"), "every 2 h");
});

test("SL-18: the cost line says how the brain is paid for", () => {
  assert.equal(costLine({ steps: 8, seconds: 120 }, 5, false), "this wakes the brain — not the voice — while Jarhead is asleep: about 2 brain minutes per fire on your plan, up to 5 a day; its one-line answer is spoken by the local speaker / shown as a banner");
  assert.equal(costLine({ steps: 8, seconds: 120 }, 5, false, "plan"), costLine({ steps: 8, seconds: 120 }, 5, false));
  assert.equal(costLine({ steps: 8, seconds: 120 }, 5, false, "key"), "this wakes the brain — not the voice — while Jarhead is asleep: about 2 brain minutes per fire billed as API tokens on your key, up to 5 a day; its one-line answer is spoken by the local speaker / shown as a banner");
  assert.equal(costLine({ steps: 8, seconds: 120 }, 5, false, "server"), "this wakes the brain — not the voice — while Jarhead is asleep: about 2 brain minutes per fire on the server you set, up to 5 a day; its one-line answer is spoken by the local speaker / shown as a banner");
  assert.match(costLine({ steps: 8, seconds: 61 }, 5, true, "key"), /per fire a model warm-up on this Mac/, "a local model is never billed");
  const ctx = (paid: "key" | "server" | undefined) => ({
    when: { kind: "at", at: MON_0600 + 3_600_000 } as AutomationWhen,
    then: [{ kind: "wake-brain", prompt: "summarise", budget: { steps: 8, seconds: 120 } }] as never,
    clauses: { quiet: "respect" } as const,
    settings: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain" as const], wakeBudgetMinutesPerDay: 5 },
    confirmed: false,
    folderWatchers: 0,
    paid,
  });
  assert.equal(classifyAutomation(ctx("key")).reason, costLine({ steps: 8, seconds: 120 }, 5, false, "key"));
  assert.equal(classifyAutomation(ctx("server")).reason, costLine({ steps: 8, seconds: 120 }, 5, false, "server"));
  assert.equal(classifyAutomation(ctx(undefined)).reason, costLine({ steps: 8, seconds: 120 }, 5, false));
});
