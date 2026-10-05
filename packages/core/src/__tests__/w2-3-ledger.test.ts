import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerRow } from "@jarhead/protocol";
import { Ledger, WALK_DAYS } from "../ledger.ts";
import { Trash } from "../trash.ts";

/**
 * W2-3: Kevin's decisions survive the walk's window and the Trash (LM-4, LM-5), and a search
 * over a long history is bounded (LM-9). Every test is a temp state dir with a fixed clock.
 */

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 4, 12).getTime(); // 2026-10-04 noon, local

function fresh(prefix: string): { dir: string; ledger: Ledger } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, ledger: new Ledger(dir) };
}

function session(ledger: Ledger, id: string, at: number, extra: { resumedFrom?: string; heard?: string } = {}): void {
  ledger.append({ at, type: "session.started", sessionId: id, voice: "ballad", ...(extra.resumedFrom ? { resumedFrom: extra.resumedFrom } : {}) } as LedgerRow);
  if (extra.heard) ledger.append({ at: at + 1000, type: "heard", item: { id: `u_${id}`, speaker: "kevin", text: extra.heard, startMs: 0, endMs: 900, at: at + 1000, final: true } });
  ledger.append({ at: at + 60_000, type: "session.closed", sessionId: id, reason: "close_requested", usageSeconds: 60 });
}

/** One short session on each of the last `days` days (the newest file is yesterday). */
function dailyUse(ledger: Ledger, days: number): void {
  for (let d = days; d >= 1; d--) session(ledger, `sess_${d}`, NOW - d * DAY);
}

// ------------------------------------------------------------------------------- LM-4

test("LM-4: a pinned conversation older than the walk's window stays listed, pinned, and its day is never swept", () => {
  const { dir, ledger } = fresh("jh-w23-pin-");
  const old = NOW - 200 * DAY;
  session(ledger, "sess_fav", old, { heard: "the favourite conversation" });
  dailyUse(ledger, 70);
  ledger.append({ at: NOW, type: "conversation.pinned", chainId: "sess_fav", pinned: true });
  assert.ok(ledger.days().length > WALK_DAYS);
  const fav = ledger.sessions().find((s) => s.id === "sess_fav");
  assert.equal(fav?.pinned, true, "the rail's Pinned section still lists it");
  assert.equal(fav?.title, "the favourite conversation");
  assert.equal(ledger.unresolvedConversationRows(), 0, "the pin resolves to its chain");
  assert.ok(ledger.readChain("sess_fav").rows.some((r) => r.type === "heard"), "a pinned conversation still opens");
  const trash = new Trash(dir, ledger, { now: () => NOW });
  const swept = trash.sweep({ ledgerRetentionDays: 90, shotsRetentionDays: 0 });
  assert.ok(swept.refused.some((r) => r.day === Ledger.dayFor(old) && r.reason === "a pinned conversation"));
  assert.ok(existsSync(join(dir, "ledger", `${Ledger.dayFor(old)}.jsonl`)), "the pinned conversation's day stays live");
  // Unpinned, it leaves the rail again (the window bounds the listing) and the next sweep may move it.
  ledger.append({ at: NOW + 1000, type: "conversation.pinned", chainId: "sess_fav", pinned: false });
  assert.equal(ledger.sessions().find((s) => s.id === "sess_fav"), undefined);
  assert.equal(trash.refusal(Ledger.dayFor(old), "ledger"), undefined);
});

test("LM-4: a conversation outside the window that Kevin trashed reads trashed in search, and its id still resolves for the Console's verbs", () => {
  const { ledger } = fresh("jh-w23-old-");
  const old = NOW - 200 * DAY;
  session(ledger, "sess_old", old, { heard: "my landlord is called Morrigan" });
  dailyUse(ledger, 70);
  assert.equal(ledger.chainRootOf("sess_old"), "sess_old", "an old id is a conversation, not 'no such conversation'");
  assert.deepEqual(ledger.search("morrigan").map((h) => [h.sessionId, h.chainId, h.state]), [["sess_old", "sess_old", "active"]]);
  ledger.append({ at: NOW, type: "conversation.trashed", chainId: "sess_old", by: "kevin" });
  assert.equal(ledger.conversation("sess_old")?.state, "trashed");
  assert.deepEqual(ledger.search("morrigan").map((h) => h.state), ["trashed"]);
  assert.equal(ledger.sessions().find((s) => s.id === "sess_old"), undefined, "unpinned and old: not listed");
});

