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
import { toMcpContent, toMcpTool, runToolOverSocket } from "../mcp-bridge.ts";
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
  problem(): void {}
}

test("mcp bridge: tool specs become MCP tools verbatim and results become MCP content", () => {
  const scroll = toMcpTool(specByName("scroll")!);
  assert.equal(scroll.name, "scroll");
  assert.equal(scroll.inputSchema.type, "object");
  assert.deepEqual(scroll.inputSchema.required, ["scroll_direction", "scroll_amount"]);
  assert.deepEqual((scroll.inputSchema.properties as Record<string, { enum?: string[] }>)["scroll_direction"]?.enum, ["up", "down", "left", "right"]);
  assert.equal(ALL_TOOL_SPECS.map(toMcpTool).length, 38);

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
