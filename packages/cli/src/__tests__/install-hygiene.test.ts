import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PIN_KEYS, INSTALLED_URL, describeHelperTiles, helperTilesOf, parseLsAppInfoList } from "../install/dock.ts";
import { LSREGISTER } from "../install/launchservices.ts";
import { LSAPPINFO, LSREGISTER_TIMEOUT_MS, installedUrlOf, readDock, readRunning, repairDock, restartDock, runHygiene, type Exec, type ExecResult } from "../install/hygiene.ts";
import { dictGet, dictSet, int, parsePlistXml, serializePlistXml, stringAt } from "../install/plist.ts";

/**
 * The one-Jarhead pass with a scripted exec: which commands run, in which order, with
 * which argv, and what goes to `defaults import`'s stdin. No Dock, no LaunchServices
 * database, no file is touched — every case runs in CI.
 */

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const TWO = fixture("dock-two-tiles.xml");
const CLEAN = fixture("dock-clean.xml");
const DUMP = fixture("ls-dump-bundle.txt");
const SEP = "--------------------------------------------------------------------------------";
const INSTALLED = "/Applications/Jarhead.app";
const ROOTS = ["/Users/kevinliu/.jarhead/worktrees", "/Users/kevinliu/.jarhead/trash", "/Users/kevinliu/.Trash", "/Users/kevinliu/jarvis/build/stage", "/Users/kevinliu/jarvis/build/previous"];
const STALE = ["/Users/kevinliu/.jarhead/worktrees/se_x/apps/mac/.build/ear-probe/EarProbe.app", "/Users/kevinliu/.Trash/Jarhead.app", "/Users/kevinliu/jarvis/build/stage/Jarhead.app"];

// `lsappinfo list` as Kevin's Mac printed it on 2026-09-17: the app (the pinned tile), a node
// process with no bundle, and — RUNNING_HELPER only — the reading hands helper LaunchServices
// checked in as a second Foreground "Jarhead" from the same bundle (the second Dock tile).
const RUNNING_APP = `115) "Jarhead" ASN:0x0-0xd23822b: 
    bundleID="com.kevinliu.jarhead"
    bundle path="/Applications/Jarhead.app"
    executable path="/Applications/Jarhead.app/Contents/MacOS/Jarhead"
    pid = 3125 type="Foreground" flavor=3 Version="2.0.0" fileType="APPL" creator="????" Arch=ARM64 
    coalition: 92615  { 3125 3390 3391 3393 3394 66017 }
    launch time =  2026/09/16 16:48:05 ( 18 hours, 44 minutes, 59.712 seconds ago )
    checkin time = 2026/09/16 16:48:05 ( 18 hours, 44 minutes, 59.3858 seconds ago )
116) "npm exec vite --port 5198 --strictPort" ASN:0x0-0xdba4b97: 
    bundleID=[ NULL ] 
    bundle path="/Users/kevinliu/.nvm/versions/node/v24.13.0/bin/node"
    executable path="/Users/kevinliu/.nvm/versions/node/v24.13.0/bin/node"
    pid = 52305 !cgsConnection !signalled type="BackgroundOnly" flavor=[ NULL ]  Version=[ NULL ]  Arch=ARM64 
    checkin time = 2026/09/17 10:07:44 ( 1 hours, 25 minutes, 20.4732 seconds ago )
`;
const HELPER_BLOCK = `122) "Jarhead" ASN:0x0-0xdbb8bab: 
    bundleID="com.kevinliu.jarhead"
    bundle path="/Applications/Jarhead.app"
    executable path="/Applications/Jarhead.app/Contents/MacOS/jarhead-hands"
    pid = 66017 !signalled type="Foreground" flavor=3 Version="2.0.0" fileType="APPL" creator="????" Arch=ARM64 
    parentASN="Jarhead" ASN:0x0-0xd23822b:  (inferred)
    checkin time = 2026/09/17 10:32:45 ( 1 hours, 19.5711 seconds ago )
`;
const RUNNING_HELPER = RUNNING_APP + HELPER_BLOCK;
/** The Bundle table after the -u loop did its work: the stale records gone, everything else kept. */
const CLEAN_DUMP = DUMP.split(SEP).filter((b) => !STALE.some((p) => b.includes(p))).join(SEP);
const HELPER = { pid: 66017, bundleId: "com.kevinliu.jarhead", executable: "/Applications/Jarhead.app/Contents/MacOS/jarhead-hands", type: "Foreground" };
const CLAUSE = "jarhead-hands pid 66017 is a Foreground app (the second tile) — the pin is fine; rebuild the helper (pnpm build:mac) and relaunch, then dock --fix clears the leftover";

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly timeoutMs?: number;
}

