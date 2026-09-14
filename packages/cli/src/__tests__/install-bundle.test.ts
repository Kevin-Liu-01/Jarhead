import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODESIGN, CODESIGN_REQUIREMENT_ARGS, CODESIGN_VERIFY_ARGS, DITTO, RSYNC, compareTrees, installLine, parityOk, parseItemized, performInstall, planInstall, probeTarget, requirementHasIdentifier, rollbackLine, rsyncArgs, snapshotArgs, snapshotNameOk, type InstallIO, type ParityReport, type TargetProbe } from "../install/bundle.ts";

/**
 * The install step's pure parts, and — on a Mac — openrsync itself between two temp
 * trees: the destination directory keeps its inode, a changed file is renamed in
 * (new inode), an equal-size-equal-mtime file is still replaced (-c), the stale file
 * goes, nothing temporary is left. /Applications is never touched here. The itemized
 * output is asserted as a SET: this Mac's openrsync and GitHub's macos-15 runner spell
 * the deletions differently (see parseItemized).
 */

test("planInstall: absent → create; a directory Kevin owns → update with its inode; a symlink, a file, another uid or no write bit → refuse", () => {
  assert.deepEqual(planInstall({ exists: false, isSymlink: false, isDirectory: false }, 501), { kind: "create" });
  assert.deepEqual(planInstall({ exists: true, isSymlink: false, isDirectory: true, uid: 501, inode: 103261417, writable: true }, 501), { kind: "update", inode: 103261417 });
  const link = planInstall({ exists: true, isSymlink: true, isDirectory: false, uid: 501, inode: 7, linkTarget: "/Users/kevinliu/jarvis/build/stage/Jarhead.app" }, 501);
  assert.equal(link.kind, "refuse");
  if (link.kind === "refuse") {
    assert.equal(link.reason, "/Applications/Jarhead.app is a symlink to /Users/kevinliu/jarvis/build/stage/Jarhead.app; rsync would write into the target");
    assert.match(link.hint, /move it to the Trash/);
  }
  const file = planInstall({ exists: true, isSymlink: false, isDirectory: false, uid: 501, inode: 8, writable: true }, 501);
  assert.equal(file.kind, "refuse");
  if (file.kind === "refuse") assert.match(file.reason, /not a directory/);
  const root = planInstall({ exists: true, isSymlink: false, isDirectory: true, uid: 0, inode: 9, writable: true }, 501);
  assert.equal(root.kind, "refuse");
  if (root.kind === "refuse") {
    assert.match(root.reason, /owned by uid 0, not 501/);
    assert.match(root.hint, /sudo chown -R/);
    assert.match(root.hint, /never runs sudo/);
  }
  const ro = planInstall({ exists: true, isSymlink: false, isDirectory: true, uid: 501, inode: 10, writable: false }, 501);
  assert.equal(ro.kind, "refuse");
  if (ro.kind === "refuse") assert.match(ro.reason, /not writable/);
});

