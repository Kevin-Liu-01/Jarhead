import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtractUnavailableError } from "../extract/extractor.ts";
import { parseCandidates, parseDecision } from "../extract/parse.ts";
import { EXTRACT_MAX_ITEMS } from "../extract/prompt.ts";
import type { Neighbour } from "../types.ts";
import { fixtureJson, item } from "./helpers.ts";

/**
 * The one reader of the model's JSON, shared by the Responses and the local
 * Chat extractors: pinned against the same fixtures responses.test.ts sends
 * through the wire, so both extractors are known to read the same shapes the
 * same way.
 */

type ResponsesFixture = { output: { type: string; content?: { type: string; text?: string }[] }[] };

/** The JSON the Responses fixture's output_text carries — what either wire hands the parser. */
function outputJson(name: string): unknown {
  const fx = fixtureJson<ResponsesFixture>(name);
  const text = fx.output.find((o) => o.type === "message")!.content!.find((c) => c.type === "output_text")!.text!;
  return JSON.parse(text) as unknown;
}

test("parseCandidates: the extract fixture yields five raw candidates with the schema's 1..5 importance untouched, origin extracted, subjects and evidence as given", () => {
  const raw = parseCandidates(outputJson("extract-response.json"));
  assert.equal(raw.length, 5);
  assert.deepEqual(raw[0], { kind: "fact", text: "Kevin goes by Kev.", subjects: ["name"], importance: 5, confidence: 0.9, evidence: [1], origin: "extracted" });
  assert.deepEqual(raw[1]!.evidence, [3, 4]);
  assert.equal(raw[1]!.kind, "preference");
  assert.equal(raw[2]!.text, "Kevin is probably tired today.");
  assert.equal(raw[3]!.kind, "procedure");
  assert.ok(raw[3]!.text.length > 200, "the parser does not cut; the post-filter does");
  assert.equal(raw[4]!.text, "Kevin's card is 4111 1111 1111 1111.", "the parser does not refuse; the post-filter does");
});

test("parseCandidates: no items array (a bare object, an array, null, a string) is bad-json; a row of the wrong shape is skipped, not fatal; missing numbers take the defaults; non-string subjects and non-number evidence are dropped; the list is cut at EXTRACT_MAX_ITEMS", () => {
  for (const bad of [{}, { items: "none" }, [], null, "x", 7, { items: null }]) {
    assert.throws(() => parseCandidates(bad), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json", JSON.stringify(bad));
  }
  assert.deepEqual(parseCandidates({ items: [] }), []);
  const mixed = parseCandidates({
    items: [
      { kind: "fact", text: "Kevin likes jazz" },
      { kind: "mood", text: "Kevin is happy" },
      { kind: "fact" },
      { text: "no kind" },
      "a string",
      null,
      42,
      { kind: "place", text: "Kevin's office is in SoMa", subjects: ["office", 3, null], importance: "high", confidence: "sure", evidence: [4, "5", 6.5] },
    ],
  });
  assert.equal(mixed.length, 2);
  assert.deepEqual(mixed[0], { kind: "fact", text: "Kevin likes jazz", subjects: [], importance: 3, confidence: 0.5, evidence: [], origin: "extracted" });
  assert.deepEqual(mixed[1], { kind: "place", text: "Kevin's office is in SoMa", subjects: ["office"], importance: 3, confidence: 0.5, evidence: [4, 6.5], origin: "extracted" });
  assert.equal(EXTRACT_MAX_ITEMS, 24);
  const many = parseCandidates({ items: Array.from({ length: 40 }, (_, i) => ({ kind: "fact", text: `Kevin fact ${i}`, subjects: [], importance: 3, confidence: 0.5, evidence: [1] })) });
  assert.equal(many.length, 24);
  assert.equal(many[23]!.text, "Kevin fact 23");
});

const existing: Neighbour[] = [
  { item: item({ id: "m_1", text: "Kevin prefers dark mode", kind: "preference" }), sim: 0.8 },
  { item: item({ id: "m_2", text: "Kevin likes a dark editor", kind: "preference" }), sim: 0.78 },
];

test("parseDecision: the decide fixture's letter target maps to the neighbour's id, contradicts is read, and an empty text is omitted", () => {
  assert.deepEqual(parseDecision(outputJson("decide-response.json"), existing), { op: "ADD", target: "m_1", contradicts: true });
  assert.deepEqual(parseDecision({ op: "UPDATE", target: "B", text: "  Kevin prefers a dark editor theme  ", contradicts: false }, existing), { op: "UPDATE", target: "m_2", text: "Kevin prefers a dark editor theme", contradicts: false });
  assert.deepEqual(parseDecision({ op: "NOOP", target: "m_2", text: "", contradicts: "yes" }, existing), { op: "NOOP", target: "m_2", contradicts: false }, "an id names the neighbour too; contradicts is only ever the boolean true");
});

test("parseDecision: a letter past the list, an unknown id or a missing target is no target; an op outside ADD | UPDATE | NOOP, or no object at all, is bad-json", () => {
  assert.deepEqual(parseDecision({ op: "ADD", target: "J", contradicts: false }, existing), { op: "ADD", contradicts: false });
  assert.deepEqual(parseDecision({ op: "ADD", target: "m_9", contradicts: false }, existing), { op: "ADD", contradicts: false });
  assert.deepEqual(parseDecision({ op: "ADD" }, existing), { op: "ADD", contradicts: false });
  assert.deepEqual(parseDecision({ op: "UPDATE", target: "a" }, existing), { op: "UPDATE", contradicts: false }, "the letters are upper case");
  for (const bad of [{ op: "DELETE", target: "A" }, { op: "add" }, {}, null, "ADD", [], { op: 1 }]) {
    assert.throws(() => parseDecision(bad, existing), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json" && /bad op/.test(e.message), JSON.stringify(bad));
  }
});
