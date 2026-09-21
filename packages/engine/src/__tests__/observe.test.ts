import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHands, ScreenStateCache, type NativeHands } from "@jarhead/hands";
import type { RunOutcome } from "@jarhead/brain";
import { ACTING_TOOLS } from "@jarhead/brain";
import { SETTLE_MS as LEASE_SETTLE_MS } from "@jarhead/hands";
import { ActionObserver, BACKGROUND_OBSERVES, OBSERVE_BUDGET_MS, OBSERVE_SETTLE_MS, OBSERVE_SLOW_SETTLE_MS } from "../observe.ts";

/**
 * ActionObserver: an acting tool's text result gains one `now:` line read from the
 * reading helper after the settle; a question, a refusal, an error, a look, a disabled
 * setting or a read past the budget leave the result as it was. The line goes through
 * the runner's redactor (I7) and the read invalidates then refills the state cache.
 */

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

const text = (t: string): RunOutcome => ({ result: { kind: "text", text: t }, ms: 5 });
const instant = async (): Promise<void> => undefined;

test("the settle constants carry the observer's name, apart from the lease's SETTLE_MS; the background set is inside the brain's ACTING_TOOLS", () => {
  assert.equal(OBSERVE_SETTLE_MS, 150);
  assert.equal(OBSERVE_SLOW_SETTLE_MS, 400);
  assert.equal(OBSERVE_BUDGET_MS, 300);
  assert.equal(LEASE_SETTLE_MS, 300, "the hands' SETTLE_MS is the lease's, a different thing — the observer's are named apart");
  assert.deepEqual([...BACKGROUND_OBSERVES].sort(), ["browser_click", "browser_navigate", "browser_type"]);
  assert.ok([...BACKGROUND_OBSERVES].every((t) => ACTING_TOOLS.has(t)));
});

test("a background lane's observer (`only: BACKGROUND_OBSERVES`) annotates browser_navigate but not applescript / run_shell / write_file / show_circle, and probes nothing for them", async () => {
  const hands = new FakeHands();
  hands.frontApp = "Cursor";
  const state = new ScreenStateCache(hands);
  const bg = new ActionObserver({ state, sleep: instant, only: BACKGROUND_OBSERVES });
  for (const n of ["applescript", "run_shell", "write_file", "edit_file", "show_circle", "left_click"]) {
    assert.equal(bg.observes(n), false, `${n}: not a background lane's business`);
    const out = text("played Focus");
    assert.equal(await bg.annotate(n, {}, out), out, `${n}: the result as it was`);
  }
  assert.equal(hands.calls.length, 0, "no probe for any of them");
  assert.equal(bg.eligible, 0);
  assert.equal(bg.observes("browser_navigate"), true);
  const nav = await bg.annotate("browser_navigate", { url: "https://github.com/" }, text("loading github.com"));
  const lines = (nav.result as { text: string }).text.split("\n");
  assert.equal(lines[0], "loading github.com");
  assert.match(lines[1]!, /^now: Cursor.*after the navigation$/);
  assert.equal(bg.observed, 1);
  // The main lane's observer, no `only`: every acting tool.
  const main = new ActionObserver({ state: new ScreenStateCache(new FakeHands()), sleep: instant });
  for (const n of ["applescript", "run_shell", "left_click", "browser_navigate"]) assert.equal(main.observes(n), true, n);
  assert.equal(main.observes("screenshot"), false);
});

test("a left_click text result gains a now: line; the settle is 150 ms, 400 for browser_click / browser_navigate; the cache is invalidated then refilled", async () => {
  const hands = new FakeHands();
  hands.frontApp = "Safari";
  hands.focusedTitle = "Search";
  hands.elementTitle = "Save";
  const state = new ScreenStateCache(hands);
  const slept: number[] = [];
  const observer = new ActionObserver({ state, sleep: async (ms) => void slept.push(ms), now: Date.now });
  state.absorb({ front: { app: "Finder", pid: 1, window: null } });
  const v0 = state.version;
  const out = await observer.annotate("left_click", { coordinate: [10, 10] }, text("OK"));
  assert.equal(out.result.kind, "text");
  const lines = (out.result as { text: string }).text.split("\n");
  assert.equal(lines[0], "OK");
  assert.match(lines[1]!, /^now: Safari \(was Finder\); focused: AXTextField "Search"; under the pointer: AXButton "Save"; \d+ ms after the click$/);
  assert.deepEqual(slept, [150]);
  assert.ok(state.version > v0 + 1, "invalidate + the probes landing bumped the version");
  assert.ok(hands.named("cursor").length === 1 && hands.named("element_at").length === 1 && hands.named("focused_text").length === 1 && hands.named("frontmost").length === 1, "one hop each, on the state's hands");
  assert.equal(observer.observed, 1);
  assert.equal(observer.eligible, 1);
  await observer.annotate("browser_click", { text: "Sign in" }, text("clicked"));
  assert.equal(slept.at(-1), 400, "a DOM click lands later");
  assert.equal(observer.settleFor("browser_navigate"), 400);
  assert.equal(observer.settleFor("type"), 150);
  // A caller that knows the point skips the pointer read.
  const before = hands.named("cursor").length;
  await observer.annotate("left_click", { coordinate: [1, 1] }, text("OK"));
  assert.equal(hands.named("cursor").length, before + 1, "no point given: the pointer is asked");
  const pointed = new ActionObserver({ state, sleep: instant, pointOf: () => ({ x: 5, y: 6 }) });
  const before2 = hands.named("cursor").length;
  await pointed.annotate("left_click", { coordinate: [1, 1] }, text("OK"));
  assert.equal(hands.named("cursor").length, before2, "point given: no cursor hop");
  assert.deepEqual(hands.named("element_at").at(-1)!.params, { x: 5, y: 6 });
});

