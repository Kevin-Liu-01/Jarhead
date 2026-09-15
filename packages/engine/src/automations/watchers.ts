import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandPath, logger, type ActionContext, type Decision } from "@jarhead/core";
import type { NativeHands, WindowInfo } from "@jarhead/hands";
import { AUTOMATION_POLL_MIN_S, recipeNamed, type AgentInfo, type Automation, type Settings, type SystemEvent, type SystemSignal } from "@jarhead/protocol";
import type { ShellRunner } from "./executor.ts";

/**
 * The watchers — polling from `tick()`, the house pattern. A folder is `readdirSync` +
 * `statSync` every FOLDER_POLL_MS against a baseline (a new entry whose size and mtime
 * hold for `settleMs` fires once; browser partials and .DS_Store never count; files
 * that were there at arm never fire — a folder is not a queue). An app quitting or
 * launching arrives as the app's `system.signal`; the reading helper's `windows` every
 * APP_POLL_MS is the fallback edge. `recipe.red` runs its recipe every `everySeconds`
 * through the shell gate and fires on the flip to non-zero and once on the flip back.
 * `agent.status` reads the registry the engine already refreshes. Nothing here acts.
 */

const log = logger("engine.automations.watchers");

export const FOLDER_POLL_MS = 5_000;
export const APP_POLL_MS = 10_000;
export const SETTLE_DEFAULT_MS = 3_000;
/** A recipe.red run is cut here whatever its recipe says. */
export const RECIPE_RED_CAP_MS = 20_000;
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
  readonly baseline: Map<string, Entry>;
  readonly pending: Map<string, Entry & { readonly since: number }>;
  /** Files that landed while the daemon was down or the folder unreadable: counted, never replayed. */
  unhandled: number;
}

interface RecipeState {
  lastExit: number | null | undefined;
  lastRunAt: number;
  running: boolean;
}

export interface WatchersOptions {
  readonly now: () => number;
  /** The reading helper (the `windows` fallback poll). */
  readonly reader: NativeHands;
  readonly shell: ShellRunner;
  readonly shellGate: (ctx: ActionContext) => Decision;
  readonly settings: () => Settings;
  readonly home: string;
  readonly repoRoot?: string | undefined;
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

export class Watchers {
  private readonly folders = new Map<string, FolderState>();
  private readonly recipes = new Map<string, RecipeState>();
  private lastFolderPollAt = 0;
  private lastAppPollAt = 0;
  /** The app names the reading helper last saw with a window; undefined before the first poll. */
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
   * the folder cannot be listed (EPERM, ENOENT); the caller raises the problem.
   */
  watch(a: Automation): string | undefined {
    if (a.when.kind !== "on") return undefined;
    const on = a.when.on;
    const folder = folderOf(on, this.opts.home);
    if (folder !== undefined) {
      const glob = on.kind === "folder.file" || on.kind === "download.done" ? on.glob : undefined;
      const settleMs = on.kind === "folder.file" && on.settleMs !== undefined ? Math.max(500, on.settleMs) : SETTLE_DEFAULT_MS;
      const state: FolderState = { path: folder, glob: glob ? globToRegExp(glob) : undefined, settleMs, baseline: new Map(), pending: new Map(), unhandled: 0 };
      const err = this.baseline(state);
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

  /** After a gap (the Mac slept, the daemon was down): every folder's listing is the new baseline; what landed meanwhile is counted, not replayed. */
  rebaseline(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, f] of this.folders) {
      const before = new Set(f.baseline.keys());
      f.pending.clear();
      const err = this.baseline(f);
      if (err) continue;
      let landed = 0;
      for (const name of f.baseline.keys()) if (!before.has(name)) landed++;
      f.unhandled += landed;
      if (landed > 0) out.set(id, landed);
    }
    return out;
  }

  private baseline(f: FolderState): string | undefined {
    try {
      f.baseline.clear();
      for (const name of readdirSync(f.path)) {
        const e = this.entry(f.path, name);
        if (e) f.baseline.set(name, e);
      }
      return undefined;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "EPERM" || code === "EACCES" ? `${f.path} cannot be read (macOS asks for the folder)` : `${f.path}: ${(e as Error).message}`;
    }
  }

  private entry(dir: string, name: string): Entry | undefined {
    try {
      const s = statSync(join(dir, name));
      if (!s.isFile()) return undefined;
      return { size: s.size, mtime: s.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * The polls, due by their own clocks: folders every FOLDER_POLL_MS, the app fallback
   * every APP_POLL_MS (only while a row listens for an app), each recipe.red at its own
   * `everySeconds`. `rows` are the armed watchers; anything else is ignored.
   */
  async poll(now: number, rows: readonly Automation[]): Promise<WatcherFire[]> {
    const fires: WatcherFire[] = [];
    if (now - this.lastFolderPollAt >= FOLDER_POLL_MS) {
      this.lastFolderPollAt = now;
      for (const a of rows) {
        const f = this.folders.get(a.id);
        if (f) for (const file of this.pollFolder(f, now)) fires.push({ id: a.id, file, what: `landed ${file.slice(file.lastIndexOf("/") + 1)}` });
      }
    }
    const appRows = rows.filter((a) => a.when.kind === "on" && (a.when.on.kind === "app.quit" || a.when.on.kind === "app.launch"));
    if (appRows.length > 0 && now - this.lastAppPollAt >= APP_POLL_MS) {
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

  /**
   * One folder's poll: an entry the baseline does not hold — by name AND by size and mtime,
   * so a file that replaces one already filed away under the same name is a new landing —
   * fires once it settled; gone entries leave the maps.
   */
  private pollFolder(f: FolderState, now: number): string[] {
    let names: string[];
    try {
      names = readdirSync(f.path);
    } catch (e) {
      log.debug(`folder ${f.path}: ${(e as Error).message}`);
      return [];
    }
    const seen = new Set(names);
    for (const name of [...f.baseline.keys()]) if (!seen.has(name)) f.baseline.delete(name);
    for (const name of [...f.pending.keys()]) if (!seen.has(name)) f.pending.delete(name);
    const fired: string[] = [];
    for (const name of names) {
      if (IGNORED.test(name)) continue;
      const e = this.entry(f.path, name);
      if (!e) continue;
      const known = f.baseline.get(name);
      if (known && known.size === e.size && known.mtime === e.mtime) continue;
      const p = f.pending.get(name);
      if (p && p.size === e.size && p.mtime === e.mtime) {
        if (now - p.since >= f.settleMs) {
          f.pending.delete(name);
          f.baseline.set(name, e);
          if (!f.glob || f.glob.test(name)) fired.push(join(f.path, name));
        }
        continue;
      }
      f.pending.set(name, { ...e, since: now });
    }
    return fired;
  }

  /** The reading helper's `windows`: the set of apps with a window; a diff is a launch or a quit. */
  private async pollApps(): Promise<SystemSignal[]> {
    let apps: Set<string>;
    try {
      const r = await this.opts.reader.request<{ readonly windows?: readonly WindowInfo[] }>("windows", {}, 1500);
      apps = new Set((r.windows ?? []).map((w) => w.app).filter((s) => typeof s === "string" && s.length > 0));
    } catch (e) {
      log.debug(`windows poll: ${(e as Error).message}`);
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