/** Answers by (cmd, first args); exports are consumed in order so a race can be scripted. */
function fake(script: { exports: readonly string[]; dumps?: readonly string[]; dumpResult?: ExecResult; unregisterFails?: readonly string[]; importCode?: number; killallCode?: number; exportCode?: number; running?: string; runningResult?: ExecResult }): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exports = [...script.exports];
  const dumps = [...(script.dumps ?? [DUMP, DUMP])];
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const exec: Exec = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], ...(opts?.input !== undefined ? { input: opts.input } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (cmd === LSREGISTER) {
      if (args[0] === "-dump") return script.dumpResult ?? ok(dumps.shift() ?? "");
      if (args[0] === "-u" && script.unregisterFails?.includes(args[1] ?? "")) return { code: 1, stdout: "", stderr: "lsregister: unregister failed" };
      return ok();
    }
    if (cmd === "defaults" && args[0] === "export") {
      if (script.exportCode) return { code: script.exportCode, stdout: "", stderr: "Domain com.apple.dock does not exist" };
      return ok(exports.shift() ?? exports.at(-1) ?? CLEAN);
    }
    if (cmd === "defaults" && args[0] === "import") return { code: script.importCode ?? 0, stdout: "", stderr: script.importCode ? "import failed" : "" };
    if (cmd === "killall") return { code: script.killallCode ?? 0, stdout: "", stderr: "" };
    if (cmd === LSAPPINFO && args[0] === "list") return script.runningResult ?? ok(script.running ?? RUNNING_APP);
    return { code: 127, stdout: "", stderr: `unexpected ${cmd}` };
  };
  return { exec, calls };
}

const argv = (calls: readonly Call[]): string[][] => calls.map((c) => [c.cmd === LSREGISTER ? "lsregister" : c.cmd, ...c.args.slice(0, 2)]);
const base = { installed: INSTALLED, staleRoots: ROOTS, exists: () => true, log: () => undefined };

test("hygiene fix, two tiles: -f, dump, -u per stale path, re-dump, export, export (mod-count), import of the audited document, killall Dock, export (after)", () => {
  const CLEANED = serializePlistXml(parsePlistXml(CLEAN));
  const { exec, calls } = fake({ exports: [TWO, TWO, CLEANED], dumps: [DUMP, CLEAN_DUMP] });
  const r = runHygiene({ ...base, mode: "fix", exec });
  assert.deepEqual(argv(calls), [
    ["lsregister", "-f", INSTALLED],
    ["lsregister", "-dump", "Bundle"],
    ["lsregister", "-u", STALE[0]!],
    ["lsregister", "-u", STALE[1]!],
    ["lsregister", "-u", STALE[2]!],
    ["lsregister", "-dump", "Bundle"],
    ["lsappinfo", "list"],
    ["defaults", "export", "com.apple.dock"],
    ["defaults", "export", "com.apple.dock"],
    ["defaults", "import", "com.apple.dock"],
    ["killall", "Dock"],
    ["defaults", "export", "com.apple.dock"],
  ]);
  const imported = calls.find((c) => c.args[0] === "import");
  assert.deepEqual(imported?.args, ["import", "com.apple.dock", "-"], "stdin, never the plist file");
  const doc = parsePlistXml(imported?.input ?? "");
  const recent = dictGet(doc, "recent-apps");
  assert.equal(recent?.kind === "array" ? recent.items.length : -1, 1, "Jarhead's recent tile dropped, TextEdit kept");
  const apps = dictGet(doc, "persistent-apps");
  const pin = apps?.kind === "array" ? dictGet(apps.items[1]!, "tile-data") : undefined;
  assert.ok(pin && pin.kind === "dict");
  assert.deepEqual(pin.entries.map(([k]) => k), [...PIN_KEYS], "the pin keeps its dates; only the bookmark went");
  assert.equal(stringAt(dictGet(pin, "file-data")!, "_CFURLString"), INSTALLED_URL);
  assert.equal(r.dock.imported, true);
  assert.equal(r.dock.restarted, true);
  assert.equal(r.dock.rounds, 1);
  assert.deepEqual(r.launchServices.unregistered, STALE);
  assert.deepEqual(r.launchServices.remaining, [], "the re-dump proves it");
  assert.equal(r.launchServices.refreshed, true);
  assert.match(r.line, /^one jarhead  LaunchServices: \/Applications\/Jarhead\.app registered · 3 stale records unregistered · Dock: 1 pinned, 0 recent \(removed 1 recent tile, pin rebuilt, Dock restarted\)$/);
});

