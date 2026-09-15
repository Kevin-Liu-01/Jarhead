import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutomationWhen, ClockTime } from "@jarhead/protocol";
import { PARSE_LEAD_MS, atClock, clockOf, describe, graceFor, inQuiet, inWindow, nextFire, parseWhen, quietEnds, snoozeDefault, weekdayOf } from "../schedule.ts";

// Every date here is local, so the zone is pinned to one with DST for the whole file: Node re-reads
// TZ when process.env.TZ is assigned (node --test runs each file in its own process). New York in
// 2026: clocks spring forward Sun 8 Mar 02:00 → 03:00 and fall back Sun 1 Nov 02:00 → 01:00.
process.env.TZ = "America/New_York";

/** A local instant: year, month (1–12), day, hour, minute, second. */
const local = (y: number, mo: number, d: number, hh: number, mm: number, ss = 0): number => new Date(y, mo - 1, d, hh, mm, ss, 0).getTime();
/** Mon 14 Sep 2026, 09:00 local — the day this was written. */
const MON_0900 = local(2026, 9, 14, 9, 0);

function when(p: string, now = MON_0900): AutomationWhen {
  const w = parseWhen(p, now);
  assert.ok(!("error" in w), `"${p}" parses: ${"error" in w ? w.error : ""}`);
  return w;
}
function error(p: string, now = MON_0900): string {
  const w = parseWhen(p, now);
  assert.ok("error" in w, `"${p}" is refused`);
  return w.error;
}

test("the zone is pinned: New York keeps DST in July and not in January", () => {
  assert.equal(new Date(2026, 6, 1).getTimezoneOffset(), 240);
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), 300);
  assert.equal(weekdayOf(MON_0900), "mon");
  assert.equal(clockOf(MON_0900), "09:00");
});

// ----------------------------------------------------------------- the phrase table

test("the phrase table, pass 1: each phrase and the row it normalises to", () => {
  assert.deepEqual(when("7:10"), { kind: "at", at: local(2026, 9, 15, 7, 10) }, "a colon form is the hour it says: 07:10 has passed at 09:00, so tomorrow's");
  assert.deepEqual(when("tomorrow 07:10"), { kind: "at", at: local(2026, 9, 15, 7, 10) });
  assert.deepEqual(when("in 12 minutes"), { kind: "in", ms: 12 * 60_000 });
  assert.deepEqual(when("weekdays 09:00"), { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "09:00" }, phrase: "weekdays 09:00" });
  assert.deepEqual(when("daily 18:00"), { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "18:00" }, phrase: "daily 18:00" });
  assert.deepEqual(when("weekends 10:30"), { kind: "every", every: { kind: "weekly", days: ["sat", "sun"], at: "10:30" }, phrase: "weekends 10:30" });
  assert.deepEqual(when("mon,wed 07:10"), { kind: "every", every: { kind: "weekly", days: ["mon", "wed"], at: "07:10" }, phrase: "mon,wed 07:10" });
  assert.deepEqual(when("every 2 h"), { kind: "every", every: { kind: "interval", everyMs: 2 * 3_600_000, anchorAt: MON_0900 }, phrase: "every 2 h" });
  assert.deepEqual(when("every 45 min"), { kind: "every", every: { kind: "interval", everyMs: 45 * 60_000, anchorAt: MON_0900 }, phrase: "every 45 min" });
});

test("the same phrases in Kevin's words: 'at', 'every', full day names, am/pm, 'and' and commas all normalise to the same rows", () => {
  assert.deepEqual(when("at 7:10 tomorrow"), when("tomorrow 07:10"));
  assert.deepEqual(when("every weekday at 9am"), when("weekdays 09:00"));
  assert.deepEqual(when("every day at 6pm"), when("daily 18:00"));
  assert.deepEqual(when("monday and wednesday at 7:10"), when("mon,wed 07:10"));
  assert.deepEqual(when("Mondays, Wednesdays 07:10"), when("mon,wed 07:10"));
  assert.deepEqual(when("every 2 hours"), when("every 2 h"));
  assert.deepEqual(when("every 45 minutes"), when("every 45 min"));
  assert.deepEqual(when("in 2 hours"), { kind: "in", ms: 2 * 3_600_000 });
  assert.deepEqual(when("in an hour and 30 minutes"), { kind: "in", ms: 90 * 60_000 });
  assert.deepEqual(when("in 90 seconds"), { kind: "in", ms: 90_000 });
  assert.deepEqual(when("weekdays 12:00"), when("weekdays noon"));
  assert.deepEqual(when("daily 00:00"), when("every day at midnight"));
  assert.deepEqual(when("weekends 7pm"), { kind: "every", every: { kind: "weekly", days: ["sat", "sun"], at: "19:00" }, phrase: "weekends 19:00" });
});

