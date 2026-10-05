import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_LOCK_FILE, DaemonLockHeld, DaemonServer, SocketInUseError, acquireDaemonLock, probeSocket, type ToolHost } from "../server.ts";
import { DaemonClient } from "../client.ts";
import { shouldAutoWake } from "../main.ts";
import { settle, until, world } from "../../../engine/src/__tests__/world.ts";

// W1-10: one daemon per socket and per state dir (APP-4, F-CODEX-SOCKET server half), a
// session nobody can hear does not keep billing (V7), and the auto-wake rule is a pure
// function (WG-12, the daemon half).

class MiniEngine extends EventEmitter {
  constructor(readonly name: string) {
    super();
  }
  commands: unknown[] = [];
  ledger = { read: () => [], days: () => [], sessions: () => [], readSession: () => [], search: () => [], readChain: () => ({ rows: [], truncated: false }) };
  memory = { list: () => [], search: async () => [] };
  config = { stateDir: "/tmp/none" };
  runner = { run: async () => ({ result: { kind: "text" as const, text: "" } }) };
  runnerFor(): undefined {
    return undefined;
  }
  snapshot(): unknown {
    return { phase: "asleep", engine: this.name };
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
  dropViewers(): void {}
}

function socketDir(): string {
  return mkdtempSync(join(tmpdir(), "jh-one-"));
}

/** "connected" when something accepts on the path, else the error code. */
function reach(path: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.once("error", (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? e.message}`));
  });
}

test("APP-4: a second daemon on a live daemon's socket path is refused; the first keeps its clients and new clients reach the first", async () => {
  const path = join(socketDir(), "d.sock");
  const first = new MiniEngine("first");
  const second = new MiniEngine("second");
  const a = new DaemonServer(first as never, path);
  await a.listen();
  const app = new DaemonClient(path);
  await app.connect({ pid: 1, audio: true });
  const b = new DaemonServer(second as never, path);
  let refused: Error | undefined;
  try {
    await b.listen();
  } catch (e) {
    refused = e as Error;
  }
  const cli = new DaemonClient(path);
  const cliSaw: { type: string; snapshot?: { engine?: string } }[] = [];
  cli.on("message", (m) => cliSaw.push(m as never));
  await cli.connect({ pid: 2 });
  await settle(50);
  app.sendJson({ type: "command", command: { type: "go" } });
  cli.sendJson({ type: "command", command: { type: "go" } });
  await settle(50);
  try {
    assert.ok(refused, "the second listen() must refuse a socket a live daemon answers on");
    assert.ok(refused instanceof SocketInUseError);
    assert.match(refused.message, /another Jarhead daemon answers on/);
    assert.equal(cliSaw.find((m) => m.type === "snapshot")?.snapshot?.engine, "first", "a new client reaches the daemon that was already running");
    assert.equal(first.commands.length, 2, "both clients' commands reach the first engine");
    assert.equal(second.commands.length, 0);
  } finally {
    app.close();
    cli.close();
    await b.close();
    await a.close();
  }
});

test("APP-4: close() unlinks only the socket it owns; a server whose path was taken over leaves the new socket answering", async () => {
  const path = join(socketDir(), "d.sock");
  const a = new DaemonServer(new MiniEngine("first") as never, path);
  await a.listen();
  // Something removed the first daemon's socket file (a hand, an older build) and a second daemon bound the path.
  unlinkSync(path);
  const b = new DaemonServer(new MiniEngine("second") as never, path);
  await b.listen();
  try {
    await a.close();
    assert.ok(existsSync(path), "the first server's close removed the second server's socket file");
    assert.equal(await reach(path), "connected", "the second server still answers on the path");
  } finally {
    await b.close();
  }
  assert.equal(existsSync(path), false, "the owner's close removes its own socket file");
});

test("V7: the app's socket closes without a bye while a session is open: the session is paused (closed, the conversation held), not left billing", async () => {
  const w = world();
  const { engine } = w;
  const path = join(socketDir(), "d.sock");
  const server = new DaemonServer(engine as never, path);
  await server.listen();
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    const app = new DaemonClient(path);
    await app.connect({ pid: 999_999, audio: true });
    app.sendJson({ type: "command", command: { type: "go" } });
    assert.ok(await until(() => engine.transportState === "awake"), "the session opened");
    // The app dies: its socket closes with no bye.
    app.close();
    assert.ok(await until(() => engine.transportState !== "awake", 1000), `a session nobody can hear must not keep billing through the linger (transport ${engine.transportState})`);
    assert.equal(engine.transportState, "paused", "paused: the meter stops and the relaunched app can resume the conversation");
  } finally {
    await server.close();
    await engine.stop();
  }
});

test("a socket file nobody listens on (a daemon that was SIGKILLed) is stale: it is removed and the path bound; probeSocket tells the three cases apart", async () => {
  const path = join(socketDir(), "d.sock");
  assert.deepEqual(await probeSocket(path), { state: "absent" });
  // A daemon killed with SIGKILL leaves its socket file behind.
  const r = spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.equal(r.signal, "SIGKILL");
  assert.ok(existsSync(path), "the killed listener left its socket file");
  assert.deepEqual(await probeSocket(path), { state: "stale" });
  const server = new DaemonServer(new MiniEngine("next") as never, path);
  await server.listen();
  try {
    assert.deepEqual(await probeSocket(path), { state: "answers" });
    const cli = new DaemonClient(path);
    const saw: { type: string; snapshot?: { engine?: string } }[] = [];
    cli.on("message", (m) => saw.push(m as never));
    await cli.connect();
    assert.ok(await until(() => saw.some((m) => m.type === "snapshot")));
    assert.equal(saw.find((m) => m.type === "snapshot")?.snapshot?.engine, "next");
    cli.close();
  } finally {
    await server.close();
  }
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirNames(path), [], "no private staging name is left beside the socket");
});

function readdirNames(path: string): string[] {
  return readdirSync(dirname(path));
}

test("F-CODEX-SOCKET (server half): a second brain's private tool server on a path the first answers on is refused; the first keeps serving and its socket stays", async () => {
  const path = join(socketDir(), "codex-tools.sock");
  const host = (tag: string): ToolHost => ({ runner: { attached: true, run: async () => ({ result: { kind: "text", text: tag } }) }, runnerFor: () => undefined, userName: undefined });
  const main = new DaemonServer(host("main"), path);
  await main.listen();
  const spare = new DaemonServer(host("spare"), path);
  await assert.rejects(spare.listen(), SocketInUseError);
  await spare.close();
  assert.ok(existsSync(path), "the refused server's close removed nothing");
  const cli = new DaemonClient(path);
  const results: { type: string; result?: { text?: string } }[] = [];
  cli.on("message", (m) => results.push(m as never));
  await cli.connect();
  cli.sendJson({ type: "tool.run", id: "1", name: "frontmost_app", input: {} });
  try {
    assert.ok(await until(() => results.some((m) => m.type === "tool.result")));
    assert.equal(results.find((m) => m.type === "tool.result")?.result?.text, "main", "the call ran in the brain that owns the socket");
  } finally {
    cli.close();
    await main.close();
  }
});

test("the state dir lock: one holder; a second open (this process or another) is refused naming the holder's pid; released, it can be taken again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-lock-"));
  const lock = acquireDaemonLock(dir);
  try {
    assert.equal(lock.path, join(dir, DAEMON_LOCK_FILE));
    assert.equal(readFileSync(lock.path, "utf8").trim(), String(process.pid), "the lock file names its holder");
    assert.throws(
      () => acquireDaemonLock(dir),
      (e: unknown) => e instanceof DaemonLockHeld && e.holder === process.pid && /another Jarhead daemon \(pid \d+\) holds/.test(e.message),
    );
    // Another process (a second jarheadd) is refused too.
    const other = await childTakesLock(dir);
    assert.equal(other, `refused ${process.pid}`);
  } finally {
    lock.release();
  }
  assert.equal(readFileSync(join(dir, DAEMON_LOCK_FILE), "utf8"), "", "a released lock names nobody");
  assert.equal(await childTakesLock(dir), "taken");
  // The child's lock died with it: the kernel drops a flock when its holder exits, however it exits.
  const again = acquireDaemonLock(dir);
  again.release();
});

/** A fresh node process tries the lock: "taken", or "refused <holder pid>". */
function childTakesLock(dir: string): Promise<string> {
  const server = new URL("../server.ts", import.meta.url).href;
  const code = `const m = await import(${JSON.stringify(server)}); try { m.acquireDaemonLock(${JSON.stringify(dir)}); console.log("taken"); } catch (e) { console.log(e instanceof m.DaemonLockHeld ? "refused " + e.holder : "error " + e.message); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").pop() ?? ""));
  });
}

/** A fake engine with an open session: records the commands the server sends it. */
class SessionEngine extends MiniEngine {
  session: unknown = { id: "sess_1" };
  override snapshot(): unknown {
    return { phase: "listening", session: this.session };
  }
}

test("V7 (server): only the last app leaving without a bye, with a session open, pauses; a bye, a CLI client leaving, a second app still attached or no session leave the engine alone", async () => {
  const path = join(socketDir(), "d.sock");
  const engine = new SessionEngine("e");
  const server = new DaemonServer(engine as never, path);
  await server.listen();
  const pauses = (): number => engine.commands.filter((c) => (c as { type?: string }).type === "pause").length;
  try {
    // A CLI client (no audio) comes and goes: nothing.
    const cli = new DaemonClient(path);
    await cli.connect({ pid: 2 });
    await settle(30);
    cli.close();
    await settle(50);
    assert.equal(pauses(), 0, "a CLI client is not the app");

    // The app quits cleanly: bye, then its socket closes. Nothing.
    const quitting = new DaemonClient(path);
    await quitting.connect({ pid: 3, audio: true });
    quitting.sendJson({ type: "bye" });
    await settle(50);
    quitting.close();
    await settle(50);
    assert.equal(pauses(), 0, "a clean quit already stopped the session itself");

    // Two apps attached; one crashes: the other still hears the session.
    const a = new DaemonClient(path);
    const b = new DaemonClient(path);
    await a.connect({ pid: 4, audio: true });
    await b.connect({ pid: 5, audio: true });
    await settle(30);
    a.close();
    await settle(50);
    assert.equal(pauses(), 0, "another app is still attached");
    // The last app crashes: pause.
    b.close();
    assert.ok(await until(() => pauses() === 1, 1000), "the last app leaving without a bye pauses the open session");

    // Asleep (no session): an app crash sends nothing.
    engine.session = undefined;
    const c = new DaemonClient(path);
    await c.connect({ pid: 6, audio: true });
    await settle(30);
    c.close();
    await settle(50);
    assert.equal(pauses(), 1, "nothing to pause while asleep");
  } finally {
    await server.close();
  }
});

test("WG-12: shouldAutoWake: the wake word gate, the env knob, --no-wake and the setting each keep the daemon from opening a session at start", () => {
  const on = { autoWake: true, wake: { enabled: false } };
  const rows: [string, { autoWake: boolean; wake: { enabled: boolean } }, Record<string, string | undefined>, string[], boolean][] = [
    ["everything permits it", on, {}, [], true],
    ["JARHEAD_AUTO_WAKE unset or 1", on, { JARHEAD_AUTO_WAKE: "1" }, [], true],
    ["the wake word gate is on", { autoWake: true, wake: { enabled: true } }, {}, [], false],
    ["the gate is on, whatever the env says", { autoWake: true, wake: { enabled: true } }, { JARHEAD_AUTO_WAKE: "1" }, [], false],
    ["JARHEAD_AUTO_WAKE=0", on, { JARHEAD_AUTO_WAKE: "0" }, [], false],
    ["--no-wake", on, {}, ["--socket", "/tmp/x.sock", "--no-wake"], false],
    ["settings.autoWake is off", { autoWake: false, wake: { enabled: false } }, {}, [], false],
  ];
  for (const [why, settings, env, args, want] of rows) assert.equal(shouldAutoWake(settings, env, args), want, why);
});

test("a file at the socket path that is not a socket is never deleted: listen() refuses it with a line that says so", async () => {
  const path = join(socketDir(), "d.sock");
  writeFileSync(path, "Kevin's notes\n");
  const server = new DaemonServer(new MiniEngine("x") as never, path);
  await assert.rejects(server.listen(), /cannot take .* \(ENOTSOCK\): something other than a Jarhead socket is there/);
  await server.close();
  assert.equal(readFileSync(path, "utf8"), "Kevin's notes\n");
});

/** jarheadd itself, as the app runs it (`node --import tsx main.ts --socket p`), on a scratch state dir: its exit code and stderr. */
function runDaemon(stateDir: string, socketPath: string): Promise<{ code: number | null; stderr: string }> {
  const main = new URL("../main.ts", import.meta.url).pathname;
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, JARHEAD_STATE_DIR: stateDir, JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1" };
    delete env["JARHEAD_SOCKET"];
    const child = spawn(process.execPath, ["--import", "tsx", main, "--socket", socketPath], { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

test("jarheadd on a state dir another daemon holds: exits 73 before building an engine, with one line naming the holder", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-held-"));
  const lock = acquireDaemonLock(stateDir);
  try {
    const { code, stderr } = await runDaemon(stateDir, join(socketDir(), "d.sock"));
    assert.equal(code, 73, stderr);
    assert.match(stderr, new RegExp(`jarheadd: another Jarhead daemon \\(pid ${process.pid}\\) holds .*jarheadd\\.lock; not starting a second daemon on the same state`));
    assert.equal(existsSync(join(stateDir, "ledger")), false, "nothing was built on the held state dir");
  } finally {
    lock.release();
  }
});

test("jarheadd on a socket another daemon answers: exits 73 with one line, leaves that daemon serving and its own state dir unlocked", async () => {
  const path = join(socketDir(), "d.sock");
  const first = new MiniEngine("first");
  const server = new DaemonServer(first as never, path);
  await server.listen();
  const stateDir = mkdtempSync(join(tmpdir(), "jh-free-"));
  try {
    const { code, stderr } = await runDaemon(stateDir, path);
    assert.equal(code, 73, stderr);
    assert.match(stderr, /jarheadd: another Jarhead daemon answers on .*d\.sock; not taking it from that daemon/);
    assert.deepEqual(await probeSocket(path), { state: "answers" }, "the first daemon still serves its socket");
    const again = acquireDaemonLock(stateDir);
    again.release();
  } finally {
    await server.close();
  }
});
