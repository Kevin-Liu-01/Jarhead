import { test } from "node:test";
import assert from "node:assert/strict";
import { OPENAI_THRESHOLDS } from "../limits.ts";
import { isReversal, RulesDecider, RulesExtractor } from "../extract/rules.ts";
import type { ExtractInput, ExtractLine } from "../types.ts";
import { item } from "./helpers.ts";

/**
 * The free extractor: each spoken pattern becomes the expected third-person
 * sentence with its kind and weights; Jarhead's lines never do; ≤ 8 per run.
 * The rules decider: newest wins above the update threshold, ADD in the band.
 */

const cases: readonly [string, string, string, number, number][] = [
  ["call me Kev", "fact", "Kevin goes by Kev", 1.0, 0.9],
  ["My name is Kevin Liu", "fact", "Kevin goes by Kevin Liu", 1.0, 0.9],
  ["I prefer short answers", "preference", "Kevin prefers short answers", 0.6, 0.7],
  ["i don't like long explanations.", "preference", "Kevin dislikes long explanations", 0.6, 0.7],
  ["I can't stand autoplay", "preference", "Kevin cannot stand autoplay", 0.6, 0.7],
  ["my dentist is Dr. Patel", "contact", "Kevin's dentist is Dr. Patel", 0.6, 0.7],
  ["my office is in SoMa", "place", "Kevin's office is in SoMa", 0.6, 0.7],
  ["my favorite editor is Zed", "fact", "Kevin's favorite editor is Zed", 0.6, 0.7],
  ["from now on read the diff before saying a PR is fine", "procedure", "How Kevin likes it done: read the diff before saying a PR is fine", 0.8, 0.8],
  ["always ask before pushing", "procedure", "How Kevin likes it done: always ask before pushing", 0.8, 0.8],
  ["never touch the prod database", "procedure", "How Kevin likes it done: never touch the prod database", 0.8, 0.8],
  ["speak in english", "preference", "Kevin wants answers in English", 1.0, 0.9],
  ["Hey Jarhead, please remember that I prefer dark mode", "preference", "Kevin prefers dark mode", 0.9, 0.9],
  ["remember that my wife is Anna", "contact", "Kevin's wife is Anna", 0.9, 0.9],
  ["remember I'm allergic to nothing but meetings", "fact", "Kevin is allergic to nothing but meetings", 0.9, 0.9],
  ["remember that the standup moved to ten", "fact", "Kevin asked Jarhead to remember: the standup moved to ten", 0.9, 0.9],
  ["keep in mind that my flight lands at noon", "fact", "Kevin's flight lands at noon", 0.9, 0.9],
];

test("rules.classify: each pattern yields its kind, sentence and weights; a 'remember' carries origin kevin", () => {
  for (const [line, kind, text, importance, confidence] of cases) {
    const c = RulesExtractor.classify(line);
    assert.ok(c, `no candidate for: ${line}`);
    assert.equal(c.kind, kind, line);
    assert.equal(c.text, text, line);
    assert.equal(c.importance, importance, line);
    assert.equal(c.confidence, confidence, line);
    assert.equal(c.origin, /remember|keep in mind/i.test(line) ? "kevin" : "extracted", line);
    assert.ok(c.subjects.length <= 5 && c.subjects.every((s) => s === s.toLowerCase()));
  }
});

test("rules.classify: lines that match no rule yield nothing (task talk, questions, transient states)", () => {
  for (const line of ["open the diff for the auth branch", "what is the Claude session doing", "I'm in a meeting now", "yes", "thanks", "remember"]) {
    assert.equal(RulesExtractor.classify(line), undefined, line);
  }
});

test("rules.classify: ordinary voice chatter never becomes a memory — 'never mind', 'call me back', 'I like that', 'I never said that', 'I always forget' yield nothing", () => {
  const chatter = [
    "never mind", "never mind that", "Never mind, forget it", "never do that", "always", "never mind about the diff",
    "call me back", "call me later", "call me when it's done", "call me tomorrow morning", "call me in an hour", "call me Kevin please tomorrow",
    "I like that", "I like it", "I don't like this", "I prefer this one", "I love it", "I can't stand that", "I never said that", "I always forget", "I usually think so",
    "I never meant that", "I like that one better", "I always guess wrong",
  ];
  for (const line of chatter) assert.equal(RulesExtractor.classify(line), undefined, `false memory from: ${line}`);
  // the real shapes next to them still land
  assert.equal(RulesExtractor.classify("call me Kev please")?.text, "Kevin goes by Kev", "a trailing please is politeness, not a name");
  assert.equal(RulesExtractor.classify("call me Kevin Liu")?.text, "Kevin goes by Kevin Liu");
  assert.equal(RulesExtractor.classify("never touch the prod database")?.kind, "procedure");
  assert.equal(RulesExtractor.classify("always ask before pushing")?.kind, "procedure");
  assert.equal(RulesExtractor.classify("I prefer that you ask before pushing")?.text, "Kevin prefers that you ask before pushing", "a long object that starts with a pronoun is still a preference");
  assert.equal(RulesExtractor.classify("I always want the short version")?.text, "Kevin always want the short version");
  assert.equal(RulesExtractor.classify("remember that I like that")?.text, "Kevin asked Jarhead to remember: I like that", "an explicit remember is Kevin's call — recorded as asked");
});

