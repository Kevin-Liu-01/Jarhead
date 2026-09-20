import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtractUnavailableError } from "../extract/extractor.ts";
import { DECIDE_INSTRUCTIONS, EXTRACT_INSTRUCTIONS, EXTRACT_MAX_ITEMS, EXTRACT_SCHEMA, extractInstructions, renderExtractUser, stripBounds } from "../extract/prompt.ts";
import { DEFAULT_MEMORY_MODEL, pickMemoryModel, ResponsesExtractor } from "../extract/responses.ts";
import { OPENAI_THRESHOLDS } from "../limits.ts";
import { postFilter } from "../merge.ts";
import type { ExtractInput } from "../types.ts";
import { fakeFetch, fixtureJson, item, jsonResponse, T0 } from "./helpers.ts";

/**
 * The paid extractor: the exact request (strict json_schema, store:false,
 * max_output_tokens 900), the parse of a real-shaped answer, and every failure
 * as an ExtractUnavailableError the service answers with rules. Model choice:
 * a mini-class id, the doctor's list narrowed by `pickMemoryModel`.
 */

const input: ExtractInput = {
  day: "2026-09-11",
  lines: [
    { n: 1, speaker: "Kevin", text: "call me Kev", at: T0 + 1 },
    { n: 2, speaker: "Jarhead", text: "Sure, Kev.", at: T0 + 2 },
    { n: 3, speaker: "Kevin", text: "I prefer short answers", at: T0 + 3 },
    { n: 4, speaker: "Jarhead", text: "Noted.", at: T0 + 4 },
  ],
  requests: [{ request: "open the diff for the auth branch", status: "done", summary: "Opened it.", at: T0 + 5 }],
  kevinLines: 2,
  pendingKevinLines: 2,
  upToAt: T0 + 5,
  truncated: false,
  dropped: 0,
};

test("responses extractor: the body is the exact instructions, numbered lines, strict json_schema, store:false, max_output_tokens 900, bearer from the getter; the fixture parses and the post-filter refuses what it must", async () => {
  const ff = fakeFetch(() => jsonResponse(fixtureJson("extract-response.json")));
  const x = new ResponsesExtractor({ apiKey: () => "sk-test", fetchImpl: ff.fetch, model: "gpt-5-mini", backoffMs: 0 });
  const raw = await x.extract(input);
  assert.equal(ff.calls.length, 1);
  const call = ff.calls[0]!;
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["authorization"], "Bearer sk-test");
  const body = call.body as Record<string, unknown>;
  assert.equal(body["model"], "gpt-5-mini");
  assert.equal(body["instructions"], EXTRACT_INSTRUCTIONS);
  assert.equal(body["input"], renderExtractUser(input));
  assert.equal(body["input"], ["Conversation on 2026-09-11 (Kevin's local day), lines numbered:", "1 Kevin: call me Kev", "2 Jarhead: Sure, Kev.", "3 Kevin: I prefer short answers", "4 Jarhead: Noted.", "Requests Jarhead worked on and how they ended:", '- "open the diff for the auth branch" — done: Opened it.'].join("\n"));
  assert.deepEqual(body["text"], { format: { type: "json_schema", name: "memory_candidates", strict: true, schema: (await import("../extract/prompt.ts")).EXTRACT_SCHEMA } });
  assert.equal(body["max_output_tokens"], 900);
  assert.equal(body["store"], false);
  assert.deepEqual(body["reasoning"], { effort: "minimal" });
  assert.match(EXTRACT_INSTRUCTIONS, /at least one cited line must be Kevin's/);
  assert.match(DECIDE_INSTRUCTIONS, /Set contradicts to true/);

  assert.equal(raw.length, 5);
  const kevin = new Set([1, 3]);
  const results = raw.map((c) => postFilter(c, { kevinLines: kevin }));
  assert.ok("ok" in results[0]! && results[0].ok.text === "Kevin goes by Kev." && results[0].ok.importance === 1 && results[0].ok.confidence === 0.9);
  assert.ok("ok" in results[1]! && results[1].ok.importance === 0.8 && results[1].ok.kind === "preference");
  assert.deepEqual(results[2], { refused: "no Kevin line cited" }, "Jarhead's guess about tiredness cites only line 2");
  assert.ok("ok" in results[3]! && results[3].ok.text.length <= 200 && results[3].ok.text.endsWith("."), "the long procedure is cut at a sentence end");
  assert.deepEqual(results[4], { refused: "card number" });
});

test("responses extractor: no key → no-key without a call; non-JSON body, an answer without output_text and a refusal → ExtractUnavailableError, never a throw of another kind", async () => {
  const none = fakeFetch(() => jsonResponse({}));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => undefined, fetchImpl: none.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "no-key");
  assert.equal(none.calls.length, 0);
  const notJson = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: notJson.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const noText = fakeFetch(() => jsonResponse({ status: "incomplete", output: [{ type: "reasoning" }] }));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: noText.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const badText = fakeFetch(() => jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "not json {" }] }] }));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: badText.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const refusal = fakeFetch(() => jsonResponse({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: refusal.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "refused");
});

