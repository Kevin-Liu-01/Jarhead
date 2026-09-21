import { test } from "node:test";
import assert from "node:assert/strict";
import { costLine } from "@jarhead/core";
import { READ_ONLY_TOOLS } from "@jarhead/hands";
import type { Automation, AutomationDraft } from "@jarhead/protocol";
import { resultText } from "../runner.ts";
import { zodShape } from "../claude.ts";
import { progressLine } from "../responses.ts";
import { ALL_TOOL_SPECS, AUTOMATION_SPECS, specByName } from "../tools.ts";
import { brainSystemPrompt } from "../brain.ts";
import {
  AUTOMATION_ECHO_CHARS,
  canonicalArgs,
  describeActions,
  draftFromArgs,
  renderAutomations,
  renderRecipes,
  type AutomationChangeResult,
  type AutomationSetContext,
  type AutomationSetResult,
  type AutomationSource,
  type AutomationVerb,
  type RecipeRow,
} from "../automations.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * The brain's side of automations (design11): four tools answered through an
 * `AutomationSource`, the set-up handshake reused (ask once, consume on the identical
 * re-call, ask again on a different one), the words the model reads, and the pins —
 * the table at 71, the standing orders naming only real tools, the read tools in
 * READ_ONLY_TOOLS. Nothing here fires: the source is a fake table and the engine's is B's.
 */

const NOW = Date.UTC(2026, 8, 14, 20, 0, 0); // a Monday evening
const COST = costLine({ steps: 25, seconds: 120 }, 5, false);

/** An armed row as the engine would return it; a key given as `undefined` is left out (a done row has no nextAt). */
function row(over: { [K in keyof Automation]?: Automation[K] | undefined } & Pick<Automation, "name">): Automation {
  const given = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) as Partial<Automation>;
  const merged: Automation = {
    id: `auto_${over.name.replace(/\W+/g, "_").toLowerCase()}`,
    when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at: "07:10" }, phrase: "weekdays 07:10" },
    then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }],
    clauses: { quiet: "override" },
    echo: 'Weekdays at 07:10, ring "Wake up, Kevin".',
    state: "armed",
    nextAt: NOW + 11 * 3_600_000,
    fires: 0,
    missed: 0,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { by: "brain", request: "wake me at seven ten on weekdays" },
    ...given,
    name: over.name,
  };
  if ("nextAt" in over && over.nextAt === undefined) delete (merged as { nextAt?: number }).nextAt;
  return merged;
}

/** A table that records what it was asked and answers as scripted: `confirm` until the context says confirmed. */
class FakeSource implements AutomationSource {
  readonly sets: { draft: AutomationDraft; ctx: AutomationSetContext }[] = [];
  readonly changes: { target: string; verb: AutomationVerb; minutes: number | undefined }[] = [];
  rows: Automation[] = [];
  recipeRows: RecipeRow[] = [];
  /** What the gate says before a yes: run (armed at once), confirm (with this reason), or refuse. */
  verdict: { kind: "run" } | { kind: "confirm"; reason: string } | { kind: "refuse"; reason: string } = { kind: "run" };
  changeResult: AutomationChangeResult | undefined;

  async set(draft: AutomationDraft, ctx: AutomationSetContext): Promise<AutomationSetResult> {
    this.sets.push({ draft, ctx });
    if (this.verdict.kind === "refuse") return { kind: "refused", reason: this.verdict.reason };
    if (this.verdict.kind === "confirm" && !ctx.confirmed) return { kind: "confirm", reason: this.verdict.reason };
    const armed = row({ name: draft.name, when: draft.when, then: draft.then, clauses: draft.clauses, echo: draft.echo, ...(ctx.confirmed ? { confirmed: { at: NOW, heard: ctx.heard ?? "" } } : {}) });
    this.rows.push(armed);
    return { kind: "armed", automation: armed };
  }
  async list(): Promise<readonly Automation[]> {
    return this.rows;
  }
  async change(target: string, verb: AutomationVerb, minutes?: number): Promise<AutomationChangeResult> {
    this.changes.push({ target, verb, minutes });
    if (this.changeResult) return this.changeResult;
    const a = this.rows.find((r) => r.name === target || r.id === target);
    if (!a) return { ok: false, reason: `no automation named "${target}"` };
    return { ok: true, automation: { ...a, state: verb === "trash" ? "trashed" : verb === "snooze" ? "snoozed" : a.state } };
  }
  async recipes(): Promise<readonly RecipeRow[]> {
    return this.recipeRows;
  }
}