test("LM-4: a chain whose root is older than the window keeps one root; a tombstone on the old root lands on the listed member", () => {
  const { ledger } = fresh("jh-w23-chain-");
  session(ledger, "R", NOW - 100 * DAY);
  dailyUse(ledger, 65);
  session(ledger, "M", NOW - 3 * DAY + 3_600_000, { resumedFrom: "R", heard: "carry on from long ago" });
  assert.equal(ledger.chainRootOf("M"), "R");
  ledger.append({ at: NOW, type: "conversation.archived", chainId: "R" });
  assert.equal(ledger.sessions().find((s) => s.id === "M")?.state, "archived");
  assert.equal(ledger.unresolvedConversationRows(), 0);
});

// ------------------------------------------------------------------------------- LM-5

test("LM-5: retention never moves a pinned conversation, whichever day the pin was pressed", () => {
  const { dir, ledger } = fresh("jh-w23-5a-");
  const convDay = NOW - 40 * DAY;
  const pinDay = NOW - 36 * DAY;
  session(ledger, "sess_fav", convDay);
  session(ledger, "sess_other", pinDay);
  ledger.append({ at: pinDay + 3_600_000, type: "conversation.pinned", chainId: "sess_fav", pinned: true });
  const trash = new Trash(dir, ledger, { now: () => NOW });
  const first = trash.sweep({ ledgerRetentionDays: 30, shotsRetentionDays: 0 });
  assert.deepEqual(first.moved.map((m) => m.day), [Ledger.dayFor(pinDay)]);
  const second = trash.sweep({ ledgerRetentionDays: 30, shotsRetentionDays: 0 });
  assert.deepEqual(second.moved, []);
  assert.ok(existsSync(join(dir, "ledger", `${Ledger.dayFor(convDay)}.jsonl`)), "the pinned conversation stays live");
  assert.equal(ledger.sessions().find((s) => s.id === "sess_fav")?.pinned, true);
});

test("LM-5: moving the day that holds a tombstone does not resurrect the conversation it trashed; the carried row is marked, lands today and keeps the decision's time", () => {
  const { dir, ledger } = fresh("jh-w23-5b-");
  const convDay = NOW - 5 * DAY;
  const actDay = NOW - 2 * DAY;
  session(ledger, "sess_old", convDay);
  session(ledger, "sess_mid", actDay);
  const decided = actDay + 3_600_000;
  ledger.append({ at: decided, type: "conversation.trashed", chainId: "sess_old", by: "kevin" });
  ledger.append({ at: decided + 1, type: "conversation.renamed", chainId: "sess_old", name: "the old plan" });
  const trash = new Trash(dir, ledger, { now: () => NOW });
  const r = trash.moveDay(Ledger.dayFor(actDay), "ledger", "kevin");
  assert.equal(r.ok, true);
  const conv = ledger.conversation("sess_old");
  assert.equal(conv?.state, "trashed", "Kevin's Move to Trash holds");
  assert.equal(conv?.name, "the old plan", "and so does his name for it");
  assert.equal(conv?.trashedAt, decided, "trashed when he trashed it, not when the day moved");
  const today = ledger.read(NOW).filter((row) => row.type.startsWith("conversation."));
  assert.equal(today.length, 2);
  for (const row of today) assert.equal((row as { carried?: unknown }).carried, true);
  // The day comes back: nothing changes, the original rows and the carried ones agree.
  assert.deepEqual(trash.restoreDay(Ledger.dayFor(actDay)).refused, []);
  assert.equal(ledger.conversation("sess_old")?.state, "trashed");
  assert.equal(ledger.conversation("sess_old")?.trashedAt, decided);
});

