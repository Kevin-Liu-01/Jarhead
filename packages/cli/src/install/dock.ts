import { type PlistNode, dict, dictGet, dictOnly, dictSet, int, integerAt, str, stringAt } from "./plist.ts";

/**
 * The Dock's view of Jarhead, as pure functions over the exported `com.apple.dock`
 * document and the `lsappinfo list` text. Two causes have drawn a second tile:
 *
 *   1. A pinned tile stores a `book` bookmark that keys on the bundle directory's
 *      inode; when `rm + cp` gave /Applications/Jarhead.app a new inode the bookmark
 *      died and the Dock grew a second, "recent" Jarhead. The install now keeps the
 *      inode (verified after every rsync), so the plist audit is mostly a read.
 *   2. A helper inside the bundle (`jarhead-hands`) that never sets its own activation
 *      policy: LaunchServices reads the enclosing bundle's Info.plist (LSUIElement
 *      false) for it and checks it in as a second Foreground "Jarhead" — one running
 *      tile per helper, parked in `recent-apps` when the helper exits. No plist repair
 *      can touch a live ASN: the tile is back within seconds of `killall Dock`. The fix
 *      is `setActivationPolicy(.prohibited)` at the helper's start; the audit names
 *      the cause (`helperTiles`) instead of promising that `dock --fix` repairs it.
 *
 * The repair (drop recent tiles, keep one pin stripped to the keys the Dock rebuilds
 * its bookmark from) runs only when Kevin asks for it (`pnpm jarhead dock --fix`,
 * JARHEAD_INSTALL_HYGIENE=fix) and, with a helper tile alive, clears only the leftover.
 */

export const DOCK_DOMAIN = "com.apple.dock";
export const JARHEAD_BUNDLE_ID = "com.kevinliu.jarhead";
export const INSTALLED_APP = "/Applications/Jarhead.app";
export const INSTALLED_URL = "file:///Applications/Jarhead.app/";
/** `file-type` most of Kevin's tiles carry; used only when a rebuilt pin has none. */
export const DEFAULT_FILE_TYPE = "41";
/** What a rebuilt pin keeps, in this order; `book`, the mod dates, `dock-extra` and `is-beta` are dropped so the Dock recomputes them. */
export const PIN_KEYS = ["bundle-identifier", "file-data", "file-label", "file-type"] as const;

export type DockList = "persistent-apps" | "recent-apps";

export interface DockTile {
  readonly list: DockList;
  readonly index: number;
  readonly guid: string | undefined;
  readonly bundleId: string | undefined;
  readonly url: string | undefined;
  readonly label: string | undefined;
  readonly hasBookmark: boolean;
}

export type DockChange =
  | { readonly kind: "remove-recent"; readonly tile: DockTile }
  | { readonly kind: "remove-duplicate-pin"; readonly tile: DockTile }
  | { readonly kind: "rebuild-pin"; readonly tile: DockTile; readonly dropped: readonly string[]; readonly urlWas: string | undefined };

export interface DockAudit {
  readonly jarhead: readonly DockTile[];
  readonly pinned: number;
  readonly recent: number;
  readonly changes: readonly DockChange[];
  /** The repaired document; the very same object as the input when nothing changes. */
  readonly doc: PlistNode;
  readonly modCount: string | undefined;
  /**
   * Running processes LaunchServices counts as Foreground Jarhead apps besides the app
   * itself — each is a tile the plist repair cannot remove. Set by the one-Jarhead pass
   * (`runHygiene`, which reads `lsappinfo list`); absent when nobody read it.
   */
  readonly helperTiles?: readonly RunningApp[];
}

/** One `lsappinfo list` block: a process LaunchServices has checked in. */
export interface RunningApp {
  readonly pid: number;
  readonly bundleId: string | undefined;
  readonly executable: string | undefined;
  /** `Foreground` (a Dock tile), `UIElement`, `BackgroundOnly`; undefined when the block has none. */
  readonly type: string | undefined;
}

/**
 * `lsappinfo list`: blocks start with `N) "Name" ASN:…:` at the margin; fields are
 * indented — `bundleID="…"` (or `[ NULL ]`), `executable path="…"`, and one line with
 * `pid = N … type="Foreground"`. Blocks without a pid (an ASN whose process is gone) are skipped.
 */
export function parseLsAppInfoList(text: string): RunningApp[] {
  const apps: RunningApp[] = [];
  for (const block of text.split(/^\s*\d+\) /m)) {
    const pid = block.match(/^\s*pid = (\d+)/m)?.[1];
    if (!pid) continue;
    apps.push({
      pid: Number(pid),
      bundleId: block.match(/^\s*bundleID="([^"]*)"/m)?.[1],
      executable: block.match(/^\s*executable path="([^"]*)"/m)?.[1],
      type: block.match(/\btype="([^"]*)"/)?.[1],
    });
  }
  return apps;
}

