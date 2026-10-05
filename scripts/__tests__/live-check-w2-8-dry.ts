import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { findPlan, runCheck, type Report, type RunOptions } from "../live-check.mts";

/**
 * One check run dry (W2-8): the scripted GPT-Live stand-in, fake hands, the canned brain, a temp
 * state dir. What every dry run must show, whatever the check: it ran to its end inside its cap,
 * nothing left the process (the one key probe is answered by the fence), no child process ran, the
 * engine's state was a temp dir and is gone, every session closed, and the engine is asleep.
 */
/** The suite's wall-clock allowance (AGENTS.md): x3 on a GitHub runner, x1 on a Mac. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

export async function dryRun(name: string, extra: Pick<RunOptions, "dryFaults" | "oversize"> = {}): Promise<Report> {
  const plan = findPlan(name);
  assert.ok(plan, name);
  const out = mkdtempSync(join(tmpdir(), "jh-live-check-dry-"));
  const t0 = Date.now();
  const r = await runCheck({ plan, mode: "dry", capUsd: 1.0, out, slack: RUNNER_SLACK, ...extra, print: () => undefined });
  const hard = r.assertions.filter((a) => !a.soft);
  console.log(`[measure] ${plan.id} ${plan.name} dry${extra.dryFaults ? ` (faults ${JSON.stringify(extra.dryFaults)})` : ""}: ${r.pass ? "pass" : "fail"} ${hard.filter((a) => a.pass).length}/${hard.length} in ${Date.now() - t0} ms; billed ${r.spend.billedSeconds.toFixed(1)} s (simulated)`);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.ran, true, `${plan.id} ran to its end`);
  assert.equal(r.capHit, false, "inside its cap");
  assert.equal(r.ceilingHit, false);
  assert.ok(r.spend.billedSeconds < r.spend.checkCapSeconds, `billed ${r.spend.billedSeconds} s of ${r.spend.checkCapSeconds}`);
  assert.deepEqual(
    r.net.filter((n) => n.verdict !== "answered" || !/^GET https:\/\/api\.openai\.com\/v1\/models\//.test(n.what)),
    [],
    "nothing left the process: the key probe is answered in it, and nothing else was asked",
  );
  assert.deepEqual(r.spawns, [], "no child process: no helper, no brain, no shell");
  assert.equal(r.isolation.brain, "live-check-canned");
  assert.ok(resolve(r.isolation.stateDir).startsWith(resolve(tmpdir()) + sep), "the engine's state is a temp dir");
  assert.ok(!existsSync(r.isolation.stateDir), "and it is gone");
  assert.ok(r.sessions.length > 0, "a session opened");
  assert.ok(r.sessions.every((s) => s.closedT !== undefined), "every session closed");
  assert.equal(r.final.phase, "asleep");
  assert.ok(r.wire.server.length > 0 && r.wire.client.length > 0, "the wire was recorded both ways");
  assert.ok(existsSync(r.files.report));
  return r;
}

/** The assertion of that name (it must exist: a judge that stops judging fails here, not silently). */
export function assertion(r: Report, name: RegExp): Report["assertions"][number] {
  const found = r.assertions.filter((a) => name.test(a.name));
  assert.ok(found.length > 0, `${r.check}: an assertion matching ${name}`);
  return found[0]!;
}

/** Every assertion matching `name`, and whether all of them passed. */
export function assertions(r: Report, name: RegExp): { readonly all: Report["assertions"]; readonly pass: boolean } {
  const all = r.assertions.filter((a) => name.test(a.name));
  assert.ok(all.length > 0, `${r.check}: assertions matching ${name}`);
  return { all, pass: all.every((a) => a.pass) };
}

/** The hard assertions, all passing (a failing one is named with its value). */
export function allPass(r: Report): void {
  const failed = r.assertions.filter((a) => !a.soft && !a.pass);
  assert.deepEqual(
    failed.map((a) => `${a.name}: ${JSON.stringify(a.value)}`),
    [],
    `${r.check} dry: every hard assertion passes`,
  );
  assert.equal(r.pass, true);
}
