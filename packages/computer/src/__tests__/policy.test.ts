import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isAllowed, CONFIRM_LEVELS, type ComputerAction } from "../policy.ts";

const level = (action: ComputerAction): string => classify(action).level;

test("read-only actions are always allowed, even in scary apps", () => {
  assert.equal(level({ kind: "screenshot" }), "always-allowed");
  assert.equal(level({ kind: "ax-query", app: "Google Chrome" }), "always-allowed");
  assert.equal(level({ kind: "read-selection", app: "Safari" }), "always-allowed");
});

test("a click in the already-focused window is pre-approvable", () => {
  assert.equal(level({ kind: "click", app: "Notes", target: "Bold", focusedWindow: true }), "pre-approvable");
  assert.equal(level({ kind: "press-element", app: "Notes", target: "Bold", focusedWindow: true }), "pre-approvable");
});

test("unknown or wrong focus escalates a click to always-confirm", () => {
  assert.equal(level({ kind: "click", app: "Notes", target: "Bold" }), "always-confirm");
  assert.equal(level({ kind: "click", app: "Notes", target: "Bold", focusedWindow: false }), "always-confirm");
});

test("typing always confirms, focus notwithstanding", () => {
  assert.equal(level({ kind: "type", app: "Notes", focusedWindow: true }), "always-confirm");
  assert.equal(level({ kind: "key", app: "Notes", focusedWindow: true }), "always-confirm");
});

test("anything in a browser always confirms", () => {
  assert.equal(level({ kind: "click", app: "Google Chrome", target: "Like", focusedWindow: true }), "always-confirm");
  assert.equal(level({ kind: "scroll", app: "Safari", focusedWindow: true }), "always-confirm");
});

test("money, messages, and deletion confirm even in focused native apps", () => {
  assert.equal(level({ kind: "click", app: "Mail", target: "Send", focusedWindow: true }), "always-confirm");
  assert.equal(level({ kind: "click", app: "Finder", target: "Move to Trash", focusedWindow: true }), "always-confirm");
  assert.equal(level({ kind: "click", app: "App Store", target: "Buy Now", focusedWindow: true }), "always-confirm");
});

test("system surfaces and credentials hand off to Kevin", () => {
  assert.equal(level({ kind: "click", app: "System Settings", focusedWindow: true }), "hand-off");
  assert.equal(level({ kind: "click", app: "iTerm2", target: "Run", focusedWindow: true }), "hand-off");
  assert.equal(level({ kind: "type", app: "Notes", target: "Password field" }), "hand-off");
  assert.equal(level({ kind: "terminal-command" }), "hand-off");
  assert.equal(level({ kind: "credential-entry", focusedWindow: true }), "hand-off");
});

test("unknown action kinds fail closed to the strictest level", () => {
  const c = classify({ kind: "quantum-entangle", app: "Notes", focusedWindow: true });
  assert.equal(c.level, "hand-off");
  assert.match(c.reason, /unknown action kind/);
  assert.equal(classify({ kind: "" }).level, "hand-off");
  assert.equal(classify({ kind: "Click " }).level, "always-confirm", "trimming/casing should not break known kinds");
});

test("every classification carries a reason", () => {
  const samples: ComputerAction[] = [
    { kind: "screenshot" },
    { kind: "click", focusedWindow: true },
    { kind: "type" },
    { kind: "made-up-thing" },
  ];
  for (const a of samples) assert.ok(classify(a).reason.length > 0);
});

test("isAllowed enforces the ladder; pre-approval never unlocks the strict tiers", () => {
  assert.equal(isAllowed("always-allowed", false), true);
  assert.equal(isAllowed("pre-approvable", false), false);
  assert.equal(isAllowed("pre-approvable", true), true);
  assert.equal(isAllowed("always-confirm", true), false);
  assert.equal(isAllowed("hand-off", true), false);
});

test("an unknown action is not silently allowed end to end", () => {
  const c = classify({ kind: "new-capability-nobody-classified" });
  assert.equal(isAllowed(c.level, true), false);
});

test("the level vocabulary is exactly the wiki's four modes", () => {
  assert.deepEqual([...CONFIRM_LEVELS], ["always-allowed", "pre-approvable", "always-confirm", "hand-off"]);
});
