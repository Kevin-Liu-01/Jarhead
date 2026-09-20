import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { SECRET_KEYS } from "@jarhead/protocol";
import { NativeHandsProcess, NativeRequestError, scrubHandsEnv } from "../native.ts";

/**
 * The resident helper client: a request in flight can be dropped by a stop
 * (cancelPending), after which the helper's late answer — the same id — is
 * ignored, and the next request works as before.
 */

/** A stand-in child: requests land in `seen`; the test answers them by hand. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  seen: { id: string; op: string }[] = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) this.seen.push(JSON.parse(line) as { id: string; op: string });
    });
    setImmediate(() => this.emit("spawn"));
  }
  answer(id: string, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  }
  kill(): boolean {
    this.exitCode = 0;
    return true;
  }
}

/** Wait until the fake child has seen `n` requests (bounded), instead of a fixed sleep that a loaded machine breaks. */
async function seen(child: FakeChild, n: number, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (child.seen.length < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`only ${child.seen.length} of ${n} requests reached the helper within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test("cancelPending fails the requests in flight with `cancelled`, drops their late answers, and leaves the helper usable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-hands-"));
  const bin = join(dir, "hands");
  writeFileSync(bin, "#!/bin/sh\n"); // must exist; never run
  const child = new FakeChild();
  const hands = new NativeHandsProcess({ binPath: bin, spawnImpl: (() => child as unknown as ChildProcess) as never });

  const click = hands.request("click", { x: 1, y: 2 });
  const move = hands.request("move", { x: 3, y: 4 });
  await seen(child, 2);
  assert.deepEqual(child.seen.map((s) => s.op).sort(), ["click", "move"]);
  assert.equal(hands.pendingCount, 2);

  assert.equal(hands.cancelPending("Kevin pressed stop"), 2);
  assert.equal(hands.pendingCount, 0);
  for (const p of [click, move]) {
    await assert.rejects(p, (e: unknown) => e instanceof NativeRequestError && e.detail.code === "cancelled" && /Kevin pressed stop/.test(e.detail.message));
  }
  // The helper's late answers for those ids are ignored, not delivered to anyone.
  child.answer(child.seen[0]!.id, { late: true });
  child.answer(child.seen[1]!.id, { late: true });
  await new Promise((r) => setTimeout(r, 10));

  // The next request goes through as before, on the same helper.
  const next = hands.request<{ x: number }>("cursor", {});
  await seen(child, 3);
  assert.equal(child.seen.length, 3);
  child.answer(child.seen[2]!.id, { x: 5 });
  assert.deepEqual(await next, { x: 5 });
  assert.equal(hands.cancelPending(), 0, "nothing in flight: nothing dropped");
  hands.stop();
});

test("the helper is spawned without any SECRET_KEYS name in its environment — from the option's env or the process's — and everything else is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-hands-"));
  const bin = join(dir, "hands");
  writeFileSync(bin, "#!/bin/sh\n");
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const child = new FakeChild();
  const spawnImpl = ((_bin: string, _args: string[], opts: SpawnOptions) => {
    envs.push(opts.env);
    return child as unknown as ChildProcess;
  }) as never;
  const given: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", JARHEAD_HANDS_BIN: bin };
  for (const key of SECRET_KEYS) given[key] = "sk-live-secret";
  const hands = new NativeHandsProcess({ binPath: bin, spawnImpl, env: given });
  const req = hands.request("cursor");
  await seen(child, 1);
  assert.equal(envs.length, 1);
  for (const key of SECRET_KEYS) assert.equal(envs[0]![key], undefined, `${key} is not in the helper's env`);
  assert.equal(envs[0]!["PATH"], "/usr/bin:/bin");
  assert.equal(envs[0]!["JARHEAD_HANDS_BIN"], bin);
  assert.equal(given["OPENAI_API_KEY"], "sk-live-secret", "the caller's env object is untouched");
  hands.cancelPending();
  await assert.rejects(req, /cancelled/);
  hands.stop();

  // Without the option the daemon's own env is the base, scrubbed the same way.
  const scrubbed = scrubHandsEnv({ HOME: "/Users/kevin", OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y", JARHEAD_BRAIN_API_KEY: "z" });
  assert.deepEqual(scrubbed, { HOME: "/Users/kevin" });
  assert.equal(SECRET_KEYS.length, 3, "the three keys the shell and Codex children are also denied");
});

test("two clients over two children: a cancel on one fails only its own pendings; the other's requests are untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-hands-"));
  const bin = join(dir, "hands");
  writeFileSync(bin, "#!/bin/sh\n");
  const childA = new FakeChild();
  const childB = new FakeChild();
  const a = new NativeHandsProcess({ binPath: bin, spawnImpl: (() => childA as unknown as ChildProcess) as never });
  const b = new NativeHandsProcess({ binPath: bin, spawnImpl: (() => childB as unknown as ChildProcess) as never });
  const typing = a.request("type", { text: "hello" });
  const tree = b.request<{ count: number }>("ax_tree", { summary: true });
  const front = b.request<{ app: string }>("frontmost");
  await seen(childA, 1);
  await seen(childB, 2);
  assert.equal(a.pendingCount, 1);
  assert.equal(b.pendingCount, 2);
  assert.equal(a.cancelPending("stop"), 1);
  await assert.rejects(typing, (e: unknown) => e instanceof NativeRequestError && e.detail.code === "cancelled");
  assert.equal(b.pendingCount, 2, "the other helper's requests stand");
  // Answer by op: two requests made while the spawn is still settling may reach the child in either order.
  const idOf = (op: string): string => childB.seen.find((s) => s.op === op)!.id;
  childB.answer(idOf("ax_tree"), { count: 12 });
  childB.answer(idOf("frontmost"), { app: "Slack" });
  assert.deepEqual(await tree, { count: 12 });
  assert.deepEqual(await front, { app: "Slack" });
  // Ids are per client: the same `r1` on both children never crosses over.
  assert.equal(childA.seen[0]!.id, "r1");
  assert.ok(childB.seen.some((s) => s.id === "r1"), "both clients start at r1");
  a.stop();
  b.stop();
});