test("rsyncArgs is one pinned argv: -rlptD -c --delay-updates --delete-after --itemize-changes, trailing slashes, never -a / -E / --inplace", () => {
  const args = rsyncArgs("/r/build/stage/Jarhead.app", "/Applications/Jarhead.app");
  assert.deepEqual(args, ["-rlptD", "-c", "--delay-updates", "--delete-after", "--itemize-changes", "/r/build/stage/Jarhead.app/", "/Applications/Jarhead.app/"]);
  for (const bad of ["-a", "-E", "--inplace", "--extended-attributes", "-rlptDE", "-aE"]) assert.ok(!args.includes(bad), bad);
  assert.equal(RSYNC, "/usr/bin/rsync");
  assert.deepEqual(snapshotArgs("/Applications/Jarhead.app", "/r/build/previous/Jarhead.app.zip"), ["-c", "-k", "--sequesterRsrc", "--keepParent", "/Applications/Jarhead.app", "/r/build/previous/Jarhead.app.zip"]);
  assert.deepEqual([...CODESIGN_VERIFY_ARGS], ["--verify", "--strict", "--deep", "--verbose=1"]);
  // The snapshot's name: LaunchServices registers any *.app directory as a bundle (build/previous/Jarhead.app was a second Jarhead in `lsregister -dump`).
  assert.equal(snapshotNameOk("/r/build/previous/Jarhead.app.zip"), true);
  assert.equal(snapshotNameOk("/r/build/previous/Jarhead.app.old"), false, "a directory snapshot is registered by Spotlight whatever it is called");
  assert.equal(snapshotNameOk("/r/build/previous/Jarhead.app"), false);
  assert.equal(snapshotNameOk("/r/build/previous/Jarhead.APP/"), false, "any case, trailing slash trimmed");
  assert.equal(snapshotNameOk("/r/build/previous/Jarhead.previous"), false, "a directory of any name is registered once Spotlight finds the Info.plist inside; only an archive is safe");
});

test("parseItemized is version-agnostic: this Mac's openrsync (directory with a trailing slash) and the macos-15 runner's (no slash, every deletion twice) give the same deleted SET, each path once; dirs made ignored; ._ entries flagged", () => {
  // This Mac's openrsync: the emptied directory itemized as `Contents/Resources/`.
  const mac = ["cL+++++++ Contents/link -> MacOS/b", ">fc...... Contents/MacOS/Jarhead", ">f+++++++ Contents/Resources/x", "cd+++++++ Contents/", "*deleting Contents/Resources/stale.txt", "*deleting Contents/Resources/", ".d..t.... ./", ""].join("\n");
  const s = parseItemized(mac);
  assert.deepEqual(s.created, ["Contents/link", "Contents/Resources/x"]);
  assert.deepEqual(s.updated, ["Contents/MacOS/Jarhead"]);
  assert.deepEqual(s.deleted, ["Contents/Resources/stale.txt", "Contents/Resources"], "files and the emptied directory, no trailing slash");
  assert.deepEqual(s.appleDouble, []);
  // GitHub's macos-15 runner, as observed in CI: `Contents/Resources` without the slash, and each entry printed twice (one line per --delete-after pass).
  const runner = ["*deleting Contents/Resources/stale.txt", "*deleting Contents/Resources", "*deleting Contents/Resources/stale.txt", "*deleting Contents/Resources", ""].join("\n");
  const r = parseItemized(runner);
  assert.deepEqual(r.deleted, ["Contents/Resources/stale.txt", "Contents/Resources"], "each path once");
  assert.deepEqual(new Set(r.deleted), new Set(s.deleted), "the same set from either build");
  assert.ok(r.deleted.includes("Contents/Resources/stale.txt"));
  for (const p of r.deleted) assert.ok(p === "Contents/Resources" || p.startsWith("Contents/Resources/"), `${p} is outside the stale subtree`);
  // Doubled lines in the other columns are one entry too; a bare `./` deletion is nothing.
  const doubled = parseItemized(">fc...... Contents/MacOS/Jarhead\n>fc...... Contents/MacOS/Jarhead\n>f+++++++ Contents/new\n>f+++++++ Contents/new\n*deleting ./\n");
  assert.deepEqual(doubled.updated, ["Contents/MacOS/Jarhead"]);
  assert.deepEqual(doubled.created, ["Contents/new"]);
  assert.deepEqual(doubled.deleted, []);
  const leaked = parseItemized(">f+++++++ Contents/._Info.plist\n>fc...... Contents/Resources/._Jarhead.icns\n*deleting Contents/._old\n");
  assert.deepEqual(leaked.appleDouble, ["Contents/._Info.plist", "Contents/Resources/._Jarhead.icns", "Contents/._old"]);
  assert.deepEqual(parseItemized(""), { created: [], updated: [], deleted: [], appleDouble: [] });
});

