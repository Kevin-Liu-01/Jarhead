import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleBrain, detectCapabilities, isLoopbackHost, isPrivateHost, normalizeBaseUrl, resolveCompatibleApiKey, stripReasoning, toChatTool, type ChatTransport } from "../compatible.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";
import { fakeServer, makeRunner, makeSink, makeTask } from "./fakes.ts";

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

const MODELS = { object: "list", data: [{ id: "llama3.1:latest", object: "model" }, { id: "qwen2.5", object: "model" }] };

function completion(message: unknown, finish_reason = "stop"): unknown {
  return { id: "chatcmpl_1", object: "chat.completion", model: "llama3.1", choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

test("compatible brain: base URLs normalise, capabilities follow the host, tools map to functions", () => {
  assert.equal(normalizeBaseUrl("http://localhost:11434"), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434");
  assert.equal(normalizeBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api");
  assert.equal(normalizeBaseUrl(" https://api.openai.com/v1 "), "https://api.openai.com");

  assert.deepEqual(detectCapabilities("https://api.openai.com"), { images: true });
  assert.deepEqual(detectCapabilities("https://openrouter.ai/api"), { images: true });
  assert.deepEqual(detectCapabilities("http://localhost:11434"), { images: false });
  assert.deepEqual(detectCapabilities("not a url"), { images: false });

  const tool = toChatTool(specByName("key")!);
  assert.equal(tool.type, "function");
  assert.equal(tool.function.name, "key");
  assert.deepEqual(tool.function.parameters.required, ["text"]);
  assert.equal(ALL_TOOL_SPECS.map(toChatTool).length, ALL_TOOL_SPECS.length);
});

test("compatible brain: probe hits /v1/models whether or not the base URL has /v1, and reports the model", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 404, json: { error: { message: `no route ${req.path}` } } }));
  try {
    const { runner } = makeRunner();
    for (const base of [server.url, `${server.url}/v1`, `${server.url}/v1/`]) {
      const brain = new OpenAICompatibleBrain({ runner, baseUrl: base, model: "llama3.1" });
      const r = await brain.start();
      assert.equal(r.ready, true, `${base}: ${r.detail}`);
      assert.match(r.detail, /llama3\.1, text-only/);
      assert.equal(server.seen.at(-1)?.path, "/v1/models");
      assert.equal(server.seen.at(-1)?.headers["authorization"], undefined, "no key → no Authorization header");
    }
    const keyed = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "qwen2.5", apiKey: "sk-or-test" });
    await keyed.start();
    assert.equal(server.seen.at(-1)?.headers["authorization"], "Bearer sk-or-test");

    const missing = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "gpt-5.6-terra" });
    const m = await missing.start();
    assert.equal(m.ready, false);
    assert.match(m.detail, /does not offer gpt-5\.6-terra; it lists llama3\.1:latest, qwen2\.5/);

    const noUrl = new OpenAICompatibleBrain({ runner, baseUrl: undefined, model: "x" });
    assert.match((await noUrl.start()).detail, /no server URL configured/);
    const noModel = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "" });
    assert.match((await noModel.start()).detail, /no model configured/);
  } finally {
    await server.close();
  }
});

test("compatible brain: 401 at start is not ready; unreachable server is not ready", async () => {
  const server = await fakeServer(() => ({ status: 401, json: { error: { message: "Incorrect API key provided", type: "invalid_request_error" } } }));
  try {
    const { runner } = makeRunner();
    const bad = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "gpt-5.6-terra", apiKey: "sk-bad" });
    const r = await bad.start();
    assert.equal(r.ready, false);
    assert.match(r.detail, /rejected the API key \(401\)/);
    const nokey = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "gpt-5.6-terra" });
    assert.match((await nokey.start()).detail, /requires an API key/);
  } finally {
    await server.close();
  }
  const { runner } = makeRunner();
  const dead = new OpenAICompatibleBrain({ runner, baseUrl: "http://127.0.0.1:9", model: "x", probeTimeoutMs: 2000 });
  const d = await dead.start();
  assert.equal(d.ready, false);
  assert.match(d.detail, /could not reach 127\.0\.0\.1:9|did not answer/);
});

