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
  // Legacy: the id was gone at close time. It could be A's (never closed) or B's — nobody's, then.
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

test("sessions: legacy pause/resume rows without a session and a '?' closed row go to the open session", () => {
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
