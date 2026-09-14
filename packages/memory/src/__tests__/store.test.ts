import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeEmbedder } from "../embed/embedder.ts";
import { MemoryStore } from "../store.ts";
import { clock, fresh, ids, T0 } from "./helpers.ts";

/**
 * index.json is a cache: written atomically, trusted only while its line count
 * matches the log, replayed from the log when stale or corrupt. The caps hold
 * at the store's door; vectors join items through the cache by sha and never
 * cross spaces.
 */

const src = { at: T0, type: "heard" as const, sessionId: "A" };

function seeded(dir: string): MemoryStore {
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  c.tick(10);
  store.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.7, importance: 0.6, origin: "extracted" }, src);
  store.setWatermark("A", T0 + 80_000, "rules", { added: 2, updated: 0, noop: 0, refused: 1 });
  store.exclude(T0 + 60_000, T0 + 70_000, "A");
  store.flush();
  return store;
}

test("store: index.json is written by tmp + rename (no .tmp survives) and a fresh load uses it without replaying", () => {
  const dir = fresh();
  const store = seeded(dir);
  assert.ok(existsSync(join(dir, "index.json")));
  assert.ok(!existsSync(join(dir, "index.json.tmp")));
  assert.deepEqual(readdirSync(dir).sort(), ["index.json", "memory.jsonl"]);
  const again = new MemoryStore({ dir, now: () => T0, newId: ids() });
  again.load();
  assert.equal(again.replayed, false);
  assert.deepEqual(again.items("all"), store.items("all"));
  assert.deepEqual(again.watermark("A"), store.watermark("A"));
  assert.deepEqual(again.exclusions(), [{ from: T0 + 60_000, to: T0 + 70_000, sessionId: "A" }]);
});

test("store: a leftover index.json.tmp is ignored; a stale index (line count ≠ log) and a corrupt one are replayed from the log, silently", () => {
  const dir = fresh();
  const store = seeded(dir);
  writeFileSync(join(dir, "index.json.tmp"), "garbage");
  // stale: a row appended by a process that never flushed
  store.add({ kind: "place", text: "Kevin's office is in SoMa", confidence: 0.7, importance: 0.5, origin: "extracted" }, src);
  const stale = new MemoryStore({ dir, now: () => T0, newId: ids() });
  stale.load();
  assert.equal(stale.replayed, true);
  assert.equal(stale.items("live").length, 3);
  assert.deepEqual(stale.items("all"), store.items("all"));
  // corrupt: bytes that are not JSON
  writeFileSync(join(dir, "index.json"), "{corrupt");
  const corrupt = new MemoryStore({ dir, now: () => T0, newId: ids() });
  corrupt.load();
  assert.equal(corrupt.replayed, true);
  assert.deepEqual(corrupt.items("all"), store.items("all"));
  // corrupt but valid JSON of the wrong shape
  writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 2, items: "no" }));
  const wrong = new MemoryStore({ dir, now: () => T0, newId: ids() });
  wrong.load();
  assert.equal(wrong.replayed, true);
  assert.equal(wrong.items("live").length, 3);
  // the log was never touched by any of this
  assert.equal(readFileSync(join(dir, "memory.jsonl"), "utf8").split("\n").filter(Boolean).length, store.lineCount);
});

test("store: sources are capped at 8 — the first mention kept, then the newest seven, newest last; subjects at 5 lowercase; text over 200 chars is refused; confidence and importance clamp to 0..1", () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const it = store.add({ kind: "fact", text: "Kevin goes by Kev", subjects: ["Name", "name", "KEV", "a", "b", "c", "d"], confidence: 1.7, importance: -2, origin: "kevin" }, src);
  assert.deepEqual(it.subjects, ["name", "kev", "a", "b", "c"]);
  assert.equal(it.confidence, 1);
  assert.equal(it.importance, 0);
  for (let i = 1; i <= 10; i++) {
    c.tick(1000);
    store.touch(it.id, { at: T0 + i * 1000, type: "heard", sessionId: "A" });
  }
  const after = store.get(it.id)!;
  assert.equal(after.sources.length, 8);
  assert.equal(after.sources[7]?.at, T0 + 10_000, "newest last");
  assert.equal(after.sources[0]?.at, T0, "the first mention is never dropped (an episode is dated by it)");
  assert.equal(after.sources[1]?.at, T0 + 4000, "the middle drops first: the newest seven follow the first");
  assert.equal(after.seenCount, 11);
  assert.throws(() => store.add({ kind: "fact", text: "x".repeat(201), confidence: 0.5, importance: 0.5, origin: "extracted" }, src), RangeError);
  assert.throws(() => store.update(it.id, { text: "y".repeat(201) }), RangeError);
  assert.throws(() => store.add({ kind: "fact", text: "   ", confidence: 0.5, importance: 0.5, origin: "extracted" }, src), RangeError);
});