test("hygiene fix, clean Dock: no import, no killall; the line says untouched", () => {
  const { exec, calls } = fake({ exports: [CLEAN], dumps: [DUMP.split("--------------------------------------------------------------------------------")[0]! + "--------------------------------------------------------------------------------" + DUMP.split("--------------------------------------------------------------------------------")[1]!] });
  const r = runHygiene({ ...base, mode: "fix", exec });
  assert.ok(!calls.some((c) => c.args[0] === "import"));
  assert.ok(!calls.some((c) => c.cmd === "killall"));
  assert.equal(calls.filter((c) => c.args[0] === "export").length, 1, "one export is enough when nothing changes");
  assert.equal(r.dock.imported, false);
  assert.equal(r.dock.after, r.dock.before);
  assert.deepEqual(r.launchServices.unregistered, []);
  assert.equal(r.line, "one jarhead  LaunchServices: /Applications/Jarhead.app registered · Dock: 1 pinned, 0 recent (untouched)");
});

test("hygiene fix, Dock race: a mod-count that moved re-audits the fresh document; the import lands on the second round; one round only → skipped, nothing written", () => {
  const moved = serializePlistXml(dictSet(parsePlistXml(TWO), "mod-count", int("1428")));
  const { exec, calls } = fake({ exports: [TWO, moved, moved, CLEAN] });
  const r = runHygiene({ ...base, mode: "fix", exec });
  assert.equal(r.dock.rounds, 2);
  assert.equal(r.dock.imported, true);
  const imported = calls.find((c) => c.args[0] === "import");
  assert.match(imported?.input ?? "", /<integer>1428<\/integer>/, "the imported document is the fresh one");
  assert.equal(r.dock.skipped, undefined);

  const one = fake({ exports: [TWO, moved, moved] });
  const r1 = runHygiene({ ...base, mode: "fix", exec: one.exec, maxDockRounds: 1 });
  assert.equal(r1.dock.imported, false);
  assert.ok(!one.calls.some((c) => c.args[0] === "import" || c.cmd === "killall"));
  assert.match(r1.dock.skipped ?? "", /kept changing; rerun pnpm jarhead dock --fix/);
  assert.match(r1.line, /two tiles — the Dock kept changing/);
});

test("hygiene: an export that fails or a domain without persistent-apps skips the Dock; a failed import restarts nothing", () => {
  const failed = fake({ exports: [], exportCode: 1 });
  const r = runHygiene({ ...base, mode: "fix", exec: failed.exec });
  assert.match(r.dock.skipped ?? "", /defaults export failed/);
  assert.ok(!failed.calls.some((c) => c.args[0] === "import"));
  assert.match(r.line, /Dock: not read — defaults export failed/);

  const empty = fake({ exports: ['<?xml version="1.0"?><plist version="1.0"><dict><key>mod-count</key><integer>1</integer></dict></plist>'] });
  assert.match(runHygiene({ ...base, mode: "fix", exec: empty.exec }).dock.skipped ?? "", /no persistent-apps/);

  const badImport = fake({ exports: [TWO, TWO], importCode: 1 });
  const r2 = runHygiene({ ...base, mode: "fix", exec: badImport.exec });
  assert.equal(r2.dock.imported, false);
  assert.ok(!badImport.calls.some((c) => c.cmd === "killall"), "no restart for a Dock that was not written");
  assert.match(r2.dock.skipped ?? "", /import failed/);
});

