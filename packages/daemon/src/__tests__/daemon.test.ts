import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@jarhead/hands";
import { FRAME_MIC, FRAME_SPEAKER, FrameParser, encodeFrame, encodeJson, type DaemonMessage } from "../wire.ts";
import { DaemonServer, Lifeline, type EngineLike, type ToolHost } from "../server.ts";
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
  ledger: EngineLike["ledger"] = {
    read: () => [{ at: 1, type: "problem", text: "x" }],
    days: () => ["2026-09-09.jsonl", "2026-09-10.jsonl"],
    sessions: () => [{ id: "sess_a", day: "2026-09-10", startedAt: 1, closedAt: 9, reason: "paused", usageSeconds: 8, heard: 1, said: 1, delegations: 0, title: "hi" }],
    readSession: (id: string) => (id === "sess_a" ? [{ at: 1, type: "session.started", sessionId: "sess_a", voice: "cedar" }, { at: 9, type: "pause", sessionId: "sess_a", usageSeconds: 8 }] : []),
    search: () => [],
    readChain: () => ({ rows: [], truncated: false }),
  };
  memory: EngineLike["memory"] = { list: () => [], search: async () => [] };
  config = { stateDir: "/tmp/jh-test" };
  toolCalls: { name: string; input: unknown }[] = [];
  /** `attached` undefined = a runner that does not say; false = no task attached, tool.run is refused. */
  runner: { attached?: boolean; run(name: string, input: unknown): Promise<{ result: ToolResult }> } = {
    run: async (name: string, input: unknown): Promise<{ result: ToolResult }> => {
      this.toolCalls.push({ name, input });
      if (name === "screenshot") return { result: { kind: "image", pngBase64: Buffer.from("png").toString("base64"), width: 100, height: 50, note: "main display" } };
      if (name === "run_shell") return { result: { kind: "needs-confirmation", pendingId: "p1", question: "About to run rm. Ask Kevin, then stop." } };
      if (name === "zoom") throw new Error("hands are down");
      return { result: { kind: "text", text: `${name} ran with ${JSON.stringify(input)}` } };
    },
  };
  /** Thread lane runners by id (`runnerFor`); a thread's call must land here and never in `runner`. */
  threadRunners = new Map<string, { attached?: boolean; run(name: string, input: unknown): Promise<{ result: ToolResult }> }>();
  threadCalls: { thread: string; name: string; input: unknown }[] = [];
  runnerFor(threadId: string): { attached?: boolean; run(name: string, input: unknown): Promise<{ result: ToolResult }> } | undefined {
    return this.threadRunners.get(threadId);
  }
  /** A thread whose lane runner answers with its own id, so a test can tell whose hands ran. */
  addThread(id: string): { attached?: boolean; run(name: string, input: unknown): Promise<{ result: ToolResult }> } {
    const runner = {
      attached: true,
      run: async (name: string, input: unknown): Promise<{ result: ToolResult }> => {
        this.threadCalls.push({ thread: id, name, input });
        return { result: { kind: "text", text: `${id} ran ${name}` } };
      },
    };
    this.threadRunners.set(id, runner);
    return runner;
  }
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
  /** Every `permission` message, as the engine would see it; the microphone is one of the rows. */
  permissionCalls: { which: string; state: string; detail?: string }[] = [];
  permissionLists: unknown[][] = [];
  setPermission(which: string, state: "granted" | "denied" | "unknown", detail?: string): void {
    this.permissionCalls.push({ which, state, ...(detail !== undefined ? { detail } : {}) });
    if (which === "microphone") this.micPermission = state;
  }
  setPermissions(all: unknown[]): void {
    this.permissionLists.push(all);
  }
  registerOwnPid(pid: number): void {
    this.pids.push(pid);
  }
  ear(): void {}
  problem(): void {}
  /** Client ids whose sockets closed, as the engine hears them (`dropViewers`). */
  dropped: string[] = [];
  dropViewers(clientId: string): void {
    this.dropped.push(clientId);
  }
  /** Every `system.signal` the wire handed over (design11): data for the watchers. */
  signals: { signal: unknown; at: number }[] = [];
  systemSignal(signal: unknown, at: number): void {
    this.signals.push({ signal, at });
  }
  /** How many viewers the server counted on each hello / close. */
  viewers: number[] = [];
  setViewers(n: number): void {
    this.viewers.push(n);
  }
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

  client.sendJson({ type: "command", command: { type: "go" } });
  client.sendJson({ type: "command", command: { type: "nonsense" } as never });
  client.sendJson({ type: "mic-level", level: 0.4 });
  client.sendJson({ type: "permission", which: "microphone", state: "granted" });
  client.sendMic(Buffer.alloc(4800));
  client.sendJson({ type: "ledger.read", id: "r1", date: "2026-09-10" });
  client.sendJson({ type: "ledger.days", id: "r2" });
  client.sendJson({ type: "ledger.sessions", id: "r3" });
  client.sendJson({ type: "ledger.session", id: "r4", sessionId: "sess_a" });
  client.sendJson({ type: "ledger.session", id: "r5", sessionId: "nope" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(engine.commands, [{ type: "go" }]);
  assert.deepEqual(engine.levels, [0.4]);
  assert.equal(engine.micPermission, "granted");
  assert.equal(engine.mic[0]?.length, 4800);
  const types = messages.map((m) => m.type);
  assert.ok(types.includes("error") && types.includes("ledger.rows") && types.includes("ledger.days"));
  const days = messages.find((m) => m.type === "ledger.days") as unknown as { days: string[] };
  assert.deepEqual(days.days, ["2026-09-10", "2026-09-09"]);
  const sessions = messages.find((m) => m.type === "ledger.sessions") as unknown as { id: string; sessions: { id: string }[] };
  assert.equal(sessions.id, "r3");
  assert.deepEqual(sessions.sessions.map((s) => s.id), ["sess_a"]);
  const rowsFor = (id: string) => (messages.find((m) => m.type === "ledger.rows" && (m as unknown as { id: string }).id === id) as unknown as { rows: { type: string }[] }).rows;
  assert.deepEqual(rowsFor("r4").map((r) => r.type), ["session.started", "pause"]);
  assert.deepEqual(rowsFor("r5"), []);

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

test("ping is answered with a pong carrying the same id and a wall-clock `at`, to the asking client only, with no engine involved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = new DaemonClient(path);
  const bystander = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  const seenByBystander: DaemonMessage[] = [];
  app.on("message", (m) => got.push(m));
  bystander.on("message", (m) => seenByBystander.push(m));
  await app.connect({ pid: 1, audio: true });
  await bystander.connect({ pid: 2 });
  await tick(30);
  const before = Date.now();
  app.sendJson({ type: "ping", id: "p-1" });
  app.sendJson({ type: "ping", id: "p-2" });
  await tick(40);
  const pongs = got.filter((m): m is Extract<DaemonMessage, { type: "pong" }> => m.type === "pong");
  assert.deepEqual(pongs.map((p) => p.id), ["p-1", "p-2"]);
  for (const p of pongs) assert.ok(p.at >= before && p.at <= Date.now() + 1, `at is the daemon's clock (${p.at})`);
  assert.equal(seenByBystander.filter((m) => m.type === "pong").length, 0, "a pong goes to whoever pinged");
  assert.deepEqual(engine.commands, [], "a ping is not an engine command");
  app.close();
  bystander.close();
  await server.close();
});

test("permission and permissions messages reach the engine as sent; a non-array list is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const client = new DaemonClient(path);
  await client.connect({ pid: 7 });

  // The app read one kind: any of the sixteen, with or without a detail line.
  client.sendJson({ type: "permission", which: "fullDiskAccess", state: "denied", detail: "not in the Full Disk Access list" });
  client.sendJson({ type: "permission", which: "contacts", state: "granted" });
  client.sendJson({ type: "permission", which: "microphone", state: "granted" });
  // The app's full list after a sweep: PermissionInfo rows, passed through untouched (the engine validates them).
  const all = [
    { kind: "microphone", grant: "granted", ask: "prompt", required: true, label: "Microphone", why: "hearing you" },
    { kind: "fullDiskAccess", grant: "denied", ask: "settings", required: true, label: "Full Disk Access", why: "Mail, Safari, every folder", detail: "drag Jarhead.app in", checkedAt: 1 },
  ];
  client.sendJson({ type: "permissions", all });
  client.sendJson({ type: "permissions", all: "nope" } as never);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(engine.permissionCalls, [
    { which: "fullDiskAccess", state: "denied", detail: "not in the Full Disk Access list" },
    { which: "contacts", state: "granted" },
    { which: "microphone", state: "granted" },
  ]);
  assert.equal(engine.micPermission, "granted", "the microphone reaches the engine as a row like any other");
  assert.deepEqual(engine.permissionLists, [all], "the list arrives as sent; a non-array is dropped");

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

/** Wait until the socket delivered what the test expects — a fixed pause is too short under a loaded full run. */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("tool.run with a thread goes to engine.runnerFor(threadId) and never the main runner; unknown, malformed and unattached threads are refused in the runner's refusal shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const spotify = engine.addThread("t_spotify");
  const server = new DaemonServer(engine, path);
  await server.listen();
  const bridge = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  bridge.on("message", (m) => got.push(m));
  await bridge.connect({ pid: 1 });
  const results = () => got.filter((m): m is Extract<DaemonMessage, { type: "tool.result" }> => m.type === "tool.result");

  const play = { script: 'tell application "Spotify" to play' };
  bridge.sendJson({ type: "tool.run", id: "w1", name: "applescript", input: play, thread: "t_spotify" });
  // A thread the engine does not have: finished, stopped or never started.
  bridge.sendJson({ type: "tool.run", id: "w2", name: "left_click", input: { coordinate: [1, 1] }, thread: "t_gone" });
  // A thread id that is not a string, and one that is empty: neither may reach any runner.
  bridge.sendJson({ type: "tool.run", id: "w3", name: "left_click", input: { coordinate: [1, 1] }, thread: 7 } as never);
  bridge.sendJson({ type: "tool.run", id: "w4", name: "frontmost_app", input: {}, thread: "" });
  // No thread: the main brain's call.
  bridge.sendJson({ type: "tool.run", id: "w5", name: "frontmost_app", input: {} });
  // The tool table is checked first, whoever asks.
  bridge.sendJson({ type: "tool.run", id: "w6", name: "format_disk", input: {}, thread: "t_spotify" });
  await until(() => results().length === 6, "six tool results");
  // The thread's lane lost its task (cancelled, budget cut): the same refusal the main runner gives.
  spotify.attached = false;
  bridge.sendJson({ type: "tool.run", id: "w7", name: "applescript", input: play, thread: "t_spotify" });
  await until(() => results().length === 7, "the seventh tool result");

  const byId = new Map(results().map((r) => [r.id, r.result]));
  assert.deepEqual(byId.get("w1"), { kind: "text", text: "t_spotify ran applescript" });
  assert.equal(byId.get("w2")?.kind, "error");
  assert.match((byId.get("w2") as { message: string }).message, /^refused: no thread t_gone is running in Jarhead; left_click was not run \(it finished, was stopped, or never started\)$/);
  assert.match((byId.get("w3") as { message: string }).message, /^refused: malformed thread id; left_click was not run$/);
  assert.match((byId.get("w4") as { message: string }).message, /^refused: malformed thread id; frontmost_app was not run$/);
  assert.match((byId.get("w5") as { text: string }).text, /frontmost_app ran/);
  assert.match((byId.get("w6") as { message: string }).message, /unknown tool format_disk/);
  assert.match((byId.get("w7") as { message: string }).message, /^refused: no task is running in Jarhead; applescript was not run \(Kevin stopped the task, or it finished\)$/);
  assert.deepEqual(engine.threadCalls, [{ thread: "t_spotify", name: "applescript", input: play }], "only the routed call reached the thread's lane");
  assert.deepEqual(engine.toolCalls.map((c) => c.name), ["frontmost_app"], "the main runner saw the main call and no thread's");

  // An engine with no thread running: every stamped call is refused as unknown; main calls still run.
  const idle = new FakeEngine();
  const idlePath = join(dir, "i.sock");
  const idleServer = new DaemonServer(idle, idlePath);
  await idleServer.listen();
  const idleBridge = new DaemonClient(idlePath);
  const idleGot: DaemonMessage[] = [];
  idleBridge.on("message", (m) => idleGot.push(m));
  await idleBridge.connect({ pid: 2 });
  idleBridge.sendJson({ type: "tool.run", id: "i1", name: "frontmost_app", input: {}, thread: "t_spotify" });
  idleBridge.sendJson({ type: "tool.run", id: "i2", name: "frontmost_app", input: {} });
  await until(() => idleGot.filter((m) => m.type === "tool.result").length === 2, "two tool results from the idle engine");
  const idleById = new Map(idleGot.filter((m): m is Extract<DaemonMessage, { type: "tool.result" }> => m.type === "tool.result").map((r) => [r.id, r.result]));
  assert.match((idleById.get("i1") as { message: string }).message, /^refused: no thread t_spotify is running in Jarhead/);
  assert.equal(idleById.get("i2")?.kind, "text");
  assert.deepEqual(idle.toolCalls.map((c) => c.name), ["frontmost_app"]);

  bridge.close();
  idleBridge.close();
  await server.close();
  await idleServer.close();
});

test("a server over a ToolHost (one brain's private tool socket): runnerFor knows exactly its thread id — that id routes, every other id is refused, no thread still hits runner; the other frames are inert", async () => {
  // The shape CodexBrain's own tool socket has outside the daemon process: one runner, one
  // thread id at most. A thread's brain there names its id on every frame; the server must
  // hand those to the same runner and nothing else to it.
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const calls: { name: string }[] = [];
  const runner = {
    attached: true,
    run: async (name: string): Promise<{ result: ToolResult }> => {
      calls.push({ name });
      return { result: { kind: "text", text: `${name} ran on the one runner` } };
    },
  };
  const host: ToolHost = { runner, runnerFor: (threadId) => (threadId === "t_slack" ? runner : undefined) };
  const server = new DaemonServer(host, path);
  await server.listen();
  const bridge = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  bridge.on("message", (m) => got.push(m));
  await bridge.connect({ pid: 1 });
  const results = () => got.filter((m): m is Extract<DaemonMessage, { type: "tool.result" }> => m.type === "tool.result");
  bridge.sendJson({ type: "tool.run", id: "s1", name: "frontmost_app", input: {}, thread: "t_slack" });
  bridge.sendJson({ type: "tool.run", id: "s2", name: "frontmost_app", input: {}, thread: "t_spotify" });
  bridge.sendJson({ type: "tool.run", id: "s3", name: "frontmost_app", input: {} });
  // Not a tool call: answered empty, never an error, never a crash.
  bridge.sendJson({ type: "ledger.search", id: "q1", query: "anything" });
  bridge.sendJson({ type: "memory.list", id: "m1" });
  bridge.sendJson({ type: "command", command: { type: "go" } });
  await until(() => results().length === 3 && got.some((m) => m.type === "ledger.hits") && got.some((m) => m.type === "memory.items"), "three tool results and the two empty answers");
  const byId = new Map(results().map((r) => [r.id, r.result]));
  assert.deepEqual(byId.get("s1"), { kind: "text", text: "frontmost_app ran on the one runner" });
  assert.match((byId.get("s2") as { message: string }).message, /^refused: no thread t_spotify is running in Jarhead; frontmost_app was not run/);
  assert.deepEqual(byId.get("s3"), { kind: "text", text: "frontmost_app ran on the one runner" });
  assert.equal(calls.length, 2, "the thread's own call and the plain call ran; the stranger's did not");
  assert.deepEqual(got.find((m) => m.type === "ledger.hits"), { type: "ledger.hits", id: "q1", hits: [] });
  assert.deepEqual(got.find((m) => m.type === "memory.items"), { type: "memory.items", id: "m1", items: [] });
  assert.equal(got.filter((m) => m.type === "error").length, 0);
  assert.equal(server.clientCount, 1);
  bridge.close();
  await server.close();
});

test("tool.run with thread: null on the wire is refused as malformed, never routed to the main runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  engine.addThread("t_spotify");
  const server = new DaemonServer(engine, path);
  await server.listen();
  const bridge = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  bridge.on("message", (m) => got.push(m));
  await bridge.connect({ pid: 1 });
  // JSON.stringify keeps a null where it drops an undefined: a bridge that sets the key to null sends it.
  bridge.sendJson({ type: "tool.run", id: "n1", name: "frontmost_app", input: {}, thread: null } as never);
  await until(() => got.some((m) => m.type === "tool.result"), "the tool result");
  const r = got.find((m): m is Extract<DaemonMessage, { type: "tool.result" }> => m.type === "tool.result")!;
  assert.equal(r.id, "n1");
  assert.match((r.result as { message: string }).message, /^refused: malformed thread id; frontmost_app was not run$/);
  assert.equal(engine.toolCalls.length, 0, "the main runner never saw it");
  assert.equal(engine.threadCalls.length, 0);
  bridge.close();
  await server.close();
});

