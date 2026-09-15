import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolResult } from "@jarhead/hands";
import { DEFAULT_AUTOMATIONS, type LedgerRow } from "@jarhead/protocol";
import type { AutomationExec } from "../automations/index.ts";
import { delegate, rows, settle, until, world } from "./world.ts";

/**
 * The brain's four automation tools through the REAL engine (design11, seam 1): the main
 * runner and every lane runner reach `Engine.automations` as their `AutomationSource`; a
 * free kind arms through the real set-up gate; a run-recipe asks ONCE through the ordinary
 * handshake and the identical re-call after Kevin's yes arms it with the words he heard;
 * the list, the recipes and a verb read and move the same table. Nothing fires here.
 */

type SetRow = Extract<LedgerRow, { type: "automation.set" }>;
const text = (r: ToolResult): string => ("text" in r ? r.text : "message" in r ? r.message : "question" in r ? r.question : JSON.stringify(r));
/** Nothing spawned: a timer would hold the Mac awake through `caffeinate`; the fake only records. */
const quietExec: AutomationExec = { run: async () => ({ code: 0 }), hold: () => ({ kill: () => undefined }) };

test("automation_set through the real engine: a free kind arms (by: brain, Kevin's words as the request); run-recipe asks once with the gate's reason, the yes and the identical re-call arm it with confirmed.heard; list, recipes and change read and move the same table", async () => {
  const w = world({ automations: { exec: quietExec } });
  const { engine, clock, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0, automations: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "run-recipe"], recipes: [{ name: "backup", command: "echo hi", timeoutSeconds: 5, approvedAt: clock.t }] } });
    await engine.wake("test");
    delegate(w, "jarhead wake me at seven ten on weekdays", "item_1");
    await until(() => brain.tasks.length === 1);

    // A free kind: the runner parses, the engine judges and arms, the line comes back.
    const set = await engine.runner.run("automation_set", { name: "Wake up", when: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }], echo: 'Weekdays at 07:10, ring "Wake up, Kevin".' });
    assert.equal(set.result.kind, "text", text(set.result));
    assert.match(text(set.result), /^armed: Wake up · weekdays 07:10 · chime "Wake up, Kevin" · next /);
    const wake = engine.snapshot().automations.find((a) => a.name === "Wake up");
    assert.ok(wake, "the row is in the snapshot");
    assert.equal(wake.state, "armed");
    assert.equal(wake.createdBy.by, "brain");
    assert.match(wake.createdBy.request, /wake me at seven ten on weekdays/, "Kevin's words ride to the row");
    assert.equal(wake.confirmed, undefined, "a free kind records no yes");
    assert.deepEqual(rows<SetRow>(w, "automation.set").map((r) => r.by), ["brain"]);

    // run-recipe: the gate says confirm; the runner asks through the ordinary handshake — once, with the gate's reason.
    const recipe = { name: "nightly backup", when: "daily 23:00", then: [{ kind: "run-recipe", recipe: "backup" }], echo: "Daily at 23:00, run recipe backup." };
    const ask = await engine.runner.run("automation_set", recipe);
    assert.equal(ask.result.kind, "needs-confirmation", text(ask.result));
    const question = text(ask.result);
    assert.match(question, /^About to arm "nightly backup" — daily 23:00: run recipe "backup"\./);
    assert.match(question, /recipe backup .* unattended/, "the gate's reason is the question");
    assert.match(question, /call automation_set again with exactly the same arguments/);
    assert.ok(engine.confirmations.pending, "the question is on the root");
    assert.equal(engine.confirmations.pending?.grantable, undefined, "the yes is spent on this one row");
    assert.equal(engine.snapshot().automations.length, 1, "nothing armed before the yes");

    // Kevin's yes, then the same call with its keys in another order: armed, confirmed with the words he heard.
    assert.ok(engine.confirmations.arm());
    const again = await engine.runner.run("automation_set", { echo: recipe.echo, then: recipe.then, when: " daily 23:00 ", name: recipe.name });
    assert.equal(again.result.kind, "text", text(again.result));
    assert.match(text(again.result), /^armed: nightly backup · daily 23:00 · run recipe "backup" · next /);
    const nightly = engine.snapshot().automations.find((a) => a.name === "nightly backup");
    assert.ok(nightly);
    assert.equal(nightly.state, "armed");
    assert.ok(nightly.confirmed, "the yes is recorded on the row");
    assert.ok(question.includes(nightly.confirmed.heard), `heard is the gate's reason inside the question: ${nightly.confirmed.heard}`);
    assert.equal(engine.confirmations.pending, undefined, "the yes is consumed");
    assert.equal(rows(w, "grant").length, 0, "no grant: nothing widens");

    // The read tools answer from the table; a verb moves one row.
    const list = await engine.runner.run("automation_list", {});
    assert.match(text(list.result), /^Wake up · alarm · armed · weekdays 07:10/m);
    assert.match(text(list.result), /^nightly backup · routine · armed · daily 23:00/m);
    const recipes = await engine.runner.run("recipe_list", {});
    assert.match(text(recipes.result), /^backup · echo hi · approved .* · used by nightly backup$/m);
    const snoozed = await engine.runner.run("automation_change", { name: "Wake up", verb: "snooze", minutes: 10 });
    assert.match(text(snoozed.result), /^snoozed: Wake up · Wake up snoozed 10 min/);
    assert.equal(engine.snapshot().automations.find((a) => a.id === wake.id)?.state, "snoozed");
    const trashed = await engine.runner.run("automation_change", { name: "nightly backup", verb: "trash" });
    assert.match(text(trashed.result), /^moved to the Trash \(restorable, nothing deleted\): nightly backup/);
    assert.equal(engine.automations.table.get(nightly.id)?.state, "trashed", "kept for Restore, never deleted");
  } finally {
    await engine.stop();
  }
});

