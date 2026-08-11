import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, classify } from "../router.ts";
import type { RoutedTurn } from "../router.ts";

test("classifies greetings", () => {
  for (const u of ["hey jarvis", "hi", "hello jarvis", "good morning jarvis", "Hey Jarvis!"]) {
    assert.equal(classify(u), "greeting", u);
  }
});

test("a greeting with a question attached is not a bare greeting", () => {
  assert.notEqual(classify("hey jarvis what's on hackernews"), "greeting");
});

test("classifies hacker news", () => {
  for (const u of ["what's on hackernews", "hacker news", "anything on HN", "what's on hn today"]) {
    assert.equal(classify(u), "hackernews", u);
  }
});

test("classifies the daily briefing", () => {
  for (const u of ["what's my daily briefing today", "give me my briefing", "what's on my agenda"]) {
    assert.equal(classify(u), "brief", u);
  }
});

test("classifies memory lookups", () => {
  for (const u of ["what do i know about sigil", "search my wiki for reticle", "did i write about qmd"]) {
    assert.equal(classify(u), "memory", u);
  }
});

test("falls through to general", () => {
  assert.equal(classify("why is the sky blue"), "general");
});

test("hacker news wins over briefing when both words appear", () => {
  // "what's on hackernews" contains no brief keyword, but this one does —
  // HN is checked first on purpose because it is the more specific ask.
  assert.equal(classify("for my daily briefing what's on hackernews"), "hackernews");
});

const base: RoutedTurn = {
  intent: "general",
  context: "",
  source: "none",
  gatherMs: 0,
  caveat: undefined,
};

test("prompt puts the question last", () => {
  const prompt = buildPrompt("what's up", { ...base, context: "Some context here." });
  assert.ok(prompt.indexOf("Some context here.") < prompt.indexOf("what's up"));
});

test("a caveat is forced into the prompt so the model must say it", () => {
  const prompt = buildPrompt("my briefing", { ...base, intent: "brief", caveat: "The brief is 20 days old." });
  assert.match(prompt, /must mention: The brief is 20 days old\./);
});

test("greetings get an explicit no-menu instruction", () => {
  const prompt = buildPrompt("hey jarvis", { ...base, intent: "greeting" });
  assert.match(prompt, /Do not offer a menu/);
});

test("no context section when there is no context", () => {
  assert.doesNotMatch(buildPrompt("why is the sky blue", base), /Context:/);
});
