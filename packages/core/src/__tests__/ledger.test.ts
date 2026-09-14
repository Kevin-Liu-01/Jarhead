import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delegation, LedgerRow, TranscriptItem } from "@jarhead/protocol";
import { Ledger } from "../ledger.ts";
import { LineSplitter } from "../ndjson.ts";
import { Marks } from "../marks.ts";

// Local wall-clock instants: Ledger.fileNameFor uses local time, so these land in
// the two day files whatever the machine's zone.
const local = (day: number, h: number, m: number, s = 0): number => new Date(2026, 8, day, h, m, s).getTime();

function item(id: string, speaker: "kevin" | "jarhead", text: string, at: number): TranscriptItem {
  return { id, speaker, text, startMs: 0, endMs: 1000, at, final: true };
}

function delegation(id: string, createdAt: number): Delegation {
  return { id, liveId: `live_${id}`, createdAt, offsetMs: 0, request: "do the thing", status: "running", steps: [], timings: { delegatedAt: createdAt } };
}

const heard = (at: number, text: string, id = `h${at}`): LedgerRow => ({ at, type: "heard", item: item(id, "kevin", text, at) });
const said = (at: number, text: string, id = `s${at}`): LedgerRow => ({ at, type: "said", item: item(id, "jarhead", text, at) });

function fresh(): Ledger {
  return new Ledger(mkdtempSync(join(tmpdir(), "jh-ledger-")));
}