function harness(over: { source?: FakeSource | undefined; brainIsLocal?: (() => boolean) | undefined; thread?: boolean } = {}) {
  const source = over.source ?? new FakeSource();
  const { runner, toolset } = makeRunner({ now: () => NOW, automations: source, ...(over.brainIsLocal ? { brainIsLocal: over.brainIsLocal } : {}) });
  const log = makeSink();
  const task = makeTask("wake me at seven ten on weekdays", undefined, { kevinDialogue: "and file the pdfs into Papers" });
  runner.attach(log.sink, over.thread ? { ...task, thread: { id: "th_1", name: "Slack", lane: "background" } } : task);
  return { runner, toolset, source, log };
}

const ALARM = { name: "Wake up", when: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }], echo: 'Weekdays at 07:10, ring "Wake up, Kevin".' };
const BRIEFING = { name: "rundown", when: "daily 18:00", then: [{ kind: "wake-brain", prompt: "summarise what my agents did today" }], echo: 'Daily at 18:00, wake the brain: "summarise what my agents did today".' };

test("a plain runner has no table: the four tools answer 'not available here' and arm nothing", async () => {
  const { runner } = makeRunner({ now: () => NOW });
  runner.attach(makeSink().sink, makeTask("set an alarm"));
  for (const n of ["automation_set", "automation_list", "automation_change", "recipe_list"]) {
    const r = await runner.run(n, n === "automation_set" ? ALARM : { name: "x", verb: "done" });
    assert.equal(r.result.kind, "error", n);
    assert.match(resultText(r.result), /not available here: no automations table/);
  }
});

test("a free kind arms at once: the draft carries the parsed when, the alarm's quiet default and the echo; the context carries by, Kevin's words and no confirmation; the line says armed, when, what and next", async () => {
  const { runner, source } = harness();
  const r = await runner.run("automation_set", ALARM);
  assert.equal(r.result.kind, "text", resultText(r.result));
  assert.match(resultText(r.result), /^armed: Wake up · weekdays 07:10 · chime "Wake up, Kevin" · next \d\d:\d\d · \w{3} \d{1,2} \w{3}$/);
  assert.equal(source.sets.length, 1);
  const { draft, ctx } = source.sets[0]!;
  assert.equal(draft.name, "Wake up");
  assert.equal(draft.when?.kind, "every", "the tool hands the engine a parsed when, never a phrase");
  assert.deepEqual(draft.then, [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }]);
  assert.equal(draft.clauses.quiet, "override", "an alarm rings through quiet hours by default");
  assert.equal(draft.echo, ALARM.echo);
  assert.equal(ctx.by, "brain");
  assert.equal(ctx.confirmed, false);
  assert.equal(ctx.fromThread, false);
  assert.equal(ctx.localBrain, undefined, "no brainIsLocal seam: the source decides from Settings");
  assert.match(ctx.request, /wake me at seven ten on weekdays/);
  assert.match(ctx.request, /file the pdfs into Papers/, "Kevin's own lines ride along; Jarhead's do not");
  assert.equal(ctx.delegationId, "item_1");
  // The runner never touches the handshake for a free kind.
  const { toolset } = harness();
  assert.equal(toolset.confirmations.pending, undefined);
});