test("hygiene audit (doctor, `jarhead dock`): dump and export only — no -f, no -u, no import, no killall; the line points at --fix", () => {
  const { exec, calls } = fake({ exports: [TWO] });
  const r = runHygiene({ ...base, mode: "audit", exec });
  assert.deepEqual(argv(calls), [
    ["lsregister", "-dump", "Bundle"],
    ["lsappinfo", "list"],
    ["defaults", "export", "com.apple.dock"],
  ]);
  assert.equal(r.launchServices.refreshed, false);
  assert.deepEqual(r.running, { helperTiles: [] }, "the app's own Foreground process is the pinned tile, not a helper");
  assert.deepEqual(r.launchServices.unregistered, []);
  assert.deepEqual(r.launchServices.remaining.map((x) => x.path), STALE, "what a fix would unregister");
  assert.equal(r.dock.imported, false);
  assert.equal(r.line, `one jarhead  LaunchServices: /Applications/Jarhead.app registered · also ${STALE.join(", ")} · Dock: 1 pinned, 1 recent — two tiles (pnpm jarhead dock --fix repairs it)`);
});

test("hygiene install (pnpm build:mac): LaunchServices is refreshed and cleaned with ONE dump — the -u exit codes are the report — and the Dock is only read", () => {
  const { exec, calls } = fake({ exports: [TWO] });
  const r = runHygiene({ ...base, mode: "install", exec });
  assert.deepEqual(
    calls.filter((c) => c.cmd === LSREGISTER).map((c) => c.args),
    [["-f", INSTALLED], ["-dump", "Bundle"], ["-u", STALE[0]!], ["-u", STALE[1]!], ["-u", STALE[2]!]],
    "no second dump: a slow lsd would make a build pay it twice for nothing",
  );
  assert.ok(!calls.some((c) => c.args[0] === "import" || c.cmd === "killall"));
  assert.ok(!calls.some((c) => c.args[0] === "-u" && (c.args[1] === INSTALLED || c.args[1] === "/Users/kevinliu/jarvis/apps/mac/.build/ear-probe/EarProbe.app")), "never the installed bundle or the live checkout's probe");
  assert.deepEqual(r.launchServices.unregistered, STALE);
  assert.deepEqual(r.launchServices.remaining, []);
  assert.equal(r.dock.imported, false);
  assert.match(r.line, /^one jarhead  LaunchServices: \/Applications\/Jarhead\.app registered · 3 stale records unregistered · Dock: 1 pinned, 1 recent — two tiles \(pnpm jarhead dock --fix repairs it\)$/);

  // A -u that fails stays in `remaining` and on the line; verifyUnregister brings the second dump back.
  const failing = fake({ exports: [TWO], unregisterFails: [STALE[1]!] });
  const r2 = runHygiene({ ...base, mode: "install", exec: failing.exec });
  assert.deepEqual(r2.launchServices.unregistered, [STALE[0], STALE[2]]);
  assert.deepEqual(r2.launchServices.remaining.map((x) => x.path), [STALE[1]]);
  assert.match(r2.line, /2 stale records unregistered · also \/Users\/kevinliu\/\.Trash\/Jarhead\.app/);
  const verified = fake({ exports: [TWO] });
  runHygiene({ ...base, mode: "install", exec: verified.exec, verifyUnregister: true });
  assert.equal(verified.calls.filter((c) => c.args[0] === "-dump").length, 2);
  // The re-dump is the proof: a -u that exited 0 but left its row (the Trash copy, 2026-09-16) is named in the log and stays in `remaining`.
  const lines: string[] = [];
  const lying = fake({ exports: [TWO], dumps: [DUMP, DUMP] });
  const r3 = runHygiene({ ...base, mode: "fix", exec: lying.exec, log: (l) => void lines.push(l) });
  assert.deepEqual(r3.launchServices.unregistered, STALE, "-u exited 0 three times");
  assert.deepEqual(r3.launchServices.remaining.map((x) => x.path), STALE, "the second dump still holds them");
  assert.ok(lines.some((l) => l === `[one-jarhead] lsregister -u /Users/kevinliu/.Trash/Jarhead.app exited 0 but the record is still in the Bundle table`), lines.join("\n"));
  assert.match(r3.line, /registered · also \/Users\/kevinliu\/\.jarhead\/worktrees.*, \/Users\/kevinliu\/\.Trash\/Jarhead\.app, /, "the line counts only what the re-dump proves gone");
  assert.ok(!/stale records unregistered/.test(r3.line));
});

