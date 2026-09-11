import { test } from "node:test";
import assert from "node:assert/strict";
import { echoOverlap, isRealInterruption, judgeEcho, normalizeWords } from "../echo.ts";

test("nothing is echo when jarvis is silent", () => {
  const v = judgeEcho("what about tomorrow", undefined);
  assert.equal(v.isEcho, false);
  assert.match(v.reason, /not speaking/);
});

test("the mic hearing jarvis back is recognised as echo", () => {
  const spoken = "Muse Glimmer is a thirty billion parameter model for running agents locally";
  const heard = "muse glimmer is a thirty billion parameter model";
  assert.equal(judgeEcho(heard, spoken).isEcho, true);
});

test("a real interruption is not mistaken for echo", () => {
  const spoken = "Muse Glimmer is a thirty billion parameter model for running agents locally";
  assert.equal(judgeEcho("no stop tell me about the weather instead", spoken).isEcho, false);
});

test("short fragments need a total match before being dismissed", () => {
  const spoken = "the top hacker news story is about postgres";
  assert.equal(judgeEcho("hacker news", spoken).isEcho, true, "exact subset of a short phrase is echo");
  assert.equal(judgeEcho("hacker news weather", spoken).isEcho, false, "an extra content word makes it Kevin");
});

test("overlap is measured against what was heard, not what was said", () => {
  const spoken = "one two three four five six seven eight nine ten eleven twelve";
  assert.equal(echoOverlap("three four", spoken), 1);
});

test("stopwords cannot carry an echo verdict on their own", () => {
  assert.equal(judgeEcho("the and it is", "the answer is that it works").isEcho, true);
});

test("empty or noise-only input is treated as echo, not as a turn", () => {
  assert.equal(judgeEcho("", "anything").isEcho, true);
  assert.equal(judgeEcho("...", "anything").isEcho, true);
});

test("interruption needs real words, not a cough", () => {
  assert.equal(isRealInterruption("uh"), false);
  assert.equal(isRealInterruption("hmm"), false);
  assert.equal(isRealInterruption("stop talking about that"), true);
  assert.equal(isRealInterruption("tell me the weather"), true, "four words is intent");
});

test("short interruption cues fire on their own", () => {
  // A word-count rule rejected these, and they are the most likely things Kevin
  // will actually say to cut Jarvis off mid-sentence.
  for (const cue of ["stop", "no wait", "hold on", "actually", "nevermind"]) {
    assert.equal(isRealInterruption(cue), true, cue);
  }
});

test("normalizeWords strips punctuation but keeps apostrophes", () => {
  assert.deepEqual(normalizeWords("What's on, Hacker News?"), ["what's", "on", "hacker", "news"]);
});

test("case and punctuation never change an echo verdict", () => {
  const spoken = "The top story is about Postgres performance";
  assert.equal(judgeEcho("the TOP story is about POSTGRES performance!!", spoken).isEcho, true);
});