test("wake-brain: confirm → needs_confirmation carrying the cost line, once; Kevin's yes and the identical re-call (keys in another order) → armed with confirmed and the words he heard; a different-argument re-call asks again", async () => {
  const { runner, toolset, source } = harness();
  source.verdict = { kind: "confirm", reason: COST };

  const ask = await runner.run("automation_set", BRIEFING);
  assert.equal(ask.result.kind, "needs-confirmation");
  const q = resultText(ask.result);
  assert.match(q, /^needs_confirmation: About to arm "rundown" — daily 18:00: wake the brain: "summarise what my agents did today"\./);
  assert.ok(q.includes(COST), q);
  assert.match(q, /about 2 brain minutes per fire on your plan, up to 5 a day/);
  assert.match(q, /call automation_set again with exactly the same arguments/);
  assert.match(q, /Ask Kevin to confirm out loud, then stop; do not retry until Kevin says yes\./);
  assert.equal(toolset.confirmations.pending?.member, "automation_set");
  assert.equal(toolset.confirmations.pending?.grantable, undefined, "the yes is spent on this one row; nothing widens");
  assert.equal(source.rows.length, 0, "nothing armed before the yes");
  assert.equal(source.sets[0]!.ctx.confirmed, false);

  // A re-call before any yes asks again (consume is false), and does not arm.
  const early = await runner.run("automation_set", BRIEFING);
  assert.equal(early.result.kind, "needs-confirmation");
  assert.equal(source.rows.length, 0);

  // Kevin's yes (the delegator arms it from his own words) and the same call, keys shuffled: armed.
  assert.ok(toolset.confirmations.arm());
  const again = await runner.run("automation_set", { echo: BRIEFING.echo, then: BRIEFING.then, when: " daily 18:00 ", name: BRIEFING.name });
  assert.equal(again.result.kind, "text", resultText(again.result));
  assert.match(resultText(again.result), /^armed: rundown · daily 18:00 · wake the brain: "summarise what my agents did today" · next /);
  const last = source.sets.at(-1)!;
  assert.equal(last.ctx.confirmed, true);
  assert.equal(last.ctx.heard, COST, "the words Kevin heard ride to the table as confirmed.heard");
  assert.deepEqual(last.draft.then, [{ kind: "wake-brain", prompt: "summarise what my agents did today", budget: { steps: 25, seconds: 120 }, speak: true }], "the default budget and speak");
  assert.equal(last.draft.clauses.quiet, "respect", "a routine waits for quiet hours");
  assert.equal(source.rows.at(-1)?.confirmed?.heard, COST);
  assert.equal(toolset.confirmations.pending, undefined, "the yes is consumed");

  // A yes to one row does not cover a different one: another prompt asks again, even armed.
  const askAgain = await runner.run("automation_set", { ...BRIEFING, then: [{ kind: "wake-brain", prompt: "read me the news" }] });
  assert.equal(askAgain.result.kind, "needs-confirmation", resultText(askAgain.result));
  assert.ok(toolset.confirmations.arm());
  const other = await runner.run("automation_set", { ...BRIEFING, then: [{ kind: "wake-brain", prompt: "read me the news, please" }] });
  assert.equal(other.result.kind, "needs-confirmation", "a changed argument after the yes is a new question, not an arm");
  assert.equal(source.rows.length, 1);
});

test("a refusal is an error the model relays: the reason and the nearest safe kind, nothing armed, nothing asked", async () => {
  const { runner, toolset, source } = harness();
  source.verdict = { kind: "refuse", reason: "run-recipe is not allowed while Jarhead is asleep (Settings › Automations › While asleep); a notify or a chime is" };
  const r = await runner.run("automation_set", { ...ALARM, then: [{ kind: "run-recipe", recipe: "backup" }] });
  assert.equal(r.result.kind, "error");
  assert.match(resultText(r.result), /^error: refused: run-recipe is not allowed while Jarhead is asleep .*a notify or a chime is$/);
  assert.equal(toolset.confirmations.pending, undefined);
  assert.equal(source.rows.length, 0);
});