test("hygiene: a Foreground jarhead-hands in `lsappinfo list` is a helper tile — the line names the pid and the rebuild, never `--fix repairs it`; a fix still drops the leftover but says not repaired; a clean plist with the helper alive is still two tiles", () => {
  // audit (doctor, `jarhead dock`): the clause replaces the --fix promise.
  const audit = fake({ exports: [TWO], running: RUNNING_HELPER });
  const r = runHygiene({ ...base, mode: "audit", exec: audit.exec });
  assert.deepEqual(r.running, { helperTiles: [HELPER] });
  assert.deepEqual(r.dock.before?.helperTiles, [HELPER], "the audit the doctor and the engine read carries the cause");
  assert.equal(r.line, `one jarhead  LaunchServices: /Applications/Jarhead.app registered · also ${STALE.join(", ")} · Dock: 1 pinned, 1 recent — two tiles; ${CLAUSE}`);
  assert.ok(!/repairs it/.test(r.line));
  // fix: the recent-apps leftover goes (it is a leftover), the pin is rebuilt, and the line refuses to call that repaired.
  const CLEANED = serializePlistXml(parsePlistXml(CLEAN));
  const fix = fake({ exports: [TWO, TWO, CLEANED], dumps: [DUMP, CLEAN_DUMP], running: RUNNING_HELPER });
  const f = runHygiene({ ...base, mode: "fix", exec: fix.exec });
  assert.equal(f.dock.imported, true, "the persisted leftover is still removed");
  assert.equal(f.dock.restarted, true);
  assert.equal(fix.calls.filter((c) => c.cmd === LSAPPINFO).length, 1, "one lsappinfo read per pass; the repair's re-reads are Dock exports only");
  assert.deepEqual(f.dock.after?.helperTiles, [HELPER], "the helper outlives the repair");
  assert.match(f.line, new RegExp(`Dock: 1 pinned, 0 recent; ${CLAUSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(removed 1 recent tile, pin rebuilt, Dock restarted — not repaired: the helper's tile returns while it lives\\)$`));
  assert.ok(!/repairs it/.test(f.line));
  // a clean plist while the helper lives: the Dock draws the running tile before it writes recent-apps.
  const clean = fake({ exports: [CLEAN], dumps: [DUMP, CLEAN_DUMP], running: RUNNING_HELPER });
  const c = runHygiene({ ...base, mode: "fix", exec: clean.exec });
  assert.equal(c.dock.imported, false, "nothing in the plist to repair");
  assert.equal(c.line, `one jarhead  LaunchServices: /Applications/Jarhead.app registered · 3 stale records unregistered · Dock: 1 pinned, 0 recent; ${CLAUSE} (untouched)`);
});

