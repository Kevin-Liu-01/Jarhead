import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineEvent } from "@jarhead/protocol";
import { settle, until, world } from "./world.ts";

/**
 * RAIL-1, dictation's half (W1-1): "new line" said while dictating into a messaging app must never send. Return in
 * Messages, Slack, Mail or a web app's compose box sends the message, so there the ear posts the newline that does not
 * send — Option-Return in Messages, Shift-Return elsewhere (and in a browser, whose page may be one of those apps).
 * When the gate still wants a yes for it, nothing is posted, the question is dropped and Kevin reads why.
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

test("dictation \"new line\" where the gate wants a yes (a hands-off app): nothing is posted, the question is dropped, and the toast says how to send", async () => {
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
    await until(() => toasts(events).some((t) => /say send if you mean send/.test(t)), 1500);
    assert.deepEqual(keys(w), [], "nothing posted");
    assert.equal(engine.confirmations.pending, undefined, "no question left for a later yes");
  } finally {
    await engine.stop();
  }
});
