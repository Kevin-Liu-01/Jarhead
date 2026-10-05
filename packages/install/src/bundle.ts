import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The install step: what the target is, how rsync is invoked, what its itemized
 * output says, whether the installed tree is exactly the signed stage — and
 * `performInstall`, the order those run in. Nothing here runs a command itself:
 * every shell-out and every stat goes through the `InstallIO` seams build-mac.ts
 * passes in, so a scripted run pins the order and every fail path without touching
 * /Applications. The one rule under all of it: /Applications/Jarhead.app is updated
 * in place — files renamed in, the directory (and its inode, which the Dock's
 * bookmark keys on) never recreated. That keeps the pin valid; it is not the only
 * way to a second tile — a helper inside the bundle that never sets its activation
 * policy is checked in as a second Foreground "Jarhead" (see dock.ts, jarhead-hands'
 * main.swift), and no install can fix that one.
 */

export interface TargetProbe {
  readonly exists: boolean;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
  readonly uid?: number;
  readonly inode?: number;
  readonly linkTarget?: string;
  readonly writable?: boolean;
}

export type InstallPlan =
  | { readonly kind: "create" }
  | { readonly kind: "update"; readonly inode: number }
  | { readonly kind: "refuse"; readonly reason: string; readonly hint: string };

/** lstat, never stat: a symlink must be seen as one, because rsync would follow it and write into its target. */
export function probeTarget(path: string): TargetProbe {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { exists: false, isSymlink: false, isDirectory: false };
  }
  if (st.isSymbolicLink()) {
    let linkTarget = "?";
    try {
      linkTarget = readlinkSync(path);
    } catch {
      // unreadable link: the reason still says it is one
    }
    return { exists: true, isSymlink: true, isDirectory: false, uid: st.uid, inode: st.ino, linkTarget };
  }
  let writable = true;
  try {
    accessSync(path, constants.W_OK);
  } catch {
    writable = false;
  }
  return { exists: true, isSymlink: false, isDirectory: st.isDirectory(), uid: st.uid, inode: st.ino, writable };
}

/**
 * `parent` is the probe of the target's directory, wanted only when the target is absent: a
 * first install copies into it, and a standard (non-administrator) account cannot write
 * /Applications — `cp -R` would only say "Permission denied". The refusal says what to do
 * instead; there is no install-location knob to point at, so the answer is an administrator
 * account. `user` names the account in that line (the uid when unknown).
 */
export function planInstall(probe: TargetProbe, uid: number, path = "/Applications/Jarhead.app", parent?: TargetProbe, user?: string): InstallPlan {
  if (!probe.exists) {
    if (parent?.exists && parent.writable === false) {
      return { kind: "refuse", reason: `${dirname(path)} is not writable by ${user ?? `uid ${uid}`}: install from an administrator account`, hint: `the script never runs sudo` };
    }
    return { kind: "create" };
  }
  if (probe.isSymlink) {
    return { kind: "refuse", reason: `${path} is a symlink to ${probe.linkTarget ?? "?"}; rsync would write into the target`, hint: `move it to the Trash in Finder (or mv it aside) and rerun pnpm build:mac` };
  }
  if (!probe.isDirectory) return { kind: "refuse", reason: `${path} is not a directory`, hint: `move it to the Trash in Finder and rerun pnpm build:mac` };
  if (probe.uid !== undefined && probe.uid !== uid) {
    return { kind: "refuse", reason: `${path} is owned by uid ${probe.uid}, not ${uid}`, hint: `sudo chown -R "$(id -un)" ${path}   # or drag it to the Trash and rerun pnpm build:mac; the script never runs sudo` };
  }
  if (probe.writable === false) return { kind: "refuse", reason: `${path} is not writable`, hint: `chmod u+w ${path} and rerun pnpm build:mac` };
  return { kind: "update", inode: probe.inode ?? -1 };
}

export const RSYNC = "/usr/bin/rsync";
export const DITTO = "/usr/bin/ditto";

/**
 * -rlptD is -a minus owner/group (never rewritten); -c compares by checksum so a
 * same-size-same-second file cannot be skipped; --delay-updates renames every changed
 * file in one burst after the transfer; --delete-after removes what the stage no
 * longer has. Never -a, never -E (openrsync's xattr emulation writes AppleDouble
 * `._*` entries into a sealed bundle), never --inplace (it would write into the
 * running app's mapped, signed Mach-O). Trailing slashes: contents, not the directory.
 */
export function rsyncArgs(stage: string, installed: string): string[] {
  return ["-rlptD", "-c", "--delay-updates", "--delete-after", "--itemize-changes", `${stage}/`, `${installed}/`];
}

