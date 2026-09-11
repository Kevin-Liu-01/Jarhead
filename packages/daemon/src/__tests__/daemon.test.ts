import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@jarhead/hands";
import { FRAME_MIC, FRAME_SPEAKER, FrameParser, encodeFrame, encodeJson, type DaemonMessage } from "../wire.ts";
import { DaemonServer, type EngineLike } from "../server.ts";
import { DaemonClient } from "../client.ts";

test("frames survive arbitrary chunking and reject oversize", () => {
  const a = encodeJson({ type: "hello" });
  const b = encodeFrame(FRAME_MIC, Buffer.from([1, 2, 3, 4, 5, 6]));
  const all = Buffer.concat([a, b]);
  const p = new FrameParser();
  const out = [];
  for (let i = 0; i < all.length; i += 3) out.push(...p.push(all.subarray(i, i + 3)));
  assert.equal(out.length, 2);
  assert.equal(JSON.parse(out[0]!.payload.toString()).type, "hello");
  assert.equal(out[1]!.type, FRAME_MIC);
  assert.equal(out[1]!.payload.length, 6);
  const bad = Buffer.alloc(5);
  bad.writeUInt8(1, 0);
  bad.writeUInt32BE(0xffffffff, 1);
  assert.throws(() => new FrameParser().push(bad));
});

class FakeEngine extends EventEmitter implements EngineLike {
  mic: Buffer[] = [];
  commands: unknown[] = [];
  pids: number[] = [];
  levels: number[] = [];
  micPermission = "unknown";
  ledger = { read: () => [{ at: 1, type: "problem", text: "x" }], days: () => ["2026-09-09.jsonl", "2026-09-10.jsonl"] };
  config = { stateDir: "/tmp/jh-test" };
  toolCalls: { name: string; input: unknown }[] = [];
  /** `attached` undefined = a runner that does not say (older engines); false = no task attached, tool.run is refused. */
  runner: { attached?: boolean; run(name: string, input: unknown): Promise<{ result: ToolResult }> } = {
    run: async (name: string, input: unknown): Promise<{ result: ToolResult }> => {
      this.toolCalls.push({ name, input });
      if (name === "screenshot") return { result: { kind: "image", pngBase64: Buffer.from("png").toString("base64"), width: 100, height: 50, note: "main display" } };
      if (name === "run_shell") return { result: { kind: "needs-confirmation", pendingId: "p1", question: "About to run rm. Ask Kevin, then stop." } };
      if (name === "zoom") throw new Error("hands are down");
      return { result: { kind: "text", text: `${name} ran with ${JSON.stringify(input)}` } };
    },
  };
  snapshot(): unknown {
    return { phase: "asleep" };
  }
  async command(cmd: unknown): Promise<void> {
    this.commands.push(cmd);
  }
  feedMic(pcm: Buffer): void {
    this.mic.push(pcm);
  }
  reportInputLevel(level: number): void {
    this.levels.push(level);
  }
  setMicrophonePermission(state: string): void {
    this.micPermission = state;
  }
  registerOwnPid(pid: number): void {
    this.pids.push(pid);
  }
  ear(): void {}
  problem(): void {}
}

