/**
 * W3-4, the F-AUTO-PROBE cap (carried from W2-1): no Go waits on the Anthropic API brain's key check past the walk's
 * patience. The walk bounds every start it moves on from (BRAIN_PATIENCE_MS), but an explicit choice has no next
 * backend, so the engine waits out its start; before W3-4 the API brain's own check took up to 8 s x 2 attempts. Now it
 * is bounded by the same patience and says so: the row names the wait, the Go lands on the Live session's own
 * Responses delegation, and Retry asks again.
 *
 * The real AnthropicBrain against a loopback server that never answers; nothing leaves the Mac.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { AnthropicBrain, type Brain } from "@jarhead/brain";
import { Engine } from "../engine.ts";
import { until, world, type World } from "./world.ts";

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

/** An HTTP server on loopback that reads every request and answers none. */
async function silent(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(() => undefined);
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

test("F-AUTO-PROBE cap (audit repro): an explicit Anthropic API brain whose key check never answers holds the Go no longer than the walk's patience, and the row says why", async () => {
  const api = await silent();
  // The first selection (auto) gets a ready stand-in, so the engine is up at once; Kevin's explicit pick gets the real brain.
  const made: string[] = [];
  let w!: World;
  const ready: Brain = { kind: "anthropic-api", start: async () => ({ ready: true, detail: "stand-in" }), handle: async () => ({ status: "done" }), cancel: async () => undefined, stop: async () => undefined };
  w = world({ brainOf: { "anthropic-api": () => (made.push("brain"), made.length === 1 ? ready : new AnthropicBrain({ runner: w.engine.runner, apiKey: "sk-ant-test", baseUrl: api.url })) } }, { select: true });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(engine.snapshot().setup.brainResolved, "anthropic-api");
    const t0 = Date.now();
    engine.updateSettings({ brain: "anthropic-api" });
    const row = /^Anthropic API brain unavailable \(the Anthropic API did not answer the key check within 5 s\); using the OpenAI backend instead$/;
    const landed = await until(() => engine.typedProblems().some((p) => p.kind === "brain.unavailable" && row.test(p.text)), Engine.BRAIN_PATIENCE_MS + 4000 * RUNNER_SLACK);
    const ms = Date.now() - t0;
    console.log(`[measure] explicit Anthropic API, key check never answered: the Go landed on Responses after ${ms} ms (patience ${Engine.BRAIN_PATIENCE_MS} ms)`);
    assert.ok(landed, JSON.stringify(engine.typedProblems()));
    assert.equal(made.length, 2);
    assert.equal(engine.brainInfo.kind, "openai-responses");
    assert.ok(ms < Engine.BRAIN_PATIENCE_MS + 1500 * RUNNER_SLACK, `${ms} ms past a ${Engine.BRAIN_PATIENCE_MS} ms patience`);
  } finally {
    await engine.stop();
    await api.close();
  }
});
