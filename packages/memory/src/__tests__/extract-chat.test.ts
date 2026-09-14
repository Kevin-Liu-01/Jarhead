import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../embed/embedder.ts";
import { CHAT_DECIDE_TIMEOUT_MS, CHAT_EXTRACT_TIMEOUT_MS, ChatExtractor, stripThinking } from "../extract/chat.ts";
import { ExtractUnavailableError } from "../extract/extractor.ts";
import { DECIDE_INSTRUCTIONS, DECIDE_SCHEMA, EXTRACT_INSTRUCTIONS, EXTRACT_SCHEMA, renderDecideUser, renderExtractUser, stripBounds } from "../extract/prompt.ts";
import { OPENAI_THRESHOLDS } from "../limits.ts";
import { MemoryService } from "../service.ts";
import type { ExtractInput } from "../types.ts";
import { fakeFetch, fixtureJson, fixtureRows, fresh, ids, item, jsonResponse, redactFake, T0 } from "./helpers.ts";

/**
 * The local extractor over Chat Completions: the exact body (system + user,
 * temperature 0, max_tokens 900, strict json_schema), the json_object retry
 * on a server that refuses the schema shape, a thinking model's <think> block
 * stripped before the parse, every failure as an ExtractUnavailableError the
 * service answers with rules, the decider's clock, and the `local` kind on
 * the run row.
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

type ResponsesFixture = { output: { type: string; content?: { type: string; text?: string }[] }[] };

/** The Responses fixture's JSON text, as a local model would hand it back in message.content. */
function fixtureText(name: string): string {
  const fx = fixtureJson<ResponsesFixture>(name);
  return fx.output.find((o) => o.type === "message")!.content!.find((c) => c.type === "output_text")!.text!;
}

function chatResponse(content: string | null, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ id: "chatcmpl-1", object: "chat.completion", model: "qwen3.5:27b", choices: [{ index: 0, message: { role: "assistant", content, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } });
}

const body = (n: number, ff: ReturnType<typeof fakeFetch>): Record<string, unknown> => ff.calls[n]!.body as Record<string, unknown>;
const messages = (b: Record<string, unknown>): { role: string; content: string }[] => b["messages"] as { role: string; content: string }[];

test("chat extractor: POST {base}/v1/chat/completions with system + user messages, temperature 0, max_tokens 900, stream false, strict json_schema, no bearer without a key; the fixture parses to five raw candidates; kind is local", async () => {
  const ff = fakeFetch(() => chatResponse(fixtureText("extract-response.json")));
  const x = new ChatExtractor({ baseUrl: "http://127.0.0.1:11434/", model: "qwen3.5:27b", fetchImpl: ff.fetch });
  assert.equal(x.kind, "local");
  const raw = await x.extract(input);
  assert.equal(ff.calls.length, 1);
  const call = ff.calls[0]!;
  assert.equal(call.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["authorization"], undefined);
  assert.equal(call.headers["content-type"], "application/json");
  const b = body(0, ff);
  assert.equal(b["model"], "qwen3.5:27b");
  assert.equal(b["temperature"], 0);
  assert.equal(b["max_tokens"], 900);
  assert.equal(b["stream"], false);
  assert.deepEqual(b["response_format"], { type: "json_schema", json_schema: { name: "memory_candidates", schema: EXTRACT_SCHEMA, strict: true } });
  assert.deepEqual(messages(b), [
    { role: "system", content: EXTRACT_INSTRUCTIONS },
    { role: "user", content: renderExtractUser(input) },
  ]);
  assert.equal(raw.length, 5);
  assert.equal(raw[0]!.text, "Kevin goes by Kev.");
  assert.equal(raw[0]!.origin, "extracted");
  const withKey = fakeFetch(() => chatResponse(fixtureText("extract-response.json")));
  await new ChatExtractor({ baseUrl: "http://127.0.0.1:1234/v1", model: "m", fetchImpl: withKey.fetch, apiKey: "lm-token" }).extract(input);
  assert.equal(withKey.calls[0]!.url, "http://127.0.0.1:1234/v1/chat/completions", "a trailing /v1 is not doubled");
  assert.equal(withKey.calls[0]!.headers["authorization"], "Bearer lm-token");
});