test("the arguments are checked for shape before the table sees them; the gate keeps the judging", async () => {
  const { runner, source } = harness();
  const bad = async (args: Record<string, unknown>, re: RegExp): Promise<void> => {
    const r = await runner.run("automation_set", args);
    assert.equal(r.result.kind, "error", JSON.stringify(args));
    assert.match(resultText(r.result), re);
  };
  await bad({ ...ALARM, name: "" }, /name: a short name/);
  await bad({ ...ALARM, name: "a name far longer than twenty-four" }, /name: at most 24 characters/);
  await bad({ ...ALARM, when: undefined }, /when: a clock phrase .* or on: a signal/);
  await bad({ ...ALARM, when: "on the third thursday" }, /when: not yet — say the date/);
  await bad({ ...ALARM, when: "sometime" }, /^error: automation_set: when: /);
  await bad({ ...ALARM, on: { kind: "app.quit", app: "Slack" } }, /not both/);
  await bad({ ...ALARM, when: undefined, on: { kind: "folder.file" } }, /on\.path: folder\.file needs it/);
  await bad({ ...ALARM, when: undefined, on: { kind: "recipe.red", recipe: "tests" } }, /on\.everySeconds: recipe\.red needs it/);
  await bad({ ...ALARM, then: [] }, /then: one to three actions/);
  await bad({ ...ALARM, then: [ALARM.then[0], ALARM.then[0], ALARM.then[0], ALARM.then[0]] }, /at most 3 actions; this has 4/);
  await bad({ ...ALARM, then: [{ kind: "say" }] }, /then\[0\]\.line: say needs it/);
  await bad({ ...ALARM, then: [{ kind: "open" }] }, /open needs an app, an https url or a path/);
  await bad({ ...ALARM, then: [{ kind: "press", app: "Cursor" }] }, /then\[0\]\.key: press needs it/);
  await bad({ ...ALARM, echo: "" }, /echo: one terse line/);
  await bad({ ...ALARM, clauses: { window: { from: "7" } } }, /clauses\.window/);
  await bad({ ...ALARM, clauses: { days: ["someday"] } }, /clauses\.days/);
  await bad({ ...ALARM, clauses: { once: "twice" } }, /clauses\.once/);
  await bad({ ...ALARM, clauses: { quiet: "loud" } }, /clauses\.quiet/);
  assert.equal(source.sets.length, 0, "a malformed call never reaches the table");

  // A reserved or unknown trigger kind is not the runner's to refuse: it rides through by name so the gate names it.
  const reserved = await runner.run("automation_set", { ...ALARM, when: undefined, on: { kind: "clipboard.match", pattern: "sk-" } });
  assert.equal(reserved.result.kind, "text");
  assert.deepEqual(source.sets.at(-1)!.draft.when, { kind: "on", on: { kind: "clipboard.match", pattern: "sk-" } });
  const unknownAction = await runner.run("automation_set", { ...ALARM, then: [{ kind: "shortcut", name: "Lights" }] });
  assert.equal(unknownAction.result.kind, "text");
  assert.deepEqual(source.sets.at(-1)!.draft.then, [{ kind: "shortcut", name: "Lights" }]);
});

