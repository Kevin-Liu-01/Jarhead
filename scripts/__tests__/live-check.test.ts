import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { LIVE_USD_PER_SECOND, MAX_CAP_USD, PLANS, findPlan, localDay, main, parseArgs, planSeconds, planUsd, readOpenAIKey, readSpend, runCheck, spendFile, spendFlagsRefusal, spendGate, spentToday, type Args, type SpendLine } from "../live-check.mts";

/**
 * W2-8, the live-check harness: the gates that keep a paid check inside its cap, the watchdog that
 * cuts a session at the check's own cap, and a dry run that never leaves the process. Nothing here
 * reads a key, opens a socket off this Mac, or spends: every run is `mode: "dry"` (the scripted
 * server in scripts/live-check.mts), and every live-mode call is one the gates refuse before a key
 * or a socket is touched.
 */

const out = (): string => mkdtempSync(join(tmpdir(), "jh-live-check-test-"));
/** The suite's wall-clock allowance (AGENTS.md): x3 on a GitHub runner, x1 on a Mac. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;
const plan = (name: string) => {
  const p = findPlan(name);
  assert.ok(p, name);
  return p;
};

test("the plan is the triage table: ten checks, their caps, under the $1.00 ceiling", () => {
  assert.deepEqual(
    PLANS.map((p) => `${p.id} ${p.name} ${p.capSeconds}`),
    ["LC-1 cadence 75", "LC-2 meter 120", "LC-3 append-cap 45", "LC-4 night 45", "LC-5 first-word 120", "LC-6 spoken-stop 90", "LC-7 room-talk 100", "LC-8 drop 90", "LC-9 delegate 60", "LC-10 speech-end 75"],
  );
  const total = PLANS.reduce((a, p) => a + planUsd(p), 0) + (planUsd(plan("LC-3"), { oversize: true }) - planUsd(plan("LC-3")));
  assert.ok(total <= MAX_CAP_USD, `the planned total ${total.toFixed(3)} fits the cap`);
  assert.equal(planSeconds(plan("LC-3"), { oversize: true }), 90, "--oversize adds LC-3's 45 s");
  assert.equal(findPlan("lc-10")?.name, "speech-end");
  assert.equal(findPlan("drop")?.id, "LC-8");
  assert.equal(findPlan("LC-11"), undefined, "LC-11 is Kevin's, with no session");
});

test("a live run refuses without --i-accept-spend, and with a --cap-usd over 1.00 (the default is 1.00)", () => {
  const parsed = (argv: string[]): Args => {
    const a = parseArgs(argv);
    assert.ok(!("error" in a), JSON.stringify(a));
    return a;
  };
  assert.match(spendFlagsRefusal(parsed(["LC-1"])) ?? "", /--i-accept-spend/);
  assert.match(spendFlagsRefusal(parsed(["LC-1", "--cap-usd", "1.00"])) ?? "", /--i-accept-spend/);
  assert.equal(spendFlagsRefusal(parsed(["LC-1", "--i-accept-spend"])), undefined, "--cap-usd defaults to $1.00");
  assert.match(spendFlagsRefusal(parsed(["LC-1", "--i-accept-spend", "--cap-usd", "1.01"])) ?? "", /at most 1\.00/);
  assert.match(spendFlagsRefusal(parsed(["LC-1", "--i-accept-spend", "--cap-usd", "0"])) ?? "", /above 0/);
  assert.match(spendFlagsRefusal(parsed(["LC-1", "--i-accept-spend", "--cap-usd", "lots"])) ?? "", /above 0/);
  assert.equal(spendFlagsRefusal(parsed(["LC-1", "--i-accept-spend", "--cap-usd", "1.00"])), undefined);
  assert.equal(spendFlagsRefusal(parsed(["LC-1", "--i-accept-spend", "--cap-usd", "0.25"])), undefined);
  assert.equal(spendFlagsRefusal(parsed(["LC-1", "--dry-run"])), undefined, "a dry run spends nothing and needs no flag");
  assert.ok("error" in parseArgs(["LC-1", "--scale", "0.1"]), "--scale is for dry runs");
  assert.ok("error" in parseArgs(["LC-1", "LC-2"]), "one check at a time");
  assert.ok("error" in parseArgs([]), "a check is named");
  for (const s of ["LC-1 --i-accept-spend --cap-usd 1.00 --sneaky"]) assert.ok("error" in parseArgs(s.split(" ")), "an unknown flag refuses");
});

test("the command line refuses before it reads a key: no flag, a cap over 1.00, an unknown check", async () => {
  const lines: string[] = [];
  const dir = out();
  assert.equal(await main(["LC-1", "--out", dir], (l) => lines.push(l)), 2);
  assert.match(lines.join("\n"), /opens a paid GPT-Live session/);
  assert.equal(await main(["LC-1", "--i-accept-spend", "--cap-usd", "2", "--out", dir], (l) => lines.push(l)), 2);
  assert.equal(await main(["LC-99", "--dry-run", "--out", dir], (l) => lines.push(l)), 2);
  assert.equal(await main(["list", "--out", dir], (l) => lines.push(l)), 0);
  assert.match(lines.at(-1) ?? "", /Planned total \d+ s/);
  assert.ok(!existsSync(spendFile(dir, "live")), "nothing was spent, nothing was written to the spend ledger");
});

test("the day's spend: ended runs count what they billed, a run that never ended counts its whole plan, other days nothing", () => {
  const day = localDay();
  const lines: SpendLine[] = [
    { at: 1, day, runId: "a", check: "LC-1", event: "start", planSeconds: 75, planUsd: 75 * LIVE_USD_PER_SECOND },
    { at: 2, day, runId: "a", check: "LC-1", event: "end", billedSeconds: 61, usd: 61 * LIVE_USD_PER_SECOND },
    { at: 3, day, runId: "b", check: "LC-2", event: "start", planSeconds: 120, planUsd: 120 * LIVE_USD_PER_SECOND },
    { at: 4, day: "1999-01-01", runId: "c", check: "LC-5", event: "start", planSeconds: 120, planUsd: 0.1 },
  ];
  const today = spentToday(lines, day);
  assert.equal(today.runs, 2);
  assert.equal(today.unended, 1);
  assert.ok(Math.abs(today.usd - (61 + 120) * LIVE_USD_PER_SECOND) < 1e-9);
  // 181 s spent; LC-7 plans 100 s + synthesis: fits a $1.00 cap, not a $0.20 one.
  assert.equal(spendGate(lines, plan("LC-7"), 1.0, { day }).ok, true);
  const refused = spendGate(lines, plan("LC-7"), 0.2, { day });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : "", /never ended; each counts its whole plan.*LC-7 plans \$0\.0\d\d.*The cap is \$0\.200/);
  // Nearly the whole dollar gone: even the smallest check is refused.
  const full: SpendLine[] = [
    { at: 1, day, runId: "z", check: "LC-2", event: "start", planSeconds: 1190, planUsd: 1190 * LIVE_USD_PER_SECOND },
    { at: 2, day, runId: "z", check: "LC-2", event: "end", billedSeconds: 1190, usd: 1190 * LIVE_USD_PER_SECOND },
  ];
  assert.equal(spendGate(full, plan("LC-3"), 1.0, { day }).ok, false);
});

test("a live run is refused by the spend ledger, and without a key, before any engine, key or socket", async () => {
  const dir = out();
  const day = localDay();
  writeFileSync(spendFile(dir, "live"), [{ at: 1, day, runId: "x", check: "LC-2", event: "start", planSeconds: 1150, planUsd: 1150 * LIVE_USD_PER_SECOND }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const printed: string[] = [];
  const before = readSpend(spendFile(dir, "live")).length;
  const r = await runCheck({ plan: plan("LC-1"), mode: "live", capUsd: 1.0, acceptSpend: true, out: dir, apiKey: "sk-never-used", print: (l) => printed.push(l) });
  assert.match(r.refused ?? "", /Today's checks spent \$0\.958 \(1 run\(s\) never ended.*LC-1 plans \$0\.063/);
  assert.equal(r.ran, false);
  assert.equal(r.net.length, 0, "nothing was asked of the network");
  assert.equal(readSpend(spendFile(dir, "live")).length, before, "a refused run writes no start line");
  const noAccept = await runCheck({ plan: plan("LC-1"), mode: "live", capUsd: 1.0, out: out(), apiKey: "sk-never-used", print: () => undefined });
  assert.match(noAccept.refused ?? "", /--i-accept-spend/, "runCheck itself refuses a live run nobody accepted");
  const noKey = await runCheck({ plan: plan("LC-1"), mode: "live", capUsd: 1.0, acceptSpend: true, out: out(), print: () => undefined });
  assert.match(noKey.refused ?? "", /No OpenAI key/);
  assert.ok(existsSync(r.files.report), "a refusal still leaves its report");
});

test("the key is the environment's, else the one OPENAI_API_KEY line of the state dir's env file", () => {
  const home = out();
  mkdirSync(join(home, ".jarhead"));
  writeFileSync(join(home, ".jarhead", "env"), "ANTHROPIC_API_KEY=sk-ant-other\nexport OPENAI_API_KEY='sk-file-key'\n");
  assert.deepEqual(readOpenAIKey({ OPENAI_API_KEY: "sk-env-key" }, home), { key: "sk-env-key", source: "the environment" });
  assert.equal(readOpenAIKey({}, home)?.key, "sk-file-key");
  assert.equal(readOpenAIKey({ JARHEAD_STATE_DIR: join(home, "elsewhere") }, home), undefined, "the state dir named is the one read");
});

test("the cap watchdog terminates the session at the check's cap, refuses another, and the ledger says so", async () => {
  const dir = out();
  const fetchBefore = globalThis.fetch;
  const wsBefore = globalThis.WebSocket;
  // LC-1 run whole bills about 3 s dry; cut at 1 s it must stop there.
  const r = await runCheck({ plan: plan("LC-1"), mode: "dry", capUsd: 1.0, out: dir, capSecondsOverride: 1, print: () => undefined });
  assert.equal(r.capHit, true, "cut at the cap");
  assert.equal(r.ran, false, "the scenario did not run to its end");
  assert.equal(r.pass, false);
  assert.equal(r.spend.checkCapSeconds, 1);
  const cap = r.marks.find((m) => m.name === "cap");
  assert.ok(cap, "the cap is marked");
  const atCut = Number(cap.data?.["billedSeconds"]);
  // The cut is never early, and lands on the cap but for the event loop's own lateness (up to a second at a load
  // average of 100, measured); from the cut on, nothing more is billed.
  assert.ok(atCut >= 1 && atCut <= 1 + RUNNER_SLACK, `cut at ${atCut} s against a 1 s cap`);
  assert.ok(r.spend.billedSeconds - atCut <= 0.2, `billed ${r.spend.billedSeconds} s, ${atCut} s at the cut`);
  for (const s of r.sessions) {
    assert.ok(s.closedT !== undefined, `session ${s.s} closed`);
    assert.ok(s.closedT! - cap!.t <= 100, `session ${s.s} closed ${s.closedT! - cap!.t} ms after the cap`);
    assert.equal(r.wire.server.filter((f) => f.s === s.s && f.t > s.closedT! + 50).length, 0, "no frame after the close");
  }
  assert.equal(r.sessions.filter((s) => s.createdT > cap!.t).length, 0, "no session opens after the cap");
  assert.equal(r.final.phase, "asleep", "and the engine is asleep");
  assert.equal(r.final.runnerAttached, false);
  const lines = readSpend(spendFile(dir, "dry"));
  assert.deepEqual(lines.map((l) => l.event), ["start", "end"]);
  assert.ok(Math.abs((lines[1]?.billedSeconds ?? 0) - r.spend.billedSeconds) < 1e-9);
  assert.ok(!existsSync(spendFile(dir, "live")), "a dry run never touches the live ledger");
  assert.equal(globalThis.fetch, fetchBefore, "the fetch fence is gone after the run");
  assert.equal(globalThis.WebSocket, wsBefore, "the WebSocket fence is gone after the run");
});

test("a dry run never connects: one key probe answered in process, nothing passed, no child process, the temp state only", async () => {
  const dir = out();
  const r = await runCheck({ plan: plan("LC-9"), mode: "dry", capUsd: 1.0, out: dir, print: () => undefined });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.ran, true);
  assert.deepEqual(
    r.net.filter((n) => n.verdict !== "answered"),
    [],
    "nothing left the process and nothing else was asked",
  );
  assert.ok(r.net.every((n) => /^GET https:\/\/api\.openai\.com\/v1\/models\//.test(n.what)), "the only request is the free key probe, answered by the fence");
  assert.deepEqual(r.spawns, [], "no child process: no helper, no brain, no shell");
  assert.equal(r.isolation.brain, "live-check-canned", "the canned brain, no model");
  assert.ok(resolve(r.isolation.stateDir).startsWith(resolve(tmpdir()) + sep), "the engine's state is a temp dir");
  assert.ok(r.isolation.socketPath.startsWith(r.isolation.stateDir));
  assert.ok(!existsSync(r.isolation.stateDir), "and it is gone after the run");
  assert.ok(r.hands.acting.length > 0, "the fake acting helper answered");
  assert.ok(r.sessions.length > 0 && r.sessions.every((s) => s.closedT !== undefined), "every session closed");
  const saved = JSON.parse(readFileSync(r.files.report, "utf8")) as { check: string; mode: string };
  assert.deepEqual([saved.check, saved.mode], ["LC-9", "dry"]);
  assert.ok(existsSync(r.files.log), "the engine's log sits beside the report");
});
