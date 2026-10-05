import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseIdentity } from "../../../../scripts/sign-identity.ts";
import { CODESIGN, CODESIGN_AUTHORITY_ARGS, RSYNC, checkRequirement, compareTrees, performInstall, probeTarget, signingAuthority, type InstallIO, type TargetProbe } from "../bundle.ts";
import { defaultExec } from "../hygiene.ts";
import { ADHOC_BUNDLE_ID, canSignAdhoc, makeStage, signLikeBuildMac } from "./adhoc-stage.ts";

/**
 * W1-12 / INS-1: a Mac with no signing identity. build-mac.ts picks ad-hoc (chooseIdentity
 * with an empty keychain), and its install step used to refuse the result: an ad-hoc
 * designated requirement is `cdhash H"…"`, never `identifier "…"`, so the one-line install
 * exited 1 at step 5 and never opened the app. Real codesign, real cp/rsync, the real
 * performInstall with the IO build-mac.ts passes, into a temp "Applications" folder.
 */

const skip = canSignAdhoc() ? false : "needs macOS codesign";

const ID = "com.kevinliu.jarhead";
const SIGNED_AS = (id: string): string => `Executable=/Applications/Jarhead.app/Contents/MacOS/Jarhead\nIdentifier=${id}\nFormat=app bundle with Mach-O thin (arm64)\n`;

