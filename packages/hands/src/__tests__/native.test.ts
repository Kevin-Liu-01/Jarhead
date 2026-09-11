import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { NativeHandsProcess, NativeRequestError } from "../native.ts";

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
