import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, Trash } from "@jarhead/core";
import type { LedgerRow, MemoryItem } from "@jarhead/protocol";
import { KeywordEmbedder } from "../embed/keyword.ts";
import { buildExtractInput } from "../extract/input.ts";
import { FakeEmbedder } from "../embed/embedder.ts";
import { RulesExtractor } from "../extract/rules.ts";
import { MemoryService } from "../service.ts";
import { MemoryStore } from "../store.ts";
import { replay } from "../log.ts";
import type { Decision } from "../types.ts";
import { clock, fresh, ids, item, redactFake } from "./helpers.ts";

/**
 * W2-3: a Forget (or an Edit) pressed while a merge waits on the decider stays what Kevin made
 * it (LM-7), a search can rank by words with no embedding call (LM-3), the sessions in the Trash
 * hide what was learned only from them, nothing deleted (D5), and a Now clear the ledger carried
 * out of a moved day hides what it hid, no more (LM-5).
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

for (const [label, decision] of [
  ["an update", (target: string): Decision => ({ op: "UPDATE", target, text: "Kevin prefers light mode in every code editor" })],
  ["a contradiction", (target: string): Decision => ({ op: "ADD", contradicts: true, target })],
] as const) {
  test(`LM-7: an Edit pressed while ${label} waits on the decider keeps Kevin's words; the candidate lands as a plain add`, async () => {
    const held = heldDecider();
    const c = clock();
    const svc = new MemoryService({ dir: fresh(), now: () => (c.tick(1000), c.now()), embedder: new KeywordEmbedder(), extractor: new RulesExtractor(), decider: held.decider, redact: (s) => s, newId: ids(), log: quiet });
    const first = await svc.remember("Kevin prefers dark mode in every code editor", "preference");
    assert.ok(first);
    const id = first.item.id;
    const pending = svc.remember("Kevin prefers light mode in every code editor", "preference");
    await until(() => held.asked() > 0);
    assert.equal(svc.edit(id, "Kevin prefers dark mode in Xcode only"), true);
    held.release(decision(id));
    const r = await pending;
    const mine = svc.store.get(id)!;
    assert.equal(mine.state, "live");
    assert.equal(mine.text, "Kevin prefers dark mode in Xcode only", "the decision judged the old words; it does not land on the new ones");
    assert.equal(r?.op, "added");
    assert.notEqual(r?.item.id, id);
    assert.equal(r?.item.supersedes, undefined);
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

// ------------------------------------------------------------------- LM-5, carried Now rows

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 4, 12).getTime();
const noRefusal = { redact: (t: string) => t, refuse: (): undefined => undefined };
const kevin = (at: number, text: string): LedgerRow => ({ at, type: "heard", item: { id: `h${at}`, speaker: "kevin", text, startMs: 0, endMs: 900, at, final: true } });
function sessionRows(ledger: Ledger, id: string, at: number, lines: readonly string[], resumedFrom?: string): void {
  ledger.append({ at, type: "session.started", sessionId: id, voice: "ballad", ...(resumedFrom ? { resumedFrom } : {}) } as LedgerRow);
  lines.forEach((text, i) => ledger.append(kevin(at + 1000 + i, text)));
  ledger.append({ at: at + 60_000, type: "session.closed", sessionId: id, reason: "close_requested", usageSeconds: 60 });
}

test("LM-5: a carried Now clear hides what the clear hid, not what Kevin said after it (memory reads the decision's time)", () => {
  // The review's repro: S1 cleared on D-4, S2 resumes S1 on D-3 with four lines, D-4 moves.
  const dir = fresh();
  const ledger = new Ledger(dir);
  sessionRows(ledger, "S1", NOW - 5 * DAY, ["an old line before the clear"]);
  sessionRows(ledger, "X", NOW - 4 * DAY, []);
  const clearedAt = NOW - 4 * DAY + 3_600_000;
  ledger.append({ at: clearedAt, type: "now.cleared", sessionId: "S1" });
  sessionRows(ledger, "S2", NOW - 3 * DAY, [0, 1, 2, 3].map((i) => `I prefer green tea in the morning ${i}`), "S1");
  const lines = (): string[] => buildExtractInput(ledger.readChain("S1").rows, noRefusal).lines.map((l) => l.text);
  assert.equal(lines().length, 4, "before the move: S2's four lines; the clear hides S1's");
  assert.equal(new Trash(dir, ledger, { now: () => NOW }).moveDay(Ledger.dayFor(clearedAt), "ledger", "kevin").ok, true);
  assert.equal(ledger.nowClearedAt("S1"), clearedAt);
  assert.deepEqual(lines(), [0, 1, 2, 3].map((i) => `I prefer green tea in the morning ${i}`), "after: the same four, and S1's line stays hidden");
});

test("LM-5: a carried Now restore does not undo a later clear in the same conversation", () => {
  const dir = fresh();
  const ledger = new Ledger(dir);
  sessionRows(ledger, "S1", NOW - 6 * DAY, ["first line"]);
  sessionRows(ledger, "X", NOW - 5 * DAY, []);
  ledger.append({ at: NOW - 5 * DAY + 3_600_000, type: "now.cleared", sessionId: "S1" });
  ledger.append({ at: NOW - 5 * DAY + 3_600_001, type: "now.restored", sessionId: "S1" });
  sessionRows(ledger, "S2", NOW - 3 * DAY, ["a line Kevin cleared"], "S1");
  ledger.append({ at: NOW - 3 * DAY + 120_000, type: "now.cleared", sessionId: "S2" });
  sessionRows(ledger, "S3", NOW - 2 * DAY, ["a line after the clear"], "S2");
  const lines = (): string[] => buildExtractInput(ledger.readChain("S1").rows, noRefusal).lines.map((l) => l.text);
  assert.deepEqual(lines(), ["a line after the clear"]);
  // S1's restore is carried (stamped now); it was decided before S2's clear and must not lift it.
  assert.equal(new Trash(dir, ledger, { now: () => NOW }).moveDay(Ledger.dayFor(NOW - 5 * DAY), "ledger", "kevin").ok, true);
  assert.ok(ledger.read(NOW).some((r) => r.type === "now.restored" && (r as { carried?: unknown }).carried === true));
  assert.deepEqual(lines(), ["a line after the clear"]);
});
