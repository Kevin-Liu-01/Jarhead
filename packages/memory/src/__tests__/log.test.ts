import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryLog, replay } from "../log.ts";
import { MemoryStore } from "../store.ts";
import type { MemoryRow } from "../types.ts";
import { clock, fresh, ids, T0 } from "./helpers.ts";

/**
 * The record: memory.jsonl only grows. Every verb is a row; replaying the rows
 * rebuilds the same items; a malformed line costs one line, never the file.
 */

const src = { at: T0, type: "heard" as const, sessionId: "A" };

test("log: append then replay reproduces the store's items exactly; forget keeps the item (state forgotten) and restore flips it back", () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const a = store.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.7, importance: 0.6, origin: "extracted" }, src);
  c.tick(1000);
  const b = store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  c.tick(1000);
  store.touch(a.id, { ...src, at: c.now() }, { confidence: 0.9 });
  store.update(b.id, { text: "Kevin goes by Kev." }, { ...src, at: c.now() });
  store.forget(a.id, "kevin");
  assert.equal(store.get(a.id)?.state, "forgotten");
  store.restore(a.id);
  assert.equal(store.get(a.id)?.state, "live");
  const e1 = store.add({ kind: "episode", text: "Kevin shipped the auth branch", confidence: 0.6, importance: 0.3, origin: "extracted" }, src);
  const e2 = store.add({ kind: "episode", text: "Kevin shipped the auth branch.", confidence: 0.6, importance: 0.3, origin: "extracted" }, src);
  store.merge(e1.id, e2.id, true);
  store.archive(b.id, "decay");
  store.exclude(T0, T0 + 1000, "A");
  store.setWatermark("A", T0 + 5000, "rules", { added: 2, updated: 1, noop: 1, refused: 0 });

  const log = new MemoryLog(join(dir, "memory.jsonl"));
  const read = log.read();
  assert.equal(read.skipped, 0);
  assert.equal(read.lines, store.lineCount);
  const state = replay(read.rows);
  assert.deepEqual([...state.items.values()], store.items("all"));
  assert.equal(state.items.get(a.id)?.seenCount, 2);
  assert.equal(state.items.get(a.id)?.confidence, 0.9);
  assert.equal(state.items.get(b.id)?.text, "Kevin goes by Kev.");
  assert.equal(state.items.get(b.id)?.state, "archived");
  assert.equal(state.items.get(e1.id)?.state, "merged");
  assert.equal(state.items.get(e1.id)?.mergedInto, e2.id);
  assert.equal(state.items.get(e2.id)?.seenCount, 2, "a fold combines evidence");
  assert.deepEqual(state.watermarks.get("A")?.counts, { added: 2, updated: 1, noop: 1, refused: 0 });
  assert.deepEqual(state.exclusions, [{ from: T0, to: T0 + 1000, sessionId: "A" }]);

  // the text change kept what was said before
  const updateRow = read.rows.find((r) => r.op === "update") as Extract<MemoryRow, { op: "update" }>;
  assert.equal(updateRow.prev?.text, "Kevin goes by Kev");
  // the forgotten item is still a line in the file
  assert.ok(readFileSync(log.path, "utf8").includes("Kevin prefers short answers"));
});

test("log: a malformed line is skipped and counted; the rows around it still replay", () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  appendFileSync(join(dir, "memory.jsonl"), "{this is not json\n");
  store.add({ kind: "fact", text: "Kevin's office is in SoMa", confidence: 0.7, importance: 0.5, origin: "extracted" }, src);
  const read = new MemoryLog(join(dir, "memory.jsonl")).read();
  assert.equal(read.skipped, 1);
  assert.equal(read.rows.length, 2);
  assert.equal(replay(read.rows).items.size, 2);
});

test("log: across 50 mixed ops the file's byte length only grows and no verb rewrites it", () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const path = join(dir, "memory.jsonl");
  let last = 0;
  const live: string[] = [];
  for (let i = 0; i < 50; i++) {
    c.tick(500);
    switch (i % 7) {
      case 0:
      case 1:
        live.push(store.add({ kind: i % 2 ? "fact" : "episode", text: `Kevin did thing number ${i}`, confidence: 0.5, importance: 0.4, origin: "extracted" }, { ...src, at: c.now() }).id);
        break;
      case 2:
        if (live[0]) store.touch(live[0], { ...src, at: c.now() });
        break;
      case 3:
        if (live[1]) store.update(live[1], { text: `Kevin did thing number ${i} again` });
        break;
      case 4:
        if (live[0]) store.forget(live[0], "cli");
        break;
      case 5:
        if (live[0]) store.restore(live[0]);
        break;
      case 6:
        if (live.length >= 2) store.archive(live[live.length - 1]!, "cap");
        break;
    }
    const size = statSync(path).size;
    assert.ok(size >= last, `op ${i}: ${size} < ${last}`);
    last = size;
  }
  assert.equal(new MemoryLog(path).read().lines, store.lineCount);
});

test("log: a partial last line (a crash mid-append, no trailing newline) costs that one line — the next append starts on a fresh line and its row replays", () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const a = store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  const path = join(dir, "memory.jsonl");
  appendFileSync(path, '{"at":1,"op":"add","item":{"id":"m_torn","kind":"fa'); // torn: no newline
  const before = statSync(path).size;
  const b = store.add({ kind: "fact", text: "Kevin's office is in SoMa", confidence: 0.7, importance: 0.5, origin: "extracted" }, src);
  assert.ok(statSync(path).size > before);
  const read = new MemoryLog(path).read();
  assert.equal(read.skipped, 1, "the torn line alone is lost");
  assert.deepEqual(read.rows.filter((r) => r.op === "add").map((r) => (r.op === "add" ? r.item.id : "")), [a.id, b.id], "the row after the tear is intact");
  assert.equal(replay(read.rows).items.size, 2);
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\n"));
  assert.equal(text.split("\n").filter(Boolean).length, 3, "one healing newline, no blank lines");
  // a reload of the same file sees the same three lines and heals nothing twice
  const again = new MemoryStore({ dir, now: c.now, newId: ids("n") });
  again.load();
  assert.equal(again.replayed, true, "index.json counts 2 lines, the file has 3 (the torn one): replay wins");
  assert.deepEqual(again.items("all"), store.items("all"));
  again.add({ kind: "fact", text: "Kevin prefers short answers", confidence: 0.7, importance: 0.6, origin: "extracted" }, src);
  assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 4);
  // a foreign writer that ends its line properly needs no healing either
  appendFileSync(path, `${JSON.stringify({ at: 2, op: "exclude", from: 1, to: 2 })}\n`);
  again.add({ kind: "fact", text: "Kevin likes jazz", confidence: 0.7, importance: 0.6, origin: "extracted" }, src);
  const final = readFileSync(path, "utf8");
  assert.ok(!/\n\n/.test(final), "no blank line was inserted after a complete foreign line");
  assert.equal(new MemoryLog(path).read().skipped, 1);
});
