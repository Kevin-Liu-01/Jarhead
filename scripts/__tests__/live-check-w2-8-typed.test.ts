import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APPEND_TOKEN_CAP, OVERSIZE_MIN_WORDS, engineHears, sinkFrame, type Report } from "../live-check.mts";
import { main, rejudge, type SavedReport } from "../rejudge.mts";
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

test("LC-2 meter: one session through the mute, the server's meter while muted, the pause row against the wall, continuity on resume, the meter against the closed rows", async () => {
  const r = await dryRun("LC-2");
  allPass(r);
  assert.equal(r.sessions.length, 2, "Go, Pause, Go: two sessions");
  assert.equal(r.sessions[1]?.continuity, true);
  assert.equal(r.ledger.filter((row) => row.type === "pause").length, 1);
  assert.equal(typeof r.metrics["usageWhileMutedSeconds"], "number", "measured from the server's own figures");
  assert.equal(typeof r.metrics["pauseSessionServerSeconds"], "number");
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

test("LC-4 night: a typed dismissal Live answers with night. and never delegates (GPT-Live-1, 3 of 3) still sleeps it: night., heard at the speaker, closed inside 1.8 s of it, asleep, three times", async () => {
  const r = await dryRun("LC-4");
  allPass(r);
  assert.equal(r.sessions.length, 3);
  assert.equal(r.ledger.filter((row) => row.type === "sleep" && row.cause === "said").length, 3);
  assert.equal(r.wire.delegations.length, 0, "the stand-in delegated nothing: the engine took the typed dismissal itself");
  assert.ok(r.sink.every((f) => typeof f.rms === "number"), "every sink frame keeps its RMS");
});

test("LC-5 first-word: ten typed questions; the engine's share of the first word judged, Live's typed path quoted", async () => {
  const r = await dryRun("LC-5");
  allPass(r);
  assert.equal((r.metrics["firstAudioMs"] as number[]).length, 10);
  assert.equal((r.metrics["ownSendMs"] as number[]).length, 10);
  assert.equal((r.metrics["sinkLagMs"] as number[]).length, 10);
  assert.equal(assertion(r, /^GPT-Live-1's typed path/).soft, true, "Live's share is quoted, never failed on");
});

test("LC-8 drop: the brain is cut once, the runner let go, nothing accepted after Stop; a paused drop holds until Go", async () => {
  const r = await dryRun("LC-8");
  allPass(r);
  assert.ok(r.brain.toolCalls.some((c) => c.accepted), "the slow task was acting before the drop");
  assert.ok(r.sessions.some((s) => s.closeReason === "connection_lost"), "the drop reads as a lost connection");
});

test("LC-9 delegate: the reflex scrolls the fake hands, a haiku Live delegates reaches the canned brain, nothing is typed", async () => {
  const r = await dryRun("LC-9");
  allPass(r);
  assert.ok(r.hands.acting.some((c) => c.op === "scroll"));
  assert.ok(r.brain.tasks.some((t) => /haiku/i.test(t.request)));
  assert.equal(r.metrics["haikuBy"], "brain");
  assert.equal(assertion(r, /Live's delegation for the haiku reaches the canned brain/).pass, true);
  // The stand-in does not delegate a line Jarhead handled: the reconcile is reported as not exercised, never as a pass.
  const reconcile = assertion(r, /reconciles as already done/);
  assert.deepEqual([reconcile.pass, reconcile.soft], [false, true]);
  assert.equal(r.metrics["reconcileExercised"], false);
});

/**
 * F3: scripts/rejudge.mts judges a saved report again with this checkout's judges, for free. A report must judge the
 * same from its JSON as it did in its run, a judge that reads a field the report does not keep must say which, and a
 * run that never reached its end fails as it did then, whatever its assertions say.
 */

const saved = (file: string): SavedReport => JSON.parse(readFileSync(file, "utf8")) as SavedReport;
/** As JSON keeps it: NaN and Infinity become null, undefined fields go. */
const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
/** One dry run per check for the re-judge tests, whose reports they only read. */
const dryOnce = new Map<string, Promise<Report>>();
const once = (check: string): Promise<Report> => {
  if (!dryOnce.has(check)) dryOnce.set(check, dryRun(check));
  return dryOnce.get(check)!;
};
/** A saved report written beside `r`'s, and the command line's output and exit code for it. */
function rejudgeFile(r: Report, name: string, report: SavedReport): { readonly code: number; readonly lines: readonly string[] } {
  const file = join(dirname(r.files.report), name);
  writeFileSync(file, JSON.stringify(report));
  const lines: string[] = [];
  return { code: main([file], (l) => void lines.push(l)), lines };
}

test("re-judge: a dry run's report, judged again from its JSON, gives the run's own assertions and metrics", async () => {
  for (const check of ["LC-2", "LC-5", "LC-9", "LC-10"]) {
    const r = await once(check);
    const again = rejudge(saved(r.files.report));
    assert.equal(again.notKept, undefined, `${check}: every field its judge reads is kept`);
    assert.deepEqual(again.notes, [], `${check}: nothing approximated`);
    assert.equal(again.unfinished, undefined, `${check}: the run reached its end`);
    assert.deepEqual(asJson(again.assertions), asJson(r.assertions), `${check}: the same assertions`);
    assert.deepEqual(asJson(again.metrics), asJson(r.metrics), `${check}: the same metrics`);
    assert.equal(again.pass, r.pass);
  }
});

test("re-judge: a judge that reads a field the report does not keep stops there, names the field, and the command line says so", async () => {
  const r = await once("LC-10");
  const { delegations: _dropped, ...older } = saved(r.files.report);
  const again = rejudge(older);
  assert.equal(again.notKept, "snapshot.delegations");
  assert.equal(again.pass, false);
  const out = rejudgeFile(r, "older.json", older);
  assert.equal(out.code, 2);
  assert.ok(out.lines.includes("  not re-judgeable: snapshot.delegations"), out.lines.join("\n"));
  // The day's meter: a report with no figure stops LC-2's meter judge by name, never on a NaN.
  const lc2 = saved((await once("LC-2")).files.report);
  assert.equal(rejudge({ ...lc2, final: { ...lc2.final, usageSeconds: undefined } }).notKept, "snapshot.usageToday");
});

test("re-judge: a run that never reached its end, or recorded an error of its own, fails whatever its assertions say", async () => {
  const r = await once("LC-5");
  const whole = saved(r.files.report);
  assert.equal(rejudge(whole).pass, true);
  const cut: SavedReport = { ...whole, ran: false, capHit: true, error: "cut", pass: false };
  const again = rejudge(cut);
  assert.ok(again.assertions.filter((a) => !a.soft).every((a) => a.pass), "its assertions alone pass");
  assert.equal(again.unfinished, "never reached its end (cut at the cap)");
  assert.equal(again.pass, false);
  const out = rejudgeFile(r, "cut.json", cut);
  assert.equal(out.code, 1, out.lines.join("\n"));
  assert.ok(out.lines.some((l) => /^  LC-5: FAIL \(\d+\/\d+ hard; the run never reached its end \(cut at the cap\); the run itself said FAIL\)$/.test(l)), out.lines.join("\n"));
  // It ran to its end and then recorded an error: that fails too. An error only the old judge raised is set aside.
  const errored = rejudge({ ...whole, error: "Error: the engine would not stop\n    at stop", pass: false });
  assert.deepEqual([errored.pass, errored.unfinished, errored.runError], [false, "recorded an error", "Error: the engine would not stop"]);
  assert.equal(rejudge({ ...whole, error: "judge: TypeError: the old judge", pass: false }).pass, true);
});

test("re-judge: a path that is not there is not a report, a folder with none says so, and the others are still judged", async () => {
  const r = await once("LC-5");
  const missing = join(dirname(r.files.report), "nothing-here.json");
  const empty = mkdtempSync(join(tmpdir(), "jh-rejudge-empty-"));
  const lines: string[] = [];
  assert.equal(main([missing, empty, r.files.report], (l) => void lines.push(l)), 2);
  assert.deepEqual(lines.slice(0, 2), [`${missing}: not a report (no such file)`, `${empty}: no reports in it`]);
  assert.ok(lines.some((l) => /^  LC-5: pass /.test(l)), lines.join("\n"));
});

test("the sink is judged at the engine's own audible level, taken from the unrounded RMS when the frame is recorded", () => {
  // A constant PCM16 frame of `v` has an RMS of v / 32768. 218 is 0.006653 of full scale: kept as 0.0067, but x 3 is
  // under the engine's 0.02, so the engine does not hear it. 219 is 0.006683: x 3 clears 0.02.
  const pcm = (v: number): Buffer => Buffer.alloc(960 * 2).fill(Buffer.from(Int16Array.of(v).buffer));
  const under = sinkFrame(0, pcm(218));
  assert.deepEqual([under.rms, under.engineAudible, engineHears(under)], [0.0067, false, false], "the kept RMS rounds up; the verdict does not");
  const over = sinkFrame(0, pcm(219));
  assert.deepEqual([over.rms, over.engineAudible, engineHears(over)], [0.0067, true, true]);
  // Reports from before the verdict was kept: the kept RMS at the engine's level, then `audible`.
  assert.equal(engineHears({ t: 0, audible: false, ms: 10, rms: 0.0067 }), true, "0.0067 x 3 clears AUDIBLE_OUTPUT_LEVEL (0.02)");
  assert.equal(engineHears({ t: 0, audible: false, ms: 10, rms: 0.006 }), false);
  assert.equal(engineHears({ t: 0, audible: true, ms: 10 }), true);
  assert.equal(engineHears({ t: 0, audible: false, ms: 10 }), false);
});
