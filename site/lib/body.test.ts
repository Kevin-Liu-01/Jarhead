/**
 * The hero's blob as a body (lib/body.ts), stepped deterministically at 1/120 s at the 1440 px scale (R 46.4, s 0.786).
 * Run from the repo root: TSX_TSCONFIG_PATH=site/tsconfig.json node --import tsx --test site/lib/body.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBody, type Body, type BodyOptions, type Box, type World } from "@/lib/body";
import { SPRING_CHAR, SPRING_DRAG, springKC } from "@/lib/motion";

const R = 46.4;
const s = 0.786;
const DT = 1 / 120;
const OPEN: Box = { l: -1e6, t: -1e6, r: 1e6, b: 1e6 };
const FREE: World = { box: OPEN, island: null };

function body(extra: Partial<BodyOptions> = {}): Body {
  return createBody({ R, s, drag: springKC(SPRING_DRAG), home: springKC(SPRING_CHAR), ...extra });
}

/** Steps until `done` or `seconds` pass; returns the time taken. */
function run(b: Body, w: World, seconds: number, each?: (t: number) => void, done?: () => boolean): number {
  let t = 0;
  while (t < seconds) {
    b.step(DT, w);
    t += DT;
    each?.(t);
    if (done?.()) break;
  }
  return t;
}