/** The app's own executable inside the installed bundle — the one Foreground process that IS the pinned tile. */
export function appExecutableOf(installed = INSTALLED_APP): string {
  return `${installed.replace(/\/+$/, "")}/Contents/MacOS/Jarhead`;
}

/**
 * A helper tile: Jarhead's bundle id, checked in as Foreground, from any executable but
 * the app's own. The Dock draws one tile per Foreground ASN, so each of these is a
 * second Jarhead while it lives, and a `recent-apps` leftover once it exits.
 */
export function helperTilesOf(apps: readonly RunningApp[], opts: { readonly bundleId?: string; readonly installed?: string } = {}): RunningApp[] {
  const bundleId = opts.bundleId ?? JARHEAD_BUNDLE_ID;
  const own = appExecutableOf(opts.installed ?? INSTALLED_APP);
  return apps.filter((a) => a.bundleId === bundleId && a.type === "Foreground" && a.executable !== own);
}

/**
 * The clause that names the cause: "jarhead-hands pid 66017 is a Foreground app (the
 * second tile) — the pin is fine; rebuild the helper (pnpm build:mac) and relaunch,
 * then dock --fix clears the leftover". `remedy` is what clears the leftover where the
 * clause is read: the CLI's `dock --fix`, the Console's Fix the Dock.
 */
export function describeHelperTiles(helpers: readonly RunningApp[], remedy = "dock --fix"): string {
  if (helpers.length === 0) return "";
  const names = [...new Set(helpers.map((h) => basenameOf(h.executable ?? "") || "a helper"))].join(", ");
  const pids = helpers.map((h) => h.pid).join(", ");
  const who = helpers.length === 1 ? `${names} pid ${pids} is a Foreground app (the second tile)` : `${names} pids ${pids} are Foreground apps (the extra tiles)`;
  return `${who} — the pin is fine; rebuild the helper (pnpm build:mac) and relaunch, then ${remedy} clears the leftover`;
}

export interface DockOptions {
  readonly bundleId?: string;
  readonly installedUrl?: string;
}

