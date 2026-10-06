import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineEvent } from "@jarhead/protocol";
import { delegate, settle, until, world } from "./world.ts";

/**
 * RAIL-1, dictation's half (W1-1): "new line" said while dictating into a messaging app must never send. Return in
 * Messages, Slack, Mail or a web app's compose box sends the message, so there the ear posts the newline that does not
 * send — Option-Return in Messages, Shift-Return elsewhere (and in a browser, whose page may be one of those apps),
 * and Shift-Return when the front app is unknown. When the gate wants a yes for it or refuses it, nothing is posted,
 * the question is dropped and the toast says the new line was not typed (with how to send, where Return sends).
 */

const keys = (w: ReturnType<typeof world>): unknown[] => w.hands.posted.filter((p) => p.op === "key").map((p) => p.params["combo"]);
const toasts = (events: EngineEvent[]): string[] => events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast").map((e) => e.text);

for (const [app, combo] of [
  ["Messages", "alt+Return"],
  ["Slack", "shift+Return"],
  ["Mail", "shift+Return"],
  ["Google Chrome", "shift+Return"],
  ["Notes", "Return"],
  ["TextEdit", "Return"],
] as const) {
  test(`dictation "new line" in ${app} posts ${combo}`, async () => {
    const w = world();
    const { engine, hands } = w;
    try {
      await engine.start();
      await engine.ready();
      engine.updateSettings({ idleSleepMinutes: 0 });
      await engine.wake("test");
      hands.frontApp = app;
      engine.ear("start dictating", true, 1, 1);
      await until(() => engine.isDictating);
      engine.ear("start dictating see you at six new line bring the charger", true, 1, 2);
      await until(() => hands.posted.filter((p) => p.op === "type").length === 2, 1500);
      await settle(20);
      assert.deepEqual(keys(w), [combo]);
      assert.ok(!keys(w).includes("Return") || combo === "Return", "a bare Return is never posted into a messaging app");
    } finally {
      await engine.stop();
    }
  });
}

test("dictation \"new line\" in a hands-off app (1Password): nothing is posted, the question is dropped, and the toast says only that the new line was not typed", async () => {
  const w = world();
  const { engine, hands, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    hands.frontApp = "1Password 7";
    engine.ear("start dictating", true, 1, 1);
    await until(() => engine.isDictating);
    engine.ear("start dictating new line", true, 1, 2);
    assert.ok(await until(() => toasts(events).some((t) => /^new line not typed/.test(t)), 1500), `toasts: ${JSON.stringify(toasts(events))}`);
    assert.ok(toasts(events).includes("new line not typed here"), "no advice to say send where send means nothing");
    assert.deepEqual(keys(w), [], "nothing posted");
    assert.equal(engine.confirmations.pending, undefined, "no question left for a later yes");
  } finally {
    await engine.stop();
  }
});

test("dictation \"new line\" in Slack where the gate wants a yes for the key: nothing is typed, the question is dropped, and the toast says how to send", async () => {
  const w = world();
  const { engine, hands, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    hands.frontApp = "Slack";
    const toolset = engine.toolset as unknown as { run(member: string, input: Record<string, unknown>): Promise<unknown> };
    const run = toolset.run.bind(toolset);
    const asked: unknown[] = [];
    toolset.run = async (member, input) => {
      if (member !== "key") return run(member, input);
      asked.push(input["text"]);
      return { kind: "needs-confirmation", pendingId: "held", question: "about to press shift+Return in Slack" };
    };
    engine.ear("start dictating", true, 1, 1);
    await until(() => engine.isDictating);
    engine.ear("start dictating new line", true, 1, 2);
    assert.ok(await until(() => toasts(events).some((t) => /^new line not typed/.test(t)), 1500), `toasts: ${JSON.stringify(toasts(events))}`);
    assert.deepEqual(asked, ["shift+Return"]);
    assert.ok(toasts(events).includes("new line not typed · say send if you mean send"));
    assert.deepEqual(keys(w), [], "nothing posted");
    assert.equal(engine.confirmations.pending, undefined);
  } finally {
    await engine.stop();
  }
});

test("dictation \"new line\" when the front app cannot be told: Shift-Return, never a bare Return", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    // From the start: the engine's own record of the front app is empty too.
    hands.frontApp = "";
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    engine.ear("start dictating", true, 1, 1);
    await until(() => engine.isDictating);
    engine.ear("start dictating see you at six new line bring the charger", true, 1, 2);
    await until(() => hands.posted.filter((p) => p.op === "type").length === 2, 1500);
    await settle(20);
    assert.deepEqual(keys(w), ["shift+Return"]);
  } finally {
    await engine.stop();
  }
});

test("Live delegates \"Jarhead, start dictating.\" (the ear never heard it): dictation starts and the brain gets no task", async () => {
  const w = world();
  const { engine, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    w.clock.t += 60_000;
    // Said to Jarhead: a bare "start dictating" a minute after the last exchange is the room's (the room-talk gate, LC-7).
    delegate(w, "Jarhead, start dictating.", "item_d");
    assert.ok(await until(() => engine.isDictating, 1500), `delegation: ${JSON.stringify(engine.snapshot().delegations.map((d) => [d.status, d.summary]))}`);
    await settle(50);
    assert.equal(brain.tasks.length, 0, "no generation for a dictation toggle");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_d")?.status, "done");
  } finally {
    await engine.stop();
  }
});