test("compatible brain: one tool round-trip, tool_call_id echoed, final answer spoken", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    if (req.path === "/v1/chat/completions") {
      posts++;
      if (posts === 1) return { status: 200, json: completion({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "frontmost_app", arguments: "{}" } }] }, "tool_calls") };
      return { status: 200, json: completion({ role: "assistant", content: "Finder is in front." }) };
    }
    return { status: 404, json: {} };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: `${server.url}/v1`, model: "llama3.1" });
    assert.equal((await brain.start()).ready, true);
    const log = makeSink();
    const result = await brain.handle(makeTask("what app is in front"), log.sink);
    assert.equal(result.status, "done");
    assert.equal(result.summary, "Finder is in front.");

    const first = server.seen[1]!.body as { model: string; tool_choice: string; tools: Array<{ type: string; function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
    assert.equal(server.seen[1]!.path, "/v1/chat/completions");
    assert.equal(first.model, "llama3.1");
    assert.equal(first.tool_choice, "auto");
    assert.equal(first.tools.length, ALL_TOOL_SPECS.length);
    assert.equal(first.tools[0]?.type, "function");
    assert.deepEqual(first.messages.map((m) => m.role), ["system", "user"]);
    assert.match(String(first.messages[0]!.content), /brain of Jarhead/);
    assert.match(String(first.messages[1]!.content), /Kevin said: "what app is in front"/);

    const second = server.seen[2]!.body as { messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }> };
    assert.deepEqual(second.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(second.messages[2]!.tool_calls?.length, 1);
    assert.equal(second.messages[3]!.tool_call_id, "call_1");
    assert.match(String(second.messages[3]!.content), /Finder/);

    assert.deepEqual(log.thinking, ["Checking which app is in front."]);
    assert.ok(log.steps.includes("tool:frontmost_app"));

    posts = 0;
    await brain.handle(makeTask("and now?"), makeSink().sink);
    const third = server.seen[3]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(third.messages.map((m) => m.role), ["system", "user", "assistant", "user"], "the previous exchange is carried as text");
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("compatible brain: screenshots become an image_url user turn only when the server takes images", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    if (posts % 2 === 1) return { status: 200, json: completion({ role: "assistant", content: "", tool_calls: [{ id: "call_shot", type: "function", function: { name: "screenshot", arguments: {} } }] }, "tool_calls") };
    return { status: 200, json: completion({ role: "assistant", content: "Looks like the desktop." }) };
  });
  try {
    const { runner } = makeRunner();
    const textOnly = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await textOnly.start();
    assert.equal((await textOnly.handle(makeTask("look"), makeSink().sink)).status, "done");
    const t = server.seen[2]!.body as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
    assert.deepEqual(t.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.match(String(t.messages[3]!.content), /cannot receive images/);

    const withImages = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", capabilities: { images: true } });
    await withImages.start();
    assert.equal((await withImages.handle(makeTask("look"), makeSink().sink)).status, "done");
    const i = server.seen[5]!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.deepEqual(i.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
    const parts = i.messages[4]!.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.equal(parts[0]?.type, "text");
    assert.equal(parts[1]?.type, "image_url");
    assert.ok(parts[1]!.image_url!.url.startsWith("data:image/png;base64,"));
    assert.match(String(i.messages[3]!.content), /screenshot attached/);
  } finally {
    await server.close();
  }
});

test("compatible brain: cancel mid-loop, a 401 mid-loop, and a server error", async () => {
  let mode: "hang" | "unauthorized" | "boom" = "hang";
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    if (posts === 1) return { status: 200, json: completion({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "frontmost_app", arguments: "{}" } }] }, "tool_calls") };
    if (mode === "hang") return "hang";
    if (mode === "unauthorized") return { status: 401, json: { error: { message: "key expired" } } };
    return { status: 500, json: { error: { message: "model crashed" } } };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();

    const abort = new AbortController();
    const pending = brain.handle(makeTask("long task", abort.signal), makeSink().sink);
    await server.arrived(3);
    abort.abort();
    assert.equal((await pending).status, "cancelled");

    posts = 0;
    mode = "boom";
    const boom = await brain.handle(makeTask("again"), makeSink().sink);
    assert.equal(boom.status, "failed");
    assert.match(boom.error ?? "", /server error 500: model crashed/);

    posts = 0;
    mode = "unauthorized";
    const unauthorized = await brain.handle(makeTask("again"), makeSink().sink);
    assert.equal(unauthorized.status, "failed");
    assert.match(unauthorized.error ?? "", /rejected the API key \(401\)/);
    assert.equal((await brain.handle(makeTask("once more"), makeSink().sink)).status, "failed", "a rejected key marks the brain not ready");
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("compatible brain: the OpenAI key never leaves for a non-OpenAI host; only JARHEAD_BRAIN_API_KEY does", () => {
  const openai = "sk-openai-DUMMY";
  // Kevin's actual state: OPENAI_API_KEY set, no JARHEAD_BRAIN_API_KEY.
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "https://openrouter.ai/api/v1", explicitKey: undefined, openaiKey: openai }), { apiKey: undefined });
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "http://localhost:11434", explicitKey: undefined, openaiKey: openai }), { apiKey: undefined });
  // OpenAI itself gets the OpenAI key, explicit key first.
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "https://api.openai.com/v1", explicitKey: undefined, openaiKey: openai }), { apiKey: openai });
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "https://api.openai.com", explicitKey: "sk-proj-x", openaiKey: openai }), { apiKey: "sk-proj-x" });
  // An explicit key goes to any https host and to loopback over http.
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "https://openrouter.ai/api/v1", explicitKey: "sk-or-x", openaiKey: openai }), { apiKey: "sk-or-x" });
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "http://127.0.0.1:1234/v1", explicitKey: "lm-studio", openaiKey: openai }), { apiKey: "lm-studio" });
  // Plain http: a LAN host gets it with a warning, a public host never does.
  const lan = resolveCompatibleApiKey({ baseUrl: "http://192.168.1.20:8000", explicitKey: "vllm-token", openaiKey: openai });
  assert.equal(lan.apiKey, "vllm-token");
  assert.match(lan.warning ?? "", /plain http to 192\.168\.1\.20/);
  const pub = resolveCompatibleApiKey({ baseUrl: "http://example.com/v1", explicitKey: "sk-or-x", openaiKey: openai });
  assert.equal(pub.apiKey, undefined);
  assert.match(pub.warning ?? "", /refusing to send an API key over plain http to example\.com/);
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: undefined, explicitKey: "x", openaiKey: openai }), { apiKey: undefined });
  assert.deepEqual(resolveCompatibleApiKey({ baseUrl: "not a url", explicitKey: "x", openaiKey: openai }), { apiKey: undefined });

  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("10.0.0.5"), false);
  assert.equal(isPrivateHost("10.0.0.5"), true);
  assert.equal(isPrivateHost("172.20.3.4"), true);
  assert.equal(isPrivateHost("172.32.0.1"), false);
  assert.equal(isPrivateHost("mac-studio.local"), true);
  assert.equal(isPrivateHost("openrouter.ai"), false);
});

