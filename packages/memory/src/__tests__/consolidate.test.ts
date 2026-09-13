import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate } from "../consolidate.ts";
import { FakeEmbedder } from "../embed/embedder.ts";
import { EmbedError } from "../embed/openai.ts";
import { LIVE_CAP } from "../limits.ts";
import { MemoryStore } from "../store.ts";
import { atCosine, clock, fresh, ids, T0 } from "./helpers.ts";

/**
 * Housekeeping without deletion: near-duplicates fold older → newer with
 * evidence combined, stale trivia archives, the cap archives episodes first,
 * pair checks are chunked, and vector-less items get a vector when the
 * embedder is back.
 */

const DAY = 86_400_000;
const src = { at: T0, type: "heard" as const, sessionId: "A" };

test("consolidate: two live items of one kind at ≥ dup fold older → newer (state merged, mergedInto, sources union, seenCount summed); below dup nothing happens; the log only grows", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  // dark mode ↔ everywhere at 0.94; the editor sits at 0.90 from dark mode and 0.70 from everywhere (the other side of the plane)
  const e = new FakeEmbedder({ table: { "Kevin prefers dark mode": atCosine(1), "Kevin prefers dark mode everywhere": atCosine(0.94), "Kevin prefers a dark editor": [0.9, -Math.sqrt(1 - 0.81), 0] } });
  await store.embed(e, ["Kevin prefers dark mode", "Kevin prefers dark mode everywhere", "Kevin prefers a dark editor"]);
  const older = store.add({ kind: "preference", text: "Kevin prefers dark mode", confidence: 0.6, importance: 0.5, origin: "extracted" }, { ...src, at: T0 });
  c.tick(1000);
  const newer = store.add({ kind: "preference", text: "Kevin prefers dark mode everywhere", confidence: 0.7, importance: 0.8, origin: "extracted" }, { ...src, at: T0 + 1000 });
  const apart = store.add({ kind: "preference", text: "Kevin prefers a dark editor", confidence: 0.7, importance: 0.5, origin: "extracted" }, src);
  const lines = store.lineCount;
  const r = await consolidate(store, e, c.now());
  assert.equal(r.merged, 1);
  assert.equal(r.done, true);
  assert.equal(store.get(older.id)!.state, "merged");
  assert.equal(store.get(older.id)!.mergedInto, newer.id);
  const kept = store.get(newer.id)!;
  assert.equal(kept.seenCount, 2);
  assert.deepEqual(kept.sources.map((s) => s.at), [T0, T0 + 1000]);
  assert.ok(kept.confidence > 0.7);
  assert.equal(store.get(apart.id)!.state, "live", "0.90 is under the 0.93 dup threshold");
  assert.ok(store.lineCount > lines, "merge and consolidated rows appended");
  assert.equal(store.consolidatedAt, c.now());
  const again = await consolidate(store, e, c.now());
  assert.equal(again.merged, 0);
  assert.equal(again.pairs, 0, "nothing fresh since the last pass: no pairs to check");
});

test("consolidate: an episode of importance 0.3 seen once and 91 days old is archived (decay); a 95-day preference and a seen-twice episode are not; archived items restore", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const e = new FakeEmbedder();
  const stale = store.add({ kind: "episode", text: "Kevin fixed the printer", confidence: 0.6, importance: 0.3, origin: "extracted" }, src);
  const pref = store.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.6, importance: 0.3, origin: "extracted" }, src);
  const seen = store.add({ kind: "episode", text: "Kevin moved desks", confidence: 0.6, importance: 0.3, origin: "extracted" }, src);
  store.touch(seen.id, { ...src, at: T0 + 1 });
  c.tick(95 * DAY);
  const r = await consolidate(store, e, c.now(), { embedMissing: false });
  assert.equal(r.archived, 1);
  assert.equal(store.get(stale.id)!.state, "archived");
  assert.equal(store.get(pref.id)!.state, "live");
  assert.equal(store.get(seen.id)!.state, "live");
  assert.ok(store.restore(stale.id));
  assert.equal(store.get(stale.id)!.state, "live");
});

