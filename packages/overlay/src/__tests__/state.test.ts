import { test } from "node:test";
import assert from "node:assert/strict";
import { OVERLAY_STATES, isOverlayState, reduce, type BuddyState } from "../state.ts";

test("set moves between visible states freely", () => {
  assert.equal(reduce("idle", { type: "set", state: "listening" }), "listening");
  assert.equal(reduce("listening", { type: "set", state: "thinking" }), "thinking");
  assert.equal(reduce("thinking", { type: "set", state: "speaking" }), "speaking");
  // Barge-in: speaking straight back to listening is legal.
  assert.equal(reduce("speaking", { type: "set", state: "listening" }), "listening");
});

test("hide wins from every state", () => {
  const all: BuddyState[] = [...OVERLAY_STATES, "hidden"];
  for (const state of all) {
    assert.equal(reduce(state, { type: "hide" }), "hidden");
  }
});

test("a hidden buddy ignores state changes until an explicit show", () => {
  for (const state of OVERLAY_STATES) {
    assert.equal(reduce("hidden", { type: "set", state }), "hidden");
  }
  assert.equal(reduce("hidden", { type: "show" }), "idle");
});

test("show is a no-op when already visible", () => {
  assert.equal(reduce("speaking", { type: "show" }), "speaking");
  assert.equal(reduce("idle", { type: "show" }), "idle");
});

test("land settles a flight to idle", () => {
  assert.equal(reduce("pointing", { type: "land" }), "idle");
});

test("a stale land does not stomp a state set mid-flight", () => {
  // Flight starts, barge-in flips to speaking, then the old flight timer
  // fires land — speaking must survive.
  let state: BuddyState = reduce("idle", { type: "set", state: "pointing" });
  state = reduce(state, { type: "set", state: "speaking" });
  assert.equal(reduce(state, { type: "land" }), "speaking");
});

test("isOverlayState accepts exactly the five poses", () => {
  for (const state of OVERLAY_STATES) assert.equal(isOverlayState(state), true);
  assert.equal(isOverlayState("hidden"), false);
  assert.equal(isOverlayState("dancing"), false);
  assert.equal(isOverlayState(3), false);
  assert.equal(isOverlayState(undefined), false);
});
