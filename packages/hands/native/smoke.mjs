#!/usr/bin/env node
// Smoke test for build/jarhead-hands. Plain Node, no dependencies.
// Safe on a live machine: it only reads (screenshots, cursor, windows, AX, user_idle) and nudges
// the mouse by 3 points and back. It never clicks, types, scrolls, drags or focuses apps: the
// acting ops it sends carry `expectFront: {pid: 1}` (launchd is never in front), so the helper
// refuses each with `focus_moved` before its first post — which is the check.
//
//   node packages/hands/native/smoke.mjs
//   JARHEAD_HANDS_BIN=/path/to/jarhead-hands node packages/hands/native/smoke.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.JARHEAD_HANDS_BIN ?? resolve(here, "../../../build/jarhead-hands");

const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (error) => {
  console.error(`could not start ${binary}: ${error.message}`);
  process.exit(1);
});
const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));

const pending = new Map();
let nextId = 1;
let unmatchedResponses = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.log(`  !! non-JSON line on stdout: ${line.slice(0, 200)}`);
    unmatchedResponses.push({ raw: line });
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) {
    unmatchedResponses.push(message);
    return;
  }
  pending.delete(message.id);
  waiter(message);
});

function request(op, params = {}, timeoutMs = 20000) {
  const id = String(nextId++);
  const started = performance.now();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error(`${op} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      done({ message, ms: performance.now() - started });
    });
    child.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
  });
}

function base64Bytes(b64) {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function summarize(result) {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const copy = { ...result };
  if (typeof copy.pngBase64 === "string") {
    copy.pngBytes = base64Bytes(copy.pngBase64);
    copy.pngMagic = Buffer.from(copy.pngBase64.slice(0, 12), "base64").toString("hex");
    delete copy.pngBase64;
  }
  if (Array.isArray(copy.windows)) {
    copy.windows = `${copy.windows.length} windows; first: ${copy.windows
      .slice(0, 3)
      .map((w) => `${w.app}${w.title ? ` "${w.title.slice(0, 30)}"` : ""} ${w.w}x${w.h}@${w.x},${w.y}`)
      .join(" | ")}`;
  }
  return JSON.stringify(copy);
}

let failures = 0;
const optionalPermissionOps = new Set(["screenshot", "zoom", "element_at", "focused_text"]);

async function step(label, op, params, expect = "ok") {
  let response;
  try {
    response = await request(op, params);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}: ${error.message}`);
    return null;
  }
  const { message, ms } = response;
  const time = `${ms.toFixed(1)} ms`;
  if (expect === "ok") {
    if (message.ok) {
      console.log(`ok   ${label} (${time}) ${summarize(message.result)}`);
      return message.result;
    }
    const code = message.error?.code;
    if (code === "permission_denied" && optionalPermissionOps.has(op)) {
      console.log(`warn ${label} (${time}) permission_denied: ${message.error.message}`);
      return null;
    }
    failures += 1;
    console.log(`FAIL ${label} (${time}) ${JSON.stringify(message.error)}`);
    return null;
  }
  if (!message.ok && message.error?.code === expect) {
    console.log(`ok   ${label} (${time}) -> ${expect}: ${message.error.message}`);
    return message.error;
  }
  failures += 1;
  console.log(`FAIL ${label} (${time}) expected ${expect}, got ${JSON.stringify(message)}`);
  return null;
}

console.log(`jarhead-hands smoke: ${binary}`);

const hello = await step("hello", "hello");
await step("permissions", "permissions");
await step("displays", "displays");
const cursor = (await step("cursor", "cursor")) ?? { x: 0, y: 0 };
await step("frontmost", "frontmost");
await step("windows", "windows");
await step("screenshot maxLongEdge 1024 (cold)", "screenshot", { maxLongEdge: 1024 });
await step("screenshot maxLongEdge 1024 (warm)", "screenshot", { maxLongEdge: 1024 });
await step("screenshot defaults, cursor display", "screenshot", {});
await step("screenshot defaults, main display", "screenshot", { display: "main" });
await step("zoom 200x100 around cursor", "zoom", { x: cursor.x - 100, y: cursor.y - 50, w: 200, h: 100 });
await step("element_at cursor", "element_at", { x: cursor.x, y: cursor.y });
await step("move +3,+3", "move", { x: cursor.x + 3, y: cursor.y + 3 });
const moved = await step("cursor after move", "cursor");
if (moved && moved.x === cursor.x && moved.y === cursor.y) {
  const ax = hello?.permissions?.accessibility;
  console.log(`note cursor did not move${ax === false ? " (Accessibility not granted to the launching app; expected)" : ""}`);
}
await step("move back", "move", { x: cursor.x, y: cursor.y });
await step("wait 50", "wait", { ms: 50 });

// Kevin's hands win: `user_idle` reads the session's last inputs (a huge number = never seen);
// an acting op judged against an app that is not in front posts nothing. `ownDriver: true`
// skips the busy check so a keystroke of yours during the run cannot turn `focus_moved` into `busy`.
const idle = await step("user_idle", "user_idle");
if (idle) {
  for (const key of ["keyMs", "clickMs", "scrollMs", "moveMs", "foreignMs"]) {
    if (typeof idle[key] !== "number" || idle[key] < 0) {
      failures += 1;
      console.log(`FAIL user_idle: ${key} should be a non-negative number, got ${JSON.stringify(idle[key])}`);
    }
  }
}
const nothingInFront = { expectFront: { pid: 1 }, ownDriver: true };
await step("click with expectFront pid 1 (nothing posted)", "click", { ...nothingInFront }, "focus_moved");
await step("type with expectFront pid 1 (nothing posted)", "type", { text: "x", ...nothingInFront }, "focus_moved");
await step("key with expectFront pid 1 (nothing posted)", "key", { combo: "shift", ...nothingInFront }, "focus_moved");
await step("scroll with expectFront pid 1 (nothing posted)", "scroll", { dy: 1, ...nothingInFront }, "focus_moved");
await step("expectFront without pid", "click", { expectFront: {} }, "bad_request");
const idleAfter = await step("user_idle after the refusals", "user_idle");
if (idle && idleAfter && idleAfter.keyMs < idle.keyMs - 50 && idle.keyMs < 1e11) {
  // A key press arrived between the two reads: yours, or a refusal that posted (it must not).
  console.log("note keyMs moved between the reads — if you did not touch the keyboard, a refused op posted something");
}

await step("invalid op", "definitely_not_an_op", {}, "bad_request");
await step("click with bad button", "click", { button: "nope" }, "bad_request");
await step("key with bad combo", "key", { combo: "cmd+notakey" }, "bad_request");
await step("drag missing 'to'", "drag", { from: { x: 0, y: 0 } }, "bad_request");
await step("screenshot with bad display", "screenshot", { display: "nope" }, "bad_request");

child.stdin.write("this is not json\n");
await step("hello after garbage line", "hello");
const garbage = unmatchedResponses.find((m) => m.id === null && m.ok === false && m.error?.code === "bad_request");
if (garbage) {
  console.log(`ok   garbage line -> bad_request with id null: ${garbage.error.message}`);
} else {
  failures += 1;
  console.log(`FAIL garbage line: expected a bad_request with id null, got ${JSON.stringify(unmatchedResponses)}`);
}

child.stdin.end();
const { code, signal } = await exited;
console.log(`helper exit code: ${code}${signal ? ` (signal ${signal})` : ""}`);
if (code !== 0) failures += 1;
console.log(failures === 0 ? "smoke: all checks passed" : `smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