test("consolidate: above LIVE_CAP the lowest-scored episodes are archived first ('cap'), pinned preferences never; maxPairs chunks a pass (done:false with a cursor, then done:true)", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const e = new FakeEmbedder();
  const pin = store.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.9, importance: 0.9, origin: "kevin" }, src);
  const facts: string[] = [];
  // distinct word tokens (f0, e12): single characters are not tokens, so bare digits would make twins
  for (let i = 0; i < 20; i++) facts.push(store.add({ kind: "fact", text: `Kevin's fact f${i} about his world`, confidence: 0.9, importance: 0.9, origin: "extracted" }, src).id);
  for (let i = 0; i < LIVE_CAP - 15; i++) store.add({ kind: "episode", text: `Kevin did episode e${i} that day`, confidence: 0.5, importance: i < 10 ? 0.1 : 0.6, origin: "extracted" }, src);
  const before = store.items("live").length;
  assert.ok(before > LIVE_CAP);
  let r = await consolidate(store, e, c.now(), { maxPairs: 200, embedMissing: false });
  assert.equal(r.done, false);
  assert.ok(r.pairs <= 200 && r.cursor > 0, "a slice of 200 pair checks, cursor handed back");
  let calls = 1;
  while (!r.done) {
    assert.ok(r.pairs <= 50_000);
    r = await consolidate(store, e, c.now(), { maxPairs: 50_000, cursor: r.cursor, embedMissing: false });
    calls++;
  }
  assert.ok(calls > 1, "a fresh store of two thousand items takes more than one slice");
  assert.equal(store.items("live").length, LIVE_CAP);
  assert.equal(store.get(pin.id)!.state, "live");
  assert.ok(facts.every((id) => store.get(id)!.state === "live"), "episodes go before facts");
  const archived = store.items("archived");
  assert.equal(archived.length, before - LIVE_CAP);
  assert.ok(archived.every((it) => it.kind === "episode" && it.importance === 0.1), "the least important episodes went first");
  assert.equal(store.items("all").length, before, "nothing left the record");
});

test("consolidate: items that landed without a vector are embedded when the embedder is back (embedded count), and a failing embedder is tolerated", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  let broken = true;
  const e = new FakeEmbedder({ fail: () => (broken ? new EmbedError("http", "503", 503) : undefined) });
  const a = store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  assert.equal(store.vectorFor(a.id, e), undefined);
  const r1 = await consolidate(store, e, c.now());
  assert.equal(r1.embedded, 0);
  assert.equal(r1.done, true);
  broken = false;
  store.touch(a.id, { ...src, at: c.now() + 1 });
  const r2 = await consolidate(store, e, c.now() + 2);
  assert.equal(r2.embedded, 1);
  assert.ok(store.vectorFor(a.id, e));
});

test("consolidate: with nothing fresh, nothing to fold, decay or embed, a pass writes nothing — five idle calls append zero rows", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const e = new FakeEmbedder();
  await store.embed(e, ["Kevin likes jazz while coding", "Kevin prefers short answers"]);
  store.add({ kind: "preference", text: "Kevin likes jazz while coding", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  store.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.7, importance: 0.6, origin: "extracted" }, src);
  c.tick(1000);
  const first = await consolidate(store, e, c.now());
  assert.equal(first.done, true);
  assert.equal(first.wrote, true, "two fresh items were checked: a real pass, one row");
  assert.equal(first.pairs, 1);
  const lines = store.lineCount;
  const bytes = store.bytes().log;
  for (let i = 0; i < 5; i++) {
    c.tick(60_000);
    const r = await consolidate(store, e, c.now());
    assert.deepEqual(r, { merged: 0, archived: 0, embedded: 0, pairs: 0, done: true, cursor: 0, wrote: false });
  }
  assert.equal(store.lineCount, lines, "no consolidated row for a no-op");
  assert.equal(store.bytes().log, bytes);
  assert.equal(store.log.read().rows.filter((r) => r.op === "consolidated").length, 1);
  // a touch makes one item fresh again: the next call is a real pass
  store.touch(store.items("live")[0]!.id, { ...src, at: c.now() });
  const again = await consolidate(store, e, c.now() + 1);
  assert.equal(again.wrote, true);
  assert.equal(again.pairs, 1);
});

test("consolidate: a fold between two items compared by words (never embedded) uses the keyword dup threshold, not the cosine one", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const e = new FakeEmbedder(); // openai dup 0.93; keyword dup 0.70
  // {like, dark, mode} vs {like, dark, mode, everywhere}: Jaccard 0.75 — a fold by words, never at cosine 0.93
  const older = store.add({ kind: "preference", text: "Kevin prefers dark mode", confidence: 0.6, importance: 0.5, origin: "extracted" }, src);
  c.tick(1000);
  const newer = store.add({ kind: "preference", text: "Kevin prefers dark mode everywhere", confidence: 0.7, importance: 0.8, origin: "extracted" }, { ...src, at: c.now() });
  const r = await consolidate(store, e, c.now(), { embedMissing: false });
  assert.equal(r.merged, 1);
  assert.equal(store.get(older.id)!.state, "merged");
  assert.equal(store.get(older.id)!.mergedInto, newer.id);
  // under 0.70 by words stays apart: {like, short, answer} vs {like, short, spoken, answer, only} = 0.6
  const { now } = c;
  const s2 = new MemoryStore({ dir: fresh(), now, newId: ids("k") });
  s2.load();
  s2.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.6, importance: 0.5, origin: "extracted" }, src);
  s2.add({ kind: "preference", text: "Kevin prefers short spoken answers only", confidence: 0.6, importance: 0.5, origin: "extracted" }, src);
  const apart = await consolidate(s2, e, now() + 1, { embedMissing: false });
  assert.equal(apart.merged, 0);
  assert.equal(s2.items("live").length, 2);
});
