import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "@jarhead/core";
import { DaemonServer, type EngineLike } from "@jarhead/daemon";
import type { ToolResult } from "@jarhead/hands";
import { SocketToolClient, toMcpContent, toMcpTool, runToolOverSocket, workerFromEnv } from "../mcp-bridge.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";

const BRIDGE = fileURLToPath(new URL("../mcp-bridge.ts", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** The four specs WORKER_SPECS adds to the table (tools.ts); the bridge serves them like any other. */
/** The four thread specs (tools.ts THREAD_SPECS); worker_* are aliases the scheduler answers, not specs. */
const THREAD_TOOLS = ["thread_start", "thread_wait", "thread_read", "thread_stop"] as const;

class FakeEngine extends EventEmitter implements EngineLike {
  calls: { name: string; input: unknown }[] = [];
  /** Calls that arrived with a worker id, by the lane runner `runnerFor` handed out. */
  workerCalls: { worker: string; name: string; input: unknown }[] = [];
  workers = new Set<string>();
  ledger = { read: () => [], days: () => [], sessions: () => [], readSession: () => [] };
  config = { stateDir: "/tmp/jh-test" };
  runner = {
    run: async (name: string, input: unknown): Promise<{ result: ToolResult }> => {
      this.calls.push({ name, input });
      if (name === "screenshot") return { result: { kind: "image", pngBase64: Buffer.from("png").toString("base64"), width: 100, height: 50, note: "main display" } };
      if (name === "run_shell") return { result: { kind: "needs-confirmation", pendingId: "p1", question: 'About to run "rm -rf x". Ask Kevin to confirm out loud, then stop.' } };
      if (name === "zoom") throw new Error("hands are down");
      return { result: { kind: "text", text: `${name} → ${JSON.stringify(input)}` } };
    },
  };
  runnerFor(worker: string): EngineLike["runner"] | undefined {
    if (!this.workers.has(worker)) return undefined;
    return {
      attached: true,
      run: async (name: string, input: unknown): Promise<{ result: ToolResult }> => {
        this.workerCalls.push({ worker, name, input });
        return { result: { kind: "text", text: `${worker}: ${name} → ${JSON.stringify(input)}` } };
      },
    };
  }
  snapshot(): unknown {
    return { phase: "asleep" };
  }
  async command(): Promise<void> {}
  feedMic(): void {}
  reportInputLevel(): void {}
  setMicrophonePermission(): void {}
  registerOwnPid(): void {}
  ear(): void {}
  problem(): void {}
}

test("mcp bridge: tool specs become MCP tools verbatim and results become MCP content", () => {
  const scroll = toMcpTool(specByName("scroll")!);
  assert.equal(scroll.name, "scroll");
  assert.equal(scroll.inputSchema.type, "object");
  assert.deepEqual(scroll.inputSchema.required, ["scroll_direction", "scroll_amount"]);
  assert.deepEqual((scroll.inputSchema.properties as Record<string, { enum?: string[] }>)["scroll_direction"]?.enum, ["up", "down", "left", "right"]);
  // Pinned at 67: the 63 of f6c3b40 (17 + 8 + 6 + 5 + 4 + 11 + 6 + 6) plus the four worker_* specs
  // (WORKER_SPECS, tools.ts). A tool added or lost anywhere in the table moves this number on purpose.
  assert.equal(ALL_TOOL_SPECS.map(toMcpTool).length, 67);
  const names = new Set(ALL_TOOL_SPECS.map((t) => t.name));
  for (const n of THREAD_TOOLS) assert.ok(names.has(n), `${n} is in the table the bridge serves`);

  assert.deepEqual(toMcpContent({ kind: "text", text: "hi" }), { content: [{ type: "text", text: "hi" }] });
  const img = toMcpContent({ kind: "image", pngBase64: "AAAA", width: 10, height: 5, note: "n" });
  assert.deepEqual(img.content[0], { type: "image", data: "AAAA", mimeType: "image/png" });
  assert.match((img.content[1] as { text: string }).text, /^10x5 px; n\. Coordinates for clicks are pixels of this image\.$/);
  assert.deepEqual(toMcpContent({ kind: "needs-confirmation", pendingId: "p", question: "Sure?" }), { content: [{ type: "text", text: "needs_confirmation: Sure?" }] });
  assert.deepEqual(toMcpContent({ kind: "error", message: "nope" }), { content: [{ type: "text", text: "error: nope" }], isError: true });
});

test("mcp bridge: a dead socket is an error result, not a hang", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-bridge-"));
  const r = await runToolOverSocket(join(dir, "none.sock"), "frontmost_app", {}, 2000);
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /could not reach the Jarhead daemon/);
});

