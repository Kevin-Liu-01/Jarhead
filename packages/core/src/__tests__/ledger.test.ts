import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../ledger.ts";
import { LineSplitter } from "../ndjson.ts";
import { Marks } from "../marks.ts";

test("ledger appends and reads back in order, per day", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-ledger-"));
  const ledger = new Ledger(dir);
  const at = Date.UTC(2026, 8, 10, 12, 0, 0);
  const seen: string[] = [];
  ledger.onRow((r) => seen.push(r.type));
  ledger.append({ at, type: "problem", text: "one" });
  ledger.append({ at: at + 1, type: "problem", text: "two" });
  const rows = ledger.read(at);
  assert.deepEqual(rows.map((r) => (r.type === "problem" ? r.text : "")), ["one", "two"]);
  assert.deepEqual(seen, ["problem", "problem"]);
  assert.equal(ledger.days().length, 1);
});

test("line splitter frames partial chunks and caps runaway lines", () => {
  const s = new LineSplitter(64);
  assert.deepEqual(s.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(":2}\r\n\n"), ['{"b":2}']);
  assert.throws(() => s.push("x".repeat(100)));
});

test("marks measure from start and between", () => {
  let t = 1000;
  const m = new Marks(() => t);
  t = 1250;
  m.mark("a");
  t = 1900;
  m.mark("b");
  m.mark("b");
  assert.equal(m.since("a"), 250);
  assert.equal(m.between("a", "b"), 650);
  assert.equal(m.since("missing"), undefined);
});
