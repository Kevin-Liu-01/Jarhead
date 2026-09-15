import { test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTOMATIONS, type Automation, type AutomationDraft, type LedgerRow, type ShellRecipe } from "@jarhead/protocol";
import { describe } from "@jarhead/core";
import { automationLine, AUTOMATION_STATES, LIST_STATES, ROW_VERBS, automationGlyph, automationsLines, automationsSummary, byStateWords, filterByState, inWords, parseClockAutomation, parseRecipeArgs, recipeVerdict, recipesLines, resolveAutomation } from "../automations-cli.ts";
import { automationChecks, pmsetCopy, readAutomationLedger, readJournal, type AutomationCheckInput, type Check } from "../doctor.ts";

/**
 * `jarhead automations`, `jarhead recipes`, the `automations` line of `jarhead status` and the
 * doctor's `automations` group, without a daemon: the renderer's exact lines, the clock ladder
 * `add` parses (free kinds only — the asking kinds are refused here by name), the resolver's
 * rules (id first, a live name before a lingering one, any `auto_…` passes through so Restore
 * can name a trashed row), the shell gate's word for a recipe, and every doctor row as a
 * function of one fixture input. A spy on child_process pins that nothing here spawns: the
 * `pmset` line is text the doctor prints for Kevin to copy, never a command it runs.
 */

const HOME = "/Users/kevin";
// A fixed instant: the renderer's "in 6 h" words are relative, so nothing here depends on the zone.
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const H = 3_600_000;

const row = (over: Partial<Automation> & Pick<Automation, "id" | "name" | "when" | "then">): Automation => ({
  clauses: { quiet: "respect" },
  echo: "",
  state: "armed",
  fires: 0,
  missed: 0,
  createdAt: NOW - 24 * H,
  updatedAt: NOW - H,
  createdBy: { by: "brain", request: "" },
  ...over,
});

const wakeUp = row({ id: "auto_1", name: "Wake up, Kevin", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "07:10" }, phrase: "weekdays 07:10" }, then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }, { kind: "say", line: "Wake up, Kevin" }], clauses: { quiet: "override" }, nextAt: NOW + 6 * H });
const pasta = row({ id: "auto_2", name: "pasta", when: { kind: "in", ms: 12 * 60_000 }, then: [{ kind: "chime", line: "pasta" }], nextAt: NOW + 4 * 60_000 + 12_000 });
const standup = row({ id: "auto_3", name: "standup notes", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "09:00" }, phrase: "weekdays 09:00" }, then: [{ kind: "open", app: "Notes" }], state: "paused" });
const papers = row({ id: "auto_4", name: "file papers", when: { kind: "on", on: { kind: "folder.file", path: "~/Downloads", glob: "*.pdf" } }, then: [{ kind: "file", into: "~/Papers" }, { kind: "chime", line: "filed" }] });
const backup = row({ id: "auto_5", name: "backup", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], at: "23:00" }, phrase: "daily 23:00" }, then: [{ kind: "run-recipe", recipe: "backup" }], state: "failed", lastDetail: "recipe exit 1", nextAt: NOW + 11 * H });
const oldPasta = row({ id: "auto_0", name: "Pasta", when: { kind: "in", ms: 600_000 }, then: [{ kind: "chime", line: "pasta" }], state: "done" });
const table: Automation[] = [pasta, wakeUp, backup, standup, papers, oldPasta];
const pointers = { nextFire: { id: "auto_2", kind: "timer" as const, name: "pasta", at: pasta.nextAt ?? 0 } };

// The spy: every execFileSync / spawn the doctor's module could reach goes through the CommonJS export. Nothing under test spawns anything.
const spawned: string[] = [];
const realExecFileSync = cp.execFileSync;
cp.execFileSync = ((file: string, args?: readonly string[]) => {
  spawned.push([file, ...(args ?? [])].join(" "));
  return realExecFileSync(file, args as string[], { encoding: "utf8" });
}) as typeof cp.execFileSync;
const realSpawn = cp.spawn;
cp.spawn = ((file: string, args?: readonly string[]) => {
  spawned.push([file, ...(args ?? [])].join(" "));
  return realSpawn(file, args as string[]);
}) as typeof cp.spawn;
syncBuiltinESMExports();

