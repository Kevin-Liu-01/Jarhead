import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_FILE_TYPE, INSTALLED_URL, PIN_KEYS, auditDock, describeDock, describeDockChanges, findJarheadTiles, isJarheadTile, modCountOf, type DockTile } from "../install/dock.ts";
import { dictGet, dictSet, integerAt, parsePlistXml, serializePlistXml, stringAt, type PlistNode } from "../install/plist.ts";

/**
 * The Dock audit over Kevin's own two-tile document (sanitized): the recent tile
 * goes, the pin stays where it is stripped to the keys the Dock rebuilds its
 * bookmark from, and nothing else in the document moves. A clean Dock is returned
 * as the very same object, so the caller can tell "nothing to do" by identity.
 */

const fixture = (name: string): PlistNode => parsePlistXml(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const tileNodes = (doc: PlistNode, list: string): readonly PlistNode[] => {
  const arr = dictGet(doc, list);
  return arr?.kind === "array" ? arr.items : [];
};

test("dock: the two-tile export has a pinned Jarhead and a recent Jarhead, both bookmarked", () => {
  const doc = fixture("dock-two-tiles.xml");
  const tiles = findJarheadTiles(doc);
  assert.deepEqual(
    tiles.map((t) => ({ list: t.list, index: t.index, guid: t.guid, url: t.url, hasBookmark: t.hasBookmark, label: t.label })),
    [
      { list: "persistent-apps", index: 1, guid: "2654545783", url: INSTALLED_URL, hasBookmark: true, label: "Jarhead" },
      { list: "recent-apps", index: 0, guid: "2654545784", url: INSTALLED_URL, hasBookmark: true, label: "Jarhead" },
    ],
  );
  assert.equal(modCountOf(doc), "1427");
});

test("dock: the audit removes the recent tile, rebuilds the pin in place, and leaves every other tile byte-identical", () => {
  const doc = fixture("dock-two-tiles.xml");
  const a = auditDock(doc);
  assert.equal(a.pinned, 1);
  assert.equal(a.recent, 1);
  assert.deepEqual(
    a.changes.map((c) => c.kind),
    ["remove-recent", "rebuild-pin"],
  );
  const rebuild = a.changes.find((c) => c.kind === "rebuild-pin");
  assert.ok(rebuild && rebuild.kind === "rebuild-pin");
  assert.deepEqual(rebuild.dropped, ["book", "dock-extra", "file-mod-date", "is-beta", "parent-mod-date"]);
  assert.equal(rebuild.urlWas, INSTALLED_URL);
  assert.notEqual(a.doc, doc, "a repaired document is a new object");
  assert.equal(a.modCount, "1427");

  const appsBefore = tileNodes(doc, "persistent-apps");
  const appsAfter = tileNodes(a.doc, "persistent-apps");
  assert.equal(appsAfter.length, 3, "the pin keeps its slot");
  assert.equal(serializePlistXml(appsAfter[0]!), serializePlistXml(appsBefore[0]!), "Safari untouched");
  assert.equal(serializePlistXml(appsAfter[2]!), serializePlistXml(appsBefore[2]!), "Notes untouched");
  const pin = appsAfter[1]!;
  assert.equal(integerAt(pin, "GUID"), "2654545783", "outer GUID kept");
  assert.equal(stringAt(pin, "tile-type"), "file-tile", "tile-type kept");
  const data = dictGet(pin, "tile-data")!;
  assert.deepEqual(data.kind === "dict" ? data.entries.map(([k]) => k) : [], [...PIN_KEYS], "exactly the keys the Dock rebuilds from, in its order");
  assert.equal(stringAt(data, "bundle-identifier"), "com.kevinliu.jarhead");
  assert.equal(stringAt(data, "file-label"), "Jarhead");
  assert.equal(integerAt(data, "file-type"), "1", "an existing file-type is kept");
  const fileData = dictGet(data, "file-data")!;
  assert.equal(stringAt(fileData, "_CFURLString"), INSTALLED_URL);
  assert.equal(integerAt(fileData, "_CFURLStringType"), "15");

  const recentAfter = tileNodes(a.doc, "recent-apps");
  assert.equal(recentAfter.length, 1);
  assert.equal(stringAt(dictGet(recentAfter[0]!, "tile-data")!, "file-label"), "TextEdit", "the other recent tile stays");
  // Nothing else in the document moved.
  for (const key of ["last-analytics-stamp", "lastShowIndicatorTime", "loc", "mod-count", "persistent-others", "region", "tilesize", "trash-full", "version", "wvous-br-corner"]) {
    assert.deepEqual(dictGet(a.doc, key), dictGet(doc, key), key);
  }
  assert.match(describeDock(a), /^Dock: 1 pinned, 1 recent — two tiles$/);
  assert.equal(describeDockChanges(a.changes), "removed 1 recent tile, pin rebuilt");
});

test("dock: a clean Dock is returned as the same object with no changes", () => {
  const doc = fixture("dock-clean.xml");
  const a = auditDock(doc);
  assert.equal(a.changes.length, 0);
  assert.equal(a.doc, doc, "same reference: nothing to import");
  assert.equal(a.pinned, 1);
  assert.equal(a.recent, 0);
  assert.equal(describeDock(a), "Dock: 1 pinned, 0 recent");
  assert.equal(describeDockChanges(a.changes), "");
});

test("dock: two pins keep the first and drop the second; a missing recent-apps key is fine", () => {
  const doc = fixture("dock-clean.xml");
  const apps = dictGet(doc, "persistent-apps");
  assert.equal(apps?.kind, "array");
  if (apps?.kind !== "array") return;
  const twoPins = dictSet(dictSet(doc, "persistent-apps", { kind: "array", items: [...apps.items, apps.items[1]!] }), "recent-apps", { kind: "array", items: [] });
  const noRecentKey: PlistNode = { kind: "dict", entries: twoPins.kind === "dict" ? twoPins.entries.filter(([k]) => k !== "recent-apps") : [] };
  const a = auditDock(noRecentKey);
  assert.equal(a.pinned, 2);
  assert.deepEqual(
    a.changes.map((c) => [c.kind, c.tile.index]),
    [
      ["remove-duplicate-pin", 2],
      ["rebuild-pin", 1],
    ],
  );
  assert.equal(tileNodes(a.doc, "persistent-apps").length, 2);
  assert.equal(integerAt(tileNodes(a.doc, "persistent-apps")[1]!, "GUID"), "2654545783", "the first pin kept its slot");
  assert.match(describeDock(a), /2 pinned, 0 recent — 1 duplicate pin/);
});

test("dock: no Jarhead pin means report only — never pin on Kevin's behalf", () => {
  const doc = fixture("dock-clean.xml");
  const apps = dictGet(doc, "persistent-apps");
  if (apps?.kind !== "array") return assert.fail("fixture");
  const unpinned = dictSet(doc, "persistent-apps", { kind: "array", items: [apps.items[0]!] });
  const a = auditDock(unpinned);
  assert.equal(a.pinned, 0);
  assert.equal(a.changes.length, 0);
  assert.equal(a.doc, unpinned);
  assert.match(describeDock(a), /^Dock: not pinned — drag/);
  // A recent tile without a pin is still left alone: two tiles cannot happen without a pin.
  const recentOnly = dictSet(unpinned, "recent-apps", { kind: "array", items: [tileNodes(fixture("dock-two-tiles.xml"), "recent-apps")[0]!] });
  const b = auditDock(recentOnly);
  assert.equal(b.changes.length, 0);
  assert.equal(describeDock(b), "Dock: not pinned, 1 recent");
});

test("dock: a pin at a stale URL is rebuilt to the installed bundle and gets file-type 41 when it had none", () => {
  const doc = fixture("dock-stale-url.xml");
  const a = auditDock(doc);
  assert.deepEqual(
    a.changes.map((c) => c.kind),
    ["rebuild-pin"],
  );
  const c = a.changes[0]!;
  assert.ok(c.kind === "rebuild-pin");
  assert.equal(c.urlWas, "file:///Users/kevinliu/jarvis/build/Jarhead.app/");
  const data = dictGet(tileNodes(a.doc, "persistent-apps")[0]!, "tile-data")!;
  assert.equal(stringAt(dictGet(data, "file-data")!, "_CFURLString"), INSTALLED_URL);
  assert.equal(integerAt(data, "file-type"), DEFAULT_FILE_TYPE);
  assert.match(describeDock(a), /pin points at file:\/\/\/Users\/kevinliu\/jarvis\/build\/Jarhead\.app\//);
});

test("dock: a tile is Jarhead by exact bundle id or by a URL named Jarhead.app (any case); a sub-id probe bundle is not", () => {
  const base: DockTile = { list: "persistent-apps", index: 0, guid: undefined, bundleId: undefined, url: undefined, label: undefined, hasBookmark: false };
  assert.ok(isJarheadTile({ ...base, bundleId: "com.kevinliu.jarhead" }));
  assert.ok(isJarheadTile({ ...base, url: "file:///Users/kevinliu/.Trash/jarhead.app/" }));
  assert.ok(isJarheadTile({ ...base, url: "file:///Users/kevinliu/jarvis/build/Jarhead.app/" }));
  assert.ok(!isJarheadTile({ ...base, bundleId: "com.kevinliu.jarhead.ear-probe", url: "file:///Users/kevinliu/jarvis/apps/mac/.build/ear-probe/EarProbe.app/" }));
  assert.ok(!isJarheadTile({ ...base, bundleId: "com.apple.Safari", url: "file:///Applications/Safari.app/" }));
  assert.ok(!isJarheadTile({ ...base, url: "not a url" }));
});