test("mcp bridge: the stdio server lists every tool and routes tools/call over the daemon socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-bridge-"));
  const socketPath = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, socketPath);
  await server.listen();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, BRIDGE],
    env: { ...(process.env as Record<string, string>), JARHEAD_SOCKET: socketPath },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, ALL_TOOL_SPECS.length);
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), ALL_TOOL_SPECS.map((t) => t.name).sort());
    assert.equal(listed.tools.find((t) => t.name === "screenshot")?.description, specByName("screenshot")!.description);

    const text = await client.callTool({ name: "frontmost_app", arguments: {} });
    assert.deepEqual(text.content, [{ type: "text", text: "frontmost_app → {}" }]);
    const shot = await client.callTool({ name: "screenshot", arguments: { display: "main" } });
    const content = shot.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    assert.equal(content[0]?.type, "image");
    assert.equal(content[0]?.mimeType, "image/png");
    assert.equal(content[0]?.data, Buffer.from("png").toString("base64"));
    assert.match(content[1]?.text ?? "", /100x50 px; main display/);
    const confirm = await client.callTool({ name: "run_shell", arguments: { command: "rm -rf x" } });
    assert.match((confirm.content as Array<{ text: string }>)[0]?.text ?? "", /^needs_confirmation: About to run "rm -rf x"/);
    const thrown = await client.callTool({ name: "zoom", arguments: { region: [0, 0, 1, 1] } });
    assert.equal(thrown.isError, true);
    assert.match((thrown.content as Array<{ text: string }>)[0]?.text ?? "", /hands are down/);
    const unknown = await client.callTool({ name: "format_disk", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.match((unknown.content as Array<{ text: string }>)[0]?.text ?? "", /unknown tool format_disk/);
    assert.deepEqual(engine.calls.map((c) => c.name), ["frontmost_app", "screenshot", "run_shell", "zoom"], "the unknown name never reached the runner");
    assert.deepEqual(engine.calls[1]?.input, { display: "main" });
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp bridge: a worker's bridge names its worker on every tool.run, the daemon routes to that worker's lane runner, and an unknown worker is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-bridge-"));
  const socketPath = join(dir, "d.sock");
  const engine = new FakeEngine();
  engine.workers.add("w_spotify");
  const server = new DaemonServer(engine, socketPath);
  await server.listen();
  const worker = new SocketToolClient(socketPath, { worker: "w_spotify" });
  const main = new SocketToolClient(socketPath);
  const gone = new SocketToolClient(socketPath, { worker: "w_gone" });
  const blank = new SocketToolClient(socketPath, { worker: "" });
  try {
    assert.equal(worker.workerId, "w_spotify");
    assert.equal(main.workerId, undefined);
    assert.equal(blank.workerId, undefined, "an empty id is no worker: the frame carries none");
    const play = { script: 'tell application "Spotify" to play' };
    assert.deepEqual(await worker.run("applescript", play), { kind: "text", text: `w_spotify: applescript → ${JSON.stringify(play)}` });
    assert.deepEqual(await main.run("frontmost_app", {}), { kind: "text", text: "frontmost_app → {}" });
    assert.deepEqual(await blank.run("frontmost_app", {}), { kind: "text", text: "frontmost_app → {}" });
    const refused = await gone.run("left_click", { coordinate: [1, 1] });
    assert.equal(refused.kind, "error");
    assert.match((refused as { message: string }).message, /^refused: no worker w_gone is running in Jarhead; left_click was not run/);
    // The one-off path carries the worker too.
    assert.deepEqual(await runToolOverSocket(socketPath, "list_windows", {}, 2000, "w_spotify"), { kind: "text", text: "w_spotify: list_windows → {}" });
    assert.deepEqual(engine.workerCalls, [
      { worker: "w_spotify", name: "applescript", input: play },
      { worker: "w_spotify", name: "list_windows", input: {} },
    ]);
    assert.deepEqual(engine.calls.map((c) => c.name), ["frontmost_app", "frontmost_app"], "the main runner never saw a worker's call");
  } finally {
    worker.close();
    main.close();
    gone.close();
    blank.close();
    await server.close();
  }
});

