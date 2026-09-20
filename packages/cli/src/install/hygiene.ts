import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "@jarhead/core";
import { HFS_EPOCH_OFFSET, DOCK_DOMAIN, INSTALLED_APP, INSTALLED_URL, JARHEAD_BUNDLE_ID, auditDock, describeDock, describeDockChanges, helperTilesOf, modCountOf, parseLsAppInfoList, type DockAudit, type RunningApp, type DockModDates } from "./dock.ts";
import { LSREGISTER, describeLaunchServices, parseLsBundleDump, staleJarheadRecords, type LsRecord, type StaleRule } from "./launchservices.ts";
import { parsePlistXml, serializePlistXml } from "./plist.ts";

/**
 * The one-Jarhead pass over LaunchServices and the Dock. Every command goes through
 * one injectable `exec`, so the whole thing runs in CI without a Dock. Three modes:
 *
 *   audit    read-only: dump the Bundle table, export the Dock, report (doctor, `jarhead dock`)
 *   install  audit + `lsregister -f` on the installed bundle + unregister stale Jarhead
 *            records (the database only; no file, Trash included, is touched) — what
 *            `pnpm build:mac` does by default
 *   fix      install + the Dock repair: `defaults export` → drop Jarhead's recent tiles,
 *            keep one pin stripped to the keys the Dock rebuilds its bookmark from →
 *            `defaults import` behind a mod-count race check → `killall Dock` only when
 *            something was written — `pnpm jarhead dock --fix`, JARHEAD_INSTALL_HYGIENE=fix
 *
 * Every mode also reads `lsappinfo list` once (`readRunning`, beside the Dock export,
 * ~50 ms, no lsd wait): a helper from the bundle that LaunchServices counts as a
 * Foreground "Jarhead" is a tile the plist repair cannot remove, so the line names it
 * (`running.helperTiles`) and never claims the Dock is repaired while one lives.
 *
 * The Dock half stands alone as `readDock` (one export) and `repairDock` (the rounds,
 * the import, `killall Dock`): the engine's startup audit and its Fix the Dock remedy
 * call those two and never lsregister, which waits on lsd for up to two minutes.
 */

export type HygieneMode = "audit" | "install" | "fix";

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (cmd: string, args: readonly string[], opts?: { readonly input?: string; readonly timeoutMs?: number }) => ExecResult;

/** `lsregister -dump Bundle` is ~12 MB on Kevin's Mac; execFileSync's default 1 MiB buffer turns that into ENOBUFS. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Every lsregister call waits on lsd. The Bundle dump is ~2 s on an idle Mac and
 * 66–85 s at load average 300 (a self-edit build under a running test suite); a 20 s
 * cap made the whole LaunchServices half silently do nothing exactly when a build
 * was slow. build-mac allows rsync the same 120 s.
 */
export const LSREGISTER_TIMEOUT_MS = 120_000;

/**
 * spawnSync, argv only (never a shell), both streams captured whatever the exit code —
 * `codesign -d -r-` and `-dvv` print their answers on stderr with exit 0 — and a
 * non-zero exit (or a spawn failure) as a result rather than a throw.
 */
export const defaultExec: Exec = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: opts.timeoutMs ?? 20_000, maxBuffer: MAX_OUTPUT_BYTES, ...(opts.input !== undefined ? { input: opts.input } : {}) });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (r.error) return { code: 1, stdout, stderr: stderr || r.error.message };
  return { code: r.status ?? 1, stdout, stderr };
};

