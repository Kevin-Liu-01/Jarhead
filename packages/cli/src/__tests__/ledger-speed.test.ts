import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import type { Delegation, DelegationStep, LedgerRow } from "@jarhead/protocol";
import { analyzeSpeed, ledgerSpeed, recentDays, renderSpeed, toolClass } from "../ledger-speed.ts";

/**
 * `jarhead ledger --speed` over a hand-built day: the acting→screenshot share, the
 * observation share, the first-tool histogram, the yes count, the generation gaps by
 * what came before them, the round trips by tool class, and the thread rows — each
 * against a number worked out by hand from the fixture.
 */

const T0 = Date.parse("2026-09-12T10:00:00.000Z");
let stepSeq = 0;
const step = (at: number, name: string, over: { ok?: boolean; ms?: number; output?: string; kind?: DelegationStep["kind"]; text?: string } = {}): DelegationStep => ({
  id: `s${++stepSeq}`,
  at,
  kind: over.kind ?? (name === "screenshot" || name === "zoom" ? "screenshot" : "tool"),
  ...(over.text ? { text: over.text } : {}),
  tool: { name, input: {}, ok: over.ok ?? true, ms: over.ms ?? 50, ...(over.output !== undefined ? { output: over.output } : {}) },
});

function delegation(id: string, at: number, request: string, steps: DelegationStep[], timings: Partial<Delegation["timings"]> & { firstActionAt?: number; speechEndAt?: number } = {}): LedgerRow[] {
  const d: Delegation = { id, liveId: `live_${id}`, createdAt: at, offsetMs: 0, request, status: "running", steps: [], timings: { delegatedAt: at } };
  const rows: LedgerRow[] = [{ at, type: "delegation.created", delegation: d }];
  for (const s of steps) rows.push({ at: s.at, type: "delegation.step", delegationId: id, step: s });
  const last = steps[steps.length - 1]?.at ?? at;
  rows.push({ at: last + 500, type: "delegation.finished", delegationId: id, status: "done", timings: { delegatedAt: at, doneAt: last + 500, ...timings } });
  return rows;
}

function fixture(): LedgerRow[] {
  const rows: LedgerRow[] = [];
  // D1: eyes' shot, click (observed), screenshot 5 s later (a verification shot), click, done. Speech ended 400 ms before.
  rows.push(
    ...delegation("d1", T0, "jarhead click the save button", [
      step(T0 + 100, "screenshot", { text: "looking", ms: 90 }),
      step(T0 + 4200, "left_click", { ms: 60, output: "OK\nnow: Finder — \"Desktop\"; focused: AXButton \"Save\"; 150 ms after the click" }),
      step(T0 + 9500, "screenshot", { ms: 120 }),
      step(T0 + 14000, "left_click", { ms: 70, output: "OK" }),
    ], { firstActionAt: T0 + 4200, speechEndAt: T0 - 400 }),
  );
  // D2: a bare yes; the brain re-runs a click at once (no gap), then reads the focused text (read-only, fast).
  rows.push(
    ...delegation("d2", T0 + 30_000, "yes", [
      step(T0 + 30_000 + 3900, "left_click", { ms: 55, output: "OK" }),
      step(T0 + 30_000 + 4000, "read_focused_text", { ms: 12, output: "AXTextField hello" }),
    ], { firstActionAt: T0 + 30_000 + 3900 }),
  );
  // D3: a look-first task: frontmost, then a shell command 4 s later (other class), no action.
  rows.push(
    ...delegation("d3", T0 + 60_000, "jarhead what is running", [
      step(T0 + 60_000 + 3800, "frontmost_app", { ms: 8, output: "{\"app\":\"Finder\"}" }),
      step(T0 + 60_000 + 8000, "run_shell", { ms: 1200, output: "node 24" }),
    ]),
  );
  // Threads: one started and ended.
  rows.push({ at: T0 + 90_000, type: "thread.started", thread: { id: "t_1", name: "Spotify", lane: "background", status: "starting", task: "play Focus", apps: [], startedAt: T0 + 90_000, updatedAt: T0 + 90_000, turns: 1, steps: 0, waits: 0, budget: { steps: 25, seconds: 180 }, canSay: true, canStop: true } });
  rows.push({ at: T0 + 102_000, type: "thread.ended", threadId: "t_1", status: "done", summary: "playing Focus", steps: 4, seconds: 12 });
  return rows;
}

