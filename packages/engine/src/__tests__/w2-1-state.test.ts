/**
 * W2-1, the engine's state (launch triage):
 *
 * - RF-7: a circle snaps to the topmost window under its centroid only, never to a window hidden behind it, whether
 *   that window is another app's or the front window's own app's.
 * - APP-8: settings.json is written whole or not at all; a file that will not parse is moved to settings.json.bad,
 *   never written over with the defaults, and the Console says so.
 * - WG-9 (decision D4): settings.json wins; JARHEAD_IDLE_SLEEP_MINUTES is the default until Settings saves one.
 * - TH-3: a main-lane task carries one note naming the live threads, so one started on an earlier request is named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegate, nextUtterance, settle, testConfig, tempDir, until, world } from "./world.ts";

/** What the helper answers for a circle at (570, 420): a line of text in the front browser, and the windows front to back. */
function screenAt(w: ReturnType<typeof world>, windows: readonly Record<string, unknown>[]): void {
  for (const h of [w.hands, w.handsBg]) {
    const orig = h.request.bind(h);
    h.request = (async (op: string, params: Record<string, unknown> = {}) => {
      if (op === "element_at") return { role: "AXStaticText", title: "a paragraph", frame: { x: 440, y: 400, w: 260, h: 40 }, app: "Safari" };
      if (op === "windows") return { windows };
      return orig(op, params);
    }) as typeof h.request;
  }
}

test("RF-7 (audit repro): a circle over a window hidden BEHIND the front one does not snap to the hidden window", async () => {
  const w = world();
  const { engine } = w;
  screenAt(w, [
    { app: "Safari", title: "Article", x: 0, y: 0, w: 1600, h: 1000, pid: 500, windowId: 1, layer: 0 },
    { app: "Notes", title: "Shopping", x: 400, y: 300, w: 340, h: 240, pid: 100, windowId: 2, layer: 0 },
  ]);
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    await settle();
    await engine.command({ type: "mark.add", rect: { x: 380, y: 280, w: 380, h: 280 } });
    await until(() => engine.snapshot().marks.length > 0 && engine.snapshot().marks.every((m) => m.element !== undefined), 3000);
    const m = engine.snapshot().marks.at(-1)!;
    assert.notEqual(m.element?.app, "Notes", `snapped to ${JSON.stringify(m.element)} at ${JSON.stringify(m.rect)}: a window that is not visible there`);
    assert.equal(m.element?.app, "Safari");
  } finally {
    await engine.stop();
  }
});

test("RF-7: a circle over a window hidden behind another window of the SAME app does not snap to the hidden one", async () => {
  const w = world();
  const { engine } = w;
  // Two Safari windows: the article in front, the Downloads window behind it, where Kevin circles part of the page.
  screenAt(w, [
    { app: "Safari", title: "Article", x: 0, y: 0, w: 1600, h: 1000, pid: 500, windowId: 1, layer: 0 },
    { app: "Safari", title: "Downloads", x: 400, y: 300, w: 340, h: 240, pid: 500, windowId: 2, layer: 0 },
  ]);
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    await settle();
    await engine.command({ type: "mark.add", rect: { x: 380, y: 280, w: 380, h: 280 } });
    await until(() => engine.snapshot().marks.length > 0 && engine.snapshot().marks.every((m) => m.element !== undefined), 3000);
    const m = engine.snapshot().marks.at(-1)!;
    assert.notEqual(m.element?.title, "Downloads", `snapped to ${JSON.stringify(m.element)} at ${JSON.stringify(m.rect)}: a window he cannot see there`);
    assert.deepEqual(m.element, { role: "AXStaticText", title: "a paragraph", app: "Safari" }, "what he circled on the page");
  } finally {
    await engine.stop();
  }
});

test("RF-7: the same circle over the same window when it is IN FRONT snaps to it", async () => {
  const w = world();
  const { engine } = w;
  screenAt(w, [
    { app: "Notes", title: "Shopping", x: 400, y: 300, w: 340, h: 240, pid: 100, windowId: 2, layer: 0 },
    { app: "Safari", title: "Article", x: 0, y: 0, w: 1600, h: 1000, pid: 500, windowId: 1, layer: 0 },
  ]);
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    await settle();
    await engine.command({ type: "mark.add", rect: { x: 380, y: 280, w: 380, h: 280 } });
    await until(() => engine.snapshot().marks.some((m) => m.element?.role === "AXWindow"), 3000);
    const m = engine.snapshot().marks.at(-1)!;
    assert.deepEqual(m.element, { role: "AXWindow", title: "Shopping", app: "Notes" });
    assert.deepEqual(m.rect, { x: 400, y: 300, w: 340, h: 240 });
  } finally {
    await engine.stop();
  }
});