test("rules.extract: only Kevin's lines produce candidates, evidence is the line number, and a run stops at 8", async () => {
  const lines: ExtractLine[] = [];
  let n = 0;
  for (let i = 0; i < 12; i++) {
    lines.push({ n: ++n, speaker: "Kevin", text: `I prefer option number ${i}`, at: i });
    lines.push({ n: ++n, speaker: "Jarhead", text: "I prefer that you say so", at: i });
  }
  const input: ExtractInput = { day: "2026-09-11", lines, requests: [], kevinLines: 12, pendingKevinLines: 12, upToAt: 11, truncated: false, dropped: 0 };
  const out = await new RulesExtractor().extract(input);
  assert.equal(out.length, 8);
  assert.deepEqual(out.map((c) => c.evidence), [[1], [3], [5], [7], [9], [11], [13], [15]], "odd lines are Kevin's");
  assert.ok(out.every((c) => c.text.startsWith("Kevin prefers option number")));
});

test("rules decider: ≥ update → UPDATE with the candidate's words (newest wins); in the band an antonym swap updates, anything else adds; never a contradiction", async () => {
  const d = new RulesDecider();
  const existing = item({ id: "m_1", text: "Kevin prefers dark mode", kind: "preference" });
  const c = { kind: "preference" as const, text: "Kevin prefers light mode", subjects: [], importance: 0.6, confidence: 0.7, evidence: [1] };
  const ctx = { thresholds: OPENAI_THRESHOLDS, now: 0 };
  assert.deepEqual(await d.decide(c, [{ item: existing, sim: 0.92 }], ctx), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true }, "above update, an antonym swap is newest-wins AND marked as replacing the old evidence");
  assert.deepEqual(await d.decide({ ...c, text: "Kevin likes dark mode" }, [{ item: existing, sim: 0.95 }], ctx), { op: "UPDATE", target: "m_1", text: "Kevin likes dark mode", contradicts: false, replaces: false }, "above update, a paraphrase is newest-wins and folds evidence");
  assert.deepEqual(await d.decide(c, [{ item: existing, sim: 0.8 }], ctx), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true }, "in the band, a one-word antonym swap is a reversal");
  const other = { ...c, text: "Kevin prefers a light editor theme" };
  assert.deepEqual(await d.decide(other, [{ item: existing, sim: 0.8 }], ctx), { op: "ADD", contradicts: false }, "in the band, anything else is a different thing");
  assert.ok(isReversal("Kevin prefers short answers", "Kevin prefers long answers"));
  assert.ok(isReversal("How Kevin likes it done: always ask before pushing", "How Kevin likes it done: never ask before pushing"));
  assert.ok(!isReversal("Kevin prefers short answers", "Kevin wants answers in English"));
  assert.ok(!isReversal("Kevin's dentist is Dr. Patel", "Kevin's doctor is Dr. Patel"), "dentist/doctor is not a reversal");
  assert.deepEqual(await d.decide(c, [{ item: existing, sim: 0.65 }], { ...ctx, thresholds: { update: 0.6, band: 0.4, dup: 0.7 } }), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true }, "the embedder's own table decides the lane");
});

test("release F1: the rules mint sentences about whoever the name says — the same shapes with Sam as subject, no literal Kevin; the extractor instance carries the name, and the default stays Kevin", async () => {
  for (const [line, kind, text] of cases) {
    const c = RulesExtractor.classify(line, "Sam");
    assert.ok(c, `no candidate for: ${line}`);
    assert.equal(c.kind, kind, line);
    assert.equal(c.text, text.replace(/^(How )?Kevin/, "$1Sam"), `${line}: the subject moves, a name the user spoke ("Kevin Liu") stays`);
    assert.doesNotMatch(c.text.replace(/Kevin Liu/, ""), /Kevin/, `${line}: only a name the user spoke ("My name is Kevin Liu") may keep the word`);
  }
  assert.equal(RulesExtractor.classify("I prefer short answers")?.text, "Kevin prefers short answers", "the default is unchanged");
  const input: ExtractInput = {
    day: "2026-09-11",
    lines: [
      { n: 1, speaker: "Kevin", text: "I prefer short answers", at: 1 } as ExtractLine,
      { n: 2, speaker: "Jarhead", text: "I prefer long ones", at: 2 } as ExtractLine,
      { n: 3, speaker: "Kevin", text: "remember that my wife is Anna", at: 3 } as ExtractLine,
    ],
    requests: [],
    kevinLines: 2,
    pendingKevinLines: 2,
    upToAt: 3,
    truncated: false,
    dropped: 0,
  };
  const out = await new RulesExtractor("Sam").extract(input);
  assert.deepEqual(out.map((c) => c.text), ["Sam prefers short answers", "Sam's wife is Anna"], "the user's lines only, in his name");
});
