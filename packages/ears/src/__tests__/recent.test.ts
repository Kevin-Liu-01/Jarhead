import { test } from "node:test";
import assert from "node:assert/strict";
import { RecentSpeech } from "../recent.ts";

test("anything older than the window is forgotten", () => {
  let t = 0;
  const r = new RecentSpeech(60_000, () => t);
  r.add("ancient history");
  t += 61_000;
  r.add("just now");
  assert.deepEqual(r.window().map((e) => e.text), ["just now"]);
});

test("the waking utterance is not repeated back as context", () => {
  // Including it makes the model answer the same question twice.
  let t = 0;
  const r = new RecentSpeech(60_000, () => t);
  r.add("the deploy finished");
  t += 5_000;
  r.add("you got that jarhead");
  assert.match(r.context(), /the deploy finished/);
  assert.doesNotMatch(r.context(), /you got that/);
});

test("context is stamped with how long ago each line was said", () => {
  let t = 0;
  const r = new RecentSpeech(60_000, () => t);
  r.add("first");
  t += 12_000;
  r.add("second");
  t += 1_000;
  r.add("waking line");
  const ctx = r.context();
  assert.match(ctx, /\[13s ago\] first/);
  assert.match(ctx, /\[1s ago\] second/);
});

test("only requests that lean on something get the context", () => {
  // A self-contained question must not drag room chatter into its answer.
  for (const c of ["you got that", "what was that", "say it again", "the same one", "explain this"]) {
    assert.equal(RecentSpeech.needsContext(c), true, c);
  }
  for (const c of ["what's on hacker news", "where is my cursor", "what time is it", ""]) {
    assert.equal(RecentSpeech.needsContext(c), false, c);
  }
  // "it" is a dummy subject far more often than a reference, so it is not a cue.
  assert.equal(RecentSpeech.needsContext("is it raining"), false);
});

test("an empty buffer yields empty context, not a stray header", () => {
  assert.equal(new RecentSpeech().context(), "");
});

test("blank transcripts are never stored", () => {
  const r = new RecentSpeech();
  r.add("   ");
  r.add("");
  assert.equal(r.window().length, 0);
});