test("chat extractor: a 400 on the json_schema shape is asked once more as json_object with the bounds-free schema written into the user text — and stays that way; a 400 in json_object mode is the http fault it is", async () => {
  const ff = fakeFetch((call) => {
    const rf = (call.body as { response_format: { type: string } }).response_format;
    if (rf.type === "json_schema") return new Response(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }), { status: 400 });
    return chatResponse(fixtureText("extract-response.json"));
  });
  const x = new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: ff.fetch });
  const raw = await x.extract(input);
  assert.equal(raw.length, 5);
  assert.equal(ff.calls.length, 2, "one 400, one json_object retry");
  const retry = body(1, ff);
  assert.deepEqual(retry["response_format"], { type: "json_object" });
  assert.equal(retry["temperature"], 0);
  const user = messages(retry)[1]!.content;
  assert.ok(user.startsWith(renderExtractUser(input)), "the transcript is still the user text");
  assert.ok(user.includes(JSON.stringify(stripBounds(EXTRACT_SCHEMA))), "the schema follows, without its bounds");
  assert.ok(!/maxItems|minItems|minimum|maximum/.test(user));
  assert.equal(messages(retry)[0]!.content, EXTRACT_INSTRUCTIONS);
  await x.extract(input);
  assert.equal(ff.calls.length, 3, "from then on json_object goes out first: no second 400");
  assert.deepEqual(body(2, ff)["response_format"], { type: "json_object" });
  const always400 = fakeFetch(() => new Response(JSON.stringify({ error: { message: "model 'nope' not found" } }), { status: 400 }));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "nope", fetchImpl: always400.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "http" && e.status === 400 && /not found/.test(e.message));
  assert.equal(always400.calls.length, 2, "the json_object retry, then the fault is reported");
});

test("chat extractor: a thinking model's <think> block, an unterminated one, a <thinking> block, the harmony analysis channel and ``` fences are stripped before the parse; content that is still not JSON is bad-json", async () => {
  const json = fixtureText("extract-response.json");
  const wrapped = fakeFetch(() => chatResponse(`<think>\nLet me read the lines.\nLine 1 is Kevin's name.\n</think>\n${json}`));
  assert.equal((await new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: wrapped.fetch }).extract(input)).length, 5);
  const fenced = fakeFetch(() => chatResponse(`<thinking>hmm</thinking>\n\`\`\`json\n${json}\n\`\`\``));
  assert.equal((await new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: fenced.fetch }).extract(input)).length, 5);
  const harmony = fakeFetch(() => chatResponse(`<|channel|>analysis<|message|>Reading the transcript…<|end|><|start|>assistant<|channel|>final<|message|>${json}`));
  assert.equal((await new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "gpt-oss:20b", fetchImpl: harmony.fetch }).extract(input)).length, 5);
  assert.equal(stripThinking(`<think>a</think> {"x":1} <think>b</think>`), '{"x":1}');
  assert.equal(stripThinking("<think>never closed\n{\"x\":1}"), "", "an unterminated leading block is all reasoning");
  assert.equal(stripThinking('{"x":1}'), '{"x":1}');
  assert.equal(stripThinking('<|channel|>analysis<|message|>thinking<|end|><|start|>assistant<|channel|>final<|message|>{"x":1}'), '{"x":1}');
  const open = fakeFetch(() => chatResponse(`<think>still thinking when max_tokens hit ${json}`));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: open.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const prose = fakeFetch(() => chatResponse("Here are the items: none."));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: prose.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const noItems = fakeFetch(() => chatResponse('{"candidates": []}'));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: noItems.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json" && /no items array/.test(e.message));
  const nullContent = fakeFetch(() => chatResponse(null, { reasoning: "I thought about it" }));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: nullContent.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const notJson = fakeFetch(() => new Response("<html>lm studio</html>", { status: 200 }));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: notJson.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "bad-json");
  const refusal = fakeFetch(() => chatResponse(null, { refusal: "I cannot" }));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: refusal.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "refused");
});

test("chat extractor: a hung server is timeout (default 90 s for a cold 27B); 500 then 200 is one retry; 5xx twice is http with the status; the abort signal wins over the timeout and is rethrown as itself", async () => {
  assert.equal(CHAT_EXTRACT_TIMEOUT_MS, 90_000);
  const hung = fakeFetch(() => new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("aborted")), 50)));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: hung.fetch, extractTimeoutMs: 10 }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "timeout");
  const once = fakeFetch((_c, n) => (n === 1 ? jsonResponse({ error: "loading" }, 503) : chatResponse(fixtureText("extract-response.json"))));
  assert.equal((await new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: once.fetch }).extract(input)).length, 5);
  assert.equal(once.calls.length, 2);
  const twice = fakeFetch(() => jsonResponse({}, 502));
  await assert.rejects(new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: twice.fetch }).extract(input), (e: unknown) => e instanceof ExtractUnavailableError && e.code === "http" && e.status === 502);
  assert.equal(twice.calls.length, 2);
  const ac = new AbortController();
  const slow = fakeFetch(() => new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("The operation was aborted")), 5)));
  const p = new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: slow.fetch }).extract(input, ac.signal);
  ac.abort();
  await assert.rejects(p, (e: unknown) => !(e instanceof ExtractUnavailableError));
});

