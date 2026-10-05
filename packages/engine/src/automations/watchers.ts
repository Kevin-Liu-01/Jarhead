import { readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { expandPath, logger, type ActionContext, type Decision } from "@jarhead/core";
import { AUTOMATION_POLL_MIN_S, recipeNamed, type AgentInfo, type Automation, type Settings, type SystemEvent, type SystemSignal } from "@jarhead/protocol";
import type { AutomationExec, ShellRunner } from "./executor.ts";

/**
 * The watchers — polling from `tick()`, the house pattern. A folder is listed every
 * FOLDER_POLL_MS, once however many rows watch it, against a baseline of names: a name the
 * baseline does not hold is statted and fires once its size and mtime hold for `settleMs`;
 * a name it holds (there at arm, or already fired) is never a landing, whatever happens to
 * its contents — Preview saving an annotation is not a download. Browser partials,
 * .DS_Store and names the glob passes over never count and are never statted. A folder of
 * LIST_ASYNC_AT entries or more is listed off the event loop. An app quitting or launching
 * arrives as the app's `system.signal`; while no app client forwards them, the process list
 * (`ps -axo pid,comm` through the exec seam) every APP_POLL_MS is the fallback edge — a
 * window leaving the screen is not a quit. `recipe.red` runs its recipe every
 * `everySeconds` through the shell gate and fires on the flip to non-zero and once on the
 * flip back. `agent.status` reads the registry the engine already refreshes. Nothing here acts.
 */

const log = logger("engine.automations.watchers");

export const FOLDER_POLL_MS = 5_000;
export const APP_POLL_MS = 10_000;
export const SETTLE_DEFAULT_MS = 3_000;
/** A recipe.red run is cut here whatever its recipe says. */
export const RECIPE_RED_CAP_MS = 20_000;
/** A folder that held this many entries at its last listing is listed with fs.promises.readdir; a smaller one inline, as of its tick. */
export const LIST_ASYNC_AT = 2_000;
/** The process list's own time limit. */
const PS_TIMEOUT_MS = 5_000;
/** Browser partials and the Finder's own file never count as a landing. */
const IGNORED = /(\.crdownload|\.download|\.part|\.tmp|\.partial)$|^\.DS_Store$|^\.localized$|^~\$/i;

export interface WatcherFire {
  readonly id: string;
  /** The file that landed, absolute (folder.file / download.done). */
  readonly file?: string | undefined;
  /** What the watcher saw ("recipe tests red · exit 1"). */
  readonly what?: string | undefined;
}

interface Entry {
  readonly size: number;
  readonly mtime: number;
}

interface FolderState {
  readonly path: string;
  readonly glob: RegExp | undefined;
  readonly settleMs: number;
  /** The names that are never a landing: what the folder held at arm (or at the last resync), and every name that already fired. */
  baseline: Set<string>;
  /** False until the folder could be read once: then its listing is the baseline, never a burst of landings. */
  ready: boolean;
  readonly pending: Map<string, Entry & { readonly since: number }>;
  /** Files that landed while the daemon was down or the folder unreadable: counted, never replayed. */
  unhandled: number;
  /** Bumped at every baseline: a listing begun before it is stale and is dropped. */
  gen: number;
}

interface RecipeState {
  lastExit: number | null | undefined;
  lastRunAt: number;
  running: boolean;
}

export interface WatchersOptions {
  readonly now: () => number;
  /** The process list for the app fallback (its `output`); without one there is no fallback poll. */
  readonly exec?: AutomationExec | undefined;
  readonly shell: ShellRunner;
  readonly shellGate: (ctx: ActionContext) => Decision;
  readonly settings: () => Settings;
  readonly home: string;
  readonly repoRoot?: string | undefined;
}

export interface PollOptions {
  /** An app client forwards app.launch and app.quit itself: no process list, and the next fallback starts from a fresh baseline. */
  readonly appSignals?: boolean | undefined;
}

/** `*.pdf` → a case-insensitive matcher on the file name; `*` any run, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** The folder a trigger watches, absolute. */
export function folderOf(on: SystemEvent, home: string): string | undefined {
  if (on.kind === "folder.file") return expandPath(on.path, home);
  if (on.kind === "download.done") return join(home, "Downloads");
  return undefined;
}

/**
 * The apps a `ps -axo pid,comm` listing shows running. Each `<Name>.app/Contents/MacOS/<exec>` path
 * gives its bundle's name and its executable's name, so "Visual Studio Code" and "Code" both read as
 * running; a helper inside an app is its own name ("Slack Helper (Renderer)") and keeps no "Slack" alive.
 */
export function runningApps(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = /\/([^/]+)\.app\/Contents\/MacOS\/([^/]+)$/.exec(line.trim());
    if (!m) continue;
    out.add(m[1] ?? "");
    out.add(m[2] ?? "");
  }
  out.delete("");
  return out;
}