test("requirementHasIdentifier matches the designated requirement's identifier clause exactly", () => {
  const req = 'designated => identifier "com.kevinliu.jarhead" and certificate leaf = H"8b79555ca54ff1c95d3e044805f34d5adac36055"\n';
  assert.ok(requirementHasIdentifier(req, "com.kevinliu.jarhead"));
  assert.ok(!requirementHasIdentifier(req, "com.kevinliu.jarvis"));
  assert.ok(!requirementHasIdentifier('identifier "com.kevinliu.jarhead.ear-probe"', "com.kevinliu.jarhead"));
});

test("installLine says kept (same inode) or REPLACED, and counts what rsync did", () => {
  const rsync = { created: [], updated: ["a", "b", "c", "d"], deleted: ["e"], appleDouble: [] };
  assert.equal(installLine({ plan: { kind: "update", inode: 103261417 }, inodeAfter: 103261417, rsync }), "install    /Applications/Jarhead.app kept (inode 103261417) · 4 files replaced, 0 added, 1 removed · strict ok · requirement identifier com.kevinliu.jarhead");
  assert.match(installLine({ plan: { kind: "update", inode: 1 }, inodeAfter: 2, rsync }), /REPLACED \(inode 1 → 2\) — report this/);
  assert.match(installLine({ plan: { kind: "create" }, inodeAfter: 5, rsync: undefined }), /created \(inode 5\) · copied whole/);
  // The counts are of unique entries: a summary built from the runner's doubled lines must not count twice.
  assert.match(installLine({ plan: { kind: "update", inode: 1 }, inodeAfter: 1, rsync: { created: ["n", "n"], updated: ["a", "a"], deleted: ["e", "e", "Contents/Resources"], appleDouble: [] } }), /1 file replaced, 1 added, 2 removed/);
});