test("mcp bridge: workerFromEnv reads JARHEAD_WORKER and treats unset, empty and blank as the main brain", () => {
  assert.equal(workerFromEnv({}), undefined);
  assert.equal(workerFromEnv({ JARHEAD_WORKER: "" }), undefined);
  assert.equal(workerFromEnv({ JARHEAD_WORKER: "   " }), undefined);
  assert.equal(workerFromEnv({ JARHEAD_WORKER: " w_7f3a\n" }), "w_7f3a");
});

test("mcp bridge: the stdio server started with JARHEAD_WORKER routes every tools/call to that worker's lane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-bridge-"));
  const socketPath = join(dir, "d.sock");
  const engine = new FakeEngine();
  engine.workers.add("w_slack");
  const server = new DaemonServer(engine, socketPath);
  await server.listen();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, BRIDGE],
    env: { ...(process.env as Record<string, string>), JARHEAD_SOCKET: socketPath, JARHEAD_WORKER: "w_slack" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, ALL_TOOL_SPECS.length, "a worker's bridge lists the same table; the lane runner does the refusing");
    const text = await client.callTool({ name: "frontmost_app", arguments: {} });
    assert.deepEqual(text.content, [{ type: "text", text: "w_slack: frontmost_app → {}" }]);
    assert.deepEqual(engine.workerCalls, [{ worker: "w_slack", name: "frontmost_app", input: {} }]);
    assert.equal(engine.calls.length, 0, "nothing reached the main runner");
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp bridge: the stdio server started with a blank JARHEAD_WORKER lists and routes as the main brain", async () => {
  // A launcher that sets the variable to whitespace (an empty TOML string, a template left
  // blank) is not a worker: the frames carry no `worker` and the main runner answers.
  const dir = mkdtempSync(join(tmpdir(), "jh-bridge-"));
  const socketPath = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, socketPath);
  await server.listen();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, BRIDGE],
    env: { ...(process.env as Record<string, string>), JARHEAD_SOCKET: socketPath, JARHEAD_WORKER: "   " },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, ALL_TOOL_SPECS.length);
    const text = await client.callTool({ name: "frontmost_app", arguments: {} });
    assert.deepEqual(text.content, [{ type: "text", text: "frontmost_app → {}" }]);
    assert.deepEqual(engine.calls, [{ name: "frontmost_app", input: {} }], "the main runner answered");
    assert.equal(engine.workerCalls.length, 0, "no lane runner was asked for");
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp bridge: SocketToolClient keeps one connection, multiplexes calls in flight, survives the daemon going away and reconnects on the next call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-bridge-"));
  const socketPath = join(dir, "d.sock");
  const engine = new FakeEngine();
  let server = new DaemonServer(engine, socketPath);
  await server.listen();
  const client = new SocketToolClient(socketPath);
  try {
    // Two calls at once over the one connection: both answered, matched by id.
    const [a, b] = await Promise.all([client.run("frontmost_app", {}), client.run("list_windows", { all: true })]);
    assert.deepEqual(a, { kind: "text", text: "frontmost_app → {}" });
    assert.deepEqual(b, { kind: "text", text: 'list_windows → {"all":true}' });
    assert.equal(client.connected, true);
    assert.equal(client.inFlight, 0);
    assert.equal(server.clientCount, 1, "one connection for both calls");
    const shot = await client.run("screenshot", {});
    assert.equal(shot.kind, "image");
    assert.equal(server.clientCount, 1, "still the same connection");

    // The daemon goes away mid-call: the call comes back as an error result, not a hang.
    const slow = new FakeEngine();
    slow.runner.run = () => new Promise(() => undefined);
    await server.close();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.connected, false);
    server = new DaemonServer(slow, socketPath);
    await server.listen();
    const hanging = client.run("frontmost_app", {}, 5000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.connected, true, "reconnected for the new call");
    assert.equal(client.inFlight, 1);
    await server.close();
    const dropped = await hanging;
    assert.equal(dropped.kind, "error");
    assert.match((dropped as { message: string }).message, /closed the connection/);

    // A dead socket: an error result; a daemon back on the path: the next call works.
    const dead = await client.run("frontmost_app", {}, 500);
    assert.equal(dead.kind, "error");
    assert.match((dead as { message: string }).message, /could not reach the Jarhead daemon/);
    server = new DaemonServer(engine, socketPath);
    await server.listen();
    assert.deepEqual(await client.run("frontmost_app", {}), { kind: "text", text: "frontmost_app → {}" });
  } finally {
    client.close();
    await server.close();
  }
});