test("an engine whose runnerFor throws answers the asking client with an error result and the server keeps serving", async () => {
  // runTool is fire-and-forget; a throw from the engine's pool lookup (a thread being cut
  // as its brain calls) must not become the unhandled rejection that would exit the daemon.
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  engine.runnerFor = (threadId: string) => {
    if (threadId === "t_boom") throw new Error("the pool is mid-cut");
    return engine.threadRunners.get(threadId);
  };
  engine.addThread("t_ok");
  const server = new DaemonServer(engine, path);
  await server.listen();
  const bridge = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  bridge.on("message", (m) => got.push(m));
  await bridge.connect({ pid: 1 });
  const results = () => got.filter((m): m is Extract<DaemonMessage, { type: "tool.result" }> => m.type === "tool.result");
  bridge.sendJson({ type: "tool.run", id: "b1", name: "frontmost_app", input: {}, thread: "t_boom" });
  await until(() => results().length === 1, "the refusal");
  assert.equal(results()[0]!.id, "b1");
  assert.match((results()[0]!.result as { message: string }).message, /^refused: the pool is mid-cut; frontmost_app was not run$/);
  // Still up: the next thread call and the next main call both run.
  bridge.sendJson({ type: "tool.run", id: "b2", name: "frontmost_app", input: {}, thread: "t_ok" });
  bridge.sendJson({ type: "tool.run", id: "b3", name: "frontmost_app", input: {} });
  await until(() => results().length === 3, "two more results");
  const byId = new Map(results().map((r) => [r.id, r.result]));
  assert.deepEqual(byId.get("b2"), { kind: "text", text: "t_ok ran frontmost_app" });
  assert.equal(byId.get("b3")?.kind, "text");
  assert.equal(server.clientCount, 1, "the connection survived the throw");
  bridge.close();
  await server.close();
});

