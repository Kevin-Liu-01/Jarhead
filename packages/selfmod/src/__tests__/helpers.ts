import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, git, type Worktree } from "../worktree.ts";
import { buildProposal, type SelfModProposal } from "../proposal.ts";
import type { CommandResult, CommandRunner, GateResult } from "../gate.ts";

/**
 * Every scenario here runs against a real throwaway git repo in tmpdir, not a
 * mock: the refusals under test are enforced by real git behavior (worktrees,
 * refs, bare remotes), so faking git would test nothing.
 */

export const NOW = new Date("2026-08-11T00:00:00.000Z");

const GIT_IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@localhost"] as const;

export async function makeFixtureRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-selfmod-fixture-"));
  await git(["init", "-b", "main"], dir);
  writeFileSync(join(dir, "app.ts"), "export const answer = 42;\n");
  await git(["add", "-A"], dir);
  await git([...GIT_IDENTITY, "commit", "-m", "initial"], dir);
  return dir;
}

export async function makeBareRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-selfmod-remote-"));
  await git(["init", "--bare", "-b", "main"], dir);
  return dir;
}

export function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-selfmod-state-"));
}

export interface Scenario {
  readonly repo: string;
  readonly wt: Worktree;
  readonly stateDir: string;
  readonly proposal: SelfModProposal;
}

/** Fresh repo → worktree → edit → proposal, the front half of the pipeline. */
export async function makeProposalScenario(
  mutate: (worktreePath: string) => void = (p) => writeFileSync(join(p, "app.ts"), "export const answer = 43;\n"),
  branch = "jarvis/proposal",
): Promise<Scenario> {
  const repo = await makeFixtureRepo();
  const wt = await createWorktree(branch, { repoRoot: repo, now: NOW });
  mutate(wt.path);
  const stateDir = makeStateDir();
  const proposal = await buildProposal({
    worktreePath: wt.path,
    summary: "Bump the answer",
    stateDir,
    now: NOW,
  });
  return { repo, wt, stateDir, proposal };
}

export interface StubRunner {
  readonly runner: CommandRunner;
  readonly calls: string[];
}

export function stubRunner(code: number): StubRunner {
  const calls: string[] = [];
  const result: CommandResult =
    code === 0
      ? { code, stdout: "typecheck ok\ntests ok\ndoctor ok\n", stderr: "" }
      : { code, stdout: "", stderr: "1 failing test\n" };
  return {
    calls,
    runner: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return result;
    },
  };
}

/** A hand-built green gate result for approval-layer tests that need no worktree. */
export function passedGateFor(proposal: SelfModProposal): GateResult {
  return {
    proposalId: proposal.proposalId,
    digest: proposal.digest,
    passed: true,
    exitCode: 0,
    command: "pnpm run check",
    output: "all green",
    startedAt: NOW.toISOString(),
    durationMs: 1,
  };
}