/**
 * The rollback snapshot of the installed bundle before an update, when one was asked for
 * (`InstallSpec.previous`) — a ZIP archive (`ditto -c -k`), never a directory: LaunchServices
 * registers any directory holding an Info.plist as a bundle, a second Jarhead whatever the
 * directory is called. An archive has no bundle to find. `snapshotNameOk` is the guard;
 * `--sequesterRsrc --keepParent` keeps resource forks and the top-level Jarhead.app.
 */
export function snapshotArgs(installed: string, previous: string): string[] {
  return ["-c", "-k", "--sequesterRsrc", "--keepParent", installed, previous];
}

/** A snapshot LaunchServices will not take for a bundle: a `.zip` file, never anything ending in `.app`. */
export function snapshotNameOk(previous: string): boolean {
  const p = previous.replace(/\/+$/, "");
  return /\.zip$/i.test(p) && !/\.app$/i.test(p);
}

export interface RsyncSummary {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  /** Every path `--delete-after` removed, files and emptied directories alike, each once, no trailing slash. */
  readonly deleted: readonly string[];
  /** Any `._*` entry: xattr emulation leaked in; the build fails on it. */
  readonly appleDouble: readonly string[];
}

/**
 * `--itemize-changes` lines: `>f+++++++ p` created, `>f.c…` (any other flag string)
 * updated, `cd+++++++ p/` a directory made (not counted), `*deleting p` removed,
 * `.d..t.... ./` a directory touched (ignored). Symlinks (`>L`, `cL`) count like files.
 *
 * The deletion lines differ by openrsync build, so the parser is version-agnostic: this
 * Mac's prints the emptied directory as `Contents/Resources/` (trailing slash); GitHub's
 * macos-15 runner prints it as `Contents/Resources` and lists every deletion twice (one
 * line per --delete-after pass). Every list holds each path once, slashes trimmed, and
 * directories are kept in `deleted` — the callers ask "is the stale subtree gone", never
 * "how many files".
 */
export function parseItemized(stdout: string): RsyncSummary {
  const created = new Set<string>();
  const updated = new Set<string>();
  const deleted = new Set<string>();
  const appleDouble = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const del = line.match(/^\*deleting\s+(.*)$/);
    if (del) {
      const path = (del[1] as string).replace(/\/+$/, "");
      if (path && path !== ".") note(path, deleted);
      continue;
    }
    const m = line.match(/^([<>ch.*])(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, op, flags, rest] = m as unknown as [string, string, string, string];
    const path = rest.replace(/\s+->\s+.*$/, "");
    const type = flags[0];
    if (type === "d") continue;
    if (op === "." || op === "h") continue;
    if (/^\S\++$/.test(flags)) note(path, created);
    else note(path, updated);
  }
  return { created: [...created], updated: [...updated], deleted: [...deleted], appleDouble: [...appleDouble] };

  function note(path: string, into: Set<string>): void {
    into.add(path);
    const base = path.split("/").pop() ?? "";
    if (base.startsWith("._")) appleDouble.add(path);
  }
}

export interface ParityReport {
  readonly missing: readonly string[];
  readonly differing: readonly string[];
  readonly extra: readonly string[];
}