test("commands on the wire: thread.stop and sleep with a cause pass isEngineCommand and reach the engine as sent; a tool name is not a command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  app.on("message", (m) => got.push(m));
  await app.connect({ pid: 1 });
  // The Console's Stop on a thread card; the blob dropped into the notch; a spoken cue with its phrase; the app's bare sleep.
  const sent = [
    { type: "thread.stop", threadId: "t_spotify" },
    { type: "sleep", cause: "dock" },
    { type: "sleep", cause: "said", phrase: "go to sleep" },
    { type: "sleep" },
  ];
  for (const command of sent) app.sendJson({ type: "command", command });
  // thread_start is a brain tool, not a surface command: refused as malformed, never dispatched.
  app.sendJson({ type: "command", command: { type: "thread_start", name: "Spotify" } as never });
  await until(() => got.some((m) => m.type === "error"), "the malformed-command error");
  assert.deepEqual(engine.commands, sent, "each command arrives intact, cause and phrase included");
  assert.deepEqual(got.filter((m) => m.type === "error"), [{ type: "error", message: "malformed command" }]);
  app.close();
  await server.close();
});

// ----------------------------------------------------------------- conversations: viewers, not broadcast

/** A connected client with every frame it receives, by type. */
async function viewer(path: string, pid: number): Promise<{ client: DaemonClient; got: DaemonMessage[]; of: (type: string) => DaemonMessage[] }> {
  const client = new DaemonClient(path);
  const got: DaemonMessage[] = [];
  client.on("message", (m) => got.push(m));
  await client.connect({ pid });
  return { client, got, of: (type) => got.filter((m) => m.type === type) };
}