test("compatible brain: built the way the engine builds it with only OPENAI_API_KEY, a non-OpenAI server sees no Authorization header", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 404, json: {} }));
  try {
    const { runner } = makeRunner();
    // config.brainApiKey falls back to OPENAI_API_KEY; the engine only forwards it when JARHEAD_BRAIN_API_KEY was set.
    const explicitSet = false;
    const configBrainApiKey = "sk-openai-DUMMY-0000";
    const key = resolveCompatibleApiKey({ baseUrl: server.url, explicitKey: explicitSet ? configBrainApiKey : undefined, openaiKey: "sk-openai-DUMMY-0000" });
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, apiKey: key.apiKey, model: "llama3.1" });
    const r = await brain.start();
    assert.equal(r.ready, true, r.detail);
    assert.equal(server.seen.length, 1);
    assert.equal(server.seen[0]?.headers["authorization"], undefined);
    assert.equal(JSON.stringify(server.seen[0]?.headers).includes("DUMMY"), false);
    await brain.stop();
  } finally {
    await server.close();
  }
});

test("compatible brain: a transient probe failure is retried once; start() after stop() probes again", async () => {
  let models = 0;
  const server = await fakeServer((req) => {
    if (req.path !== "/v1/models") return { status: 404, json: {} };
    models++;
    return models === 1 ? { status: 503, json: { error: { message: "loading" } } } : { status: 200, json: MODELS };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", probeRetryDelayMs: 10 });
    const r = await brain.start();
    assert.equal(r.ready, true, r.detail);
    assert.equal(models, 2, "503 then 200");

    await brain.stop();
    assert.equal((await brain.handle(makeTask("x"), makeSink().sink)).status, "failed");
    const again = await brain.start();
    assert.equal(again.ready, true, again.detail);
    assert.equal(models, 3, "a stopped brain probes again instead of staying 'stopped'");

    // Auth failures are final: no retry.
    models = 0;
    const server401 = await fakeServer(() => ({ status: 401, json: { error: { message: "nope" } } }));
    try {
      const bad = new OpenAICompatibleBrain({ runner, baseUrl: server401.url, model: "llama3.1", apiKey: "k", probeRetryDelayMs: 10 });
      assert.equal((await bad.start()).ready, false);
      assert.equal(server401.seen.length, 1);
    } finally {
      await server401.close();
    }
  } finally {
    await server.close();
  }
});

test("compatible brain: 429 and 503 are retried with Retry-After inside the wall budget", async () => {
  let posts = 0;
  const server = await fakeServer((req, res) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    if (posts === 1) {
      res.setHeader("retry-after", "0");
      return { status: 429, json: { error: { message: "slow down" } } };
    }
    if (posts === 2) {
      res.setHeader("retry-after-ms", "15");
      return { status: 503, json: { error: { message: "busy" } } };
    }
    return { status: 200, json: completion({ role: "assistant", content: "Third time lucky." }) };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const r = await brain.handle(makeTask("hello"), makeSink().sink);
    assert.equal(r.status, "done", r.error);
    assert.equal(r.summary, "Third time lucky.");
    assert.equal(posts, 3);

    // Retries exhausted: the 429 is reported, not looped forever.
    posts = 0;
    const limited = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", requestRetries: 0 });
    await limited.start();
    const l = await limited.handle(makeTask("hello"), makeSink().sink);
    assert.equal(l.status, "failed");
    assert.match(l.error ?? "", /rate limiting/);
    assert.equal(posts, 1);

    // A Retry-After longer than the brain will wait fails immediately.
    posts = 0;
    const server2 = await fakeServer((req, res) => {
      if (req.path === "/v1/models") return { status: 200, json: MODELS };
      posts++;
      res.setHeader("retry-after", "120");
      return { status: 429, json: { error: { message: "slow down" } } };
    });
    try {
      const patient = new OpenAICompatibleBrain({ runner, baseUrl: server2.url, model: "llama3.1" });
      await patient.start();
      const started = Date.now();
      const pr = await patient.handle(makeTask("hello"), makeSink().sink);
      assert.equal(pr.status, "failed");
      assert.ok(Date.now() - started < 2000 * RUNNER_SLACK, `did not sleep for the 120 s Retry-After: under ${2000 * RUNNER_SLACK} ms (${Date.now() - started} ms)`);
      assert.equal(posts, 1);
    } finally {
      await server2.close();
    }
  } finally {
    await server.close();
  }
});

test("compatible brain: a request that truly hangs is cancelled by the task signal while in flight", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : "hang"));
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const abort = new AbortController();
    const pending = brain.handle(makeTask("long task", abort.signal), makeSink().sink);
    await server.arrived(2);
    // Let the request sit in flight for a moment: a fake that dropped the connection would have failed by now.
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    abort.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.ok(Date.now() - started < 1000 * RUNNER_SLACK, `cancelled at once: under ${1000 * RUNNER_SLACK} ms (${Date.now() - started} ms)`);

    // The per-request timeout bounds a hang without a cancel.
    const quick = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", requestTimeoutMs: 1000 });
    await quick.start();
    const t = await quick.handle(makeTask("long task"), makeSink().sink);
    assert.equal(t.status, "failed");
    assert.match(t.error ?? "", /did not answer within 1 seconds/);
  } finally {
    await server.close();
  }
});