test("a lane runner reaches the same table: a screen thread's automation_set arms a free kind (the row is the engine's, by: brain) and its wake-brain is refused at depth one, not asked; the background lane — where a headless wake-brain turn runs — refuses automation_* and recipe_* outright", async () => {
  const w = world({ automations: { exec: quietExec } });
  const { engine, brain } = w;
  const results: ToolResult[] = [];
  const headless: ToolResult[] = [];
  try {
    w.threads.script = async (job) => {
      if (job.task.thread?.lane === "background") {
        headless.push((await job.runner.run("automation_list", {})).result);
        headless.push((await job.runner.run("recipe_list", {})).result);
        return { status: "done", summary: "read" };
      }
      results.push((await job.runner.run("automation_set", { name: "log hours", on: { kind: "app.quit", app: "Slack" }, then: [{ kind: "say", line: "log your hours" }], echo: "When Slack quits, say 'log your hours'." })).result);
      results.push((await job.runner.run("automation_set", { name: "rundown", when: "daily 18:00", then: [{ kind: "wake-brain", prompt: "summarise the day" }], echo: 'Daily at 18:00, wake the brain: "summarise the day".' })).result);
      return { status: "done", summary: "set" };
    };
    await engine.start();
    await engine.ready();
    // wake-brain is allowed asleep here so the refusal under test is the thread's depth, not the chip.
    engine.updateSettings({ idleSleepMinutes: 0, automations: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "wake-brain"] } });
    await engine.wake("test");
    delegate(w, "jarhead remind me to log my hours when slack quits", "item_1");
    await until(() => brain.tasks.length === 1);
    await engine.runner.run("thread_start", { name: "Slack", task: "set the reminder", lane: "screen" });
    await engine.runner.run("thread_start", { name: "Spotify", task: "read the list", lane: "background" });
    await until(() => results.length === 2 && headless.length === 2, 3000);
    await settle();
    assert.equal(results[0]!.kind, "text", text(results[0]!));
    assert.match(text(results[0]!), /^armed: log hours · when Slack quits · say "log your hours"/);
    const row = engine.snapshot().automations.find((a) => a.name === "log hours");
    assert.ok(row);
    assert.equal(row.createdBy.by, "brain");
    assert.equal(results[1]!.kind, "error", text(results[1]!));
    assert.match(text(results[1]!), /^refused: a spawned thread cannot arm a brain wake \(depth one\)/, "wake-brain from a spawned thread is refused, not asked");
    assert.equal(engine.confirmations.pending, undefined);
    for (const r of headless) {
      assert.equal(r.kind, "error", text(r));
      assert.match(text(r), /is not a background lane's \(an automation is set in the conversation, never by a headless turn\)/);
    }
  } finally {
    await engine.stop();
  }
});