const threadPage = (threadId: string, seq: number) => ({ threadId, entries: [{ kind: "system", seq, at: 1, symbol: "circle", text: "started" }], total: seq, complete: false, live: true, cursor: { startSeq: seq, endSeq: seq } });

test("thread.transcript reaches only the viewers of that thread; a second client's thread gets only its own; thread.event, snapshot and toast still reach everyone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const a = await viewer(path, 1); // the Console: Slack's pane
  const b = await viewer(path, 2); // a second Console window on Slack
  const c = await viewer(path, 3); // a pane on Spotify
  const cli = await viewer(path, 4); // `pnpm jarhead status`: joins, never opens anything
  a.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p1" } });
  b.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p2" } });
  c.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_spotify", viewer: "p3" } });
  await until(() => engine.commands.length === 3, "three opens at the engine");

  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 1), mode: "replace" });
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_spotify", 1), mode: "replace" });
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 2), mode: "append" });
  engine.emit("event", { type: "thread.event", event: { seq: 7, at: 1, threadId: "t_slack", kind: "step", steps: 3, tool: "click_element", ok: true } });
  engine.emit("event", { type: "snapshot", snapshot: { phase: "acting" } });
  engine.emit("event", { type: "toast", text: "Slack asks: send it to Ben?", tone: "info" });
  // Four sockets are four read queues: a toast seen at one says nothing about another's pages yet.
  for (const v of [a, b, c, cli]) await until(() => v.of("toast").length === 1, "the toast at every client");

  const pages = (v: { of: (t: string) => DaemonMessage[] }) => v.of("thread.transcript").map((m) => { const t = m as Extract<DaemonMessage, { type: "thread.transcript" }>; return `${(t.transcript as { threadId: string }).threadId}/${t.mode}`; });
  assert.deepEqual(pages(a), ["t_slack/replace", "t_slack/append"], "Slack's pages, in order, to the first viewer");
  assert.deepEqual(pages(b), ["t_slack/replace", "t_slack/append"], "and to the second viewer of the same thread");
  assert.deepEqual(pages(c), ["t_spotify/replace"], "Spotify's viewer sees Spotify only");
  assert.deepEqual(pages(cli), [], "a client that opened nothing receives no conversation page");
  for (const v of [a, b, c, cli]) {
    assert.equal(v.of("thread.event").length, 1, "thread.event is broadcast: Spotify's viewer and the CLI hear Slack's step too");
    assert.equal(v.of("snapshot").length, 2, "the hello snapshot and the emitted one");
    assert.equal(v.of("toast").length, 1);
  }
  const ev = a.of("thread.event")[0] as Extract<DaemonMessage, { type: "thread.event" }>;
  assert.deepEqual(ev.event, { seq: 7, at: 1, threadId: "t_slack", kind: "step", steps: 3, tool: "click_element", ok: true }, "the event rides the wire unchanged");
  assert.ok(encodeJson({ type: "thread.event", event: ev.event }).length <= 200, "a step event frame fits the 200 B budget");

  for (const v of [a, b, c, cli]) v.client.close();
  await server.close();
});