test("hygiene: no helper in `lsappinfo list` (the app alone, a node process, a BackgroundOnly helper) is today's line; a failed or throwing lsappinfo skips the read, keeps the Dock half and says so", () => {
  const quiet = RUNNING_APP + HELPER_BLOCK.replace('type="Foreground"', 'type="BackgroundOnly"');
  const r = runHygiene({ ...base, mode: "audit", exec: fake({ exports: [TWO], running: quiet }).exec });
  assert.deepEqual(r.running, { helperTiles: [] }, "a helper that set its activation policy is not a tile");
  assert.equal(r.line, `one jarhead  LaunchServices: /Applications/Jarhead.app registered · also ${STALE.join(", ")} · Dock: 1 pinned, 1 recent — two tiles (pnpm jarhead dock --fix repairs it)`);
  assert.equal(r.dock.before?.helperTiles, undefined, "no helpers → the audit is the plain plist audit");
  const failed = runHygiene({ ...base, mode: "audit", exec: fake({ exports: [TWO], runningResult: { code: 1, stdout: "", stderr: "lsappinfo: no LaunchServices\nmore" } }).exec });
  assert.deepEqual(failed.running, { helperTiles: [], skipped: "lsappinfo list failed (1): lsappinfo: no LaunchServices" });
  assert.equal(failed.dock.before?.recent, 1, "the Dock is still read");
  assert.match(failed.line, / · running: skipped \(lsappinfo list failed \(1\): lsappinfo: no LaunchServices\)$/);
  // The doctor's scripted exec throws on a command it did not expect: a throw reads as skipped, never as a crash of the whole pass.
  const throwing: Exec = (cmd, args, opts) => {
    if (cmd === LSAPPINFO) throw new Error("unexpected lsappinfo list");
    return fake({ exports: [TWO] }).exec(cmd, args, opts);
  };
  const t = runHygiene({ ...base, mode: "audit", exec: throwing });
  assert.equal(t.running.skipped, "lsappinfo list threw: unexpected lsappinfo list");
  assert.equal(t.dock.before?.pinned, 1);
  // readRunning alone: `lsappinfo list`, the cap when given, the rule applied.
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    return { code: 0, stdout: RUNNING_HELPER, stderr: "" };
  };
  assert.deepEqual(readRunning(exec, { timeoutMs: 3000 }), { helperTiles: [HELPER] });
  assert.deepEqual(calls, [{ cmd: "lsappinfo", args: ["list"], timeoutMs: 3000 }]);
  assert.deepEqual(readRunning(exec), { helperTiles: [HELPER] });
  assert.equal(calls[1]?.timeoutMs, undefined, "no cap unless asked (the CLI keeps defaultExec's 20 s)");
});

test("lsappinfo list parsing: a block per process with pid, bundleID (NULL → undefined), executable path and type; the helper rule is Jarhead's id + Foreground + not the app's own executable; the clause names pids", () => {
  const apps = parseLsAppInfoList(RUNNING_HELPER);
  assert.deepEqual(apps, [
    { pid: 3125, bundleId: "com.kevinliu.jarhead", executable: "/Applications/Jarhead.app/Contents/MacOS/Jarhead", type: "Foreground" },
    { pid: 52305, bundleId: undefined, executable: "/Users/kevinliu/.nvm/versions/node/v24.13.0/bin/node", type: "BackgroundOnly" },
    HELPER,
  ]);
  assert.deepEqual(helperTilesOf(apps), [HELPER]);
  assert.deepEqual(helperTilesOf(apps, { installed: "/Users/kevinliu/jarvis/build/stage/Jarhead.app" }).map((a) => a.pid), [3125, 66017], "a different install path makes the /Applications app a helper too");
  assert.deepEqual(helperTilesOf(apps, { bundleId: "com.kevinliu.jarvis" }), []);
  assert.deepEqual(parseLsAppInfoList(""), []);
  assert.deepEqual(parseLsAppInfoList('1) "gone" ASN:0x0-0x1:\n    bundleID=[ NULL ] \n    pid =  !cgsConnection type=[ NULL ]\n'), [], "an ASN without a pid is skipped");
  assert.equal(describeHelperTiles([HELPER]), CLAUSE);
  assert.equal(describeHelperTiles([HELPER], "Fix the Dock"), CLAUSE.replace("then dock --fix clears", "then Fix the Dock clears"));
  assert.equal(describeHelperTiles([HELPER, { ...HELPER, pid: 66020 }]), "jarhead-hands pids 66017, 66020 are Foreground apps (the extra tiles) — the pin is fine; rebuild the helper (pnpm build:mac) and relaunch, then dock --fix clears the leftover");
  assert.equal(describeHelperTiles([]), "");
});

test("hygiene: every lsregister call gets the long timeout (the Bundle dump is 2 s idle, over a minute under load); lsTimeoutMs overrides it", () => {
  const { exec, calls } = fake({ exports: [TWO] });
  runHygiene({ ...base, mode: "fix", exec });
  const ls = calls.filter((c) => c.cmd === LSREGISTER);
  assert.ok(ls.length >= 5);
  assert.ok(LSREGISTER_TIMEOUT_MS >= 120_000, `${LSREGISTER_TIMEOUT_MS}`);
  for (const c of ls) assert.equal(c.timeoutMs, LSREGISTER_TIMEOUT_MS, `${c.args.join(" ")} waits long enough for lsd`);
  const tuned = fake({ exports: [TWO] });
  runHygiene({ ...base, mode: "audit", exec: tuned.exec, lsTimeoutMs: 5_000 });
  assert.equal(tuned.calls.find((c) => c.args[0] === "-dump")?.timeoutMs, 5_000);
});