export interface HygieneOptions {
  readonly mode: HygieneMode;
  readonly installed?: string;
  readonly bundleId?: string;
  readonly staleRoots?: readonly string[];
  readonly exists?: (path: string) => boolean;
  /** Resolves a record's path before the stale rule sees it (a symlink to the installed bundle is the installed bundle). */
  readonly realpath?: StaleRule["realpath"];
  readonly exec?: Exec;
  readonly log?: (line: string) => void;
  /** Dock export/compare rounds before giving up on a Dock that keeps rewriting itself (3). */
  readonly maxDockRounds?: number;
  /** Cap for every lsregister call; the Bundle dump is the slow one (LSREGISTER_TIMEOUT_MS). */
  readonly lsTimeoutMs?: number;
  /**
   * Dump the table again after the `-u` loop to prove the records went. Default: only
   * in `fix` mode — a build should not pay a second dump; `unregistered` from the -u
   * exit codes is what the line reports then.
   */
  readonly verifyUnregister?: boolean;
}

export interface HygieneReport {
  readonly mode: HygieneMode;
  readonly launchServices: {
    readonly refreshed: boolean;
    readonly records: readonly LsRecord[];
    readonly stale: readonly LsRecord[];
    readonly unregistered: readonly string[];
    readonly remaining: readonly LsRecord[];
    readonly skipped?: string;
  };
  readonly dock: {
    readonly before: DockAudit | undefined;
    readonly after: DockAudit | undefined;
    readonly imported: boolean;
    readonly restarted: boolean;
    readonly rounds: number;
    readonly skipped?: string;
  };
  /** What `lsappinfo list` said: the Foreground Jarhead processes that are not the app (each a tile), or why it was not read. */
  readonly running: {
    readonly helperTiles: readonly RunningApp[];
    readonly skipped?: string;
  };
  readonly line: string;
}

/** Where leftover Jarhead bundles come from: the Trash, self-edit worktrees, the build's own stage and rollback dirs. */
export function defaultStaleRoots(stateDir = join(homedir(), ".jarhead")): string[] {
  return [join(stateDir, "worktrees"), join(stateDir, "trash"), join(homedir(), ".Trash"), join(REPO_ROOT, "build", "stage"), join(REPO_ROOT, "build", "previous")];
}

