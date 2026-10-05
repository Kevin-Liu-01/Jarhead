import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryItem } from "@jarhead/protocol";
import { KeywordEmbedder } from "../embed/keyword.ts";
import { FakeEmbedder } from "../embed/embedder.ts";
import { RulesExtractor } from "../extract/rules.ts";
import { MemoryService } from "../service.ts";
import { MemoryStore } from "../store.ts";
import { replay } from "../log.ts";
import type { Decision } from "../types.ts";
import { clock, fresh, ids, item, redactFake } from "./helpers.ts";

/**
 * W2-3: a Forget pressed while a merge waits on the decider stays a Forget (LM-7), a search can
 * rank by words with no embedding call (LM-3), and the sessions in the Trash hide what was
 * learned only from them, nothing deleted (D5).
 */

const quiet = { info: () => undefined, warn: () => undefined };

/** A decider the test holds: it answers when `release` is called. */
function heldDecider(): { decider: { kind: "responses"; decide: () => Promise<Decision> }; release: (d: Decision) => void; asked: () => number } {
  let release: ((d: Decision) => void) | undefined;
  let asked = 0;
  return {
    decider: {
      kind: "responses",
      decide: () => {
        asked++;
        return new Promise<Decision>((r) => {
          release = r;
        });
      },
    },
    release: (d) => release?.(d),
    asked: () => asked,
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

for (const [label, decision] of [
  ["a contradiction", (target: string): Decision => ({ op: "ADD", contradicts: true, target })],
  ["an update", (target: string): Decision => ({ op: "UPDATE", target, text: "Kevin prefers light mode in every code editor" })],
  ["a noop", (target: string): Decision => ({ op: "NOOP", target })],
] as const) {
  test(`LM-7: Forget pressed while ${label} waits on the decider still restores; the candidate lands as a plain add`, async () => {
    const held = heldDecider();
    const c = clock();
    const svc = new MemoryService({ dir: fresh(), now: () => (c.tick(1000), c.now()), embedder: new KeywordEmbedder(), extractor: new RulesExtractor(), decider: held.decider, redact: (s) => s, newId: ids(), log: quiet });
    const first = await svc.remember("Kevin prefers dark mode in every code editor", "preference");
    assert.ok(first);
    const id = first.item.id;
    const pending = svc.remember("Kevin prefers light mode in every code editor", "preference");
    await until(() => held.asked() > 0);
    assert.equal(held.asked(), 1, "the decider was asked about the neighbour");
    assert.equal(svc.forget(id, "kevin"), true);
    held.release(decision(id));
    const r = await pending;
    const old = svc.store.get(id)!;
    assert.equal(old.state, "forgotten", "the Forget holds");
    assert.equal(old.text, "Kevin prefers dark mode in every code editor", "the forgotten words are not rewritten");
    assert.equal(old.seenCount, 1, "nor counted again");
    assert.equal(r?.op, "added");
    assert.notEqual(r?.item.id, id);
    assert.equal(r?.item.supersedes, undefined, "a plain add: it supersedes nothing");
    assert.equal(svc.restore(id), true, "Restore brings it back");
    assert.equal(svc.store.get(id)?.state, "live");
  });
}

test("LM-7: store.merge is a no-op on an item that is not live", () => {
  const c = clock();
  const store = new MemoryStore({ dir: fresh(), now: c.now, newId: ids() });
  store.load();
  const a = store.add({ kind: "fact", text: "Kevin lives in Oakland", confidence: 0.8, importance: 0.5, origin: "extracted" }, { at: c.now(), type: "heard" });
  const b = store.add({ kind: "fact", text: "Kevin lives in Berkeley", confidence: 0.8, importance: 0.5, origin: "extracted" }, { at: c.now(), type: "heard" });
  store.forget(a.id, "kevin");
  const lines = store.lineCount;
  store.merge(a.id, b.id, false);
  assert.equal(store.lineCount, lines, "no row");
  assert.equal(store.get(a.id)?.state, "forgotten");
  assert.ok(store.restore(a.id));
});

test("LM-7: a merge row a log already holds for an item that was not live applies to nothing on replay, so Restore finds its item", () => {
  const at = 1_790_000_000_000;
  const a = item({ id: "m_a", text: "Kevin prefers dark mode", createdAt: at });
  const b = item({ id: "m_b", text: "Kevin prefers light mode", createdAt: at + 2 });
  const state = replay([
    { at, op: "add", item: a },
    { at: at + 1, op: "forget", id: a.id, by: "kevin" },
    { at: at + 2, op: "add", item: b },
    { at: at + 3, op: "merge", id: a.id, into: b.id, fold: false },
  ]);
  assert.equal(state.items.get(a.id)?.state, "forgotten");
  assert.equal(state.items.get(a.id)?.mergedInto, undefined);
});

test("LM-3: search with vectors off ranks by words and never calls the embedder", async () => {
  const embedder = new FakeEmbedder();
  const c = clock();
  const svc = new MemoryService({ dir: fresh(), now: c.now, embedder, extractor: new RulesExtractor(), redact: redactFake, newId: ids(), log: quiet });
  await svc.remember("Kevin's sister lives on Alder Street", "fact");
  const before = embedder.calls.length;
  const hits = await svc.search("sister's street", 10, "live", { vectors: false });
  assert.equal(embedder.calls.length, before, "no embedding call");
  assert.equal(hits.length, 1);
  await svc.search("sister's street", 10);
  assert.equal(embedder.calls.length, before + 1, "with vectors on, the query is embedded");
});

test("D5: items learned only from sessions in the Trash leave every read; one also seen elsewhere, or said by Kevin, stays; nothing is written", async () => {
  const c = clock();
  const svc = new MemoryService({ dir: fresh(), now: c.now, embedder: new KeywordEmbedder(), extractor: new RulesExtractor(), redact: redactFake, newId: ids(), log: quiet });
  const at = c.now();
  const only = svc.store.add({ kind: "preference", text: "Kevin prefers short answers", confidence: 0.9, importance: 0.8, origin: "extracted" }, { sessionId: "T", at, type: "heard" });
  const both = svc.store.add({ kind: "fact", text: "Kevin's dentist is Dr. Patel", confidence: 0.9, importance: 0.8, origin: "extracted" }, { sessionId: "T", at, type: "heard" });
  svc.store.touch(both.id, { sessionId: "K", at: at + 1, type: "heard" });
  const said = svc.store.add({ kind: "fact", text: "Kevin's car is a blue Civic", confidence: 0.9, importance: 0.8, origin: "kevin" }, { at, type: "kevin" });
  svc.flush();
  const lines = svc.store.lineCount;
  const hidden: ReadonlySet<string> = new Set(["T"]);
  const idsOf = (items: readonly MemoryItem[]): string[] => items.map((i) => i.id).sort();

  assert.deepEqual(idsOf(svc.list("live", 50, { hidden })), [both.id, said.id].sort());
  assert.deepEqual(idsOf(svc.list("all", 50, { hidden })), [only.id, both.id, said.id].sort(), "the record still holds it");
  assert.equal(svc.summary({ hidden }).count, 2);
  assert.ok(!(await svc.search("short answers", 10, "live", { hidden })).some((i) => i.id === only.id));
  assert.ok(!(await svc.retrieveForBrain("how should you answer me", { hidden })).ids.includes(only.id));
  assert.ok(!svc.retrieveForVoice({ hidden }).ids.includes(only.id));
  assert.equal(svc.store.lineCount, lines, "hiding writes nothing");

  // Restore: the Trash no longer holds the session, and the item is back everywhere.
  const none: ReadonlySet<string> = new Set();
  assert.ok(svc.list("live", 50, { hidden: none }).some((i) => i.id === only.id));
  assert.ok((await svc.retrieveForBrain("how should you answer me", { hidden: none })).ids.includes(only.id));
  assert.ok(svc.retrieveForVoice({ hidden: none }).ids.includes(only.id));
  assert.equal(svc.store.get(only.id)?.state, "live");
});
