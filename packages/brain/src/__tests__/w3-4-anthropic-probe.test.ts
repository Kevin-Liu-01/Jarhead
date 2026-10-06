/**
 * W3-4, the F-AUTO-PROBE cap (carried from W2-1): the Anthropic API brain's key check is bounded by the engine's
 * patience for any one start (Engine.BRAIN_PATIENCE_MS, 5 s), attempts and backoff included. A check that runs out
 * says so in the brain's detail, so the engine's row names the wait and Retry asks again; it never holds a Go.
 * Before: an 8 s timeout per attempt and one retry, about 16 s when the API brain was the only client brain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_PROBE_MS, ANTHROPIC_WALK_PROBE_MS, AnthropicBrain } from "../anthropic.ts";
import { fakeServer, makeRunner } from "./fakes.ts";

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

const MODEL_INFO = { id: "claude-opus-5", type: "model", display_name: "Claude Opus 5", created_at: "2026-04-01T00:00:00Z" };

test("F-AUTO-PROBE cap (audit repro): a key check that never answers holds start() no longer than the engine's patience, and the detail says why", async () => {
  assert.equal(ANTHROPIC_PROBE_MS, 5000, "Engine.BRAIN_PATIENCE_MS; engine w3-4-probe-patience.test.ts holds the two together");
  const hang = await fakeServer(() => "hang");
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: hang.url });
    const t0 = Date.now();
    const r = await brain.start();
    const ms = Date.now() - t0;
    console.log(`[measure] Anthropic API key check against a server that never answers: start() returned after ${ms} ms`);
    assert.equal(r.ready, false);
    assert.equal(r.detail, "the Anthropic API did not answer the key check within 5 s");
    assert.ok(ms >= ANTHROPIC_PROBE_MS - 50, `${ms} ms: it waits the whole patience`);
    assert.ok(ms < ANTHROPIC_PROBE_MS + 1000 * RUNNER_SLACK, `${ms} ms: no longer`);
    assert.deepEqual(await brain.start(), r, "a second start() answers the same, with no second wait");
  } finally {
    await hang.close();
  }
});

test("F-AUTO-PROBE cap: an overloaded API is retried inside the budget, never past it; a 529 then a 200 inside it is ready", async () => {
  let gets = 0;
  const busy = await fakeServer((req) => {
    if (req.method !== "GET") return { status: 404, json: {} };
    gets++;
    return { status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
  });
  try {
    const { runner } = makeRunner();
    const brain = new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: busy.url, probeTimeoutMs: 300, probeRetries: 5 });
    const t0 = Date.now();
    const r = await brain.start();
    const ms = Date.now() - t0;
    assert.equal(r.ready, false);
    assert.ok(ms < 300 + 500 * RUNNER_SLACK, `${ms} ms past a 300 ms budget with five retries allowed`);
    assert.ok(gets >= 1);
  } finally {
    await busy.close();
  }

  let calls = 0;
  const flaky = await fakeServer((req) => {
    if (req.method !== "GET") return { status: 404, json: {} };
    calls++;
    return calls === 1 ? { status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } } : { status: 200, json: MODEL_INFO };
  });
  try {
    const { runner } = makeRunner();
    const r = await new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: flaky.url }).start();
    assert.equal(r.ready, true, r.detail);
    assert.equal(calls, 2);
  } finally {
    await flaky.close();
  }
});

/**
 * W3-4 review fix: under `auto` the walk stops waiting at its own patience (5 s) and lets a slow start go on, so a
 * slow but valid key can take over later. A 5 s cap inside the brain ended that start first. The walk's budget is
 * its own constant, and `probeTimeoutMs` is the whole check: a check that answers inside it is ready, one that answers
 * after it is not. The engine passes the walk's budget once the W3-1 / W3-4 integration edit lands (TRIAGE).
 */
test("F-AUTO-PROBE under a walk: ANTHROPIC_WALK_PROBE_MS outlasts the walk's patience, and probeTimeoutMs decides whether a slow check is ready", async () => {
  assert.equal(ANTHROPIC_WALK_PROBE_MS, 16_000, "the old 8 s x 2 attempts");
  assert.ok(ANTHROPIC_WALK_PROBE_MS > ANTHROPIC_PROBE_MS, "a walk's start outlives the walk's patience, so it can take over");
  const slow = await fakeServer((req, res) => {
    if (req.method !== "GET") return { status: 404, json: {} };
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(MODEL_INFO));
    }, 600);
    return "hang";
  });
  try {
    const { runner } = makeRunner();
    const short = await new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: slow.url, probeTimeoutMs: 300 }).start();
    assert.equal(short.ready, false);
    assert.equal(short.detail, "the Anthropic API did not answer the key check within 0.3 s");
    const long = await new AnthropicBrain({ runner, apiKey: "sk-ant-test", baseUrl: slow.url, probeTimeoutMs: 2000 }).start();
    assert.equal(long.ready, true, long.detail);
    assert.match(long.detail, /Claude Opus 5/);
  } finally {
    await slow.close();
  }
});