// ---- the transport seam ---------------------------------------------------------------------

test("compatible brain: reasoning in message.reasoning goes to sink.thinking and not into the summary or history", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    return { status: 200, json: completion({ role: "assistant", content: "Safari is open.", reasoning: "The user wants Safari; it is already the front app so I just confirm." }) };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const log = makeSink();
    const r = await brain.handle(makeTask("open safari"), log.sink);
    assert.equal(r.status, "done");
    assert.equal(r.summary, "Safari is open.");
    assert.equal(log.thinking.length, 1);
    assert.match(log.thinking[0]!, /^The user wants Safari/);
    await brain.handle(makeTask("and now?"), makeSink().sink);
    const second = server.seen[posts]!.body as { messages: Array<{ role: string; content: unknown }> };
    const carried = second.messages.filter((m) => m.role === "assistant").map((m) => String(m.content));
    assert.deepEqual(carried, ["Safari is open."], "history carries the answer, never the reasoning");
    assert.equal(JSON.stringify(second.messages).includes("front app so I just confirm"), false);
  } finally {
    await server.close();
  }
});

test("compatible brain: <think> in content is stripped (terminated, unterminated, harmony channel)", async () => {
  assert.deepEqual(stripReasoning("<think>\nhmm\n</think>\nFinder is in front."), { content: "Finder is in front.", reasoning: "hmm" });
  assert.deepEqual(stripReasoning("<thinking>plan</thinking> done."), { content: "done.", reasoning: "plan" });
  assert.deepEqual(stripReasoning("<think>I should call the tool with {\"text\":\"hi\"}"), { content: '{"text":"hi"}', reasoning: "I should call the tool with" });
  assert.deepEqual(stripReasoning("<think>only thoughts, no answer"), { content: "", reasoning: "only thoughts, no answer" });
  const harmony = stripReasoning("<|channel|>analysis<|message|>User asks for the time.<|end|><|start|>assistant<|channel|>final<|message|>It is noon.");
  assert.deepEqual(harmony, { content: "It is noon.", reasoning: "User asks for the time." });
  assert.deepEqual(stripReasoning("plain answer"), { content: "plain answer" });

  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    return { status: 200, json: completion({ role: "assistant", content: "<think>Where is the front app? I know it.</think>Finder is in front." }) };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const log = makeSink();
    const r = await brain.handle(makeTask("what is in front"), log.sink);
    assert.equal(r.summary, "Finder is in front.");
    assert.deepEqual(log.thinking, ["Where is the front app? I know it."]);
    assert.equal(posts, 1);
  } finally {
    await server.close();
  }
});