test("an ambiguous 'at seven' is the next seven at least a minute away: 19:00 today from 09:00, 07:00 today from 06:58, tomorrow's 07:00 from 06:59:30", () => {
  assert.deepEqual(when("at seven"), { kind: "at", at: local(2026, 9, 14, 19, 0) });
  assert.deepEqual(when("at 7"), { kind: "at", at: local(2026, 9, 14, 19, 0) });
  assert.deepEqual(when("at seven", local(2026, 9, 14, 6, 58)), { kind: "at", at: local(2026, 9, 14, 7, 0) });
  assert.deepEqual(when("at seven", local(2026, 9, 14, 6, 59, 30)), { kind: "at", at: local(2026, 9, 14, 19, 0) }, "07:00 is 30 s away, under the minute's lead; the next seven is 19:00");
  assert.deepEqual(when("7am", local(2026, 9, 14, 6, 59, 30)), { kind: "at", at: local(2026, 9, 15, 7, 0) }, "am said: 07:00 exactly, and today's is too close");
  assert.deepEqual(when("7:10", local(2026, 9, 14, 7, 9)), { kind: "at", at: local(2026, 9, 14, 7, 10) }, "a minute ahead is enough");
  assert.deepEqual(when("7:10", local(2026, 9, 14, 7, 9, 1)), { kind: "at", at: local(2026, 9, 15, 7, 10) }, "59 s ahead is tomorrow's");
  assert.equal(PARSE_LEAD_MS, 60_000);
  assert.deepEqual(when("today 19:00"), { kind: "at", at: local(2026, 9, 14, 19, 0) });
  assert.match(error("today 07:10"), /has passed today/);
});

test("a bare hour with today / tonight / this evening: 'tonight at seven' is 19:00 today, 'today at nine' said at 14:00 is 21:00 (and 09:00 from 06:00), 'this evening at 8' is 20:00, 'tomorrow at seven' stays 07:00; an exact time on a named day is what it says", () => {
  assert.deepEqual(when("tonight at seven"), { kind: "at", at: local(2026, 9, 14, 19, 0) });
  assert.deepEqual(when("tonight at 8"), { kind: "at", at: local(2026, 9, 14, 20, 0) });
  assert.deepEqual(when("tonight at 11"), { kind: "at", at: local(2026, 9, 14, 23, 0) });
  assert.deepEqual(when("this evening at 8"), { kind: "at", at: local(2026, 9, 14, 20, 0) });
  assert.deepEqual(when("today at nine", local(2026, 9, 14, 14, 0)), { kind: "at", at: local(2026, 9, 14, 21, 0) });
  assert.deepEqual(when("today at nine", local(2026, 9, 14, 6, 0)), { kind: "at", at: local(2026, 9, 14, 9, 0) }, "the earliest twin still ahead");
  assert.deepEqual(when("today at 9"), { kind: "at", at: local(2026, 9, 14, 21, 0) }, "09:00 is now: under the minute's lead, so 21:00");
  assert.deepEqual(when("tomorrow at seven"), { kind: "at", at: local(2026, 9, 15, 7, 0) });
  assert.deepEqual(when("tonight at 7pm"), { kind: "at", at: local(2026, 9, 14, 19, 0) });
  assert.match(error("tonight 07:00"), /07:00 has passed today/, "a colon form is exact: no evening twin");
  assert.match(error("today at nine", local(2026, 9, 14, 21, 30)), /21:00 has passed today/, "both twins gone: the refusal names the last one tried");
  assert.match(error("tonight at seven", local(2026, 9, 14, 19, 30)), /19:00 has passed today/);
});