test("responses extractor: 500 then 200 is one retry; 429 twice fails as http; a 400 about `reasoning` retries once without it and drops it for good; a hung server times out", async () => {
  const fixture = fixtureJson("extract-response.json");
  const once = fakeFetch((_c, n) => (n === 1 ? jsonResponse({ error: { message: "boom" } }, 500) : jsonResponse(fixture)));
  const got = await new ResponsesExtractor({ apiKey: () => "k", fetchImpl: once.fetch, backoffMs: 0 }).extract(input);
  assert.equal(once.calls.length, 2);
  assert.equal(got.length, 5);
  const twice = fakeFetch(() => jsonResponse({}, 429));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: twice.fetch, backoffMs: 0 }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "http" && e.status === 429);
  assert.equal(twice.calls.length, 2);
  const noReasoning = fakeFetch((c) => ((c.body as Record<string, unknown>)["reasoning"] ? new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning'" } }), { status: 400 }) : jsonResponse(fixture)));
  const x = new ResponsesExtractor({ apiKey: () => "k", fetchImpl: noReasoning.fetch, backoffMs: 0 });
  await x.extract(input);
  assert.equal(noReasoning.calls.length, 2);
  await x.extract(input);
  assert.equal(noReasoning.calls.length, 3, "the third call went straight without reasoning");
  assert.equal((noReasoning.calls[2]!.body as Record<string, unknown>)["reasoning"], undefined);
  const hung = fakeFetch(() => new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("aborted")), 50)));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: hung.fetch, timeoutMs: 10 }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "timeout");
  const plain = new ResponsesExtractor({ apiKey: () => "k", fetchImpl: once.fetch, model: "gpt-4.1-mini" });
  assert.equal(plain.model, "gpt-4.1-mini");
});

test("responses decider: the letter target maps to the neighbour, contradicts is read, and any failure falls back to the rules decision", async () => {
  const ff = fakeFetch(() => jsonResponse(fixtureJson("decide-response.json")));
  const x = new ResponsesExtractor({ apiKey: () => "k", fetchImpl: ff.fetch, backoffMs: 0 });
  const existing = item({ id: "m_1", text: "Kevin prefers dark mode", kind: "preference" });
  const c = { kind: "preference" as const, text: "Kevin prefers light mode", subjects: [], importance: 0.6, confidence: 0.7, evidence: [1] };
  const d = await x.decide(c, [{ item: existing, sim: 0.8 }], { thresholds: OPENAI_THRESHOLDS, now: T0 });
  assert.deepEqual(d, { op: "ADD", target: "m_1", contradicts: true });
  const body = ff.calls[0]!.body as Record<string, unknown>;
  assert.equal(body["instructions"], DECIDE_INSTRUCTIONS);
  assert.equal(body["input"], "Candidate: Kevin prefers light mode (kind preference, importance 3)\nExisting:\nA [m_1] Kevin prefers dark mode (preference, last seen 0 days ago, seen 1 times)");
  assert.deepEqual((body["text"] as { format: { name: string } }).format.name, "memory_decision");
  const down = fakeFetch(() => jsonResponse({}, 503));
  const y = new ResponsesExtractor({ apiKey: () => "k", fetchImpl: down.fetch, backoffMs: 0 });
  assert.deepEqual(await y.decide(c, [{ item: existing, sim: 0.92 }], { thresholds: OPENAI_THRESHOLDS, now: T0 }), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true });
  assert.deepEqual(await y.decide(c, [{ item: existing, sim: 0.8 }], { thresholds: OPENAI_THRESHOLDS, now: T0 }), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true }, "rules in the band: dark → light is an antonym swap");
  assert.deepEqual(await y.decide({ ...c, text: "Kevin prefers a light editor theme" }, [{ item: existing, sim: 0.8 }], { thresholds: OPENAI_THRESHOLDS, now: T0 }), { op: "ADD", contradicts: false });
});