export class Watchers {
  private readonly folders = new Map<string, FolderState>();
  private readonly recipes = new Map<string, RecipeState>();
  /** Entries per folder at its last listing: a big one is listed off the loop next time. */
  private readonly sizes = new Map<string, number>();
  private lastFolderPollAt = 0;
  /** A listing off the loop is out: the next folder poll waits for it. */
  private folderPolling = false;
  private lastAppPollAt = 0;
  /** The apps the last process list showed running; undefined before the fallback's first listing. */
  private knownApps: Set<string> | undefined;
  private readonly agentStatus = new Map<string, string>();
  private agentsSeen = false;

  constructor(private readonly opts: WatchersOptions) {}

  /** How many folders are watched (tests). */
  get folderCount(): number {
    return this.folders.size;
  }

  /**
   * Start watching for a row. A folder is read NOW — while Kevin is at the Mac, so the
   * per-folder TCC prompt shows at set-up, never at 3 a.m. Returns the read error when
   * the folder cannot be listed (EPERM, ENOENT); the caller raises the problem, and the
   * first listing that works becomes the baseline. `asOf` (a restart) is the daemon's last
   * heartbeat: files newer than it stay out of the baseline for the resync to count.
   */
  watch(a: Automation, asOf?: number): string | undefined {
    if (a.when.kind !== "on") return undefined;
    const on = a.when.on;
    const folder = folderOf(on, this.opts.home);
    if (folder !== undefined) {
      const glob = on.kind === "folder.file" || on.kind === "download.done" ? on.glob : undefined;
      const settleMs = on.kind === "folder.file" && on.settleMs !== undefined ? Math.max(500, on.settleMs) : SETTLE_DEFAULT_MS;
      const state: FolderState = { path: folder, glob: glob ? globToRegExp(glob) : undefined, settleMs, baseline: new Set(), ready: false, pending: new Map(), unhandled: 0, gen: 0 };
      // At a restart the baseline is the listing AS OF the last heartbeat: what landed since is left out, so the resync that
      // follows counts it ("not watching … · N new files not handled") instead of the fresh listing hiding it. Never replayed.
      const err = this.baseline(state, asOf);
      this.folders.set(a.id, state);
      return err;
    }
    if (on.kind === "recipe.red") this.recipes.set(a.id, { lastExit: undefined, lastRunAt: 0, running: false });
    return undefined;
  }

  unwatch(id: string): void {
    this.folders.delete(id);
    this.recipes.delete(id);
  }

  /** A landed file left its folder (filed away): its name leaves the folder's baselines, so a new file under that name is a new landing. */
  forget(file: string): void {
    const dir = resolve(dirname(file));
    const name = basename(file);
    for (const f of this.folders.values()) if (resolve(f.path) === dir) f.baseline.delete(name);
  }

