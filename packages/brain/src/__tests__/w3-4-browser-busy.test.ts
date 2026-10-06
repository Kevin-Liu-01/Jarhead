/**
 * W3-4 review fix: holding browser_js in the front browser must not break the reads. The helper holds a page script
 * in the front browser while Kevin types (W3-4, carried from W2-4), and BrowserTools runs its read-only scripts
 * through browser_js too: the `1+1` probe, the read and the find. Before this fix the busy probe was remembered as
 * "JavaScript from Apple Events is off" for a minute, so browser_read fell back to accessibility with that note and a
 * selector click failed for 60 s; with JavaScript known on, browser_read and browser_find failed outright while he
 * typed. Now the scripts that only look say `readOnly: true` and run under his hands, the click and type scripts are
 * held (and the lease retries them once he is still), and a busy probe is never cached.
 *
 * FakeHands is the hands' own fake, which holds a call exactly when the helper does (fakeHeldNow); the page answers
 * are canned. Nothing reaches a helper, a browser or the desktop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "@jarhead/core";
import { AgentRegistry } from "@jarhead/agents";
import { ComputerToolset, ConfirmationState, FakeHands, KEVIN_QUIET_MS, NativeRequestError, isBusyResult, type ToolResult } from "@jarhead/hands";
import { browserJsDoctor } from "../browser.ts";
import { ToolRunner } from "../runner.ts";
import { makeSink, makeTask } from "./fakes.ts";

const PAGE = { url: "https://example.com/notes", title: "Notes", text: "Hello from the page", length: 19 };
const FOUND = { tag: "button", text: "Save", href: null, x: 10, y: 20, w: 60, h: 24, screenX: 0, screenY: 0, outerHeight: 900, innerHeight: 820, outerWidth: 1200, innerWidth: 1200 };

/**
 * Chrome in front with JavaScript from Apple Events on. The fake's own guard runs first (super.request), so a held
 * call answers `busy` before any page answer. `ignoreReadOnly` stands in for a helper that holds every page script in
 * the front browser, the probe included: the shape the review reproduced.
 */
class Chrome extends FakeHands {
  ignoreReadOnly = false;
  override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const sent = this.ignoreReadOnly && op === "browser_js" ? { ...params, readOnly: undefined } : params;
    await super.request(op, sent);
    switch (op) {
      case "browser_url":
        return { url: PAGE.url, title: PAGE.title } as T;
      case "ax_tree":
        return { nodes: [{ role: "AXStaticText", value: PAGE.text }], count: 1, window: PAGE.title, truncated: false } as unknown as T;
      case "browser_js": {
        const script = String(params["script"]);
        if (script === "1+1") return { result: "2", ms: 3 } as T;
        if (script.includes("document.body.innerText")) return { result: JSON.stringify(PAGE) } as T;
        if (script.includes("el.click()")) return { result: JSON.stringify({ count: 1, clicked: FOUND }) } as T;
        if (script.includes("__jhFind")) return { result: JSON.stringify({ count: 1, exact: true, first: FOUND }) } as T;
        return { result: "null" } as T;
      }
      default:
        return {} as T;
    }
  }
  /** The page scripts sent, in order: the probe, read, find, click. */
  scripts(): string[] {
    return this.named("browser_js").map((c) => {
      const s = String(c.params["script"]);
      return s === "1+1" ? "probe" : s.includes("document.body.innerText") ? "read" : s.includes("el.click()") ? "click" : s.includes("__jhFind") ? "find" : "other";
    });
  }
}

function setup(): { hands: Chrome; runner: ToolRunner; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  const hands = new Chrome();
  hands.now = () => clock.t;
  hands.frontApp = "Google Chrome";
  const toolset = new ComputerToolset({ hands, confirmations: new ConfirmationState() });
  const home = mkdtempSync(join(tmpdir(), "jh-w34-browser-home-"));
  mkdirSync(join(home, "Documents"), { recursive: true });
  const policy = (): Decision => ({ verdict: "run", reason: "stand-in: this test is about the hands, not the page policy" });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([], 0), stateDir: mkdtempSync(join(tmpdir(), "jh-w34-browser-state-")), home, policy, now: () => clock.t });
  runner.attach(makeSink().sink, makeTask("read the page"));
  return { hands, runner, clock };
}

const text = (r: ToolResult): string => (r.kind === "text" ? r.text : r.kind === "error" ? `error: ${r.message}` : r.kind);

