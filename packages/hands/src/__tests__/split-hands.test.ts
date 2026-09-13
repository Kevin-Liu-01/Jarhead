import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandsPool, SplitHands, ACTING_OPS, READ_OPS, defaultRoute } from "../pool.ts";
import { FakeHands, fakeHandsSpawn } from "../fake.ts";
import type { NativeHands } from "../native.ts";

/**
 * SplitHands: one NativeHands over the two helpers. Reads go to the reading helper,
 * acts (and the frame-setting screenshot) to the acting one — so a read issued while a
 * 2 s `type` holds the acting helper answers in milliseconds instead of queueing behind
 * it. A cut, a restart and a stop reach both.
 */

function binPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jh-split-"));
  const bin = join(dir, "hands");
  writeFileSync(bin, "#!/bin/sh\n");
  return bin;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("routing table: reads → background, acts and the frame-setting screenshot → focus, unknown → focus, overrides win", () => {
  const split = new SplitHands({ focus: new FakeHands(), background: new FakeHands() });
  for (const op of ["zoom", "cursor", "frontmost", "windows", "focused_text", "element_at", "find_element", "ax_tree", "browser_url", "browser_tabs", "displays"]) {
    assert.ok(READ_OPS.has(op), `${op} is a read`);
    assert.equal(split.routeOf(op), "background", op);
  }
  for (const op of ["click", "move", "drag", "scroll", "type", "key", "hold_key", "mouse_down", "mouse_up", "open_app", "focus_app", "browser_js", "browser_navigate", "wait"]) {
    assert.ok(ACTING_OPS.has(op), `${op} acts`);
    assert.equal(split.routeOf(op), "focus", op);
  }
  // The screenshot sets the frame the next click is aimed at: it must see the act before it, so it shares the acting queue.
  assert.equal(split.routeOf("screenshot"), "focus");
  // `zoom` on the READING helper after a `screenshot` on the acting one is safe only because the helper's
  // opZoom captures the live display region fresh (packages/hands/native/Screen.swift `opZoom`: activeDisplays()
  // + a new CaptureSpec) and keeps no per-process last frame. A future "crop the last frame" optimisation in
  // the helper would silently hand the model a crop of a frame the reading process never took: keep this
  // pin with that change, or move zoom to "focus" then.
  assert.equal(split.routeOf("zoom"), "background");
  // user_idle excludes only the posts of the process asked; the acting helper is the one whose posts are Jarhead's.
  assert.equal(split.routeOf("user_idle"), "focus");
  for (const op of ["hello", "permissions", "something_new"]) assert.equal(defaultRoute(op), "focus", `${op}: unknown or identity → the acting helper`);
  const ab = new SplitHands({ focus: new FakeHands(), background: new FakeHands() }, { screenshot: "background", cursor: "focus" });
  assert.equal(ab.routeOf("screenshot"), "background", "an A/B may move the shot");
  assert.equal(ab.routeOf("cursor"), "focus");
  assert.equal(ab.routeOf("frontmost"), "background", "the rest of the table stands");
});

test("a frontmost read during a 2 s fake type answers in < 20 ms on the split, while the same read on the acting helper alone is still queued", async () => {
  // Two fakes, one per helper: the acting one types for 2 s (the helper is serial — a real
  // `type` is ≥ 8 ms per grapheme and holds the queue), the reading one answers at once.
  // Serial like the Swift helper (main.swift's one DispatchQueue): an op waits for the one before it.
  class TypingHands extends FakeHands {
    private queue: Promise<unknown> = Promise.resolve();
    override request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      const run = async (): Promise<T> => {
        if (op !== "type") return super.request<T>(op, params);
        // On the wire at once (the helper's queue has it), answered 2 s later: a long type.
        this.calls.push({ op, params, at: this.now() });
        await sleep(2000);
        this.posted.push({ op, params, at: this.now() });
        return this.typeResult as T;
      };
      const next = this.queue.then(run, run);
      this.queue = next.catch(() => undefined);
      return next;
    }
  }
  const focusFake = new TypingHands();
  const bgFake = new FakeHands();
  const pool = new HandsPool({ binPath: binPath(), spawnImpl: fakeHandsSpawn(focusFake), assumeAvailable: true, background: { spawnImpl: fakeHandsSpawn(bgFake) } });
  const split = new SplitHands(pool);
  // Warm both children (the first request spawns the fake process on a later tick).
  await split.request("cursor");
  await pool.focus.request("cursor");

  const typing = split.request("type", { text: "hello there" }, 5000);
  await sleep(5); // the type is on the acting helper's wire
  assert.equal(focusFake.named("type").length, 1, "the type went to the acting helper");
  const t0 = performance.now();
  const front = await split.request<{ app: string }>("frontmost", {}, 1000);
  const readMs = performance.now() - t0;
  assert.equal(front.app, "Notes");
  assert.equal(bgFake.named("frontmost").length, 1, "the read went to the reading helper");
  assert.ok(readMs < 20, `a read during the type took ${readMs.toFixed(2)} ms; must be < 20 ms`);
  console.log(`measured: frontmost during a 2 s type on the split = ${readMs.toFixed(2)} ms`);

  // The counterfactual: the same read on the acting helper queues behind the type.
  const behind = pool.focus.request<{ app: string }>("frontmost", {}, 5000);
  let landed = false;
  void behind.then(() => (landed = true));
  await sleep(100);
  assert.equal(landed, false, "on the acting helper alone the read is still waiting behind the type after 100 ms");
  assert.equal(pool.focus.pendingCount, 2, "type + frontmost pending on the acting helper");
  await typing;
  await behind;
  assert.equal(landed, true);
  pool.stop();
});

test("cancelAll drops the pendings of both helpers; restartAll and stop reach both; ready means the acting helper", async () => {
  const focusFake = new FakeHands();
  const bgFake = new FakeHands();
  focusFake.hold = "type";
  bgFake.hold = "ax_tree";
  const pool = new HandsPool({ binPath: binPath(), spawnImpl: fakeHandsSpawn(focusFake), assumeAvailable: true, background: { spawnImpl: fakeHandsSpawn(bgFake) } });
  const split = new SplitHands(pool);
  await split.request("cursor");
  await pool.focus.request("cursor");
  const typing = split.request("type", { text: "x" });
  const tree = split.request("ax_tree", { summary: true });
  await sleep(5);
  assert.equal(pool.pendingCount, 2);
  assert.equal(split.cancelAll("Kevin pressed stop"), 2, "both queues dropped through one call");
  await assert.rejects(typing, /cancelled/);
  await assert.rejects(tree, /cancelled/);
  assert.equal(pool.pendingCount, 0);
  focusFake.release();
  bgFake.release();
  assert.equal(split.ready, pool.focus.ready);
  await split.restartAll();
  assert.ok(pool.focus.ready && pool.background.ready, "both respawned");
  split.stop();
  assert.ok(!pool.focus.ready && !pool.background.ready, "both stopped");
});

test("over two bare NativeHands (no pool) a cut is a no-op count of 0 and the request still routes", async () => {
  const calls: string[] = [];
  const stub = (tag: string): NativeHands => ({ ready: true, request: async <T>(op: string) => ((calls.push(`${tag}:${op}`), {}) as T) });
  const split = new SplitHands({ focus: stub("focus"), background: stub("bg") });
  await split.request("frontmost");
  await split.request("click", { x: 1, y: 1 });
  assert.deepEqual(calls, ["bg:frontmost", "focus:click"]);
  assert.equal(split.cancelAll(), 0);
  await split.restartAll();
  split.stop();
});
