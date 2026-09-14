import { test } from "node:test";
import assert from "node:assert/strict";
import { LABELS_MAX, OBSERVATION_MAX_CHARS, ScreenStateCache, axLabels, renderCompositeLook, renderObservation, type ScreenState } from "../state.ts";
import type { AxTreeResult, FrontmostInfo, NativeHands } from "../native.ts";

/**
 * ScreenStateCache: an O(1) hit within age and under the same config, a miss otherwise;
 * a refresh runs its probes together (≤ parallel in flight) and answers with what landed
 * inside the budget; the observation line is one line ≤ 240 chars whatever the state.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Hands whose every op answers after `delays[op]` ms (default 1), stamping when it was asked and how many were in flight. */
class ProbeHands implements NativeHands {
  ready = true;
  calls: { op: string; at: number }[] = [];
  delays: Record<string, number> = {};
  inFlight = 0;
  maxInFlight = 0;
  frontApp = "Safari";
  title = "GitHub — kevin/jarhead";
  config = "cfg-1";
  secure = false;
  value: string | undefined = "hello";
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, at: performance.now() });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.delays[op] ?? 1);
    } finally {
      this.inFlight--;
    }
    switch (op) {
      case "frontmost":
        return { app: this.frontApp, pid: 7, window: { title: this.title, x: 0, y: 0, w: 100, h: 100, windowId: 1 } } as T;
      case "focused_text":
        return { role: "AXTextField", title: "Search", secure: this.secure, app: this.frontApp, ...(this.value !== undefined ? { value: this.value } : {}), config: this.config } as T;
      case "cursor":
        return { x: 40, y: 50 } as T;
      case "element_at":
        return { role: "AXButton", title: "Save", app: this.frontApp, config: this.config, frame: { x: Number(params["x"]), y: Number(params["y"]), w: 10, h: 10 } } as T;
      case "windows":
        return { windows: Array.from({ length: 14 }, (_, i) => ({ windowId: i, pid: 7, app: `App${i}`, title: `T${i}`, x: 0, y: 0, w: 10, h: 10, layer: 0 })) } as T;
      case "ax_tree":
        return { app: this.frontApp, pid: 7, window: this.title, count: 3, cached: true, ageMs: 10, treeMs: 4, truncated: false, nodes: [{ i: 0, depth: 0, role: "AXButton", title: "Save", x: 10, y: 20, w: 40, h: 20, pressable: true }, { i: 1, depth: 0, role: "AXStaticText", title: "Hello", x: 0, y: 0, w: 1, h: 1 }, { i: 2, depth: 1, role: "AXTextField", title: "Search", x: 100, y: 200, w: 200, h: 20 }] } as T;
      default:
        return {} as T;
    }
  }
}

test("get(maxAgeMs) is an O(1) hit within age and the same config, a miss when too old, under another config, or after invalidate", async () => {
  let now = 10_000;
  const hands = new ProbeHands();
  const cache = new ScreenStateCache(hands, { now: () => now });
  assert.equal(cache.get(1000), undefined, "nothing yet");
  const v0 = cache.version;
  await cache.refresh({ focused: true }, 300);
  assert.ok(cache.version > v0, "the refresh bumped the version");
  const hit = cache.get(500);
  assert.ok(hit && hit.front?.app === "Safari" && hit.focused?.role === "AXTextField", "a hit within age");
  assert.equal(hit!.config, "cfg-1");
  assert.equal(cache.get(500, "cfg-1"), hit, "same config: the same object, no probe");
  assert.equal(cache.get(500, "cfg-2"), undefined, "another display config: a miss");
  const calls = hands.calls.length;
  now += 600;
  assert.equal(cache.get(500), undefined, "too old");
  assert.equal(hands.calls.length, calls, "get never probes");
  now -= 600;
  assert.ok(cache.get(500));
  // A state that knows no config (a frontmost-only refresh; the AX tick's absorb — ax_tree reports none)
  // cannot vouch for the screen it was read under: a MISS for a caller that names the hash it needs.
  const unkeyed = new ScreenStateCache(hands, { now: () => now });
  await unkeyed.refresh({}, 300);
  assert.ok(unkeyed.get(500), "a hit for a caller that names no config");
  assert.equal(unkeyed.get(500)!.config, undefined, "frontmost carries no config");
  assert.equal(unkeyed.get(500, "cfg-1"), undefined, "unknown config: a miss when the caller names one");
  unkeyed.absorb({ ax: { app: "Safari", window: "w", labels: [] } });
  assert.equal(unkeyed.get(500, "cfg-1"), undefined, "an absorb without a config keeps it unkeyed");
  const before = cache.version;
  cache.invalidate("after left_click");
  assert.equal(cache.get(Number.POSITIVE_INFINITY), undefined, "invalidated");
  assert.equal(cache.version, before + 1);
  cache.invalidate("again");
  assert.equal(cache.version, before + 1, "invalidating nothing changes nothing");
});

