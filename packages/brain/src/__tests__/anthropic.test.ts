import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicBrain, anthropicReasoning, claudeGeneration, resolveAnthropicModel, toAnthropicTool } from "../anthropic.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";
import { fakeServer, makeRunner, makeSink, makeTask } from "./fakes.ts";

const MODEL_INFO = { id: "claude-opus-5", type: "model", display_name: "Claude Opus 5", created_at: "2026-04-01T00:00:00Z" };

function message(content: unknown[], stop_reason: string): unknown {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content, stop_reason, stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } };
}

test("anthropic tool definitions and reasoning config follow the model", () => {
  const scroll = toAnthropicTool(specByName("scroll")!);
  assert.equal(scroll.name, "scroll");
  assert.equal(scroll.input_schema.type, "object");
  assert.deepEqual(scroll.input_schema.required, ["scroll_direction", "scroll_amount"]);
  assert.equal(ALL_TOOL_SPECS.map(toAnthropicTool).length, ALL_TOOL_SPECS.length);

  assert.deepEqual(claudeGeneration("claude-opus-4-8"), { major: 4, minor: 8 });
  assert.deepEqual(claudeGeneration("claude-opus-5"), { major: 5, minor: 0 });
  assert.deepEqual(claudeGeneration("claude-3-5-sonnet-20241022"), { major: 3, minor: 5 });
  assert.equal(claudeGeneration("my-gateway-alias"), undefined);

  assert.deepEqual(anthropicReasoning("claude-opus-5", "medium"), { thinking: { type: "adaptive" }, effort: "medium" });
  assert.deepEqual(anthropicReasoning("claude-opus-4-6", "xhigh"), { thinking: { type: "adaptive" }, effort: "high" });
  assert.deepEqual(anthropicReasoning("claude-haiku-4-5", "high"), {}, "no budget_tokens, no effort on pre-4.6 models");
  assert.deepEqual(anthropicReasoning("my-gateway-alias", "high"), {});

  assert.equal(resolveAnthropicModel(undefined), "claude-opus-5");
  assert.equal(resolveAnthropicModel("gpt-5.6-terra"), "claude-opus-5", "another brain's leftover model");
  assert.equal(resolveAnthropicModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(resolveAnthropicModel("my-gateway-alias"), "my-gateway-alias");
});

test("anthropic brain: one tool round-trip through the runner, then the spoken answer", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.method === "GET" && req.path.startsWith("/v1/models/")) return { status: 200, json: MODEL_INFO };
    if (req.method === "POST" && req.path === "/v1/messages") {
      posts++;
      if (posts === 1) return { status: 200, json: message([{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "frontmost_app", input: {} }], "tool_use") };
      return { status: 200, json: message([{ type: "text", text: "Finder is in front." }], "end_turn") };
    }
    return { status: 404, json: { type: "error", error: { type: "not_found_error", message: `no route ${req.path}` } } };
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, model: "claude-opus-5", effort: "medium", maxRetries: 0 });
    const started = await brain.start();
    assert.equal(started.ready, true, started.detail);
    assert.match(started.detail, /Claude Opus 5/);
    assert.match(started.detail, /adaptive thinking/);
    assert.equal(server.seen[0]?.path, "/v1/models/claude-opus-5");
    assert.equal(server.seen[0]?.headers["x-api-key"], "sk-ant-test");

    const log = makeSink();
    const result = await brain.handle(makeTask("what app is in front"), log.sink);
    assert.equal(result.status, "done");
    assert.equal(result.summary, "Finder is in front.");

    const first = server.seen[1]!.body as { model: string; system: string; tools: unknown[]; thinking: unknown; output_config: unknown; tool_choice: unknown; messages: Array<{ role: string; content: unknown }> };
    assert.equal(first.model, "claude-opus-5");
    assert.match(first.system, /brain of Jarhead/);
    assert.equal(first.tools.length, ALL_TOOL_SPECS.length);
    assert.deepEqual(first.thinking, { type: "adaptive" });
    assert.deepEqual(first.output_config, { effort: "medium" });
    assert.deepEqual(first.tool_choice, { type: "auto", disable_parallel_tool_use: false }, "several calls per turn are allowed; batch.ts runs look-only ones together and acting ones in order");
    assert.equal(first.messages.length, 1);
    assert.match(String(first.messages[0]!.content), /Kevin said: "what app is in front"/);

    const second = server.seen[2]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(second.messages.map((m) => m.role), ["user", "assistant", "user"]);
    const results = second.messages[2]!.content as Array<{ type: string; tool_use_id: string; content: string }>;
    assert.equal(results[0]?.type, "tool_result");
    assert.equal(results[0]?.tool_use_id, "toolu_1");
    assert.match(results[0]!.content, /Finder/);

    assert.deepEqual(log.thinking, ["Checking which app is in front."]);
    assert.ok(log.steps.includes("note:Let me look."), `steps: ${log.steps.join(",")}`);
    assert.ok(log.steps.includes("tool:frontmost_app"));

    // The exchange is remembered as plain text for the next delegation.
    posts = 0;
    const again = await brain.handle(makeTask("and now?"), makeSink().sink);
    assert.equal(again.status, "done");
    const third = server.seen[3]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(third.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(third.messages[1]!.content, "Finder is in front.");
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("anthropic brain: screenshots go back as base64 image blocks", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.method === "GET") return { status: 200, json: MODEL_INFO };
    posts++;
    if (posts === 1) return { status: 200, json: message([{ type: "tool_use", id: "toolu_shot", name: "screenshot", input: {} }], "tool_use") };
    return { status: 200, json: message([{ type: "text", text: "I see the desktop." }], "end_turn") };
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, maxRetries: 0 });
    await brain.start();
    const log = makeSink();
    const result = await brain.handle(makeTask("look at the screen"), log.sink);
    assert.equal(result.status, "done");
    const second = server.seen[2]!.body as { messages: Array<{ content: Array<{ type: string; content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }> }> }> };
    const block = second.messages[2]!.content[0]!;
    assert.equal(block.type, "tool_result");
    assert.equal(block.content[0]?.type, "image");
    assert.equal(block.content[0]?.source?.media_type, "image/png");
    assert.equal(block.content[0]?.source?.data, Buffer.from("png").toString("base64"));
    assert.equal(block.content[1]?.type, "text");
    assert.ok(log.steps.includes("shot:shots"));
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("anthropic brain: cancel mid-loop aborts the request and frees the brain", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.method === "GET") return { status: 200, json: MODEL_INFO };
    posts++;
    if (posts === 1) return { status: 200, json: message([{ type: "tool_use", id: "toolu_1", name: "frontmost_app", input: {} }], "tool_use") };
    return "hang";
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, maxRetries: 0 });
    await brain.start();
    const abort = new AbortController();
    const pending = brain.handle(makeTask("do something long", abort.signal), makeSink().sink);
    await server.arrived(3); // the second /v1/messages is now hanging
    abort.abort();
    await brain.cancel();
    const result = await pending;
    assert.equal(result.status, "cancelled");

    // The brain is free again right away.
    posts = 0;
    const server2Result = brain.handle(makeTask("quick one"), makeSink().sink);
    await server.arrived(4);
    assert.equal(server.seen[3]?.path, "/v1/messages");
    // The fake still hangs on non-first posts; cancel to finish the test cleanly.
    await brain.cancel();
    assert.equal((await server2Result).status, "cancelled");
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("anthropic brain: 401 at start reports not ready with a clear detail; a missing key never touches the network", async () => {
  const server = await fakeServer(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }));
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-bad", baseUrl: server.url, maxRetries: 0 });
    const r = await brain.start();
    assert.equal(r.ready, false);
    assert.match(r.detail, /ANTHROPIC_API_KEY is rejected by the API \(401\)/);
    const h = await brain.handle(makeTask("anything"), makeSink().sink);
    assert.equal(h.status, "failed");
    assert.match(h.error ?? "", /rejected/);

    const none = new AnthropicBrain({ runner, apiKey: undefined, baseUrl: server.url });
    const r2 = await none.start();
    assert.equal(r2.ready, false);
    assert.match(r2.detail, /ANTHROPIC_API_KEY is not set/);
    assert.equal(server.seen.length, 1, "only the bad-key probe reached the server");
  } finally {
    await server.close();
  }
});