/** The path a `file:///…/` URL names, decoded; undefined for anything else. */
function urlPath(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file://")) return undefined;
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function tileAt(list: DockList, index: number, node: PlistNode): DockTile {
  const data = dictGet(node, "tile-data");
  const fileData = data ? dictGet(data, "file-data") : undefined;
  return {
    list,
    index,
    guid: integerAt(node, "GUID"),
    bundleId: data ? stringAt(data, "bundle-identifier") : undefined,
    url: fileData ? stringAt(fileData, "_CFURLString") : undefined,
    label: data ? stringAt(data, "file-label") : undefined,
    hasBookmark: data ? dictGet(data, "book")?.kind === "data" : false,
  };
}

function tilesOf(doc: PlistNode, list: DockList): DockTile[] {
  const arr = dictGet(doc, list);
  if (arr?.kind !== "array") return [];
  return arr.items.map((node, index) => tileAt(list, index, node));
}

/** A Jarhead tile: the exact bundle id, or a URL whose bundle is named Jarhead.app (a stale build path, a Trash copy). Sub-ids like `.ear-probe` are not Jarhead. */
export function isJarheadTile(tile: DockTile, bundleId = JARHEAD_BUNDLE_ID): boolean {
  if (tile.bundleId === bundleId) return true;
  const path = urlPath(tile.url);
  return path !== undefined && basenameOf(path).toLowerCase() === "jarhead.app";
}

export function findJarheadTiles(doc: PlistNode, opts: DockOptions = {}): DockTile[] {
  const bundleId = opts.bundleId ?? JARHEAD_BUNDLE_ID;
  return [...tilesOf(doc, "persistent-apps"), ...tilesOf(doc, "recent-apps")].filter((t) => isJarheadTile(t, bundleId));
}

export function modCountOf(doc: PlistNode): string | undefined {
  return integerAt(doc, "mod-count");
}

/** The pin's `tile-data` reduced to what the Dock needs to rebuild its bookmark, pointed at the installed bundle. */
function rebuiltTileData(data: PlistNode, installedUrl: string, bundleId: string): { node: PlistNode; dropped: string[] } {
  const keep = new Set<string>(PIN_KEYS);
  const dropped = data.kind === "dict" ? data.entries.map(([k]) => k).filter((k) => !keep.has(k)) : [];
  let node = dictOnly(data, PIN_KEYS);
  node = dictSet(node, "bundle-identifier", str(bundleId));
  node = dictSet(node, "file-data", dict([["_CFURLString", str(installedUrl)], ["_CFURLStringType", int("15")]]));
  node = dictSet(node, "file-label", str("Jarhead"));
  if (!dictGet(node, "file-type")) node = dictSet(node, "file-type", int(DEFAULT_FILE_TYPE));
  // dictOnly kept the pin's own order; PIN_KEYS is the order the Dock writes, so re-lay it.
  return { node: dictOnly(node, PIN_KEYS), dropped: dropped.sort() };
}

/**
 * Audit the exported document. Rules: every Jarhead tile in `recent-apps` goes; the
 * first Jarhead pin stays where it is and later ones go; the kept pin is rebuilt when
 * anything else changed or its URL is not the installed bundle's. No pin → nothing to
 * do (report only; pinning is Kevin's). Nothing else in the document is touched.
 */
export function auditDock(doc: PlistNode, opts: DockOptions = {}): DockAudit {
  const bundleId = opts.bundleId ?? JARHEAD_BUNDLE_ID;
  const installedUrl = opts.installedUrl ?? INSTALLED_URL;
  const jarhead = findJarheadTiles(doc, { bundleId });
  const pins = jarhead.filter((t) => t.list === "persistent-apps");
  const recents = jarhead.filter((t) => t.list === "recent-apps");
  const changes: DockChange[] = [];
  const modCount = modCountOf(doc);
  const bail = (): DockAudit => ({ jarhead, pinned: pins.length, recent: recents.length, changes, doc, modCount });
  if (doc.kind !== "dict" || pins.length === 0) return bail();

  const keptPin = pins[0] as DockTile;
  for (const t of recents) changes.push({ kind: "remove-recent", tile: t });
  for (const t of pins.slice(1)) changes.push({ kind: "remove-duplicate-pin", tile: t });
  const urlStale = keptPin.url !== installedUrl;
  if (changes.length === 0 && !urlStale) return bail();

  let out: PlistNode = doc;
  const apps = dictGet(doc, "persistent-apps");
  if (apps?.kind === "array") {
    const dropAt = new Set(pins.slice(1).map((t) => t.index));
    const items = apps.items
      .map((node, index) => {
        if (index !== keptPin.index) return node;
        const data = dictGet(node, "tile-data") ?? dict([]);
        const rebuilt = rebuiltTileData(data, installedUrl, bundleId);
        changes.push({ kind: "rebuild-pin", tile: keptPin, dropped: rebuilt.dropped, urlWas: keptPin.url });
        return dictSet(node, "tile-data", rebuilt.node);
      })
      .filter((_node, index) => !dropAt.has(index));
    out = dictSet(out, "persistent-apps", { kind: "array", items });
  }
  const recentArr = dictGet(doc, "recent-apps");
  if (recentArr?.kind === "array" && recents.length) {
    const dropAt = new Set(recents.map((t) => t.index));
    out = dictSet(out, "recent-apps", { kind: "array", items: recentArr.items.filter((_node, index) => !dropAt.has(index)) });
  }
  return { jarhead, pinned: pins.length, recent: recents.length, changes, doc: out, modCount };
}

/**
 * One clause for the summary line and the doctor row. A helper tile is appended after
 * `;` whatever the plist says: the Dock draws it whether or not `recent-apps` has
 * caught up, and it is the one tile the repair cannot remove.
 */
export function describeDock(a: DockAudit | undefined, skipped?: string): string {
  if (skipped) return `Dock: skipped (${skipped})`;
  if (!a) return "Dock: not read";
  const helpers = a.helperTiles ?? [];
  const cause = helpers.length ? `; ${describeHelperTiles(helpers)}` : "";
  if (a.pinned === 0 && a.recent === 0) return `Dock: not pinned — drag /Applications/Jarhead.app to the Dock once; the bookmark then stays valid across builds${cause}`;
  if (a.pinned === 0) return `Dock: not pinned, ${a.recent} recent${cause}`;
  const base = `Dock: ${a.pinned} pinned, ${a.recent} recent`;
  if (a.changes.length === 0) return `${base}${cause}`;
  const notes: string[] = [];
  if (a.recent === 1) notes.push("two tiles");
  else if (a.recent > 1) notes.push(`${a.recent + a.pinned} tiles`);
  if (a.pinned > 1) notes.push(`${a.pinned - 1} duplicate pin${a.pinned - 1 === 1 ? "" : "s"}`);
  const rebuild = a.changes.find((c) => c.kind === "rebuild-pin");
  if (rebuild && rebuild.urlWas !== INSTALLED_URL) notes.push(`pin points at ${rebuild.urlWas ?? "nothing"}`);
  return `${base} — ${notes.join(", ") || "needs a repair"}${cause}`;
}

/** What a repair did, for the summary line: "removed 1 recent tile, pin rebuilt". */
export function describeDockChanges(changes: readonly DockChange[]): string {
  const removedRecent = changes.filter((c) => c.kind === "remove-recent").length;
  const removedPins = changes.filter((c) => c.kind === "remove-duplicate-pin").length;
  const parts: string[] = [];
  if (removedRecent) parts.push(`removed ${removedRecent} recent tile${removedRecent === 1 ? "" : "s"}`);
  if (removedPins) parts.push(`removed ${removedPins} duplicate pin${removedPins === 1 ? "" : "s"}`);
  if (changes.some((c) => c.kind === "rebuild-pin")) parts.push("pin rebuilt");
  return parts.join(", ");
}