test("responses extractor: a 400 that names a schema bound (minItems/maxItems/minimum/maximum) is answered once more with the bounds stripped, and stays stripped; the post-filter still caps at 24 items", async () => {
  let n = 0;
  const ff = fakeFetch((call) => {
    n++;
    const schema = JSON.stringify((call.body as { text: { format: { schema: unknown } } }).text.format.schema);
    if (/maxItems|minItems|minimum|maximum/.test(schema)) return jsonResponse({ error: { message: "Invalid schema for response_format 'memory_candidates': 'maxItems' is not permitted." } }, 400);
    return jsonResponse(fixtureJson("extract-response.json"));
  });
  const x = new ResponsesExtractor({ apiKey: () => "k", fetchImpl: ff.fetch, backoffMs: 0 });
  const raw = await x.extract(input);
  assert.equal(raw.length, 5, "the second call succeeded");
  assert.equal(ff.calls.length, 2, "one 400, one plain retry — not the 429 retry");
  const plain = JSON.stringify((ff.calls[1]!.body as { text: { format: { schema: unknown } } }).text.format.schema);
  assert.ok(!/maxItems|minItems|minimum|maximum/.test(plain), "no bound keyword anywhere in the stripped schema");
  assert.ok(/"strict":true/.test(JSON.stringify(ff.calls[1]!.body)), "still strict");
  assert.ok(/"enum"/.test(plain) && /"required"/.test(plain) && /"additionalProperties":false/.test(plain), "everything but the bounds survives");
  await x.extract(input);
  assert.equal(ff.calls.length, 3, "from then on the plain schema goes out first: no second 400");
  const stripped = stripBounds(EXTRACT_SCHEMA) as { properties: { items: Record<string, unknown> } };
  assert.ok(!("maxItems" in stripped.properties.items));
  assert.equal(EXTRACT_MAX_ITEMS, 24);
  // a bounds-free schema cannot cap the list: the parser does
  const many = fakeFetch(() => jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ kind: "fact", text: `Kevin fact ${i}`, subjects: [], importance: 3, confidence: 0.5, evidence: [1] })) }) }] }] }));
  const z = new ResponsesExtractor({ apiKey: () => "k", fetchImpl: many.fetch, backoffMs: 0 });
  assert.equal((await z.extract(input)).length, 24);
  // any other 400 is the configuration fault it looks like
  const bad = fakeFetch(() => jsonResponse({ error: { message: "The model `gpt-9-mini` does not exist" } }, 400));
  await assert.rejects(new ResponsesExtractor({ apiKey: () => "k", fetchImpl: bad.fetch, backoffMs: 0, model: "gpt-9-mini", reasoningEffort: "none" }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "http" && e.status === 400);
  assert.equal(bad.calls.length, 1);
});

test("pickMemoryModel: prefers the newest gpt-*-mini text model, undated over dated, skips audio/realtime/tts/search/nano/preview; undefined when nothing fits; the default is a mini id", () => {
  assert.equal(DEFAULT_MEMORY_MODEL, "gpt-5-mini");
  assert.equal(pickMemoryModel(["gpt-4o", "gpt-4o-mini", "gpt-4o-mini-tts", "gpt-4o-mini-realtime-preview", "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", "gpt-5-mini", "gpt-5-mini-2025-08-07", "gpt-5-nano", "o4-mini", "text-embedding-3-small"]), "gpt-5-mini");
  assert.equal(pickMemoryModel(["gpt-5-mini", "gpt-5.4-mini", "gpt-5.4", "gpt-5.4-mini-search-preview"]), "gpt-5.4-mini");
  assert.equal(pickMemoryModel(["gpt-4.1-mini", "o4-mini", "gpt-4o-mini"]), "gpt-4.1-mini");
  assert.equal(pickMemoryModel(["o3-mini", "o4-mini"]), "o4-mini");
  assert.equal(pickMemoryModel(["gpt-5-mini-2025-08-07"]), "gpt-5-mini-2025-08-07", "a dated id when nothing else exists");
  assert.equal(pickMemoryModel(["gpt-4o", "gpt-live-1", "gpt-4o-mini-tts", "gpt-5-nano"]), undefined);
  assert.equal(pickMemoryModel([]), undefined);
});

test("release F1: the extractor's instructions and transcript carry the user's name — the rules say \"Sam prefers …\", the lines are labelled \"Sam:\", no literal Kevin; the extractor option threads it into the request", async () => {
  const sam = extractInstructions("Sam");
  assert.doesNotMatch(sam, /Kevin/);
  assert.match(sam, /durable memory of Sam, the one person it works for/);
  assert.match(sam, /starting with "Sam", the named person, or the named place: "Sam prefers …", "Sam's dentist is …", "How Sam likes it done: …"/);
  assert.match(sam, /at least one cited line must be Sam's \("Sam:"\)/);
  assert.equal(sam.replaceAll("Sam", "Kevin"), EXTRACT_INSTRUCTIONS, "only the name moves");
  assert.equal(extractInstructions(), EXTRACT_INSTRUCTIONS);
  assert.equal(renderExtractUser(input, "Sam"), ["Conversation on 2026-09-11 (Sam's local day), lines numbered:", "1 Sam: call me Kev", "2 Jarhead: Sure, Kev.", "3 Sam: I prefer short answers", "4 Jarhead: Noted.", "Requests Jarhead worked on and how they ended:", '- "open the diff for the auth branch" — done: Opened it.'].join("\n"));
  const ff = fakeFetch(() => jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ items: [] }) }] }] }));
  await new ResponsesExtractor({ apiKey: () => "sk-test", fetchImpl: ff.fetch, backoffMs: 0, userName: "Sam" }).extract(input);
  const body = ff.calls[0]!.body as Record<string, unknown>;
  assert.equal(body["instructions"], sam);
  assert.equal(body["input"], renderExtractUser(input, "Sam"));
});
