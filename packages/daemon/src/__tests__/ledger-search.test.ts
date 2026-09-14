import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@jarhead/hands";
import { DaemonServer, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";

/**
 * `ledger.search` over the socket: the query and the limit reach the ledger, and the hits
 * come back under the request's id.
 */

class SearchEngine extends EventEmitter implements EngineLike {
  searches: { query: string; limit: number | undefined }[] = [];
  ledger: EngineLike["ledger"] = {
    read: () => [],
    days: () => [],
    sessions: () => [],
    readSession: () => [],
    search: (query: string, limit?: number) => {
      this.searches.push({ query, limit });
      return [{ sessionId: "s1", chainId: "s1", at: 1, kind: "heard", text: `hit for ${query}` }];
    },
    readChain: () => ({ rows: [], truncated: false }),
  };
  memory: EngineLike["memory"] = { list: () => [], search: async () => [] };
  config = { stateDir: "/tmp/jh-test" };
  runner: { attached?: boolean; run(name: string, input: unknown): Promise<{ result: ToolResult }> } = {
    run: async () => ({ result: { kind: "text", text: "" } }),
  };
  runnerFor(): undefined {
    return undefined;
  }
  snapshot(): unknown {
    return { phase: "asleep" };
  }
  async command(): Promise<void> {}
  feedMic(): void {}
  reportInputLevel(): void {}
  setPermission(): void {}
  setPermissions(): void {}
  registerOwnPid(): void {}
  ear(): void {}
  problem(): void {}
  dropViewers(): void {}
}

async function withServer(engine: EngineLike, run: (client: DaemonClient, messages: { type: string; id?: string; hits?: unknown[] }[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const server = new DaemonServer(engine, join(dir, "d.sock"));
  await server.listen();
  const client = new DaemonClient(join(dir, "d.sock"));
  const messages: { type: string; id?: string; hits?: unknown[] }[] = [];
  client.on("message", (m) => messages.push(m as { type: string }));
  try {
    await client.connect({ pid: 1 });
    await run(client, messages);
  } finally {
    client.close();
    await server.close();
  }
}

/** Wait until the socket delivered what the test expects — a fixed pause is too short under a loaded full run. */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("ledger.search: query and limit reach the ledger; hits answer under the request id; a bad limit is left to the default", async () => {
  const engine = new SearchEngine();
  await withServer(engine, async (client, messages) => {
    client.sendJson({ type: "ledger.search", id: "q1", query: "auth branch", limit: 5 });
    client.sendJson({ type: "ledger.search", id: "q2", query: "plan" });
    client.sendJson({ type: "ledger.search", id: "q3", query: "x", limit: -3 });
    await until(() => messages.filter((m) => m.type === "ledger.hits").length === 3, "three ledger.hits answers");
    const hits = messages.filter((m) => m.type === "ledger.hits");
    assert.deepEqual(hits.map((m) => m.id), ["q1", "q2", "q3"]);
    assert.deepEqual(hits[0]!.hits, [{ sessionId: "s1", chainId: "s1", at: 1, kind: "heard", text: "hit for auth branch" }]);
    assert.deepEqual(engine.searches, [
      { query: "auth branch", limit: 5 },
      { query: "plan", limit: undefined },
      { query: "x", limit: undefined },
    ]);
  });
});