test("agent.transcript goes to that agent's viewers only — the CLI's join/leave clients receive none — and the same client may view an agent and a thread at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const console_ = await viewer(path, 1);
  const cli = await viewer(path, 2);
  console_.client.sendJson({ type: "command", command: { type: "agent.open", agentId: "sessions:codex:abc", viewer: "pane-1" } });
  console_.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "main" } });
  await until(() => engine.commands.length === 2, "the two opens");
  engine.emit("event", { type: "agent.transcript", transcript: { agentId: "sessions:codex:abc", messages: [], total: 0, complete: true, live: true }, mode: "replace" });
  engine.emit("event", { type: "agent.transcript", transcript: { agentId: "sessions:codex:other", messages: [], total: 0, complete: true, live: true }, mode: "replace" });
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("main", 1), mode: "replace" });
  engine.emit("event", { type: "toast", text: "done", tone: "info" });
  for (const v of [console_, cli]) await until(() => v.of("toast").length === 1, "the toast at both clients");
  assert.deepEqual(console_.of("agent.transcript").map((m) => ((m as Extract<DaemonMessage, { type: "agent.transcript" }>).transcript as { agentId: string }).agentId), ["sessions:codex:abc"], "only the opened agent's page");
  assert.equal(console_.of("thread.transcript").length, 1, "and main's page — one client, two conversations");
  assert.equal(cli.of("agent.transcript").length, 0, "no agent page at the CLI");
  assert.equal(cli.of("thread.transcript").length, 0, "no thread page at the CLI");
  console_.client.close();
  cli.client.close();
  await server.close();
});

test("thread.open/close viewers are rewritten to <clientId>/<pane> (or /pane when the surface sent none) exactly as agent.open/close; a close ends the routing; a second pane on the same thread keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p1" } });
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p2" } });
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_spotify" } });
  app.client.sendJson({ type: "command", command: { type: "agent.open", agentId: "sessions:codex:abc" } });
  app.client.sendJson({ type: "command", command: { type: "thread.close", threadId: "t_slack", viewer: "p1" } });
  await until(() => engine.commands.length === 5, "five commands");
  assert.deepEqual(engine.commands, [
    { type: "thread.open", threadId: "t_slack", viewer: "c1/p1" },
    { type: "thread.open", threadId: "t_slack", viewer: "c1/p2" },
    { type: "thread.open", threadId: "t_spotify", viewer: "c1/pane" },
    { type: "agent.open", agentId: "sessions:codex:abc", viewer: "c1/pane" },
    { type: "thread.close", threadId: "t_slack", viewer: "c1/p1" },
  ], "the engine sees the viewer under this client's id, thread and agent alike");

  // p2 still shows Slack: its pages keep coming after p1 closed.
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 3), mode: "append" });
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_spotify", 3), mode: "append" });
  await until(() => app.of("thread.transcript").length === 2, "both pages (one pane each still open)");
  app.client.sendJson({ type: "command", command: { type: "thread.close", threadId: "t_slack", viewer: "p2" } });
  app.client.sendJson({ type: "command", command: { type: "thread.close", threadId: "t_spotify" } });
  await until(() => engine.commands.length === 7, "the last two closes");
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 4), mode: "append" });
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_spotify", 4), mode: "append" });
  engine.emit("event", { type: "agent.transcript", transcript: { agentId: "sessions:codex:abc", messages: [], total: 1, complete: false, live: true }, mode: "append" });
  await until(() => app.of("agent.transcript").length === 1, "the agent page still arrives (its pane is open)");
  assert.equal(app.of("thread.transcript").length, 2, "no thread page after the last pane closed");
  // A close for a pane that never opened is harmless (the engine refuses it in its own way).
  app.client.sendJson({ type: "command", command: { type: "thread.close", threadId: "t_never", viewer: "zz" } });
  await until(() => engine.commands.length === 8, "the stray close");
  assert.equal(server.clientCount, 1);
  app.client.close();
  await server.close();
});

test("a client that closed its socket is dropped: engine.dropViewers(clientId) is called once and no page is routed its way; the other viewer keeps receiving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const a = await viewer(path, 1);
  const b = await viewer(path, 2);
  a.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p1" } });
  b.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p1" } });
  await until(() => engine.commands.length === 2, "two opens");
  b.client.close();
  await until(() => server.clientCount === 1, "the second client gone");
  assert.deepEqual(engine.dropped, ["c2"], "the engine is told whose viewers left, once");
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 2), mode: "append" });
  await until(() => a.of("thread.transcript").length === 1, "the page at the surviving viewer");
  assert.equal(b.of("thread.transcript").length, 0, "nothing reached the closed client");
  a.client.close();
  await until(() => server.clientCount === 0, "everyone gone");
  assert.deepEqual(engine.dropped, ["c2", "c1"]);
  await server.close();
});

test("a re-open from the same pane never double-counts: opened twice, closed once, the thread's pages stop (the panes are a Set, as the engine's per-viewer set is)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  // The Console re-sends thread.open for the same pane on a reconnect and when its window comes back (ConversationPane's idiom).
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p1" } });
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p1" } });
  await until(() => engine.commands.length === 2, "both opens forwarded (the engine dedupes its own set)");
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 1), mode: "replace" });
  await until(() => app.of("thread.transcript").length === 1, "one page for two opens of one pane");
  app.client.sendJson({ type: "command", command: { type: "thread.close", threadId: "t_slack", viewer: "p1" } });
  await until(() => engine.commands.length === 3, "the one close");
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 2), mode: "append" });
  engine.emit("event", { type: "toast", text: "after the close", tone: "info" });
  await until(() => app.of("toast").length === 1, "the toast after the close");
  assert.equal(app.of("thread.transcript").length, 1, "one close ended the routing: the second open was the same pane, not a second viewer");
  app.client.close();
  await server.close();
});

