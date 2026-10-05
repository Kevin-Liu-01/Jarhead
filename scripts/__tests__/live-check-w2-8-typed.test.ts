import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { APPEND_TOKEN_CAP, OVERSIZE_MIN_WORDS } from "../live-check.mts";
import { allPass, assertion, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-1 splits a typed paste into parts that each fit an append (V5). Before it is merged a paste goes out whole and
 * LC-3's cap verdict fails dry, so the strict test below is a todo; once W2-1's own test file is in the tree it is an
 * ordinary test, and a regression in the chunking fails the suite offline. The first LC-3 test checks the two agree
 * (the paste is chunked exactly when W2-1 is in), so a moved file fails loudly instead of quietly making it a todo.
 */
const W2_1_MERGED = existsSync(new URL("../../packages/engine/src/__tests__/w2-1-voice.test.ts", import.meta.url));

/**
 * W2-8: the typed live checks, run dry (scripts/live-check.mts --dry-run). The engine is real; the
 * server is the scripted stand-in; the hands are fakes; the brain is canned. A pass here says the
 * scenario drives the engine and the judge reads what it needs; the live run is the evidence.
 */

test("LC-1 cadence: frame gaps and output-audio gaps through 50 s of silence, the usage interval, a watchdog figure", async () => {
  const r = await dryRun("LC-1");
  allPass(r);
  assert.equal(typeof r.metrics["frameGapMaxMs"], "number");
  assert.equal(typeof r.metrics["outputAudioGapMaxMs"], "number");
  assert.equal(assertion(r, /no output-audio gap over 2 s/).pass, true);
  assert.ok(Number(r.metrics["recommendedWatchdogMs"]) >= 5000, "max(5 s, 5 x the max gap)");
  assert.ok(Number(r.metrics["audioFramesInWindow"]) > 0);
});

test("LC-2 meter: usage while muted, the pause row against the wall, continuity on resume, the meter against the closed rows", async () => {
  const r = await dryRun("LC-2");
  allPass(r);
  assert.equal(r.sessions.length, 2, "Go, Pause, Go: two sessions");
  assert.equal(r.sessions[1]?.continuity, true);
  assert.equal(r.ledger.filter((row) => row.type === "pause").length, 1);
});

test("LC-3 append-cap: every client append is measured against the 500-token cap", async () => {
  const r = await dryRun("LC-3");
  const appends = r.wire.client.filter((f) => f.tokens !== undefined);
  assert.ok(appends.length > 0, "the appends were recorded with their token estimate");
  assert.equal(r.metrics["maxAppendTokens"], Math.max(...appends.filter((f) => f.t >= (r.marks.find((m) => m.name === "paste")?.t ?? 0)).map((f) => f.tokens ?? 0)));
  const verdict = assertion(r, /within 500 tokens/);
  assert.equal(verdict.pass, Number(r.metrics["maxAppendTokens"]) <= APPEND_TOKEN_CAP);
  console.log(`[measure] LC-3 dry: largest append ${String(r.metrics["maxAppendTokens"])} tokens over ${String(r.metrics["appends"])} append(s) (cap ${APPEND_TOKEN_CAP}); W2-1 in the tree: ${W2_1_MERGED}`);
  assert.equal(Number(r.metrics["appends"]) > 1, W2_1_MERGED, "the paste is chunked exactly when W2-1 is in the tree (else the strict test below is judged on the wrong side)");
});

test("LC-3 append-cap passes dry: the paste is chunked within the cap and the reply reads its end", { todo: W2_1_MERGED ? false : "a typed paste goes out whole until W2-1 is merged (V5)" }, async () => {
  const r = await dryRun("LC-3");
  allPass(r);
  assert.ok(Number(r.metrics["maxAppendTokens"]) <= APPEND_TOKEN_CAP, `largest append ${String(r.metrics["maxAppendTokens"])} tokens`);
});

test("LC-3 --oversize: one raw append of varied prose, recorded with its size, draws the stand-in's error", async () => {
  const r = await dryRun("LC-3", { oversize: true });
  assert.ok(Number(r.metrics["oversizeWords"]) >= OVERSIZE_MIN_WORDS, `${String(r.metrics["oversizeWords"])} words`);
  assert.ok(Number(r.metrics["oversizeChars"]) > 0 && Number(r.metrics["oversizeTokensEstimate"]) > APPEND_TOKEN_CAP);
  assert.equal(assertion(r, /one oversize append gives an error event/).pass, true);
  const probe = r.wire.client.find((f) => f.type === "session.instructions.append" && f.t >= (r.marks.find((m) => m.name === "oversize")?.t ?? Infinity));
  assert.ok(probe && (probe.chars ?? 0) === Number(r.metrics["oversizeChars"]), "sent whole, past the engine and the session");
});

test("LC-4 night: three farewells, each exactly night., each closed inside 1.8 s, asleep", async () => {
  const r = await dryRun("LC-4");
  allPass(r);
  assert.equal(r.sessions.length, 3);
  assert.equal(r.ledger.filter((row) => row.type === "sleep" && row.cause === "said").length, 3);
});

test("LC-5 first-word: ten typed questions, typed send to the first audible frame", async () => {
  const r = await dryRun("LC-5");
  allPass(r);
  assert.equal((r.metrics["firstAudioMs"] as number[]).length, 10);
});

test("LC-8 drop: the brain is cut once, the runner let go, nothing accepted after Stop; a paused drop holds until Go", async () => {
  const r = await dryRun("LC-8");
  allPass(r);
  assert.ok(r.brain.toolCalls.some((c) => c.accepted), "the slow task was acting before the drop");
  assert.ok(r.sessions.some((s) => s.closeReason === "connection_lost"), "the drop reads as a lost connection");
});

test("LC-9 delegate: the reflex scrolls the fake hands, the haiku reaches the canned brain, nothing is typed", async () => {
  const r = await dryRun("LC-9");
  allPass(r);
  assert.ok(r.hands.acting.some((c) => c.op === "scroll"));
  assert.ok(r.brain.tasks.some((t) => /haiku/i.test(t.request)));
  // The stand-in does not delegate a line Jarhead handled: the reconcile is reported as not exercised, never as a pass.
  const reconcile = assertion(r, /reconciles as already done/);
  assert.deepEqual([reconcile.pass, reconcile.soft], [false, true]);
  assert.equal(r.metrics["reconcileExercised"], false);
});