test("probeTarget: lstat, so a symlink is seen as one; a directory reports uid, inode and the write bit", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "jh-probe-"));
  try {
    mkdirSync(join(root, "real.app"));
    symlinkSync(join(root, "real.app"), join(root, "link.app"));
    writeFileSync(join(root, "file.app"), "x");
    const dir = probeTarget(join(root, "real.app"));
    assert.equal(dir.isDirectory, true);
    assert.equal(dir.isSymlink, false);
    assert.equal(dir.writable, true);
    assert.equal(dir.uid, process.getuid?.());
    assert.equal(typeof dir.inode, "number");
    const link = probeTarget(join(root, "link.app"));
    assert.equal(link.isSymlink, true);
    assert.equal(link.isDirectory, false, "not followed");
    assert.equal(link.linkTarget, join(root, "real.app"));
    const file = probeTarget(join(root, "file.app"));
    assert.equal(file.exists, true);
    assert.equal(file.isDirectory, false);
    assert.deepEqual(probeTarget(join(root, "nope.app")), { exists: false, isSymlink: false, isDirectory: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openrsync in place: the destination directory keeps its inode, changed files are renamed in, -c catches an equal-size-equal-mtime change, the stale file goes, parity holds", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "jh-install-"));
  try {
    const src = join(root, "stage", "Jarhead.app");
    const dst = join(root, "Applications", "Jarhead.app");
    mkdirSync(join(src, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(dst, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(dst, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(src, "Contents", "MacOS", "a"), "new-a");
    writeFileSync(join(src, "Contents", "MacOS", "b"), "same");
    writeFileSync(join(src, "Contents", "MacOS", "c"), "v1xx");
    symlinkSync("MacOS/b", join(src, "Contents", "link"));
    writeFileSync(join(dst, "Contents", "MacOS", "a"), "old-a");
    writeFileSync(join(dst, "Contents", "MacOS", "b"), "same");
    writeFileSync(join(dst, "Contents", "MacOS", "c"), "v0xx");
    writeFileSync(join(dst, "Contents", "Resources", "stale.txt"), "stale");
    const t = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(src, "Contents", "MacOS", "c"), t, t);
    utimesSync(join(dst, "Contents", "MacOS", "c"), t, t);
    const dirInode = statSync(dst).ino;
    const cInode = statSync(join(dst, "Contents", "MacOS", "c")).ino;
    const bInode = statSync(join(dst, "Contents", "MacOS", "b")).ino;

    const out = execFileSync(RSYNC, rsyncArgs(src, dst), { encoding: "utf8" });
    const s = parseItemized(out);
    assert.deepEqual([...s.updated].sort(), ["Contents/MacOS/a", "Contents/MacOS/c"], "-c replaced c despite equal size and mtime");
    assert.deepEqual(s.created, ["Contents/link"]);
    // The deletions as a SET: this Mac's openrsync says `Contents/Resources/`, the runner's `Contents/Resources` twice — what matters is that stale.txt went and nothing outside its subtree did.
    const deleted = new Set(s.deleted);
    assert.ok(deleted.has("Contents/Resources/stale.txt"), JSON.stringify(s.deleted));
    assert.equal(deleted.size, s.deleted.length, `each path once: ${JSON.stringify(s.deleted)}`);
    for (const p of deleted) assert.ok(p === "Contents/Resources" || p.startsWith("Contents/Resources/"), `${p} is outside the stale subtree`);
    assert.deepEqual(s.appleDouble, [], "no -E, no ._ entries");
    assert.equal(statSync(dst).ino, dirInode, "the bundle directory is the same inode — the Dock's bookmark stays valid");
    assert.notEqual(statSync(join(dst, "Contents", "MacOS", "c")).ino, cInode, "a changed file is a new inode renamed in, so a running process keeps its mapped one");
    assert.equal(statSync(join(dst, "Contents", "MacOS", "b")).ino, bInode, "an unchanged file is not rewritten");
    assert.equal(readdirSync(join(dst, "Contents")).includes("Resources"), false, "the stale file and its now-empty directory went");
    assert.ok(!readdirSync(join(dst, "Contents")).some((n) => n === ".~tmp~" || n.startsWith("._")), "nothing temporary left behind");
    const parity = compareTrees(src, dst);
    assert.ok(parityOk(parity), JSON.stringify(parity));

    appendFileSync(join(dst, "Contents", "MacOS", "a"), "!");
    writeFileSync(join(dst, "Contents", "extra"), "x");
    rmSync(join(dst, "Contents", "MacOS", "b"));
    const bad = compareTrees(src, dst);
    assert.deepEqual(bad, { missing: ["Contents/MacOS/b"], differing: ["Contents/MacOS/a"], extra: ["Contents/extra"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- performInstall: step 5 of build:mac over scripted seams — the order and every fail path.

/** A spec that asked for the rollback snapshot (JARHEAD_INSTALL_SNAPSHOT=1); `NO_SNAPSHOT` is the default build. */
const SPEC = { stage: "/r/build/stage/Jarhead.app", installed: "/Applications/Jarhead.app", previous: "/r/build/previous/Jarhead.app.zip", link: "/r/build/Jarhead.app", cleanup: "/r/build/stage", bundleId: "com.kevinliu.jarhead", uid: 501 };
const { previous: _previous, ...NO_SNAPSHOT } = SPEC;
const ABSENT: TargetProbe = { exists: false, isSymlink: false, isDirectory: false };
const DIR: TargetProbe = { exists: true, isSymlink: false, isDirectory: true, uid: 501, inode: 103261417, writable: true };
const OK_REQ = 'designated => identifier "com.kevinliu.jarhead" and certificate leaf = H"8b79555ca54ff1c95d3e044805f34d5adac36055"\n';
const ITEMIZED = ">fc...... Contents/MacOS/Jarhead\n>fc...... Contents/MacOS/jarhead-hands\n>f+++++++ Contents/Resources/new\n*deleting Contents/Resources/stale\n";

/** Records every seam call as one line so the whole order can be asserted at once. */
function scripted(o: { probes?: TargetProbe[]; snapshotCode?: number; rsyncCode?: number; rsyncOut?: string; cpCode?: number; verifyCode?: number; requirement?: string; parity?: ParityReport } = {}): { io: InstallIO; trace: string[]; warnings: string[] } {
  const trace: string[] = [];
  const warnings: string[] = [];
  const probes = [...(o.probes ?? [DIR, DIR])];
  const io: InstallIO = {
    exec: (cmd, args) => {
      trace.push(`exec ${cmd} ${args.join(" ")}`);
      if (cmd === "cp") return { code: o.cpCode ?? 0, stdout: "", stderr: o.cpCode ? "cp: /Applications/Jarhead.app: Permission denied" : "" };
      if (cmd === DITTO) return { code: o.snapshotCode ?? 0, stdout: "", stderr: o.snapshotCode ? "ditto: can't create archive" : "" };
      if (cmd === RSYNC) return { code: o.rsyncCode ?? 0, stdout: o.rsyncOut ?? ITEMIZED, stderr: o.rsyncCode ? "rsync error: some files could not be transferred" : "" };
      if (cmd === CODESIGN && args[0] === "--verify") return { code: o.verifyCode ?? 0, stdout: "", stderr: o.verifyCode ? "/Applications/Jarhead.app: a sealed resource is missing or invalid" : "/Applications/Jarhead.app: valid on disk\n" };
      if (cmd === CODESIGN && args[0] === "-d") return { code: 0, stdout: "", stderr: o.requirement ?? OK_REQ };
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    },
    probe: (path) => {
      trace.push(`probe ${path}`);
      return probes.shift() ?? DIR;
    },
    mkdirp: (path) => void trace.push(`mkdirp ${path}`),
    rmTree: (path) => void trace.push(`rmTree ${path}`),
    relink: (target, link) => void trace.push(`relink ${link} -> ${target}`),
    compare: (stage, installed) => {
      trace.push(`compare ${stage} ${installed}`);
      return o.parity ?? { missing: [], differing: [], extra: [] };
    },
    warn: (line) => void warnings.push(line),
  };
  return { io, trace, warnings };
}

test("performInstall, update with a snapshot asked for: plan → mkdir previous → ditto snapshot → rsync in place → strict+deep verify of the INSTALLED copy → designated requirement → parity walk → inode → unstage → relink, in that order, then the rollback line", () => {
  const { io, trace, warnings } = scripted();
  const r = performInstall(SPEC, io);
  assert.deepEqual(trace, [
    "probe /Applications/Jarhead.app",
    "mkdirp /r/build/previous",
    `exec ${DITTO} ${snapshotArgs(SPEC.installed, SPEC.previous).join(" ")}`,
    `exec ${RSYNC} ${rsyncArgs(SPEC.stage, SPEC.installed).join(" ")}`,
    `exec ${CODESIGN} ${CODESIGN_VERIFY_ARGS.join(" ")} /Applications/Jarhead.app`,
    `exec ${CODESIGN} ${CODESIGN_REQUIREMENT_ARGS.join(" ")} /Applications/Jarhead.app`,
    "compare /r/build/stage/Jarhead.app /Applications/Jarhead.app",
    "probe /Applications/Jarhead.app",
    "rmTree /r/build/stage",
    "relink /r/build/Jarhead.app -> /Applications/Jarhead.app",
  ]);
  assert.ok(!trace.some((t) => /--inplace|-E\b| -a /.test(t)));
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.plan, { kind: "update", inode: 103261417 });
    assert.equal(r.rollback, rollbackLine(SPEC.previous, SPEC.installed));
    assert.equal(r.rollback, `rollback:  ${DITTO} -x -k /r/build/previous/Jarhead.app.zip /tmp/jarhead-rollback && ${RSYNC} -rlptD -c --delete-after /tmp/jarhead-rollback/Jarhead.app/ /Applications/Jarhead.app/`);
    assert.equal(r.line, "install    /Applications/Jarhead.app kept (inode 103261417) · 2 files replaced, 1 added, 1 removed · strict ok · requirement identifier com.kevinliu.jarhead");
  }
  assert.deepEqual(warnings, []);
});

test("performInstall, update without a snapshot (the default build): no mkdirp, no ditto, no rollback line — plan → rsync in place → verify → parity → inode → unstage → relink; every fail path names no rollback", () => {
  const { io, trace, warnings } = scripted();
  const r = performInstall(NO_SNAPSHOT, io);
  assert.deepEqual(trace, [
    "probe /Applications/Jarhead.app",
    `exec ${RSYNC} ${rsyncArgs(SPEC.stage, SPEC.installed).join(" ")}`,
    `exec ${CODESIGN} ${CODESIGN_VERIFY_ARGS.join(" ")} /Applications/Jarhead.app`,
    `exec ${CODESIGN} ${CODESIGN_REQUIREMENT_ARGS.join(" ")} /Applications/Jarhead.app`,
    "compare /r/build/stage/Jarhead.app /Applications/Jarhead.app",
    "probe /Applications/Jarhead.app",
    "rmTree /r/build/stage",
    "relink /r/build/Jarhead.app -> /Applications/Jarhead.app",
  ]);
  assert.ok(!trace.some((t) => t.startsWith("mkdirp") || t.startsWith(`exec ${DITTO}`)), "nothing archived, no directory made");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.rollback, undefined, "no snapshot → no rollback line to print");
    assert.deepEqual(r.plan, { kind: "update", inode: 103261417 });
    assert.equal(r.line, "install    /Applications/Jarhead.app kept (inode 103261417) · 2 files replaced, 1 added, 1 removed · strict ok · requirement identifier com.kevinliu.jarhead");
  }
  assert.deepEqual(warnings, []);
  // A failure after the rsync keeps the stage and offers no rollback: there is none to offer.
  const failed = performInstall(NO_SNAPSHOT, scripted({ verifyCode: 1 }).io);
  assert.ok(!failed.ok);
  if (!failed.ok) {
    assert.match(failed.what, /^the installed bundle does not verify/);
    assert.deepEqual(failed.lines, []);
  }
});

test("performInstall, update with a snapshot asked for: the ditto archive is taken before the rsync, the outcome carries the rollback line, and a `previous` that itself ends in .app is refused before anything runs", () => {
  const { io, trace } = scripted();
  const r = performInstall(SPEC, io);
  const ditto = trace.indexOf(`exec ${DITTO} ${snapshotArgs(SPEC.installed, SPEC.previous).join(" ")}`);
  const rsync = trace.findIndex((t) => t.startsWith(`exec ${RSYNC}`));
  assert.ok(ditto > 0 && rsync > ditto, `snapshot, then rsync: ${JSON.stringify(trace)}`);
  assert.equal(trace[ditto - 1], "mkdirp /r/build/previous");
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.rollback, rollbackLine(SPEC.previous, SPEC.installed));
  // The guard: a `previous` named .app would be a second Jarhead to LaunchServices on the next scan.
  const bad = scripted();
  const refused = performInstall({ ...SPEC, previous: "/r/build/previous/Jarhead.app" }, bad.io);
  assert.ok(!refused.ok);
  if (!refused.ok) {
    assert.equal(refused.what, "refusing to install: the snapshot path /r/build/previous/Jarhead.app is not a .zip archive");
    assert.match(refused.lines[0] ?? "", /second Jarhead; snapshot to a \.zip archive/);
  }
  assert.deepEqual(bad.trace, ["probe /Applications/Jarhead.app"], "refused before the snapshot or any write");
});

test("performInstall, first install: cp -R of the stage into the parent directory, no snapshot, no inode check, the line says created", () => {
  const created: TargetProbe = { ...DIR, inode: 555 };
  const { io, trace, warnings } = scripted({ probes: [{ exists: false, isSymlink: false, isDirectory: false }, created] });
  const r = performInstall(SPEC, io);
  assert.deepEqual(trace.slice(0, 3), ["probe /Applications/Jarhead.app", "exec cp -R /r/build/stage/Jarhead.app /Applications/", `exec ${CODESIGN} ${CODESIGN_VERIFY_ARGS.join(" ")} /Applications/Jarhead.app`]);
  assert.ok(!trace.some((t) => t.startsWith(`exec ${RSYNC}`)), "nothing to snapshot or sync into");
  assert.ok(trace.includes("relink /r/build/Jarhead.app -> /Applications/Jarhead.app"));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.rollback, undefined);
    assert.match(r.line, /^install    \/Applications\/Jarhead\.app created \(inode 555\) · copied whole/);
  }
  assert.deepEqual(warnings, []);
  const denied = performInstall(SPEC, scripted({ probes: [{ exists: false, isSymlink: false, isDirectory: false }], cpCode: 1 }).io);
  assert.ok(!denied.ok);
  if (!denied.ok) {
    assert.equal(denied.what, "cp -R exited 1");
    assert.deepEqual(denied.lines, ["cp: /Applications/Jarhead.app: Permission denied"]);
  }
});

test("performInstall refuses before anything runs: a symlink, a file, another uid or no write bit at the target means no command, no snapshot, the plan's own hint", () => {
  for (const probe of [
    { exists: true, isSymlink: true, isDirectory: false, uid: 501, inode: 7, linkTarget: "/r/build/stage/Jarhead.app" },
    { exists: true, isSymlink: false, isDirectory: false, uid: 501, inode: 8, writable: true },
    { ...DIR, uid: 0 },
    { ...DIR, writable: false },
  ] satisfies TargetProbe[]) {
    const { io, trace } = scripted({ probes: [probe] });
    const r = performInstall(SPEC, io);
    assert.deepEqual(trace, ["probe /Applications/Jarhead.app"], JSON.stringify(probe));
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.match(r.what, /^refusing to install: \/Applications\/Jarhead\.app /);
      assert.equal(r.lines.length, 1, "the hint alone — there is no snapshot to roll back to");
    }
  }
});

test("performInstall fail paths keep the stage and name the rollback when a snapshot exists: rsync non-zero, a leaked ._ entry, a failed verify, a missing identifier, a parity mismatch", () => {
  const rollback = rollbackLine(SPEC.previous, SPEC.installed);
  const cases: Array<[string, Parameters<typeof scripted>[0], RegExp, string[]]> = [
    ["rsync", { rsyncCode: 23 }, /^rsync exited 23$/, ["rsync error: some files could not be transferred", rollback]],
    ["appledouble", { rsyncOut: ">f+++++++ Contents/._Info.plist\n" }, /^xattr emulation leaked into the bundle \(Contents\/\._Info\.plist\); never pass -E$/, [rollback]],
    ["verify", { verifyCode: 1 }, /^the installed bundle does not verify: .*sealed resource/, [rollback]],
    ["identifier", { requirement: 'designated => identifier "com.kevinliu.jarvis"\n' }, /^the designated requirement lacks identifier "com\.kevinliu\.jarhead"/, [rollback]],
    ["parity", { parity: { missing: ["Contents/MacOS/jarhead-hands"], differing: [], extra: ["Contents/._x"] } }, /^the installed tree is not the signed stage$/, ["missing: Contents/MacOS/jarhead-hands", "differing: —", "extra: Contents/._x", rollback]],
  ];
  for (const [name, opts, what, lines] of cases) {
    const { io, trace } = scripted(opts);
    const r = performInstall(SPEC, io);
    assert.ok(!r.ok, name);
    if (!r.ok) {
      assert.match(r.what, what, name);
      assert.deepEqual(r.lines, lines, name);
    }
    assert.ok(!trace.some((t) => t.startsWith("rmTree /r/build/stage") || t.startsWith("relink")), `${name}: the stage is kept and the link untouched`);
    assert.ok(trace.some((t) => t.includes("--delete-after ")), `${name}: the install rsync ran`);
  }
  // A verify that fails AFTER rsync never re-probes or compares.
  const { trace } = (() => {
    const s = scripted({ verifyCode: 1 });
    performInstall(SPEC, s.io);
    return s;
  })();
  assert.ok(!trace.some((t) => t.startsWith("compare")));
  assert.equal(trace.filter((t) => t.startsWith("probe /Applications")).length, 1);
});

test("performInstall: a failed snapshot is a warning, continues, and drops the rollback line from every later failure; a replaced directory inode is a warning and a REPLACED line, not a failure", () => {
  const noSnap = scripted({ snapshotCode: 1, verifyCode: 1 });
  const r = performInstall(SPEC, noSnap.io);
  assert.ok(!r.ok);
  if (!r.ok) assert.deepEqual(r.lines, [], "no snapshot → no rollback to offer");
  assert.deepEqual(noSnap.warnings, ["rollback snapshot failed (1); continuing without one: ditto: can't create archive"]);
  const okNoSnap = performInstall(SPEC, scripted({ snapshotCode: 1 }).io);
  assert.ok(okNoSnap.ok && okNoSnap.rollback === undefined);

  const replaced = scripted({ probes: [DIR, { ...DIR, inode: 999 }] });
  const r2 = performInstall(SPEC, replaced.io);
  assert.ok(r2.ok);
  if (r2.ok) assert.match(r2.line, /REPLACED \(inode 103261417 → 999\) — report this/);
  assert.deepEqual(replaced.warnings, ["the bundle directory was replaced (inode 103261417 → 999); the Dock tile may duplicate — report this"]);
  assert.ok(replaced.trace.includes("relink /r/build/Jarhead.app -> /Applications/Jarhead.app"), "the install stands; the warning is for Kevin");
});

test("ditto snapshot: snapshotArgs writes build/previous/Jarhead.app.zip holding Jarhead.app whole; a second snapshot replaces it and drops what the bundle no longer has; an archive is never a bundle LaunchServices can register", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "jh-snapshot-"));
  try {
    const installed = join(root, "Applications", "Jarhead.app");
    const previous = join(root, "build", "previous", "Jarhead.app.zip");
    assert.ok(snapshotNameOk(previous));
    mkdirSync(join(installed, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(installed, "Contents", "MacOS", "Jarhead"), "bin");
    writeFileSync(join(installed, "Contents", "Info.plist"), "plist");
    mkdirSync(join(root, "build", "previous"), { recursive: true });
    execFileSync(DITTO, snapshotArgs(installed, previous), { encoding: "utf8" });
    const out1 = join(root, "out1");
    execFileSync(DITTO, ["-x", "-k", previous, out1], { encoding: "utf8" });
    assert.ok(parityOk(compareTrees(installed, join(out1, "Jarhead.app"))), "the archive holds the bundle whole, under its own name");
    rmSync(join(installed, "Contents", "Info.plist"));
    writeFileSync(join(installed, "Contents", "MacOS", "Jarhead"), "bin2");
    execFileSync(DITTO, snapshotArgs(installed, previous), { encoding: "utf8" });
    const out2 = join(root, "out2");
    execFileSync(DITTO, ["-x", "-k", previous, out2], { encoding: "utf8" });
    const parity = compareTrees(installed, join(out2, "Jarhead.app"));
    assert.ok(parityOk(parity), JSON.stringify(parity));
    assert.ok(!readdirSync(join(out2, "Jarhead.app", "Contents")).includes("Info.plist"), "a second snapshot is the bundle as it is now");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