test("tool.run with a minted thread id (newId(\"t\")) goes to engine.runnerFor; an unknown thread id is refused; the main brain's call has no thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const slack = "t_mp0z3k9pk3q9zx"; // newId("t"): a base36 time and six random chars
  engine.addThread(slack);
  const server = new DaemonServer(engine, path);
  await server.listen();
  const bridge = await viewer(path, 1);
  const results = () => bridge.of("tool.result") as Extract<DaemonMessage, { type: "tool.result" }>[];
  bridge.client.sendJson({ type: "tool.run", id: "t1", name: "click_element", input: { label: "Send" }, thread: slack });
  bridge.client.sendJson({ type: "tool.run", id: "t2", name: "frontmost_app", input: {}, thread: "t_mp0z3k9pgone00" });
  bridge.client.sendJson({ type: "tool.run", id: "t3", name: "frontmost_app", input: {} });
  await until(() => results().length === 3, "three tool results");
  const byId = new Map(results().map((r) => [r.id, r.result]));
  assert.deepEqual(byId.get("t1"), { kind: "text", text: `${slack} ran click_element` }, "the thread's own lane ran it");
  assert.match((byId.get("t2") as { message: string }).message, /^refused: no thread t_mp0z3k9pgone00 is running in Jarhead; frontmost_app was not run/);
  assert.equal(byId.get("t3")?.kind, "text");
  assert.deepEqual(engine.threadCalls, [{ thread: slack, name: "click_element", input: { label: "Send" } }]);
  assert.deepEqual(engine.toolCalls.map((c) => c.name), ["frontmost_app"], "the main runner saw only the main brain's call");
  bridge.client.close();
  await server.close();
});

test("a conversation page that names no thread or agent is routed nowhere and does not throw; a client that opened a thread literally named \"undefined\" does not receive it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "undefined", viewer: "p1" } });
  app.client.sendJson({ type: "command", command: { type: "thread.open", threadId: "t_slack", viewer: "p2" } });
  app.client.sendJson({ type: "command", command: { type: "agent.open", agentId: "undefined", viewer: "p3" } });
  await until(() => engine.commands.length === 3, "three opens");
  // An engine (or a fake) emitting a page without its id: `thread:${undefined}` must not spell a key.
  engine.emit("event", { type: "thread.transcript", transcript: { entries: [], total: 0, complete: true, live: true }, mode: "append" } as never);
  engine.emit("event", { type: "agent.transcript", transcript: { messages: [], total: 0, complete: true, live: true }, mode: "append" } as never);
  engine.emit("event", { type: "thread.transcript", transcript: { ...threadPage("t_slack", 1), threadId: "" }, mode: "append" });
  engine.emit("event", { type: "thread.transcript", transcript: threadPage("t_slack", 1), mode: "replace" });
  engine.emit("event", { type: "toast", text: "still serving", tone: "info" });
  await until(() => app.of("toast").length === 1, "the toast after the id-less pages");
  const pages = app.of("thread.transcript").map((m) => ((m as Extract<DaemonMessage, { type: "thread.transcript" }>).transcript as { threadId: string }).threadId);
  assert.deepEqual(pages, ["t_slack"], "only the page that names an opened thread arrived");
  assert.equal(app.of("agent.transcript").length, 0, "no agent page without an agent id");
  assert.equal(server.clientCount, 1, "the server kept serving");
  app.client.close();
  await server.close();
});

test("commands on the wire: all eight thread.* commands pass isEngineCommand and reach the engine as sent (viewer rewritten on open/close); a thread tool name and an unknown thread.* verb are malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  const sent = [
    { type: "thread.open", threadId: "t_slack", viewer: "p1" },
    { type: "thread.close", threadId: "t_slack", viewer: "p1" },
    { type: "thread.history", threadId: "t_slack", before: 120 },
    { type: "thread.stop", threadId: "t_slack" },
    { type: "thread.pause", threadId: "t_spotify" },
    { type: "thread.resume", threadId: "t_spotify" },
    { type: "thread.answer", threadId: "t_slack", yes: true },
    { type: "thread.say", threadId: "t_spotify", text: "skip this song" },
  ];
  for (const command of sent) app.client.sendJson({ type: "command", command });
  // thread_start is a brain tool; thread.nonsense is nobody's verb: neither is dispatched.
  app.client.sendJson({ type: "command", command: { type: "thread_start", name: "Slack" } as never });
  app.client.sendJson({ type: "command", command: { type: "thread.nonsense", threadId: "t_slack" } as never });
  await until(() => app.of("error").length === 2, "two malformed-command errors");
  assert.deepEqual(engine.commands, sent.map((c) => (c.type === "thread.open" || c.type === "thread.close" ? { ...c, viewer: "c1/p1" } : c)), "each of the eight arrives intact; open/close carry this client's viewer");
  assert.deepEqual(app.of("error"), [{ type: "error", message: "malformed command" }, { type: "error", message: "malformed command" }]);
  app.client.close();
  await server.close();
});

test("commands on the wire: mark.remove {id} and mark.window pass the allow-list and reach the engine as sent, beside mark.add and mark.clear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  // The overlay's stroke; the notch's × on one thumbnail; the notch's Window box; the notch's Clear.
  const sent = [
    { type: "mark.add", rect: { x: 10, y: 20, w: 100, h: 50 }, path: [{ x: 10, y: 20 }, { x: 110, y: 70 }] },
    { type: "mark.remove", id: "mark_pending" },
    { type: "mark.window" },
    { type: "mark.clear" },
  ];
  for (const command of sent) app.client.sendJson({ type: "command", command });
  await until(() => engine.commands.length === sent.length, "four mark commands at the engine");
  assert.deepEqual(engine.commands, sent, "each arrives intact: the id on mark.remove, nothing added to mark.window");
  assert.deepEqual(app.of("error"), [], "none is refused");
  app.client.close();
  await server.close();
});

