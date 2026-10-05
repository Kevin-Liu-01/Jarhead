import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Automation } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import { APP_POLL_MS, LIST_ASYNC_AT, Watchers, type AutomationExec } from "../automations/index.ts";
import { world } from "./world.ts";

/**
 * W2-2 SL-13 and SL-17: the app quit fallback reads the process list (a window that left the
 * screen is not a quit), and only while no app forwards the signals; a folder poll lists each
 * folder once, stats only the names its baseline does not hold, and lists a big folder off the
 * event loop. The process list is scripted through the exec seam: no `ps` runs here.
 */

// Count the synchronous fs calls a poll makes. The watchers import these by name; the builtin's
// live bindings follow the patched functions after syncBuiltinESMExports().
const calls = { stat: 0, readdir: 0 };
const patchable = fs as { statSync: typeof fs.statSync; readdirSync: typeof fs.readdirSync };
const realStat = fs.statSync;
const realReaddir = fs.readdirSync;
patchable.statSync = function statSync(...args: Parameters<typeof realStat>) {
  calls.stat++;
  return realStat.apply(fs, args);
} as typeof fs.statSync;
patchable.readdirSync = function readdirSync(...args: Parameters<typeof realReaddir>) {
  calls.readdir++;
  return realReaddir.apply(fs, args);
} as typeof fs.readdirSync;
syncBuiltinESMExports();

const home = (): string => mkdtempSync(join(tmpdir(), "jh-w22-watch-"));
const row = (id: string, on: unknown): Automation => ({ id, name: id, when: { kind: "on", on }, then: [{ kind: "chime", line: "x" }], clauses: { quiet: "respect" }, echo: "", state: "armed", fires: 0, missed: 0, createdAt: 0, updatedAt: 0, createdBy: { by: "brain", request: "" } }) as unknown as Automation;

/** `ps -axo pid,comm` as macOS prints it: the executable's full path. */
function psExec(apps: () => readonly string[]): { exec: AutomationExec; lists: () => number } {
  let n = 0;
  return {
    lists: () => n,
    exec: {
      run: async () => ({ code: 0 }),
      hold: () => undefined,
      output: async (file, argv) => {
        n++;
        assert.deepEqual([file, ...argv], ["/bin/ps", "-axo", "pid,comm"]);
        const lines = apps().map((app, i) => `${String(100 + i).padStart(5)} /Applications/${app}.app/Contents/MacOS/${app}`);
        return { code: 0, stdout: ["  PID COMM", "    1 /sbin/launchd", ...lines, "  999 /Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)"].join("\n") };
      },
    },
  };
}

function watchers(exec: AutomationExec, h = home()): Watchers {
  return new Watchers({ now: () => 0, exec, shell: (async () => ({})) as never, shellGate: (() => ({ verdict: "run", reason: "" })) as never, settings: () => DEFAULT_SETTINGS, home: h });
}

test("SL-13: Slack moved to another Space (still running) does not fire 'when Slack quits'; Slack quitting does, once; Figma launching fires 'when Figma launches'", async () => {
  let apps = ["Slack", "Notes"];
  const { exec } = psExec(() => apps);
  const w = watchers(exec);
  const quit = row("auto_slack", { kind: "app.quit", app: "Slack" });
  const launch = row("auto_figma", { kind: "app.launch", app: "figma" });
  assert.deepEqual(await w.poll(APP_POLL_MS, [quit, launch]), [], "the first listing is the baseline");
  // Kevin swipes to a Space without Slack, minimises it, closes its last window: the process runs on.
  assert.deepEqual(await w.poll(2 * APP_POLL_MS, [quit, launch]), [], "a window off the screen is not a quit");
  apps = ["Notes", "Figma"];
  assert.deepEqual(await w.poll(3 * APP_POLL_MS, [quit, launch]), [{ id: "auto_slack", what: "Slack quit" }, { id: "auto_figma", what: "Figma launched" }]);
  assert.deepEqual(await w.poll(4 * APP_POLL_MS, [quit, launch]), [], "once");
});

test("SL-13: while an app client forwards the signals the fallback lists nothing; when the app goes it starts from a fresh baseline", async () => {
  let apps = ["Slack"];
  const { exec, lists } = psExec(() => apps);
  const w = watchers(exec);
  const quit = row("auto_slack", { kind: "app.quit", app: "Slack" });
  assert.deepEqual(await w.poll(APP_POLL_MS, [quit], { appSignals: false }), []);
  assert.equal(lists(), 1);
  assert.deepEqual(await w.poll(2 * APP_POLL_MS, [quit], { appSignals: true }), []);
  apps = [];
  assert.deepEqual(await w.poll(3 * APP_POLL_MS, [quit], { appSignals: true }), [], "the app's own signal is the edge; no double fire");
  assert.equal(lists(), 1, "no process list while the app forwards");
  assert.deepEqual(await w.poll(4 * APP_POLL_MS, [quit], { appSignals: false }), [], "a fresh baseline: what changed meanwhile is not replayed");
  assert.equal(lists(), 2);
});

