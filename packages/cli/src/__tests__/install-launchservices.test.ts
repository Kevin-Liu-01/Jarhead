import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRealpath, describeLaunchServices, jarheadRecords, parseLsBundleDump, staleJarheadRecords } from "../install/launchservices.ts";

/**
 * `lsregister -dump Bundle` parsing and the stale rule. `open -a Jarhead` resolves by
 * name through this table, so a Jarhead.app in the Trash (a foreign bundle with the same
 * name and a different id) or a stage bundle counts as a second Jarhead.
 */

const dump = readFileSync(fileURLToPath(new URL("./fixtures/ls-dump-bundle.txt", import.meta.url)), "utf8");
const INSTALLED = "/Applications/Jarhead.app";
const ROOTS = ["/Users/kevinliu/.jarhead/worktrees", "/Users/kevinliu/.jarhead/trash", "/Users/kevinliu/.Trash", "/Users/kevinliu/jarvis/build/stage", "/Users/kevinliu/jarvis/build/previous"];

test("launchservices: the dump splits on the dashed lines into records with path (the (0x…) tag stripped), identifier and executable", () => {
  const records = parseLsBundleDump(dump);
  assert.deepEqual(
    records.map((r) => [r.path, r.identifier, r.executable]),
    [
      ["/Applications/Jarhead.app", "com.kevinliu.jarhead", "Contents/MacOS/Jarhead"],
      ["/Users/kevinliu/.jarhead/worktrees/se_x/apps/mac/.build/ear-probe/EarProbe.app", "com.kevinliu.jarhead.ear-probe", "Contents/MacOS/ear-probe"],
      ["/Users/kevinliu/jarvis/apps/mac/.build/ear-probe/EarProbe.app", "com.kevinliu.jarhead.ear-probe", "Contents/MacOS/ear-probe"],
      ["/Users/kevinliu/.Trash/Jarhead.app", "com.kevinliu.jarvis", "Contents/MacOS/Jarhead"],
      ["/Users/kevinliu/jarvis/build/stage/Jarhead.app", "com.kevinliu.jarhead", "Contents/MacOS/Jarhead"],
      ["/System/Applications/Utilities/Grapher.app", "com.apple.grapher", "Contents/MacOS/Grapher"],
    ],
  );
  assert.deepEqual(parseLsBundleDump(""), []);
});

test("launchservices: stale = Jarhead's id elsewhere, a sub-id under a stale root, or a Jarhead.app by name under a stale root; the live checkout's probe and the installed bundle never", () => {
  const records = parseLsBundleDump(dump);
  const stale = staleJarheadRecords(records, { installed: INSTALLED, bundleId: "com.kevinliu.jarhead", staleRoots: ROOTS, exists: () => true });
  assert.deepEqual(
    stale.map((r) => r.path),
    ["/Users/kevinliu/.jarhead/worktrees/se_x/apps/mac/.build/ear-probe/EarProbe.app", "/Users/kevinliu/.Trash/Jarhead.app", "/Users/kevinliu/jarvis/build/stage/Jarhead.app"],
  );
  // A probe bundle whose path is gone is stale wherever it was; /Applications is never.
  const gone = staleJarheadRecords(records, { installed: INSTALLED, bundleId: "com.kevinliu.jarhead", staleRoots: ROOTS, exists: () => false });
  assert.ok(gone.some((r) => r.path === "/Users/kevinliu/jarvis/apps/mac/.build/ear-probe/EarProbe.app"));
  assert.ok(!gone.some((r) => r.path === INSTALLED));
  assert.ok(!gone.some((r) => r.path.endsWith("Grapher.app")), "other people's bundles are not ours to touch");
  assert.deepEqual(
    jarheadRecords(records, "com.kevinliu.jarhead").map((r) => r.path),
    ["/Applications/Jarhead.app", "/Users/kevinliu/jarvis/build/stage/Jarhead.app"],
  );
});