test("mark.remove without id is refused as malformed and never dispatched; an empty or non-string id is the same refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  app.client.sendJson({ type: "command", command: { type: "mark.remove" } as never });
  app.client.sendJson({ type: "command", command: { type: "mark.remove", id: "" } as never });
  app.client.sendJson({ type: "command", command: { type: "mark.remove", id: 7 } as never });
  // A well-formed one behind them still lands, so the refusals are per command, not per client.
  app.client.sendJson({ type: "command", command: { type: "mark.remove", id: "mark_pending" } });
  await until(() => app.of("error").length === 3 && engine.commands.length === 1, "three refusals and one dispatch");
  assert.deepEqual(app.of("error"), [{ type: "error", message: "malformed command" }, { type: "error", message: "malformed command" }, { type: "error", message: "malformed command" }]);
  assert.deepEqual(engine.commands, [{ type: "mark.remove", id: "mark_pending" }], "only the one with an id reached the engine");
  app.client.close();
  await server.close();
});

test("mark.delete is refused: not a verb on the wire, never dispatched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  app.client.sendJson({ type: "command", command: { type: "mark.delete", id: "mark_pending" } as never });
  await until(() => app.of("error").length === 1, "the malformed-command error");
  assert.deepEqual(app.of("error"), [{ type: "error", message: "malformed command" }]);
  assert.deepEqual(engine.commands, [], "nothing reached the engine");
  app.client.close();
  await server.close();
});

// ----------------------------------------------------------------- automations (design11): the twelve verbs, the signal, the three events

test("commands on the wire: all twelve automation.* / recipe.* verbs pass isEngineCommand and reach the engine as sent; automation.delete is refused — not a verb on the wire, never dispatched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = await viewer(path, 1);
  const sent = [
    { type: "automation.set", automation: { name: "Wake up", when: { kind: "at", at: 1 }, then: [{ kind: "chime", line: "Wake up" }], clauses: { quiet: "override" }, echo: "At 07:10, ring." } },
    { type: "automation.snooze", id: "auto_1", minutes: 10 },
    { type: "automation.done", id: "auto_1" },
    { type: "automation.skip", id: "auto_1" },
    { type: "automation.pause", id: "auto_1" },
    { type: "automation.resume", id: "auto_1" },
    { type: "automation.rename", id: "auto_1", name: "Wake up, Kevin" },
    { type: "automation.trash", id: "auto_1" },
    { type: "automation.restore", id: "auto_1" },
    { type: "automation.run", id: "auto_1" },
    { type: "recipe.set", recipe: { name: "backup", command: "echo hi", timeoutSeconds: 5, approvedAt: 1 } },
    { type: "recipe.trash", name: "backup" },
  ];
  for (const command of sent) app.client.sendJson({ type: "command", command });
  // The deletion verb is spelt at run time so the acceptance grep over the sources stays at zero.
  app.client.sendJson({ type: "command", command: { type: ["automation", "delete"].join("."), id: "auto_1" } as never });
  await until(() => app.of("error").length === 1 && engine.commands.length === sent.length, "twelve dispatched, one refused");
  assert.deepEqual(engine.commands, sent, "each verb arrives intact");
  assert.deepEqual(app.of("error"), [{ type: "error", message: "malformed command" }]);
  app.client.close();
  await server.close();
});

test("system.signal parses as a ClientMessage and reaches engine.systemSignal as data with its `at`; a signal without a body is dropped; the app's hello counts as a viewer and the CLI's does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const app = new DaemonClient(path);
  await app.connect({ pid: 1, audio: true });
  const cli = await viewer(path, 2);
  app.sendJson({ type: "system.signal", signal: { kind: "app.quit", app: "Slack", bundleId: "com.tinyspeck.slackmacgap" }, at: 1_757_500_000_000 });
  app.sendJson({ type: "system.signal", signal: { kind: "mac.wake" }, at: 1_757_500_001_000 });
  app.sendJson({ type: "system.signal", at: 5 } as never);
  await until(() => engine.signals.length === 2, "two signals");
  assert.deepEqual(engine.signals, [
    { signal: { kind: "app.quit", app: "Slack", bundleId: "com.tinyspeck.slackmacgap" }, at: 1_757_500_000_000 },
    { signal: { kind: "mac.wake" }, at: 1_757_500_001_000 },
  ]);
  assert.deepEqual(engine.commands, [], "a signal is never a command");
  assert.equal(engine.viewers.at(-1), 1, "the app (audio hello) is the one viewer; the CLI client is not");
  app.close();
  await until(() => engine.viewers.at(-1) === 0, "the viewer left");
  cli.client.close();
  await server.close();
});

test("the three automation events broadcast to every client like toast: automation.event, local.say and notify pass through with their fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  await server.listen();
  const a = await viewer(path, 1);
  const b = await viewer(path, 2);
  const event = { seq: 1, at: 2, id: "auto_1", kind: "state", state: "snoozed", nextAt: 3 };
  engine.emit("event", { type: "automation.event", event });
  engine.emit("event", { type: "local.say", text: "call mum", sound: "Glass", automationId: "auto_1" });
  engine.emit("event", { type: "local.say", sound: "Hero", automationId: "auto_2" });
  engine.emit("event", { type: "notify", id: "ntf_1", title: "07:10 · Wake up", presses: [{ kind: "snooze", minutes: 10 }, { kind: "done" }], automationId: "auto_2" });
  await until(() => a.of("notify").length === 1 && b.of("notify").length === 1, "both clients got the banner");
  for (const c of [a, b]) {
    assert.deepEqual(c.of("automation.event"), [{ type: "automation.event", event }]);
    assert.deepEqual(c.of("local.say"), [
      { type: "local.say", text: "call mum", sound: "Glass", automationId: "auto_1" },
      { type: "local.say", sound: "Hero", automationId: "auto_2" },
    ]);
    assert.deepEqual(c.of("notify"), [{ type: "notify", id: "ntf_1", title: "07:10 · Wake up", presses: [{ kind: "snooze", minutes: 10 }, { kind: "done" }], automationId: "auto_2" }]);
  }
  a.client.close();
  b.client.close();
  await server.close();
});