test("the vocabulary pins: every AutomationState is listed, `all` joins it for --state, the row verbs are the nine that are never a deletion", () => {
  assert.deepEqual(AUTOMATION_STATES, ["armed", "snoozed", "firing", "fired", "deferred", "paused", "done", "failed", "trashed"]);
  assert.deepEqual(LIST_STATES, [...AUTOMATION_STATES, "all"]);
  assert.deepEqual(ROW_VERBS, ["snooze", "done", "skip", "pause", "resume", "rename", "run", "trash", "restore"]);
  assert.ok(!ROW_VERBS.some((v) => /delet/i.test(v)), "the trash rule: Move to Trash, never Delete");
  assert.deepEqual((["alarm", "timer", "reminder", "routine", "watcher"] as const).map(automationGlyph), ["⏰", "⏳", "🔔", "↻", "👁"]);
});

test("inWords: seconds, minutes, hours, days — and `now` for an instant behind", () => {
  assert.equal(inWords(NOW + 45_000, NOW), "in 45 s");
  assert.equal(inWords(NOW + 12 * 60_000, NOW), "in 12 min");
  assert.equal(inWords(NOW + 6 * H, NOW), "in 6 h");
  assert.equal(inWords(NOW + 3 * 24 * H, NOW), "in 3 d");
  assert.equal(inWords(NOW - 1, NOW), "now");
});

test("automationsLines: the summary line, then one row each — glyph · name · when · actions · id · what it waits for; the states count in vocabulary order", () => {
  assert.equal(byStateWords(table), "3 armed · 1 paused · 1 done · 1 failed");
  assert.equal(automationsSummary(table, pointers, NOW), "  automations 6 (3 armed · 1 paused · 1 done · 1 failed) · next 12:00 pasta (in 4 min)".replace("12:00", clock(pasta.nextAt ?? 0)) + " · ringing: —");
  assert.deepEqual(automationsLines(table, pointers, NOW), [
    automationsSummary(table, pointers, NOW),
    "    ⏳ pasta                    in 12 min                  chime                auto_2 · next in 4 min",
    "    ⏰ Wake up, Kevin           weekdays 07:10             chime + say          auto_1 · next in 6 h",
    "    ↻ backup                   daily 23:00                run-recipe           auto_5 · failed: recipe exit 1",
    "    ↻ standup notes            weekdays 09:00             open                 auto_3 · paused",
    "    👁 file papers              when a file lands in ~/Do… file + chime         auto_4 · watching",
    "    ⏳ Pasta                    in 10 min                  chime                auto_0 · done",
  ]);
  const ringing = { ...pointers, ringing: { id: "auto_1", kind: "alarm" as const, name: "Wake up, Kevin", line: "07:10 · Wake up, Kevin", at: NOW, presses: [], more: 1 } };
  assert.match(automationsSummary(table, ringing, NOW), / · ringing: 07:10 · Wake up, Kevin \(\+1 more\)$/);
  assert.equal(automationsSummary([], {}, NOW), "  automations 0 · next — · ringing: —");
});

