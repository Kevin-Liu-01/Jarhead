import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow, TranscriptItem } from "@jarhead/protocol";
import { candidates, lastClause, mineMisses, renderMisses, stripFillers } from "../reflex-miss.ts";

/**
 * The reflex miner: fillers and tags come off the head, the last clause is what is
 * judged, hits (whole or tail) are dropped, long clauses are dropped, and the misses
 * group by head word with counts — the shapes the speed reader found in Kevin's ledger,
 * anonymised.
 */

const heard = (text: string, at = 1000, final = true): LedgerRow => ({ at, type: "heard", item: { id: `h${at}`, speaker: "kevin", text, startMs: 0, endMs: 1, at, final } as TranscriptItem });
const request = (text: string, at = 2000): LedgerRow => ({ at, type: "delegation.created", delegation: { id: `d${at}`, liveId: "l", createdAt: at, offsetMs: 0, request: text, status: "running", steps: [], timings: { delegatedAt: at } } });

test("stripFillers: stacked fillers and bracketed tags come off the head; 'right click' keeps its right", () => {
  assert.equal(stripFillers("um, okay, so scroll down"), "scroll down");
  assert.equal(stripFillers("[chuckle] yeah press enter"), "press enter");
  assert.equal(stripFillers("Oh awesome. Great, nice, open safari"), "open safari");
  assert.equal(stripFillers("right click save"), "right click save");
  assert.equal(stripFillers("   "), "");
});

test("lastClause: the sentence after the last full stop, or the words after a trailing 'then'", () => {
  assert.equal(lastClause("yeah okay. jarhead, scroll down."), "jarhead, scroll down");
  assert.equal(lastClause("open slack and then type hi"), "type hi");
  assert.equal(lastClause("find the invoice, then open it"), "open it");
  assert.equal(lastClause("what time is it?"), "what time is it");
});

test("mineMisses: hits are dropped whether the whole utterance or its tail parses; long clauses are dropped; the rest group by head word with counts and examples", () => {
  // A stand-in grammar: only "scroll down" and "open <app>" parse.
  const parse = (u: string): unknown => (/^(scroll down|open [a-z]+)$/.test(u) ? { kind: "hit" } : undefined);
  const rows: LedgerRow[] = [
    heard("um, okay, scroll down", 1), // a hit after stripping → not a miss
    heard("yeah okay. jarhead, open safari.", 2), // tail hit → not a miss
    heard("play the music", 3),
    heard("pause the music", 4),
    heard("[chuckle] play the music", 5), // same clause twice
    heard("can you please minimize this window", 6),
    request("what time is it", 7),
    heard("could you go through my inbox and archive everything older than a week from the recruiters", 8), // > 8 words → dropped
    heard("jarhead", 9, false), // not final → ignored
  ];
  assert.equal(candidates(rows).length, 8, "finals and requests are candidates; the open fragment is not");
  const groups = mineMisses(rows, { parse });
  assert.deepEqual(
    groups.map((g) => [g.head, g.n, g.examples.map((e) => `${e.n}×${e.clause}`)]),
    [
      ["play", 2, ["2×play the music"]],
      ["minimize", 1, ["1×minimize this window"]],
      ["pause", 1, ["1×pause the music"]],
      ["what", 1, ["1×what time is it"]],
    ],
  );
  const lines = renderMisses(["2026-09-12"], groups);
  assert.match(lines[0] ?? "", /5 short clauses the grammar did not catch, in 4 groups/);
  assert.ok(lines.some((l) => /play\s+×\s+2/.test(l)));
  assert.ok(lines.some((l) => l.includes('×2 "play the music"')));
  assert.match(lines[lines.length - 1] ?? "", /never a destructive verb/);
});

test("mineMisses: with the real grammar, today's one-step rows are hits and Kevin's real shapes are misses", () => {
  // A description ("draft a reply to ben") is never a reflex; the bare status question has no live thread name here.
  const rows: LedgerRow[] = [heard("um, scroll down please", 1), heard("okay press enter", 2), heard("yeah, what is spotify doing", 3), heard("hmm, draft a reply to ben", 4)];
  const groups = mineMisses(rows);
  assert.deepEqual(groups.map((g) => g.head).sort(), ["draft", "what"], "the grammar's own rows are not misses; the status question and the description are");
  assert.deepEqual(renderMisses([], []).slice(0, 2), ["  reflex misses over the given rows: 0 short clauses the grammar did not catch, in 0 groups", "  nothing to add: every short clause parsed (or there were none)"]);
});