export function runHygiene(opts: HygieneOptions): HygieneReport {
  const exec = opts.exec ?? defaultExec;
  const installed = opts.installed ?? INSTALLED_APP;
  const bundleId = opts.bundleId ?? JARHEAD_BUNDLE_ID;
  const installedUrl = installedUrlOf(installed);
  const log = opts.log ?? ((): void => undefined);
  const mutateLs = opts.mode !== "audit";
  const mutateDock = opts.mode === "fix";
  const lsOpts = { timeoutMs: opts.lsTimeoutMs ?? LSREGISTER_TIMEOUT_MS };
  const verifyUnregister = opts.verifyUnregister ?? opts.mode === "fix";

  // ---- LaunchServices
  let refreshed = false;
  if (mutateLs) {
    const r = exec(LSREGISTER, ["-f", installed], lsOpts);
    refreshed = r.code === 0;
    if (!refreshed) log(`[one-jarhead] lsregister -f failed (${r.code}): ${r.stderr.trim()}`);
  }
  const dump = (): { records: LsRecord[] } | { skipped: string } => {
    const r = exec(LSREGISTER, ["-dump", "Bundle"], lsOpts);
    // The reason travels: a timeout (spawnSync … ETIMEDOUT) reads differently from a real failure.
    if (r.code !== 0) return { skipped: `lsregister -dump Bundle failed (${r.code})${r.stderr.trim() ? `: ${firstLine(r.stderr)}` : ""}` };
    return { records: parseLsBundleDump(r.stdout) };
  };
  const first = dump();
  let ls: HygieneReport["launchServices"];
  if ("skipped" in first) {
    log(`[one-jarhead] ${first.skipped}`);
    ls = { refreshed, records: [], stale: [], unregistered: [], remaining: [], skipped: first.skipped };
  } else {
    const rule: StaleRule = { installed, bundleId, staleRoots: opts.staleRoots ?? defaultStaleRoots(), exists: opts.exists ?? existsSync, ...(opts.realpath ? { realpath: opts.realpath } : {}) };
    const stale = staleJarheadRecords(first.records, rule);
    const unregistered: string[] = [];
    let remaining: LsRecord[] = stale;
    if (mutateLs && stale.length) {
      for (const rec of stale) {
        const r = exec(LSREGISTER, ["-u", rec.path], lsOpts);
        if (r.code === 0) unregistered.push(rec.path);
        else log(`[one-jarhead] lsregister -u ${rec.path} failed (${r.code}): ${r.stderr.trim()}`);
      }
      remaining = stale.filter((r) => !unregistered.includes(r.path));
      if (verifyUnregister) {
        // The re-dump is the proof: a -u that exited 0 and left its row (the Trash copy has) is said so.
        const second = dump();
        if ("skipped" in second) log(`[one-jarhead] ${second.skipped} — trusting the -u exit codes`);
        else {
          remaining = staleJarheadRecords(second.records, rule);
          for (const rec of remaining) if (unregistered.includes(rec.path)) log(`[one-jarhead] lsregister -u ${rec.path} exited 0 but the record is still in the Bundle table`);
        }
      }
    }
    ls = { refreshed, records: first.records, stale, unregistered, remaining };
  }

  // ---- Running processes: the helper tiles no plist repair can remove
  const ran = readRunning(exec, { bundleId, installed });
  const running: HygieneReport["running"] = "skipped" in ran ? { helperTiles: [], skipped: ran.skipped } : { helperTiles: ran.helperTiles };
  if (running.skipped) log(`[one-jarhead] ${running.skipped}`);
  const withHelpers = (a: DockAudit): DockAudit => (running.helperTiles.length ? { ...a, helperTiles: running.helperTiles } : a);

  // ---- Dock (readDock / repairDock below: the engine's Fix-the-Dock runs the same two, without lsregister)
  const dockOpts = { bundleId, installedUrl, log, ...(opts.maxDockRounds !== undefined ? { maxRounds: opts.maxDockRounds } : {}) };
  let dock: HygieneReport["dock"];
  const read = readDock(exec, dockOpts);
  if ("skipped" in read) {
    dock = { before: undefined, after: undefined, imported: false, restarted: false, rounds: 0, skipped: read.skipped };
  } else if (!mutateDock || read.changes.length === 0) {
    const before = withHelpers(read);
    dock = { before, after: before, imported: false, restarted: false, rounds: 0 };
  } else {
    // The repair removes the leftover entry either way; the helper's tile outlives it, so the report keeps naming it.
    const r = repairDock(exec, read, dockOpts);
    dock = { ...r, before: withHelpers(read), after: r.after ? withHelpers(r.after) : undefined };
  }

  const partial = { mode: opts.mode, launchServices: ls, dock, running, line: "" };
  const line = hygieneLine({ ...partial, installed, bundleId });
  const report: HygieneReport = { ...partial, line };
  log(line);
  return report;
}

/** The `_CFURLString` the Dock writes for a bundle path. */
export function installedUrlOf(installed: string): string {
  return installed === INSTALLED_APP ? INSTALLED_URL : `file://${installed}/`;
}

export interface DockOnlyOptions {
  readonly bundleId?: string;
  readonly installedUrl?: string;
  readonly log?: (line: string) => void;
  /** Export/compare rounds before giving up on a Dock that keeps rewriting itself (3). */
  readonly maxRounds?: number;
  /**
   * Cap for each `defaults` / `killall` call. Unset, defaultExec's 20 s (the CLI, at a
   * terminal); the engine passes DOCK_EXEC_TIMEOUT_MS so a hung cfprefsd cannot hold the
   * daemon's event loop — a timed-out export reads as `skipped`.
   */
  readonly timeoutMs?: number;
}

/** The exec options a Dock call carries: the cap when one was given, nothing otherwise (so the CLI's argv trace is unchanged). */
const timeoutOf = (opts: DockOnlyOptions): { readonly timeoutMs?: number } => (opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});

export const LSAPPINFO = "lsappinfo";