test("LM-5: a decision no longer in force is not carried; a restore in force is", () => {
  const { dir, ledger } = fresh("jh-w23-5c-");
  session(ledger, "A", NOW - 9 * DAY);
  session(ledger, "x", NOW - 6 * DAY);
  ledger.append({ at: NOW - 6 * DAY + 3_600_000, type: "conversation.trashed", chainId: "A", by: "kevin" });
  session(ledger, "y", NOW - 3 * DAY);
  ledger.append({ at: NOW - 3 * DAY + 3_600_000, type: "conversation.restored", chainId: "A" });
  const trash = new Trash(dir, ledger, { now: () => NOW });
  // The trash row is not in force (the restore is later): moving its day carries nothing.
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 6 * DAY), "ledger", "kevin").ok, true);
  assert.equal(ledger.read(NOW).filter((r) => r.type.startsWith("conversation.")).length, 0);
  assert.equal(ledger.conversation("A")?.state, "active");
  // Moving the restore's day must not let the older trash row (back from the Trash) win.
  assert.deepEqual(trash.restoreDay(Ledger.dayFor(NOW - 6 * DAY)).refused, []);
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 3 * DAY), "ledger", "kevin").ok, true);
  assert.equal(ledger.conversation("A")?.state, "active", "the restore was carried");
});

test("LM-5: a hidden agent stays hidden and a cleared Now stays cleared when the day holding the decision moves", () => {
  const { dir, ledger } = fresh("jh-w23-5d-");
  session(ledger, "S", NOW - 4 * DAY);
  session(ledger, "x", NOW - 2 * DAY);
  ledger.append({ at: NOW - 2 * DAY + 3_600_000, type: "agent.hidden", agentId: "sessions:codex:long", hidden: true });
  ledger.append({ at: NOW - 2 * DAY + 3_600_001, type: "now.cleared", sessionId: "S" });
  const trash = new Trash(dir, ledger, { now: () => NOW });
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 2 * DAY), "ledger", "kevin").ok, true);
  assert.deepEqual(ledger.hiddenAgents(), ["sessions:codex:long"]);
  assert.equal(ledger.nowClearedAt("S"), NOW - 2 * DAY + 3_600_001);
});

test("LM-5: moving the day of a chain's root keeps the decision on the sessions that remain", () => {
  const { dir, ledger } = fresh("jh-w23-5e-");
  session(ledger, "R", NOW - 6 * DAY);
  session(ledger, "M", NOW - 4 * DAY, { resumedFrom: "R" });
  ledger.append({ at: NOW - 1 * DAY, type: "conversation.trashed", chainId: "R", by: "kevin" });
  assert.equal(ledger.conversation("M")?.state, "trashed");
  const trash = new Trash(dir, ledger, { now: () => NOW });
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 6 * DAY), "ledger", "kevin").ok, true);
  assert.equal(ledger.chainRootOf("M"), "M", "the chain starts at M now");
  assert.equal(ledger.conversation("M")?.state, "trashed", "M is still in the Trash");
  assert.equal(ledger.sessions().find((s) => s.id === "M")?.state, "trashed");
});

test("LM-5: the trashed sessions memory hides include every member and the root a moved day took away; a restore lifts them", () => {
  const { dir, ledger } = fresh("jh-w23-5f-");
  session(ledger, "R", NOW - 6 * DAY);
  session(ledger, "M", NOW - 4 * DAY, { resumedFrom: "R" });
  session(ledger, "Z", NOW - 3 * DAY);
  ledger.append({ at: NOW - 2 * DAY, type: "conversation.trashed", chainId: "R", by: "kevin" });
  assert.deepEqual([...ledger.trashedSessionIds()].sort(), ["M", "R"]);
  new Trash(dir, ledger, { now: () => NOW }).moveDay(Ledger.dayFor(NOW - 6 * DAY), "ledger", "kevin");
  assert.deepEqual([...ledger.trashedSessionIds()].sort(), ["M", "R"], "R's day is in the Trash; memory learned from R stays hidden");
  ledger.append({ at: NOW, type: "conversation.restored", chainId: "M" });
  assert.deepEqual([...ledger.trashedSessionIds()], []);
});

// ------------------------------------------------------------------------- D5 lineage

