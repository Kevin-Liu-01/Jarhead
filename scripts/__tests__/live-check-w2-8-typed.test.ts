import { test } from "node:test";
import assert from "node:assert/strict";
import { APPEND_TOKEN_CAP } from "../live-check.mts";
import { allPass, dryRun } from "./live-check-w2-8-dry.ts";

/**
 * W2-8: the typed live checks, run dry (scripts/live-check.mts --dry-run). The engine is real; the
 * server is the scripted stand-in; the hands are fakes; the brain is canned. A pass here says the
 * scenario drives the engine and the judge reads what it needs; the live run is the evidence.
 */

test("LC-1 cadence: frame gaps through 50 s of silence, the usage interval, a watchdog figure", async () => {
  const r = await dryRun("LC-1");
  allPass(r);
  assert.equal(typeof r.metrics["frameGapMaxMs"], "number");
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
  // Not pinned to pass: on main a typed paste goes out as ONE 882-token append (V5), which the stand-in
  // refuses as the server would. W2-1 chunks it; this dry run is how that fix is seen offline.
  const appends = r.wire.client.filter((f) => f.tokens !== undefined);
  assert.ok(appends.length > 0, "the appends were recorded with their token estimate");
  assert.equal(r.metrics["maxAppendTokens"], Math.max(...appends.filter((f) => f.t >= (r.marks.find((m) => m.name === "paste")?.t ?? 0)).map((f) => f.tokens ?? 0)));
  const verdict = r.assertions.find((a) => /within 500 tokens/.test(a.name));
  assert.ok(verdict, "the cap is judged");
  assert.equal(verdict.pass, Number(r.metrics["maxAppendTokens"]) <= APPEND_TOKEN_CAP);
  console.log(`[measure] LC-3 dry: largest append ${String(r.metrics["maxAppendTokens"])} tokens (cap ${APPEND_TOKEN_CAP})`);
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
});
