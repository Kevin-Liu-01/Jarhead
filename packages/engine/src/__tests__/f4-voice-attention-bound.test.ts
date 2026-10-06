import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveInstructions } from "@jarhead/live";
import { Engine } from "../engine.ts";
import { world } from "./world.ts";

/**
 * F4 (LC-7, 2026-10-06): the voice's always-on gate bounds the exchange in words, "about eight seconds without words
 * to or from you", because the live package cannot import the engine. These pin the words to
 * Engine.EXCHANGE_WINDOW_MS, and show that the session the engine opens carries the bound.
 */

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];

const boundFor = (windowMs: number): RegExp => {
  const word = NUMBER_WORDS[Math.round(windowMs / 1000)];
  assert.ok(word, `${windowMs} ms has no word here: extend NUMBER_WORDS`);
  return new RegExp(`Session start or your name opens an exchange; about ${word} seconds without words to or from you end it`);
};

test("the voice's exchange bound says the engine's window: about <Engine.EXCHANGE_WINDOW_MS in seconds> seconds", () => {
  const orders = buildLiveInstructions({ alwaysOn: true });
  const attention = orders.slice(orders.indexOf("# Attention"), orders.indexOf("# Backchannel policy"));
  assert.match(attention, boundFor(Engine.EXCHANGE_WINDOW_MS), "change the window and the voice's words together (packages/live/src/instructions.ts)");
});

test("the session the engine opens carries the bounded gate, with no delegation for ignored words", async () => {
  const w = world();
  const { engine, lives } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const text = lives[0]!.config?.instructions ?? "";
    assert.match(text, boundFor(Engine.EXCHANGE_WINDOW_MS));
    assert.match(text, /Then words without your name are not for you, even commands and questions; typed lines always are\./);
    assert.match(text, /stay completely silent then, no backchannel and no delegation\./);
  } finally {
    await engine.stop();
  }
});