test("hygiene: a dump that times out or fails carries its reason (the ETIMEDOUT text) into launchServices.skipped, the log and the line; nothing is unregistered", () => {
  const timedOut: ExecResult = { code: 1, stdout: "", stderr: `spawnSync ${LSREGISTER} ETIMEDOUT` };
  const logged: string[] = [];
  const { exec, calls } = fake({ exports: [TWO], dumpResult: timedOut });
  const r = runHygiene({ ...base, mode: "install", exec, log: (l) => void logged.push(l) });
  assert.equal(r.launchServices.skipped, `lsregister -dump Bundle failed (1): spawnSync ${LSREGISTER} ETIMEDOUT`);
  assert.ok(!calls.some((c) => c.args[0] === "-u"), "no stale rule without a table");
  assert.equal(r.launchServices.refreshed, true, "-f still ran");
  assert.match(r.line, /^one jarhead  LaunchServices: skipped \(lsregister -dump Bundle failed \(1\): spawnSync .*ETIMEDOUT\) · Dock: 1 pinned, 1 recent — two tiles/);
  assert.ok(logged.some((l) => /ETIMEDOUT/.test(l)), "the reason reaches the build log");
  // Only the first line of a chatty stderr travels.
  const chatty = fake({ exports: [TWO], dumpResult: { code: 2, stdout: "", stderr: "first line\nsecond line\n" } });
  assert.equal(runHygiene({ ...base, mode: "audit", exec: chatty.exec }).launchServices.skipped, "lsregister -dump Bundle failed (2): first line");
});

test("hygiene: a record whose path is a symlink to the installed bundle is the installed bundle — never -u'd, whatever its id says", () => {
  const LINK = "/Users/kevinliu/jarvis/build/Jarhead.app";
  const linkRecord = `--------------------------------------------------------------------------------\npath:                       ${LINK} (0x4270)\nidentifier:                 com.kevinliu.jarhead\nexecutable:                 Contents/MacOS/Jarhead\n`;
  const realpath = (p: string): string => (p === LINK ? INSTALLED : p);
  const { exec, calls } = fake({ exports: [TWO], dumps: [DUMP + linkRecord] });
  const r = runHygiene({ ...base, mode: "install", exec, realpath });
  assert.ok(!calls.some((c) => c.args[0] === "-u" && c.args[1] === LINK), "-u on the link could unregister /Applications/Jarhead.app itself");
  assert.deepEqual(r.launchServices.unregistered, STALE);
  // Without the resolution the same record reads as Jarhead's id elsewhere and would go.
  const raw = fake({ exports: [TWO], dumps: [DUMP + linkRecord] });
  runHygiene({ ...base, mode: "install", exec: raw.exec, realpath: (p) => p });
  assert.ok(raw.calls.some((c) => c.args[0] === "-u" && c.args[1] === LINK));
});

