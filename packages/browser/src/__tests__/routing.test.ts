import { test } from "node:test";
import assert from "node:assert/strict";
import { routeBrowserTask } from "../routing.ts";
import { describeCapabilities, detectBrowserTools, hasBinary } from "../detect.ts";
import type { BrowserCapabilities } from "../detect.ts";

const thisMachine: BrowserCapabilities = { agentBrowser: true, playwright: false, browserUse: false };
const bareMachine: BrowserCapabilities = { agentBrowser: false, playwright: false, browserUse: false };
const fullMachine: BrowserCapabilities = { agentBrowser: true, playwright: true, browserUse: true };

test("plain reads route to plain fetch, not a Chrome launch", () => {
  for (const task of [
    "read this article about rust async",
    "look up the weather in tokyo",
    "what does the anthropic pricing page say",
    "summarize the latest node release notes",
  ]) {
    assert.equal(routeBrowserTask(task, thisMachine).route, "plain-fetch", task);
  }
});

test("interactive tasks route to agent-browser", () => {
  for (const task of [
    "click the export button on localhost:3000",
    "fill the login form on github",
    "take a screenshot of the dashboard",
    "check the web vitals on the staging site",
    "upload the resume to the careers portal",
  ]) {
    assert.equal(routeBrowserTask(task, thisMachine).route, "agent-browser", task);
  }
});

test("JS-gated reads escalate to agent-browser even with no interaction", () => {
  const d = routeBrowserTask("read the pricing table, it's a single-page app that needs javascript", thisMachine);
  assert.equal(d.route, "agent-browser");
});

test("interactive work without agent-browser is unavailable, with the tool named", () => {
  const d = routeBrowserTask("click the export button on localhost:3000", bareMachine);
  assert.equal(d.route, "unavailable");
  assert.equal(d.tool, "agent-browser");
  assert.match(d.reason, /not installed/);
});

test("regression tests belong to playwright, which is not installed here", () => {
  const d = routeBrowserTask("write a playwright regression test for the signup form", thisMachine);
  assert.equal(d.route, "unavailable");
  assert.equal(d.tool, "playwright");
  assert.match(d.reason, /playwright/i);
});

test("the test-suite ask wins over its interactive vocabulary", () => {
  // Mentions clicking and logging in, but it is a committed-test task.
  const d = routeBrowserTask("add an e2e test that clicks through the login flow", fullMachine);
  assert.equal(d.route, "playwright");
});

test("every decision carries a reason", () => {
  for (const caps of [thisMachine, bareMachine, fullMachine]) {
    for (const task of ["read the docs", "click submit", "run the regression tests", "spa behind a paywall"]) {
      assert.ok(routeBrowserTask(task, caps).reason.length > 0, task);
    }
  }
});

test("hasBinary finds sh in /bin and nothing in a bogus PATH", () => {
  assert.equal(hasBinary("sh", "/bin"), true);
  assert.equal(hasBinary("sh", "/nonexistent-dir-for-jarvis-tests"), false);
  assert.equal(hasBinary("sh", ""), false);
});

test("detection with an explicit PATH reports nothing on an empty dir", () => {
  const caps = detectBrowserTools("/nonexistent-dir-for-jarvis-tests");
  assert.deepEqual(caps, bareMachine);
});

test("detection against the real PATH is cached for the process lifetime", () => {
  assert.equal(detectBrowserTools(), detectBrowserTools());
});

test("describeCapabilities names what is missing instead of failing later", () => {
  assert.match(describeCapabilities(bareMachine), /No browser automation tools/);
  assert.match(describeCapabilities(bareMachine), /brew install agent-browser/);
  assert.match(describeCapabilities(thisMachine), /agent-browser/);
});
