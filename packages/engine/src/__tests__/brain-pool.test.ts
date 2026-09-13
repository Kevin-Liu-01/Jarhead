import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, BrainResult } from "@jarhead/brain";
import { BrainPool, WARM_SPARES_MAX, WARM_SPARE_RETRY_MS, type PoolLane } from "../threads/brain-pool.ts";

/**
 * The warm brains: warm(2) boots two spares and nothing awaits them; take() hands
 * out a READY spare first (the caller's start is then microseconds) and tops up
 * behind it; a boot that fails is dropped, its process stopped, and tried again
 * only after WARM_SPARE_RETRY_MS on the pool's own clock; stopAll ends every spare,
 * booting ones too, and forgets the failure; the count clamps to 0..3 and is zero
 * while threads are off.
 */

interface FakeLane extends PoolLane {
  readonly id: string;
  readonly brain: Brain & { starts: number; stops: number; boot: (r: { ready: boolean; detail: string }) => void };
  started: Promise<{ ready: boolean; detail: string }> | undefined;
}

function harness(opts: { spares?: number; retryMs?: number; enabled?: boolean; readyAtOnce?: boolean; factory?: boolean } = {}): { pool: BrainPool<FakeLane>; lanes: FakeLane[]; clock: { t: number }; flush: () => Promise<void> } {
  const clock = { t: 1_757_500_000_000 };
  const lanes: FakeLane[] = [];
  const makeLane = (): FakeLane | undefined => {
    if (opts.factory === false) return undefined;
    let boot!: (r: { ready: boolean; detail: string }) => void;
    const booting = new Promise<{ ready: boolean; detail: string }>((r) => (boot = r));
    const brain: FakeLane["brain"] = {
      kind: "fake",
      starts: 0,
      stops: 0,
      boot,
      start: async () => {
        brain.starts++;
        return opts.readyAtOnce === false ? booting : { ready: true, detail: "fake" };
      },
      handle: async (): Promise<BrainResult> => ({ status: "done" }),
      cancel: async () => undefined,
      stop: async () => {
        brain.stops++;
      },
    };
    const lane: FakeLane = { id: `t_${lanes.length + 1}`, brain, started: undefined };
    lanes.push(lane);
    return lane;
  };
  const pool = new BrainPool<FakeLane>({ makeLane, now: () => clock.t, ...(opts.spares !== undefined ? { spares: () => opts.spares! } : {}), ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}), ...(opts.enabled !== undefined ? { enabled: () => opts.enabled! } : {}) });
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  return { pool, lanes, clock, flush };
}

test("warm(2) boots two lanes and awaits nothing; the count reads Settings.warmThreads live, clamped 0..3; threads off → no spare", async () => {
  const { pool, lanes, flush } = harness();
  assert.equal(pool.wanted, 2, "the default");
  assert.equal(pool.warm(), 2);
  assert.equal(lanes.length, 2);
  assert.equal(pool.bootingCount, 2, "both booting right after warm()");
  await flush();
  assert.equal(pool.warmCount, 2);
  assert.equal(pool.warm(), 0, "already at the count");
  assert.deepEqual(pool.spareIds, ["t_1", "t_2"]);
  assert.ok(lanes.every((l) => l.brain.starts === 1));

  const many = harness({ spares: 9 });
  assert.equal(many.pool.wanted, WARM_SPARES_MAX, "clamped");
  const none = harness({ spares: -1 });
  assert.equal(none.pool.wanted, 0);
  assert.equal(none.pool.warm(), 0);
  const off = harness({ enabled: false });
  assert.equal(off.pool.warm(), 0, "threads are off: nothing boots");
  assert.equal(off.lanes.length, 0);
  const noFactory = harness({ factory: false });
  assert.equal(noFactory.pool.warm(), 0, "no brain kind that runs its own thread: nothing to warm");
});