test("checkRequirement: an identity's requirement must name the bundle id; an ad-hoc cdhash requirement passes on the signature's own Identifier", () => {
  const leaf = 'designated => identifier "com.kevinliu.jarhead" and certificate leaf = H"8b79555ca54ff1c95d3e044805f34d5adac36055"';
  assert.deepEqual(checkRequirement(`${leaf}\n${SIGNED_AS(ID)}Authority=Jarhead Local Signing\n`, ID), { ok: true, adhoc: false });
  assert.deepEqual(checkRequirement('designated => identifier "com.kevinliu.jarhead" and anchor apple generic\n', ID), { ok: true, adhoc: false });

  const thin = '# designated => cdhash H"5f0c1b3e9a7d2c4e8b6a0f1d3c5e7a9b2d4f6e8a"';
  const universal = '# designated => cdhash H"b26a76fe21b4e183527229d555f7d6d7c93bd291" or cdhash H"eeb5d138d044dc3a8af55119b94eace71c123a82"';
  assert.deepEqual(checkRequirement(`${thin}\n${SIGNED_AS(ID)}Signature=adhoc\n`, ID), { ok: true, adhoc: true });
  assert.deepEqual(checkRequirement(`${universal}\n${SIGNED_AS(ID)}Signature=adhoc\nTeamIdentifier=not set\n`, ID), { ok: true, adhoc: true });

  const refused = (output: string): string => {
    const r = checkRequirement(output, ID);
    assert.ok(!r.ok, output);
    return r.ok ? "" : r.reason;
  };
  assert.equal(refused(`${thin}\n${SIGNED_AS("com.kevinliu.jarvis")}Signature=adhoc\n`), `designated requirement lacks identifier "${ID}": designated => cdhash H"5f0c1b3e9a7d2c4e8b6a0f1d3c5e7a9b2d4f6e8a" (ad-hoc, signed as com.kevinliu.jarvis)`);
  assert.equal(refused(`designated => identifier "com.kevinliu.jarvis"\n${SIGNED_AS("com.kevinliu.jarvis")}`), `designated requirement lacks identifier "${ID}": designated => identifier "com.kevinliu.jarvis"`);
  assert.match(refused(`${thin}\n${SIGNED_AS(ID)}`), /lacks identifier .*: designated => cdhash H"5f0c/, "a cdhash requirement without Signature=adhoc is not ad-hoc");
  assert.match(refused(`designated => identifier "com.kevinliu.jarvis"\n${SIGNED_AS(ID)}Signature=adhoc\n`), /\(ad-hoc, signed as com\.kevinliu\.jarhead\)$/, "an explicit requirement naming another id is refused, ad-hoc or not");
  assert.match(refused(`${SIGNED_AS(ID)}Signature=adhoc\n`), /: Executable=\/Applications\/Jarhead\.app/, "no requirement line at all");
  assert.equal(refused(""), `designated requirement lacks identifier "${ID}": codesign printed no requirement`);
});

function realIO(warnings: string[]): InstallIO {
  return {
    exec: (cmd, args) => defaultExec(cmd, args, { timeoutMs: 120_000 }),
    probe: probeTarget,
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    rmTree: (p) => rmSync(p, { recursive: true, force: true }),
    relink: (target, link) => {
      try {
        const st = lstatSync(link);
        if (st.isSymbolicLink() || st.isDirectory()) rmSync(link, { recursive: true, force: true });
      } catch {
        // nothing there
      }
      symlinkSync(target, link);
    },
    compare: compareTrees,
    warn: (line) => void warnings.push(line),
  };
}

function withRoot(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jh-adhoc-install-")));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an empty keychain picks ad-hoc, and performInstall installs that bundle, then updates it in place on a rebuild", { skip }, () => {
  withRoot((root) => {
    const chosen = chooseIdentity([], undefined);
    assert.equal(chosen.identity, undefined, "an empty keychain picks ad-hoc");
    const apps = join(root, "Applications");
    mkdirSync(apps);
    // signing "adhoc", as build-mac.ts passes for an unpinned ad-hoc pick: the update below reads the real installed signature first.
    const spec = { stage: join(root, "build", "stage", "AdhocJarhead.app"), installed: join(apps, "AdhocJarhead.app"), link: join(root, "build", "AdhocJarhead.app"), cleanup: join(root, "build", "stage"), bundleId: ADHOC_BUNDLE_ID, uid: process.getuid?.() ?? -1, signing: "adhoc" as const };

    signLikeBuildMac(makeStage(root, "one"), chosen.identity);
    const warnings: string[] = [];
    const first = performInstall(spec, realIO(warnings));
    assert.ok(first.ok, `first install: ${first.ok ? "" : `${first.what} | ${first.lines.join(" | ")}`}`);
    assert.equal(first.plan.kind, "create");
    assert.match(first.line, /strict ok · ad-hoc, identifier com\.example\.jarhead-adhoc-install$/);
    assert.deepEqual(warnings, ["ad-hoc: grants reset on every rebuild"]);
    assert.equal(lstatSync(spec.link).isSymbolicLink(), true, "build/ link points at the installed copy");

    // A rebuild re-signs: a new cdhash, so a new designated requirement. Still accepted, in place:
    // the installed copy is ad-hoc too, so there is no identity to lose.
    assert.equal(signingAuthority(execText("/usr/bin/codesign", [...CODESIGN_AUTHORITY_ARGS, spec.installed])), undefined, "the real installed copy reads as ad-hoc");
    signLikeBuildMac(makeStage(root, "two"), chosen.identity);
    const second = performInstall(spec, realIO(warnings));
    assert.ok(second.ok, `second install: ${second.ok ? "" : `${second.what} | ${second.lines.join(" | ")}`}`);
    assert.equal(second.plan.kind, "update");
    assert.equal(second.inodeAfter, first.inodeAfter, "the bundle directory is kept");
    assert.ok((second.rsync?.updated.length ?? 0) > 0, "the changed files were renamed in");
    assert.match(second.line, /kept \(inode \d+\) · .* · strict ok · ad-hoc, identifier com\.example\.jarhead-adhoc-install$/);
  });
});

test("an ad-hoc bundle signed under another identifier is refused, and the message carries the designated => line", { skip }, () => {
  withRoot((root) => {
    const apps = join(root, "Applications");
    mkdirSync(apps);
    signLikeBuildMac(makeStage(root, "one"), undefined);
    const spec = { stage: join(root, "build", "stage", "AdhocJarhead.app"), installed: join(apps, "AdhocJarhead.app"), link: join(root, "build", "AdhocJarhead.app"), cleanup: join(root, "build", "stage"), bundleId: "com.kevinliu.jarhead", uid: process.getuid?.() ?? -1 };
    const r = performInstall(spec, realIO([]));
    assert.ok(!r.ok, "a bundle that is not the one asked for never installs");
    if (!r.ok) {
      assert.match(r.what, /^the designated requirement lacks identifier "com\.kevinliu\.jarhead": designated => cdhash H"[0-9a-f]+"(?: or cdhash H"[0-9a-f]+")* \(ad-hoc, signed as com\.example\.jarhead-adhoc-install\)$/);
    }
  });
});

/** stdout and stderr of a real command, joined the way performInstall joins them. */
function execText(cmd: string, args: readonly string[]): string {
  const r = defaultExec(cmd, args, { timeoutMs: 30_000 });
  return `${r.stdout}\n${r.stderr}`;
}

test("signingAuthority: the leaf Authority= of a real identity's signature; nothing for ad-hoc, unsigned or missing", { skip }, () => {
  // /usr/bin/true is signed by Apple: three Authority= lines, the leaf first.
  assert.equal(signingAuthority(execText("/usr/bin/codesign", [...CODESIGN_AUTHORITY_ARGS, "/usr/bin/true"])), "Software Signing");
  assert.equal(signingAuthority("Identifier=com.kevinliu.jarhead\nSignature size=1803\nAuthority=Jarhead Local Signing\nTeamIdentifier=not set\n"), "Jarhead Local Signing", "a self-signed certificate is one Authority= line");
  withRoot((root) => {
    const stage = makeStage(root, "one");
    signLikeBuildMac(stage, undefined);
    assert.equal(signingAuthority(execText("/usr/bin/codesign", [...CODESIGN_AUTHORITY_ARGS, stage])), undefined, "a real ad-hoc signature has no authority");
    assert.equal(signingAuthority(execText("/usr/bin/codesign", [...CODESIGN_AUTHORITY_ARGS, join(root, "missing.app")])), undefined, "nothing installed");
  });
  assert.equal(signingAuthority("/Applications/Jarhead.app: code object is not signed at all\n"), undefined);
  assert.equal(signingAuthority(""), undefined);
});

// ---- The downgrade guard over scripted seams: an unpinned ad-hoc stage never lands on an identity-signed install.

const DIR_PROBE: TargetProbe = { exists: true, isSymlink: false, isDirectory: true, uid: 501, inode: 103261417, writable: true };
const SCRIPTED_SPEC = { stage: "/r/build/stage/Jarhead.app", installed: "/Applications/Jarhead.app", link: "/r/build/Jarhead.app", cleanup: "/r/build/stage", bundleId: ID, uid: 501 };
const IDENTITY_SIGNED = `Executable=/Applications/Jarhead.app/Contents/MacOS/Jarhead\nIdentifier=${ID}\nSignature size=1803\nAuthority=Jarhead Local Signing\nSigned Time=Sep 20, 2026 at 9:14:02 PM\nTeamIdentifier=not set\n`;
const ADHOC_SIGNED = `Executable=/Applications/Jarhead.app/Contents/MacOS/Jarhead\nIdentifier=${ID}\nCodeDirectory v=20400 size=259 flags=0x2(adhoc) hashes=2+2 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n`;
const ADHOC_REQUIREMENT = `# designated => cdhash H"5f0c1b3e9a7d2c4e8b6a0f1d3c5e7a9b2d4f6e8a"\n${SIGNED_AS(ID)}Signature=adhoc\n`;

function scriptedIO(installedSignature: string, probes: TargetProbe[] = [DIR_PROBE, DIR_PROBE]): { io: InstallIO; trace: string[]; warnings: string[] } {
  const trace: string[] = [];
  const warnings: string[] = [];
  const queue = [...probes];
  const io: InstallIO = {
    exec: (cmd, args) => {
      trace.push(`exec ${cmd} ${args.join(" ")}`);
      if (cmd === CODESIGN && args.join(" ") === `${CODESIGN_AUTHORITY_ARGS.join(" ")} ${SCRIPTED_SPEC.installed}`) return { code: 0, stdout: "", stderr: installedSignature };
      if (cmd === CODESIGN && args[0] === "--verify") return { code: 0, stdout: "", stderr: "valid on disk\n" };
      if (cmd === CODESIGN && args[0] === "-d") return { code: 0, stdout: "", stderr: ADHOC_REQUIREMENT };
      if (cmd === RSYNC) return { code: 0, stdout: ">fc...... Contents/MacOS/Jarhead\n", stderr: "" };
      if (cmd === "cp") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    },
    probe: (path) => {
      trace.push(`probe ${path}`);
      return queue.shift() ?? DIR_PROBE;
    },
    mkdirp: (path) => void trace.push(`mkdirp ${path}`),
    rmTree: (path) => void trace.push(`rmTree ${path}`),
    relink: (target, link) => void trace.push(`relink ${link} -> ${target}`),
    compare: () => ({ missing: [], differing: [], extra: [] }),
    warn: (line) => void warnings.push(line),
  };
  return { io, trace, warnings };
}

test("an unpinned ad-hoc build over an identity-signed install is refused before anything is written, and the refusal names the certificate fix and the pin", () => {
  const { io, trace } = scriptedIO(IDENTITY_SIGNED);
  const r = performInstall({ ...SCRIPTED_SPEC, signing: "adhoc" }, io);
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.what, 'refusing to install: this build is signed ad-hoc, and /Applications/Jarhead.app is signed by "Jarhead Local Signing"');
    assert.deepEqual(r.lines, [
      "Installing it would reset every permission grant. The keychain listed no code-signing identity, so that certificate has likely expired or been removed.",
      'See what the keychain has: security find-identity -v -p codesigning. Renew or recreate "Jarhead Local Signing" in Keychain Access, then run pnpm build:mac again.',
      "Or install ad-hoc anyway and grant the permissions again: JARHEAD_SIGN_IDENTITY=- pnpm build:mac",
    ]);
    for (const line of [r.what, ...r.lines]) assert.doesNotMatch(line, /\u2014/, "no em dash");
  }
  assert.deepEqual(trace, ["probe /Applications/Jarhead.app", `exec ${CODESIGN} ${CODESIGN_AUTHORITY_ARGS.join(" ")} /Applications/Jarhead.app`], "only the read: no rsync, no copy, no relink");
});

