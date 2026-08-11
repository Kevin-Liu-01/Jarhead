import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegionArg, downscaleArgs, downscaledPathFor } from "../screen.ts";

test("downscale args cap width without ever upscaling", () => {
  assert.deepEqual(
    [...downscaleArgs("/tmp/in.png", "/tmp/out.png", 1280)],
    [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", "/tmp/in.png",
      "-vf", "scale='min(1280,iw)':-2",
      "-frames:v", "1",
      "/tmp/out.png",
    ],
  );
});

test("downscale rejects a nonsense width", () => {
  for (const bad of [0, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => downscaleArgs("/tmp/a.png", "/tmp/b.png", bad), /positive integer/, String(bad));
  }
});

test("downscaled path keeps the directory and marks the width", () => {
  assert.equal(downscaledPathFor("/tmp/shot.png", 1280), "/tmp/shot.w1280.png");
  assert.equal(downscaledPathFor("/tmp/shot.PNG", 800), "/tmp/shot.w800.png");
  assert.equal(downscaledPathFor("/tmp/noext", 800), "/tmp/noext.w800.png");
});

test("region arg is rounded to integers screencapture accepts", () => {
  assert.equal(buildRegionArg({ x: 10.4, y: 20.6, w: 100, h: 50 }), "10,21,100,50");
});

test("region arg rejects empty or non-finite regions", () => {
  assert.throws(() => buildRegionArg({ x: 0, y: 0, w: 0, h: 50 }), /positive width and height/);
  assert.throws(() => buildRegionArg({ x: 0, y: 0, w: 100, h: -1 }), /positive width and height/);
  assert.throws(() => buildRegionArg({ x: Number.NaN, y: 0, w: 10, h: 10 }), /finite/);
});