test("refresh runs its probes together (arrivals within one hop, ≤ parallel in flight) and answers with the partial state past the budget; late probes still fill the cache unless invalidated", async () => {
  const hands = new ProbeHands();
  const cache = new ScreenStateCache(hands, { parallel: 3 });
  const t0 = performance.now();
  const s = await cache.refresh({ focused: true, windows: true, ax: true, underCursor: true }, 300);
  const arrivals = hands.calls.filter((c) => c.op !== "element_at").map((c) => c.at - t0);
  assert.ok(arrivals.length >= 4, `frontmost, focused_text, cursor, windows, ax_tree asked: ${hands.calls.map((c) => c.op).join(",")}`);
  assert.ok(Math.max(...arrivals) - Math.min(...arrivals) < 30, `the probes went out together (spread ${(Math.max(...arrivals) - Math.min(...arrivals)).toFixed(1)} ms)`);
  assert.ok(hands.maxInFlight <= 3, `at most 3 in flight (saw ${hands.maxInFlight})`);
  assert.equal(s.front?.app, "Safari");
  assert.equal(s.under?.role, "AXButton");
  assert.deepEqual(s.under?.point, { x: 40, y: 50 }, "the pointer's position rode with the element under it");
  assert.equal(s.windows?.length, 12, "windows capped at WINDOWS_MAX");
  assert.equal(s.ax?.labels.length, 2, "pressable or editable roles only; static text left out");

  // A slow focused_text past the budget: the answer is partial, the late probe fills the cache.
  const slow = new ProbeHands();
  slow.delays["focused_text"] = 120;
  const c2 = new ScreenStateCache(slow);
  const t1 = performance.now();
  const partial = await c2.refresh({ focused: true }, 40);
  const took = performance.now() - t1;
  assert.ok(took < 100, `answered at the budget (${took.toFixed(1)} ms), not at the slow probe`);
  assert.equal(partial.front?.app, "Safari");
  assert.equal(partial.focused, undefined, "the slow probe had not landed");
  await sleep(150);
  assert.equal(c2.get(1000)?.focused?.role, "AXTextField", "the late probe filled the cache for the next get");

  // Invalidated meanwhile: the late probe describes a screen that is gone and is dropped.
  const c3 = new ScreenStateCache(slow);
  await c3.refresh({ focused: true }, 40);
  c3.invalidate("after type");
  await sleep(150);
  assert.equal(c3.get(1000), undefined, "nothing from before the act survives it");

  // absorb: somebody else's answer (the AX tick) is a hit without a probe.
  const quiet = new ProbeHands();
  const c4 = new ScreenStateCache(quiet);
  c4.absorb({ front: { app: "Finder", pid: 1, window: null } });
  assert.equal(c4.get(100)?.front?.app, "Finder");
  assert.equal(quiet.calls.length, 0, "absorb probed nothing");
});

