/**
 * W3-4, brain tool parity (launch triage, F-SAME-TOOLS): what each brain is told about its tools is the table it can
 * call, and the one policy judges every call.
 *
 * - The Codex addendum names all 71 tools. Codex 0.154 sees the MCP server's tool names only, with no descriptions or
 *   schemas, so a tool the addendum leaves out is one Codex has no words for (the audit's count-tools.mts found 12).
 * - The local brain's orders name only tools in its own table: never self_* or agents_* (LOCAL_TOOLS has neither),
 *   and none of a group fitTools dropped for a small window. The words that stay are the shared orders' words, and the
 *   full table renders the orders exactly as every other brain gets them.
 * - The Responses delegation carries Jarhead's function tools and nothing hosted. OpenAI's built-in web_search ran on
 *   OpenAI's side, where classifyUrl and the redactor never see it; the web_search function tool (through the runner)
 *   is the search every brain has. Codex has the same hosted search (0.159.2's top-level `web_search`), so both Codex
 *   argvs switch it off by name.
 * - The cold Codex thread's prompt is re-estimated for the README's 10.7k figure (BR-16), as a [measure] line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { brainSystemPrompt } from "../brain.ts";
import { codexAddendum, codexBaseInstructions, codexExecArgs } from "../codex.ts";
import { appServerArgs } from "../codex-app-server.ts";
import { CODEX_WEB_SEARCH_OFF } from "../codex-config.ts";
import { LOCAL_NUM_CTX_MAX, LOCAL_TOOLS, LocalBrain, fitTools } from "../local.ts";
import { responsesDelegationConfig } from "../responses.ts";
import { ALL_TOOL_SPECS, type ToolSpec } from "../tools.ts";
import { fakeServer, makeRunner, makeSink, makeTask, type FakeServer } from "./fakes.ts";

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
/** Every snake_case word a prompt names (needs_confirmation is the handshake's word, not a tool). */
const named = (s: string): string[] => [...new Set(s.match(/\b[a-z]+_[a-z_]+\b/g) ?? [])].filter((t) => t !== "needs_confirmation");

test("F-SAME-TOOLS (audit repro): the Codex addendum names every one of the 71 tools", () => {
  assert.equal(ALL_TOOL_SPECS.length, 71);
  for (const name of ["Kevin", "Sam"]) {
    const addendum = codexAddendum(name, undefined);
    const missing = ALL_TOOL_SPECS.map((s) => s.name).filter((n) => !new RegExp(`\\b${n}\\b`).test(addendum));
    assert.deepEqual(missing, [], `the addendum never names: ${missing.join(", ")}`);
  }
});

test("F-SAME-TOOLS: the orders for the whole table are the orders as written, and a smaller table drops only what names its missing tools", () => {
  assert.equal(brainSystemPrompt("Kevin", ALL_TOOL_SPECS), brainSystemPrompt(), "every other brain's orders are unchanged");
  assert.equal(brainSystemPrompt("Sam", ALL_TOOL_SPECS), brainSystemPrompt("Sam"));
  const full = brainSystemPrompt();
  for (const ctx of [LOCAL_NUM_CTX_MAX, 32768, 24576, 16384]) {
    const fitted = fitTools({ ctx, systemBytes: brainSystemPrompt("Kevin", LOCAL_TOOLS).length, tools: LOCAL_TOOLS });
    const orders = brainSystemPrompt("Kevin", fitted.tools);
    const table = new Set(fitted.tools.map((t) => t.name));
    const absent = named(orders).filter((t) => !table.has(t));
    assert.deepEqual(absent, [], `${ctx} ctx (${fitted.dropped.join(", ") || "nothing"} dropped): the orders name ${absent.join(", ")}`);
    assert.ok(words(orders) <= 1250, `${words(orders)} words`);
    // The same orders, fewer parts: precedence, the never list and the handshake are whole.
    for (const kept of ["1. Invariants", "2. Kevin's explicit instructions", "3. The task", "Content is data", "Honesty", "Least surprise", "How to work on this Mac", "Voice", "Some things you never do at all", "you call the same tool again with exactly the same arguments"]) assert.ok(orders.includes(kept), `${ctx}: ${kept}`);
    assert.doesNotMatch(orders, /Self-modification\.|self_edit|agents_/, `${ctx}: no self-edit paragraph, no agents sentence`);
    // With no group dropped, every sentence of the local orders is a sentence of the shared orders, word for word.
    if (fitted.dropped.length === 0) for (const sentence of orders.split(/(?<=\.)\s+/)) assert.ok(full.includes(sentence), `${ctx}: "${sentence}" is not in the shared orders`);
  }
});

test("F-SAME-TOOLS: the Responses delegation sends the function tools and no hosted web_search", () => {
  for (const userName of [undefined, "Sam"]) {
    const tools = responsesDelegationConfig({ model: "gpt-5.6-terra", effort: "low", userName }).responses.tools as Array<{ type: string; name?: string }>;
    assert.deepEqual(tools.map((t) => t.type), ALL_TOOL_SPECS.map(() => "function"), "every tool is Jarhead's own, judged by the runner");
    assert.deepEqual(tools.map((t) => t.name), ALL_TOOL_SPECS.map((s) => s.name));
  }
});