test("automationsLines: --state filters; an empty table says how to set one; an empty filter names the states present", () => {
  assert.deepEqual(filterByState(table, "paused").map((a) => a.id), ["auto_3"]);
  assert.equal(filterByState(table, "all").length, 6);
  // The snapshot's Trash tail rides after the live rows: `all` and the summary leave it out, `--state trashed` lists it.
  const binned = row({ id: "auto_9", name: "old alarm", when: { kind: "at", at: NOW - H }, then: [{ kind: "chime", line: "up" }], state: "trashed" });
  assert.equal(filterByState([...table, binned], "all").length, 6);
  assert.deepEqual(filterByState([...table, binned], "trashed").map((a) => a.id), ["auto_9"]);
  assert.equal(automationsSummary([...table, binned], pointers, NOW), automationsSummary(table, pointers, NOW));
  assert.equal(automationsLines([binned], {}, NOW)[1], automationsLines([], {}, NOW)[1], "only the Trash: nothing is set");
  assert.equal(automationsLines([binned], {}, NOW)[2], "    1 in the Trash — jarhead automations list --state trashed · restore <id>", "…and the Trash is named");
  assert.equal(automationsLines([binned], {}, NOW).length, 3);
  assert.deepEqual(automationsLines([binned], {}, NOW, "trashed"), [automationsSummary([binned], {}, NOW), automationLine(binned, NOW)], "--state trashed lists the tail with nothing live");
  assert.deepEqual(automationsLines([...table, binned], pointers, NOW, "trashed").slice(1), [automationLine(binned, NOW)], "…and beside live rows");
  assert.equal(automationsLines([...table, binned], pointers, NOW, "snoozed")[1], "    nothing snoozed — set: 3 armed · 1 paused · 1 done · 1 failed", "an empty filter counts the live rows, never the Trash");
  assert.deepEqual(resolveAutomation([...table, binned], "old alarm").id, "auto_9", "Restore by name reaches the tail");
  assert.deepEqual(automationsLines(table, pointers, NOW, "snoozed"), [automationsSummary(table, pointers, NOW), "    nothing snoozed — set: 3 armed · 1 paused · 1 done · 1 failed"]);
  const empty = automationsLines([], {}, NOW);
  assert.equal(empty.length, 2);
  assert.match(empty[1] ?? "", /nothing set — say "wake me at 7:10 on weekdays", or: jarhead automations add/);
});

test("parseClockAutomation: the three ladder phrases become drafts with a name, the free action, the quiet clause by kind and the echo line", () => {
  const alarm = parseClockAutomation("at 7:10 weekdays chime 'Wake up'", NOW) as AutomationDraft;
  assert.deepEqual(alarm, {
    name: "Wake up",
    when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "07:10" }, phrase: "weekdays 07:10" },
    then: [{ kind: "chime", line: "Wake up" }],
    clauses: { quiet: "override" },
    echo: 'Weekdays 07:10, ring "Wake up".',
  });
  const timer = parseClockAutomation("in 12m chime pasta", NOW) as AutomationDraft;
  assert.deepEqual(timer.when, { kind: "in", ms: 12 * 60_000 });
  assert.deepEqual(timer.then, [{ kind: "chime", line: "pasta" }]);
  assert.equal(timer.name, "pasta");
  assert.deepEqual(timer.clauses, { quiet: "respect" }, "a timer is not an alarm (automationKind): only alarms ring through quiet hours");
  assert.equal(timer.echo, 'In 12 min, ring "pasta".');
  const routine = parseClockAutomation("weekdays 09:00 open Notes", NOW) as AutomationDraft;
  assert.deepEqual(routine.then, [{ kind: "open", app: "Notes" }]);
  assert.equal(routine.name, "open Notes");
  assert.deepEqual(routine.clauses, { quiet: "respect" }, "an acting kind waits out quiet hours");
  assert.equal(routine.echo, "Weekdays 09:00, open Notes.");
  // A reminder tomorrow: the `at` is local tomorrow 15:00, whatever the zone the test runs in.
  const reminder = parseClockAutomation('tomorrow 15:00 say "call mum"', NOW) as AutomationDraft;
  const d = new Date(NOW);
  const expected = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 15, 0, 0, 0).getTime();
  assert.deepEqual(reminder.when, { kind: "at", at: expected });
  assert.deepEqual(reminder.then, [{ kind: "say", line: "call mum" }]);
  assert.deepEqual(reminder.clauses, { quiet: "respect" });
  assert.equal(reminder.echo, `${describe(reminder.when).charAt(0).toUpperCase()}${describe(reminder.when).slice(1)}, say "call mum".`);
  // open's three targets, and a notify.
  assert.deepEqual((parseClockAutomation("daily 18:00 open https://example.com/standup", NOW) as AutomationDraft).then, [{ kind: "open", url: "https://example.com/standup" }]);
  assert.deepEqual((parseClockAutomation("daily 18:00 open ~/Notes/standup.md", NOW) as AutomationDraft).then, [{ kind: "open", path: "~/Notes/standup.md" }]);
  assert.deepEqual((parseClockAutomation("every 2 h notify 'stand up'", NOW) as AutomationDraft).then, [{ kind: "notify", title: "stand up" }]);
  // A long line is a name of 24 chars, cut with an ellipsis; the echo keeps the whole line.
  const long = parseClockAutomation("at 7:10 chime 'this is a very long alarm line indeed'", NOW) as AutomationDraft;
  assert.equal(long.name.length, 24);
  assert.ok(long.name.endsWith("…"));
});