test("SL-13: without a process-list seam (a test's exec) there is no fallback poll", async () => {
  const w = watchers({ run: async () => ({ code: 0 }), hold: () => undefined });
  const quit = row("auto_slack", { kind: "app.quit", app: "Slack" });
  assert.deepEqual(await w.poll(APP_POLL_MS, [quit]), []);
  assert.deepEqual(await w.poll(2 * APP_POLL_MS, [quit]), []);
});

test("SL-13: the engine polls the process list only while no app client is attached", async () => {
  const { exec, lists } = psExec(() => ["Slack"]);
  const w = world({ automations: { exec, home: home() } });
  const { engine, clock } = w;
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  try {
    await engine.start();
    engine.setViewers(1);
    const r = engine.automations.arm({ name: "log hours", when: { kind: "on", on: { kind: "app.quit", app: "Slack" } }, then: [{ kind: "say", line: "log your hours" }], echo: "When Slack quits, say it." }, "brain");
    assert.equal(r.kind, "armed");
    for (let i = 0; i < 3; i++) {
      clock.t += APP_POLL_MS;
      tick();
    }
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(lists(), 0, "the app forwards app.quit itself");
    engine.setViewers(0);
    clock.t += APP_POLL_MS;
    tick();
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(lists(), 1, "no app: the fallback lists the processes");
  } finally {
    await engine.stop();
  }
});

test("SL-17: a poll lists each folder once and stats only the names its baseline does not hold", async () => {
  const h = home();
  const dl = join(h, "Downloads");
  mkdirSync(dl);
  for (let i = 0; i < 500; i++) writeFileSync(join(dl, `old-${i}.pdf`), "x");
  const w = watchers({ run: async () => ({ code: 0 }), hold: () => undefined }, h);
  const a = row("auto_a", { kind: "download.done", glob: "*.pdf" });
  const b = row("auto_b", { kind: "folder.file", path: dl });
  assert.equal(w.watch(a), undefined);
  assert.equal(w.watch(b), undefined);
  calls.stat = 0;
  calls.readdir = 0;
  for (let k = 1; k <= 3; k++) assert.deepEqual(await w.poll(k * 5_000, [a, b]), []);
  assert.equal(calls.readdir, 3, "one listing per folder per poll, shared by the two rows");
  assert.equal(calls.stat, 0, "nothing new: nothing statted");
  writeFileSync(join(dl, "new.pdf"), "y");
  calls.stat = 0;
  assert.deepEqual(await w.poll(4 * 5_000, [a, b]), [], "first sighting");
  const fires = await w.poll(5 * 5_000, [a, b]);
  assert.deepEqual(fires.map((f) => f.id).sort(), ["auto_a", "auto_b"]);
  assert.ok(calls.stat <= 4, `only the new name is statted (${calls.stat} stats)`);
});

test("SL-17: a big folder is listed off the event loop, and a landing in it still fires", async () => {
  const h = home();
  const dl = join(h, "Downloads");
  mkdirSync(dl);
  for (let i = 0; i < LIST_ASYNC_AT + 100; i++) writeFileSync(join(dl, `old-${i}.pdf`), "x");
  const w = watchers({ run: async () => ({ code: 0 }), hold: () => undefined }, h);
  const a = row("auto_a", { kind: "download.done", glob: "*.pdf" });
  assert.equal(w.watch(a), undefined);
  calls.stat = 0;
  calls.readdir = 0;
  assert.deepEqual(await w.poll(5_000, [a]), []);
  assert.equal(calls.readdir, 0, "no synchronous listing");
  assert.equal(calls.stat, 0, "no stat of what was there");
  writeFileSync(join(dl, "new.pdf"), "y");
  assert.deepEqual(await w.poll(10_000, [a]), []);
  assert.deepEqual(await w.poll(15_000, [a]), [{ id: "auto_a", file: join(dl, "new.pdf"), what: "landed new.pdf" }]);
  assert.equal(calls.readdir, 0);
});

test("SL-17: a resync while a big listing is in flight wins: the stale listing never turns what landed meanwhile into landings", async () => {
  const h = home();
  const dl = join(h, "Downloads");
  mkdirSync(dl);
  for (let i = 0; i < LIST_ASYNC_AT + 100; i++) writeFileSync(join(dl, `old-${i}.pdf`), "x");
  const w = watchers({ run: async () => ({ code: 0 }), hold: () => undefined }, h);
  const a = row("auto_a", { kind: "download.done", glob: "*.pdf" });
  w.watch(a);
  const inFlight = w.poll(5_000, [a]);
  writeFileSync(join(dl, "slept.pdf"), "landed while the Mac slept");
  assert.deepEqual([...w.rebaseline()], [["auto_a", 1]], "counted by the resync");
  assert.deepEqual(await inFlight, []);
  assert.deepEqual(await w.poll(10_000, [a]), []);
  assert.deepEqual(await w.poll(15_000, [a]), [], "never replayed");
});
