import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseIdentity } from "../../../../scripts/sign-identity.ts";
import { checkRequirement, compareTrees, performInstall, probeTarget, type InstallIO } from "../bundle.ts";
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
    const spec = { stage: join(root, "build", "stage", "AdhocJarhead.app"), installed: join(apps, "AdhocJarhead.app"), link: join(root, "build", "AdhocJarhead.app"), cleanup: join(root, "build", "stage"), bundleId: ADHOC_BUNDLE_ID, uid: process.getuid?.() ?? -1 };

    signLikeBuildMac(makeStage(root, "one"), chosen.identity);
    const warnings: string[] = [];
    const first = performInstall(spec, realIO(warnings));
    assert.ok(first.ok, `first install: ${first.ok ? "" : `${first.what} | ${first.lines.join(" | ")}`}`);
    assert.equal(first.plan.kind, "create");
    assert.match(first.line, /strict ok · ad-hoc, identifier com\.example\.jarhead-adhoc-install$/);
    assert.deepEqual(warnings, ["ad-hoc: grants reset on every rebuild"]);
    assert.equal(lstatSync(spec.link).isSymbolicLink(), true, "build/ link points at the installed copy");

    // A rebuild re-signs: a new cdhash, so a new designated requirement. Still accepted, in place.
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
