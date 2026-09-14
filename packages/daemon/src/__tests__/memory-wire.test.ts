import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@jarhead/hands";
import { DaemonServer, MEMORY_LIST_DEFAULT, MEMORY_LIST_MAX, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";

/**
 * The long-horizon and memory frames over the socket: `memory.list` / `memory.search`
 * answer under the request id with `memory.items` and clamp their limit; `ledger.chain`
 * answers a whole conversation as `ledger.rows` and says when it was cut; an
 * `agent.open` / `agent.close` viewer is prefixed with the client's id, and a client's
 * socket closing drops its viewers (no leaked tails).
 */

type Msg = { type: string; id?: string; items?: unknown[]; rows?: unknown[]; truncated?: boolean };

/** The engine's memory reads, chain read and viewer drop — every call recorded. */
class WireEngine extends EventEmitter implements EngineLike {
  commands: unknown[] = [];
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
  async command(cmd: unknown): Promise<void> {
    this.commands.push(cmd);
  }
  feedMic(): void {}
  reportInputLevel(): void {}
  setPermission(): void {}
  setPermissions(): void {}
  registerOwnPid(): void {}
  ear(): void {}
  problem(): void {}
  lists: { state: string | undefined; limit: number | undefined }[] = [];
  searches: { query: string; limit: number | undefined }[] = [];
  chains: string[] = [];
  dropped: string[] = [];
  ledger: EngineLike["ledger"] = {
    read: () => [],
    days: () => [],
    sessions: () => [],
    readSession: () => [],
    search: () => [],
    readChain: (rootId: string) => {
      this.chains.push(rootId);
      return { rows: [{ at: 1, type: "session.started", sessionId: rootId, voice: "cedar" }, { at: 2, type: "heard" }], truncated: rootId === "big" };
    },
  };
  memory: EngineLike["memory"] = {
    list: (state, limit) => {
      this.lists.push({ state, limit });
      return Array.from({ length: Math.min(limit ?? 1, 300) }, (_v, i) => ({ id: `m_${i}`, text: `item ${i} (${state ?? "live"})` }));
    },
    search: async (query, limit) => {
      this.searches.push({ query, limit });
      return [{ id: "m_1", text: `hit for ${query}` }];
    },
  };
  dropViewers(clientId: string): void {
    this.dropped.push(clientId);
  }
}

async function withServer(engine: EngineLike, run: (client: DaemonClient, messages: Msg[], server: DaemonServer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const server = new DaemonServer(engine, join(dir, "d.sock"));
  await server.listen();
  const client = new DaemonClient(join(dir, "d.sock"));
  const messages: Msg[] = [];
  client.on("message", (m) => messages.push(m as Msg));
  try {
    await client.connect({ pid: 1 });
    await run(client, messages, server);
  } finally {
    client.close();
    await server.close();
  }
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("memory.list / memory.search answer under the request id as memory.items; the limit defaults to 50, clamps to 200 and ignores a bad one; the state reaches the engine", async () => {
  const engine = new WireEngine();
  await withServer(engine, async (client, messages) => {
    client.sendJson({ type: "memory.list", id: "l1", state: "forgotten", limit: 5 });
    client.sendJson({ type: "memory.list", id: "l2" });
    client.sendJson({ type: "memory.list", id: "l3", limit: 900 });
    client.sendJson({ type: "memory.list", id: "l4", limit: -2 });
    client.sendJson({ type: "memory.search", id: "s1", query: "dentist", limit: 3 });
    await until(() => messages.filter((m) => m.type === "memory.items").length === 5, "five memory.items answers");
    const items = messages.filter((m) => m.type === "memory.items");
    assert.deepEqual(items.map((m) => m.id), ["l1", "l2", "l3", "l4", "s1"]);
    assert.deepEqual(engine.lists, [
      { state: "forgotten", limit: 5 },
      { state: undefined, limit: MEMORY_LIST_DEFAULT },
      { state: undefined, limit: MEMORY_LIST_MAX },
      { state: undefined, limit: MEMORY_LIST_DEFAULT },
    ]);
    assert.equal(items[0]!.items!.length, 5);
    assert.equal(items[2]!.items!.length, MEMORY_LIST_MAX, "never more than the ceiling on the wire");
    assert.deepEqual(items[0]!.items![0], { id: "m_0", text: "item 0 (forgotten)" });
    assert.deepEqual(engine.searches, [{ query: "dentist", limit: 3 }]);
    assert.deepEqual(items[4]!.items, [{ id: "m_1", text: "hit for dentist" }]);
    assert.ok(!messages.some((m) => m.type === "error"));
  });
});

test("ledger.chain answers a whole conversation as ledger.rows under the request id, with truncated only when the read was cut", async () => {
  const engine = new WireEngine();
  await withServer(engine, async (client, messages) => {
    client.sendJson({ type: "ledger.chain", id: "c1", rootId: "sess_1" });
    client.sendJson({ type: "ledger.chain", id: "c2", rootId: "big" });
    await until(() => messages.filter((m) => m.type === "ledger.rows").length === 2, "two ledger.rows answers");
    const rows = messages.filter((m) => m.type === "ledger.rows");
    assert.deepEqual(engine.chains, ["sess_1", "big"]);
    assert.equal(rows[0]!.id, "c1");
    assert.equal(rows[0]!.rows!.length, 2);
    assert.equal(rows[0]!.truncated, undefined, "not cut: the field is absent");
    assert.equal(rows[1]!.truncated, true);
  });
});

test("agent.open / agent.close viewers are prefixed with the client's id (a pane token, or 'pane' when the surface sent none); the socket closing drops that client's viewers", async () => {
  const engine = new WireEngine();
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const server = new DaemonServer(engine, join(dir, "d.sock"));
  await server.listen();
  const a = new DaemonClient(join(dir, "d.sock"));
  const b = new DaemonClient(join(dir, "d.sock"));
  try {
    await a.connect({ pid: 1 });
    await b.connect({ pid: 2 });
    a.sendJson({ type: "command", command: { type: "agent.open", agentId: "sessions:codex:x", viewer: "p1" } });
    a.sendJson({ type: "command", command: { type: "agent.open", agentId: "sessions:codex:x" } });
    b.sendJson({ type: "command", command: { type: "agent.close", agentId: "sessions:codex:x", viewer: "p2" } });
    b.sendJson({ type: "command", command: { type: "go" } });
    await until(() => engine.commands.length === 4, "four commands");
    const viewers = engine.commands.map((c) => (c as { viewer?: string }).viewer);
    assert.equal(viewers[0], "c1/p1");
    assert.equal(viewers[1], "c1/pane", "no token from the surface: still this client's");
    assert.equal(viewers[2], "c2/p2");
    assert.equal(viewers[3], undefined, "other commands are untouched");
    assert.deepEqual((engine.commands[3] as { type: string }), { type: "go" });
    a.close();
    await until(() => engine.dropped.length === 1, "the client's viewers dropped");
    assert.deepEqual(engine.dropped, ["c1"]);
    b.close();
    await until(() => engine.dropped.length === 2, "the second client's too");
    assert.deepEqual(engine.dropped, ["c1", "c2"]);
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});