/** A tiny seeded generator (mulberry32), so the random flings are the same every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test("springKC converts the tokens as motion-dom does", () => {
  const d = springKC(SPRING_DRAG);
  assert.ok(Math.abs(d.k - 304.6) <= 0.5, `drag k ${d.k}`);
  assert.ok(Math.abs(d.c - 17.1) <= 0.1, `drag c ${d.c}`);
  const c = springKC(SPRING_CHAR);
  assert.ok(Math.abs(c.k - 101.4) <= 0.5, `char k ${c.k}`);
  assert.ok(Math.abs(c.c - 13.3) <= 0.1, `char c ${c.c}`);
});

test("held, it trails the hand by c/k of its speed and rings once when the hand stops", () => {
  const b = body();
  b.beginDrag(0, 0, 0);
  // the hand at 600 px/s, read at the start of each step: the lag is the hand's target minus the centre then
  let t = 0;
  for (; t < 1 - 1e-9; t += DT) {
    b.moveDrag(600 * t, 0, t * 1000);
    b.step(DT, FREE);
  }
  const hand = 600 * t;
  const lag = b.lag.x;
  assert.ok(Math.abs(lag - 33.7) <= 2, `steady lag ${lag.toFixed(2)}`);
  // the hand stops where it is
  b.moveDrag(hand, 0, t * 1000);
  const crossings: number[] = [];
  let prev = hand - b.x;
  let low = 0;
  let high = 0;
  for (let u = 0; u < 1.5; u += DT) {
    b.step(DT, FREE);
    const l = hand - b.x;
    if (Math.sign(l) !== Math.sign(prev) && prev !== 0) crossings.push(u);
    if (crossings.length === 1) low = Math.min(low, l);
    if (crossings.length === 2) high = Math.max(high, l);
    prev = l;
  }
  assert.ok(crossings.length >= 2, `crossings ${crossings.length}`);
  const gap = crossings[1]! - crossings[0]!;
  assert.ok(Math.abs(gap - 0.18) <= 0.03, `crossing gap ${gap.toFixed(3)} s`);
  // one overshoot: past the hand, then back by less than a third of it
  assert.ok(low < -1, `overshoot ${low.toFixed(2)}`);
  assert.ok(high < -low * 0.35, `second swing ${high.toFixed(2)} after ${low.toFixed(2)}`);
});

test("endDrag blends the hand's velocity unless it is stale, capped at 4500·s", () => {
  const drive = (): Body => {
    const b = body();
    b.beginDrag(0, 0, 0);
    let t = 0;
    for (; t < 0.5; t += DT) {
      b.moveDrag(600 * (t + DT), 0, (t + DT) * 1000);
      b.step(DT, FREE);
    }
    return b;
  };
  const fresh = drive();
  const vb = fresh.vx;
  fresh.endDrag(500 + 10);
  assert.ok(Math.abs(fresh.vx - (0.6 * vb + 0.4 * 600)) < 1, `fresh ${fresh.vx} from ${vb}`);
  const stale = drive();
  const vs = stale.vx;
  stale.endDrag(500 + 130);
  assert.ok(Math.abs(stale.vx - 0.6 * vs) < 1e-6, `stale ${stale.vx} from ${vs}`);
  const wild = body();
  wild.beginDrag(0, 0, 0);
  wild.moveDrag(5000, 0, 4);
  wild.step(DT, FREE);
  wild.endDrag(6);
  assert.ok(Math.hypot(wild.vx, wild.vy) <= 4500 * s + 1e-6, `cap ${Math.hypot(wild.vx, wild.vy)}`);
});

test("toward a wall: slow sticks into a dome, quick bounces at 0.55, hard splats first", () => {
  const box: Box = { l: -100, t: -1e6, r: 1e6, b: 1e6 };
  const w: World = { box, island: null };
  // 300 px/s: sticks, then sags to 0.62 R off the wall and rests
  const slow = body();
  slow.fling(-300, 0);
  run(slow, w, 4, undefined, () => slow.atRest);
  assert.equal(slow.mode, "rest");
  assert.equal(slow.stuckCount, 1);
  const off = slow.x - box.l;
  assert.ok(Math.abs(off - 0.62 * R) <= 0.6, `dome ${off.toFixed(2)} vs ${(0.62 * R).toFixed(2)}`);
  // 800 px/s: bounces (from just off the wall, so it arrives at about the speed it was thrown)
  const near: World = { box: { ...box, l: -50 }, island: null };
  let hit = 0;
  let bounced = false;
  const quick = body({
    onImpact: (v, b) => {
      hit = v;
      bounced = b;
    },
  });
  quick.fling(-800, 0);
  run(quick, near, 2, undefined, () => hit > 0);
  assert.ok(bounced, "bounced");
  assert.ok(hit > 420 * s && hit < 1300 * s, `impact ${hit}`);
  assert.ok(Math.abs(quick.vx - 0.55 * hit) <= 0.01 * 0.55 * hit, `vn' ${quick.vx} vs ${0.55 * hit}`);
  // 1100 px/s: splats, then bounces
  const order: string[] = [];
  const hard = body({ onSplat: () => order.push("splat"), onImpact: () => order.push("impact") });
  hard.fling(-1100, 0);
  run(hard, near, 2, undefined, () => order.length > 0);
  assert.deepEqual(order.slice(0, 2), ["splat", "impact"]);
});

test("stuck, then pulled straight off by hand, it snaps at 40·s of pull", () => {
  const box: Box = { l: -100, t: -1e6, r: 1e6, b: 1e6 };
  const w: World = { box, island: null };
  let pull = -1;
  let x0 = 0;
  // the pull is measured from the stuck spot, where the hand found it
  const b = body({ onSnap: () => (pull = b.x - x0) });
  b.fling(-300, 0);
  run(b, w, 4, undefined, () => b.atRest);
  assert.equal(b.stuckCount, 1);
  x0 = b.x;
  b.beginDrag(x0, 0, 0);
  run(b, w, 3, (t) => b.moveDrag(x0 + 100 * t, 0, t * 1000), () => pull >= 0);
  assert.ok(Math.abs(pull - 40 * s) <= 1, `snap at ${pull.toFixed(2)} vs ${(40 * s).toFixed(2)}`);
});

test("home(true) flies home under the cap and lands exactly on it", () => {
  const b = body();
  b.place(-400, 200);
  b.home(true);
  let top = 0;
  const t = run(b, FREE, 3, () => (top = Math.max(top, Math.hypot(b.vx, b.vy))), () => b.atRest);
  assert.ok(top <= 880 * s + 1, `top speed ${top.toFixed(1)}`);
  assert.equal(b.x, 0);
  assert.equal(b.y, 0);
  assert.equal(b.mode, "rest");
  assert.ok(b.atHome);
  assert.ok(t <= 2.5, `home in ${t.toFixed(2)} s`);
});

test("the tap's hop peaks near 0.39 R and is home within a second", () => {
  const b = body();
  b.hopHome(0, -480 * s);
  let peak = 0;
  const t = run(b, FREE, 2, () => (peak = Math.min(peak, b.y)), () => b.atRest);
  assert.ok(Math.abs(peak / R + 0.39) <= 0.06, `peak ${(peak / R).toFixed(3)} R`);
  assert.ok(t <= 1, `rest in ${t.toFixed(2)} s`);
  assert.ok(b.atHome);
});

test("200 seeded flings in a 1440 × 860 box never leave it", () => {
  const rnd = seeded(7);
  const box: Box = { l: -1200, t: -380, r: 240, b: 480 };
  const w: World = { box, island: null };
  const max = 4500 * s;
  for (let k = 0; k < 200; k++) {
    const b = body();
    b.place(box.l + R + rnd() * (box.r - box.l - 2 * R), box.t + R + rnd() * (box.b - box.t - 2 * R));
    const a = rnd() * Math.PI * 2;
    const v = rnd() * max;
    b.fling(Math.cos(a) * v, Math.sin(a) * v);
    for (let t = 0; t < 4 && !b.atRest; t += DT) {
      const cs = b.step(DT, w);
      const stuck = (nx: number, ny: number): boolean => cs.some((c) => c.stuck && c.nx === nx && c.ny === ny);
      // a wall it bounces off keeps the centre 0.9 R inside; one it sticks to, the dome's 0.62 R
      const room = (nx: number, ny: number): number => (stuck(nx, ny) ? 0.62 : 0.9) * R - 0.5;
      assert.ok(b.x - box.l >= room(1, 0), `fling ${k}: left ${b.x - box.l}`);
      assert.ok(box.r - b.x >= room(-1, 0), `fling ${k}: right ${box.r - b.x}`);
      assert.ok(b.y - box.t >= room(0, 1), `fling ${k}: top ${b.y - box.t}`);
      assert.ok(box.b - b.y >= room(0, -1), `fling ${k}: bottom ${box.b - b.y}`);
    }
  }
});

test("the island's underside: a slow arrival puts it to bed, a quick one bounces at 0.42", () => {
  const island: Box = { l: -200, t: -Infinity, r: 200, b: -60 };
  const w: World = { box: OPEN, island };
  let tucked = false;
  const slow = body({ onTuck: () => (tucked = true) });
  slow.fling(0, -200);
  run(slow, w, 2, undefined, () => tucked);
  assert.ok(tucked, "tucked");
  let hit = 0;
  const quick = body({ onTuck: () => assert.fail("a quick arrival bounces"), onImpact: (v) => (hit = v) });
  quick.fling(0, -800);
  run(quick, w, 2, undefined, () => hit > 0);
  assert.ok(hit > 420 * s, `impact ${hit}`);
  assert.ok(Math.abs(quick.vy - 0.42 * hit) <= 0.01 * 0.42 * hit, `vn' ${quick.vy} vs ${0.42 * hit}`);
});
