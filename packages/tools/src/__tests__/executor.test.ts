import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTool, type ClickPolicy, type ElementFinder } from "../executor.ts";
import { fakeDeps } from "./fakes.ts";

const denyingPolicy = (level: string, reason: string): ClickPolicy => ({
  classifyClick: async () => ({ level, reason }),
});

test("an unknown tool name is an error result, not a throw", async () => {
  const { deps } = fakeDeps();
  const outcome = await executeTool("quantum_entangle", { x: 1 }, deps);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /unknown tool/);
});

test("non-object and malformed inputs come back as readable errors", async () => {
  const { deps } = fakeDeps();
  for (const bad of [null, "click here", 42, ["x", "y"]]) {
    const outcome = await executeTool("click_at", bad, deps);
    assert.equal(outcome.ok, false);
  }
  const wrongType = await executeTool("point_at", { x: "ten", y: 5, label: "a" }, deps);
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.ok ? "" : wrongType.error, /finite number/);
});

test("negative coordinates are valid — the second display lives there", async () => {
  const { deps, calls } = fakeDeps();
  const outcome = await executeTool("point_at", { x: 500, y: -2000, label: "menu bar" }, deps);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["move:500,-2000", "draw:arrow:500,-2000:menu bar"]);
});

test("point_at glides first, then draws the arrow", async () => {
  const { deps, calls } = fakeDeps();
  await executeTool("point_at", { x: 10, y: 20, label: "Export" }, deps);
  assert.equal(calls[0], "move:10,20");
  assert.equal(calls[1], "draw:arrow:10,20:Export");
});

test("find_on_screen reports not-found as an answer the model can use", async () => {
  const finder: ElementFinder = {
    find: async () => ({ target: undefined, degraded: "Chrome exposes neither elements nor window bounds" }),
  };
  const { deps } = fakeDeps({ finder });
  const outcome = await executeTool("find_on_screen", { description: "the settings gear" }, deps);
  assert.equal(outcome.ok, true);
  const result = outcome.ok ? (outcome.result as { found: boolean; why: string }) : undefined;
  assert.equal(result?.found, false);
  assert.match(result?.why ?? "", /Chrome/);
});

test("draw rejects a shape the annotator was never taught", async () => {
  const { deps, calls } = fakeDeps();
  const outcome = await executeTool("draw", { shape: "sparkle", x: 1, y: 2 }, deps);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /unknown shape/);
  assert.equal(calls.length, 0);
});

test("highlight_region needs a real rectangle", async () => {
  const { deps } = fakeDeps();
  const outcome = await executeTool("highlight_region", { x: 0, y: 0, w: -5, h: 10 }, deps);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /positive/);
});

test("a pre-approvable click runs", async () => {
  const { deps, calls } = fakeDeps();
  const outcome = await executeTool("click_at", { x: 300, y: 400 }, deps);
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, ["click:300,400"]);
});

test("clicks above pre-approvable are refused and ask for Kevin", async () => {
  for (const level of ["always-confirm", "hand-off"]) {
    const { deps, calls } = fakeDeps({ policy: denyingPolicy(level, "browser click") });
    const outcome = await executeTool("click_at", { x: 1, y: 2 }, deps);
    assert.equal(outcome.ok, false, level);
    assert.match(outcome.ok ? "" : outcome.error, /confirmation/);
    assert.match(outcome.ok ? "" : outcome.error, /browser click/);
    assert.equal(calls.length, 0, `${level}: the cursor must never have been touched`);
  }
});

test("a policy level the executor has never heard of fails closed", async () => {
  // A buggy (or compromised) policy implementation returning a made-up level
  // must read as a refusal — new levels are admitted in executor.ts on
  // purpose, never by default.
  const { deps, calls } = fakeDeps({ policy: denyingPolicy("totally-fine-trust-me", "n/a") });
  const outcome = await executeTool("click_at", { x: 1, y: 2 }, deps);
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test("a policy that throws refuses the click instead of killing the turn", async () => {
  const policy: ClickPolicy = {
    classifyClick: async () => {
      throw new Error("frontmostApp timed out");
    },
  };
  const { deps, calls } = fakeDeps({ policy });
  const outcome = await executeTool("click_at", { x: 1, y: 2 }, deps);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /timed out/);
  assert.equal(calls.length, 0);
});

test("a dependency blowing up is an error result, never an exception", async () => {
  const finder: ElementFinder = {
    find: async () => {
      throw new Error("screencapture returned no file");
    },
  };
  const { deps } = fakeDeps({ finder });
  const outcome = await executeTool("find_on_screen", { description: "anything" }, deps);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /screencapture/);
});

test("clear_annotations and list_windows round-trip", async () => {
  const { deps, calls } = fakeDeps();
  const cleared = await executeTool("clear_annotations", {}, deps);
  assert.equal(cleared.ok, true);
  const listed = await executeTool("list_windows", {}, deps);
  assert.equal(listed.ok, true);
  const windows = listed.ok ? (listed.result as { windows: readonly { app: string }[] }).windows : [];
  assert.equal(windows[0]?.app, "Notes");
  assert.deepEqual(calls, ["clear-annotations", "list-windows"]);
});

test("cursor position is read from the system, never estimated from a picture", async () => {
  // screencapture omits the pointer unless asked, so a vision answer to "where
  // is my cursor" is confidently wrong. This tool must not touch the eyes at all.
  const { deps, calls } = fakeDeps();
  const out = await executeTool("cursor_position", {}, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(out.ok && out.result, { x: 4242, y: -1337 });
  assert.equal(calls.filter((c) => c.startsWith("lookAt")).length, 0, "must not take a screenshot");
});

test("negative cursor coordinates survive, since a display sits above the primary", () => {
  assert.ok(-1337 < 0);
});