export function parityOk(p: ParityReport): boolean {
  return p.missing.length === 0 && p.differing.length === 0 && p.extra.length === 0;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(root: string, rel = "", out: string[] = []): string[] {
  for (const name of readdirSync(join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    out.push(r);
    const st = lstatSync(join(root, r));
    if (st.isDirectory()) walk(root, r, out);
  }
  return out;
}

/** Every regular file by sha256, every symlink by target, directories by presence: `installed` must be exactly `stage`. */
export function compareTrees(stage: string, installed: string): ParityReport {
  const missing: string[] = [];
  const differing: string[] = [];
  const extra: string[] = [];
  const left = walk(stage);
  const leftSet = new Set(left);
  for (const rel of left) {
    const a = lstatSync(join(stage, rel));
    let b;
    try {
      b = lstatSync(join(installed, rel));
    } catch {
      missing.push(rel);
      continue;
    }
    if (a.isDirectory()) {
      if (!b.isDirectory()) differing.push(rel);
    } else if (a.isSymbolicLink()) {
      if (!b.isSymbolicLink() || readlinkSync(join(stage, rel)) !== readlinkSync(join(installed, rel))) differing.push(rel);
    } else if (a.isFile()) {
      if (!b.isFile() || sha256(join(stage, rel)) !== sha256(join(installed, rel))) differing.push(rel);
    }
  }
  let right: string[] = [];
  try {
    right = walk(installed);
  } catch {
    // an absent target: every stage entry is already missing
  }
  for (const rel of right) if (!leftSet.has(rel)) extra.push(rel);
  return { missing, differing, extra };
}

export const CODESIGN = "/usr/bin/codesign";
/** `--deep` checks the nested jarhead-hands too; `--strict` refuses sideband data (resource forks, FinderInfo) a bad copy could add. */
export const CODESIGN_VERIFY_ARGS = ["--verify", "--strict", "--deep", "--verbose=1"] as const;
/**
 * The designated requirement and the signature, in one call. `-r-` prints the requirement
 * on stdout: `designated => identifier "com.kevinliu.jarhead" and certificate leaf = H"…"`
 * for a real identity, `# designated => cdhash H"…"` for an ad-hoc signature (implicit;
 * one hash per architecture). `-v` prints `Identifier=…` and `Signature=adhoc` on stderr.
 */
export const CODESIGN_REQUIREMENT_ARGS = ["-d", "-v", "-r-"] as const;

/** `-vv` adds one `Authority=` line (stderr) per certificate in the signing chain, the leaf first. An ad-hoc signature has none and says `Signature=adhoc`. */
export const CODESIGN_AUTHORITY_ARGS = ["-d", "-vv"] as const;

/**
 * The certificate that signed, from `codesign -d -vv` output (stdout and stderr together):
 * the leaf `Authority=` line. Undefined for an ad-hoc signature, an unsigned bundle, or
 * output codesign could not produce (nothing installed, an unreadable bundle).
 */
export function signingAuthority(output: string): string | undefined {
  if (/^Signature=adhoc$/m.test(output)) return undefined;
  return output.match(/^Authority=(.+)$/m)?.[1]?.trim() || undefined;
}

export function requirementHasIdentifier(reqText: string, bundleId: string): boolean {
  const escaped = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`identifier "${escaped}"`).test(reqText);
}

export type RequirementCheck = { readonly ok: true; readonly adhoc: boolean } | { readonly ok: false; readonly reason: string };

/**
 * Judges `codesign -d -v -r-` output, stdout and stderr together. A real identity's
 * designated requirement must name `bundleId`: TCC keys the grants on it. An ad-hoc
 * signature has no identity to name. Its requirement is the code hash, which changes on
 * every build, so the grants reset; it is accepted when the signature's own Identifier
 * is `bundleId`. Ad-hoc is what build-mac.ts signs with on a Mac whose keychain lists no
 * code-signing identity, and refusing it left a fresh Mac with nothing installed. A
 * refusal quotes the `designated =>` line.
 */
export function checkRequirement(output: string, bundleId: string): RequirementCheck {
  const designated = output.match(/^#?[ \t]*(designated => .*)$/m)?.[1]?.trim();
  if (designated !== undefined && requirementHasIdentifier(designated, bundleId)) return { ok: true, adhoc: false };
  const adhoc = /^Signature=adhoc$/m.test(output);
  const identifier = output.match(/^Identifier=(.*)$/m)?.[1]?.trim();
  if (adhoc && identifier === bundleId && designated !== undefined && designated.startsWith('designated => cdhash H"')) return { ok: true, adhoc: true };
  const said = designated ?? (output.trim().split("\n")[0] || "codesign printed no requirement");
  return { ok: false, reason: `designated requirement lacks identifier "${bundleId}": ${said}${adhoc ? ` (ad-hoc, signed as ${identifier ?? "no identifier"})` : ""}` };
}

/** The summary line under `built`: what happened to the bundle directory and its files. */
export function installLine(i: { readonly plan: InstallPlan; readonly inodeAfter: number | undefined; readonly rsync: RsyncSummary | undefined; readonly installed?: string; readonly bundleId?: string; readonly adhoc?: boolean }): string {
  const installed = i.installed ?? "/Applications/Jarhead.app";
  const bundleId = i.bundleId ?? "com.kevinliu.jarhead";
  const where =
    i.plan.kind === "create"
      ? `${installed} created${i.inodeAfter !== undefined ? ` (inode ${i.inodeAfter})` : ""}`
      : i.plan.kind === "update"
        ? i.inodeAfter === i.plan.inode
          ? `${installed} kept (inode ${i.plan.inode})`
          : `${installed} REPLACED (inode ${i.plan.inode} → ${i.inodeAfter ?? "?"}) — report this`
        : `${installed} refused: ${i.plan.reason}`;
  // Unique entries: a parser fed the runner's doubled deletion lines must not count twice.
  const n = (xs: readonly string[]): number => new Set(xs).size;
  const files = i.rsync
    ? `${n(i.rsync.updated)} file${n(i.rsync.updated) === 1 ? "" : "s"} replaced, ${n(i.rsync.created)} added, ${n(i.rsync.deleted)} removed`
    : i.plan.kind === "create"
      ? "copied whole"
      : "no files written";
  const signature = i.adhoc ? `ad-hoc, identifier ${bundleId}` : `requirement identifier ${bundleId}`;
  return `install    ${where} · ${files} · strict ok · ${signature}`;
}

/** The line a failure prints: how to put the snapshot back by hand. */
export function rollbackLine(previous: string, installed: string): string {
  return `rollback:  ${DITTO} -x -k ${previous} /tmp/jarhead-rollback && ${RSYNC} -rlptD -c --delete-after /tmp/jarhead-rollback/Jarhead.app/ ${installed}/`;
}

export interface InstallSpec {
  /** The signed stage bundle (build/stage/Jarhead.app). */
  readonly stage: string;
  readonly installed: string;
  /**
   * Where the rollback snapshot goes (build/previous/Jarhead.app.zip — an archive, never a
   * directory; see snapshotNameOk). Absent: no snapshot is taken and no rollback line is
   * printed — the rollback is `git checkout <previous> && pnpm build:mac`.
   */
  readonly previous?: string;
  /** The checkout's symlink to the installed bundle (build/Jarhead.app). */
  readonly link: string;
  /** Removed once the installed copy verifies (build/stage); kept for inspection on a failure. */
  readonly cleanup?: string;
  readonly bundleId: string;
  readonly uid: number;
  /** The account's short name, for the not-writable line of a first install (the uid stands in when absent). */
  readonly user?: string;
  /**
   * How build-mac.ts signed the stage; absent means an identity. `adhoc`: the keychain listed
   * no code-signing identity. Over an installed copy an identity signed, that is refused before
   * anything is written: TCC keyed every grant on that identity, so all of them would reset,
   * and an identity that stopped being listed is usually an expired or removed certificate,
   * not a choice. `adhoc-pinned`: JARHEAD_SIGN_IDENTITY=- asked for ad-hoc, which installs over
   * anything. A first install has nothing to downgrade, so either ad-hoc installs.
   */
  readonly signing?: "identity" | "adhoc" | "adhoc-pinned";
}

/** Every side effect of the install, injectable: build-mac.ts passes the real ones, the tests a recorder. */
export interface InstallIO {
  readonly exec: (cmd: string, args: readonly string[]) => { readonly code: number; readonly stdout: string; readonly stderr: string };
  readonly probe: (path: string) => TargetProbe;
  readonly mkdirp: (path: string) => void;
  readonly rmTree: (path: string) => void;
  /** Replace whatever is at `link` (a link or a directory) with a symlink to `target`. */
  readonly relink: (target: string, link: string) => void;
  readonly compare: (stage: string, installed: string) => ParityReport;
  readonly warn: (line: string) => void;
}

export type InstallOutcome =
  | {
      readonly ok: true;
      readonly plan: Extract<InstallPlan, { kind: "create" | "update" }>;
      readonly inodeAfter: number | undefined;
      readonly rsync: RsyncSummary | undefined;
      /** Present when a snapshot was taken and the caller should print it. */
      readonly rollback: string | undefined;
      readonly line: string;
    }
  | { readonly ok: false; readonly what: string; readonly lines: readonly string[] };

/**
 * Step 5 of `pnpm build:mac`, in order: plan (refuse a symlink / file / other uid /
 * no write bit, a parent directory this account cannot write into, or a snapshot path
 * named `.app`, or an ad-hoc stage over a copy an identity signed, unless ad-hoc was pinned —
 * before anything is written) → first install `cp -R`, else snapshot to `previous` when one was asked for, then rsync in
 * place (never --inplace; `._*` in the itemized output means -E leaked and the build
 * fails) → verify the INSTALLED copy: strict + deep, the designated requirement's
 * identifier (or, ad-hoc, the signature's; see checkRequirement), a sha256 parity walk
 * against the stage, the directory inode unchanged →
 * remove the stage → relink. Any failure keeps the stage and names the rollback when a
 * snapshot was taken.
 */
export function performInstall(spec: InstallSpec, io: InstallIO): InstallOutcome {
  const target = io.probe(spec.installed);
  // Only a first install writes into the parent, so only then is it probed.
  const parent = target.exists ? undefined : io.probe(dirname(spec.installed));
  const plan = planInstall(target, spec.uid, spec.installed, parent, spec.user);
  if (plan.kind === "refuse") return { ok: false, what: `refusing to install: ${plan.reason}`, lines: [plan.hint] };
  if (spec.previous !== undefined && !snapshotNameOk(spec.previous)) {
    return { ok: false, what: `refusing to install: the snapshot path ${spec.previous} is not a .zip archive`, lines: ["LaunchServices registers any directory holding an Info.plist as a bundle — a second Jarhead; snapshot to a .zip archive (build/previous/Jarhead.app.zip)"] };
  }
  if (plan.kind === "update" && spec.signing === "adhoc") {
    const installedSig = io.exec(CODESIGN, [...CODESIGN_AUTHORITY_ARGS, spec.installed]);
    const authority = signingAuthority(`${installedSig.stdout}\n${installedSig.stderr}`);
    if (authority !== undefined) {
      return {
        ok: false,
        what: `refusing to install: this build is signed ad-hoc, and ${spec.installed} is signed by "${authority}"`,
        lines: [
          "Installing it would reset every permission grant. The keychain listed no code-signing identity, so that certificate has likely expired or been removed.",
          `See what the keychain has: security find-identity -v -p codesigning. Renew or recreate "${authority}" in Keychain Access, then run pnpm build:mac again.`,
          "Or install ad-hoc anyway and grant the permissions again: JARHEAD_SIGN_IDENTITY=- pnpm build:mac",
        ],
      };
    }
  }
  const rollback = spec.previous !== undefined ? rollbackLine(spec.previous, spec.installed) : undefined;
  let rollbackOk = false;
  const withRollback = (lines: string[]): string[] => (rollbackOk && rollback ? [...lines, rollback] : lines);
  const fail = (what: string, ...lines: string[]): InstallOutcome => ({ ok: false, what, lines: withRollback(lines.filter(Boolean)) });

  let rsync: RsyncSummary | undefined;
  if (plan.kind === "create") {
    // First install: nothing to keep, so a whole copy (the link and the Dock have no bookmark yet).
    const cp = io.exec("cp", ["-R", spec.stage, `${dirname(spec.installed)}/`]);
    if (cp.code !== 0) return fail(`cp -R exited ${cp.code}`, cp.stderr.trim());
  } else {
    if (spec.previous !== undefined) {
      io.mkdirp(dirname(spec.previous));
      const snap = io.exec(DITTO, snapshotArgs(spec.installed, spec.previous));
      rollbackOk = snap.code === 0;
      if (!rollbackOk) io.warn(`rollback snapshot failed (${snap.code}); continuing without one: ${snap.stderr.trim()}`);
    }
    const r = io.exec(RSYNC, rsyncArgs(spec.stage, spec.installed));
    if (r.code !== 0) return fail(`rsync exited ${r.code}`, r.stderr.trim());
    rsync = parseItemized(r.stdout);
    if (rsync.appleDouble.length) return fail(`xattr emulation leaked into the bundle (${rsync.appleDouble.join(", ")}); never pass -E`);
  }

  // The installed copy, not the stage: strict + deep (the helper is nested code), the
  // designated requirement TCC keys the grants on, byte parity with what was signed,
  // and the directory inode the Dock's bookmark points at.
  const verify = io.exec(CODESIGN, [...CODESIGN_VERIFY_ARGS, spec.installed]);
  if (verify.code !== 0) return fail(`the installed bundle does not verify: ${(verify.stderr || verify.stdout).trim()}`);
  const requirement = io.exec(CODESIGN, [...CODESIGN_REQUIREMENT_ARGS, spec.installed]);
  const signed = checkRequirement(`${requirement.stdout}\n${requirement.stderr}`, spec.bundleId);
  if (!signed.ok) return fail(`the ${signed.reason}`);
  const parity = io.compare(spec.stage, spec.installed);
  if (!parityOk(parity)) return fail("the installed tree is not the signed stage", `missing: ${parity.missing.join(", ") || "—"}`, `differing: ${parity.differing.join(", ") || "—"}`, `extra: ${parity.extra.join(", ") || "—"}`);
  const after = io.probe(spec.installed);
  if (plan.kind === "update" && after.inode !== plan.inode) io.warn(`the bundle directory was replaced (inode ${plan.inode} → ${after.inode}); the Dock tile may duplicate — report this`);

  if (spec.cleanup) io.rmTree(spec.cleanup);
  io.relink(spec.installed, spec.link);
  if (signed.adhoc) io.warn("ad-hoc: grants reset on every rebuild");
  const line = installLine({ plan, inodeAfter: after.inode, rsync, installed: spec.installed, bundleId: spec.bundleId, adhoc: signed.adhoc });
  return { ok: true, plan, inodeAfter: after.inode, rsync, rollback: rollbackOk ? rollback : undefined, line };
}
