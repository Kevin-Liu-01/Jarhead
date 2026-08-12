import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsAction } from "../intent.ts";

test("on-screen requests route to the act loop", () => {
  for (const u of [
    "show me the export button",
    "point at my cursor",
    "where is the search box",
    "find the settings icon",
    "highlight this window",
    "click the submit button",
  ]) {
    assert.equal(wantsAction(u).act, true, u);
  }
});

test("questions about the world stay on the answer path", () => {
  // These trip the action verbs but pointing at the screen would be nonsense.
  for (const u of [
    "what's on hacker news",
    "what's my daily briefing",
    "who is ada lovelace",
    "what is a monad",
    "find me a good pasta recipe",
  ]) {
    assert.equal(wantsAction(u).act, false, u);
  }
});

test("an action verb with no on-screen target does not act", () => {
  // "open source" is not a request to open anything.
  assert.equal(wantsAction("open source licensing").act, false);
});

test("the bias is toward answering, because acting is slow and moves the cursor", () => {
  assert.equal(wantsAction("tell me about postgres").act, false);
  assert.equal(wantsAction("").act, false);
  assert.equal(wantsAction("hey jarvis").act, false);
});

test("every verdict explains itself, so a misroute is debuggable", () => {
  for (const u of ["show me the button", "what's on hacker news", "hello"]) {
    assert.ok(wantsAction(u).reason.length > 0, u);
  }
});