test("renderObservation: the line, the (was X) only on a change, a password field without its value, titles at 60 and values at 80, ≤ 240 chars in 100 random states", () => {
  const front = (app: string, title: string): FrontmostInfo => ({ app, pid: 1, window: { title, x: 0, y: 0, w: 1, h: 1, windowId: 1 } });
  const after: ScreenState = { at: 1, front: front("Safari", "GitHub"), focused: { role: "AXTextField", title: "Search", value: "hello", secure: false }, under: { role: "AXButton", title: "Save" } };
  const line = renderObservation({ at: 0, front: front("Finder", "Desktop") }, after, { name: "left_click", settleMs: 152 });
  assert.equal(line, 'now: Safari — "GitHub" (was Finder); focused: AXTextField "Search" = "hello"; under the pointer: AXButton "Save"; 152 ms after the click');
  assert.ok(!renderObservation({ at: 0, front: front("Safari", "x") }, after, { name: "type", settleMs: 150 }).includes("(was"), "same app: no (was X)");
  assert.ok(renderObservation(undefined, after, { name: "type", settleMs: 150 }).endsWith("150 ms after the typing"));
  assert.match(renderObservation(undefined, after, { name: "browser_navigate", settleMs: 401 }), /401 ms after the navigation$/);
  assert.match(renderObservation(undefined, after, { name: "show_circle", settleMs: 3 }), /after the circle$/);
  const secure = renderObservation(undefined, { ...after, focused: { role: "AXSecureTextField", title: "Password", value: "hunter2", secure: true } }, { name: "type" });
  assert.match(secure, /focused: a password field;/);
  assert.ok(!secure.includes("hunter2") && !secure.includes("Password"), "no value, no title for a secure field");
  assert.equal(renderObservation(undefined, { at: 1 }, { name: "key" }), "", "nothing known: no line");
  const long = renderObservation(undefined, { at: 1, front: front("Safari", "T".repeat(120)), focused: { role: "AXTextArea", title: "Body", value: "v".repeat(300), secure: false } }, { name: "type", settleMs: 150 });
  assert.match(long, /"T{59}…"/, "title cut at 60");
  assert.match(long, /"v{79}…"/, "value cut at 80");
  assert.ok(long.length <= OBSERVATION_MAX_CHARS, `${long.length}`);
  assert.equal(renderObservation(undefined, { at: 1, front: front("Mail", "Inbox"), focused: { role: "AXTextField", title: "To", value: "line one\n\n  line   two", secure: false } }, { name: "key", settleMs: 150 }), 'now: Mail — "Inbox"; focused: AXTextField "To" = "line one line two"; 150 ms after the key', "whitespace collapsed to one line");

  // 100 random states with a seeded generator: every line one line, ≤ 240.
  let seed = 42;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const word = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join("");
  const maybe = <T>(v: T): T | undefined => (rnd() < 0.7 ? v : undefined);
  const names = ["left_click", "type", "key", "scroll", "open_app", "browser_click", "applescript", "run_shell", "show_rect", "click_element"];
  let longest = 0;
  for (let i = 0; i < 100; i++) {
    const focused: NonNullable<ScreenState["focused"]> = { role: `AX${word(4 + Math.floor(rnd() * 12))}`, secure: rnd() < 0.1 };
    const title = maybe(word(Math.floor(rnd() * 80)));
    const value = rnd() < 0.7 ? word(Math.floor(rnd() * 400)) : undefined;
    const under: NonNullable<ScreenState["under"]> = { role: `AX${word(4 + Math.floor(rnd() * 12))}` };
    const underTitle = rnd() < 0.7 ? word(Math.floor(rnd() * 120)) : undefined;
    const state: ScreenState = {
      at: i,
      ...(rnd() < 0.9 ? { front: front(word(1 + Math.floor(rnd() * 40)), rnd() < 0.5 ? "" : word(Math.floor(rnd() * 200))) } : {}),
      ...(rnd() < 0.8 ? { focused: { ...focused, ...(title !== undefined ? { title } : {}), ...(value !== undefined ? { value } : {}) } } : {}),
      ...(rnd() < 0.8 ? { under: { ...under, ...(underTitle !== undefined ? { title: underTitle } : {}) } } : {}),
    };
    const before: ScreenState | undefined = rnd() < 0.5 ? { at: 0, front: front(word(5), "") } : undefined;
    const out = renderObservation(before, state, { name: names[i % names.length]!, settleMs: Math.floor(rnd() * 900) });
    assert.ok(out.length <= OBSERVATION_MAX_CHARS, `state ${i}: ${out.length} chars`);
    assert.ok(!out.includes("\n"), "one line");
    if (state.front || state.focused || state.under) assert.ok(out.startsWith("now:"), out);
    longest = Math.max(longest, out.length);
  }
  console.log(`measured: longest observation line over 100 random states = ${longest} chars (cap ${OBSERVATION_MAX_CHARS})`);
  assert.ok(longest <= OBSERVATION_MAX_CHARS);
});