test("draftFromArgs: a watcher with clauses, a trimmed echo, the timer and at forms", () => {
  const watcher = draftFromArgs(
    {
      name: "file PDFs",
      on: { kind: "folder.file", path: "~/Downloads", glob: "*.pdf" },
      then: [{ kind: "file", into: "~/Documents/Papers" }, { kind: "chime", line: "filed" }],
      clauses: { window: { from: "9:00", to: "18:30" }, days: ["Mon", "fri"], once: "day", cooldown: 45, quiet: "respect" },
      echo: "x".repeat(200),
      recipeCommand: "  ",
    },
    NOW,
  );
  assert.ok("draft" in watcher, JSON.stringify(watcher));
  assert.deepEqual(watcher.draft.when, { kind: "on", on: { kind: "folder.file", path: "~/Downloads", glob: "*.pdf" } });
  assert.deepEqual(watcher.draft.clauses, { quiet: "respect", window: { from: "09:00", to: "18:30" }, days: ["mon", "fri"], once: "day", cooldown: 45 });
  assert.equal(watcher.draft.echo.length, AUTOMATION_ECHO_CHARS);
  assert.ok(watcher.draft.echo.endsWith("…"));
  assert.equal(watcher.recipeCommand, undefined, "a blank recipeCommand is none");

  const timer = draftFromArgs({ name: "pasta", when: "in 12 minutes", then: [{ kind: "chime", line: "pasta" }], echo: 'In 12:00, ring "pasta".' }, NOW);
  assert.ok("draft" in timer);
  assert.deepEqual(timer.draft.when, { kind: "in", ms: 12 * 60_000 });
  assert.equal(timer.draft.clauses.quiet, "respect", "a timer is its own kind (automationKind): only alarms default to ringing through quiet hours");

  const reminder = draftFromArgs({ name: "call mum", when: "15:00", then: [{ kind: "say", line: "call mum" }], echo: 'At 15:00, say "call mum".', recipeCommand: "~/bin/x.sh" }, NOW);
  assert.ok("draft" in reminder);
  assert.equal(reminder.draft.when.kind, "at");
  assert.equal(reminder.draft.clauses.quiet, "respect");
  assert.equal(reminder.recipeCommand, "~/bin/x.sh");
  assert.equal(describeActions(watcher.draft.then), 'file it into ~/Documents/Papers, then chime "filed"');
});

test("automation_list renders the table's rows (name · kind · state · when · echo · next · last), hides done unless asked, filters by state, and never answers from anywhere else", async () => {
  const { runner, source } = harness();
  source.rows = [
    row({ name: "Wake up" }),
    row({ name: "pasta", when: { kind: "in", ms: 720_000 }, state: "snoozed", nextAt: NOW + 300_000, echo: 'In 12:00, ring "pasta".', lastFiredAt: NOW - 60_000, lastDetail: "snoozed 5" }),
    row({ name: "standup notes", then: [{ kind: "open", app: "Notes" }], state: "done", nextAt: undefined, echo: "Weekdays at 09:00, open Notes." }),
    row({ name: "backup", state: "failed", nextAt: NOW + 3_600_000, then: [{ kind: "run-recipe", recipe: "backup" }], lastDetail: "recipe exit 1" }),
    row({ name: "old", state: "trashed" }),
  ];
  const all = resultText((await runner.run("automation_list", {})).result).split("\n");
  assert.equal(all.length, 3, all.join(" | "));
  assert.match(all[0]!, /^Wake up · alarm · armed · weekdays 07:10 · Weekdays at 07:10, ring "Wake up, Kevin"\. · next \d\d:\d\d · /);
  assert.match(all[1]!, /^pasta · timer · snoozed · in 12 min · In 12:00, ring "pasta"\. · next \d\d:\d\d · .* · last \d\d:\d\d · .* \(snoozed 5\)$/);
  assert.match(all[2]!, /^backup · routine · failed · weekdays 07:10 · .* · recipe exit 1$/, "a failed row shows its detail, not a next");
  assert.ok(!all.some((l) => l.startsWith("old")), "the Trash is the Console's");
  const done = resultText((await runner.run("automation_list", { state: "all" })).result).split("\n");
  assert.equal(done.length, 4);
  assert.match(done[2]!, /^standup notes · routine · done · weekdays 07:10 · Weekdays at 09:00, open Notes\.$/);
  assert.equal(resultText((await runner.run("automation_list", { state: "failed" })).result).split("\n").length, 1);
  assert.equal(resultText((await runner.run("automation_list", { state: "paused" })).result), "nothing paused");
  source.rows = [];
  assert.equal(resultText((await runner.run("automation_list", {})).result), "nothing is set");
  assert.match(resultText((await runner.run("automation_list", { state: "trashed" })).result), /state is one of/);
});

