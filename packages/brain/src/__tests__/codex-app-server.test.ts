import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CodexAppServer, appServerArgs } from "../codex-app-server.ts";

/**
 * The warm transport's JSON-RPC client against an in-process stand-in: a stop
 * that arrives while turn/start is still unanswered (a thread's first turn takes
 * ~2 s while the MCP servers start) must still interrupt the server-side turn
 * once its id is known — otherwise the turn runs on after Kevin's stop and its
 * tool calls reach the daemon with no delegation attached. And the boot budget
 * is the boot budget: thread/start gets what is left of startTimeoutMs, not a
 * hard-coded minute.
 */

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  requests: { id: number | undefined; method: string; params: Record<string, unknown> }[] = [];
  turnStartDelayMs = 300;
  threadStartDelayMs = 0;
  /** Whether turn/interrupt is followed by turn/completed{interrupted} (a server that never says so is given up locally). */
  completesOnInterrupt = true;
  constructor() {
    super();
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        if (!msg.method) continue;
        this.requests.push({ id: msg.id, method: msg.method, params: msg.params ?? {} });
        const reply = (result: unknown): boolean => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        const notif = (method: string, params: unknown): boolean => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
        if (msg.method === "initialize") reply({ userAgent: "fake" });
        else if (msg.method === "thread/start") setTimeout(() => reply({ thread: { id: "thr_1" }, model: "fake", reasoningEffort: null }), this.threadStartDelayMs);
        else if (msg.method === "turn/start") {
          // The first turn on a thread starts the MCP servers before the reply lands.
          setTimeout(() => {
            reply({ turn: { id: "turn_1", status: "inProgress" } });
            notif("turn/started", { threadId: "thr_1", turnId: "turn_1", turn: { id: "turn_1", status: "inProgress" } });
            setTimeout(() => notif("item/started", { threadId: "thr_1", turnId: "turn_1", item: { type: "mcpToolCall", server: "jarhead", tool: "left_click", status: "inProgress" } }), 50);
          }, this.turnStartDelayMs);
        } else if (msg.method === "turn/interrupt") {
          reply({});
          if (this.completesOnInterrupt) notif("turn/completed", { threadId: "thr_1", turnId: "turn_1", turn: { id: "turn_1", status: "interrupted", error: null } });
        }
      }
    });
    setImmediate(() => this.emit("spawn"));
  }
  kill(): boolean {
    this.exitCode = 0;
    setImmediate(() => this.emit("close", 0, null));
    return true;
  }
}

function server(child: FakeChild, extra: Partial<ConstructorParameters<typeof CodexAppServer>[0]> = {}): CodexAppServer {
  return new CodexAppServer({ bin: "codex", cwd: "/tmp", env: {}, codexHome: "/tmp/no-codex-home", node: "node", tsxCli: "tsx", bridgePath: "bridge", socketPath: "/tmp/x.sock", developerInstructions: "x", disableUserServers: false, spawnImpl: (() => child as unknown as ChildProcess) as never, killGraceMs: 10, ...extra });
}

test("app-server: interrupt() before turn/start has answered still interrupts the server-side turn once its id is known, and the turn resolves on the server's word", async () => {
  const child = new FakeChild();
  const s = server(child);
  await s.start();
  const started: string[] = [];
  const turn = s.turn([{ type: "text", text: "click save", text_elements: [] }], { onItemStarted: (i) => started.push(`${i.type}:${i.tool}`) });
  await new Promise((r) => setTimeout(r, 30)); // Kevin presses stop while turn/start is in flight
  const t0 = Date.now();
  await s.interrupt();
  assert.ok(Date.now() - t0 < 50, "interrupt() returns at once; it does not wait for turn/start");
  assert.ok(!child.requests.some((r) => r.method === "turn/interrupt"), "nothing to interrupt yet: no turn id");
  const result = await turn;
  assert.equal(result.status, "interrupted");
  assert.equal(result.turnId, "turn_1", "resolved by the server's turn/completed, with the real id");
  const methods = child.requests.map((r) => r.method);
  assert.deepEqual(methods, ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"], "turn/interrupt went out the moment turn/start answered");
  assert.equal((child.requests[4]!.params as { turnId: string }).turnId, "turn_1");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(started, [], "the interrupted turn's items never reach the handlers");
  // The thread is free for the next turn.
  child.turnStartDelayMs = 5;
  child.requests.length = 0;
  const next = s.turn([{ type: "text", text: "again", text_elements: [] }], {});
  await new Promise((r) => setTimeout(r, 40));
  await s.interrupt();
  assert.equal((await next).status, "interrupted");
  await s.stop();
});

test("app-server: a server that never completes an interrupted turn is given up locally after the grace period; a second interrupt() is a no-op", async () => {
  const child = new FakeChild();
  child.completesOnInterrupt = false;
  child.turnStartDelayMs = 10;
  const s = server(child, { interruptGraceMs: 120 });
  await s.start();
  const turn = s.turn([{ type: "text", text: "x", text_elements: [] }], {});
  await new Promise((r) => setTimeout(r, 40));
  const t0 = Date.now();
  await s.interrupt();
  await s.interrupt();
  const result = await turn;
  const took = Date.now() - t0;
  assert.equal(result.status, "interrupted");
  assert.ok(took >= 100 && took < 1000, `given up after the grace period (${took} ms)`);
  assert.equal(child.requests.filter((r) => r.method === "turn/interrupt").length, 1, "one turn/interrupt, not one per stop");
  await s.stop();
});

test("app-server: the boot budget bounds thread/start (not a hard-coded minute), and the argv switches the plugin runtime and the notify hook off", async () => {
  const child = new FakeChild();
  child.threadStartDelayMs = 400;
  const s = server(child, { startTimeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(s.start(), /codex app-server did not start within 0s/);
  assert.ok(Date.now() - t0 < 1000);
  const args = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", developerInstructions: "x", disableUserServers: false });
  assert.deepEqual(args.slice(0, 7), ["app-server", "--listen", "stdio://", "--disable", "apps", "-c", "notify=[]"]);
});