test("anthropic brain: a refusal and a step budget end the task honestly", async () => {
  let mode: "refusal" | "loop" = "refusal";
  const server = await fakeServer((req) => {
    if (req.method === "GET") return { status: 200, json: MODEL_INFO };
    if (mode === "refusal") return { status: 200, json: { ...(message([], "refusal") as object), stop_details: { type: "refusal", category: "cyber", explanation: "not doing that" } } };
    return { status: 200, json: message([{ type: "tool_use", id: `toolu_${Date.now()}`, name: "frontmost_app", input: {} }], "tool_use") };
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, maxRetries: 0, maxSteps: 3 });
    await brain.start();
    const refused = await brain.handle(makeTask("bad idea"), makeSink().sink);
    assert.equal(refused.status, "failed");
    assert.match(refused.error ?? "", /declined: not doing that/);

    mode = "loop";
    const log = makeSink();
    const capped = await brain.handle(makeTask("forever"), log.sink);
    assert.equal(capped.status, "failed");
    assert.match(capped.error ?? "", /3 tool calls/);
    assert.equal(log.steps.filter((s) => s === "tool:frontmost_app").length, 3);
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("anthropic brain: a turn cut off by max_tokens with a pending tool call fails instead of speaking the preamble", async () => {
  const server = await fakeServer((req) => {
    if (req.method === "GET") return { status: 200, json: MODEL_INFO };
    return { status: 200, json: message([{ type: "text", text: "Let me click" }, { type: "tool_use", id: "toolu_1", name: "frontmost_app", input: {} }], "max_tokens") };
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, maxRetries: 0 });
    await brain.start();
    const log = makeSink();
    const r = await brain.handle(makeTask("click it"), log.sink);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /cut off by the token limit/);
    assert.equal(log.steps.includes("tool:frontmost_app"), false, "the truncated tool call never ran");
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("anthropic brain: each request is bounded by the wall budget, a hang is cancellable in flight, and a 5xx probe is retried", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.method === "GET") return { status: 200, json: MODEL_INFO };
    posts++;
    return "hang";
  });
  try {
    const { runner } = makeRunner();
    // 1.5 s of wall clock: the single hanging request must be timed out well inside the SDK's 10 min default.
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: server.url, maxRetries: 0, maxWallMs: 1500 });
    await brain.start();
    const started = Date.now();
    const r = await brain.handle(makeTask("slow"), makeSink().sink);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /did not answer within [12] seconds/);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
    assert.equal(posts, 1, "no retry when the budget cannot fit another attempt");

    // Cancel while a request is genuinely in flight.
    const abort = new AbortController();
    const pending = brain.handle(makeTask("slow again", abort.signal), makeSink().sink);
    await server.arrived(3);
    await new Promise((res) => setTimeout(res, 150));
    abort.abort();
    assert.equal((await pending).status, "cancelled");
    await brain.stop();
  } finally {
    await server.close();
  }

  // Probe: one 529 then a 200 → ready (the SDK retries 5xx, never 401).
  let gets = 0;
  const flaky = await fakeServer((req) => {
    if (req.method !== "GET") return { status: 404, json: {} };
    gets++;
    return gets === 1 ? { status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } } : { status: 200, json: MODEL_INFO };
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: flaky.url });
    const r = await brain.start();
    assert.equal(r.ready, true, r.detail);
    assert.equal(gets, 2);
    const once = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: flaky.url, probeRetries: 0 });
    gets = 0;
    assert.equal((await once.start()).ready, false, "probeRetries: 0 keeps the single-shot behaviour");
    assert.equal(gets, 1);
  } finally {
    await flaky.close();
  }
});
