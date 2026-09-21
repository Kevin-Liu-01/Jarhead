import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installChecks, type Check } from "../doctor.ts";
import { CODESIGN, LSREGISTER, dictGet, dictSet, parsePlistXml, serializePlistXml, stringAt, type Exec, type TargetProbe } from "@jarhead/install";

/**
 * The doctor's app rows driven by a scripted exec and a scripted stat: they read the
 * installed bundle (never build/Jarhead.app), verify strict + deep, check the designated
 * requirement, and report the one-Jarhead audit read-only — every fix is a command,
 * never an action the doctor takes itself.
 */

// The sanitized Dock exports and lsregister dump the install library's tests own; one copy, read from there.
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../install/src/__tests__/fixtures/${name}`, import.meta.url)), "utf8");
const INSTALLED = "/Applications/Jarhead.app";
const dir: TargetProbe = { exists: true, isSymlink: false, isDirectory: true, uid: 501, inode: 103261417, writable: true };
const ROOTS = ["/Users/kevinliu/.jarhead/worktrees", "/Users/kevinliu/.jarhead/trash", "/Users/kevinliu/.Trash", "/Users/kevinliu/jarvis/build/stage", "/Users/kevinliu/jarvis/build/previous"];

function exec(o: { verifyCode?: number; requirement?: string; dvv?: string; dump?: string; dumpCode?: number; dock?: string; calls?: string[][] }): Exec {
  return (cmd, args, _opts) => {
    o.calls?.push([cmd, ...args]);
    if (cmd === CODESIGN && args[0] === "-dvv") return { code: 0, stdout: "", stderr: o.dvv ?? "Executable=/Applications/Jarhead.app/Contents/MacOS/Jarhead\nAuthority=Jarhead Local Signing\n" };
    if (cmd === CODESIGN && args[0] === "--verify") return { code: o.verifyCode ?? 0, stdout: "", stderr: o.verifyCode ? "/Applications/Jarhead.app: a sealed resource is missing or invalid" : "/Applications/Jarhead.app: valid on disk\n" };
    if (cmd === CODESIGN && args[0] === "-d") return { code: 0, stdout: "", stderr: o.requirement ?? 'designated => identifier "com.kevinliu.jarhead" and certificate leaf = H"8b79555ca54ff1c95d3e044805f34d5adac36055"\n' };
    if (cmd === LSREGISTER && args[0] === "-dump") return o.dumpCode ? { code: o.dumpCode, stdout: "", stderr: `spawnSync ${LSREGISTER} ETIMEDOUT` } : { code: 0, stdout: o.dump ?? fixture("ls-dump-bundle.txt"), stderr: "" };
    if (cmd === "defaults" && args[0] === "export") return { code: 0, stdout: o.dock ?? fixture("dock-clean.xml"), stderr: "" };
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
}

const byName = (rows: readonly Check[]): Record<string, Check> => Object.fromEntries(rows.map((r) => [r.name, r]));
const CLEAN_DUMP = fixture("ls-dump-bundle.txt").split("--------------------------------------------------------------------------------").filter((b) => b.includes("/Applications/Jarhead.app") || b.includes("Grapher") || b.includes("/Users/kevinliu/jarvis/apps/mac")).join("--------------------------------------------------------------------------------");

test("doctor app rows: a healthy Mac — installed, real identity, strict ok with the identifier, one LaunchServices record, one pinned tile; every row ok and read-only", () => {
  const calls: string[][] = [];
  const rows = installChecks({ exec: exec({ calls, dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED });
  assert.deepEqual(rows.map((r) => r.name), ["Jarhead.app", "signing identity", "install", "launch services", "dock"]);
  assert.ok(rows.every((r) => r.group === "app" && r.status === "ok" && !r.required), JSON.stringify(rows.filter((r) => r.status !== "ok")));
  const r = byName(rows);
  assert.equal(r["Jarhead.app"]!.detail, "/Applications/Jarhead.app (build/Jarhead.app → symlink)");
  assert.equal(r["signing identity"]!.detail, "Jarhead Local Signing");
  assert.equal(r["install"]!.detail, "/Applications/Jarhead.app · inode 103261417 · strict ok · requirement identifier com.kevinliu.jarhead");
  assert.equal(r["launch services"]!.detail, "1 record: /Applications/Jarhead.app");
  assert.equal(r["dock"]!.detail, "1 pinned, 0 recent");
  assert.ok(calls.some((c) => c[0] === CODESIGN && c[1] === "--verify" && c.includes("--deep") && c.at(-1) === INSTALLED), "strict + deep on the installed copy");
  assert.ok(!calls.some((c) => c.includes("build/Jarhead.app")), "never the symlink");
  assert.ok(!calls.some((c) => c[1] === "-f" || c[1] === "-u" || c[1] === "import" || c[0] === "killall"), "the doctor changes nothing");
});

test("doctor app rows: two Dock tiles and stale records warn with `pnpm jarhead dock --fix`; a failed verify or a missing identifier warns with `pnpm build:mac`", () => {
  const rows = byName(installChecks({ exec: exec({ dock: fixture("dock-two-tiles.xml") }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(rows["dock"]!.status, "warn");
  assert.equal(rows["dock"]!.detail, "1 pinned, 1 recent — two tiles");
  assert.equal(rows["dock"]!.fix, "pnpm jarhead dock --fix");
  assert.equal(rows["launch services"]!.status, "warn");
  assert.match(rows["launch services"]!.detail, /^4 Jarhead records — also .*\.Trash\/Jarhead\.app.*open -a Jarhead can pick one of them/);
  assert.equal(rows["launch services"]!.fix, "pnpm jarhead dock --fix");

  const bad = byName(installChecks({ exec: exec({ verifyCode: 1, dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(bad["install"]!.status, "warn");
  assert.match(bad["install"]!.detail, /codesign --verify --strict --deep failed: .*sealed resource/);
  assert.equal(bad["install"]!.fix, "pnpm build:mac");

  const wrongId = byName(installChecks({ exec: exec({ requirement: 'designated => identifier "com.kevinliu.jarvis"\n', dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.match(wrongId["install"]!.detail, /designated requirement lacks identifier "com.kevinliu.jarhead"/);

  const adhoc = byName(installChecks({ exec: exec({ dvv: "Signature=adhoc\n", dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(adhoc["signing identity"]!.status, "warn");
  assert.match(adhoc["signing identity"]!.fix ?? "", /Certificate Assistant/);
});

test("doctor app rows: a Dock with no Jarhead pin is a warn that asks Kevin to drag the app once (no fix command — pinning is his); a timed-out Bundle dump warns with the reason", () => {
  // dock-clean.xml minus its Jarhead pin: Safari alone in persistent-apps, recent-apps empty.
  const clean = parsePlistXml(fixture("dock-clean.xml"));
  const apps = dictGet(clean, "persistent-apps");
  assert.ok(apps && apps.kind === "array");
  const others = apps.items.filter((tile) => stringAt(dictGet(tile, "tile-data")!, "bundle-identifier") !== "com.kevinliu.jarhead");
  assert.equal(others.length, apps.items.length - 1);
  const unpinned = serializePlistXml(dictSet(clean, "persistent-apps", { kind: "array", items: others }));
  const rows = byName(installChecks({ exec: exec({ dock: unpinned, dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(rows["dock"]!.status, "warn", "an ok row that tells Kevin to do something is a contradiction");
  assert.match(rows["dock"]!.detail, /^not pinned — drag \/Applications\/Jarhead\.app to the Dock once/);
  assert.equal(rows["dock"]!.fix, undefined, "nothing `dock --fix` can do about a missing pin");

  const slow = byName(installChecks({ exec: exec({ dumpCode: 1 }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(slow["launch services"]!.status, "warn");
  assert.equal(slow["launch services"]!.detail, `lsregister -dump Bundle failed (1): spawnSync ${LSREGISTER} ETIMEDOUT`);
  assert.equal(slow["dock"]!.status, "ok", "the Dock half still reads");
});

test("doctor app rows: not installed → both rows say pnpm build:mac; a symlink or another owner at /Applications/Jarhead.app warns with the plan's own hint", () => {
  const none = byName(installChecks({ exec: exec({ dump: "", dock: fixture("dock-clean.xml") }), probe: () => ({ exists: false, isSymlink: false, isDirectory: false }), uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: undefined }));
  assert.equal(none["Jarhead.app"]!.status, "warn");
  assert.equal(none["Jarhead.app"]!.fix, "pnpm build:mac");
  assert.equal(none["install"]!.fix, "pnpm build:mac");
  assert.equal(none["launch services"]!.status, "warn", "the bundle is not registered when nothing is there");
  assert.match(none["launch services"]!.detail, /is not registered/);

  const link = byName(installChecks({ exec: exec({ dump: CLEAN_DUMP }), probe: () => ({ exists: true, isSymlink: true, isDirectory: false, uid: 501, inode: 3, linkTarget: "/Users/kevinliu/jarvis/build/stage/Jarhead.app" }), uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(link["install"]!.status, "warn");
  assert.match(link["install"]!.detail, /is a symlink to .*build\/stage\/Jarhead\.app.*the next pnpm build:mac refuses/);
  assert.match(link["install"]!.fix ?? "", /move it to the Trash/);

  const root = byName(installChecks({ exec: exec({ dump: CLEAN_DUMP }), probe: () => ({ ...dir, uid: 0 }), uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.match(root["install"]!.detail, /owned by uid 0, not 501/);
  assert.match(root["install"]!.fix ?? "", /sudo chown -R/);
});