test("readDock / repairDock — the engine's Fix the Dock: a read is one `defaults export` and never lsregister; the repair is export (mod-count), import of the audited document, killall Dock, export — the same Dock half as `dock --fix`", () => {
  const CLEANED = serializePlistXml(parsePlistXml(CLEAN));
  const { exec, calls } = fake({ exports: [TWO, TWO, CLEANED] });
  const before = readDock(exec);
  assert.deepEqual(argv(calls), [["defaults", "export", "com.apple.dock"]]);
  assert.ok(!("skipped" in before));
  if ("skipped" in before) return;
  assert.equal(before.pinned, 1);
  assert.equal(before.recent, 1);
  assert.deepEqual(
    before.changes.map((c) => c.kind),
    ["remove-recent", "rebuild-pin"],
  );
  const r = repairDock(exec, before);
  assert.deepEqual(argv(calls), [
    ["defaults", "export", "com.apple.dock"],
    ["defaults", "export", "com.apple.dock"],
    ["defaults", "import", "com.apple.dock"],
    ["killall", "Dock"],
    ["defaults", "export", "com.apple.dock"],
  ]);
  assert.ok(!calls.some((c) => c.cmd === LSREGISTER), "never lsregister from the engine: lsd can hold a call for two minutes");
  const imported = calls.find((c) => c.args[0] === "import");
  assert.deepEqual(imported?.args, ["import", "com.apple.dock", "-"]);
  const doc = parsePlistXml(imported?.input ?? "");
  const recent = dictGet(doc, "recent-apps");
  assert.equal(recent?.kind === "array" ? recent.items.length : -1, 1, "Jarhead's recent tile dropped, TextEdit kept");
  assert.equal(r.imported, true);
  assert.equal(r.restarted, true);
  assert.equal(r.rounds, 1);
  assert.equal(r.after?.changes.length, 0, "the re-read is clean");
  assert.equal(r.skipped, undefined);
  // A read that fails carries its reason and nothing is written; a race that never settles is skipped without an import.
  const failed = fake({ exports: [], exportCode: 1 });
  assert.deepEqual(readDock(failed.exec), { skipped: "defaults export failed (1)" });
  const moved = serializePlistXml(dictSet(parsePlistXml(TWO), "mod-count", int("1428")));
  const racing = fake({ exports: [TWO, moved, moved] });
  const b2 = readDock(racing.exec);
  if ("skipped" in b2) return assert.fail("read");
  const r2 = repairDock(racing.exec, b2, { maxRounds: 1 });
  assert.equal(r2.imported, false);
  assert.ok(!racing.calls.some((c) => c.args[0] === "import" || c.cmd === "killall"));
  assert.match(r2.skipped ?? "", /kept changing/);
  // A failed import restarts nothing and says why.
  const badImport = fake({ exports: [TWO, TWO], importCode: 1 });
  const b3 = readDock(badImport.exec);
  if ("skipped" in b3) return assert.fail("read");
  const r3 = repairDock(badImport.exec, b3);
  assert.equal(r3.imported, false);
  assert.ok(!badImport.calls.some((c) => c.cmd === "killall"));
  assert.match(r3.skipped ?? "", /import failed \(1\)/);
  assert.equal(installedUrlOf(INSTALLED), INSTALLED_URL);
  assert.equal(installedUrlOf("/Users/kevinliu/jarvis/build/stage/Jarhead.app"), "file:///Users/kevinliu/jarvis/build/stage/Jarhead.app/");
  // The calls above carried no cap (the CLI at a terminal keeps defaultExec's 20 s); with `timeoutMs` given, every Dock call — export, import, killall — carries it (the engine's 3 s).
  assert.ok(calls.every((c) => c.timeoutMs === undefined), "no timeoutMs unless asked: the CLI's argv trace is unchanged");
  const capped = fake({ exports: [TWO, TWO, CLEANED] });
  const b4 = readDock(capped.exec, { timeoutMs: 3000 });
  if ("skipped" in b4) return assert.fail("read");
  repairDock(capped.exec, b4, { timeoutMs: 3000 });
  assert.equal(capped.calls.length, 5);
  assert.ok(capped.calls.every((c) => c.timeoutMs === 3000), JSON.stringify(capped.calls.map((c) => [c.cmd, c.args[0], c.timeoutMs])));
  // restartDock alone: `killall Dock`, true when it went, false (and logged) when not; nothing else runs.
  const lines: string[] = [];
  const dead = fake({ exports: [], killallCode: 1 });
  assert.equal(restartDock(dead.exec, { log: (l) => lines.push(l), timeoutMs: 3000 }), false);
  assert.deepEqual(argv(dead.calls), [["killall", "Dock"]]);
  assert.equal(dead.calls[0]?.timeoutMs, 3000);
  assert.match(lines[0] ?? "", /^\[one-jarhead\] killall Dock failed \(1\)/);
  assert.equal(restartDock(fake({ exports: [] }).exec), true);
});

test("hygiene: `defaults import <file> -` then `export` round-trips the document with its <data> blobs (a temp FILE domain, never the Dock's)", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "jh-dock-"));
  const domain = join(root, "scratch.plist");
  try {
    const doc = parsePlistXml(TWO);
    execFileSync("defaults", ["import", domain, "-"], { input: serializePlistXml(doc), encoding: "utf8" });
    const back = parsePlistXml(execFileSync("defaults", ["export", domain, "-"], { encoding: "utf8" }));
    assert.deepEqual(back, doc);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
