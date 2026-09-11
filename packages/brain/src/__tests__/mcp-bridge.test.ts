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
import { SocketToolClient, toMcpContent, toMcpTool, runToolOverSocket } from "../mcp-bridge.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";

const BRIDGE = fileURLToPath(new URL("../mcp-bridge.ts", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

class FakeEngine extends EventEmitter implements EngineLike {
  calls: { name: string; input: unknown }[] = [];
  ledger = { read: () => [], days: () => [] };
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
  assert.equal(ALL_TOOL_SPECS.map(toMcpTool).length, 17 + 6 + 5 + 4 + 11 + 6 + 6);

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
