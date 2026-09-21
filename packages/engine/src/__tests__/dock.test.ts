import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LSREGISTER, dictGet, dictSet, parsePlistXml, readDock, serializePlistXml, type Exec } from "@jarhead/install";
import type { Problem, ProblemKind } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { rows, until, world, type World } from "./world.ts";

/**
 * One Jarhead in the Dock (REDESIGN §14, "Learned since"): the engine READS the Dock
 * 20 s after start — `defaults export com.apple.dock -` and `lsappinfo list` for the
 * Foreground helpers, never lsregister — and two Jarhead tiles become the typed problem
 * `dock` with Fix the Dock as its remedy. The fix runs only on `problem.retry {kind:"dock"}`
 * (Kevin's press): the Dock half of `pnpm jarhead dock --fix` — import behind the mod-count
 * check, `killall Dock` — then a re-read clears the row, and tick() reads once more 10 s
 * later. A helper alive is the tile no import removes: the row keeps its cause and the
 * press says "Dock written", never "fixed". Every command goes through a scripted exec;
 * no Dock, no file, no Trash is touched.
 */

// The sanitized exports of Kevin's own Dock, shared with the install library's tests.
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../install/src/__tests__/fixtures/${name}`, import.meta.url)), "utf8");
const TWO = fixture("dock-two-tiles.xml");
const CLEAN = fixture("dock-clean.xml");
const CLEANED = serializePlistXml(parsePlistXml(CLEAN));
// The reading hands helper as `lsappinfo list` printed it on 2026-09-17: LaunchServices checked it in as a
// second Foreground "Jarhead" from the same bundle — the second tile no plist repair removes.
const RUNNING_HELPER = fixture("lsappinfo-helper.txt");
const HELPER = { pid: 66017, bundleId: "com.kevinliu.jarhead", executable: "/Applications/Jarhead.app/Contents/MacOS/jarhead-hands", type: "Foreground" };
const HELPER_CLAUSE = "jarhead-hands pid 66017 is a Foreground app (the second tile) — the pin is fine; rebuild the helper (pnpm build:mac) and relaunch, then Fix the Dock clears the leftover";

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly timeoutMs?: number;
}

interface Script {
  readonly exports: readonly string[];
  /** A non-zero code fails every export from now on (the script is mutable: a test flips it mid-way). */
  exportCode?: number;
  importCode?: number;
  /** `killall Dock` exit codes, consumed in order (the last one repeats; default 0). */
  readonly killall?: readonly number[];
  /** What `lsappinfo list` prints (mutable: a helper exits mid-test); unset, the command is unknown (127) — nobody's tile, as on a headless run. */
  running?: string | undefined;
}

/** Exports are consumed in order (the last one repeats); import, killall and lsappinfo answer as scripted. */
function fake(script: Script): { exec: Exec; calls: Call[]; script: Script } {
  const calls: Call[] = [];
  const exports = [...script.exports];
  const killall = [...(script.killall ?? [])];
  const exec: Exec = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], ...(opts?.input !== undefined ? { input: opts.input } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (cmd === "defaults" && args[0] === "export") {
      if (script.exportCode) return { code: script.exportCode, stdout: "", stderr: "Domain com.apple.dock does not exist" };
      return { code: 0, stdout: exports.length > 1 ? (exports.shift() as string) : (exports[0] ?? CLEAN), stderr: "" };
    }
    if (cmd === "defaults" && args[0] === "import") return { code: script.importCode ?? 0, stdout: "", stderr: script.importCode ? "import failed" : "" };
    if (cmd === "killall") {
      const code = killall.length > 1 ? (killall.shift() as number) : (killall[0] ?? 0);
      return { code, stdout: "", stderr: code ? "No matching processes belonging to you were found" : "" };
    }
    if (cmd === "lsappinfo" && args[0] === "list" && script.running !== undefined) return { code: 0, stdout: script.running, stderr: "" };
    return { code: 127, stdout: "", stderr: `unexpected ${cmd}` };
  };
  return { exec, calls, script };
}

const argv = (calls: readonly Call[]): string[][] => calls.map((c) => [c.cmd, ...c.args.slice(0, 2)]);
const EXPORT = ["defaults", "export", "com.apple.dock"];
const IMPORT = ["defaults", "import", "com.apple.dock"];
const KILLALL = ["killall", "Dock"];
const RUNNING = ["lsappinfo", "list"];
const ofKind = (w: World, kind: ProblemKind): readonly Problem[] => w.engine.typedProblems().filter((p) => p.kind === kind);
const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();
const REMEDY = { label: "Fix the Dock", command: { type: "problem.retry", kind: "dock" } };

test("the Dock is read once, 20 s after start (shortened here) and read-only: two tiles raise `dock` — Two Jarhead tiles in the Dock, Fix the Dock — with one export, no import, no Dock restart, no lsregister", async () => {
  const { exec, calls } = fake({ exports: [TWO] });
  const w = world({ exec, dockAuditDelayMs: 30 });
  const { engine } = w;
  try {
    await engine.start();
    assert.equal(calls.length, 0, "not at start: the app's own launch is still moving tiles");
    assert.ok(await until(() => ofKind(w, "dock").length === 1), "the delayed read raised the row");
    const p = ofKind(w, "dock")[0]!;
    assert.equal(p.text, "Two Jarhead tiles in the Dock");
    assert.deepEqual(p.remedy, REMEDY);
    assert.equal(p.since, w.clock.t);
    assert.deepEqual(argv(calls), [EXPORT, RUNNING], "one export and one lsappinfo, nothing written, nothing restarted");
    assert.ok(!calls.some((c) => c.cmd === LSREGISTER), "never lsregister from the engine");
    assert.ok(calls.every((c) => c.timeoutMs === Engine.DOCK_EXEC_TIMEOUT_MS), "every Dock shell-out is capped: spawnSync on the daemon's event loop");
    assert.equal(Engine.DOCK_EXEC_TIMEOUT_MS, 3000);
    assert.ok(rows<{ type: string; text: string }>(w, "problem").some((r) => r.text === "Two Jarhead tiles in the Dock"), "one ledger row on the first sighting");
    assert.equal(engine.snapshot().problems.find((q) => q.kind === "dock")?.remedy?.label, "Fix the Dock");
    assert.equal(Engine.DOCK_AUDIT_DELAY_MS, 20_000);
  } finally {
    await engine.stop();
  }
});

test("a clean Dock raises nothing; a Dock that cannot be read (headless, `defaults` failing) raises nothing and throws nothing; the test world's own engine never shells out for real", async () => {
  const clean = fake({ exports: [CLEAN] });
  const w = world({ exec: clean.exec });
  try {
    await w.engine.start();
    const audit = w.engine.checkDock("test");
    assert.ok(audit);
    assert.equal(audit?.changes.length, 0);
    assert.equal(ofKind(w, "dock").length, 0);
    assert.deepEqual(argv(clean.calls), [EXPORT, RUNNING], "the plist and the running apps, both read-only");
  } finally {
    await w.engine.stop();
  }
  const failing = fake({ exports: [], exportCode: 1 });
  const w2 = world({ exec: failing.exec });
  try {
    await w2.engine.start();
    assert.equal(w2.engine.checkDock("test"), undefined);
    assert.equal(ofKind(w2, "dock").length, 0, "no Dock to read is not a problem of Kevin's");
  } finally {
    await w2.engine.stop();
  }
  const plain = world();
  try {
    await plain.engine.start();
    assert.equal(plain.engine.checkDock("test"), undefined, "the world's default exec answers 127: no test reads the real Dock");
  } finally {
    await plain.engine.stop();
  }
});

test("Fix the Dock (problem.retry dock) runs the repair — export, export (mod-count), import of the audited document, killall Dock, export — clears the row when the re-read is clean, toasts what it did, and tick() reads once more 10 s later", async () => {
  // Startup read: TWO. The fix: before TWO, mod-count TWO, (import, killall), after CLEANED. The 10 s recheck: CLEANED.
  const { exec, calls } = fake({ exports: [TWO, TWO, TWO, CLEANED, CLEANED] });
  const w = world({ exec });
  const { engine, clock } = w;
  try {
    await engine.start();
    engine.checkDock("startup");
    assert.equal(ofKind(w, "dock").length, 1);
    const before = calls.length;
    await engine.command({ type: "problem.retry", kind: "dock" });
    assert.deepEqual(argv(calls.slice(before)), [EXPORT, RUNNING, EXPORT, IMPORT, KILLALL, EXPORT], "one lsappinfo per press; the repair's re-reads are Dock exports only");
    assert.ok(!calls.some((c) => c.cmd === LSREGISTER));
    assert.ok(calls.slice(before).every((c) => c.timeoutMs === Engine.DOCK_EXEC_TIMEOUT_MS), "the import and the killall are capped like the reads");
    const imported = calls.find((c) => c.args[0] === "import");
    assert.deepEqual(imported?.args, ["import", "com.apple.dock", "-"], "stdin, never the plist file");
    const doc = parsePlistXml(imported?.input ?? "");
    const recent = dictGet(doc, "recent-apps");
    assert.equal(recent?.kind === "array" ? recent.items.length : -1, 1, "Jarhead's recent tile dropped, TextEdit kept");
    assert.equal(ofKind(w, "dock").length, 0, "the re-read is clean: the row is gone");
    assert.ok(w.events.some((e) => e.type === "toast" && /^Dock fixed: removed 1 recent tile, pin rebuilt$/.test(e.text)), JSON.stringify(w.events.filter((e) => e.type === "toast")));
    // Ticks before the recheck read nothing; the recheck reads once and stays quiet on a clean Dock.
    const n = calls.length;
    clock.t += Engine.DOCK_RECHECK_MS - 1000;
    tick(w);
    assert.equal(calls.length, n, "not yet");
    clock.t += 1000;
    tick(w);
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING], "one recheck");
    tick(w);
    assert.equal(calls.length, n + 2, "once, not every tick");
    assert.equal(ofKind(w, "dock").length, 0);
  } finally {
    await engine.stop();
  }
});

test("a Dock that grows the tile back after the fix gets its row back at the 10 s recheck; a repair whose import fails keeps the row with the reason and restarts nothing", async () => {
  const grows = fake({ exports: [TWO, TWO, TWO, CLEANED, TWO] });
  const w = world({ exec: grows.exec });
  try {
    await w.engine.start();
    w.engine.checkDock("startup");
    await w.engine.command({ type: "problem.retry", kind: "dock" });
    assert.equal(ofKind(w, "dock").length, 0);
    w.clock.t += Engine.DOCK_RECHECK_MS;
    tick(w);
    assert.equal(ofKind(w, "dock")[0]?.text, "Two Jarhead tiles in the Dock", "the Dock rewrote its domain: the row is back, the button too");
    assert.deepEqual(ofKind(w, "dock")[0]?.remedy, REMEDY);
  } finally {
    await w.engine.stop();
  }
  const bad = fake({ exports: [TWO], importCode: 1 });
  const w2 = world({ exec: bad.exec });
  try {
    await w2.engine.start();
    w2.engine.checkDock("startup");
    const since = ofKind(w2, "dock")[0]!.since;
    w2.clock.t += 5000;
    await w2.engine.command({ type: "problem.retry", kind: "dock" });
    assert.ok(!bad.calls.some((c) => c.cmd === "killall"), "nothing written → no Dock restart");
    const p = ofKind(w2, "dock");
    assert.equal(p.length, 1, "one row of the kind");
    assert.match(p[0]!.text, /^Two Jarhead tiles in the Dock — defaults import failed \(1\)/);
    assert.equal(p[0]!.since, since, "refreshed in place, first seen unchanged");
    assert.deepEqual(p[0]!.remedy, REMEDY);
  } finally {
    await w2.engine.stop();
  }
});

test("an import whose `killall Dock` failed is not a fix: the row stays (— Dock not restarted), the toast warns, no recheck is armed and a clean read keeps the row; the next press runs only the restart and clears it; a press whose read fails toasts why and leaves the row", async () => {
  // Startup TWO; first press: before TWO, mod-count TWO, import ok, killall FAILS, after CLEANED (cfprefsd's copy — not what the Dock draws).
  // Second press: before CLEANED (nothing to repair) → the owed killall succeeds → row gone; its recheck reads CLEANED.
  const toasts = (w: World): string[] => w.events.filter((e): e is Extract<typeof e, { type: "toast" }> => e.type === "toast").map((e) => `${e.tone}: ${e.text}`);
  const { exec, calls } = fake({ exports: [TWO, TWO, TWO, CLEANED, CLEANED, CLEANED], killall: [1, 0] });
  const w = world({ exec });
  const { engine, clock } = w;
  try {
    await engine.start();
    engine.checkDock("startup");
    const since = ofKind(w, "dock")[0]!.since;
    let n = calls.length;
    await engine.command({ type: "problem.retry", kind: "dock" });
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING, EXPORT, IMPORT, KILLALL, EXPORT], "the repair ran to the killall");
    const p = ofKind(w, "dock");
    assert.equal(p.length, 1);
    assert.equal(p[0]!.text, "Two Jarhead tiles in the Dock — Dock not restarted", "the re-read said clean, but the Dock never relaunched: not fixed");
    assert.equal(p[0]!.since, since, "the same row, refreshed");
    assert.deepEqual(p[0]!.remedy, REMEDY, "the button stays");
    assert.deepEqual(toasts(w).filter((t) => /Dock/.test(t)), ["warn: Dock written, not restarted — press Fix the Dock again"], "a warn, never 'Dock fixed'");
    // No recheck: a clean export is cfprefsd's import, not the truth, so nothing 10 s later could clear the row.
    n = calls.length;
    clock.t += Engine.DOCK_RECHECK_MS + 1000;
    tick(w);
    assert.equal(calls.length, n, "no recheck armed");
    // An audit that reads clean meanwhile keeps the row for the same reason.
    engine.checkDock("meanwhile");
    assert.equal(ofKind(w, "dock")[0]?.text, "Two Jarhead tiles in the Dock — Dock not restarted", "a clean read while the restart is owed changes nothing");
    // The next press: the document is already clean, so only the restart runs — and it lands.
    n = calls.length;
    await engine.command({ type: "problem.retry", kind: "dock" });
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING, KILLALL], "one read, the owed restart, no import");
    assert.equal(ofKind(w, "dock").length, 0, "restarted: the row is gone");
    assert.ok(toasts(w).includes("info: Dock fixed: restarted"), JSON.stringify(toasts(w)));
    n = calls.length;
    clock.t += Engine.DOCK_RECHECK_MS;
    tick(w);
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING], "this fix earns its recheck");
    assert.equal(ofKind(w, "dock").length, 0);
    // A press whose read fails: the row (raised by a read that worked) stays, and the press is seen — a warn toast, nothing written.
    engine.checkDock("again");
    assert.equal(ofKind(w, "dock").length, 0);
    const two = fake({ exports: [TWO] });
    const w2 = world({ exec: two.exec });
    try {
      await w2.engine.start();
      w2.engine.checkDock("startup");
      assert.equal(ofKind(w2, "dock").length, 1);
      two.script.exportCode = 1;
      const m = two.calls.length;
      await w2.engine.command({ type: "problem.retry", kind: "dock" });
      assert.deepEqual(argv(two.calls.slice(m)), [EXPORT], "one failed read, nothing else — not even lsappinfo");
      assert.equal(ofKind(w2, "dock")[0]?.text, "Two Jarhead tiles in the Dock", "the row stands");
      assert.deepEqual(toasts(w2).filter((t) => /Dock/.test(t)), ["warn: Could not read the Dock: defaults export failed (1)"]);
    } finally {
      await w2.engine.stop();
    }
  } finally {
    await engine.stop();
  }
});

test("a Foreground jarhead-hands alive: the row names it from the startup read on; Fix the Dock still drops the leftover but keeps the row with the cause and toasts 'Dock written — …rebuild…', never 'Dock fixed'; a clean plist with the helper alive writes nothing; once the helper is gone the leftover's fix clears the row", async () => {
  const toasts = (w: World): string[] => w.events.filter((e): e is Extract<typeof e, { type: "toast" }> => e.type === "toast").map((e) => `${e.tone}: ${e.text}`);
  const WITH_HELPER = `Two Jarhead tiles in the Dock — ${HELPER_CLAUSE}`;
  const WRITTEN = "warn: Dock written — the helper's tile returns while it lives; rebuild (pnpm build:mac) and relaunch";
  // Startup TWO (the helper's tile already parked once). Press 1: before TWO, mod-count TWO, import, killall, after CLEANED — and the
  // helper still checked in. Recheck: CLEANED. Press 2 (plist clean, helper alive): before CLEANED, nothing to write. Then the helper
  // exits and the Dock parks its leftover again: TWO; press 3 repairs it for good: TWO, TWO, import, killall, CLEANED; recheck CLEANED.
  const { exec, calls, script } = fake({ exports: [TWO, TWO, TWO, CLEANED, CLEANED, CLEANED, TWO, TWO, TWO, CLEANED, CLEANED], running: RUNNING_HELPER });
  const w = world({ exec });
  const { engine, clock } = w;
  try {
    await engine.start();
    engine.checkDock("startup");
    const p0 = ofKind(w, "dock");
    assert.equal(p0.length, 1);
    assert.equal(p0[0]!.text, WITH_HELPER, "the startup read names the helper as the second tile");
    assert.deepEqual(p0[0]!.remedy, REMEDY, "Fix the Dock stays the remedy: it clears the leftover");
    const since = p0[0]!.since;
    // Press 1: the leftover goes, the tile stays — the row keeps its cause; the toast never says fixed.
    let n = calls.length;
    await engine.command({ type: "problem.retry", kind: "dock" });
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING, EXPORT, IMPORT, KILLALL, EXPORT], "the repair ran; one lsappinfo per press");
    const imported = calls.find((c) => c.args[0] === "import");
    const recent = dictGet(parsePlistXml(imported?.input ?? ""), "recent-apps");
    assert.equal(recent?.kind === "array" ? recent.items.length : -1, 1, "the persisted leftover was dropped all the same");
    let p = ofKind(w, "dock");
    assert.equal(p.length, 1, "the row stands");
    assert.equal(p[0]!.text, WITH_HELPER, "the re-read is a clean plist, but the helper still draws its tile");
    assert.equal(p[0]!.since, since, "refreshed in place");
    assert.deepEqual(toasts(w).filter((t) => /Dock/.test(t)), [WRITTEN], "written, not fixed");
    assert.ok(!toasts(w).some((t) => /Dock fixed/.test(t)), "never 'Dock fixed' with a helper alive");
    // The 10 s recheck reads the clean plist and the living helper: the row stays as it is.
    n = calls.length;
    clock.t += Engine.DOCK_RECHECK_MS;
    tick(w);
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING]);
    assert.equal(ofKind(w, "dock")[0]?.text, WITH_HELPER, "the recheck keeps the cause");
    // Press 2 on a clean plist: nothing to write, nothing restarted; the row and its cause stay, the toast says so.
    n = calls.length;
    w.events.length = 0;
    await engine.command({ type: "problem.retry", kind: "dock" });
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING], "no import, no killall");
    assert.equal(ofKind(w, "dock")[0]?.text, WITH_HELPER);
    assert.deepEqual(toasts(w).filter((t) => /Dock/.test(t)), ["warn: Dock unchanged — the helper's tile returns while it lives; rebuild (pnpm build:mac) and relaunch"]);
    // The helper exits (rebuilt and relaunched, or the daemon reaped it); the Dock parks its leftover once more.
    script.running = undefined;
    w.events.length = 0;
    engine.checkDock("later");
    assert.equal(ofKind(w, "dock")[0]?.text, "Two Jarhead tiles in the Dock", "no helper: today's line, no clause");
    n = calls.length;
    await engine.command({ type: "problem.retry", kind: "dock" });
    assert.deepEqual(argv(calls.slice(n)), [EXPORT, RUNNING, EXPORT, IMPORT, KILLALL, EXPORT]);
    assert.equal(ofKind(w, "dock").length, 0, "the leftover was the last tile: fixed");
    assert.deepEqual(toasts(w).filter((t) => /Dock/.test(t)), ["info: Dock fixed: removed 1 recent tile, pin rebuilt"]);
  } finally {
    await engine.stop();
  }
});

test("dockProblemText: two tiles with a pin is the line; more is the count; a recent tile with no pin is one tile and no row; a pin at a stale path names it", () => {
  // The text is a static function of the pure audit (readDock); no engine needed.
  const read = (xml: string): Parameters<typeof Engine.dockProblemText>[0] => {
    const a = readDock(fake({ exports: [xml] }).exec);
    if ("skipped" in a) throw new Error(a.skipped);
    return a;
  };
  const two = parsePlistXml(TWO);
  const clean = parsePlistXml(CLEAN);
  assert.equal(Engine.dockProblemText(read(TWO)), "Two Jarhead tiles in the Dock");
  assert.equal(Engine.dockProblemText(read(CLEAN)), undefined);
  // Three tiles: the pin plus two recents.
  const recents = dictGet(two, "recent-apps");
  assert.equal(recents?.kind, "array");
  if (recents?.kind !== "array") return;
  const three = dictSet(two, "recent-apps", { kind: "array", items: [...recents.items, recents.items[0]!] });
  assert.equal(Engine.dockProblemText(read(serializePlistXml(three))), "3 Jarhead tiles in the Dock");
  // Unpinned, one recent: one tile — nothing the fix could do, so no row (pinning is Kevin's).
  const apps = dictGet(clean, "persistent-apps");
  assert.equal(apps?.kind, "array");
  if (apps?.kind !== "array") return;
  const unpinned = dictSet(dictSet(clean, "persistent-apps", { kind: "array", items: [apps.items[0]!] }), "recent-apps", recents);
  assert.equal(Engine.dockProblemText(read(serializePlistXml(unpinned))), undefined);
  // A pin at the old build path.
  assert.equal(Engine.dockProblemText(read(fixture("dock-stale-url.xml"))), "The Dock's Jarhead pin points at file:///Users/kevinliu/jarvis/build/Jarhead.app/");
  assert.deepEqual(Engine.DOCK_REMEDY, REMEDY);
});

test("dockProblemText with helperTiles: a clean plist and one Foreground jarhead-hands is two tiles with the cause and the Console's remedy; the same helper over a recent tile is still two, not three; no helper is today's line", () => {
  const read = (xml: string): Parameters<typeof Engine.dockProblemText>[0] => {
    const a = readDock(fake({ exports: [xml] }).exec);
    if ("skipped" in a) throw new Error(a.skipped);
    return a;
  };
  const clean = read(CLEAN);
  assert.equal(clean.pinned, 1);
  assert.equal(clean.recent, 0);
  // The helper's tile is drawn before `recent-apps` has caught up: the row names it, the pin is fine.
  assert.equal(Engine.dockProblemText({ ...clean, helperTiles: [HELPER] }), `Two Jarhead tiles in the Dock — ${HELPER_CLAUSE}`);
  // The leftover already in `recent-apps` is the helper's own tile parked: one tile, not one more.
  const two = read(TWO);
  assert.equal(two.recent, 1);
  assert.equal(Engine.dockProblemText({ ...two, helperTiles: [HELPER] }), `Two Jarhead tiles in the Dock — ${HELPER_CLAUSE}`);
  // Two helpers over the one leftover: three tiles, both pids.
  assert.equal(Engine.dockProblemText({ ...two, helperTiles: [HELPER, { ...HELPER, pid: 66020 }] }), "3 Jarhead tiles in the Dock — jarhead-hands pids 66017, 66020 are Foreground apps (the extra tiles) — the pin is fine; rebuild the helper (pnpm build:mac) and relaunch, then Fix the Dock clears the leftover");
  // No helper (an empty list, or nobody read `lsappinfo`): today's lines, no clause.
  assert.equal(Engine.dockProblemText({ ...two, helperTiles: [] }), "Two Jarhead tiles in the Dock");
  assert.equal(Engine.dockProblemText({ ...clean, helperTiles: [] }), undefined);
  assert.equal(Engine.dockProblemText(clean), undefined);
});