test("the guard lets the rest through: JARHEAD_SIGN_IDENTITY=- installs over an identity, ad-hoc over ad-hoc installs, a first install never asks, an identity build never asks", () => {
  const pinned = scriptedIO(IDENTITY_SIGNED);
  const p = performInstall({ ...SCRIPTED_SPEC, signing: "adhoc-pinned" }, pinned.io);
  assert.ok(p.ok, "a pinned - is a choice");
  assert.ok(!pinned.trace.some((t) => t.includes(CODESIGN_AUTHORITY_ARGS.join(" "))), "and the installed signature is not even read");
  assert.ok(pinned.trace.some((t) => t.startsWith(`exec ${RSYNC}`)));
  assert.deepEqual(pinned.warnings, ["ad-hoc: grants reset on every rebuild"]);

  const overAdhoc = scriptedIO(ADHOC_SIGNED);
  assert.ok(performInstall({ ...SCRIPTED_SPEC, signing: "adhoc" }, overAdhoc.io).ok, "ad-hoc over ad-hoc loses nothing");
  assert.equal(overAdhoc.trace[1], `exec ${CODESIGN} ${CODESIGN_AUTHORITY_ARGS.join(" ")} /Applications/Jarhead.app`, "read before the rsync");
  assert.ok(overAdhoc.trace[2]?.startsWith(`exec ${RSYNC}`));

  const unsigned = scriptedIO("/Applications/Jarhead.app: code object is not signed at all\n");
  assert.ok(performInstall({ ...SCRIPTED_SPEC, signing: "adhoc" }, unsigned.io).ok, "an unsigned leftover has no grants to keep");

  const absent: TargetProbe = { exists: false, isSymlink: false, isDirectory: false };
  const applications: TargetProbe = { exists: true, isSymlink: false, isDirectory: true, uid: 0, inode: 2, writable: true };
  const fresh = scriptedIO(IDENTITY_SIGNED, [absent, applications, DIR_PROBE]);
  const f = performInstall({ ...SCRIPTED_SPEC, signing: "adhoc" }, fresh.io);
  assert.ok(f.ok, "a fresh Mac installs ad-hoc");
  if (f.ok) assert.equal(f.plan.kind, "create");
  assert.ok(!fresh.trace.some((t) => t.includes(CODESIGN_AUTHORITY_ARGS.join(" "))), "nothing installed, nothing to read");

  const identity = scriptedIO(IDENTITY_SIGNED);
  performInstall({ ...SCRIPTED_SPEC, signing: "identity" }, identity.io);
  assert.ok(!identity.trace.some((t) => t.includes(CODESIGN_AUTHORITY_ARGS.join(" "))), "an identity build is not guarded");
});
