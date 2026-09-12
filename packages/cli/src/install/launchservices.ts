/**
 * LaunchServices' Bundle table, parsed from `lsregister -dump Bundle` (the whole
 * `-dump` is many times slower). `open -a Jarhead` resolves by name through this
 * database, so a Jarhead.app in the Trash or a probe bundle in a discarded worktree
 * can be what launches. The repair is `lsregister -u <path>` — the database only;
 * the files, the Trash included, are never touched.
 */

import { realpathSync } from "node:fs";

export const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface LsRecord {
  readonly path: string;
  readonly identifier: string | undefined;
  readonly executable: string | undefined;
}

/** Records are separated by a line of dashes; fields are `name:` padded to a column. */
export function parseLsBundleDump(text: string): LsRecord[] {
  const records: LsRecord[] = [];
  for (const block of text.split(/^-{40,}\s*$/m)) {
    const path = block.match(/^path:\s+(.*?)(?:\s+\(0x[0-9a-fA-F]+\))?\s*$/m)?.[1];
    if (!path) continue;
    records.push({
      path,
      identifier: block.match(/^identifier:\s+(\S+)/m)?.[1],
      executable: block.match(/^executable:\s+(\S+)/m)?.[1],
    });
  }
  return records;
}

export interface StaleRule {
  /** The one launchable bundle: never stale. */
  readonly installed: string;
  readonly bundleId: string;
  /** Roots whose bundles are leftovers: the Trash, self-edit worktrees, the build's stage and previous. */
  readonly staleRoots: readonly string[];
  readonly exists: (path: string) => boolean;
  /** Resolves symlinks (the raw path back when it does not exist); injectable so the tests need no filesystem. */
  readonly realpath?: (path: string) => string;
}

/** realpathSync.native, or the path itself when nothing is there to resolve. */
export function defaultRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function under(path: string, root: string): boolean {
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * Stale: (a) Jarhead's own id at any path but the installed one; (b) a sub-id
 * (`com.kevinliu.jarhead.ear-probe`) under a stale root or at a path that is gone;
 * (c) any other bundle named Jarhead.app under a stale root or gone — the retired
 * Electron shell in the Trash has a different id but the same name, and `open -a
 * Jarhead` can pick it. A live checkout's own probe bundle is not stale. Paths are
 * compared resolved: a record at build/Jarhead.app (a symlink to the installed bundle)
 * IS the installed bundle, and `lsregister -u` on it could unregister the real one.
 */
export function staleJarheadRecords(records: readonly LsRecord[], rule: StaleRule): LsRecord[] {
  const real = rule.realpath ?? defaultRealpath;
  const installedReal = real(rule.installed);
  const gone = (r: LsRecord): boolean => rule.staleRoots.some((root) => under(r.path, root)) || !rule.exists(r.path);
  return records.filter((r) => {
    if (r.path === rule.installed || real(r.path) === installedReal) return false;
    if (r.identifier === rule.bundleId) return true;
    if (r.identifier?.startsWith(`${rule.bundleId}.`)) return gone(r);
    if (basenameOf(r.path).toLowerCase() === "jarhead.app") return gone(r);
    return false;
  });
}

/** The records carrying exactly Jarhead's id (the ones `open -b` chooses between). */
export function jarheadRecords(records: readonly LsRecord[], bundleId: string): LsRecord[] {
  return records.filter((r) => r.identifier === bundleId);
}

/** One clause: "1 record" or "3 records — also /Users/…/.Trash/Jarhead.app, …". */
export function describeLaunchServices(all: readonly LsRecord[], stale: readonly LsRecord[], unregistered: readonly string[], installed: string): string {
  const own = all.filter((r) => r.path === installed).length;
  const registered = own ? "registered" : "NOT registered";
  const others = stale.filter((r) => !unregistered.includes(r.path));
  const parts = [`LaunchServices: ${installed} ${registered}`];
  if (unregistered.length) parts.push(`${unregistered.length} stale record${unregistered.length === 1 ? "" : "s"} unregistered`);
  if (others.length) parts.push(`also ${others.map((r) => r.path).join(", ")}`);
  return parts.join(" · ");
}
