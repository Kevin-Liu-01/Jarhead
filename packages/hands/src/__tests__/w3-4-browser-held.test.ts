/**
 * W3-4 (carried from W2-4): the browser's own ops are held while Kevin types, like every other op that steps on him.
 * browser_navigate replaces the page under his hands; a page script in the browser he is typing in clicks, types and
 * moves the focus there. So the helper runs the hands-win guard (Kevin's last key, click or scroll within
 * KEVIN_QUIET_MS gives `busy`, nothing sent) before browser_navigate, and before browser_js when the target browser
 * is the front app. A page script in a browser behind his app touches nothing of his and runs.
 * The fake mirrors the helper (FAKE_HELD_OPS), and the Swift is pinned by its source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_HELD_OPS, FakeHands } from "../fake.ts";
import { NativeRequestError } from "../native.ts";

const native = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native");

/** The body of `func <name>(` up to the next top-level `func` (or the end of the file). */
function body(source: string, name: string): string {
  const start = source.indexOf(`func ${name}(`);
  assert.ok(start >= 0, `${name} is in the source`);
  const next = source.indexOf("\nfunc ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof NativeRequestError ? e.detail.code : `threw ${(e as Error).message}`;
  }
}

test("the helper: browser_navigate runs the guard before its Apple event; browser_js runs it when the target browser is in front", () => {
  const browser = readFileSync(join(native, "Browser.swift"), "utf8");
  const navigate = body(browser, "opBrowserNavigate");
  const guard = navigate.indexOf("try guardActing(params)");
  assert.ok(guard >= 0 && guard < navigate.indexOf("runScript("), "opBrowserNavigate: the guard before the script");
  const js = body(browser, "opBrowserJS");
  assert.match(js, /if isFrontApp\(app\) \{ try guardActing\(params\) \}/);
  assert.ok(js.indexOf("guardActing") < js.indexOf("runScript("), "opBrowserJS: the guard before the script");
  // The reads that only look stay unheld: the tab list and the URL.
  assert.doesNotMatch(body(browser, "opBrowserTabs"), /guardActing/);
  assert.doesNotMatch(body(browser, "opBrowserURL"), /guardActing/);
});

test("the fake: browser_navigate and a front browser's browser_js answer busy while Kevin types; a background browser's script runs", async () => {
  assert.ok(FAKE_HELD_OPS.has("browser_navigate") && FAKE_HELD_OPS.has("browser_js"));
  const hands = new FakeHands();
  hands.frontApp = "Google Chrome";
  hands.kevinActed();
  assert.equal(await code(hands.request("browser_navigate", { app: "Google Chrome", url: "https://example.com/" })), "busy");
  assert.equal(await code(hands.request("browser_navigate", { app: "Safari", url: "https://example.com/" })), "busy", "a navigate is held wherever it lands");
  assert.equal(await code(hands.request("browser_js", { app: "Google Chrome", script: "1+1" })), "busy");
  assert.equal(await code(hands.request("browser_js", { app: "google chrome", script: "1+1" })), "busy", "the app's name, case folded");
  assert.equal(await code(hands.request("browser_js", { app: "Safari", script: "1+1" })), "ok", "Safari is behind Chrome");
  assert.equal(await code(hands.request("browser_tabs", { app: "Google Chrome" })), "ok", "the tab list only looks");
  // Quiet again: everything runs. Dictation's own driver is never held by Kevin's keys.
  const quiet = new FakeHands();
  quiet.frontApp = "Google Chrome";
  assert.equal(await code(quiet.request("browser_navigate", { app: "Google Chrome", url: "https://example.com/" })), "ok");
  assert.equal(await code(quiet.request("browser_js", { app: "Google Chrome", script: "1+1" })), "ok");
  quiet.kevinActed();
  assert.equal(await code(quiet.request("browser_js", { app: "Google Chrome", script: "1+1", ownDriver: true })), "ok");
  assert.deepEqual(quiet.posted, [], "neither is a post");
});
