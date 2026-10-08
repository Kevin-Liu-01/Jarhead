import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserChecks, installChecks, type Check } from "../doctor.ts";
import { CODESIGN, LSREGISTER, defaultExec, dictGet, dictSet, parsePlistXml, serializePlistXml, stringAt, type Exec, type TargetProbe } from "@jarhead/install";
import { ADHOC_BUNDLE_ID, canSignAdhoc, makeStage, signLikeBuildMac } from "../../../install/src/__tests__/adhoc-stage.ts";

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

function exec(o: { verifyCode?: number; requirement?: string; requirementOut?: string; dvv?: string; dump?: string; dumpCode?: number; dock?: string; calls?: string[][] }): Exec {
  return (cmd, args, _opts) => {
    o.calls?.push([cmd, ...args]);
    if (cmd === CODESIGN && args[0] === "-dvv") return { code: 0, stdout: "", stderr: o.dvv ?? "Executable=/Applications/Jarhead.app/Contents/MacOS/Jarhead\nAuthority=Jarhead Local Signing\n" };
    if (cmd === CODESIGN && args[0] === "--verify") return { code: o.verifyCode ?? 0, stdout: "", stderr: o.verifyCode ? "/Applications/Jarhead.app: a sealed resource is missing or invalid" : "/Applications/Jarhead.app: valid on disk\n" };
    if (cmd === CODESIGN && args[0] === "-d") return { code: 0, stdout: o.requirementOut ?? "", stderr: o.requirement ?? 'designated => identifier "com.kevinliu.jarhead" and certificate leaf = H"8b79555ca54ff1c95d3e044805f34d5adac36055"\n' };
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
  assert.equal(rows["dock"]!.detail, "1 pinned, 1 recent · two tiles");
  assert.equal(rows["dock"]!.fix, "pnpm jarhead dock --fix");
  assert.equal(rows["launch services"]!.status, "warn");
  assert.match(rows["launch services"]!.detail, /^4 Jarhead records: also .*\.Trash\/Jarhead\.app.*open -a Jarhead can pick one of them/);
  assert.equal(rows["launch services"]!.fix, "pnpm jarhead dock --fix");

  const bad = byName(installChecks({ exec: exec({ verifyCode: 1, dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(bad["install"]!.status, "warn");
  assert.match(bad["install"]!.detail, /codesign --verify --strict --deep failed: .*sealed resource/);
  assert.equal(bad["install"]!.fix, "pnpm build:mac");

  const wrongId = byName(installChecks({ exec: exec({ requirement: 'designated => identifier "com.kevinliu.jarvis"\n', dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.match(wrongId["install"]!.detail, /designated requirement lacks identifier "com.kevinliu.jarhead"/);

});

// What codesign prints for /Applications/Jarhead.app signed ad-hoc (build-mac.ts on a Mac with no
// identity): -dvv and -d -v on stderr, the implicit cdhash requirement on stdout. No Authority line,
// no identifier clause in the requirement.
const ADHOC_SIGNATURE = [
  "Executable=/Applications/Jarhead.app/Contents/MacOS/Jarhead",
  "Identifier=com.kevinliu.jarhead",
  "Format=app bundle with Mach-O thin (arm64)",
  "CodeDirectory v=20400 size=48212 flags=0x2(adhoc) hashes=1495+7 location=embedded",
  "Signature=adhoc",
  "Info.plist entries=21",
  "TeamIdentifier=not set",
  "Sealed Resources version=2 rules=13 files=31",
].join("\n");
const ADHOC_REQUIREMENT = '# designated => cdhash H"5f0c1b3e9a7d2c4e8b6a0f1d3c5e7a9b2d4f6e8a"\n';

test("doctor app rows on an ad-hoc install: the identity row warns with the certificate fix; the install row is ok, because ad-hoc is the no-identity default build:mac installs", () => {
  const rows = byName(installChecks({ exec: exec({ dvv: `${ADHOC_SIGNATURE}\nInternal requirements count=0 size=12\n`, requirement: `${ADHOC_SIGNATURE}\n`, requirementOut: ADHOC_REQUIREMENT, dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(rows["signing identity"]!.status, "warn");
  assert.match(rows["signing identity"]!.detail, /^ad-hoc/);
  assert.match(rows["signing identity"]!.fix ?? "", /Certificate Assistant/);
  assert.equal(rows["install"]!.status, "ok", `install row: ${rows["install"]!.detail}`);
  assert.equal(rows["install"]!.detail, "/Applications/Jarhead.app · inode 103261417 · strict ok · ad-hoc, identifier com.kevinliu.jarhead");
  assert.equal(rows["install"]!.fix, undefined, "no pnpm build:mac loop");

  // An ad-hoc bundle under another identifier is still a warn, and the row quotes the requirement.
  const other = ADHOC_SIGNATURE.replace("Identifier=com.kevinliu.jarhead", "Identifier=com.kevinliu.jarvis");
  const wrong = byName(installChecks({ exec: exec({ dvv: other, requirement: other, requirementOut: ADHOC_REQUIREMENT, dump: CLEAN_DUMP }), probe: () => dir, uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.equal(wrong["install"]!.status, "warn");
  assert.match(wrong["install"]!.detail, /^designated requirement lacks identifier "com\.kevinliu\.jarhead": designated => cdhash H"5f0c1b3e/);
  assert.match(wrong["install"]!.detail, /\(ad-hoc, signed as com\.kevinliu\.jarvis\)$/);
});

test("doctor app rows against a real ad-hoc signature (codesign runs; LaunchServices and the Dock are stubbed)", { skip: canSignAdhoc() ? false : "needs macOS codesign" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jh-adhoc-doctor-")));
  try {
    const app = makeStage(root, "doctor");
    signLikeBuildMac(app, undefined);
    const run: Exec = (cmd, args, opts) => (cmd === CODESIGN ? defaultExec(cmd, args, opts) : { code: 0, stdout: "", stderr: "" });
    const rows = byName(installChecks({ exec: run, installed: app, bundleId: ADHOC_BUNDLE_ID, uid: process.getuid?.() ?? -1, staleRoots: [], exists: () => true, linkTarget: app }));
    assert.equal(rows["signing identity"]!.status, "warn", "ad-hoc is a warn on the identity row");
    assert.equal(rows["install"]!.status, "ok", `install row: ${rows["install"]!.detail} (fix offered: ${rows["install"]!.fix})`);
    assert.match(rows["install"]!.detail, /strict ok · ad-hoc, identifier com\.example\.jarhead-adhoc-install$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor browser rows: the plain doctor sends no Apple event, names --browsers and warns about nothing; with it, each running browser is asked and one that is not running is never launched", async () => {
  const asked: string[] = [];
  const plain = await browserChecks({ ask: false, running: () => assert.fail("not even pgrep without --browsers"), probe: async (app) => (asked.push(app), { status: "ok", detail: "on" }) });
  assert.equal(asked.length, 0, "no browser is asked");
  assert.equal(plain.length, 1);
  assert.equal(plain[0]!.name, "browser JS from Apple Events");
  assert.equal(plain[0]!.status, "ok", "not asking is the default, so the plain doctor (the one install.sh names) shows no warn here");
  assert.equal(plain[0]!.detail, "Not asked. pnpm run doctor --browsers sends each running browser an Apple event.");

  const rows = await browserChecks({ ask: true, running: (app) => app === "Safari", probe: async (app) => (asked.push(app), { status: "off", detail: "Develop menu setting is off", fix: "Safari › Develop › Allow JavaScript from Apple Events" }) });
  assert.deepEqual(asked, ["Safari"], "only the running browser is asked");
  const r = byName(rows);
  assert.equal(r["Google Chrome JS from Apple Events"]!.status, "warn");
  assert.equal(r["Google Chrome JS from Apple Events"]!.detail, "Not running. Not probed.");
  assert.equal(r["Safari JS from Apple Events"]!.status, "warn");
  assert.equal(r["Safari JS from Apple Events"]!.detail, "Off. Develop menu setting is off");
  for (const row of [...plain, ...rows]) assert.doesNotMatch(row.detail, /\u2014/, `no em dash: ${row.detail}`);
  assert.match(r["Safari JS from Apple Events"]!.fix ?? "", /Allow JavaScript from Apple Events/);
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
  assert.match(rows["dock"]!.detail, /^not pinned \(drag \/Applications\/Jarhead\.app to the Dock once/);
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
  assert.match(link["install"]!.detail, /is a symlink to .*build\/stage\/Jarhead\.app.*\, so the next pnpm build:mac refuses/);
  assert.match(link["install"]!.fix ?? "", /move it to the Trash/);

  const root = byName(installChecks({ exec: exec({ dump: CLEAN_DUMP }), probe: () => ({ ...dir, uid: 0 }), uid: 501, staleRoots: ROOTS, exists: () => true, linkTarget: INSTALLED }));
  assert.match(root["install"]!.detail, /owned by uid 0, not 501/);
  assert.match(root["install"]!.fix ?? "", /sudo chown -R/);
});
