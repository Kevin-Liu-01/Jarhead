/**
 * W3-4 review fix, F-AUTO-PROBE under a walk: under `auto` the walk stops waiting on a start at its patience and lets
 * it go on, so a slower start that proves itself takes over at the next quiet moment (W2-1). The Anthropic API brain
 * capped its own key check at 5 s (W3-4, so an explicit pick's Go never waits 16 s), which ended the start first: a
 * valid key whose check answered at 6.5 s got "did not answer the key check within 5 s" and never took over. The
 * engine now passes ANTHROPIC_WALK_PROBE_MS (16 s) when its selection walks; an explicit pick keeps the 5 s cap
 * (w3-4-probe-patience).
 *
 * The real engine selection and the real AnthropicBrain against a loopback server (ANTHROPIC_BASE_URL); nothing
 * leaves the Mac.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tempDir, testConfig, until, world } from "./world.ts";

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

test(
  "F-AUTO-PROBE under auto: a valid Anthropic key whose check answers after 5 s takes over from Responses once it proves itself",
  async () => {
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(req.method === "GET" ? 200 : 404, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "claude-opus-5", type: "model", display_name: "Claude Opus 5", created_at: "2026-04-01T00:00:00Z" }));
        }, 6500);
      });
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const saved = process.env["ANTHROPIC_BASE_URL"];
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = tempDir("jh-w34-walk-");
    // Nothing else is configured, so the walk is anthropic-api, then Responses; a short patience keeps the test quick.
    const w = world({ config: testConfig(dir, { openaiApiKey: "sk-test-not-used", anthropicApiKey: "sk-ant-test" }), brainPatienceMs: 500 }, { select: true, dir });
    try {
      const t0 = Date.now();
      await w.engine.start();
      await w.engine.ready();
      assert.equal(w.engine.brainInfo.kind, "openai-responses", "the walk moved on at its patience");
      const took = await until(() => w.engine.brainInfo.kind === "anthropic-api", 12_000 * RUNNER_SLACK);
      console.log(`[measure] auto, Anthropic key check answering at 6.5 s: took over after ${Date.now() - t0} ms`);
      assert.ok(took, JSON.stringify(w.engine.typedProblems().map((p) => p.text)));
      assert.ok(!w.engine.typedProblems().some((p) => /did not answer the key check/.test(p.text)), "no 5 s row");
    } finally {
      await w.engine.stop();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (saved === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = saved;
    }
  },
);
