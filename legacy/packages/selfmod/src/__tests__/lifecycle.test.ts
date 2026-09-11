import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, disposeWorktree, git, runGit } from "../worktree.ts";
import { buildProposal, digestOfDiff, proposalPathFor, readProposal } from "../proposal.ts";
import { runGate } from "../gate.ts";
import { recordApproval } from "../approval.ts";
import { commitAndPush, PushRefusedError } from "../push.ts";
import { NOW, makeBareRemote, makeFixtureRepo, makeProposalScenario, makeStateDir, stubRunner } from "./helpers.ts";

/** End-to-end against real git: worktree isolation, proposal capture, gate binding, and the push refusals. */

test("edits in a worktree never touch the user's working tree", async () => {
  const repo = await makeFixtureRepo();
  const wt = await createWorktree("jarvis/isolated", { repoRoot: repo, now: NOW });

  writeFileSync(join(wt.path, "new-module.ts"), "export const shiny = true;\n");
  writeFileSync(join(wt.path, "app.ts"), "export const answer = 43;\n");

  assert.ok(!existsSync(join(repo, "new-module.ts")));
  assert.equal(await git(["status", "--porcelain"], repo), "", "the main tree stays pristine");
  assert.equal(await git(["rev-parse", "HEAD"], wt.path), wt.baseRef);
});

test("refuses to create a worktree on an existing branch", async () => {
  const repo = await makeFixtureRepo();
  await git(["branch", "taken"], repo);
  await assert.rejects(createWorktree("taken", { repoRoot: repo }), /already exists/);
});

test("refuses to create a worktree on a default branch name", async () => {
  const repo = await makeFixtureRepo();
  await assert.rejects(createWorktree("main", { repoRoot: repo }), /default branch/);
  await assert.rejects(createWorktree("master", { repoRoot: repo }), /default branch/);
});

test("refuses to dispose a directory it did not create", async () => {
  const stranger = mkdtempSync(join(tmpdir(), "jarvis-selfmod-stranger-"));
  await assert.rejects(disposeWorktree(stranger), /no selfmod marker/);
});

test("dispose preserves uncommitted work unless forced", async () => {
  const repo = await makeFixtureRepo();
  const wt = await createWorktree("jarvis/dirty", { repoRoot: repo, now: NOW });
  writeFileSync(join(wt.path, "app.ts"), "export const answer = 43;\n");

  await assert.rejects(disposeWorktree(wt.path), /uncommitted changes/);
  assert.ok(existsSync(join(wt.path, "app.ts")), "the refusal left the work in place");

  await disposeWorktree(wt.path, { force: true });
  assert.ok(!existsSync(wt.path));
  const branch = await runGit(["rev-parse", "--verify", "--quiet", "refs/heads/jarvis/dirty"], repo);
  assert.notEqual(branch.code, 0, "the disposable branch is gone too");
});

test("buildProposal captures modified AND newly created files, and persists", async () => {
  const { proposal, stateDir } = await makeProposalScenario((p) => {
    writeFileSync(join(p, "app.ts"), "export const answer = 43;\n");
    writeFileSync(join(p, "brand-new.ts"), "export const created = true;\n");
  });

  assert.deepEqual([...proposal.files].sort(), ["app.ts", "brand-new.ts"]);
  assert.match(proposal.diff, /brand-new\.ts/, "a diff blind to new files would approve bytes Kevin never saw");
  assert.equal(proposal.digest, digestOfDiff(proposal.diff));
  assert.equal(proposal.stats.filesChanged, 2);

  assert.ok(existsSync(proposalPathFor(stateDir, proposal.proposalId)));
  const restored = readProposal(stateDir, proposal.proposalId);
  assert.equal(digestOfDiff(restored.diff), proposal.digest, "digest survives the disk round-trip");
});

test("an unchanged worktree has nothing to propose", async () => {
  const repo = await makeFixtureRepo();
  const wt = await createWorktree("jarvis/noop", { repoRoot: repo, now: NOW });
  await assert.rejects(
    buildProposal({ worktreePath: wt.path, summary: "nothing", stateDir: makeStateDir(), now: NOW }),
    /nothing to propose/,
  );
});

test("identical edits produce identical digests across independent worktrees", async () => {
  const edit = (p: string): void => writeFileSync(join(p, "app.ts"), "export const answer = 43;\n");
  const a = await makeProposalScenario(edit, "jarvis/twin-a");
  const b = await makeProposalScenario(edit, "jarvis/twin-b");
  assert.equal(a.proposal.digest, b.proposal.digest);

  const c = await makeProposalScenario(
    (p) => writeFileSync(join(p, "app.ts"), "export const answer = 44;\n"),
    "jarvis/twin-c",
  );
  assert.notEqual(a.proposal.digest, c.proposal.digest);
});

test("the gate binds pass/fail to the proposal's exact bytes", async () => {
  const { proposal } = await makeProposalScenario();

  const green = stubRunner(0);
  const passed = await runGate(proposal, { runner: green.runner });
  assert.ok(passed.passed);
  assert.equal(passed.digest, proposal.digest);
  assert.deepEqual(green.calls, ["pnpm run check"]);

  const red = stubRunner(1);
  const failed = await runGate(proposal, { runner: red.runner });
  assert.ok(!failed.passed);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /failing/);
});

