import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtractInput, localDay } from "../extract/input.ts";
import { refuseReason } from "../redact.ts";
import { fixtureRows, heard, redactFake, said, T0 } from "./helpers.ts";

/**
 * Over fixtures/session-1.jsonl: what memory never reads is absent — grants,
 * tool payloads, the confirmation exchange, rows Kevin cleared, rows behind the
 * watermark or inside a forget window, and every line the redactor or a shape
 * touched. Lines are numbered from 1 after filtering; the cap slices oldest first.
 */

const base = { redact: redactFake, refuse: (s: string) => refuseReason(s) };

test("input: the fixture yields Kevin's six durable lines and Jarhead's context, numbered from 1, with the request and its outcome", () => {
  const rows = fixtureRows();
  const input = buildExtractInput(rows, base);
  const texts = input.lines.map((l) => `${l.speaker}: ${l.text}`);
  assert.deepEqual(texts, [
    "Kevin: call me Kev",
    "Jarhead: Sure, Kev.",
    "Kevin: I prefer short answers",
    "Jarhead: Noted.",
    "Kevin: my dentist is Dr. Patel",
    "Kevin: from now on read the diff before saying a PR is fine",
    "Jarhead: Will do.",
    "Kevin: remember that I like dark mode",
    "Kevin: speak in english",
    "Jarhead: English it is.",
  ]);
  assert.deepEqual(input.lines.map((l) => l.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(input.kevinLines, 6);
  assert.equal(input.day, localDay(T0));
  assert.deepEqual(input.requests, [{ request: "open the diff for the auth branch and push it", status: "done", summary: "Pushed the auth branch.", at: T0 + 50_000 }]);
  assert.equal(input.upToAt, T0 + 80_000, "the watermark covers every row read, the closed row included");
  assert.equal(input.truncated, false);
  assert.equal(input.dropped, 4, "card, password, key, SSN");
  const joined = JSON.stringify(input);
  for (const secret of ["4111", "hunter22", "sk-proj", "[redacted secret]", "123-45-6789", "ghp_", "TOKEN"]) assert.ok(!joined.includes(secret), `${secret} leaked into the extractor input`);
  assert.ok(!joined.includes("Should I push to main?"), "the confirmation question is not a source");
  assert.ok(!joined.includes("yes go ahead"), "nor its short answer");
  assert.ok(!joined.includes("hey jarhead"), "rows at or before now.cleared are hidden");
  assert.ok(!joined.includes("git push"), "grant rows and tool payloads never appear");
});

test("input: rows ≤ sinceAt and rows inside an exclusion window are absent; a now.restored after the clear brings the early rows back", () => {
  const rows = fixtureRows();
  const since = buildExtractInput(rows, { ...base, sinceAt: T0 + 30_000 });
  assert.deepEqual(since.lines.filter((l) => l.speaker === "Kevin").map((l) => l.text), ["from now on read the diff before saying a PR is fine", "remember that I like dark mode", "speak in english"]);
  assert.equal(since.requests.length, 1, "the request after the watermark is still read");
  const excluded = buildExtractInput(rows, { ...base, exclusions: [{ from: T0 + 69_000, to: T0 + 73_000, sessionId: "A" }] });
  assert.ok(!excluded.lines.some((l) => /dark mode|english/i.test(l.text)));
  assert.equal(excluded.upToAt, T0 + 80_000, "the window is skipped, not re-read next time");
  const restored = buildExtractInput([...rows, { at: T0 + 4000, type: "now.restored", sessionId: "A" }], base);
  assert.equal(restored.lines[0]?.text, "hey jarhead");
});

test("input: the char cap keeps the OLDEST lines and stops there (truncated, upToAt = the last kept line) so a long delta is read in slices", () => {
  const rows = fixtureRows();
  const small = buildExtractInput(rows, { ...base, maxChars: 120 });
  assert.equal(small.truncated, true);
  assert.equal(small.lines[0]?.text, "call me Kev");
  assert.ok(small.lines.length < 10);
  assert.equal(small.upToAt, small.lines[small.lines.length - 1]!.at);
  assert.equal(small.pendingKevinLines, 6, "the gate sees the whole delta, not the slice");
  assert.ok(small.kevinLines < 6);
  assert.ok(small.requests.every((r) => r.at <= small.upToAt));
  const next = buildExtractInput(rows, { ...base, maxChars: 120, sinceAt: small.upToAt });
  assert.equal(next.lines[0]?.at, rows.find((r) => r.at > small.upToAt && (r.type === "heard" || r.type === "said"))?.at, "the next slice starts where this one stopped");
});

test("input: non-final fragments and empty lines are skipped; a lone answer after a confirm with more than four words is kept", () => {
  const rows = [
    heard(T0 + 1000, "call me Kev"),
    { ...said(T0 + 2000, "partial"), item: { id: "p", speaker: "jarhead" as const, text: "partial", startMs: 0, endMs: 1, at: T0 + 2000, final: false } },
    heard(T0 + 3000, "   "),
    { at: T0 + 4000, type: "delegation.step" as const, delegationId: "d", step: { id: "s", at: T0 + 4000, kind: "confirm" as const, text: "Send it?" } },
    said(T0 + 4500, "Send the email to Ben?"),
    heard(T0 + 6000, "yes but change the subject line to standup first"),
  ];
  const input = buildExtractInput(rows, base);
  assert.deepEqual(input.lines.map((l) => l.text), ["call me Kev", "yes but change the subject line to standup first"]);
});

test("input: the injected `refuse` is the one applied — a stricter caller's shape drops lines the default would keep, and the redactor still goes first", () => {
  const rows = fixtureRows();
  const strict = buildExtractInput(rows, { redact: redactFake, refuse: (s) => (/dentist/i.test(s) ? "health" : refuseReason(s)) });
  assert.ok(!strict.lines.some((l) => /dentist/i.test(l.text)), "the caller's shape dropped the dentist line");
  assert.equal(strict.dropped, 5, "the four secrets and the dentist");
  const lax = buildExtractInput(rows, { redact: redactFake, refuse: () => undefined });
  assert.ok(lax.lines.some((l) => /dentist/i.test(l.text)));
  assert.ok(!lax.lines.some((l) => /sk-proj|ghp_/.test(l.text)), "a refuser that refuses nothing still never sees what the redactor changed");
  assert.equal(lax.dropped, 1, "only the redactor-marked key line");
  assert.ok(lax.lines.some((l) => /4111/.test(l.text)), "with no refusal shapes the card line stays — the shapes are the caller's, not hidden in the builder");
});
