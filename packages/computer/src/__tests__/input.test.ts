import { test } from "node:test";
import assert from "node:assert/strict";
import { easedSteps } from "../input.ts";

test("eased movement lands exactly on the (rounded) target", () => {
  const steps = easedSteps({ x: 10, y: 900 }, { x: 640.4, y: 120.2 }, 350);
  assert.deepEqual(steps[steps.length - 1], { x: 640, y: 120, atMs: 350 });
});

test("progress is monotonic on both axes and in time", () => {
  const steps = easedSteps({ x: 0, y: 500 }, { x: 1000, y: 0 }, 400);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i]!.x >= steps[i - 1]!.x, "x should never move backwards");
    assert.ok(steps[i]!.y <= steps[i - 1]!.y, "y should never move backwards");
    assert.ok(steps[i]!.atMs >= steps[i - 1]!.atMs, "time should never move backwards");
  }
});

test("duration is respected and never exceeded", () => {
  const steps = easedSteps({ x: 0, y: 0 }, { x: 100, y: 100 }, 500);
  assert.equal(steps[steps.length - 1]!.atMs, 500);
  for (const s of steps) assert.ok(s.atMs >= 0 && s.atMs <= 500);
});

test("easing starts gently instead of jumping linearly", () => {
  const steps = easedSteps({ x: 0, y: 0 }, { x: 1000, y: 0 }, 480);
  const linearFirstStep = 1000 / steps.length;
  assert.ok(steps[0]!.x < linearFirstStep, `first step should undershoot linear, got ${steps[0]!.x}`);
});

test("no single step teleports across the screen", () => {
  const steps = easedSteps({ x: 0, y: 0 }, { x: 1200, y: 0 }, 480);
  let prev = 0;
  for (const s of steps) {
    assert.ok(s.x - prev <= 1200 / 3, `step of ${s.x - prev}px reads as a teleport`);
    prev = s.x;
  }
});

test("zero or negative duration collapses to one immediate step at the target", () => {
  assert.deepEqual([...easedSteps({ x: 5, y: 5 }, { x: 50, y: 60 }, 0)], [{ x: 50, y: 60, atMs: 0 }]);
  assert.deepEqual([...easedSteps({ x: 5, y: 5 }, { x: 50, y: 60 }, -10)], [{ x: 50, y: 60, atMs: 0 }]);
});

test("a zero-distance move still produces a valid plan", () => {
  const steps = easedSteps({ x: 300, y: 300 }, { x: 300, y: 300 }, 200);
  assert.ok(steps.length >= 1);
  assert.deepEqual(steps[steps.length - 1], { x: 300, y: 300, atMs: 200 });
});