test("the gate refuses to certify a worktree that drifted from the proposal", async () => {
  const { proposal } = await makeProposalScenario();
  appendFileSync(join(proposal.worktreePath, "app.ts"), "// drifted\n");

  const green = stubRunner(0);
  const result = await runGate(proposal, { runner: green.runner });
  assert.ok(!result.passed, "a green check of the wrong bytes proves nothing");
  assert.notEqual(result.digest, proposal.digest);
  assert.deepEqual(green.calls, [], "the check was never even run");
});

test("dry-run is the default and performs no mutation", async () => {
  const { proposal, stateDir } = await makeProposalScenario();
  const gate = await runGate(proposal, { runner: stubRunner(0).runner });
  const { receipt } = recordApproval({ proposal, gate, spokenConsent: "go for it", stateDir, now: NOW });
  const remote = await makeBareRemote();

  const result = await commitAndPush(proposal, receipt, { remote, now: NOW });

  assert.equal(result.dryRun, true);
  assert.equal(result.pushed, false);
  assert.equal(result.commitSha, undefined);
  assert.equal(await git(["rev-parse", "HEAD"], proposal.worktreePath), proposal.baseRef, "no commit was created");
  const refs = await git(["for-each-ref"], remote);
  assert.equal(refs, "", "nothing reached the remote");
});

test("a real push lands the proposal branch on the remote, never a default branch", async () => {
  const { proposal, stateDir } = await makeProposalScenario();
  const gate = await runGate(proposal, { runner: stubRunner(0).runner });
  const { receipt } = recordApproval({ proposal, gate, spokenConsent: "go for it", stateDir, now: NOW });
  const remote = await makeBareRemote();

  const result = await commitAndPush(proposal, receipt, { remote, now: NOW, dryRun: false });

  assert.equal(result.pushed, true);
  assert.ok(result.commitSha);
  assert.equal(await git(["rev-parse", `refs/heads/${proposal.branch}`], remote), result.commitSha);
  const main = await runGit(["rev-parse", "--verify", "--quiet", "refs/heads/main"], remote);
  assert.notEqual(main.code, 0, "the remote's default branch was never written");
});

test("a worktree changed after approval refuses to push", async () => {
  const { proposal, stateDir } = await makeProposalScenario();
  const gate = await runGate(proposal, { runner: stubRunner(0).runner });
  const { receipt } = recordApproval({ proposal, gate, spokenConsent: "go for it", stateDir, now: NOW });
  const remote = await makeBareRemote();

  // The bytes Kevin approved are no longer the bytes that would ship.
  appendFileSync(join(proposal.worktreePath, "app.ts"), "// sneaky post-approval edit\n");

  await assert.rejects(
    commitAndPush(proposal, receipt, { remote, now: NOW, dryRun: false }),
    PushRefusedError,
  );
  const refs = await git(["for-each-ref"], remote);
  assert.equal(refs, "", "the refused push mutated nothing");
});

test("a rejected receipt cannot push, even with dryRun disabled", async () => {
  const { proposal, stateDir } = await makeProposalScenario();
  const gate = await runGate(proposal, { runner: stubRunner(0).runner });
  const { receipt } = recordApproval({ proposal, gate, spokenConsent: "hmm, maybe", stateDir, now: NOW });
  const remote = await makeBareRemote();

  await assert.rejects(
    commitAndPush(proposal, receipt, { remote, now: NOW, dryRun: false }),
    PushRefusedError,
  );
});

test("an expired receipt cannot push", async () => {
  const { proposal, stateDir } = await makeProposalScenario();
  const gate = await runGate(proposal, { runner: stubRunner(0).runner });
  const { receipt } = recordApproval({ proposal, gate, spokenConsent: "go for it", stateDir, now: NOW });
  const remote = await makeBareRemote();

  const later = new Date(NOW.getTime() + 60 * 60 * 1000);
  await assert.rejects(
    commitAndPush(proposal, receipt, { remote, now: later, dryRun: false }),
    PushRefusedError,
  );
});

test("a flag-shaped remote is refused, but real remotes are not", async () => {
  const { assertRemoteName } = await import("../push.ts");
  // The remote is git push's first positional argument and git offers no `--`
  // separator there, so an option-shaped value would execute.
  assert.throws(() => assertRemoteName("--receive-pack=/bin/sh"), /leading dash/);
  assert.throws(() => assertRemoteName("-o"), /leading dash/);
  assert.throws(() => assertRemoteName("   "), /empty/);
  // Everything git legitimately accepts as a destination must still work.
  assert.doesNotThrow(() => assertRemoteName("origin"));
  assert.doesNotThrow(() => assertRemoteName("/var/folders/tmp/jarvis-remote-AbC"));
  assert.doesNotThrow(() => assertRemoteName("git@github.com:Kevin-Liu-01/jarvis.git"));
  assert.doesNotThrow(() => assertRemoteName("https://github.com/Kevin-Liu-01/jarvis.git"));
});

test("disposeWorktree accepts the object createWorktree returned, not just a path", async () => {
  const { createWorktree, disposeWorktree } = await import("../worktree.ts");
  const wt = await createWorktree(`jarvis/dispose-shape-${Date.now()}`);
  // The asymmetry is a trap: cleanup lives in a finally block, so a surprise
  // throw here would leak the worktree and hide the original error.
  await assert.doesNotReject(() => disposeWorktree(wt, { force: true }));
});