test("axLabels keeps pressable or editable roles with a label and a frame, one per (role, label), ≤ LABELS_MAX; renderCompositeLook lists ≤ 8 windows and the controls in screenshot pixels", () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ i, depth: 1, role: i % 3 === 0 ? "AXButton" : i % 3 === 1 ? "AXStaticText" : "AXTextField", title: `Ctl ${i}`, x: i, y: i * 2, w: 10, h: 10, ...(i % 3 === 0 ? { pressable: true } : {}) }));
  const tree: AxTreeResult = { app: "Safari", pid: 1, window: "W", count: nodes.length, cached: true, ageMs: 1, treeMs: 1, truncated: true, nodes: [...nodes, { i: 99, depth: 1, role: "AXButton", title: "Ctl 0", x: 5, y: 5, w: 1, h: 1, pressable: true }, { i: 98, depth: 1, role: "AXButton", title: "No frame", pressable: true }, { i: 97, depth: 1, role: "AXLink", x: 1, y: 1, w: 1, h: 1 }] };
  const ax = axLabels(tree);
  assert.equal(ax.labels.length, LABELS_MAX);
  assert.ok(ax.labels.every((l) => l.role !== "AXStaticText"), "no static text");
  assert.equal(ax.labels.filter((l) => l.label === "Ctl 0").length, 1, "duplicates folded");
  assert.ok(!ax.labels.some((l) => l.label === "No frame"), "a control without a frame has no centre to click");
  assert.deepEqual(ax.labels[0], { role: "AXButton", label: "Ctl 0", center: { x: 5, y: 5 }, pressable: true });
  assert.ok(ax.labels.some((l) => l.editable === true), "text fields are editable");
  assert.equal(ax.truncated, true);

  const state: ScreenState = { at: 1, front: { app: "Safari", pid: 1, window: { title: "GitHub", x: 0, y: 0, w: 1, h: 1, windowId: 1 } }, focused: { role: "AXTextField", title: "Search", secure: false }, windows: Array.from({ length: 12 }, (_, i) => ({ windowId: i, pid: 1, app: `A${i}`, title: `T${i}`, x: 0, y: 0, w: 1, h: 1, layer: 0 })), ax };
  const look = renderCompositeLook(state, (p) => ({ x: p.x * 2, y: p.y * 2 }));
  const lines = look.split("\n");
  assert.equal(lines[0], 'screen: Safari — "GitHub"');
  assert.equal(lines[1], 'focused: AXTextField "Search"');
  assert.equal((lines[2]!.match(/A\d+/g) ?? []).length, 8, "≤ 8 windows");
  assert.match(lines[3]!, /^controls \(screenshot pixels; the tree was cut short, a control may be missing\): AXButton "Ctl 0" @10,10; /);
  assert.equal((lines[3]!.match(/@\d+,\d+/g) ?? []).length, LABELS_MAX);
  assert.match(renderCompositeLook({ at: 1, ax }), /^screen: unknown\ncontrols \(global points; the tree was cut short, a control may be missing\)/);
  const { truncated: _cut, ...whole } = ax;
  assert.match(renderCompositeLook({ at: 1, ax: whole }), /^screen: unknown\ncontrols \(global points\): /);
});