test("launchservices: a record at a symlink that resolves to the installed bundle is the installed bundle, not Jarhead's id elsewhere; defaultRealpath resolves links and hands back a path that is gone", () => {
  const LINK = "/Users/kevinliu/jarvis/build/Jarhead.app";
  const records = [...parseLsBundleDump(dump), { path: LINK, identifier: "com.kevinliu.jarhead", executable: "Contents/MacOS/Jarhead" }];
  const resolved = staleJarheadRecords(records, { installed: INSTALLED, bundleId: "com.kevinliu.jarhead", staleRoots: ROOTS, exists: () => true, realpath: (p) => (p === LINK ? INSTALLED : p) });
  assert.ok(!resolved.some((r) => r.path === LINK), "unregistering the link would unregister /Applications/Jarhead.app");
  assert.equal(resolved.length, 3, "the three real leftovers are still stale");
  const unresolved = staleJarheadRecords(records, { installed: INSTALLED, bundleId: "com.kevinliu.jarhead", staleRoots: ROOTS, exists: () => true, realpath: (p) => p });
  assert.ok(unresolved.some((r) => r.path === LINK), "rule (a) without the resolution");

  const root = mkdtempSync(join(tmpdir(), "jh-realpath-"));
  try {
    mkdirSync(join(root, "Real.app"));
    symlinkSync(join(root, "Real.app"), join(root, "Link.app"));
    assert.equal(defaultRealpath(join(root, "Link.app")), defaultRealpath(join(root, "Real.app")));
    assert.equal(defaultRealpath(join(root, "gone", "Nope.app")), join(root, "gone", "Nope.app"), "a path that is gone comes back as itself, so the gone rule still sees it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launchservices: the build's rollback snapshots are stale wherever LaunchServices met them — the old build/previous/Jarhead.app (a full bundle with Jarhead's id, registered as a second Jarhead) and any record at the new .previous name", () => {
  const records = [
    ...parseLsBundleDump(dump),
    { path: "/Users/kevinliu/jarvis/build/previous/Jarhead.app", identifier: "com.kevinliu.jarhead", executable: "Contents/MacOS/Jarhead" },
    { path: "/Users/kevinliu/jarvis/build/previous/Jarhead.app.previous", identifier: "com.kevinliu.jarhead", executable: "Contents/MacOS/Jarhead" },
  ];
  // Present on disk (the build has not retired it yet) or gone (it has): stale either way — Jarhead's id anywhere but /Applications.
  for (const exists of [() => true, () => false]) {
    const stale = staleJarheadRecords(records, { installed: INSTALLED, bundleId: "com.kevinliu.jarhead", staleRoots: ROOTS, exists, realpath: (p) => p });
    assert.ok(stale.some((r) => r.path === "/Users/kevinliu/jarvis/build/previous/Jarhead.app"), `exists=${exists()}`);
    assert.ok(stale.some((r) => r.path === "/Users/kevinliu/jarvis/build/previous/Jarhead.app.previous"), `exists=${exists()}`);
    assert.ok(!stale.some((r) => r.path === INSTALLED));
  }
});

test("launchservices: the summary clause names the installed record, what was unregistered and what still remains", () => {
  const records = parseLsBundleDump(dump);
  const stale = staleJarheadRecords(records, { installed: INSTALLED, bundleId: "com.kevinliu.jarhead", staleRoots: ROOTS, exists: () => true });
  assert.equal(describeLaunchServices(records, [], [], INSTALLED), "LaunchServices: /Applications/Jarhead.app registered");
  assert.equal(
    describeLaunchServices(records, stale, [], INSTALLED),
    "LaunchServices: /Applications/Jarhead.app registered · also /Users/kevinliu/.jarhead/worktrees/se_x/apps/mac/.build/ear-probe/EarProbe.app, /Users/kevinliu/.Trash/Jarhead.app, /Users/kevinliu/jarvis/build/stage/Jarhead.app",
  );
  assert.equal(
    describeLaunchServices(records, stale, stale.map((r) => r.path), INSTALLED),
    "LaunchServices: /Applications/Jarhead.app registered · 3 stale records unregistered",
  );
  assert.match(describeLaunchServices([], [], [], INSTALLED), /NOT registered/);
});