test("take() hands out a ready spare first, in microseconds, and tops up behind it; a booting spare is taken ahead of a cold start; empty → undefined and a warm", async () => {
  const { pool, lanes, flush } = harness({ readyAtOnce: false });
  pool.warm();
  assert.equal(lanes.length, 2);
  lanes[1]!.brain.boot({ ready: true, detail: "up" });
  await flush();
  assert.equal(pool.warmCount, 1, "one ready, one still booting");
  const t0 = process.hrtime.bigint();
  const taken = pool.take();
  const us = Number(process.hrtime.bigint() - t0) / 1e3;
  assert.equal(taken, lanes[1], "the READY one, not the first");
  assert.ok(us < 5000, `take() answered in ${us.toFixed(0)} µs`);
  assert.ok(taken!.started, "its boot promise rides with it");
  await flush();
  assert.equal(lanes.length, 3, "topped up after the take");
  assert.deepEqual(pool.spareIds, ["t_1", "t_3"]);
  // Nothing ready: the booting one goes (its boot is ahead of a cold one).
  const booting = pool.take();
  assert.equal(booting, lanes[0]);
  assert.equal(pool.warmCount, 0);
  await flush();
  assert.equal(lanes.length, 4, "topped up again");
  // Everything taken: undefined, and the pool warms.
  pool.take();
  pool.take();
  await flush();
  const empty = harness({ spares: 0 });
  assert.equal(empty.pool.take(), undefined, "no spares wanted: a cold lane is the caller's");
  assert.equal(empty.lanes.length, 0);
});

test("a spare whose boot fails is dropped and its process stopped; the pool cools for WARM_SPARE_RETRY_MS on its own clock, then warms again; a success clears the cooling", async () => {
  const { pool, lanes, clock, flush } = harness({ readyAtOnce: false, spares: 1 });
  pool.warm();
  assert.equal(lanes.length, 1);
  lanes[0]!.brain.boot({ ready: false, detail: "codex is not logged in" });
  await flush();
  assert.equal(pool.spareIds.length, 0, "dropped");
  assert.equal(lanes[0]!.brain.stops, 1, "its process ended");
  assert.equal(pool.cooling, true);
  assert.equal(pool.warm(), 0, "no retry yet");
  clock.t += WARM_SPARE_RETRY_MS - 1;
  assert.equal(pool.warm(), 0, "not yet");
  clock.t += 1;
  assert.equal(pool.cooling, false);
  assert.equal(pool.warm(), 1, "tried again after the window");
  assert.equal(lanes.length, 2);
  lanes[1]!.brain.boot({ ready: true, detail: "up" });
  await flush();
  assert.equal(pool.warmCount, 1);
  assert.equal(pool.boots, 2);
  // A failure while another spare is fine cools the top-up, not the spare that is up.
  const two = harness({ readyAtOnce: false, spares: 2, retryMs: 1000 });
  two.pool.warm();
  two.lanes[0]!.brain.boot({ ready: true, detail: "up" });
  two.lanes[1]!.brain.boot({ ready: false, detail: "no" });
  await two.flush();
  assert.deepEqual(two.pool.spareIds, ["t_1"]);
  assert.equal(two.pool.warm(), 0, "cooling");
  two.clock.t += 1000;
  assert.equal(two.pool.warm(), 1);
});

test("stopAll stops every spare — booting ones too — and forgets the failure, so the next wake warms again; release() stops a thread's brain and tops up", async () => {
  const { pool, lanes, flush } = harness({ readyAtOnce: false });
  pool.warm();
  lanes[0]!.brain.boot({ ready: true, detail: "up" });
  await flush();
  assert.equal(pool.warmCount, 1);
  assert.equal(pool.bootingCount, 1);
  await pool.stopAll();
  assert.equal(pool.spareIds.length, 0);
  assert.ok(lanes.every((l) => l.brain.stops === 1), "both processes ended");
  // A boot that answers after stopAll is nobody's: not re-added, not counted.
  lanes[1]!.brain.boot({ ready: true, detail: "late" });
  await flush();
  assert.equal(pool.warmCount, 0);
  assert.equal(pool.spareIds.length, 0);
  // Warm again: fresh lanes.
  pool.warm();
  assert.equal(lanes.length, 4);
  const taken = pool.take()!;
  await flush();
  const before = lanes.length;
  await pool.release(taken);
  assert.equal(taken.brain.stops, 1, "the thread's process ends with it");
  assert.equal(lanes.length, before, "already at the count: no extra boot");
  assert.equal(pool.spareIds.length, 2);
});