test("ledger appends and reads back in order, per day", () => {
  const ledger = fresh();
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

test("sessions: a session crossing midnight is one summary, its rows span both files", () => {
  const ledger = fresh();
  const t0 = local(10, 23, 50);
  ledger.append({ at: t0, type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append(heard(local(10, 23, 51), "  Hey Jarhead,   what is the  Claude session doing on the auth branch right now, and is it stuck?  "));
  ledger.append(said(local(10, 23, 52), "Two sessions are active."));
  ledger.append({ at: local(10, 23, 53), type: "delegation.created", delegation: delegation("d1", local(10, 23, 53)) });
  ledger.append(heard(local(11, 0, 5), "fix it"));
  ledger.append({ at: local(11, 0, 9), type: "stop", how: "pressed" });
  ledger.append({ at: local(11, 0, 10), type: "session.closed", sessionId: "A", reason: "idle", usageSeconds: 1200 });
  assert.deepEqual(ledger.days(), ["2026-09-10.jsonl", "2026-09-11.jsonl"]);

  const list = ledger.sessions();
  assert.equal(list.length, 1);
  const a = list[0]!;
  assert.equal(a.id, "A");
  assert.equal(a.day, "2026-09-10");
  assert.equal(a.startedAt, t0);
  assert.equal(a.closedAt, local(11, 0, 10));
  assert.equal(a.reason, "idle");
  assert.equal(a.usageSeconds, 1200);
  assert.equal(a.heard, 2);
  assert.equal(a.said, 1);
  assert.equal(a.delegations, 1);
  // The first heard line, whitespace collapsed, cut at 60 characters.
  assert.equal(a.title, "Hey Jarhead, what is the Claude session doing on the auth br");
  assert.equal(a.title.length, 60);
  assert.equal(a.resumedFrom, undefined);

  const rows = ledger.readSession("A");
  assert.deepEqual(rows.map((r) => r.type), ["session.started", "heard", "said", "delegation.created", "heard", "stop", "session.closed"]);
});

test("sessions: no closed row means open, unless a later session started (then lost, billed its last pause)", () => {
  const ledger = fresh();
  ledger.append({ at: local(10, 9, 0), type: "session.started", sessionId: "lost", voice: "cedar" });
  ledger.append(heard(local(10, 9, 1), "one"));
  ledger.append({ at: local(10, 9, 2), type: "pause", sessionId: "lost", usageSeconds: 90 });
  ledger.append(said(local(10, 9, 3), "quiet"));
  ledger.append({ at: local(10, 10, 0), type: "session.started", sessionId: "open", voice: "cedar" });
  ledger.append(heard(local(10, 10, 1), "two"));
  ledger.append({ at: local(10, 10, 2), type: "stop", how: "said", cancelled: "d9" });

  const [open, lost] = ledger.sessions();
  assert.equal(open?.id, "open");
  assert.equal(open?.closedAt, undefined);
  assert.equal(open?.reason, undefined);
  assert.equal(open?.usageSeconds, 0);
  assert.equal(open?.heard, 1);
  assert.equal(open?.title, "two");

  assert.equal(lost?.id, "lost");
  assert.equal(lost?.closedAt, local(10, 10, 0));
  assert.equal(lost?.reason, "lost");
  assert.equal(lost?.usageSeconds, 90);
  assert.equal(lost?.heard, 1);
  assert.equal(lost?.said, 1);

  // The lost session's rows stop where the next one starts; the open one runs to the end of the file.
  assert.deepEqual(ledger.readSession("lost").map((r) => r.type), ["session.started", "heard", "pause", "said"]);
  assert.deepEqual(ledger.readSession("open").map((r) => r.type), ["session.started", "heard", "stop"]);
  assert.deepEqual(ledger.readSession("nope"), []);
});

test("sessions: a pause → resume chain links through resumedFrom, each with its own rows", () => {
  const ledger = fresh();
  const t = (m: number, s = 0) => local(11, 14, m, s);
  ledger.append({ at: t(0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append(heard(t(1), "read me the plan"));
  ledger.append(said(t(2), "the plan is…"));
  ledger.append({ at: t(3), type: "pause", sessionId: "A", usageSeconds: 180 });
  // The server's word for the close the pause asked for; the summary says what Kevin did.
  ledger.append({ at: t(3, 1), type: "session.closed", sessionId: "A", reason: "close_requested", usageSeconds: 180 });
  // The resume announces the new session before its started row lands.
  ledger.append({ at: t(6), type: "resume", sessionId: "B", resumedFrom: "A", pausedMs: 179_000 });
  ledger.append({ at: t(6, 1), type: "session.started", sessionId: "B", voice: "cedar", resumedFrom: "A" });
  ledger.append(heard(t(7), "carry on"));
  ledger.append({ at: t(8), type: "session.closed", sessionId: "B", reason: "idle", usageSeconds: 60 });

  const list = ledger.sessions();
  assert.deepEqual(list.map((s) => s.id), ["B", "A"]);
  const b = list[0]!;
  const a = list[1]!;
  assert.equal(b.resumedFrom, "A");
  assert.equal(b.title, "carry on");
  assert.equal(b.usageSeconds, 60);
  assert.equal(a.resumedFrom, undefined);
  assert.equal(a.reason, "paused");
  assert.equal(a.usageSeconds, 180);
  assert.equal(a.heard, 1);
  assert.equal(a.said, 1);

  assert.deepEqual(ledger.readSession("A").map((r) => r.type), ["session.started", "heard", "said", "pause", "session.closed"]);
  const bRows = ledger.readSession("B");
  assert.deepEqual(bRows.map((r) => r.type), ["resume", "session.started", "heard", "session.closed"]);
  assert.equal(bRows[0]?.type === "resume" ? bRows[0].pausedMs : 0, 179_000);
});

test("sessions: a client-requested close reads as what Kevin did — paused, stopped — and other reasons are kept", () => {
  const ledger = fresh();
  const t = (m: number, s = 0) => local(11, 16, m, s);
  // A pressed stop closes the session: close_requested → "stopped".
  ledger.append({ at: t(0), type: "session.started", sessionId: "S", voice: "cedar" });
  ledger.append({ at: t(1), type: "stop", how: "pressed" });
  ledger.append({ at: t(1, 1), type: "session.closed", sessionId: "S", reason: "close_requested", usageSeconds: 60 });
  // A spoken stop keeps it listening; the engine's idle sleep closes it later with no transport row: the word stays.
  ledger.append({ at: t(2), type: "session.started", sessionId: "I", voice: "cedar" });
  ledger.append({ at: t(3), type: "stop", how: "said", cancelled: "d1" });
  ledger.append({ at: t(9), type: "session.closed", sessionId: "I", reason: "close_requested", usageSeconds: 420 });
  // The forced close after the deadline is ours too: client_closed after a pause → "paused".
  ledger.append({ at: t(10), type: "session.started", sessionId: "P", voice: "cedar" });
  ledger.append({ at: t(11), type: "pause", sessionId: "P", usageSeconds: 55 });
  ledger.append({ at: t(11, 1), type: "session.closed", sessionId: "P", reason: "client_closed", usageSeconds: 55 });
  // A connection that dropped while pausing is still a dropped connection.
  ledger.append({ at: t(12), type: "session.started", sessionId: "C", voice: "cedar" });
  ledger.append({ at: t(13), type: "pause", sessionId: "C", usageSeconds: 30 });
  ledger.append({ at: t(13, 1), type: "session.closed", sessionId: "C", reason: "connection_lost", usageSeconds: 30 });

  const reasons = Object.fromEntries(ledger.sessions().map((s) => [s.id, s.reason]));
  assert.deepEqual(reasons, { S: "stopped", I: "close_requested", P: "paused", C: "connection_lost" });
});

test("sessions: a '?' closed row right after a lost session is left out rather than closing the wrong one", () => {
  const ledger = fresh();
  ledger.append({ at: local(11, 8, 0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append({ at: local(11, 8, 5), type: "session.started", sessionId: "B", voice: "cedar" });
  // A "?" close (day files from before 2026-09-13): the id was gone at close time. It could be A's (never closed) or B's — nobody's, then.
  ledger.append({ at: local(11, 8, 6), type: "session.closed", sessionId: "?", reason: "connection_lost", usageSeconds: 300 });
  ledger.append(heard(local(11, 8, 7), "still talking to B"));

  const list = ledger.sessions();
  const a = list.find((s) => s.id === "A")!;
  const b = list.find((s) => s.id === "B")!;
  assert.equal(a.reason, "lost");
  assert.equal(a.usageSeconds, 0);
  assert.equal(b.closedAt, undefined);
  assert.equal(b.heard, 1);
  assert.equal(b.title, "still talking to B");
  assert.deepEqual(ledger.readSession("B").map((r) => r.type), ["session.started", "session.closed", "heard"]);
});

test("sessions: a resume row in the previous day's file still belongs to the session it announces", () => {
  const ledger = fresh();
  ledger.append({ at: local(10, 23, 0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append({ at: local(10, 23, 30), type: "pause", sessionId: "A", usageSeconds: 100 });
  ledger.append({ at: local(10, 23, 30, 1), type: "session.closed", sessionId: "A", reason: "close_requested", usageSeconds: 100 });
  // Kevin pressed Go at 23:59:59; the new session's started row landed after midnight.
  ledger.append({ at: local(10, 23, 59, 59), type: "resume", sessionId: "B", resumedFrom: "A", pausedMs: 1_800_000 });
  ledger.append({ at: local(11, 0, 0, 1), type: "session.started", sessionId: "B", voice: "cedar", resumedFrom: "A" });
  ledger.append(heard(local(11, 0, 1), "morning"));
  ledger.append({ at: local(11, 0, 5), type: "session.closed", sessionId: "B", reason: "close_requested", usageSeconds: 4 });

  assert.deepEqual(ledger.days(), ["2026-09-10.jsonl", "2026-09-11.jsonl"]);
  assert.deepEqual(ledger.readSession("B").map((r) => r.type), ["resume", "session.started", "heard", "session.closed"]);
  assert.deepEqual(ledger.readSession("A").map((r) => r.type), ["session.started", "pause", "session.closed"]);
  const b = ledger.sessions().find((s) => s.id === "B")!;
  assert.equal(b.day, "2026-09-11");
  assert.equal(b.resumedFrom, "A");
  // Nothing was pressed after the resume: the server's word stays.
  assert.equal(b.reason, "close_requested");
});

test("sessions: the walk is reused while no file changed, and redone when one does", () => {
  const ledger = fresh();
  ledger.append({ at: local(11, 7, 0), type: "session.started", sessionId: "A", voice: "cedar" });
  const first = ledger.sessions();
  const again = ledger.sessions();
  assert.deepEqual(again, first);
  assert.equal(again[0]?.heard, 0);
  ledger.append(heard(local(11, 7, 1), "now with a title"));
  const after = ledger.sessions();
  assert.equal(after[0]?.heard, 1);
  assert.equal(after[0]?.title, "now with a title");
});

test("sessions: pause/resume rows without a session and a '?' closed row (day files from before 2026-09-13) go to the open session", () => {
  const ledger = fresh();
  ledger.append({ at: local(11, 9, 0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append({ at: local(11, 9, 1), type: "pause" } as unknown as LedgerRow);
  ledger.append({ at: local(11, 9, 2), type: "resume" } as unknown as LedgerRow);
  ledger.append({ at: local(11, 9, 3), type: "session.closed", sessionId: "?", reason: "connection_lost", usageSeconds: 7 });
  ledger.append({ at: local(11, 9, 4), type: "problem", text: "after the session — nobody's" });

  const [a] = ledger.sessions();
  assert.equal(a?.id, "A");
  assert.equal(a?.reason, "connection_lost");
  assert.equal(a?.usageSeconds, 7);
  assert.deepEqual(ledger.readSession("A").map((r) => r.type), ["session.started", "pause", "resume", "session.closed"]);
});

test("sessions: a late closed row for a lost session fixes its summary without widening its rows", () => {
  const ledger = fresh();
  ledger.append({ at: local(11, 9, 0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append({ at: local(11, 9, 5), type: "session.started", sessionId: "B", voice: "cedar" });
  ledger.append(heard(local(11, 9, 6), "for B"));
  ledger.append({ at: local(11, 9, 7), type: "session.closed", sessionId: "A", reason: "connection_lost", usageSeconds: 300 });
  ledger.append(heard(local(11, 9, 8), "still B"));

  const list = ledger.sessions();
  const a = list.find((s) => s.id === "A")!;
  const b = list.find((s) => s.id === "B")!;
  assert.equal(a.reason, "connection_lost");
  assert.equal(a.usageSeconds, 300);
  assert.equal(a.closedAt, local(11, 9, 7));
  assert.equal(b.heard, 2);
  // A's rows: its started row and, by name, its closed row — none of B's.
  assert.deepEqual(ledger.readSession("A").map((r) => r.type), ["session.started", "session.closed"]);
  assert.deepEqual(ledger.readSession("B").map((r) => r.type), ["session.started", "heard", "heard"]);
});

test("sessions: the per-file cache notices a file that grew, including by another writer", () => {
  const ledger = fresh();
  ledger.append({ at: local(11, 12, 0), type: "session.started", sessionId: "A", voice: "cedar" });
  assert.equal(ledger.sessions()[0]?.heard, 0);
  assert.equal(ledger.sessions()[0]?.title, "");
  // Written behind the Ledger's back (the daemon's process is the writer; the reader
  // may be another instance): only mtime + size can tell.
  const row: LedgerRow = heard(local(11, 12, 1), "hello there");
  appendFileSync(join(ledger.dir, Ledger.fileNameFor(row.at)), `${JSON.stringify(row)}\n`);
  const after = ledger.sessions()[0]!;
  assert.equal(after.heard, 1);
  assert.equal(after.title, "hello there");
  assert.equal(ledger.readSession("A").length, 2);
  // Through append(), the same.
  ledger.append(said(local(11, 12, 2), "hi"));
  assert.equal(ledger.sessions()[0]?.said, 1);
});

// ------------------------------------------------------------ conversation cleanup
//
// Tombstone rows in TODAY's file; the bytes of the conversation stay where they were
// written. A row's chainId is any session of the chain and resolves to the root through
// the resumedFrom links; the last row by `at` wins; `restored` clears trashed and archived.

/** A two-session chain (A paused, B resumed from it) on the 11th, closed. */
function chain(ledger: Ledger): void {
  const t = (m: number, s = 0) => local(11, 14, m, s);
  ledger.append({ at: t(0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append(heard(t(1), "read me the plan"));
  ledger.append(said(t(2), "the plan is a plan"));
  ledger.append({ at: t(3), type: "delegation.created", delegation: { ...delegation("d1", t(3)), request: "open the auth branch in Safari" } });
  ledger.append({ at: t(3, 30), type: "delegation.finished", delegationId: "d1", status: "done", timings: { delegatedAt: t(3) }, summary: "Safari shows the pull request" });
  ledger.append({ at: t(4), type: "pause", sessionId: "A", usageSeconds: 180 });
  ledger.append({ at: t(4, 1), type: "session.closed", sessionId: "A", reason: "close_requested", usageSeconds: 180 });
  ledger.append({ at: t(6), type: "resume", sessionId: "B", resumedFrom: "A", pausedMs: 119_000 });
  ledger.append({ at: t(6, 1), type: "session.started", sessionId: "B", voice: "cedar", resumedFrom: "A" });
  ledger.append(heard(t(7), "carry on"));
  ledger.append({ at: t(8), type: "session.closed", sessionId: "B", reason: "idle", usageSeconds: 60 });
}

test("conversations: a tombstone against any session of the chain lands on the chain; last row by `at` wins; restore clears trashed and archived", () => {
  const ledger = fresh();
  chain(ledger);
  // An unrelated session on the 12th, so the tombstones land in "today's" file, not the chain's.
  ledger.append({ at: local(12, 9, 0), type: "session.started", sessionId: "C", voice: "cedar" });
  ledger.append({ at: local(12, 9, 1), type: "session.closed", sessionId: "C", reason: "idle", usageSeconds: 5 });

  const states = () => Object.fromEntries(ledger.sessions().map((s) => [s.id, s.state]));
  assert.deepEqual(states(), { C: undefined, B: undefined, A: undefined }, "no rows: active, nothing stamped");

  // Trashed through the RESUMED session's id: both summaries of the chain say so; C is untouched.
  ledger.append({ at: local(12, 14, 2), type: "conversation.trashed", chainId: "B", by: "kevin" });
  assert.deepEqual(states(), { C: undefined, B: "trashed", A: "trashed" });
  const a = ledger.sessions().find((s) => s.id === "A")!;
  assert.equal(a.trashedAt, local(12, 14, 2));
  assert.equal(a.pinned, false);
  assert.equal(a.name, undefined);
  assert.equal(ledger.conversation("A")?.state, "trashed");
  assert.equal(ledger.conversation("B")?.trashedAt, local(12, 14, 2));
  assert.equal(ledger.chainRootOf("B"), "A");
  assert.equal(ledger.chainRootOf("A"), "A");
  assert.equal(ledger.chainRootOf("C"), "C");

  // Restored: active again, trashedAt gone.
  ledger.append({ at: local(12, 14, 3), type: "conversation.restored", chainId: "A" });
  assert.deepEqual(states(), { C: undefined, B: "active", A: "active" });
  assert.equal(ledger.sessions().find((s) => s.id === "B")!.trashedAt, undefined);

  // Archived, then trashed, then restored: restore clears both.
  ledger.append({ at: local(12, 14, 4), type: "conversation.archived", chainId: "A" });
  assert.equal(ledger.conversation("B")?.state, "archived");
  ledger.append({ at: local(12, 14, 5), type: "conversation.trashed", chainId: "A", by: "retention" });
  assert.equal(ledger.conversation("B")?.state, "trashed");
  ledger.append({ at: local(12, 14, 6), type: "conversation.restored", chainId: "B" });
  assert.equal(ledger.conversation("A")?.state, "active");
  assert.equal(ledger.conversation("A")?.trashedAt, undefined);

  // Rename and pin ride along; "" puts the auto title back.
  ledger.append({ at: local(12, 14, 7), type: "conversation.renamed", chainId: "B", name: "  The auth branch  " });
  ledger.append({ at: local(12, 14, 8), type: "conversation.pinned", chainId: "A", pinned: true });
  const b = ledger.sessions().find((s) => s.id === "B")!;
  assert.equal(b.name, "The auth branch");
  assert.equal(b.pinned, true);
  assert.equal(b.state, "active");
  assert.equal(b.title, "carry on", "the auto title is still there underneath");
  ledger.append({ at: local(12, 14, 9), type: "conversation.renamed", chainId: "B", name: "" });
  assert.equal(ledger.sessions().find((s) => s.id === "A")!.name, undefined);

  // Last row by `at` wins, whatever the file order: a late-written row with an EARLIER `at` does not undo the newer verdict.
  ledger.append({ at: local(12, 14, 1), type: "conversation.trashed", chainId: "A", by: "kevin" });
  assert.equal(ledger.conversation("A")?.state, "active");
  assert.equal(ledger.conversation("A")?.updatedAt, local(12, 14, 9));

  // Unknown ids are counted, never fatal — and never stamp anyone.
  ledger.append({ at: local(12, 15, 0), type: "conversation.trashed", chainId: "nope", by: "kevin" });
  assert.equal(ledger.unresolvedConversationRows(), 1);
  assert.deepEqual(states(), { C: undefined, B: "active", A: "active" });
  assert.equal(ledger.conversation("nope"), undefined);
  assert.equal(ledger.chainRootOf("nope"), undefined);
});

test("conversations: readSession carries the chain's tombstones from today's file, in order, and not another chain's", () => {
  const ledger = fresh();
  chain(ledger);
  // Today: an OPEN session D (no closed row) whose span runs to the end of the file, and the moves.
  ledger.append({ at: local(12, 13, 0), type: "session.started", sessionId: "D", voice: "cedar" });
  ledger.append(heard(local(12, 13, 1), "hello"));
  ledger.append({ at: local(12, 14, 2), type: "conversation.trashed", chainId: "B", by: "kevin" });
  ledger.append({ at: local(12, 14, 3), type: "conversation.restored", chainId: "A" });
  ledger.append({ at: local(12, 14, 4), type: "conversation.pinned", chainId: "D", pinned: true });
  ledger.append({ at: local(12, 14, 5), type: "grant", chainId: "A", app: "Mail", actionClass: "send", until: local(12, 15, 0) });

  // The chain's rows show the moves after the session's own rows — the Log's "Moved to Trash 14:02 · Restored 14:03".
  assert.deepEqual(ledger.readSession("A").map((r) => r.type), ["session.started", "heard", "said", "delegation.created", "delegation.finished", "pause", "session.closed", "conversation.trashed", "conversation.restored", "grant"]);
  assert.deepEqual(ledger.readSession("B").map((r) => r.type), ["resume", "session.started", "heard", "session.closed", "conversation.trashed", "conversation.restored", "grant"]);
  // D is open around the tombstones, but only its own pin is its row; the others belong to A's chain.
  assert.deepEqual(ledger.readSession("D").map((r) => r.type), ["session.started", "heard", "conversation.pinned"]);
  assert.equal(ledger.sessions().find((s) => s.id === "D")!.pinned, true);
  assert.equal(ledger.sessions().find((s) => s.id === "D")!.state, "active");
});

test("conversations: now.cleared / now.restored per session, last by `at`; the rows are the session's own", () => {
  const ledger = fresh();
  ledger.append({ at: local(12, 10, 0), type: "session.started", sessionId: "S", voice: "cedar" });
  ledger.append(heard(local(12, 10, 1), "one"));
  assert.equal(ledger.nowClearedAt("S"), undefined);
  ledger.append({ at: local(12, 10, 2), type: "now.cleared", sessionId: "S" });
  assert.equal(ledger.nowClearedAt("S"), local(12, 10, 2));
  ledger.append({ at: local(12, 10, 3), type: "now.restored", sessionId: "S" });
  assert.equal(ledger.nowClearedAt("S"), undefined);
  ledger.append({ at: local(12, 10, 4), type: "now.cleared", sessionId: "S" });
  assert.equal(ledger.nowClearedAt("S"), local(12, 10, 4));
  assert.equal(ledger.nowClearedAt("other"), undefined);
  assert.deepEqual(ledger.readSession("S").map((r) => r.type), ["session.started", "heard", "now.cleared", "now.restored", "now.cleared"]);
  // Hidden agents: last row per agent wins.
  ledger.append({ at: local(12, 10, 5), type: "agent.hidden", agentId: "sessions:codex:1", hidden: true });
  ledger.append({ at: local(12, 10, 6), type: "agent.hidden", agentId: "sessions:claude:2", hidden: true });
  ledger.append({ at: local(12, 10, 7), type: "agent.hidden", agentId: "sessions:codex:1", hidden: false });
  assert.deepEqual(ledger.hiddenAgents(), ["sessions:claude:2"]);
  // ledger.moved and agent.hidden rows are nobody's session rows.
  ledger.append({ at: local(12, 10, 8), type: "ledger.moved", day: "2026-09-01", what: "ledger", to: "trash", path: "/x", by: "kevin" });
  assert.ok(!ledger.readSession("S").some((r) => r.type === "ledger.moved" || r.type === "agent.hidden"));
});

test("automations: the six automation.* / recipe.* rows written inside an open session are the record's, never the session's; a row type from a newer daemon still falls through", () => {
  const ledger = fresh();
  ledger.append({ at: local(12, 10, 0), type: "session.started", sessionId: "S", voice: "cedar" });
  ledger.append(heard(local(12, 10, 1), "wake me at seven ten on weekdays"));
  const automation = {
    id: "auto_1", name: "Wake up", when: { kind: "every" as const, every: { kind: "weekly" as const, days: ["mon" as const], at: "07:10" as const }, phrase: "mon 07:10" },
    then: [{ kind: "chime" as const, line: "Wake up, Kevin" }], clauses: { quiet: "override" as const }, echo: "Monday at 7:10, a chime", state: "armed" as const,
    fires: 0, missed: 0, createdAt: local(12, 10, 2), updatedAt: local(12, 10, 2), createdBy: { by: "brain" as const, request: "wake me at seven ten" },
  };
  ledger.append({ at: local(12, 10, 2), type: "automation.set", automation, by: "brain" });
  ledger.append({ at: local(12, 10, 3), type: "automation.fired", id: "auto_1", actions: ["chime"], ok: true, line: "07:10 · Wake up", ms: 4 });
  ledger.append({ at: local(12, 10, 4), type: "automation.state", id: "auto_1", state: "snoozed", by: "kevin", until: local(12, 10, 14) });
  ledger.append({ at: local(12, 10, 5), type: "automation.missed", id: "auto_1", dueAt: local(12, 10, 4), why: "mac-slept" });
  ledger.append({ at: local(12, 10, 6), type: "recipe.set", recipe: { name: "tests", command: "pnpm test", timeoutSeconds: 120, approvedAt: local(12, 10, 6) }, by: "kevin" });
  ledger.append({ at: local(12, 10, 7), type: "recipe.trashed", name: "tests" });
  ledger.append(said(local(12, 10, 8), "armed"));
  ledger.append({ at: local(12, 10, 9), type: "session.closed", sessionId: "S", reason: "sleep", usageSeconds: 9 });
  assert.deepEqual(ledger.readSession("S").map((r) => r.type), ["session.started", "heard", "said", "session.closed"], "the automation rows are not the session's");
  assert.equal(ledger.read(local(12, 10, 0)).filter((r) => r.type.startsWith("automation.") || r.type.startsWith("recipe.")).length, 6, "the day file keeps all six");
  // A type this build does not know (a newer daemon's) is read, kept in the day, and placed by position like any unknown row of before 2026-09-13.
  ledger.append({ at: local(12, 10, 10), type: "automation.something-new", id: "auto_1" } as unknown as LedgerRow);
  assert.equal(ledger.read(local(12, 10, 0)).length, 11);
  assert.ok(ledger.sessions().some((s) => s.id === "S"));
});

test("conversations: a chain whose root day is gone resolves to the last known session; the old tombstone is counted, not applied", () => {
  const ledger = fresh();
  // Only B's day is live: its resumedFrom names an A the ledger never saw start.
  ledger.append({ at: local(11, 14, 6, 1), type: "session.started", sessionId: "B", voice: "cedar", resumedFrom: "A" });
  ledger.append({ at: local(11, 14, 8), type: "session.closed", sessionId: "B", reason: "idle", usageSeconds: 60 });
  ledger.append({ at: local(12, 14, 2), type: "conversation.trashed", chainId: "A", by: "kevin" });
  ledger.append({ at: local(12, 14, 3), type: "conversation.renamed", chainId: "B", name: "still here" });
  assert.equal(ledger.chainRootOf("B"), "B");
  assert.equal(ledger.unresolvedConversationRows(), 1);
  const b = ledger.sessions()[0]!;
  assert.equal(b.state, "active");
  assert.equal(b.name, "still here");
});

test("search: case-insensitive substring over heard, said, requests and summaries, newest first, attributed to the session and its chain, bounded", () => {
  const ledger = fresh();
  chain(ledger);
  ledger.append({ at: local(12, 9, 0), type: "session.started", sessionId: "C", voice: "cedar" });
  ledger.append(heard(local(12, 9, 1), "what did the PLAN say again"));
  ledger.append(said(local(12, 9, 2), "the plan is what it was"));
  ledger.append({ at: local(12, 9, 3), type: "problem", text: "a plan-shaped problem is not searched" });

  const hits = ledger.search("  plan ");
  assert.deepEqual(
    hits.map((h) => [h.sessionId, h.chainId, h.kind, h.text]),
    [
      ["C", "C", "said", "the plan is what it was"],
      ["C", "C", "heard", "what did the PLAN say again"],
      ["A", "A", "said", "the plan is a plan"],
      ["A", "A", "heard", "read me the plan"],
    ],
  );
  assert.ok(hits.every((h, i) => i === 0 || h.at <= hits[i - 1]!.at), "newest first");
  // Requests and summaries, attributed to the chain through the resumed session too.
  assert.deepEqual(ledger.search("auth branch").map((h) => [h.sessionId, h.chainId, h.kind]), [["A", "A", "request"]]);
  assert.deepEqual(ledger.search("pull request").map((h) => h.kind), ["summary"]);
  assert.deepEqual(ledger.search("carry").map((h) => [h.sessionId, h.chainId]), [["B", "A"]]);
  // Bounds: an empty query is nothing; the limit caps and clamps.
  assert.deepEqual(ledger.search("   "), []);
  assert.equal(ledger.search("plan", 2).length, 2);
  assert.equal(ledger.search("plan", 0).length, 4, "0 falls back to the default");
  assert.equal(ledger.search("a", 10_000).length <= 200, true);
  assert.deepEqual(ledger.search("nothing like this"), []);
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

test("search: a hit says the state of its conversation (a rail that hides a trashed chain can hide or mark the hit); a limit that is not positive is the default, never a cap of 1", () => {
  const ledger = fresh();
  chain(ledger);
  ledger.append({ at: local(12, 9, 0), type: "session.started", sessionId: "C", voice: "cedar" });
  ledger.append(heard(local(12, 9, 1), "the secret plan"));
  ledger.append({ at: local(12, 9, 2), type: "session.closed", sessionId: "C", reason: "idle", usageSeconds: 5 });
  assert.ok(ledger.search("plan").every((h) => h.state === "active"));

  ledger.append({ at: local(12, 10, 0), type: "conversation.trashed", chainId: "A", by: "kevin" });
  ledger.append({ at: local(12, 10, 1), type: "conversation.archived", chainId: "C" });
  assert.deepEqual(
    ledger.search("plan").map((h) => [h.sessionId, h.chainId, h.state]),
    [
      ["C", "C", "archived"],
      ["A", "A", "trashed"],
      ["A", "A", "trashed"],
    ],
  );
  // B's line sits in A's chain: trashed with it, restored with it.
  assert.deepEqual(ledger.search("carry").map((h) => [h.sessionId, h.chainId, h.state]), [["B", "A", "trashed"]]);
  ledger.append({ at: local(12, 10, 2), type: "conversation.restored", chainId: "A" });
  assert.deepEqual(ledger.search("carry").map((h) => h.state), ["active"]);
  // Bounds: -3, NaN and 0 are the default (well above the three hits here); 1 is a cap of 1.
  assert.equal(ledger.search("plan", -3).length, 3);
  assert.equal(ledger.search("plan", Number.NaN).length, 3);
  assert.equal(ledger.search("plan", 0).length, 3);
  assert.equal(ledger.search("plan", 1).length, 1);
});

// ---------------------------------------------------------------------------
// Long-horizon reads (pass 3): a whole conversation in one read, a bounded walk, and the
// memory audit rows as the record's own (never a session's by position).

import { CHAIN_ROWS_MAX, WALK_DAYS } from "../ledger.ts";

test("readChain: every session of the chain, oldest first, each with its own rows, the chain's tombstones and grants once; a member id resolves to the root; an unknown id reads empty; the newest `max` rows survive a cut and truncated says so", () => {
  const ledger = fresh();
  const t = (m: number, s = 0) => local(11, 14, m, s);
  ledger.append({ at: t(0), type: "session.started", sessionId: "A", voice: "cedar", language: "en", accent: "american" });
  ledger.append(heard(t(1), "read me the plan"));
  ledger.append(said(t(2), "the plan is…"));
  ledger.append({ at: t(2, 30), type: "grant", chainId: "A", app: "Mail", actionClass: "send", until: t(59) });
  ledger.append({ at: t(3), type: "pause", sessionId: "A", usageSeconds: 180 });
  ledger.append({ at: t(3, 1), type: "session.closed", sessionId: "A", reason: "close_requested", usageSeconds: 180 });
  ledger.append({ at: t(6), type: "resume", sessionId: "B", resumedFrom: "A", pausedMs: 179_000 });
  ledger.append({ at: t(6, 1), type: "session.started", sessionId: "B", voice: "cedar", resumedFrom: "A" });
  ledger.append(heard(t(7), "carry on"));
  ledger.append({ at: t(8), type: "session.closed", sessionId: "B", reason: "connection_lost", usageSeconds: 60 });
  // The reconnect's session: a third member, chained by resumedFrom like a pause's resume.
  ledger.append({ at: t(8, 1), type: "session.started", sessionId: "C", voice: "cedar", resumedFrom: "B" });
  ledger.append({ at: t(8, 1), type: "resume", sessionId: "C", resumedFrom: "B", pausedMs: 1000 });
  ledger.append(heard(t(9), "and the weather"));
  ledger.append({ at: t(10), type: "session.closed", sessionId: "C", reason: "idle", usageSeconds: 30 });
  // Another conversation entirely, and a rename on ours from a later moment.
  ledger.append({ at: t(20), type: "session.started", sessionId: "Z", voice: "cedar" });
  ledger.append(heard(t(21), "unrelated"));
  ledger.append({ at: t(22), type: "session.closed", sessionId: "Z", reason: "idle", usageSeconds: 5 });
  ledger.append({ at: t(30), type: "conversation.renamed", chainId: "C", name: "the plan" });

  const chain = ledger.readChain("A");
  assert.equal(chain.truncated, false);
  const types = chain.rows.map((r) => r.type);
  // Each member as readSession gives it: file order, the chain's own rows where they sit (the grant
  // inside A's span; the rename, written after A closed, after its span) — and only once for the chain.
  assert.deepEqual(types, [
    "session.started", "heard", "said", "grant", "pause", "session.closed", "conversation.renamed",
    "resume", "session.started", "heard", "session.closed",
    "session.started", "resume", "heard", "session.closed",
  ]);
  assert.equal(chain.rows.filter((r) => r.type === "grant").length, 1, "the chain's grant appears once, not once per member");
  assert.equal(chain.rows.filter((r) => r.type === "conversation.renamed").length, 1);
  assert.ok(!chain.rows.some((r) => r.type === "heard" && r.item.text === "unrelated"), "another chain's rows stay out");
  assert.deepEqual(ledger.readChain("C").rows, chain.rows, "a member id resolves to the root");
  assert.deepEqual(ledger.readChain("B").rows, chain.rows);
  assert.deepEqual(ledger.readChain("nope"), { rows: [], truncated: false });
  // The cap keeps the newest rows.
  const cut = ledger.readChain("A", 4);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.rows.map((r) => r.type), ["session.started", "resume", "heard", "session.closed"]);
  assert.equal(CHAIN_ROWS_MAX, 20_000);
});

test("memory.* audit rows are the record's own: appended to today's file they never count as the open session's rows, and readChain leaves them out", () => {
  const ledger = fresh();
  const t = (m: number) => local(12, 9, m);
  ledger.append({ at: t(0), type: "session.started", sessionId: "A", voice: "cedar" });
  ledger.append(heard(t(1), "remember that I prefer dark mode"));
  ledger.append({ at: t(1), type: "memory.added", id: "m_1", kind: "preference", origin: "kevin" });
  ledger.append({ at: t(2), type: "session.closed", sessionId: "A", reason: "idle", usageSeconds: 10 });
  ledger.append({ at: t(3), type: "memory.run", sessionId: "A", extractor: "rules", added: 1, updated: 0, noop: 2, refused: 0, ms: 12 });
  ledger.append({ at: t(4), type: "memory.forgotten", id: "m_1", by: "kevin" });
  ledger.append({ at: t(5), type: "memory.restored", id: "m_1" });
  ledger.append({ at: t(6), type: "memory.updated", id: "m_1" });
  ledger.append({ at: t(7), type: "session.started", sessionId: "B", voice: "cedar" });
  ledger.append({ at: t(8), type: "memory.run", extractor: "responses", added: 0, updated: 0, noop: 0, refused: 0, ms: 3 });
  assert.deepEqual(ledger.readSession("A").map((r) => r.type), ["session.started", "heard", "session.closed"]);
  assert.deepEqual(ledger.readSession("B").map((r) => r.type), ["session.started"]);
  assert.ok(!ledger.readChain("A").rows.some((r) => r.type.startsWith("memory.")));
  assert.equal(ledger.read(t(0)).filter((r) => r.type.startsWith("memory.")).length, 6, "the day file keeps them");
  assert.equal(ledger.search("dark mode").length, 1, "search sees the heard line; the audit rows carry no text to search");
});

test("the walk reads the last WALK_DAYS day files: a session older than the window leaves sessions() and the chain reads; its day file stays on disk and read(at) still opens it", () => {
  const ledger = fresh();
  const day0 = new Date(2026, 3, 1, 12, 0, 0).getTime();
  const DAY = 24 * 3_600_000;
  ledger.append({ at: day0, type: "session.started", sessionId: "old", voice: "cedar" });
  ledger.append(heard(day0 + 60_000, "long ago"));
  ledger.append({ at: day0 + 120_000, type: "session.closed", sessionId: "old", reason: "idle", usageSeconds: 5 });
  for (let d = 1; d < WALK_DAYS; d++) ledger.append({ at: day0 + d * DAY, type: "problem", text: `day ${d}` });
  assert.equal(ledger.days().length, WALK_DAYS);
  assert.deepEqual(ledger.sessions().map((s) => s.id), ["old"], "inside the window: seen");
  // One more day pushes the first file out of the window.
  ledger.append({ at: day0 + WALK_DAYS * DAY, type: "session.started", sessionId: "new", voice: "cedar" });
  ledger.append({ at: day0 + WALK_DAYS * DAY + 1000, type: "session.closed", sessionId: "new", reason: "idle", usageSeconds: 5 });
  assert.equal(ledger.days().length, WALK_DAYS + 1);
  assert.deepEqual(ledger.sessions().map((s) => s.id), ["new"], "the old session is outside the walk");
  assert.deepEqual(ledger.readChain("old"), { rows: [], truncated: false });
  assert.equal(ledger.read(day0).length, 3, "the file is still there and opens by date");
  assert.equal(WALK_DAYS, 60);
});

test("a hide older than WALK_DAYS still hides: agent.hidden is Kevin's decision about the rail, gathered from every day file; the later row wins across the window's edge; sessions() stays bounded", () => {
  const ledger = fresh();
  const day0 = new Date(2026, 3, 1, 12, 0, 0).getTime();
  const DAY = 24 * 3_600_000;
  ledger.append({ at: day0, type: "session.started", sessionId: "old", voice: "cedar" });
  ledger.append({ at: day0 + 1000, type: "agent.hidden", agentId: "sessions:codex:long-lived", hidden: true });
  ledger.append({ at: day0 + 2000, type: "agent.hidden", agentId: "sessions:claude:shown-again", hidden: true });
  ledger.append({ at: day0 + 3000, type: "agent.hidden", agentId: "sessions:claude:shown-again", hidden: false });
  ledger.append({ at: day0 + 4000, type: "session.closed", sessionId: "old", reason: "idle", usageSeconds: 5 });
  for (let d = 1; d <= WALK_DAYS; d++) ledger.append({ at: day0 + d * DAY, type: "problem", text: `day ${d}` });
  assert.equal(ledger.days().length, WALK_DAYS + 1, "day 0 is outside the window");
  assert.deepEqual(ledger.sessions().map((s) => s.id), [], "session attribution is bounded by the window");
  assert.deepEqual(ledger.hiddenAgents(), ["sessions:codex:long-lived"], "the hide from day 0 holds; the agent shown again on day 0 stays shown");
  // Inside the window Kevin shows the long-lived one again, then hides another: the later rows win.
  ledger.append({ at: day0 + WALK_DAYS * DAY + 1000, type: "agent.hidden", agentId: "sessions:codex:long-lived", hidden: false });
  ledger.append({ at: day0 + WALK_DAYS * DAY + 2000, type: "agent.hidden", agentId: "sessions:codex:new", hidden: true });
  assert.deepEqual(ledger.hiddenAgents(), ["sessions:codex:new"]);
  // The old file is read once for its hidden rows and not kept as rows: a second call costs a stat.
  assert.deepEqual(ledger.hiddenAgents(), ["sessions:codex:new"]);
});

test("before 2026-09-13: a day file with the old row type, a delegation.step whose step carries the old name key, a session.started without language and a torn last line reads without a throw; the old row is neither a session nor a hit; the step lands on its delegation", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-ledger-"));
  const ledger = new Ledger(dir);
  const t0 = local(11, 9, 0);
  const d = delegation("dlg_old", local(11, 9, 2));
  const OLD_TYPE = "worker"; // before 2026-09-13: the row type the threads pass replaced
  const OLD_KEY = "worker"; // before 2026-09-13: the step key that is `thread` now
  const oldRow = { at: local(11, 9, 3), type: OLD_TYPE, [OLD_KEY]: { id: "w_old", name: "Spotify", delegationId: "dlg_old", task: "play something quiet", lane: "background", status: "working", startedAt: local(11, 9, 3), steps: 1 } };
  const oldStep = { at: local(11, 9, 4), type: "delegation.step", delegationId: "dlg_old", step: { id: "s_old", at: local(11, 9, 4), kind: "note", text: "Spotify is playing", [OLD_KEY]: "Spotify" } };
  const rows = [
    { at: t0, type: "session.started", sessionId: "live_old", voice: "cedar" }, // before 2026-09-13: no language, no accent
    heard(local(11, 9, 1), "spotify, play something quiet"),
    { at: local(11, 9, 2), type: "delegation.created", delegation: d },
    oldRow,
    oldStep,
    { at: local(11, 9, 5), type: "delegation.finished", delegationId: "dlg_old", status: "done", timings: { delegatedAt: local(11, 9, 2), doneAt: local(11, 9, 5) }, summary: "Playing Spotify" },
    said(local(11, 9, 6), "Playing something quiet."),
    { at: local(11, 9, 7), type: "session.closed", sessionId: "?", reason: "idle", usageSeconds: 400 },
  ];
  const torn = JSON.stringify({ at: local(11, 9, 8), type: "heard", item: item("h_torn", "kevin", "and then the Mac slept", local(11, 9, 8)) }).slice(0, 40);
  appendFileSync(join(ledger.dir, Ledger.fileNameFor(t0)), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n${torn}`);

  const read = ledger.read(t0);
  assert.equal(read.length, rows.length, "every whole line parses; the torn one is skipped");
  assert.equal(read.filter((r) => (r as { type: string }).type === OLD_TYPE).length, 1, "the old row type rides through parse untouched");

  const sessions = ledger.sessions();
  assert.equal(sessions.length, 1, "the old row is not a session");
  const s = sessions[0]!;
  assert.equal(s.id, "live_old");
  assert.equal(s.closedAt, local(11, 9, 7), "the \"?\" closed row is the open session's");
  assert.equal(s.usageSeconds, 400);
  assert.equal(s.heard, 1);
  assert.equal(s.said, 1);
  assert.equal(s.delegations, 1);
  assert.equal(s.title, "spotify, play something quiet");

  const hits = ledger.search("Spotify");
  assert.deepEqual(hits.map((h) => h.kind).sort(), ["heard", "summary"], "heard text and the summary hit; the old row's task never does");
  assert.ok(hits.every((h) => h.sessionId === "live_old"));

  const chain = ledger.readChain("live_old");
  assert.equal(chain.truncated, false);
  const step = chain.rows.find((r) => r.type === "delegation.step");
  assert.ok(step && step.type === "delegation.step");
  assert.equal(step.delegationId, "dlg_old", "the old step still belongs to its delegation");
  assert.equal(step.step.thread, undefined, "the old name key on the step is not `thread`: the row reads as main's");
  assert.equal((step.step as unknown as Record<string, unknown>)[OLD_KEY], "Spotify", "and the bytes are what they were");
  assert.deepEqual(ledger.readSession("live_old").map((r) => r.type), rows.map((r) => r.type), "the session's rows, the old row among them, the torn line gone");
});