  /** After a gap (the Mac slept, the daemon was down): every folder's listing is the new baseline; what landed meanwhile is counted, not replayed. */
  rebaseline(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, f] of this.folders) {
      const before = f.baseline;
      const wasReady = f.ready;
      if (this.baseline(f) || !wasReady) continue;
      let landed = 0;
      for (const name of f.baseline) if (!before.has(name) && this.landable(f, name)) landed++;
      f.unhandled += landed;
      if (landed > 0) out.set(id, landed);
    }
    return out;
  }

  /** A name that could be a landing in this folder: not a partial or the Finder's own, and the glob's. */
  private landable(f: FolderState, name: string): boolean {
    return !IGNORED.test(name) && (!f.glob || f.glob.test(name));
  }

  private baseline(f: FolderState, asOf?: number): string | undefined {
    let names: string[];
    try {
      names = readdirSync(f.path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "EPERM" || code === "EACCES" ? `${f.path} cannot be read (macOS asks for the folder)` : `${f.path}: ${(e as Error).message}`;
    }
    this.sizes.set(f.path, names.length);
    const base = new Set<string>();
    for (const name of names) {
      if (asOf !== undefined && this.landable(f, name)) {
        const e = this.entry(join(f.path, name));
        if (e && e.mtime > asOf) continue;
      }
      base.add(name);
    }
    f.baseline = base;
    f.ready = true;
    f.pending.clear();
    f.gen++;
    return undefined;
  }

  /** A file's size and mtime; null for a name that is not a file (a folder); undefined when it is gone. */
  private entry(path: string): Entry | null | undefined {
    try {
      const s = statSync(path);
      return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
    } catch {
      return undefined;
    }
  }

  /**
   * The polls, due by their own clocks: folders every FOLDER_POLL_MS, the app fallback
   * every APP_POLL_MS (only while a row listens for an app and no app client forwards the
   * signals), each recipe.red at its own `everySeconds`. `rows` are the watchers to poll.
   */
  async poll(now: number, rows: readonly Automation[], o: PollOptions = {}): Promise<WatcherFire[]> {
    const fires: WatcherFire[] = [];
    if (now - this.lastFolderPollAt >= FOLDER_POLL_MS && !this.folderPolling) {
      this.lastFolderPollAt = now;
      fires.push(...(await this.pollFolders(now, rows)));
    }
    const appRows = rows.filter((a) => a.when.kind === "on" && (a.when.on.kind === "app.quit" || a.when.on.kind === "app.launch"));
    if (o.appSignals || appRows.length === 0) {
      // The app's own signals are the edge (or nobody listens): the fallback's listing lapses, and its next one is a fresh baseline.
      this.knownApps = undefined;
    } else if (now - this.lastAppPollAt >= APP_POLL_MS) {
      this.lastAppPollAt = now;
      for (const sig of await this.pollApps()) fires.push(...this.signal(sig, appRows));
    }
    for (const a of rows) {
      if (a.when.kind !== "on" || a.when.on.kind !== "recipe.red") continue;
      const r = this.recipes.get(a.id) ?? this.recipes.set(a.id, { lastExit: undefined, lastRunAt: 0, running: false }).get(a.id)!;
      const every = Math.max(AUTOMATION_POLL_MIN_S, a.when.on.everySeconds) * 1000;
      if (r.running || now - r.lastRunAt < every) continue;
      r.lastRunAt = now;
      const fire = await this.pollRecipe(a, a.when.on.recipe, r);
      if (fire) fires.push({ id: a.id, what: fire });
    }
    return fires;
  }

  /** Every watched folder once: one listing per folder, one stat per new name, the big folders' listings awaited off the loop. */
  private async pollFolders(now: number, rows: readonly Automation[]): Promise<WatcherFire[]> {
    const fires: WatcherFire[] = [];
    const watched: (readonly [Automation, FolderState])[] = [];
    for (const a of rows) {
      const f = this.folders.get(a.id);
      if (f) watched.push([a, f]);
    }
    const listings = new Map<string, string[] | Promise<string[] | undefined> | undefined>();
    for (const [, f] of watched) if (!listings.has(f.path)) listings.set(f.path, this.list(f.path));
    const stats = new Map<string, Entry | null | undefined>();
    const statOf = (path: string): Entry | null | undefined => {
      if (!stats.has(path)) stats.set(path, this.entry(path));
      return stats.get(path);
    };
    const take = (a: Automation, f: FolderState, names: readonly string[] | undefined): void => {
      if (names) for (const file of this.pollFolder(f, names, now, statOf)) fires.push({ id: a.id, file, what: `landed ${file.slice(file.lastIndexOf("/") + 1)}` });
    };
    const later: (readonly [Automation, FolderState, number])[] = [];
    for (const [a, f] of watched) {
      const l = listings.get(f.path);
      if (l instanceof Promise) later.push([a, f, f.gen]);
      else take(a, f, l);
    }
    if (later.length === 0) return fires;
    this.folderPolling = true;
    try {
      for (const [a, f, gen] of later) {
        const names = await listings.get(f.path);
        // A resync read the folder again while this listing was out: its baseline is newer than what came back.
        if (f.gen === gen) take(a, f, names);
      }
    } finally {
      this.folderPolling = false;
    }
    return fires;
  }

  /** One folder's names: inline below LIST_ASYNC_AT entries, off the loop at or above it; undefined when it cannot be read. */
  private list(path: string): string[] | Promise<string[] | undefined> | undefined {
    if ((this.sizes.get(path) ?? 0) >= LIST_ASYNC_AT) {
      return readdir(path).then(
        (names) => {
          this.sizes.set(path, names.length);
          return names;
        },
        (e: unknown) => {
          log.debug(`folder ${path}: ${(e as Error).message}`);
          return undefined;
        },
      );
    }
    try {
      const names = readdirSync(path);
      this.sizes.set(path, names.length);
      return names;
    } catch (e) {
      log.debug(`folder ${path}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * One folder's poll over its listing: a name the baseline does not hold is statted; it fires
   * once its size and mtime held for `settleMs`, and joins the baseline. A name the baseline
   * holds is never a landing. Gone names leave the maps (and `forget` drops a name the fire
   * filed away), so a file that replaces one under the same name is a new landing.
   */
  private pollFolder(f: FolderState, names: readonly string[], now: number, statOf: (path: string) => Entry | null | undefined): string[] {
    if (!f.ready) {
      // The folder could not be read at arm: what it holds now is what was there, never a burst of landings.
      f.baseline = new Set(names);
      f.ready = true;
      return [];
    }
    const seen = new Set(names);
    for (const name of f.baseline) if (!seen.has(name)) f.baseline.delete(name);
    for (const name of f.pending.keys()) if (!seen.has(name)) f.pending.delete(name);
    const fired: string[] = [];
    for (const name of names) {
      if (f.baseline.has(name)) continue;
      // A partial, the Finder's own file, a name the glob passes over: never a landing, never statted again.
      if (!this.landable(f, name)) {
        f.baseline.add(name);
        continue;
      }
      const e = statOf(join(f.path, name));
      if (e === null) {
        f.baseline.add(name);
        continue;
      }
      if (!e) continue;
      const p = f.pending.get(name);
      if (p && p.size === e.size && p.mtime === e.mtime) {
        if (now - p.since >= f.settleMs) {
          f.pending.delete(name);
          f.baseline.add(name);
          fired.push(join(f.path, name));
        }
        continue;
      }
      f.pending.set(name, { ...e, since: now });
    }
    return fired;
  }

  /** The process list: the set of running apps; a diff is a launch or a quit. A failed or cut listing changes nothing. */
  private async pollApps(): Promise<SystemSignal[]> {
    const exec = this.opts.exec;
    if (!exec?.output) return [];
    let apps: Set<string>;
    try {
      const r = await exec.output("/bin/ps", ["-axo", "pid,comm"], PS_TIMEOUT_MS);
      if (r.code !== 0 || r.error || /bytes dropped\] …/.test(r.stdout)) {
        log.debug(`process list: ${r.error ?? `exit ${r.code ?? "?"}`}`);
        return [];
      }
      apps = runningApps(r.stdout);
    } catch (e) {
      log.debug(`process list: ${(e as Error).message}`);
      return [];
    }
    const before = this.knownApps;
    this.knownApps = apps;
    if (!before) return [];
    const out: SystemSignal[] = [];
    for (const app of before) if (!apps.has(app)) out.push({ kind: "app.quit", app });
    for (const app of apps) if (!before.has(app)) out.push({ kind: "app.launch", app });
    return out;
  }

  /** One recipe.red run through the shell gate; the flip is the fire. */
  private async pollRecipe(a: Automation, name: string, r: RecipeState): Promise<string | undefined> {
    const recipe = recipeNamed(this.opts.settings().automations.recipes, name);
    if (!recipe) return undefined;
    const cwd = recipe.cwd ? expandPath(recipe.cwd, this.opts.home) : this.opts.home;
    const d = this.opts.shellGate({ kind: "run_shell", text: recipe.command, confirmed: false, cwd, home: this.opts.home, presence: { recent: false }, ...(this.opts.repoRoot ? { repoRoot: this.opts.repoRoot } : {}) });
    if (d.verdict !== "run") {
      log.info(`recipe.red ${a.name}: ${recipe.name} is ${d.verdict} now; not run`);
      return undefined;
    }
    r.running = true;
    let code: number | null;
    try {
      const out = await this.opts.shell({ command: recipe.command, cwd, timeoutMs: Math.min(RECIPE_RED_CAP_MS, Math.max(1, recipe.timeoutSeconds) * 1000) });
      code = out.error ? null : out.code;
    } catch {
      code = null;
    } finally {
      r.running = false;
    }
    const was = r.lastExit;
    r.lastExit = code;
    if (was === undefined) return undefined; // the first run is the baseline
    const red = code !== 0;
    const wasRed = was !== 0;
    if (red && !wasRed) return `recipe ${recipe.name} red · exit ${code ?? "?"}`;
    if (!red && wasRed) return `recipe ${recipe.name} green again`;
    return undefined;
  }

  /** A signal the app forwarded (or the fallback poll produced) against the armed watchers. */
  signal(sig: SystemSignal, rows: readonly Automation[]): WatcherFire[] {
    const out: WatcherFire[] = [];
    for (const a of rows) {
      if (a.when.kind !== "on") continue;
      const on = a.when.on;
      if ((on.kind === "app.quit" || on.kind === "app.launch") && sig.kind === on.kind && sig.app.toLowerCase() === on.app.toLowerCase()) out.push({ id: a.id, what: `${sig.app} ${on.kind === "app.quit" ? "quit" : "launched"}` });
      else if ((on.kind === "mac.wake" || on.kind === "screen.unlock" || on.kind === "display.connected" || on.kind === "display.disconnected") && sig.kind === on.kind) out.push({ id: a.id, what: describeSignal(sig) });
    }
    return out;
  }

  /** The agents registry refreshed: a status that moved fires the rows that name it (the first listing is the baseline). */
  agents(list: readonly AgentInfo[], rows: readonly Automation[]): WatcherFire[] {
    const out: WatcherFire[] = [];
    const changed: AgentInfo[] = [];
    for (const agent of list) {
      const before = this.agentStatus.get(agent.id);
      this.agentStatus.set(agent.id, agent.status);
      if (this.agentsSeen && before !== agent.status) changed.push(agent);
    }
    this.agentsSeen = true;
    for (const agent of changed) {
      for (const a of rows) {
        if (a.when.kind !== "on" || a.when.on.kind !== "agent.status") continue;
        const on = a.when.on;
        if (on.status !== agent.status) continue;
        if (on.agent && on.agent.toLowerCase() !== agent.name.toLowerCase() && on.agent !== agent.id) continue;
        out.push({ id: a.id, what: `${agent.name} is ${agent.status}` });
      }
    }
    return out;
  }
}

function describeSignal(sig: SystemSignal): string {
  switch (sig.kind) {
    case "mac.wake":
      return "the Mac woke";
    case "screen.unlock":
      return "the screen unlocked";
    case "display.connected":
      return "a display connected";
    case "display.disconnected":
      return "a display disconnected";
    default:
      return sig.kind;
  }
}
