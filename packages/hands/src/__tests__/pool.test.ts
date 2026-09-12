import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { SECRET_KEYS } from "@jarhead/protocol";
import { HandsPool } from "../pool.ts";
import { NativeRequestError, TYPE_CANCEL_SIGNAL } from "../native.ts";

/**
 * Two helpers, one binary: both spawned without Jarhead's keys; a cut cancels the
 * pendings of both and signals only the child that is typing; a grant restart
 * restarts both; stop stops both; a stale child's late exit orphans nothing.
 */

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  seen: { id: string; op: string }[] = [];
  killed = 0;
  constructor(readonly pid: number) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) this.seen.push(JSON.parse(line) as { id: string; op: string });
    });
    setImmediate(() => this.emit("spawn"));
  }
  kill(): boolean {
    this.killed += 1;
    this.exitCode = 0;
    return true;
  }
}

async function until(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`${what} did not happen within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function binPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jh-pool-"));
  const bin = join(dir, "hands");
  writeFileSync(bin, "#!/bin/sh\n"); // exists so `available` is true; never run
  return bin;
}

test("both helpers are spawned from an environment without any SECRET_KEYS name (the rest of the daemon's env stays)", async () => {
  const spawns: { child: FakeChild; env: NodeJS.ProcessEnv | undefined }[] = [];
  const spawnImpl = ((_bin: string, _args: string[], opts: SpawnOptions) => {
    const child = new FakeChild(0);
    spawns.push({ child, env: opts.env });
    return child as unknown as ChildProcess;
  }) as never;
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/kevin", JARHEAD_HANDS_DEBUG: "0" };
  for (const key of SECRET_KEYS) env[key] = `sk-${key}`;
  const pool = new HandsPool({ binPath: binPath(), spawnImpl, env });
  const a = pool.focus.request("cursor");
  const b = pool.background.request("frontmost");
  // The client resolves its spawn on a later tick: wait for the requests to reach the children, not for the spawn call.
  await until(() => spawns.length === 2 && spawns.every((s) => s.child.seen.length === 1), "two spawns, one request each");
  for (const { env: spawned } of spawns) {
    assert.ok(spawned, "spawn got an env");
    for (const key of SECRET_KEYS) assert.equal(spawned![key], undefined, `${key} stripped`);
    assert.equal(spawned!["PATH"], "/usr/bin");
    assert.equal(spawned!["HOME"], "/Users/kevin");
    assert.equal(spawned!["JARHEAD_HANDS_DEBUG"], "0");
  }
  assert.notEqual(spawns[0]!.child, spawns[1]!.child, "two processes");
  assert.equal(pool.cancelAll("done"), 2);
  await assert.rejects(a, /cancelled/);
  await assert.rejects(b, /cancelled/);
  pool.stop();
  assert.equal(spawns[0]!.child.killed, 1);
  assert.equal(spawns[1]!.child.killed, 1);
});

test("cancelAll fails every pending on both helpers and sends SIGURG only to the child with a `type` in flight (this process stands in for that child)", async () => {
  const signals: NodeJS.Signals[] = [];
  const onUrg = (): void => {
    signals.push(TYPE_CANCEL_SIGNAL);
  };
  process.on(TYPE_CANCEL_SIGNAL, onUrg);
  try {
    // The focus child has this process's pid (a signal to it is observable); the background child pid 0 — the client never signals pid ≤ 0.
    const focusChild = new FakeChild(process.pid);
    const bgChild = new FakeChild(0);
    const pool = new HandsPool({ binPath: binPath(), spawnImpl: (() => focusChild) as never, background: { spawnImpl: (() => bgChild) as never } });

    // A type on focus, a tree read on background: the cut drops both, the signal goes once (to focus).
    const typing = pool.focus.request("type", { text: "hello" });
    const tree = pool.background.request("ax_tree", { summary: true });
    await until(() => focusChild.seen.length === 1 && bgChild.seen.length === 1, "both requests written");
    assert.equal(pool.pendingCount, 2);
    assert.equal(pool.cancelAll("Kevin pressed stop"), 2);
    assert.equal(pool.pendingCount, 0);
    await assert.rejects(typing, (e: unknown) => e instanceof NativeRequestError && e.detail.code === "cancelled");
    await assert.rejects(tree, (e: unknown) => e instanceof NativeRequestError && e.detail.code === "cancelled");
    await until(() => signals.length >= 1, "the SIGURG", 1000);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(signals, [TYPE_CANCEL_SIGNAL], "one signal, for the one typing child");

    // Nothing typing anywhere: no signal at all.
    signals.length = 0;
    const click = pool.focus.request("click", { x: 1, y: 1 });
    const front = pool.background.request("frontmost");
    await until(() => focusChild.seen.length === 2 && bgChild.seen.length === 2, "both written");
    assert.equal(pool.cancelAll(), 2);
    await assert.rejects(click, /cancelled/);
    await assert.rejects(front, /cancelled/);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(signals, [], "a click that went out has landed; nothing to signal");

    // Late answers for the cancelled ids are dropped; both helpers stay usable.
    focusChild.stdout.write(`${JSON.stringify({ id: focusChild.seen[0]!.id, ok: true, result: { characters: 2, cancelled: true } })}\n`);
    bgChild.stdout.write(`${JSON.stringify({ id: bgChild.seen[0]!.id, ok: true, result: { count: 3 } })}\n`);
    const cursor = pool.focus.request<{ x: number }>("cursor");
    const windows = pool.background.request<{ windows: unknown[] }>("windows");
    await until(() => focusChild.seen.length === 3 && bgChild.seen.length === 3, "next requests");
    focusChild.stdout.write(`${JSON.stringify({ id: focusChild.seen[2]!.id, ok: true, result: { x: 9 } })}\n`);
    bgChild.stdout.write(`${JSON.stringify({ id: bgChild.seen[2]!.id, ok: true, result: { windows: [] } })}\n`);
    assert.deepEqual(await cursor, { x: 9 });
    assert.deepEqual(await windows, { windows: [] });
    pool.stop();
  } finally {
    process.off(TYPE_CANCEL_SIGNAL, onUrg);
  }
});

test("restartAll restarts both helpers (a grant is per process); a stale child's late exit does not orphan its successor; stop stops both", async () => {
  const focusChildren: FakeChild[] = [];
  const bgChildren: FakeChild[] = [];
  const pool = new HandsPool({
    binPath: binPath(),
    spawnImpl: (() => {
      const c = new FakeChild(0);
      focusChildren.push(c);
      return c;
    }) as never,
    background: {
      spawnImpl: (() => {
        const c = new FakeChild(0);
        bgChildren.push(c);
        return c;
      }) as never,
    },
  });
  const a = pool.focus.request("cursor");
  const b = pool.background.request("frontmost");
  await until(() => focusChildren[0]?.seen.length === 1 && bgChildren[0]?.seen.length === 1, "first requests written");
  assert.ok(pool.ready);
  // The restart fails both pendings on its first tick; the handlers go on before it, or node reports them unhandled.
  const aFailed = assert.rejects(a, /stopped/);
  const bFailed = assert.rejects(b, /stopped/);
  await pool.restartAll();
  assert.equal(focusChildren.length, 2, "focus respawned");
  assert.equal(bgChildren.length, 2, "background respawned");
  await aFailed;
  await bFailed;
  assert.equal(focusChildren[0]!.killed, 1);
  assert.equal(bgChildren[0]!.killed, 1);
  assert.ok(pool.focus.ready && pool.background.ready, "both new children running");

  // The old children exit late: the new ones stay in their slots.
  focusChildren[0]!.emit("exit", 0, null);
  bgChildren[0]!.emit("exit", 0, null);
  assert.ok(pool.focus.ready && pool.background.ready, "a stale exit clears nothing");
  const c = pool.focus.request<{ x: number }>("cursor");
  await until(() => focusChildren[1]!.seen.length === 1, "request on the new child");
  focusChildren[1]!.stdout.write(`${JSON.stringify({ id: focusChildren[1]!.seen[0]!.id, ok: true, result: { x: 3 } })}\n`);
  assert.deepEqual(await c, { x: 3 });

  pool.stop();
  assert.ok(!pool.ready);
  assert.equal(focusChildren[1]!.killed, 1);
  assert.equal(bgChildren[1]!.killed, 1);
  assert.equal(pool.pendingCount, 0);
});
