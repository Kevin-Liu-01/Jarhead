import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript, joinFragments } from "../transcript.ts";
import { chunkForAppend, APPEND_CHAR_BUDGET, estimateTokens } from "../appender.ts";

test("fragments from one speaker merge into one utterance with real spacing", () => {
  const t = new Transcript(() => 0);
  const frags = [
    [" hey", 800, 1000], [", jar", 1400, 1600], ["head", 1600, 1800], [", can you", 2000, 2200], [" look", 2200, 2400],
    [" at my", 2400, 2600], [" screen", 3000, 3200],
  ] as const;
  for (const [delta, s, e] of frags) t.push({ speaker: "kevin", delta, startMs: s, endMs: e });
  const all = t.all();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.text, "hey, jarhead, can you look at my screen");
  assert.equal(all[0]?.startMs, 800);
  assert.equal(all[0]?.endMs, 3200);
});

test("a long pause or the other speaker starts a new utterance", () => {
  const t = new Transcript(() => 0);
  t.push({ speaker: "kevin", delta: "what time is it", startMs: 0, endMs: 900 });
  t.push({ speaker: "jarhead", delta: " ten past", startMs: 1200, endMs: 1600 });
  t.push({ speaker: "jarhead", delta: " four.", startMs: 1600, endMs: 1800 });
  t.push({ speaker: "kevin", delta: " thanks", startMs: 2000, endMs: 2300 });
  t.push({ speaker: "kevin", delta: " open slack", startMs: 6000, endMs: 6800 });
  const texts = t.all().map((i) => `${i.speaker}:${i.text}`);
  assert.deepEqual(texts, ["kevin:what time is it", "jarhead:ten past four.", "kevin:thanks", "kevin:open slack"]);
  assert.equal(t.all()[0]?.final, true, "an utterance is finalized when the next one begins");
  assert.equal(t.last("kevin")?.text, "open slack");
  assert.equal(t.since(5000, "kevin").length, 1);
});

test("settle finalizes stale utterances and render shows a window", () => {
  const t = new Transcript(() => 0);
  t.push({ speaker: "kevin", delta: "hello", startMs: 0, endMs: 500 });
  assert.equal(t.settle(600).length, 0);
  assert.equal(t.settle(3000).length, 1);
  assert.equal(t.all()[0]?.final, true);
  t.push({ speaker: "jarhead", delta: "hi", startMs: 3100, endMs: 3300 });
  assert.equal(t.render(10_000, 3300), "Kevin: hello\nJarhead: hi");
});

test("an utterance closed by the next one is emitted as final once — the ledger keeps the command Jarhead answered at once — and settle does not emit it again", () => {
  const t = new Transcript(() => 0);
  const finals: string[] = [];
  const kinds: string[] = [];
  t.onChange((item, kind) => {
    kinds.push(`${kind}:${item.speaker}`);
    if (kind === "final") finals.push(`${item.speaker}:${item.text}`);
  });
  t.push({ speaker: "kevin", delta: "jarhead scroll down", startMs: 0, endMs: 900 });
  // Jarhead answers 200 ms later: Kevin's utterance is closed by finalizeOpen (inside push), not by settle.
  t.push({ speaker: "jarhead", delta: " On it.", startMs: 1100, endMs: 1400 });
  assert.deepEqual(finals, ["kevin:jarhead scroll down"], "the closed utterance was emitted as final");
  assert.deepEqual(kinds, ["start:kevin", "final:kevin", "start:jarhead"], "final lands before the new utterance starts");
  assert.equal(t.all()[0]?.final, true);
  assert.equal(t.settle(5000).length, 1, "settle closes only the still-open jarhead line");
  assert.deepEqual(finals, ["kevin:jarhead scroll down", "jarhead:On it."], "nothing is emitted twice");
  // Explicit finalizeOpen with several open items (both speakers): one final each, nothing for what was already final.
  const t2 = new Transcript(() => 0);
  const closed: string[] = [];
  t2.onChange((item, kind) => kind === "final" && closed.push(item.text));
  t2.push({ speaker: "kevin", delta: "one", startMs: 0, endMs: 500 });
  t2.settle(3000);
  t2.push({ speaker: "kevin", delta: "two", startMs: 4000, endMs: 4500 });
  t2.finalizeOpen();
  t2.finalizeOpen();
  assert.deepEqual(closed, ["one", "two"]);
});

test("joinFragments handles punctuation and word pieces", () => {
  assert.equal(joinFragments("hey", ", jar"), "hey, jar");
  assert.equal(joinFragments("hey, jar", "head"), "hey, jarhead");
  assert.equal(joinFragments("chrome's", " up"), "chrome's up");
  assert.equal(joinFragments("", " on it"), "on it");
});

test("appends are chunked under the token cap at sentence boundaries", () => {
  const sentence = "The build finished with three warnings about unused imports in the auth module. ";
  const text = sentence.repeat(40);
  const chunks = chunkForAppend(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= APPEND_CHAR_BUDGET, `chunk too long: ${c.length}`);
    assert.ok(estimateTokens(c) <= 500);
    assert.ok(/[.!?]$/.test(c), `chunk should end at a sentence: …${c.slice(-30)}`);
  }
  assert.deepEqual(chunkForAppend("   "), []);
  assert.deepEqual(chunkForAppend("short one."), ["short one."]);
});