test("compatible brain: unparseable arguments → error tool result, the runner is not called", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    if (posts === 1) return { status: 200, json: completion({ role: "assistant", content: null, tool_calls: [{ id: "call_bad", type: "function", function: { name: "type", arguments: "{text: hello" } }] }, "tool_calls") };
    return { status: 200, json: completion({ role: "assistant", content: "I could not type." }) };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const log = makeSink();
    const r = await brain.handle(makeTask("type hello"), log.sink);
    assert.equal(r.status, "done");
    assert.equal(log.steps.some((s) => s.startsWith("tool:")), false, "no tool ran");
    const second = server.seen[2]!.body as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
    const toolMsg = second.messages.find((m) => m.role === "tool")!;
    assert.equal(toolMsg.tool_call_id, "call_bad");
    assert.equal(toolMsg.content, "arguments were not valid JSON: {text: hello");
  } finally {
    await server.close();
  }
});

test("compatible brain: tools option sends a subset and the count follows", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 200, json: completion({ role: "assistant", content: "ok" }) }));
  try {
    const { runner } = makeRunner();
    const subset = [specByName("frontmost_app")!, specByName("screenshot")!];
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", tools: subset });
    await brain.start();
    await brain.handle(makeTask("x"), makeSink().sink);
    const body = server.seen[1]!.body as { tools: Array<{ function: { name: string } }> };
    assert.deepEqual(body.tools.map((t) => t.function.name), ["frontmost_app", "screenshot"]);
    const full = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await full.start();
    await full.handle(makeTask("x"), makeSink().sink);
    assert.equal((server.seen[3]!.body as { tools: unknown[] }).tools.length, ALL_TOOL_SPECS.length, "the default is still the whole table");
  } finally {
    await server.close();
  }
});

test("compatible brain: imageHistory newest keeps one image turn", async () => {
  let posts = 0;
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    posts++;
    if (posts <= 2) return { status: 200, json: completion({ role: "assistant", content: "", tool_calls: [{ id: `shot_${posts}`, type: "function", function: { name: "screenshot", arguments: "{}" } }] }, "tool_calls") };
    return { status: 200, json: completion({ role: "assistant", content: "Seen." }) };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", capabilities: { images: true }, imageHistory: "newest" });
    await brain.start();
    assert.equal((await brain.handle(makeTask("look twice"), makeSink().sink)).status, "done");
    const third = server.seen[3]!.body as { messages: Array<{ role: string; content: unknown }> };
    const imageTurns = third.messages.filter((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((p) => p.type === "image_url"));
    assert.equal(imageTurns.length, 1, "only the newest screenshot keeps its pixels");
    assert.ok(third.messages.some((m) => m.role === "user" && m.content === "[screenshot from screenshot, superseded]"));

    posts = 0;
    const all = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", capabilities: { images: true } });
    await all.start();
    await all.handle(makeTask("look twice"), makeSink().sink);
    const last = server.seen.at(-1)!.body as { messages: Array<{ role: string; content: unknown }> };
    assert.equal(last.messages.filter((m) => Array.isArray(m.content)).length, 2, "the default keeps every screenshot");
  } finally {
    await server.close();
  }
});