test("D5: a conversation Kevin restored stays visible to memory after its remaining days move to the Trash", () => {
  // The review's repro: R ← M, trashed; R's day moves (M carries the trash); Kevin restores M; M's day moves.
  const { dir, ledger } = fresh("jh-w23-d5a-");
  session(ledger, "R", NOW - 8 * DAY);
  session(ledger, "M", NOW - 7 * DAY, { resumedFrom: "R" });
  session(ledger, "x", NOW - 6 * DAY);
  ledger.append({ at: NOW - 6 * DAY + 3_600_000, type: "conversation.trashed", chainId: "R", by: "kevin" });
  let t = NOW - 5 * DAY;
  const trash = new Trash(dir, ledger, { now: () => t });
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 8 * DAY), "ledger", "kevin").ok, true);
  assert.deepEqual([...ledger.trashedSessionIds()].sort(), ["M", "R"]);
  t = NOW - 4 * DAY;
  ledger.append({ at: t, type: "conversation.restored", chainId: "M" });
  assert.deepEqual([...ledger.trashedSessionIds()], [], "restored: what memory learned from R is back");
  t = NOW - 3 * DAY;
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 7 * DAY), "ledger", "kevin").ok, true);
  assert.deepEqual([...ledger.trashedSessionIds()], [], "moving M's day too hides nothing again");
  // The first move's own row (and the carried trash) sit on D-5; that day can move as well.
  t = NOW - 2 * DAY;
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 5 * DAY), "ledger", "kevin").ok, true);
  assert.deepEqual([...ledger.trashedSessionIds()], []);
});

test("D5: a chain whose root and link leave on one day keeps its lineage on the move's row; Trash and Restore of what stays reach the root, across later moves", () => {
  const { dir, ledger } = fresh("jh-w23-d5b-");
  session(ledger, "R", NOW - 9 * DAY);
  session(ledger, "A", NOW - 9 * DAY + 3_600_000, { resumedFrom: "R" });
  session(ledger, "M", NOW - 6 * DAY, { resumedFrom: "A" });
  let t = NOW - 5 * DAY;
  const trash = new Trash(dir, ledger, { now: () => t });
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 9 * DAY), "ledger", "kevin").ok, true);
  const moved = ledger.read(t).find((r) => r.type === "ledger.moved") as { lineage?: Record<string, string[]> } | undefined;
  assert.deepEqual(moved?.lineage, { M: ["A", "R"] }, "the move says M continues A and R; no decision was carried");
  assert.equal(ledger.chainRootOf("M"), "M");
  t = NOW - 4 * DAY;
  ledger.append({ at: t, type: "conversation.trashed", chainId: "M", by: "kevin" });
  assert.deepEqual([...ledger.trashedSessionIds()].sort(), ["A", "M", "R"], "R named what memory learned; it follows M");
  ledger.append({ at: t + 1000, type: "conversation.restored", chainId: "M" });
  assert.deepEqual([...ledger.trashedSessionIds()], []);
  ledger.append({ at: t + 2000, type: "conversation.trashed", chainId: "M", by: "kevin" });
  // M's day moves, then the day of the first move's row: the lineage is said again each time.
  t = NOW - 3 * DAY;
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 6 * DAY), "ledger", "kevin").ok, true);
  assert.deepEqual([...ledger.trashedSessionIds()].sort(), ["A", "M", "R"]);
  t = NOW - 2 * DAY;
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 5 * DAY), "ledger", "kevin").ok, true);
  const again = ledger.read(t).find((r) => r.type === "ledger.moved") as { lineage?: Record<string, string[]> } | undefined;
  assert.deepEqual(again?.lineage, { M: ["A", "R"] }, "the lineage only that day held is on the new move's row");
  assert.deepEqual([...ledger.trashedSessionIds()].sort(), ["A", "M", "R"]);
});