/**
 * READ what LaunchServices has checked in: `lsappinfo list` (one command, ~50 ms, no
 * lsd wait, no write) → the Foreground Jarhead processes that are not the app itself.
 * Each is a Dock tile while it lives and a `recent-apps` leftover once it exits. An
 * exec that throws (a scripted one) reads as skipped, like a failed command.
 */
export function readRunning(exec: Exec, opts: { readonly bundleId?: string; readonly installed?: string; readonly timeoutMs?: number } = {}): { helperTiles: RunningApp[] } | { skipped: string } {
  let r: ExecResult;
  try {
    r = exec(LSAPPINFO, ["list"], opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
  } catch (e) {
    return { skipped: `lsappinfo list threw: ${(e as Error).message}` };
  }
  if (r.code !== 0) return { skipped: `lsappinfo list failed (${r.code})${r.stderr.trim() ? `: ${firstLine(r.stderr)}` : ""}` };
  return { helperTiles: helperTilesOf(parseLsAppInfoList(r.stdout), { ...(opts.bundleId !== undefined ? { bundleId: opts.bundleId } : {}), ...(opts.installed !== undefined ? { installed: opts.installed } : {}) }) };
}

/**
 * READ the Dock: `defaults export com.apple.dock -` (through cfprefsd) → the audit.
 * One command, ~100 ms, no lsregister (which waits on lsd for up to two minutes), no
 * write. The engine runs this 20 s after start and after every Fix-the-Dock.
 */
export function readDock(exec: Exec, opts: DockOnlyOptions = {}): DockAudit | { skipped: string } {
  const bundleId = opts.bundleId ?? JARHEAD_BUNDLE_ID;
  const installedUrl = opts.installedUrl ?? INSTALLED_URL;
  const r = exec("defaults", ["export", DOCK_DOMAIN, "-"], timeoutOf(opts));
  if (r.code !== 0) return { skipped: `defaults export failed (${r.code})` };
  try {
    const doc = parsePlistXml(r.stdout);
    if (doc.kind !== "dict" || !doc.entries.some(([k]) => k === "persistent-apps")) return { skipped: "no persistent-apps in the Dock domain" };
    const modDates = bundleModDates(urlPathOf(installedUrl));
    return auditDock(doc, { bundleId, installedUrl, ...(modDates ? { modDates } : {}) });
  } catch (e) {
    return { skipped: `Dock plist unreadable: ${(e as Error).message}` };
  }
}

/**
 * `killall Dock`: the Dock relaunches from cfprefsd's document — the import. True when
 * it went; a failure is logged with its reason. The one step that shows on screen, so
 * only `repairDock` (after an import) and the engine's Fix-the-Dock press (when the
 * last press imported but this failed) call it.
 */
export function restartDock(exec: Exec, opts: DockOnlyOptions = {}): boolean {
  const k = exec("killall", ["Dock"], timeoutOf(opts));
  if (k.code !== 0) (opts.log ?? ((): void => undefined))(`[one-jarhead] killall Dock failed (${k.code}): ${k.stderr.trim()}`);
  return k.code === 0;
}

/**
 * The Dock repair, given an audit with changes: re-export and compare `mod-count` (the
 * Dock rewrites its domain on its own events — a launch adds a recent tile — so only a
 * document whose mod-count we audited is imported), `defaults import com.apple.dock -`,
 * `killall Dock` only when something was written, then one export for the report.
 * Exactly what `pnpm jarhead dock --fix` does; the engine's `problem.retry {kind:"dock"}`
 * runs it when Kevin presses Fix the Dock — never on its own.
 */
export function repairDock(exec: Exec, before: DockAudit, opts: DockOnlyOptions = {}): HygieneReport["dock"] {
  const maxRounds = opts.maxRounds ?? 3;
  const again = (): DockAudit | { skipped: string } => readDock(exec, opts);
  let current = before;
  let imported = false;
  let restarted = false;
  let rounds = 0;
  let skipped: string | undefined;
  for (;;) {
    rounds++;
    const fresh = again();
    if ("skipped" in fresh) {
      skipped = fresh.skipped;
      break;
    }
    if (fresh.modCount === current.modCount) {
      const r = exec("defaults", ["import", DOCK_DOMAIN, "-"], { input: serializePlistXml(current.doc), ...timeoutOf(opts) });
      if (r.code !== 0) {
        skipped = `defaults import failed (${r.code}): ${r.stderr.trim()}`;
        break;
      }
      imported = true;
      restarted = restartDock(exec, opts);
      break;
    }
    current = fresh;
    if (current.changes.length === 0) break;
    if (rounds >= maxRounds) {
      skipped = "the Dock kept changing; rerun pnpm jarhead dock --fix";
      break;
    }
  }
  const after = imported ? again() : current;
  return { before, after: "skipped" in after ? undefined : after, imported, restarted, rounds, ...(skipped ? { skipped } : {}) };
}

/** The `one jarhead` line under `install`: what LaunchServices holds and what the Dock shows. */
export function hygieneLine(r: Omit<HygieneReport, "line"> & { readonly installed?: string; readonly bundleId?: string }): string {
  const installed = r.installed ?? INSTALLED_APP;
  // Only a record the re-dump no longer holds counts as unregistered on the line; one that -u'd "fine" but stayed is still "also …".
  const gone = r.launchServices.unregistered.filter((path) => !r.launchServices.remaining.some((x) => x.path === path));
  const ls = r.launchServices.skipped ? `LaunchServices: skipped (${r.launchServices.skipped})` : describeLaunchServices(r.launchServices.records, r.launchServices.remaining, gone, installed);
  // A live helper tile is the one thing the repair cannot remove: the line never says --fix repairs it, nor that a fix did.
  const helper = r.running.helperTiles.length > 0;
  let dock: string;
  if (r.dock.skipped && !r.dock.imported) dock = `${describeDock(r.dock.before)} — ${r.dock.skipped}`;
  else if (r.dock.imported) {
    const did = describeDockChanges(r.dock.before?.changes ?? []);
    const restart = r.dock.restarted ? ", Dock restarted" : ", Dock not restarted";
    dock = `${describeDock(r.dock.after)} (${did}${restart}${helper ? " — not repaired: the helper's tile returns while it lives" : ""})`;
  } else if (r.dock.before && r.dock.before.changes.length > 0) {
    dock = helper ? describeDock(r.dock.before) : `${describeDock(r.dock.before)} (pnpm jarhead dock --fix repairs it)`;
  } else dock = `${describeDock(r.dock.before)} (untouched)`;
  const ran = r.running.skipped ? ` · running: skipped (${r.running.skipped})` : "";
  return `one jarhead  ${ls} · ${dock}${ran}`;
}

/** The lsregister argv for a fresh registration of the installed bundle, pinned for the tests. */
export function lsregisterRefreshArgs(installed = INSTALLED_APP): string[] {
  return ["-f", installed];
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export { modCountOf };

/** The installed bundle's and its folder's mtimes as the Dock stores them (HFS seconds); undefined when the bundle is not on disk. */
export function bundleModDates(bundlePath: string | undefined): DockModDates | undefined {
  if (!bundlePath) return undefined;
  try {
    const file = Math.floor(statSync(bundlePath).mtimeMs / 1000) + HFS_EPOCH_OFFSET;
    const parent = Math.floor(statSync(dirname(bundlePath)).mtimeMs / 1000) + HFS_EPOCH_OFFSET;
    return { file, parent };
  } catch {
    return undefined;
  }
}

/** The path a `file:///…/` URL names, without its trailing slash; undefined for anything else. */
function urlPathOf(url: string): string | undefined {
  if (!url.startsWith("file://")) return undefined;
  return decodeURIComponent(url.slice("file://".length)).replace(/\/$/, "");
}