test("automation_change: one verb on one row by name; snooze minutes clamped; trash is Move to Trash in words; the table's refusal is relayed", async () => {
  const { runner, source } = harness();
  source.rows = [row({ name: "Wake up" })];
  const snoozed = await runner.run("automation_change", { name: "Wake up", verb: "snooze", minutes: 10 });
  assert.match(resultText(snoozed.result), /^snoozed: Wake up · next \d\d:\d\d · .* · snoozed$/);
  assert.deepEqual(source.changes.at(-1), { target: "Wake up", verb: "snooze", minutes: 10 });
  await runner.run("automation_change", { name: "auto_wake_up", verb: "snooze", minutes: 9999 });
  assert.deepEqual(source.changes.at(-1), { target: "auto_wake_up", verb: "snooze", minutes: 720 });
  await runner.run("automation_change", { name: "Wake up", verb: "Pause" });
  assert.deepEqual(source.changes.at(-1), { target: "Wake up", verb: "pause", minutes: undefined });
  const trashed = await runner.run("automation_change", { name: "Wake up", verb: "trash" });
  assert.match(resultText(trashed.result), /^moved to the Trash \(restorable, nothing deleted\): Wake up · trashed$/);
  assert.match(resultText((await runner.run("automation_change", { name: "Wake up", verb: "delete" })).result), /verb is one of snooze, done, skip, pause, resume, trash, restore, run/);
  assert.match(resultText((await runner.run("automation_change", { verb: "done" })).result), /needs the automation's name or id/);
  source.changeResult = { ok: false, reason: "run needs Kevin awake to hear it" };
  assert.match(resultText((await runner.run("automation_change", { name: "Wake up", verb: "run" })).result), /^error: refused: run needs Kevin awake to hear it$/);
});

test("recipe_list renders the approved recipes with `asks` when the gate would now question one, and says how one gets approved when there are none", async () => {
  const { runner, source } = harness();
  assert.match(resultText((await runner.run("recipe_list", {})).result), /^no recipes approved; a run-recipe automation with recipeCommand asks once/);
  source.recipeRows = [
    { recipe: { name: "backup", command: "~/bin/backup.sh", timeoutSeconds: 300, approvedAt: NOW - 86_400_000 }, asks: false, usedBy: ["nightly backup"] },
    { recipe: { name: "deploy", command: "git push --force", timeoutSeconds: 60, approvedAt: NOW }, asks: true, usedBy: [] },
  ];
  const lines = resultText((await runner.run("recipe_list", {})).result).split("\n");
  assert.match(lines[0]!, /^backup · ~\/bin\/backup\.sh · approved \d\d:\d\d · .* · used by nightly backup$/);
  assert.match(lines[1]!, /^deploy · git push --force · approved .* · asks — would need a yes when it runs; nobody is there then/);
  assert.equal(renderRecipes([]).startsWith("no recipes"), true);
  assert.equal(renderAutomations([], undefined), "nothing is set");
});

test("a spawned thread's call says so, and a local brain's says so: the context the gate reads for depth-one and the cost line's wording", async () => {
  const onThread = harness({ thread: true, brainIsLocal: () => true });
  await onThread.runner.run("automation_set", ALARM);
  assert.equal(onThread.source.sets[0]!.ctx.fromThread, true);
  assert.equal(onThread.source.sets[0]!.ctx.localBrain, true);
  const main = harness({ brainIsLocal: () => false });
  await main.runner.run("automation_set", ALARM);
  assert.equal(main.source.sets[0]!.ctx.fromThread, false);
  assert.equal(main.source.sets[0]!.ctx.localBrain, false);
});

test("canonicalArgs judges the identical re-call by content: key order and outer whitespace are no difference, any value is", () => {
  const a = canonicalArgs({ name: "x", then: [{ kind: "chime", line: "hi" }], when: "7:10 " });
  const b = canonicalArgs({ when: "7:10", then: [{ line: "hi", kind: "chime" }], name: " x" });
  assert.equal(a, b);
  assert.notEqual(a, canonicalArgs({ name: "x", then: [{ kind: "chime", line: "hi!" }], when: "7:10" }));
  assert.notEqual(a, canonicalArgs({ name: "x", then: [{ kind: "chime", line: "hi" }], when: "7:10", clauses: { quiet: "respect" } }));
});

test("the table: four automation specs close ALL_TOOL_SPECS at 71, carry the rules, shape to zod, have progress lines; the read tools are looks; the orders' 'Later.' paragraph names them and only real tools", () => {
  assert.deepEqual(AUTOMATION_SPECS.map((s) => s.name), ["automation_set", "automation_list", "automation_change", "recipe_list"]);
  assert.equal(ALL_TOOL_SPECS.length, 71);
  assert.deepEqual(ALL_TOOL_SPECS.slice(-4).map((s) => s.name), AUTOMATION_SPECS.map((s) => s.name), "AUTOMATION_SPECS close the table");
  const set = specByName("automation_set")!;
  // The rules the Contract table asks the description to carry.
  assert.match(set.description, /Write `echo`: one terse line in Kevin's words saying exactly when and what, and say it to him/);
  assert.match(set.description, /The policy judges NOW, at set-up: a kind off in Settings, a non-https URL, a hands-off app, a recipe that would need a yes when it runs, a send\/type\/click\/delete\/pay, are refused with the reason and the nearest safe action/);
  assert.match(set.description, /run-recipe, press and wake-brain return needs_confirmation once, here/);
  assert.match(set.description, /after his yes call again with exactly the same arguments; from then on it fires silently/);
  assert.match(set.description, /the question carries its cost: brain minutes per fire and the daily cap; relay it exactly/);
  assert.match(set.description, /Times are local; say the time back/);
  assert.match(set.description, /no session, no brain turn, nothing billed/);
  assert.deepEqual(set.parameters.required, ["name", "then", "echo"]);
  assert.match(specByName("automation_list")!.description, /never from memory/);
  assert.match(specByName("automation_change")!.description, /trash \(Move to Trash — it will not fire; Kevin can restore it .*nothing is deleted\)/);
  assert.match(specByName("automation_change")!.description, /run \(fire it now — only while Kevin is awake to hear it\)/);
  assert.match(specByName("recipe_list")!.description, /`asks` when the policy would now question it/);
  assert.match(specByName("recipe_list")!.description, /nothing here writes settings/);
  for (const s of AUTOMATION_SPECS) assert.ok(!/Delete|Cancel/.test(s.description), `${s.name}: the words are Move to Trash / Restore`);
  // The Claude SDK path shapes `then` as an array of objects and `on`/`clauses` as nested objects.
  const shape = zodShape(set);
  assert.ok(shape["then"]!.safeParse([{ kind: "chime", line: "hi", sound: "Hero" }]).success);
  assert.ok(!shape["then"]!.safeParse(["chime"]).success, "an array of strings is not an action list");
  assert.ok(shape["on"]!.safeParse({ kind: "app.quit", app: "Slack" }).success);
  assert.ok(shape["clauses"]!.safeParse({ window: { from: "09:00", to: "18:00" }, once: "day" }).success);
  assert.ok(shape["on"]!.safeParse(undefined).success && shape["when"]!.safeParse(undefined).success);
  // Progress lines for the timeline.
  assert.equal(progressLine("automation_set", { name: "Wake up" }), "Setting Wake up.");
  assert.equal(progressLine("automation_list", {}), "Checking what is set.");
  assert.equal(progressLine("automation_change", { name: "Wake up", verb: "snooze" }), "Snooze Wake up.");
  assert.equal(progressLine("recipe_list", {}), "Checking the approved recipes.");
  // The tool gate's static half: the two reads are looks (they may run alongside other looks); the two arms are not.
  assert.ok(READ_ONLY_TOOLS.has("automation_list") && READ_ONLY_TOOLS.has("recipe_list"));
  assert.ok(!READ_ONLY_TOOLS.has("automation_set") && !READ_ONLY_TOOLS.has("automation_change"));
  // The standing orders: one "Later." paragraph, under "How to work on this Mac", naming the four tools and nothing that is not a tool.
  const p = brainSystemPrompt();
  const start = p.indexOf("\nLater. ");
  assert.ok(start > p.indexOf("How to work on this Mac") && start < p.indexOf("Self-modification."), "one paragraph, between the Mac section and self-modification");
  const paragraph = p.slice(start, p.indexOf("\n\n", start + 1));
  assert.match(paragraph, /automation_set arms "when X then Y" for the daemon: it fires with no session and no brain turn/);
  assert.match(paragraph, /Write the echo line in Kevin's words and say it; say the local time back/);
  assert.match(paragraph, /Free kinds arm silently: chime, say a fixed line you write now, notify, open an app or an https page, file a file into a folder/);
  assert.match(paragraph, /run-recipe, press and wake-brain return needs_confirmation once, here — ask in Kevin's words, and on his yes call the same tool with exactly the same arguments; for the brain, the question you relay carries its cost/);
  assert.match(paragraph, /What the policy refuses stays refused; offer the safe kind it names, and never schedule a shell recipe that does the same thing/);
  assert.match(paragraph, /automation_list is the truth about what is set; automation_change snoozes, skips, pauses, bins \(nothing is deleted\); recipe_list shows the approved recipes/);
  const names = new Set(ALL_TOOL_SPECS.map((t) => t.name));
  const tokens = [...new Set(paragraph.match(/\b[a-z]+_[a-z_]+\b/g) ?? [])].filter((t) => t !== "needs_confirmation");
  assert.deepEqual(tokens.sort(), ["automation_change", "automation_list", "automation_set", "recipe_list"]);
  for (const t of tokens) assert.ok(names.has(t), t);
  assert.equal(p.split("\nLater. ").length - 1, 1, "once");
  assert.ok(!/[#*`]/.test(paragraph), "no markdown in a spoken paragraph");
});

// ------------------------------------------------------------ the user's name ---

test("the user's name: the draft's three errors say the name the runner passes, the example line included; the default renders as before", () => {
  const errorFor = (args: Record<string, unknown>, userName?: string): string => {
    const r = userName === undefined ? draftFromArgs(args, NOW) : draftFromArgs(args, NOW, userName);
    return "error" in r ? r.error : "";
  };
  const noName = {};
  const noThen = { name: "Wake up", when: "7:10" };
  const noEcho = { name: "Wake up", when: "7:10", then: [{ kind: "chime", line: "up" }] };
  assert.equal(errorFor(noName, "Sam"), "name: a short name Sam will hear ('Wake up', 'pasta', 'standup notes')");
  assert.equal(errorFor(noThen, "Sam"), "then: one to three actions, in order ([{ kind: 'chime', line: 'Wake up, Sam' }])");
  assert.equal(errorFor(noEcho, "Sam"), `echo: one terse line in Sam's words saying exactly when and what ('Weekdays at 07:10, ring "Wake up".')`);
  for (const args of [noName, noThen, noEcho]) {
    assert.doesNotMatch(errorFor(args, "Sam"), /Kevin/);
    assert.equal(errorFor(args, "Sam").replaceAll("Sam", "Kevin"), errorFor(args), "only the name moves");
    assert.equal(errorFor(args, "Kevin"), errorFor(args), "the default is Kevin");
  }
});