test("D5: a carried copy of an old decision never outranks a newer one on the conversation that continues it", () => {
  const { dir, ledger } = fresh("jh-w23-d5c-");
  session(ledger, "R", NOW - 9 * DAY);
  session(ledger, "x", NOW - 8 * DAY);
  ledger.append({ at: NOW - 8 * DAY + 3_600_000, type: "conversation.trashed", chainId: "R", by: "kevin" });
  session(ledger, "M", NOW - 6 * DAY, { resumedFrom: "R" });
  let t = NOW - 5 * DAY;
  const trash = new Trash(dir, ledger, { now: () => t });
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 9 * DAY), "ledger", "kevin").ok, true);
  t = NOW - 4 * DAY;
  ledger.append({ at: t, type: "conversation.restored", chainId: "M" });
  assert.deepEqual([...ledger.trashedSessionIds()], []);
  // The day of R's own trash row moves: that row is still R's last, so it is carried, stamped now.
  t = NOW - 3 * DAY;
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 8 * DAY), "ledger", "kevin").ok, true);
  assert.ok(ledger.read(t).some((r) => r.type === "conversation.trashed" && (r as { carried?: unknown }).carried === true && r.chainId === "R"));
  assert.deepEqual([...ledger.trashedSessionIds()], [], "Kevin's restore of M is newer than the trash it restates");
  // M's day goes as well: R's own last row is that carried trash, and M's restore still outranks it.
  t = NOW - 2 * DAY;
  assert.equal(trash.moveDay(Ledger.dayFor(NOW - 6 * DAY), "ledger", "kevin").ok, true);
  assert.deepEqual([...ledger.trashedSessionIds()], []);
});

// ------------------------------------------------------------------------------- LM-9

test("LM-9: a search reads a bounded slice of the history, newest first, and says where to go on; the continuation finds the older hits", () => {
  const { ledger } = fresh("jh-w23-9-");
  const filler = "x".repeat(2000);
  session(ledger, "old", NOW - 30 * DAY, { heard: "the zanzibar plan" });
  for (let d = 29; d >= 1; d--) {
    const at = NOW - d * DAY;
    session(ledger, `s${d}`, at);
    for (let i = 0; i < 20; i++) ledger.append({ at: at + 2000 + i, type: "problem", text: filler } as LedgerRow);
  }
  session(ledger, "new", NOW - 3_600_000, { heard: "the Zanzibar plan again" });
  const page = ledger.searchPage("zanzibar", { maxBytes: 200_000 });
  assert.deepEqual(page.hits.map((h) => h.sessionId), ["new"]);
  assert.ok(page.older, "the slice ended before the history did");
  let older: string | undefined = page.older;
  const found: string[] = [];
  for (let i = 0; i < 40 && older; i++) {
    const next = ledger.searchPage("zanzibar", { maxBytes: 200_000, before: older });
    found.push(...next.hits.map((h) => h.sessionId));
    older = next.older;
  }
  assert.deepEqual(found, ["old"]);
  assert.equal(older, undefined, "the last page says there is nothing older");
  // The default search keeps its contract over a small history: every hit, no continuation needed.
  assert.deepEqual(ledger.search("zanzibar").map((h) => h.sessionId), ["new", "old"]);
});

test("LM-9: the raw-line prefilter never drops a hit the parsed text would make: quotes, backslashes, tabs and runs of spaces", () => {
  const { ledger } = fresh("jh-w23-9b-");
  session(ledger, "q", NOW - DAY, { heard: 'he said "ship it"\tand  left C:\\temp behind' });
  assert.equal(ledger.search('"ship it" and left').length, 1);
  assert.equal(ledger.search("C:\\temp").length, 1);
  assert.equal(ledger.search("SHIP   IT").length, 1);
  assert.equal(ledger.search("ship it and left").length, 0, "the quote is part of the text");
});

test("LM-9: the parsed-row cache is bounded by bytes, and a day read again after eviction reads the same rows", () => {
  const { ledger } = fresh("jh-w23-9c-");
  const filler = "y".repeat(4000);
  for (let d = 40; d >= 1; d--) {
    const at = NOW - d * DAY;
    session(ledger, `s${d}`, at);
    for (let i = 0; i < 40; i++) ledger.append({ at: at + 70_000 + i, type: "problem", text: filler } as LedgerRow);
  }
  const first = ledger.read(NOW - 40 * DAY).length;
  for (let d = 39; d >= 1; d--) ledger.read(NOW - d * DAY);
  assert.ok(ledger.parsedBytes() <= Ledger.PARSED_BYTES_MAX, `the cache holds ${ledger.parsedBytes()} bytes`);
  assert.equal(ledger.read(NOW - 40 * DAY).length, first);
  assert.equal(ledger.readSession("s40").length, 2);
});