test("compatible brain: label in the ready detail", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 404, json: {} }));
  try {
    const { runner } = makeRunner();
    const plain = await new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" }).start();
    assert.match(plain.detail, /^OpenAI-compatible 127\.0\.0\.1:\d+ \(llama3\.1, text-only\)$/);
    const local = await new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", label: "Local" }).start();
    assert.match(local.detail, /^Local 127\.0\.0\.1:\d+ \(llama3\.1, text-only\)$/);
  } finally {
    await server.close();
  }
});

test("compatible brain: a transport that returns finish error with unready flips the brain not ready", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 404, json: {} }));
  try {
    const { runner } = makeRunner();
    let calls = 0;
    const transport: ChatTransport = {
      complete: async (req, _signal, _deadline, sink) => {
        calls++;
        assert.equal(req.model, "llama3.1");
        sink.thinking("loading");
        return { content: "", toolCalls: [], finish: "error", error: "llama3.1 cannot call tools; pick a model with the tools badge", unready: "llama3.1 cannot call tools; pick a model with the tools badge" };
      },
    };
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", transport });
    assert.equal((await brain.start()).ready, true);
    const r = await brain.handle(makeTask("x"), makeSink().sink);
    assert.equal(r.status, "failed");
    assert.match(r.error ?? "", /cannot call tools/);
    assert.match(brain.detail, /cannot call tools/);
    const again = await brain.handle(makeTask("y"), makeSink().sink);
    assert.equal(again.status, "failed");
    assert.equal(calls, 1, "a brain flipped not-ready does not ask the transport again");
    assert.equal(server.seen.filter((s) => s.path === "/v1/chat/completions").length, 0, "the injected transport replaced the fetch");
  } finally {
    await server.close();
  }
});

test("compatible brain: usage becomes one note step per turn", async () => {
  const server = await fakeServer((req) => {
    if (req.path === "/v1/models") return { status: 200, json: MODELS };
    return { status: 200, json: { ...(completion({ role: "assistant", content: "ok" }) as object), usage: { prompt_tokens: 12_400, completion_tokens: 310 } } };
  });
  try {
    const { runner } = makeRunner();
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const log = makeSink();
    await brain.handle(makeTask("x"), log.sink);
    assert.equal(log.steps.filter((s) => s.startsWith("note:12.4k prompt · 310 out · ")).length, 1);
  } finally {
    await server.close();
  }
});

test("compatible brain: the tool table goes out in the user's name — a Sam brain's request carries no literal Kevin, the same names in the same order, a subset too; the default carries the table as written", async () => {
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: MODELS } : { status: 200, json: completion({ role: "assistant", content: "ok" }) }));
  try {
    const { runner } = makeRunner();
    const sam = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", userName: "Sam" });
    await sam.start();
    await sam.handle(makeTask("open the budget"), makeSink().sink);
    const body = server.seen[1]!.body as { tools: Array<{ function: { name: string; description: string } }> };
    assert.deepEqual(body.tools.map((t) => t.function.name), ALL_TOOL_SPECS.map((t) => t.name));
    assert.doesNotMatch(JSON.stringify(body), /Kevin/, "nothing in the request says Kevin: not the orders, not the table, not the prompt");
    assert.match(body.tools.find((t) => t.function.name === "run_shell")!.function.description, /^Run a shell command on Sam's Mac/);
    const subset = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1", userName: "Sam", tools: [specByName("thread_start")!] });
    await subset.start();
    await subset.handle(makeTask("x"), makeSink().sink);
    const sub = server.seen[3]!.body as { tools: Array<{ function: { name: string; description: string } }> };
    assert.deepEqual(sub.tools.map((t) => t.function.name), ["thread_start"]);
    assert.match(sub.tools[0]!.function.description, /named for Sam to hear/);
    const plain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await plain.start();
    await plain.handle(makeTask("x"), makeSink().sink);
    const def = server.seen[5]!.body as { tools: Array<{ function: { description: string } }> };
    assert.match(def.tools.find((t) => /^Run a shell command/.test(t.function.description))!.function.description, /on Kevin's Mac/, "the default is the table as written");
  } finally {
    await server.close();
  }
});