test("a question, a refusal, an error, an image and a look are never annotated, and nothing is probed for them", async () => {
  const hands = new FakeHands();
  const state = new ScreenStateCache(hands);
  const observer = new ActionObserver({ state, sleep: instant });
  const q: RunOutcome = { result: { kind: "needs-confirmation", question: "About to click Send?", pendingId: "confirm_1" }, ms: 3 };
  const e: RunOutcome = { result: { kind: "error", message: "refused: 1Password" }, ms: 3 };
  const img: RunOutcome = { result: { kind: "image", pngBase64: "AAAA", width: 1, height: 1 }, ms: 3 };
  assert.equal(await observer.annotate("left_click", {}, q), q);
  assert.equal(await observer.annotate("type", {}, e), e);
  assert.equal(await observer.annotate("screenshot", {}, img), img);
  const look = text('{"app":"Finder"}');
  assert.equal(await observer.annotate("frontmost_app", {}, look), look, "a look is not observed");
  assert.equal(await observer.annotate("find_element", {}, look), look);
  const started = text("started");
  assert.equal(await observer.annotate("thread_start", {}, started), started, "a thread tool is not an acting tool");
  assert.equal(hands.calls.length, 0, "no probe for any of them");
  assert.equal(observer.eligible, 0);
});

test("a read slower than the budget leaves the result unchanged; Settings.observe=false disables it without a probe", async () => {
  const slow: NativeHands = { ready: true, request: () => new Promise(() => undefined) };
  const state = new ScreenStateCache(slow);
  const observer = new ActionObserver({ state, sleep: instant, budgetMs: 20 });
  const out = text("OK");
  const t0 = Date.now();
  assert.equal(await observer.annotate("left_click", {}, out), out, "nothing landed: the result as it was");
  assert.ok(Date.now() - t0 < 200 * RUNNER_SLACK, `answered at the budget: under ${200 * RUNNER_SLACK} ms (${Date.now() - t0} ms)`);
  assert.equal(observer.eligible, 1);
  assert.equal(observer.observed, 0);

  const hands = new FakeHands();
  const off = new ActionObserver({ state: new ScreenStateCache(hands), sleep: instant, enabled: () => false });
  assert.equal(await off.annotate("left_click", {}, out), out);
  assert.equal(hands.calls.length, 0, "off: no probe");
  assert.equal(off.eligible, 0);
});

test("the line passes through the redactor: a secret-shaped window title is struck (I7)", async () => {
  class SecretTitle extends FakeHands {
    override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      if (op === "frontmost") return { app: "Terminal", pid: 9, window: { title: "export OPENAI_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz", x: 0, y: 0, w: 1, h: 1, windowId: 1 } } as T;
      return super.request<T>(op, params);
    }
  }
  const state = new ScreenStateCache(new SecretTitle());
  const observer = new ActionObserver({ state, sleep: instant, redact: (s) => s.replace(/sk-live-[a-z]+/g, "[redacted secret]") });
  const out = await observer.annotate("key", { text: "Return" }, text("OK"));
  const line = (out.result as { text: string }).text.split("\n")[1]!;
  assert.match(line, /\[redacted secret\]/);
  assert.ok(!line.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("onLine hears every appended line with the tool's name and the settle it took", async () => {
  const hands = new FakeHands();
  const seen: { name: string; line: string }[] = [];
  const observer = new ActionObserver({ state: new ScreenStateCache(hands), sleep: instant, onLine: (name, line) => void seen.push({ name, line }) });
  await observer.annotate("open_app", { name: "Slack" }, text("opened Slack (pid 200)"));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.name, "open_app");
  assert.match(seen[0]!.line, /^now: /);
  assert.match(seen[0]!.line, /after the switch$/);
});