test("ledger --speed: the counters come out as worked by hand", () => {
  const r = analyzeSpeed(fixture(), ["2026-09-12"]);
  assert.equal(r.delegations, 3);
  assert.equal(r.finished, 3);
  // Acting steps (the delegator's ACTING_TOOLS: the hands' acting members, shell, files, browser, overlays): d1's two clicks, d2's click, d3's shell = 4;
  // d1's first click is followed by a screenshot; only it carries a now: line.
  assert.deepEqual(r.acting, { steps: 4, thenShot: 1, shotShare: 0.25 });
  assert.deepEqual(r.observed, { steps: 4, withLine: 1, share: 0.25 });
  assert.equal(r.yesDelegations, 1);
  // The eyes' shot is not a model tool: d1's first model tool is the click.
  assert.deepEqual(r.firstTool, [{ tool: "left_click", n: 2 }, { tool: "frontmost_app", n: 1 }]);
  // Gaps > 1.5 s: d1 click→shot 5300 (after an action), shot→click 4500 (after a shot); d2 none (100 ms); d3 frontmost→shell 4200 (other).
  assert.deepEqual([r.gaps.afterAction.n, r.gaps.afterAction.median], [1, 5300]);
  assert.deepEqual([r.gaps.afterShot.n, r.gaps.afterShot.median], [1, 4500]);
  assert.deepEqual([r.gaps.other.n, r.gaps.other.median], [1, 4200]);
  // Round trips by class: read-only = d1's verification shot 120, d2's focused text 12, d3's frontmost 8 (the eyes' shot is excluded); acting = 60, 70, 55 and the shell's 1200 (nearest-rank median of four = the second); other = none here.
  assert.deepEqual([r.roundTrip.readOnly.n, r.roundTrip.readOnly.median, r.roundTrip.readOnly.p95], [3, 12, 120]);
  assert.deepEqual([r.roundTrip.acting.n, r.roundTrip.acting.median, r.roundTrip.acting.p95], [4, 60, 1200]);
  assert.equal(r.roundTrip.other.n, 0);
  // First action: d1 4200, d2 3900 → median 3900 (nearest rank of two); speech end → action only where speechEndAt is stamped (d1: 4600).
  assert.deepEqual([r.firstActionMs.n, r.firstActionMs.median], [2, 3900]);
  assert.deepEqual([r.speechToActionMs.n, r.speechToActionMs.median], [1, 4600]);
  assert.deepEqual([r.threads.started, r.threads.ended, r.threads.seconds.median, r.threads.steps.median], [1, 1, 12_000, 4]);
  const lines = renderSpeed(r);
  assert.match(lines[0] ?? "", /^  speed over 2026-09-12: 3 delegations \(3 finished\)$/);
  assert.match(lines.find((l) => l.includes("acting step → screenshot next")) ?? "", /1\/4 \(25 %\)/);
  assert.match(lines.find((l) => l.includes("now: line")) ?? "", /1\/4 \(25 %\)/);
  assert.match(lines.find((l) => l.includes("read-only")) ?? "", /median 12 ms · p95 120 ms \(n=3\)/);
  assert.match(lines.find((l) => l.startsWith("  threads")) ?? "", /1 started, 1 ended; wall 12\.0 s median, 4 steps median/);
});

test("ledger --speed: an empty day renders dashes and no thread line noise; the tool classes are the toolset's", () => {
  const r = analyzeSpeed([], ["2026-09-01"]);
  assert.equal(r.delegations, 0);
  const lines = renderSpeed(r);
  assert.match(lines[0] ?? "", /0 delegations \(0 finished\)/);
  assert.ok(lines.every((l) => !l.includes("NaN")), "no NaN reaches the terminal");
  assert.ok(lines.some((l) => /threads\s+none spawned/.test(l)));
  assert.deepEqual(["screenshot", "frontmost_app", "read_file"].map(toolClass), ["readOnly", "readOnly", "readOnly"]);
  assert.deepEqual(["left_click", "type", "applescript", "browser_navigate", "run_shell"].map(toolClass), ["acting", "acting", "acting", "acting", "acting"]);
  assert.equal(toolClass("show_circle"), "readOnly", "the overlays are read-only to the toolset (no hands) though they stamp firstActionAt — the toolset's class wins for round trips");
  assert.equal(toolClass("web_fetch"), "readOnly", "reads of the web are read-only to the toolset");
  assert.deepEqual(["agent_send", "speak_progress", "worker_start"].map(toolClass), ["other", "other", "other"]);
});

test("ledger --speed --days N reads the last N day files of a ledger, oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "jh-speed-"));
  try {
    const ledger = new Ledger(dir);
    const day = (d: string): number => Date.parse(`${d}T12:00:00`);
    for (const d of ["2026-09-08", "2026-09-10", "2026-09-11", "2026-09-12"]) {
      // Ids are unique across days on a real ledger; suffix the fixture's so the days do not fold into one.
      for (const row of fixture()) ledger.append(JSON.parse(JSON.stringify({ ...row, at: day(d) + (row.at - T0) }).replaceAll('"d1"', `"d1-${d}"`).replaceAll('"d2"', `"d2-${d}"`).replaceAll('"d3"', `"d3-${d}"`).replaceAll('"t_1"', `"t_1-${d}"`)) as LedgerRow);
    }
    assert.deepEqual(recentDays(ledger, 2), ["2026-09-11", "2026-09-12"]);
    assert.deepEqual(recentDays(ledger, 0), ["2026-09-12"], "at least today");
    const r = ledgerSpeed(ledger, 3);
    assert.deepEqual(r.days, ["2026-09-10", "2026-09-11", "2026-09-12"]);
    assert.equal(r.delegations, 9, "three days of the fixture");
    assert.equal(r.threads.started, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
