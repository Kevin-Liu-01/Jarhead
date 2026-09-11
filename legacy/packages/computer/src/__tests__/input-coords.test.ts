import { test } from "node:test";
import assert from "node:assert/strict";
import { cliclickCanExpress, easedSteps } from "../input.ts";

/**
 * Regression for a bug that silently walked the cursor off every display.
 *
 * cliclick reads a leading sign in `m:`/`c:` as a RELATIVE offset, so
 * `m:1000,-500` means "y minus 500". Measured: two identical calls landed at
 * y=-378779 then y=-379279. Kevin's displays sit above the primary one, so
 * negative absolute Y is routine here, not exotic.
 */
test("negative coordinates are not expressible in cliclick", () => {
  assert.equal(cliclickCanExpress(1000, -500), false);
  assert.equal(cliclickCanExpress(-1, 0), false);
  assert.equal(cliclickCanExpress(0, -0.4), true, "-0.4 rounds to 0, which is expressible");
  assert.equal(cliclickCanExpress(-0.6, 5), false, "-0.6 rounds to -1, which is not");
});

test("non-negative coordinates stay on the cliclick path", () => {
  assert.equal(cliclickCanExpress(0, 0), true);
  assert.equal(cliclickCanExpress(800, 600), true);
  assert.equal(cliclickCanExpress(), true, "no coordinates is vacuously expressible");
});

test("every coordinate is checked, not just the first", () => {
  assert.equal(cliclickCanExpress(10, 10, 10, -2160), false, "a negative target must disqualify the batch");
});

test("the glide plan lands exactly on a negative target", () => {
  const steps = easedSteps({ x: 0, y: 0 }, { x: 1000, y: -500 }, 300);
  const last = steps[steps.length - 1];
  assert.deepEqual({ x: last?.x, y: last?.y }, { x: 1000, y: -500 });
});

test("the glide plan is monotonic toward a negative target", () => {
  const steps = easedSteps({ x: 0, y: 0 }, { x: 0, y: -1000 }, 400);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i]!.y <= steps[i - 1]!.y, `step ${i} moved back up`);
  }
});