test("parseClockAutomation: the asking kinds are refused by name with where the yes is heard; a missing verb, line, target or time is named — never guessed", () => {
  const error = (words: string): string => (parseClockAutomation(words, NOW) as { error: string }).error;
  assert.match(error("daily 23:00 run backup"), /^run is set up by voice or in the Console, where the yes is heard; the CLI arms chime · say · notify · open$/);
  assert.match(error("daily 18:00 press cmd+s"), /^press is set up by voice/);
  assert.match(error("daily 18:00 wake 'summarise'"), /^wake is set up by voice/);
  assert.match(error("weekdays 09:00 file ~/Papers"), /^file is set up by voice/);
  assert.match(error("at 7:10 weekdays"), /didn't catch what it does — say when, then what/);
  assert.match(error("chime 'Wake up'"), /^say when first/);
  assert.match(error("at 7:10 chime"), /^chime needs a line: chime 'Wake up'$/);
  assert.match(error("at 7:10 open"), /^open needs an app, an https URL or a path$/);
  assert.match(error("at sevenish chime hi"), /didn't catch "sevenish"/);
  assert.match(error("the 3rd of the month chime hi"), /not yet — say the date/);
  assert.match(error(""), /^say when, then what/);
});

test("resolveAutomation: an id is sent as it is; a name finds the LIVE row before a lingering done one, whatever the case; any auto_… passes through (Restore names a trashed row the snapshot does not list); unknown throws naming what is set", () => {
  assert.deepEqual(resolveAutomation(table, "auto_3"), { id: "auto_3", target: standup });
  assert.equal(resolveAutomation(table, "pasta").id, "auto_2", "the live pasta, not the done Pasta that lingers");
  assert.equal(resolveAutomation(table, "PASTA").id, "auto_2");
  assert.equal(resolveAutomation(table, "wake up, kevin").id, "auto_1");
  assert.equal(resolveAutomation(table.filter((a) => a.id !== "auto_2"), "pasta").id, "auto_0", "only a done one carries the name → it is still what the name means");
  assert.deepEqual(resolveAutomation([], "auto_mfk3z1abcdef"), { id: "auto_mfk3z1abcdef" }, "an id the engine minted (newId: base-36 time + six chars) passes through unlisted");
  assert.throws(() => resolveAutomation(table, "coffee"), /^Error: no automation called coffee; set: pasta \(auto_2\), Wake up, Kevin \(auto_1\), backup \(auto_5\), standup notes \(auto_3\), file papers \(auto_4\), Pasta \(auto_0\)$/);
  assert.throws(() => resolveAutomation([], "coffee"), /nothing is set/);
});

const recipe = (name: string, command: string, over: Partial<ShellRecipe> = {}): ShellRecipe => ({ name, command, timeoutSeconds: 120, approvedAt: NOW - 3 * 24 * H, ...over });

test("recipeVerdict: the shell gate's word — run for a plain script, asks for a destructive verb (nobody there to say yes), refused for the never list, fronts for open/osascript", () => {
  assert.equal(recipeVerdict(recipe("tests", "pnpm test"), HOME).word, "run");
  assert.equal(recipeVerdict(recipe("backup", "~/bin/backup.sh"), HOME).word, "run");
  const rm = recipeVerdict(recipe("clean", "rm -rf ~/Downloads/old"), HOME);
  assert.equal(rm.word, "asks");
  assert.match(rm.reason, /would need a yes when it runs; nobody is there then$/);
  assert.equal(recipeVerdict(recipe("nuke", "rm -rf ~"), HOME).word, "refused");
  const fronts = recipeVerdict(recipe("notes", "open -a Notes"), HOME);
  assert.equal(fronts.word, "fronts");
  assert.match(fronts.reason, /use the open action instead/);
  assert.equal(recipeVerdict(recipe("bg", "open -g https://example.com"), HOME).word, "run", "open in the background does not steal the front");
});

test("recipesLines: one row per recipe with the gate's word; the count line says how many can fire unattended; an empty list says how to add one", () => {
  const lines = recipesLines([recipe("tests", "pnpm test", { cwd: "~/jarvis" }), recipe("clean", "rm -rf ~/Downloads/old", { approvedAt: NOW - 90_000 })], NOW, HOME);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "  tests                    run      pnpm test                                                    · approved 3 d ago · cwd ~/jarvis · 120 s");
  assert.match(lines[1] ?? "", /^  clean                    asks     rm -rf ~\/Downloads\/old {38} · approved 2 min ago · 120 s · .*would need a yes when it runs; nobody is there then$/);
  assert.equal(lines[2], "  2 recipes · 1 run-tier · 1 cannot fire unattended (edit the command, or Move to Trash)");
  assert.match(recipesLines([], NOW, HOME)[0] ?? "", /^  no recipes — jarhead recipes add/);
});

test("parseRecipeArgs: a name ≤ 24, a command, cwd and a whole-second timeout 1–600 (default 120); anything else is refused before a socket is opened", () => {
  assert.deepEqual(parseRecipeArgs("backup", "~/bin/backup.sh", undefined, undefined, NOW), { name: "backup", command: "~/bin/backup.sh", timeoutSeconds: 120, approvedAt: NOW });
  assert.deepEqual(parseRecipeArgs("tests", " pnpm test ", "~/jarvis", "30", NOW), { name: "tests", command: "pnpm test", cwd: "~/jarvis", timeoutSeconds: 30, approvedAt: NOW });
  assert.throws(() => parseRecipeArgs(undefined, "x", undefined, undefined, NOW), /usage: jarhead recipes add/);
  assert.throws(() => parseRecipeArgs("x", "  ", undefined, undefined, NOW), /usage: jarhead recipes add/);
  assert.throws(() => parseRecipeArgs("a-name-that-is-far-too-long", "x", undefined, undefined, NOW), /24 chars at most/);
  assert.throws(() => parseRecipeArgs("x", "y", undefined, "601", NOW), /1 to 600/);
  assert.throws(() => parseRecipeArgs("x", "y", undefined, "1.5", NOW), /whole seconds/);
});

// ---- doctor

const byName = (rows: readonly Check[]): Record<string, Check> => Object.fromEntries(rows.map((r) => [r.name, r]));
const healthy: AutomationCheckInput = {
  settings: { ...DEFAULT_AUTOMATIONS, openAtLogin: true, quietHours: { from: "23:00", to: "07:00" }, recipes: [recipe("tests", "pnpm test"), recipe("backup", "~/bin/backup.sh")] },
  rows: table,
  nextFire: pointers.nextFire,
  journal: { path: `${HOME}/.jarhead/automations/jobs.ndjson`, rows: 41, live: 6 },
  notifications: "granted",
  folderGrants: { filesDownloads: "granted" },
  missed: { count: 0, why: [] },
  brainSecondsToday: 0,
  timeSensitive: false,
  pmsetSched: "Repeating power events:\n  wakepoweron at 7:05AM weekdays only\n",
  now: NOW,
  home: HOME,
};

test("doctor automations: a healthy Mac — every row ok but the two pass-1 notes (time-sensitive), all advisory, in the design's order; nothing spawned", () => {
  spawned.length = 0;
  const rows = automationChecks(healthy);
  assert.deepEqual(rows.map((r) => r.name), ["enabled", "journal", "daemon", "banners", `wake for ${clock(wakeUp.nextAt ?? 0)}`, "quiet hours", "missed", "brain budget", "recipes", "time-sensitive", "folder grant"]);
  assert.ok(rows.every((r) => r.group === "automations" && r.required === false), "advisory throughout");
  const r = byName(rows);
  assert.equal(r["enabled"]!.status, "ok");
  assert.equal(r["enabled"]!.detail, `6 set · 3 armed · next ${clock(pasta.nextAt ?? 0)} pasta (in 4 min)`);
  assert.equal(r["journal"]!.detail, `${HOME}/.jarhead/automations/jobs.ndjson · 6 live · 41 rows`);
  assert.equal(r["daemon"]!.status, "ok");
  assert.match(r["daemon"]!.detail, /nothing fires while Jarhead is quit$/, "the standing line, even when Open at login is on");
  assert.equal(r["banners"]!.status, "ok");
  const wake = r[`wake for ${clock(wakeUp.nextAt ?? 0)}`]!;
  assert.equal(wake.status, "ok", "pmset -g sched already shows a wake");
  assert.match(wake.detail, /pmset schedules a wake \(pmset -g sched: wakepoweron at 7:05AM weekdays only\)/);
  assert.equal(wake.fix, undefined);
  assert.equal(r["quiet hours"]!.detail, "23:00–07:00 · alarms override; chime/say show silently; acting kinds wait");
  assert.equal(r["missed"]!.detail, "0 in 7 days");
  assert.equal(r["brain budget"]!.detail, "wake-brain unused · 0 of 5 min used today");
  assert.equal(r["recipes"]!.status, "ok");
  assert.equal(r["recipes"]!.detail, "2 · 2 run-tier");
  assert.equal(r["time-sensitive"]!.status, "warn");
  assert.match(r["time-sensitive"]!.detail, /entitlement absent — alarm banners honour Focus like any banner/);
  assert.equal(r["folder grant"]!.status, "ok");
  assert.equal(r["folder grant"]!.detail, "watching ~/Downloads · the Downloads folder grant is on");
  assert.deepEqual(spawned, [], "the doctor's automations rows spawn nothing — pmset is text, never a command it runs");
});

test("doctor automations: the trouble rows — Open at login off, banners denied, no pmset wake (the copy line, never run), missed fires with why, budget spent, a recipe that asks, the Downloads grant missing", () => {
  // `quietHours` must be absent, not undefined (exactOptionalPropertyTypes): rebuild the block without it.
  const { quietHours: _quiet, ...noQuiet } = healthy.settings;
  const trouble = automationChecks({
    ...healthy,
    settings: { ...noQuiet, openAtLogin: false, recipes: [recipe("tests", "pnpm test"), recipe("vpn-up", "sudo rm -rf /var/run/vpn"), recipe("notes", "open -a Notes")], wakeBudgetMinutesPerDay: 5 },
    notifications: "denied",
    folderGrants: {},
    missed: { count: 2, why: ["mac-slept", "mac-slept"] },
    brainSecondsToday: 5 * 60,
    pmsetSched: "No scheduled events.\n",
  });
  const r = byName(trouble);
  assert.equal(r["daemon"]!.status, "warn");
  assert.equal(r["daemon"]!.detail, "nothing fires while Jarhead is quit — Open at login is off");
  assert.equal(r["daemon"]!.fix, "Settings › Automations › Open at login");
  assert.equal(r["banners"]!.status, "warn");
  assert.equal(r["banners"]!.detail, "Notifications not granted — the island and the chime still fire");
  assert.match(r["banners"]!.fix ?? "", /^pnpm jarhead cmd request-permission notifications/);
  const wake = r[`wake for ${clock(wakeUp.nextAt ?? 0)}`]!;
  assert.equal(wake.status, "warn");
  assert.match(wake.detail, /^a closed lid sleeps through \d\d:\d\d — the alarm rings late \(within 15 min\) or is missed; the Mac is never woken by Jarhead$/);
  assert.equal(wake.fix, "copy (root; never run by Jarhead): sudo pmset repeat wakeorpoweron MTWRF 07:05:00");
  assert.equal(r["quiet hours"]!.detail, "none set — everything fires as set");
  assert.equal(r["missed"]!.status, "warn");
  assert.equal(r["missed"]!.detail, "2 missed in 7 days · the Mac slept");
  assert.match(r["missed"]!.fix ?? "", /^Run now on the row/);
  assert.equal(r["brain budget"]!.status, "warn");
  assert.match(r["brain budget"]!.detail, /^spent — 5 of 5 min used today; wake-brain rows fail until midnight \(a failed row, never a question\)$/);
  assert.equal(r["recipes"]!.status, "warn");
  assert.equal(r["recipes"]!.detail, "3 · 1 run-tier · 2 ask (vpn-up: would need a yes when it runs; notes: the recipe fronts an app (open / osascript); use the open action instead)");
  assert.match(r["recipes"]!.fix ?? "", /fails at fire; edit it so the gate says run/);
  assert.equal(r["folder grant"]!.status, "warn");
  assert.equal(r["folder grant"]!.detail, "watching ~/Downloads needs the Downloads folder grant (not read) — a denied read is the automation.watch problem, never a silent watcher");
  assert.equal(r["folder grant"]!.fix, "Ask (the automation.watch problem's button; Setup › Permissions)");
  assert.deepEqual(spawned, []);
});

test("doctor automations: the switch off, no daemon, no journal yet, brain minutes 0 — honest rows, no wake row without an alarm, no folder row without rows", () => {
  const off = byName(automationChecks({ ...healthy, settings: { ...healthy.settings, enabled: false } }));
  assert.equal(off["enabled"]!.status, "warn");
  assert.equal(off["enabled"]!.detail, "off (Settings › Automations) — nothing fires; every row stays (6 set)");
  const quiet = automationChecks({ ...healthy, rows: undefined, nextFire: undefined, notifications: undefined, journal: { path: "/x/jobs.ndjson", missing: true }, settings: { ...healthy.settings, wakeBudgetMinutesPerDay: 0, recipes: [] } });
  const q = byName(quiet);
  assert.deepEqual(quiet.map((r) => r.name), ["enabled", "journal", "daemon", "banners", "quiet hours", "missed", "brain budget", "recipes", "time-sensitive"]);
  assert.equal(q["enabled"]!.detail, "on · no daemon answering — the rows and the next fire come from a running daemon");
  assert.equal(q["journal"]!.detail, "no journal yet at /x/jobs.ndjson (it appears with the first automation)");
  assert.equal(q["banners"]!.detail, "Notifications not read (no daemon answering) — the island and the chime still fire");
  assert.equal(q["brain budget"]!.detail, "wake-brain off (Brain minutes 0) — no automation wakes the brain; nothing is billed asleep");
  assert.equal(q["recipes"]!.detail, "none — a recipe is a shell command you approved once; the gate re-judges it at every fire");
  const empty = byName(automationChecks({ ...healthy, rows: [], nextFire: undefined }));
  assert.match(empty["enabled"]!.detail, /^on · nothing set — say "wake me at 7:10 on weekdays"/);
  assert.equal(empty["folder grant"]!.detail, "no guarded folder watched");
  const torn = byName(automationChecks({ ...healthy, journal: { path: "/x/jobs.ndjson", error: "EACCES" } }));
  assert.equal(torn["journal"]!.status, "fail");
  assert.equal(torn["journal"]!.required, false, "a fail that never blocks the build: advisory");
  assert.match(torn["journal"]!.detail, /unreadable \(EACCES\) → nothing fires until it is/);
});

test("pmsetCopy: a weekly alarm is `repeat wakeorpoweron` on pmset's letters five minutes early (wrapping midnight); a one-shot is `schedule wake` on its date; a watcher has none", () => {
  assert.equal(pmsetCopy(wakeUp), "sudo pmset repeat wakeorpoweron MTWRF 07:05:00");
  assert.equal(pmsetCopy(row({ id: "a", name: "a", when: { kind: "every", every: { kind: "weekly", days: ["sun", "sat"], at: "00:02" }, phrase: "" }, then: [] })), "sudo pmset repeat wakeorpoweron SU 23:57:00");
  const at = new Date(2026, 8, 15, 7, 10, 0, 0).getTime();
  assert.equal(pmsetCopy(row({ id: "a", name: "a", when: { kind: "at", at }, then: [], nextAt: at })), 'sudo pmset schedule wake "09/15/26 07:05:00"');
  assert.equal(pmsetCopy(papers), undefined);
});

test("readJournal: rows counted, live = last row per id whose state is not trashed; a torn last line is skipped; a missing file is `missing`, never created", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarhead-automations-cli-"));
  const path = join(dir, "jobs.ndjson");
  assert.deepEqual(readJournal(path), { path, missing: true });
  const lines = [
    JSON.stringify({ ...wakeUp, state: "armed" }),
    JSON.stringify({ ...pasta, state: "armed" }),
    JSON.stringify({ ...pasta, state: "trashed" }),
    JSON.stringify({ ...standup, state: "paused" }),
    '{"id":"auto_9","sta',
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  assert.deepEqual(readJournal(path), { path, rows: 5, live: 2 });
  assert.deepEqual(spawned, []);
});

test("readAutomationLedger: missed rows over seven day files with their why; wake-brain seconds from today's fired rows only", () => {
  const days = new Map<string, LedgerRow[]>();
  const dayOf = (at: number): string => new Date(at).toDateString();
  const put = (at: number, r: LedgerRow): void => void days.set(dayOf(at), [...(days.get(dayOf(at)) ?? []), r]);
  put(NOW, { at: NOW - H, type: "automation.fired", id: "auto_8", actions: ["wake-brain"], ok: true, line: "briefing", ms: 90_000, brainSeconds: 95 });
  put(NOW, { at: NOW - 2 * H, type: "automation.missed", id: "auto_1", dueAt: NOW - 3 * H, why: "mac-slept" });
  put(NOW - 2 * 24 * H, { at: NOW - 2 * 24 * H, type: "automation.fired", id: "auto_8", actions: ["wake-brain"], ok: true, line: "briefing", ms: 90_000, brainSeconds: 100 });
  put(NOW - 3 * 24 * H, { at: NOW - 3 * 24 * H, type: "automation.missed", id: "auto_5", dueAt: NOW - 3 * 24 * H, skipped: true, why: "daemon-down" });
  put(NOW - 9 * 24 * H, { at: NOW - 9 * 24 * H, type: "automation.missed", id: "auto_5", dueAt: 0, why: "budget" });
  const ledger = { read: (at: number) => days.get(dayOf(at)) ?? [] };
  assert.deepEqual(readAutomationLedger(ledger, NOW), { missed: { count: 2, why: ["mac-slept", "daemon-down"] }, brainSecondsToday: 95 });
});

/** The local wall clock of an instant, as core's `clockOf` prints it. */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