test("refusals name the word they did not catch; monthly is 'not yet — say the date'; too-short intervals, a missing time and a bare 'weekdays' are refused", () => {
  assert.match(error(""), /say when/);
  assert.match(error("   "), /say when/);
  assert.match(error("first monday 09:00"), /not yet — say the date/);
  assert.match(error("monthly 09:00"), /not yet — say the date/);
  assert.match(error("on the 15th at 9"), /not yet — say the date/);
  assert.match(error("weekdays"), /say a time too/);
  assert.match(error("every 30 s"), /at least a minute/);
  assert.match(error("every 0 min"), /at least a minute/);
  assert.match(error("in 0 seconds"), /at least a second/);
  assert.match(error("in a while"), /didn't catch the duration/);
  assert.match(error("at 25:00"), /didn't catch "25:00"/);
  assert.match(error("at 7:60"), /didn't catch "7:60"/);
  assert.match(error("whenever"), /didn't catch "whenever"/);
  assert.match(error("at 7 and at 8"), /two times/);
  assert.match(error("tomorrow monday 07:10"), /don't go together/);
});

// ----------------------------------------------------------------- nextFire

const weekly = (days: readonly ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[], at: ClockTime): AutomationWhen => ({ kind: "every", every: { kind: "weekly", days, at }, phrase: "" });
const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

test("a weekday 17:00 weekly asked one second after Friday 17:00 is Monday 17:00; asked at 16:59:59 it is that Friday", () => {
  const w = weekly(["mon", "tue", "wed", "thu", "fri"], "17:00");
  assert.equal(weekdayOf(local(2026, 9, 18, 17, 0)), "fri");
  assert.equal(nextFire(w, local(2026, 9, 18, 17, 0, 1), 0), local(2026, 9, 21, 17, 0));
  assert.equal(nextFire(w, local(2026, 9, 18, 16, 59, 59), 0), local(2026, 9, 18, 17, 0));
  assert.equal(nextFire(w, local(2026, 9, 18, 17, 0, 0), 0), local(2026, 9, 21, 17, 0), "strictly after: the instant itself is not next");
  assert.equal(nextFire(weekly(["sun"], "10:30"), MON_0900, 0), local(2026, 9, 20, 10, 30), "a single day walks the week");
  assert.equal(nextFire(weekly([], "10:30"), MON_0900, 0), undefined, "no days: nothing ahead");
});

test("DST spring-forward: a daily 02:30 on 8 Mar 2026 has no such minute and fires at 03:00 EDT once; the day after it is 02:30 again", () => {
  const w = weekly(ALL, "02:30");
  const fire = nextFire(w, local(2026, 3, 7, 12, 0), 0);
  assert.ok(fire !== undefined);
  const d = new Date(fire);
  assert.equal(d.getDate(), 8);
  assert.equal(`${d.getHours()}:${d.getMinutes()}`, "3:0", "rolled to the first minute after the gap, not 03:30");
  assert.equal(d.getTimezoneOffset(), 240, "already on daylight time");
  assert.equal(fire, Date.UTC(2026, 2, 8, 7, 0), "03:00 EDT is 07:00 UTC");
  const next = nextFire(w, fire, 0);
  assert.ok(next !== undefined);
  assert.equal(new Date(next).getDate(), 9);
  assert.equal(clockOf(next), "02:30");
  assert.equal(next - fire, 23.5 * 3_600_000, "the day after the gap is 23 h 30 min from 03:00");
  // The clock face is what stays put: 07:10 is 07:10 on both sides of the change (23 h apart that night).
  const seven = weekly(ALL, "07:10");
  const before = nextFire(seven, local(2026, 3, 7, 0, 0), 0);
  const after = before === undefined ? undefined : nextFire(seven, before, 0);
  assert.ok(before !== undefined && after !== undefined);
  assert.equal(clockOf(before), "07:10");
  assert.equal(clockOf(after), "07:10");
  assert.equal(after - before, 23 * 3_600_000);
});

test("DST fall-back: a daily 01:30 on 1 Nov 2026 happens twice and fires once, on the first (EDT); the next is 2 Nov 01:30 EST, 25 h later", () => {
  const w = weekly(ALL, "01:30");
  const fire = nextFire(w, local(2026, 10, 31, 12, 0), 0);
  assert.ok(fire !== undefined);
  assert.equal(fire, Date.UTC(2026, 10, 1, 5, 30), "01:30 EDT is 05:30 UTC — the first of the two");
  const next = nextFire(w, fire, 0);
  assert.ok(next !== undefined);
  assert.equal(next, Date.UTC(2026, 10, 2, 6, 30), "the second 01:30 (EST, 06:30 UTC) is skipped; next is the following day");
  assert.equal(next - fire, 25 * 3_600_000);
  assert.equal(clockOf(next), "01:30");
  // Asked from inside the repeated hour (01:45 EST, after the second 01:30) the answer is still tomorrow's.
  assert.equal(nextFire(w, Date.UTC(2026, 10, 1, 6, 45), 0), Date.UTC(2026, 10, 2, 6, 30));
});

test("an interval is anchorAt + k·everyMs: anchored five hours back with every 2 h the next is anchor + 6 h; a future anchor is itself; a zero interval never", () => {
  const anchor = MON_0900 - 5 * 3_600_000;
  const w: AutomationWhen = { kind: "every", every: { kind: "interval", everyMs: 2 * 3_600_000, anchorAt: anchor }, phrase: "every 2 h" };
  assert.equal(nextFire(w, MON_0900, 0), anchor + 6 * 3_600_000);
  assert.equal(nextFire(w, anchor, 0), anchor + 2 * 3_600_000, "at the anchor itself the next is one step on");
  assert.equal(nextFire(w, anchor - 1, 0), anchor, "a future anchor fires first");
  assert.equal(nextFire({ kind: "every", every: { kind: "interval", everyMs: 0, anchorAt: anchor }, phrase: "" }, MON_0900, 0), undefined);
});

test("one-shots: `at` once and never after its instant; `in` is createdAt + ms once; `on` has no clock", () => {
  assert.equal(nextFire({ kind: "at", at: MON_0900 + 5 }, MON_0900, 0), MON_0900 + 5);
  assert.equal(nextFire({ kind: "at", at: MON_0900 }, MON_0900, 0), undefined);
  assert.equal(nextFire({ kind: "in", ms: 12 * 60_000 }, MON_0900, MON_0900 - 60_000), MON_0900 + 11 * 60_000);
  assert.equal(nextFire({ kind: "in", ms: 12 * 60_000 }, MON_0900 + 13 * 60_000, MON_0900), undefined, "a timer that is up has nothing ahead");
  assert.equal(nextFire({ kind: "on", on: { kind: "app.quit", app: "Slack" } }, MON_0900, 0), undefined);
});

test("the pass-2 recurrences are typed and computable so the wire holds: the last Friday of the month, the 31st skips short months", () => {
  const lastFri: AutomationWhen = { kind: "every", every: { kind: "monthly", nth: -1, weekday: "fri", at: "17:00" }, phrase: "" };
  assert.equal(nextFire(lastFri, MON_0900, 0), local(2026, 9, 25, 17, 0));
  const firstMon: AutomationWhen = { kind: "every", every: { kind: "monthly", nth: 1, weekday: "mon", at: "09:00" }, phrase: "" };
  assert.equal(nextFire(firstMon, MON_0900, 0), local(2026, 10, 5, 9, 0));
  const day31: AutomationWhen = { kind: "every", every: { kind: "monthday", day: 31, at: "09:00" }, phrase: "" };
  assert.equal(nextFire(day31, MON_0900, 0), local(2026, 10, 31, 9, 0), "September has 30 days; October the 31st is next");
  assert.match(describe(lastFri), /last Fri of the month 17:00/);
  assert.match(describe(day31), /31st of the month 09:00/);
});

test("atClock resolves a clock on a date: an ordinary minute as-is, the skipped 02:30 as 03:00", () => {
  assert.equal(atClock(new Date(2026, 8, 14), "07:10"), local(2026, 9, 14, 7, 10));
  assert.equal(atClock(new Date(2026, 2, 8), "02:30"), Date.UTC(2026, 2, 8, 7, 0));
  assert.equal(atClock(new Date(2026, 2, 8), "02:00"), Date.UTC(2026, 2, 8, 7, 0), "02:00 itself is skipped too");
  assert.equal(atClock(new Date(2026, 2, 8), "03:00"), Date.UTC(2026, 2, 8, 7, 0));
  assert.equal(atClock(new Date(2026, 2, 8), "01:59"), Date.UTC(2026, 2, 8, 6, 59));
});

// ----------------------------------------------------------------- describe

test("describe round-trips every recurrence phrase and the one-shots' words", () => {
  for (const p of ["weekdays 09:00", "daily 18:00", "weekends 10:30", "mon,wed 07:10", "every 2 h", "every 45 min", "in 12 min", "in 2 h", "in 1 min 30 s", "in 45 s"]) {
    const w = when(p);
    assert.equal(describe(w), p, `describe keeps "${p}"`);
    assert.deepEqual(parseWhen(describe(w), MON_0900), w, `"${p}" round-trips`);
  }
  assert.equal(describe(when("every weekday at 9am")), "weekdays 09:00", "the phrase kept is the normalised one");
  assert.equal(describe(when("in an hour and 30 minutes")), "in 1 h 30 min");
  assert.equal(describe(when("in 90 seconds")), "in 1 min 30 s", "seconds past a minute read as minutes and seconds");
  assert.equal(describe(when("tomorrow 07:10")), "07:10 · Tue 15 Sep");
  assert.equal(describe({ kind: "on", on: { kind: "folder.file", path: "~/Downloads", glob: "*.pdf" } }), "when a file lands in ~/Downloads (*.pdf)");
  assert.equal(describe({ kind: "on", on: { kind: "app.quit", app: "Slack" } }), "when Slack quits");
  assert.equal(describe({ kind: "on", on: { kind: "recipe.red", recipe: "tests", everySeconds: 60 } }), "when recipe tests goes red (checked every 60 s)");
  assert.equal(describe({ kind: "on", on: { kind: "agent.status", status: "blocked" } }), "when an agent is blocked");
  assert.equal(describe({ kind: "on", on: { kind: "mac.wake" } }), "when the Mac wakes");
});

// ----------------------------------------------------------------- quiet hours, window

test("inQuiet wraps midnight: 22:00–07:00 holds 23:00, 03:00 and 22:00 itself, not 07:00 or noon; quietEnds is the 07:00 ahead; none set = never quiet", () => {
  const q = { from: "22:00", to: "07:00" } as const;
  assert.equal(inQuiet(q, local(2026, 9, 14, 23, 0)), true);
  assert.equal(inQuiet(q, local(2026, 9, 14, 3, 0)), true);
  assert.equal(inQuiet(q, local(2026, 9, 14, 22, 0)), true, "from is inclusive");
  assert.equal(inQuiet(q, local(2026, 9, 14, 7, 0)), false, "to is exclusive");
  assert.equal(inQuiet(q, local(2026, 9, 14, 12, 0)), false);
  assert.equal(quietEnds(q, local(2026, 9, 14, 3, 0)), local(2026, 9, 14, 7, 0));
  assert.equal(quietEnds(q, local(2026, 9, 14, 23, 0)), local(2026, 9, 15, 7, 0));
  assert.equal(quietEnds(q, local(2026, 9, 14, 12, 0)), undefined, "not quiet: nothing ends");
  assert.equal(inQuiet(undefined, local(2026, 9, 14, 3, 0)), false);
  assert.equal(quietEnds(undefined, local(2026, 9, 14, 3, 0)), undefined);
  const day = { from: "13:00", to: "14:00" } as const;
  assert.equal(inQuiet(day, local(2026, 9, 14, 13, 30)), true);
  assert.equal(inQuiet(day, local(2026, 9, 14, 14, 0)), false);
  assert.equal(inQuiet({ from: "09:00", to: "09:00" }, local(2026, 9, 14, 9, 0)), false, "an empty span is no quiet at all");
});

test("inWindow: no clauses admit everything; a 09:00–17:00 window holds noon and not 17:00; a wrapped window holds 23:00; days narrow it", () => {
  assert.equal(inWindow({}, MON_0900), true);
  const office = { window: { from: "09:00", to: "17:00" } } as const;
  assert.equal(inWindow(office, local(2026, 9, 14, 12, 0)), true);
  assert.equal(inWindow(office, local(2026, 9, 14, 17, 0)), false);
  assert.equal(inWindow(office, local(2026, 9, 14, 8, 59)), false);
  assert.equal(inWindow({ window: { from: "22:00", to: "06:00" } }, local(2026, 9, 14, 23, 0)), true);
  assert.equal(inWindow({ days: ["sat", "sun"] }, MON_0900), false);
  assert.equal(inWindow({ days: ["mon"] }, MON_0900), true);
  assert.equal(inWindow({ days: ["mon"], window: { from: "10:00", to: "11:00" } }, MON_0900), false, "the right day, outside the window");
});

test("graceFor is the contract's table and snoozeDefault is 5 for a timer, the setting for the rest", () => {
  assert.equal(graceFor("alarm"), 15 * 60_000);
  assert.equal(graceFor("timer"), 10 * 60_000);
  assert.equal(graceFor("reminder"), 60 * 60_000);
  assert.equal(graceFor("routine"), 0);
  assert.equal(graceFor("watcher"), 0);
  assert.equal(snoozeDefault("timer", 10), 5);
  assert.equal(snoozeDefault("alarm", 10), 10);
  assert.equal(snoozeDefault("reminder", 30), 30);
  assert.equal(snoozeDefault("routine", 10), 10);
  assert.equal(snoozeDefault("watcher", 10), 10);
});