test("store: forget/restore/archive are states with rules (a merged item cannot be forgotten; only forgotten or archived restore); counts follow", () => {
  const dir = fresh();
  const store = new MemoryStore({ dir, now: () => T0, newId: ids() });
  store.load();
  const a = store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  const b = store.add({ kind: "fact", text: "Kevin goes by Kev.", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  assert.equal(store.restore(a.id), undefined, "a live item has nothing to restore");
  store.merge(a.id, b.id, false);
  assert.equal(store.get(a.id)?.state, "merged");
  assert.equal(store.get(b.id)?.seenCount, 1, "a supersession does not fold evidence");
  assert.equal(store.forget(a.id, "kevin"), undefined);
  store.archive(b.id, "cap");
  assert.equal(store.get(b.id)?.state, "archived");
  assert.ok(store.forget(b.id, "cli"), "an archived item can still be forgotten");
  assert.ok(store.restore(b.id));
  assert.deepEqual(store.counts(), { live: 1, forgotten: 0, archived: 0, merged: 1 });
});

test("store: embed() goes through embeddings.jsonl — misses hit the embedder once, hits never do; vectors are keyed by model and dims so a different embedder sees none", async () => {
  const dir = fresh();
  const store = new MemoryStore({ dir, now: () => T0, newId: ids() });
  store.load();
  const e = new FakeEmbedder({ dims: 8 });
  const texts = ["Kevin goes by Kev", "Kevin prefers short answers", "Kevin goes by Kev"];
  const first = await store.embed(e, texts);
  assert.equal(e.calls.length, 1);
  assert.deepEqual(e.calls[0], ["Kevin goes by Kev", "Kevin prefers short answers"], "duplicates within a batch embed once");
  assert.equal(first.length, 3);
  assert.equal(first[0]!.length, 8);
  const second = await store.embed(e, ["kevin goes by kev.", "Kevin prefers short answers"]);
  assert.equal(e.calls.length, 1, "case, whitespace and trailing punctuation share a sha");
  assert.deepEqual([...second[0]!], [...first[0]!]);
  const it = store.add({ kind: "fact", text: "Kevin goes by Kev", confidence: 0.9, importance: 1, origin: "kevin" }, src);
  assert.ok(store.vectorFor(it.id, e));
  const other = new FakeEmbedder({ dims: 16 });
  assert.equal(store.vectorFor(it.id, other), undefined, "never a vector from another space");
  const reloaded = new MemoryStore({ dir, now: () => T0, newId: ids() });
  reloaded.load();
  assert.deepEqual([...reloaded.vectorFor(it.id, e)!], [...first[0]!], "the cache round-trips through base64 exactly");
  assert.equal(reloaded.cache.size, 2);
});

test("store: 200 mixed ops — memory.jsonl and embeddings.jsonl byte lengths only grow, nothing is unlinked, and the final state replays", async () => {
  const dir = fresh();
  const c = clock();
  const store = new MemoryStore({ dir, now: c.now, newId: ids() });
  store.load();
  const e = new FakeEmbedder({ dims: 8 });
  const logPath = join(dir, "memory.jsonl");
  const embPath = join(dir, "embeddings.jsonl");
  let lastLog = 0;
  let lastEmb = 0;
  const all: string[] = [];
  for (let i = 0; i < 200; i++) {
    c.tick(250);
    const kind = (["fact", "preference", "episode", "procedure", "contact", "place"] as const)[i % 6]!;
    switch (i % 9) {
      case 0:
      case 1:
      case 2: {
        const text = `Kevin ${kind} number ${i}`;
        await store.embed(e, [text]);
        all.push(store.add({ kind, text, confidence: 0.5, importance: (i % 5) / 4, origin: "extracted" }, { ...src, at: c.now() }).id);
        break;
      }
      case 3:
        store.touch(all[i % all.length]!, { ...src, at: c.now() });
        break;
      case 4:
        store.update(all[i % all.length]!, { text: `Kevin ${kind} number ${i} revised`, confidence: 0.6 }, { ...src, at: c.now() });
        break;
      case 5:
        store.forget(all[i % all.length]!, i % 2 ? "kevin" : "reflex");
        break;
      case 6:
        store.restore(all[i % all.length]!);
        break;
      case 7:
        if (all.length > 3) store.merge(all[(i + 1) % all.length]!, all[(i + 2) % all.length]!, i % 2 === 0);
        break;
      case 8:
        store.archive(all[i % all.length]!, i % 2 ? "decay" : "cap");
        if (i % 4 === 0) store.flush();
        break;
    }
    const l = statSync(logPath).size;
    const em = existsSync(embPath) ? statSync(embPath).size : 0;
    assert.ok(l >= lastLog, `op ${i}: log shrank ${lastLog} → ${l}`);
    assert.ok(em >= lastEmb, `op ${i}: embeddings shrank ${lastEmb} → ${em}`);
    lastLog = l;
    lastEmb = em;
  }
  assert.ok(existsSync(logPath) && existsSync(embPath));
  const again = new MemoryStore({ dir, now: c.now, newId: ids() });
  again.load();
  assert.equal(again.replayed, true, "the last flush is behind the log, so the log wins");
  assert.deepEqual(again.items("all"), store.items("all"));
});
