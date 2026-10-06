import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { engineHears } from "../live-check.mts";
import { main, rejudge, type SavedReport } from "../rejudge.mts";
import { dryRun } from "./live-check-w2-8-dry.ts";

/**
 * F3: scripts/rejudge.mts judges a saved report again with this checkout's judges, for free. A report must judge the
 * same from its JSON as it did in its run, and a judge that reads a field the report does not keep must say which.
 */

const saved = (file: string): SavedReport => JSON.parse(readFileSync(file, "utf8")) as SavedReport;
/** As JSON keeps it: NaN and Infinity become null, undefined fields go. */
const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

test("a dry run's report, judged again from its JSON, gives the run's own assertions and metrics", async () => {
  for (const check of ["LC-2", "LC-5", "LC-9", "LC-10"]) {
    const r = await dryRun(check);
    const again = rejudge(saved(r.files.report));
    assert.equal(again.notKept, undefined, `${check}: every field its judge reads is kept`);
    assert.deepEqual(again.notes, [], `${check}: nothing approximated`);
    assert.deepEqual(asJson(again.assertions), asJson(r.assertions), `${check}: the same assertions`);
    assert.deepEqual(asJson(again.metrics), asJson(r.metrics), `${check}: the same metrics`);
    assert.equal(again.pass, r.pass);
  }
});

test("a judge that reads a field the report does not keep stops there, names the field, and the command line says so", async () => {
  const r = await dryRun("LC-10");
  const { delegations: _dropped, ...older } = saved(r.files.report);
  const again = rejudge(older);
  assert.equal(again.notKept, "snapshot.delegations");
  assert.equal(again.pass, false);
  writeFileSync(r.files.report, JSON.stringify(older));
  const lines: string[] = [];
  assert.equal(main([r.files.report], (l) => void lines.push(l)), 2);
  assert.ok(lines.includes("  not re-judgeable: snapshot.delegations"), lines.join("\n"));
});

test("the sink is judged at the engine's own audible level, and a frame kept without its RMS falls back to `audible`", () => {
  assert.equal(engineHears({ t: 0, audible: false, ms: 10, rms: 0.0067 }), true, "0.0067 x 3 clears AUDIBLE_OUTPUT_LEVEL (0.02)");
  assert.equal(engineHears({ t: 0, audible: false, ms: 10, rms: 0.006 }), false);
  assert.equal(engineHears({ t: 0, audible: true, ms: 10 }), true);
  assert.equal(engineHears({ t: 0, audible: false, ms: 10 }), false);
});