test("review repro: Kevin types in the front browser; browser_read reads through JavaScript, then and once he is still, and nothing remembers JavaScript as off", async () => {
  const { hands, runner, clock } = setup();
  hands.kevinActed(clock.t - 200);
  const first = await runner.run("browser_read", {});
  assert.equal(first.result.kind, "text", text(first.result));
  assert.match(text(first.result), /Hello from the page/);
  assert.match(text(first.result), /the page's text follows/, "the JavaScript read, not the accessibility fallback");
  assert.doesNotMatch(text(first.result), /JavaScript from Apple Events is off|used the keyboard\/mouse/);
  // The probe and the read said readOnly; neither was held.
  for (const c of hands.named("browser_js")) assert.equal(c.params["readOnly"], true, String(c.params["script"]).slice(0, 20));
  // Past his quiet window (and well inside the 60 s an off state would be remembered), JavaScript is used again.
  clock.t += KEVIN_QUIET_MS + 100;
  const second = await runner.run("browser_read", {});
  assert.match(text(second.result), /the page's text follows/);
  assert.deepEqual(hands.scripts(), ["probe", "read", "read"], "one probe, remembered as on");
  assert.equal(hands.named("ax_tree").length, 0, "the accessibility tree was never needed");
});

test("with JavaScript known on, browser_find runs while Kevin types; browser_click is held as busy (the lease retries it), and runs once he is still", async () => {
  const { hands, runner, clock } = setup();
  assert.match(text((await runner.run("browser_read", {})).result), /the page's text follows/);
  hands.kevinActed(clock.t);
  clock.t += 100;
  const find = await runner.run("browser_find", { text: "Save" });
  assert.equal(find.result.kind, "text", text(find.result));
  assert.match(text(find.result), /"match":"exact"/);
  const click = await runner.run("browser_click", { text: "Save" });
  assert.equal(click.result.kind, "error");
  assert.ok(isBusyResult(click.result), `a held click reads as busy, so the lease retries it: ${text(click.result)}`);
  assert.match(text(click.result), /nothing was posted/);
  clock.t += KEVIN_QUIET_MS;
  const again = await runner.run("browser_click", { text: "Save" });
  assert.match(text(again.result), /^clicked <button> "Save"/);
  // The click script was sent twice (held, then run) and never with readOnly; the busy click did not turn JavaScript off.
  const clicks = hands.named("browser_js").filter((c) => String(c.params["script"]).includes("el.click()"));
  assert.equal(clicks.length, 2);
  assert.ok(clicks.every((c) => c.params["readOnly"] === undefined), "a click is never sent as readOnly");
  assert.deepEqual(hands.scripts(), ["probe", "read", "find", "click", "click"]);
});

test("a probe the helper held is not remembered as JavaScript off: that one read falls back, the next one after his quiet window uses JavaScript", async () => {
  const { hands, runner, clock } = setup();
  hands.ignoreReadOnly = true; // a helper that holds even the probe
  hands.kevinActed(clock.t - 200);
  const first = await runner.run("browser_read", {});
  assert.equal(first.result.kind, "text", text(first.result));
  assert.match(text(first.result), /read through accessibility/, "this one call falls back");
  clock.t += KEVIN_QUIET_MS + 100;
  const second = await runner.run("browser_read", {});
  assert.match(text(second.result), /the page's text follows/, `JavaScript again at ${KEVIN_QUIET_MS + 100} ms, not after a minute: ${text(second.result)}`);
  assert.deepEqual(hands.scripts(), ["probe", "probe", "read"], "the busy probe was asked again, not cached");
  // A selector click needs JavaScript; it is not refused as "JavaScript is off" after a busy probe.
  const click = await runner.run("browser_click", { selector: "#save" });
  assert.match(text(click.result), /^clicked <button>/, text(click.result));
});

test("the doctor's probe only looks: it reads JavaScript as on while Kevin types in the front browser", async () => {
  const hands = new Chrome();
  hands.frontApp = "Google Chrome";
  hands.kevinActed();
  const row = await browserJsDoctor(hands, "Google Chrome");
  assert.equal(row.status, "ok", row.detail);
  assert.equal(hands.named("browser_js")[0]?.params["readOnly"], true);
  // And the fake still holds a page script that does not say so.
  await assert.rejects(hands.request("browser_js", { app: "Google Chrome", script: "document.title" }), (e: unknown) => e instanceof NativeRequestError && e.detail.code === "busy");
});
