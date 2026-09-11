import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APEX_SCALE,
  MAX_FLIGHT_MS,
  MIN_FLIGHT_MS,
  apexScale,
  arcControls,
  cubicBezierPoint,
  distance,
  easeInOutCubic,
  flightDuration,
  flightFrame,
  type Point,
} from "../pointer.ts";

const FROM: Point = { x: 100, y: 700 };
const TO: Point = { x: 1300, y: 180 };

test("a flight starts exactly at the origin", () => {
  const frame = flightFrame(FROM, TO, 0, 1000);
  assert.deepEqual(frame.position, FROM);
  assert.equal(frame.done, false);
});

test("a flight ends exactly at the target, including past the duration", () => {
  for (const elapsed of [1000, 1001, 999999]) {
    const frame = flightFrame(FROM, TO, elapsed, 1000);
    assert.deepEqual(frame.position, TO);
    assert.equal(frame.scale, 1);
    assert.equal(frame.done, true);
  }
});

test("the path is continuous — no frame jumps more than a few pixels at 60Hz", () => {
  const durationMs = flightDuration(distance(FROM, TO));
  let previous = flightFrame(FROM, TO, 0, durationMs).position;
  for (let t = 16; t <= durationMs + 16; t += 16) {
    const { position } = flightFrame(FROM, TO, t, durationMs);
    const step = distance(previous, position);
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    // Peak eased speed over a ~1300px arc at 60Hz stays well under 60px/frame;
    // a discontinuity in the math would blow straight past this.
    assert.ok(step < 60, `frame at ${t}ms jumped ${step.toFixed(1)}px`);
    previous = position;
  }
  assert.deepEqual(previous, TO);
});

test("the arc actually arcs: a horizontal flight bows upward, off the chord", () => {
  const from: Point = { x: 0, y: 500 };
  const to: Point = { x: 800, y: 500 };
  const [c1, c2] = arcControls(from, to);
  const mid = cubicBezierPoint(from, c1, c2, to, 0.5);
  assert.ok(mid.y < 500 - 40, `midpoint should lift above the chord, got y=${mid.y}`);
});

test("scale pulses to the apex value at mid-flight and returns to 1", () => {
  assert.equal(apexScale(0), 1);
  assert.equal(apexScale(1), 1);
  assert.equal(apexScale(0.5), APEX_SCALE);
  const midFrame = flightFrame(FROM, TO, 500, 1000);
  assert.ok(midFrame.scale > 1.25, `apex frame should be near ${APEX_SCALE}, got ${midFrame.scale}`);
});

test("duration clamps at the short and long ends", () => {
  assert.equal(flightDuration(0), MIN_FLIGHT_MS);
  assert.equal(flightDuration(50), MIN_FLIGHT_MS);
  assert.equal(flightDuration(10_000), MAX_FLIGHT_MS);
});

test("duration grows monotonically with distance between the clamps", () => {
  let previous = 0;
  for (let d = 0; d <= 3000; d += 25) {
    const duration = flightDuration(d);
    assert.ok(duration >= previous, `duration regressed at ${d}px`);
    assert.ok(duration >= MIN_FLIGHT_MS && duration <= MAX_FLIGHT_MS);
    previous = duration;
  }
  const mid = flightDuration(860);
  assert.ok(mid > MIN_FLIGHT_MS && mid < MAX_FLIGHT_MS, `mid-range should interpolate, got ${mid}`);
});

test("a zero-distance flight produces no NaN and stays put", () => {
  const frame = flightFrame(FROM, FROM, 100, 600);
  assert.deepEqual(frame.position, FROM);
  assert.ok(Number.isFinite(frame.scale));
});

test("easing is pinned at the ends and symmetric through the middle", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  // Out-of-range inputs clamp instead of extrapolating past the target.
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(2), 1);
});