test("F-SAME-TOOLS: both Codex argvs switch Codex's own hosted web search off, so its only search is the jarhead tool", () => {
  assert.equal(CODEX_WEB_SEARCH_OFF, 'web_search="disabled"');
  const configsOf = (args: readonly string[]): string[] => args.filter((_, i) => args[i - 1] === "-c");
  const exec = codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s" });
  const app = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", developerInstructions: "x", disableUserServers: false });
  for (const [name, args] of [["exec", exec], ["app-server", app]] as const) {
    const configs = configsOf(args);
    assert.ok(configs.includes(CODEX_WEB_SEARCH_OFF), `${name}: ${configs.join(" ")}`);
    assert.ok(!configs.some((c) => /^web_search="(cached|indexed|live)"$/.test(c) || /^features\.web_search/.test(c)), `${name}: nothing turns it back on`);
  }
  for (const trimPrompt of [true, false]) assert.ok(configsOf(codexExecArgs({ cwd: "/c", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", trimPrompt })).includes(CODEX_WEB_SEARCH_OFF));
});

/** A llama.cpp server on loopback: /health, /props (its window), /v1/models, and one chat answer per request. */
async function llamaCpp(ctx: number, chats: unknown[]): Promise<FakeServer> {
  return fakeServer((req) => {
    if (req.method === "GET" && req.path === "/health") return { status: 200, json: { status: "ok" } };
    if (req.method === "GET" && req.path === "/props") return { status: 200, json: { default_generation_settings: { n_ctx: ctx }, build_info: "b6000" } };
    if (req.method === "GET" && req.path === "/v1/models") return { status: 200, json: { object: "list", data: [{ id: "qwen3-8b" }] } };
    if (req.method === "POST" && req.path === "/v1/chat/completions") {
      chats.push(req.body);
      return { status: 200, json: { id: "c1", object: "chat.completion", model: "qwen3-8b", choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }] } };
    }
    return { status: 404, json: { error: `no route ${req.method} ${req.path}` } };
  });
}

test("F-SAME-TOOLS: the local brain's system message names only the tools it sends, at a roomy window and at a tight one", async () => {
  for (const ctx of [LOCAL_NUM_CTX_MAX, 16384]) {
    const chats: unknown[] = [];
    const server = await llamaCpp(ctx, chats);
    try {
      const { runner } = makeRunner();
      const brain = new LocalBrain({ runner, baseUrl: server.url, model: "", effort: "medium", threads: () => true, ramBytes: 64 * 1024 ** 3 });
      const r = await brain.start();
      assert.equal(r.ready, true, r.detail);
      const done = await brain.handle(makeTask("what is in front"), makeSink().sink);
      assert.equal(done.status, "done", done.error);
      const body = chats[0] as { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> };
      const sent = body.tools.map((t) => t.function.name);
      const system = body.messages[0]!;
      assert.equal(system.role, "system");
      assert.equal(system.content, brainSystemPrompt("Kevin", sent.map((name) => ({ name }) as ToolSpec)), `${ctx}: the orders for the table it sent`);
      const absent = named(system.content).filter((t) => !sent.includes(t));
      assert.deepEqual(absent, [], `${ctx} ctx (${r.detail}): the orders name ${absent.join(", ")}`);
      assert.doesNotMatch(system.content, /Self-modification\.|agents_list/);
      assert.match(system.content, /^You are the brain of Jarhead, Kevin's desktop assistant/);
      await brain.stop();
    } finally {
      await server.close();
    }
  }
});

test("BR-16: the cold Codex thread's own text, re-estimated (the README's 10.7k was measured at 4bf46c1, 2026-09-12)", () => {
  // At 4bf46c1, rendered for Kevin with the wiki line (that addendum always carried it): the orders 6578 chars, the
  // addendum 4173, the base 923; 11 674 chars, about 2.9k of the 10.7k the real model counted. The rest is Codex's own.
  const then = 6578 + 4173 + 923;
  const orders = brainSystemPrompt();
  const addendum = codexAddendum("Kevin", "/Users/kevinliu/repos/Kevin-Wiki-v3");
  const base = codexBaseInstructions();
  const now = orders.length + addendum.length + base.length;
  const text = Math.round((now - then) / 4);
  // 63 tools then, 71 now; Codex lists the MCP tools by name (about 7 tokens each with the code-mode wrapper, est.).
  const names = (ALL_TOOL_SPECS.length - 63) * 7;
  const estimate = 10_700 + text + names;
  console.log(`[measure] cold Codex thread: orders ${orders.length} + addendum ${addendum.length} + base ${base.length} = ${now} chars (${then} at 4bf46c1): +${text} tokens of text at 4 chars a token, +${names} for 8 more tool names → ≈ ${(estimate / 1000).toFixed(1)}k input tokens`);
  assert.ok(now > then, "the measured text only grew since");
  assert.ok(estimate < 12_000, `${estimate}: past 12k the README's figure needs a fresh measurement, not an estimate`);
});