test("chat decider: the decide body carries DECIDE_INSTRUCTIONS and the rendered candidate with the memory_decision schema; the letter maps to the neighbour; past decideTimeoutMs (8 s by default) or on any failure the rules decision answers", async () => {
  assert.equal(CHAT_DECIDE_TIMEOUT_MS, 8_000);
  const ff = fakeFetch(() => chatResponse(fixtureText("decide-response.json")));
  const x = new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: ff.fetch });
  const existing = item({ id: "m_1", text: "Kevin prefers dark mode", kind: "preference" });
  const c = { kind: "preference" as const, text: "Kevin prefers light mode", subjects: [], importance: 0.6, confidence: 0.7, evidence: [1] };
  const d = await x.decide(c, [{ item: existing, sim: 0.8 }], { thresholds: OPENAI_THRESHOLDS, now: T0 });
  assert.deepEqual(d, { op: "ADD", target: "m_1", contradicts: true });
  const b = body(0, ff);
  assert.deepEqual(messages(b), [
    { role: "system", content: DECIDE_INSTRUCTIONS },
    { role: "user", content: renderDecideUser(c, [{ item: existing, sim: 0.8 }], T0) },
  ]);
  assert.deepEqual(b["response_format"], { type: "json_schema", json_schema: { name: "memory_decision", schema: DECIDE_SCHEMA, strict: true } });
  assert.equal(b["max_tokens"], 900);
  // a slow model: the rules decision after decideTimeoutMs, and the extract timeout was not the one used
  const slow = fakeFetch(() => new Promise<Response>((_r, reject) => setTimeout(() => reject(new Error("aborted")), 80)));
  const y = new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: slow.fetch, decideTimeoutMs: 10, extractTimeoutMs: 5000 });
  const t0 = Date.now();
  assert.deepEqual(await y.decide(c, [{ item: existing, sim: 0.92 }], { thresholds: OPENAI_THRESHOLDS, now: T0 }), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true });
  assert.ok(Date.now() - t0 < 1000, "the decider's own clock, not the extractor's");
  const down = fakeFetch(() => jsonResponse({}, 503));
  const z = new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: down.fetch });
  assert.deepEqual(await z.decide({ ...c, text: "Kevin prefers a light editor theme" }, [{ item: existing, sim: 0.8 }], { thresholds: OPENAI_THRESHOLDS, now: T0 }), { op: "ADD", contradicts: false });
  const badOp = fakeFetch(() => chatResponse('{"op":"DELETE","target":"A","text":"","contradicts":false}'));
  assert.deepEqual(await new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", fetchImpl: badOp.fetch }).decide(c, [{ item: existing, sim: 0.8 }], { thresholds: OPENAI_THRESHOLDS, now: T0 }), { op: "UPDATE", target: "m_1", text: "Kevin prefers light mode", contradicts: false, replaces: true }, "bad-json inside decide is the rules decision too");
});

test("chat extractor: maxChars is 24 000 for a window of 32k or more, 12 000 for a smaller or unknown one", () => {
  const at = (contextLength?: number) => new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "m", ...(contextLength !== undefined ? { contextLength } : {}) }).maxChars;
  assert.equal(at(), 12_000);
  assert.equal(at(8192), 12_000);
  assert.equal(at(32_767), 12_000);
  assert.equal(at(32_768), 24_000);
  assert.equal(at(262_144), 24_000);
});

test("chat extractor through the service: a run over the fixture lands with extractor `local` in the memory.run row, the watermark and the summary; nothing went anywhere but the local base URL", async () => {
  const ff = fakeFetch((call) => {
    const user = messages(call.body as Record<string, unknown>)[1]!.content;
    // extract by rule from the numbered lines the service rendered — what a local model would do, deterministic
    const items = user
      .split("\n")
      .map((l) => /^(\d+) Kevin: (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .flatMap((m) => {
        const text = m[2]!;
        if (/call me (\w+)/i.test(text)) return [{ kind: "fact", text: `Kevin goes by ${/call me (\w+)/i.exec(text)![1]}`, subjects: ["name"], importance: 5, confidence: 0.9, evidence: [Number(m[1])] }];
        if (/dentist is (.+)/i.test(text)) return [{ kind: "contact", text: `Kevin's dentist is ${/dentist is (.+)/i.exec(text)![1]}`, subjects: ["dentist"], importance: 3, confidence: 0.9, evidence: [Number(m[1])] }];
        return [];
      });
    return chatResponse(JSON.stringify({ items }));
  });
  const rows: { type: string; extractor?: string }[] = [];
  const svc = new MemoryService({
    dir: fresh(),
    now: () => T0 + 100_000,
    embedder: new FakeEmbedder(),
    extractor: new ChatExtractor({ baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:27b", fetchImpl: ff.fetch }),
    redact: redactFake,
    onRow: (r) => rows.push(r as { type: string; extractor?: string }),
    newId: ids(),
    log: { info() {}, warn() {} },
  });
  const r = await svc.ingestSession("A", fixtureRows());
  assert.equal(r.status, "ran");
  assert.equal(r.extractor, "local");
  assert.ok(r.added >= 2, `${r.added} added`);
  assert.equal(svc.store.watermark("A")?.extractor, "local");
  const run = rows.find((x) => x.type === "memory.run");
  assert.ok(run && run.extractor === "local", JSON.stringify(run));
  assert.equal(svc.summary().lastRun?.extractor, "local");
  assert.ok(ff.calls.length >= 1);
  assert.ok(ff.calls.every((c) => c.url.startsWith("http://127.0.0.1:11434/")), "every request stayed on the Mac");
  assert.ok(ff.calls.every((c) => !("authorization" in c.headers)));
});