test("APP-8: a settings.json that will not parse is moved to settings.json.bad whole, never written over; the Console says so; the next save is a clean file", async () => {
  const dir = tempDir("jh-w21-settings-");
  const config = testConfig(dir);
  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, "settings.json");
  const torn = '{\n  "brain": "codex",\n  "voice": "marin",\n  "idleSleepMi';
  writeFileSync(path, torn);
  const w = world({ config }, { dir });
  const { engine } = w;
  try {
    assert.equal(existsSync(path), false, "moved aside");
    assert.equal(readFileSync(`${path}.bad`, "utf8"), torn, "kept whole");
    assert.equal(engine.currentSettings.brain, "auto", "the defaults run");
    await engine.start();
    const row = engine.typedProblems().find((p) => p.text.startsWith("settings.json could not be read"));
    assert.ok(row, JSON.stringify(engine.typedProblems()));
    assert.match(row.text, /It is kept as settings\.json\.bad\. Jarhead runs on the defaults\.$/);
    assert.deepEqual(row.remedy, { label: "Reveal", open: `${path}.bad` });
    engine.updateSettings({ voice: "ballad" });
    assert.equal(readFileSync(`${path}.bad`, "utf8"), torn, "the next save never touches the kept file");
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as { voice: string }).voice, "ballad");
    assert.deepEqual(readdirSync(config.stateDir).filter((f) => f.includes(".tmp")), [], "no temp file left behind");
  } finally {
    await engine.stop();
  }
});

test("APP-8 (review repro): a second unreadable settings.json never overwrites the first one kept aside; each is kept whole and the row names its own file", async () => {
  const dir = tempDir("jh-w21-settings-twice-");
  const config = testConfig(dir);
  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, "settings.json");
  const first = '{"voice": "marin", "userName": "Kev';
  const second = '{"voice": "cedar", "brain": "co';
  const third = "[1, 2";
  const kept: string[] = [];
  for (const torn of [first, second, third]) {
    writeFileSync(path, torn);
    const w = world({ config }, { dir });
    try {
      await w.engine.start();
      const row = w.engine.typedProblems().find((p) => p.text.startsWith("settings.json could not be read"));
      assert.ok(row?.remedy && "open" in row.remedy, JSON.stringify(w.engine.typedProblems()));
      const open = (row.remedy as { open: string }).open;
      assert.equal(readFileSync(open, "utf8"), torn, "the row's Reveal opens the file it names");
      assert.ok(row.text.includes(`It is kept as ${open.slice(config.stateDir.length + 1)}.`), row.text);
      kept.push(open.slice(config.stateDir.length + 1));
    } finally {
      await w.engine.stop();
    }
  }
  assert.deepEqual(kept, ["settings.json.bad", "settings.json.bad-2", "settings.json.bad-3"]);
  assert.equal(readFileSync(`${path}.bad`, "utf8"), first, "the first file, with Kevin's settings, is still there");
  assert.equal(readFileSync(`${path}.bad-2`, "utf8"), second);
  assert.equal(readFileSync(`${path}.bad-3`, "utf8"), third);
});

test("APP-8: a settings.json that parses to something other than an object is moved aside too", async () => {
  const dir = tempDir("jh-w21-settings-null-");
  const config = testConfig(dir);
  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, "settings.json");
  writeFileSync(path, "null");
  const w = world({ config }, { dir });
  try {
    assert.equal(readFileSync(`${path}.bad`, "utf8"), "null");
    assert.equal(w.engine.currentSettings.brain, "auto");
  } finally {
    await w.engine.stop();
  }
});

test("WG-9 (D4): JARHEAD_IDLE_SLEEP_MINUTES is the default until Settings saves a value; then settings.json wins", async () => {
  const dir = tempDir("jh-w21-idle-");
  const first = world({ config: testConfig(dir, { idleSleepMinutes: 25 }) }, { dir });
  try {
    assert.equal(first.engine.currentSettings.idleSleepMinutes, 25, "no saved value: the env default");
    first.engine.updateSettings({ idleSleepMinutes: 5 });
  } finally {
    await first.engine.stop();
  }
  const second = world({ config: testConfig(dir, { idleSleepMinutes: 25 }) }, { dir, firstSessionId: "sess_b" });
  try {
    assert.equal(second.engine.currentSettings.idleSleepMinutes, 5, "the saved value wins over the env");
  } finally {
    await second.engine.stop();
  }
});

test("TH-3: a main-lane task carries one note naming the threads still running, so a thread started on an earlier request is reachable by name", async () => {
  const w = world();
  const { engine } = w;
  try {
    w.threads.script = async () => undefined;
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead tell ben on slack i'm late", "item_1");
    await until(() => w.brain.tasks.length === 1);
    assert.ok(!(w.brain.tasks[0]!.notes ?? []).some((n) => n.includes("Threads still running")), "no threads, no note");
    await engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
    await until(() => w.threads.byName("Slack")?.tasks.length === 1);
    w.brain.resolve!({ status: "done", summary: "on it." });
    await settle(50);
    nextUtterance(w);
    delegate(w, "jarhead actually don't message ben", "item_2");
    await until(() => w.brain.tasks.length === 2);
    const notes = w.brain.tasks[1]!.notes ?? [];
    const line = notes.join("\n").split("\n").find((l) => l.startsWith("Threads still running"));
    assert.ok(line, JSON.stringify(notes));
    assert.match(line, /^Threads still running: Slack \([a-z -]+: send Ben: I'm running late\)\. thread_read, thread_wait and thread_stop take these names\.$/);
  } finally {
    await engine.stop();
  }
});
