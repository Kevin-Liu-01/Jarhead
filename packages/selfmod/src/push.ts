import { captureDiff, digestOfDiff, type SelfModProposal } from "./proposal.ts";
import { verifyApproval, type ApprovalReceipt } from "./approval.ts";
import { git, readMarker, runGit, PROTECTED_BRANCHES } from "./worktree.ts";

/**
 * The only place selfmod touches a remote, and it is built to refuse.
 *
 * Order matters: the approval is verified against the receipt, then the LIVE
 * worktree is re-diffed and re-digested — not the proposal object, which
 * could be stale — before any ref moves. dryRun defaults to true so the
 * mutating path is opt-in twice: once by Kevin's spoken approval, once by the
 * caller explicitly asking for a real push.
 *
 * Force pushes are unrepresentable rather than forbidden: the refspec is
 * constructed here from a validated branch name, never taken from input, so
 * there is no way to smuggle in `--force` or a leading `+`.
 */

export class PushRefusedError extends Error {
  constructor(reason: string) {
    super(`push refused: ${reason}`);
    this.name = "PushRefusedError";
  }
}

export interface PushOptions {
  readonly remote?: string;
  /** Defaults to TRUE. A real push requires an explicit false. */
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface PushResult {
  readonly dryRun: boolean;
  readonly branch: string;
  readonly remote: string;
  readonly digest: string;
  readonly commitSha: string | undefined;
  readonly pushed: boolean;
}

const GIT_IDENTITY = ["-c", "user.name=jarvis-selfmod", "-c", "user.email=jarvis-selfmod@localhost"] as const;

export async function commitAndPush(
  proposal: SelfModProposal,
  receipt: ApprovalReceipt,
  opts: PushOptions = {},
): Promise<PushResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? true;
  const remote = opts.remote ?? "origin";

  if (!verifyApproval(proposal, receipt, now)) {
    throw new PushRefusedError(
      "the approval does not cover these exact bytes (changed diff, different proposal, rejected, or expired)",
    );
  }

  const marker = readMarker(proposal.worktreePath);
  if (marker.branch !== proposal.branch) {
    throw new PushRefusedError(`worktree is on "${marker.branch}" but the proposal was built on "${proposal.branch}"`);
  }
  if (PROTECTED_BRANCHES.has(proposal.branch)) {
    throw new PushRefusedError(`"${proposal.branch}" is a default branch; proposals ship on their own branch`);
  }

  // The receipt bound consent to a digest; the tree may have moved since.
  // What gets committed is the live tree, so the live tree is what must match.
  const currentDiff = await captureDiff(proposal.worktreePath, marker.baseRef);
  if (digestOfDiff(currentDiff) !== receipt.subjectDigest) {
    throw new PushRefusedError("the worktree changed after approval — re-propose and re-approve");
  }

  if (dryRun) {
    return {
      dryRun: true,
      branch: proposal.branch,
      remote,
      digest: receipt.subjectDigest,
      commitSha: undefined,
      pushed: false,
    };
  }

  // `captureDiff` above already staged everything, so committing the index
  // commits exactly the verified bytes. If a previous attempt got as far as
  // committing before the push failed, the index matches HEAD — reuse that
  // commit instead of erroring on "nothing to commit".
  const staged = await runGit(["diff", "--cached", "--quiet", "HEAD"], proposal.worktreePath);
  let commitSha: string;
  if (staged.code === 0) {
    const head = await git(["rev-parse", "HEAD"], proposal.worktreePath);
    if (head === marker.baseRef) throw new PushRefusedError("nothing to commit");
    commitSha = head;
  } else {
    const message = [
      proposal.summary.split("\n")[0]?.slice(0, 72) ?? "selfmod proposal",
      "",
      `Proposal: ${proposal.proposalId}`,
      `Digest: ${receipt.subjectDigest}`,
      `Approval: ${receipt.approvalId}`,
    ].join("\n");
    await git([...GIT_IDENTITY, "commit", "-m", message], proposal.worktreePath);
    commitSha = await git(["rev-parse", "HEAD"], proposal.worktreePath);
  }

  await git(["push", remote, `HEAD:refs/heads/${proposal.branch}`], proposal.worktreePath);

  return {
    dryRun: false,
    branch: proposal.branch,
    remote,
    digest: receipt.subjectDigest,
    commitSha,
    pushed: true,
  };
}