test("a failed boot discovered after stopAll never sets the cooling; the pool's log line is one per spare (the RSS hook answers or stays silent)", async () => {
  const clock = { t: 1_757_500_000_000 };
  const lanes: FakeLane[] = [];
  const rss: string[] = [];
  const pool = new BrainPool<FakeLane>({
    now: () => clock.t,
    spares: () => 1,
    makeLane: () => {
      let boot!: (r: { ready: boolean; detail: string }) => void;
      const booting = new Promise<{ ready: boolean; detail: string }>((r) => (boot = r));
      const brain: FakeLane["brain"] = { kind: "fake", starts: 0, stops: 0, boot, start: async () => booting, handle: async () => ({ status: "done" }), cancel: async () => undefined, stop: async () => undefined };
      const lane: FakeLane = { id: `t_${lanes.length + 1}`, brain, started: undefined };
      lanes.push(lane);
      return lane;
    },
    rssOf: async (lane) => {
      rss.push(lane.id);
      return 187;
    },
  });
  pool.warm();
  await pool.stopAll();
  lanes[0]!.brain.boot({ ready: false, detail: "gone" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pool.cooling, false, "a stopped spare's late failure is not a failure of this wake");
  pool.warm();
  lanes[1]!.brain.boot({ ready: true, detail: "up" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rss, ["t_2"], "one RSS reading per spare that came up");
});

test("stopAll closes the pool: a release that settles after it, a take's top-up and the tick's topUp() boot nothing while closed — 0 processes behind a sleep — and only warm() (the wake path) opens it again; close() alone stops nothing", async () => {
  const { pool, lanes, flush } = harness({ readyAtOnce: false });
  pool.warm();
  lanes[0]!.brain.boot({ ready: true, detail: "up" });
  await flush();
  const taken = pool.take()!;
  await flush();
  assert.equal(lanes.length, 3, "topped up after the take while open");
  // The thread's process is still stopping when the sleep comes.
  let stopped!: () => void;
  const slow = new Promise<void>((r) => (stopped = r));
  const realStop = taken.brain.stop.bind(taken.brain);
  taken.brain.stop = async () => {
    await slow;
    return realStop();
  };
  const releasing = pool.release(taken);
  await pool.stopAll();
  assert.ok(pool.isClosed);
  assert.equal(pool.spareIds.length, 0);
  const boots = pool.boots;
  stopped();
  await releasing;
  assert.equal(pool.boots, boots, "the release's tail topped nothing up: the pool is closed");
  assert.equal(pool.spareIds.length, 0);
  assert.equal(pool.topUp(), 0, "the tick's top-up is 0 while closed");
  assert.equal(pool.take(), undefined, "nothing to take, and the empty take warms nothing");
  await flush();
  assert.equal(pool.boots, boots);
  assert.equal(lanes.length, 3, "no lane built while closed");
  // The wake path.
  assert.equal(pool.warm(), 2);
  assert.ok(!pool.isClosed);
  assert.equal(pool.boots, boots + 2);
  // close() alone: the spares stay up, nothing more boots.
  pool.close();
  assert.ok(pool.isClosed);
  assert.equal(pool.spareIds.length, 2);
  assert.equal(pool.topUp(), 0);
  await pool.stopAll();
  assert.equal(pool.spareIds.length, 0);
});