// ----------------------------------------------------------------- the lifeline: bye vs. no bye

/** A Lifeline with a short window and every decision recorded. */
function lifeline(clients: { n: number }, lingerMs = 40) {
  const log: string[] = [];
  const ended: string[] = [];
  const l = new Lifeline({ lingerMs, byeWindowMs: 10_000, clientCount: () => clients.n, shutdown: (why) => ended.push(why), log: (line) => log.push(line) });
  return { l, log, ended };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("lifeline: a bye then stdin closing is a clean quit — shutdown at once, no linger", async () => {
  const clients = { n: 1 };
  const { l, log, ended } = lifeline(clients);
  l.bye();
  assert.equal(ended.length, 0, "the bye alone does nothing while stdin is open");
  clients.n = 0;
  l.stdinClosed();
  assert.deepEqual(ended, ["stdin closed"]);
  assert.equal(l.lingering, false);
  assert.ok(!log.some((s) => /lingering/.test(s)), "no linger line on a clean quit");
});

test("lifeline: stdin closing without a bye is a crash — linger, then exit when nobody comes back", async () => {
  const clients = { n: 0 };
  const { l, log, ended } = lifeline(clients, 40);
  let orphaned = 0;
  const l2 = new Lifeline({ lingerMs: 40, clientCount: () => clients.n, shutdown: (why) => ended.push(why), log: (line) => log.push(line), onOrphaned: () => orphaned++ });
  l.dispose();
  l2.stdinClosed();
  assert.equal(orphaned, 1, "the host is told once to re-home its output");
  assert.equal(l2.lingering, true);
  assert.match(log[0]!, /^app went away without a bye; lingering 0 s for a relaunch$/);
  assert.equal(ended.length, 0, "still up inside the window");
  await tick(80);
  assert.deepEqual(ended, ["nobody came back in 0 s"]);
  assert.equal(l2.lingering, false);
  l2.stdinClosed();
  l2.bye();
  assert.equal(ended.length, 1, "nothing fires twice after the end");
});

test("lifeline: a client attaching during the linger keeps the daemon; its bye is the quit; leaving without one lingers again", async () => {
  const clients = { n: 0 };
  const { l, log, ended } = lifeline(clients, 40);
  l.stdinClosed();
  clients.n = 1;
  l.clientJoined();
  assert.equal(l.lingering, false, "the relaunched app cancelled the timer");
  await tick(80);
  assert.equal(ended.length, 0, "adopted: the window passing changes nothing");
  // A status check comes and goes: the count is back to zero without a bye → a fresh window.
  clients.n = 0;
  l.clientLeft();
  assert.equal(l.lingering, true);
  assert.match(log.at(-1)!, /the last client left an orphaned daemon; lingering/);
  clients.n = 1;
  l.clientJoined();
  // The adopting app quits cleanly: its stdin cannot close (it never held ours), so the bye is the quit.
  l.bye();
  assert.deepEqual(ended, ["bye from the app that adopted us"]);
});

test("lifeline: a client still attached when the window ends means staying up; a stale bye does not count", async () => {
  const clients = { n: 0 };
  const now = { t: 1_000_000 };
  const log: string[] = [];
  const ended: string[] = [];
  const l = new Lifeline({ lingerMs: 30, byeWindowMs: 1000, clientCount: () => clients.n, shutdown: (why) => ended.push(why), log: (line) => log.push(line), now: () => now.t });
  l.bye();
  now.t += 5000; // the bye was five seconds ago: not this quit's
  l.stdinClosed();
  assert.equal(l.lingering, true, "an old bye does not make the EOF a clean quit");
  clients.n = 1; // someone attached through the socket probe but the join event was missed: the count still decides
  await tick(60);
  assert.equal(ended.length, 0);
  assert.match(log.at(-1)!, /a client is attached; staying up/);
  l.dispose();
});

test("bye reaches the server as an event and is acknowledged to that client only; every join and leave carries the client count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-sock-"));
  const path = join(dir, "d.sock");
  const engine = new FakeEngine();
  const server = new DaemonServer(engine, path);
  const events: string[] = [];
  server.on("bye", () => events.push("bye"));
  server.on("join", (n) => events.push(`join ${n}`));
  server.on("leave", (n) => events.push(`leave ${n}`));
  await server.listen();
  const app = new DaemonClient(path);
  const appGot: string[] = [];
  app.on("message", (m) => appGot.push(m.type));
  await app.connect({ pid: 1, audio: true });
  const probe = new DaemonClient(path);
  const probeGot: string[] = [];
  probe.on("message", (m) => probeGot.push(m.type));
  await probe.connect({ pid: 2 });
  await tick(30);
  app.sendJson({ type: "bye" });
  await tick(30);
  // The ack: the app closes only once it has read this (DaemonProcess.sendBye).
  assert.deepEqual(appGot, ["hello", "snapshot", "bye"]);
  assert.deepEqual(probeGot, ["hello", "snapshot"], "the ack goes to the client that said bye, nobody else");
  probe.close();
  await tick(30);
  app.close();
  await tick(30);
  assert.deepEqual(events, ["join 1", "join 2", "bye", "leave 1", "leave 0"]);
  assert.deepEqual(engine.commands, [], "a bye is not an engine command");
  await server.close();
});