test("release F1: the busy prefix is a function of the user's name; the helper's own subject (\"the user\", or the pre-release \"Kevin\") is renamed to it, other messages pass through, and a runner spots the refusal whatever the name", async () => {
  const { handsBusyPrefix, HANDS_BUSY_PREFIX, isHandsBusyMessage, nameBusyMessage, HELPER_BUSY_SUBJECT } = await import("../native.ts");
  assert.equal(handsBusyPrefix("Sam"), "Sam used the keyboard/mouse");
  assert.equal(handsBusyPrefix(), HANDS_BUSY_PREFIX);
  assert.equal(HANDS_BUSY_PREFIX, "Kevin used the keyboard/mouse");
  assert.equal(nameBusyMessage(`${HELPER_BUSY_SUBJECT} used the keyboard/mouse 300 ms ago; nothing was posted`, "Sam"), "Sam used the keyboard/mouse 300 ms ago; nothing was posted");
  assert.equal(nameBusyMessage("Kevin used the keyboard/mouse 0 ms ago; nothing was posted", "Sam"), "Sam used the keyboard/mouse 0 ms ago; nothing was posted", "a helper built before the release");
  assert.equal(nameBusyMessage("front app moved", "Sam"), "front app moved");
  for (const m of ["Sam used the keyboard/mouse 12 ms ago; nothing was posted", "busy: Kevin used the keyboard/mouse 0 ms ago; nothing was posted", "Ada Lovelace used the keyboard/mouse 5 ms ago"]) assert.ok(isHandsBusyMessage(m), m);
  for (const m of ["refused: the keyboard/mouse", "front app moved", "Kevin is dictating"]) assert.equal(isHandsBusyMessage(m), false, m);
});
