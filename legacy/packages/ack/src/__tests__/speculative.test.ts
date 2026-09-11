import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAck } from "../speculative.ts";

const THRESHOLD = 400;

test("never acks a greeting, even when latency looks terrible", () => {
  const d = shouldAck("greeting", 5000, THRESHOLD);
  assert.equal(d.ack, false);
  assert.equal(d.category, undefined);
  assert.match(d.reason, /greeting/);
});

test("stays quiet when the warm path will beat the ack", () => {
  const d = shouldAck("hackernews", 250, THRESHOLD);
  assert.equal(d.ack, false);
  assert.equal(d.category, undefined);
  assert.match(d.reason, /250ms/);
  assert.match(d.reason, /400ms/);
});

test("exactly at the threshold counts as fast enough", () => {
  assert.equal(shouldAck("memory", THRESHOLD, THRESHOLD).ack, false);
});

test("acks slow lookup intents with a thinking phrase", () => {
  for (const intent of ["memory", "hackernews", "brief", "general"]) {
    const d = shouldAck(intent, 1200, THRESHOLD);
    assert.equal(d.ack, true, intent);
    assert.equal(d.category, "thinking", intent);
  }
});

test("acks unknown, action-shaped intents with a working phrase", () => {
  const d = shouldAck("automation", 1200, THRESHOLD);
  assert.equal(d.ack, true);
  assert.equal(d.category, "working");
});

test("the reason carries the numbers the latency timeline needs", () => {
  const d = shouldAck("memory", 1200, THRESHOLD);
  assert.match(d.reason, /memory/);
  assert.match(d.reason, /1200ms/);
  assert.match(d.reason, /400ms/);
});
