import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PlistSyntaxError, dictGet, dictOnly, dictSet, int, integerAt, parsePlistXml, serializePlistXml, str, stringAt } from "../install/plist.ts";

/**
 * The plist reader/writer over the exact subset `defaults export` emits. The Dock
 * document has `<data>` bookmark blobs and 14-digit integers, so the tests pin that
 * nothing is rounded, reordered or re-encoded on the way through.
 */

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

test("plist: the Dock export parses to a dict with the keys in file order, empties as empty arrays, scalars verbatim", () => {
  const doc = parsePlistXml(fixture("dock-two-tiles.xml"));
  assert.equal(doc.kind, "dict");
  if (doc.kind !== "dict") return;
  assert.deepEqual(
    doc.entries.map(([k]) => k),
    ["last-analytics-stamp", "lastShowIndicatorTime", "loc", "mod-count", "persistent-apps", "persistent-others", "recent-apps", "region", "tilesize", "trash-full", "version", "wvous-br-corner"],
  );
  assert.deepEqual(dictGet(doc, "persistent-others"), { kind: "array", items: [] });
  assert.equal(integerAt(doc, "mod-count"), "1427");
  assert.deepEqual(dictGet(doc, "lastShowIndicatorTime"), { kind: "real", text: "810855845.02202499" });
  assert.deepEqual(dictGet(doc, "trash-full"), { kind: "bool", value: true });
  const recent = dictGet(doc, "recent-apps");
  assert.equal(recent?.kind, "array");
  if (recent?.kind !== "array") return;
  const tile = dictGet(recent.items[0]!, "tile-data")!;
  assert.equal(integerAt(tile, "file-mod-date"), "20404966709239", "a 14-digit integer stays text");
  const book = dictGet(tile, "book");
  assert.equal(book?.kind, "data");
  if (book?.kind !== "data") return;
  assert.doesNotMatch(book.base64, /\s/, "whitespace stripped from <data>");
  assert.equal(book.base64, "Ym9vazwCAAAAAAUQQAAAAAAAAAAAAAAAAAAAAAAAAAAA0AAABAAAAAAAAAA=");
});

test("plist: entities decode on the way in and re-encode on the way out", () => {
  const doc = parsePlistXml(fixture("dock-two-tiles.xml"));
  const apps = dictGet(doc, "persistent-apps");
  assert.equal(apps?.kind, "array");
  if (apps?.kind !== "array") return;
  const notes = dictGet(apps.items[2]!, "tile-data")!;
  assert.equal(stringAt(notes, "file-label"), "Notes & Lists");
  assert.match(serializePlistXml(doc), /<string>Notes &amp; Lists<\/string>/);
  const odd = parsePlistXml('<plist version="1.0"><dict><key>k</key><string>a &lt; b &gt; c &quot;d&quot; &apos;e&apos; &#65;&#x42;</string></dict></plist>');
  assert.equal(stringAt(odd, "k"), "a < b > c \"d\" 'e' AB");
  assert.match(serializePlistXml(odd), /<string>a &lt; b &gt; c "d" 'e' AB<\/string>/);
});

test("plist: serialize(parse(x)) is byte-identical to Apple's own export layout, and round-trips", () => {
  for (const name of ["dock-two-tiles.xml", "dock-clean.xml", "dock-stale-url.xml"]) {
    const xml = fixture(name);
    const doc = parsePlistXml(xml);
    const out = serializePlistXml(doc);
    assert.equal(out, xml, `${name} re-serializes byte for byte (header, DOCTYPE, tabs, 44-column data lines, <array/>)`);
    assert.deepEqual(parsePlistXml(out), doc);
  }
});

test("plist: <array/> and <dict/> for empties; a truncated document names its offset", () => {
  assert.match(serializePlistXml({ kind: "dict", entries: [["a", { kind: "array", items: [] }], ["b", { kind: "dict", entries: [] }]] }), /<key>a<\/key>\n\t<array\/>\n\t<key>b<\/key>\n\t<dict\/>/);
  assert.throws(
    () => parsePlistXml('<?xml version="1.0"?><plist version="1.0"><dict><key>a</key><string>x'),
    (e: unknown) => e instanceof PlistSyntaxError && typeof e.offset === "number" && /unterminated <string>/.test(e.message),
  );
  assert.throws(() => parsePlistXml("<plist><dict><key>a</key></dict></plist>"), PlistSyntaxError, "a key without a value");
  assert.throws(() => parsePlistXml("<plist><dict><string>a</string></dict></plist>"), /expected <key>/);
  assert.throws(() => parsePlistXml("<plist><bogus/></plist>"), /unknown element/);
});

test("plist: dictGet / dictSet / dictOnly keep order and never mutate", () => {
  const d = parsePlistXml("<dict><key>x</key><integer>1</integer><key>y</key><string>two</string></dict>");
  const set = dictSet(d, "x", int("9"));
  assert.equal(integerAt(set, "x"), "9");
  assert.equal(integerAt(d, "x"), "1", "the input dict is untouched");
  const added = dictSet(d, "z", str("three"));
  assert.deepEqual(added.kind === "dict" ? added.entries.map(([k]) => k) : [], ["x", "y", "z"]);
  const only = dictOnly(added, ["z", "x", "missing"]);
  assert.deepEqual(only.kind === "dict" ? only.entries.map(([k]) => k) : [], ["z", "x"], "exactly these keys, in this order, absent ones skipped");
  assert.equal(dictGet(d, "nope"), undefined);
  assert.equal(stringAt(d, "x"), undefined, "an integer is not a string");
});

test("plist: plutil -lint accepts what we write", { skip: process.platform !== "darwin" }, () => {
  const out = serializePlistXml(parsePlistXml(fixture("dock-two-tiles.xml")));
  const r = execFileSync("plutil", ["-lint", "-"], { input: out, encoding: "utf8" });
  assert.match(r, /OK/);
});
