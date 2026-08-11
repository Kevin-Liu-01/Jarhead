export { createWorktree, disposeWorktree, readMarker, git, runGit, PROTECTED_BRANCHES } from "./worktree.ts";
export type { Worktree, WorktreeMarker, CreateWorktreeOptions, DisposeOptions, GitResult } from "./worktree.ts";

export {
  buildProposal,
  captureDiff,
  digestOfDiff,
  proposalHash,
  proposalPathFor,
  readProposal,
  toWikiProposal,
} from "./proposal.ts";
export type { SelfModProposal, BuildProposalRequest, DiffStats } from "./proposal.ts";

export { runGate, defaultRunner, GATE_COMMAND } from "./gate.ts";
export type { GateResult, RunGateOptions, CommandResult, CommandRunner } from "./gate.ts";

export {
  requestApproval,
  recordApproval,
  verifyApproval,
  approvalPathFor,
  isConsent,
  isRefusal,
  APPROVAL_TTL_MS,
  GateNotProvenError,
} from "./approval.ts";
export type { ApprovalReceipt, ApprovalRecord, RecordApprovalRequest } from "./approval.ts";

export { commitAndPush, PushRefusedError } from "./push.ts";
export type { PushOptions, PushResult } from "./push.ts";