test("server and client round-trip control, audio, and ledger over a unix socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const client = new DaemonClient(path);
  const messages: { type: string }[] = [];
  const audio: Buffer[] = [];
  client.on("message", (m) => messages.push(m as { type: string }));
  client.on("audio", (b) => audio.push(b));
  await client.connect({ pid: 4242, audio: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(messages.map((m) => m.type), ["hello", "snapshot"]);
  assert.deepEqual(engine.pids, [4242]);

  client.sendJson({ type: "command", command: { type: "wake" } });
  client.sendJson({ type: "command", command: { type: "nonsense" } as never });
  client.sendJson({ type: "mic-level", level: 0.4 });
  client.sendJson({ type: "permission", which: "microphone", state: "granted" });
  client.sendMic(Buffer.alloc(4800));
  client.sendJson({ type: "ledger.read", id: "r1", date: "2026-09-10" });
  client.sendJson({ type: "ledger.days", id: "r2" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(engine.commands, [{ type: "wake" }]);
  assert.deepEqual(engine.levels, [0.4]);
  assert.equal(engine.micPermission, "granted");
  assert.equal(engine.mic[0]?.length, 4800);
  const types = messages.map((m) => m.type);
  assert.ok(types.includes("error") && types.includes("ledger.rows") && types.includes("ledger.days"));
  const days = messages.find((m) => m.type === "ledger.days") as unknown as { days: string[] };
  assert.deepEqual(days.days, ["2026-09-10", "2026-09-09"]);

  engine.emit("event", { type: "snapshot", snapshot: { phase: "listening" } });
  engine.emit("event", { type: "speaker-flush" });
  engine.emit("overlay", { cmd: "clear" });
  engine.emit("audio", Buffer.alloc(960));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(messages.some((m) => m.type === "overlay"));
  // A stop/cancel/sleep reaches the speaker as the audio flush control.
  assert.ok(messages.some((m) => m.type === "audio" && (m as { control?: string }).control === "flush"));
  assert.equal(audio[0]?.length, 960);
  assert.equal(encodeFrame(FRAME_SPEAKER, Buffer.alloc(0)).length, 5);

  client.close();
  await server.close();
});

test("tool.run goes through the engine's runner and answers the asking client only; unknown names are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const asker = new DaemonClient(path);
  const bystander = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  const seenByBystander: DaemonMessage[] = [];
  asker.on("message", (m) => got.push(m));
  bystander.on("message", (m) => seenByBystander.push(m));
  await asker.connect({ pid: 1 });
  await bystander.connect({ pid: 2 });

  asker.sendJson({ type: "tool.run", id: "t1", name: "frontmost_app", input: {} });
  asker.sendJson({ type: "tool.run", id: "t2", name: "screenshot", input: { display: "main" } });
  asker.sendJson({ type: "tool.run", id: "t3", name: "run_shell", input: { command: "rm -rf x" } });
  asker.sendJson({ type: "tool.run", id: "t4", name: "zoom", input: { region: [0, 0, 1, 1] } });
  asker.sendJson({ type: "tool.run", id: "t5", name: "format_disk", input: {} });
  await new Promise((r) => setTimeout(r, 80));
  // No task attached to the runner (a Codex turn that outlived a stop): refused before the runner sees it.
  engine.runner.attached = false;
  asker.sendJson({ type: "tool.run", id: "t6", name: "left_click", input: { coordinate: [1, 1] } });
  await new Promise((r) => setTimeout(r, 40));
  engine.runner.attached = true;
  asker.sendJson({ type: "tool.run", id: "t7", name: "left_click", input: { coordinate: [1, 1] } });
  await new Promise((r) => setTimeout(r, 40));
  delete engine.runner.attached;

  const results = got.filter((m): m is Extract<DaemonMessage, { type: "tool.result" }> => m.type === "tool.result");
  const byId = new Map(results.map((r) => [r.id, r.result]));
  assert.equal(byId.get("t1")?.kind, "text");
  assert.match((byId.get("t1") as { text: string }).text, /frontmost_app ran/);
  assert.equal(byId.get("t2")?.kind, "image");
  assert.equal((byId.get("t2") as { width: number }).width, 100);
  assert.equal(byId.get("t3")?.kind, "needs-confirmation");
  // A runner that throws becomes an error result, not a dropped connection.
  assert.equal(byId.get("t4")?.kind, "error");
  assert.match((byId.get("t4") as { message: string }).message, /hands are down/);
  // Names outside ALL_TOOL_SPECS never reach the runner.
  assert.equal(byId.get("t5")?.kind, "error");
  assert.match((byId.get("t5") as { message: string }).message, /unknown tool format_disk/);
  assert.equal(byId.get("t6")?.kind, "error");
  assert.match((byId.get("t6") as { message: string }).message, /^refused: no task is running in Jarhead; left_click was not run/);
  assert.equal(byId.get("t7")?.kind, "text", "with a task attached the same call runs");
  assert.deepEqual(engine.toolCalls.map((c) => c.name), ["frontmost_app", "screenshot", "run_shell", "zoom", "left_click"], "the refused call never reached the runner");
  assert.equal(seenByBystander.filter((m) => m.type === "tool.result").length, 0, "tool results are not broadcast");

  asker.close();
  bystander.close();
  await server.close();
});
