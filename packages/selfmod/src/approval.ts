import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isConsent, isRefusal } from "@jarvis/automations";
import { assertContract } from "@jarvis/wiki-bridge";
import { digestOfDiff, proposalHash, type SelfModProposal } from "./proposal.ts";
import type { GateResult } from "./gate.ts";

/**
 * Exact-hash approval (DECISION.md §7 steps 4–5).
 *
 * The wiki's rule, verbatim: "a standing auto-commit, auto-push, or auto-PR
 * preference does not count as exact approval." Consent here therefore binds
 * to one digest — the sha256 of the exact diff bytes Kevin was told about —
 * and to nothing else. A different diff, a different proposal, an edited
 * summary, or a stale receipt all verify false, and verifiers recompute the
 * digest from the bytes in hand rather than trusting any stored field.
 *
 * Receipts expire quickly for the same reason: an approval is one spoken
 * exchange, not a standing yes that survives until someone remembers to
 * revoke it.
 */

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Consent semantics are shared with @jarvis/automations: explicit affirmative only, ambiguity is refusal. */
export { isConsent, isRefusal };

/** Shape of the wiki's `approval-receipt` contract; validated with assertContract before persisting. */
export interface ApprovalReceipt {
  readonly schemaVersion: "1";
  readonly approvalId: string;
  readonly proposalId: string;
  readonly proposalHash: string;
  readonly subjectDigest: string;
  readonly decision: "approved" | "rejected";
  readonly decidedAt: string;
  readonly decidedBy: string;
  readonly authority: readonly string[];
  readonly expiresAt: string;
}

export interface ApprovalRecord {
  readonly receipt: ApprovalReceipt;
  /** Verbatim, because the receipt schema is closed and the exact words are the audit trail. */
  readonly spokenConsent: string;
}

export class GateNotProvenError extends Error {
  constructor(detail: string) {
    super(`cannot approve: ${detail}`);
    this.name = "GateNotProvenError";
  }
}

/**
 * A gate result only counts if it is green AND it proved these exact bytes.
 * Passing a stale green gate alongside an edited proposal must not work.
 */
function assertGateProves(proposal: SelfModProposal, gate: GateResult): void {
  if (gate.proposalId !== proposal.proposalId) {
    throw new GateNotProvenError(`gate ran for ${gate.proposalId}, not ${proposal.proposalId}`);
  }
  if (!gate.passed) {
    throw new GateNotProvenError(`the proof gate failed (exit ${gate.exitCode}) — a red proposal can never be approved`);
  }
  if (gate.digest !== digestOfDiff(proposal.diff)) {
    throw new GateNotProvenError("the gate proved different bytes than this proposal carries");
  }
}

/** The spoken prompt. Refuses to produce one at all for a proposal the gate has not proven. */
export function requestApproval(proposal: SelfModProposal, gate: GateResult): string {
  assertGateProves(proposal, gate);
  const { filesChanged, insertions, deletions } = proposal.stats;
  return (
    `patch ready, doctor green, digest ${proposal.digest.slice(0, 8)} — ` +
    `${proposal.summary.toLowerCase()}. ` +
    `touches ${filesChanged} file${filesChanged === 1 ? "" : "s"}, +${insertions} -${deletions}. approve?`
  );
}

export interface RecordApprovalRequest {
  readonly proposal: SelfModProposal;
  readonly gate: GateResult;
  /** What Kevin actually said, verbatim. */
  readonly spokenConsent: string;
  readonly stateDir: string;
  readonly now: Date;
  readonly decidedBy?: string;
}

export function approvalPathFor(stateDir: string, approvalId: string): string {
  return join(stateDir, "approvals", `${approvalId}.json`);
}

/**
 * Turn a spoken response into a receipt bound to the exact digest.
 *
 * Anything that is not an explicit affirmative — refusal, ambiguity, silence,
 * an unrecognized phrase — is recorded as `rejected` rather than dropped, so
 * the audit trail shows the refusal too. A failed gate throws instead: that
 * proposal is not allowed to reach the question.
 */
export function recordApproval(req: RecordApprovalRequest): ApprovalRecord {
  assertGateProves(req.proposal, req.gate);

  const decision = isConsent(req.spokenConsent) ? "approved" : "rejected";
  const receipt: ApprovalReceipt = {
    schemaVersion: "1",
    approvalId: `approval-${req.proposal.proposalId}-${req.now.getTime()}`,
    proposalId: req.proposal.proposalId,
    proposalHash: proposalHash(req.proposal),
    // Recomputed from the bytes, never copied from the proposal's own field.
    subjectDigest: digestOfDiff(req.proposal.diff),
    decision,
    decidedAt: req.now.toISOString(),
    decidedBy: req.decidedBy ?? "kevin (spoken)",
    authority: ["voice:spoken-consent", "gate:pnpm-run-check"],
    expiresAt: new Date(req.now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };

  assertContract("approval-receipt", receipt);

  const record: ApprovalRecord = { receipt, spokenConsent: req.spokenConsent };
  mkdirSync(join(req.stateDir, "approvals"), { recursive: true });
  writeFileSync(approvalPathFor(req.stateDir, receipt.approvalId), `${JSON.stringify(record, null, 2)}\n`);

  return record;
}

/**
 * Does this receipt authorize this proposal, right now?
 *
 * Returns false — never throws — on any mismatch, so callers cannot confuse
 * an error path with consent. The digest comparison recomputes from
 * `proposal.diff`: a proposal whose diff changed by one byte after approval
 * re-digests differently even if its `digest` field was updated to match.
 */
export function verifyApproval(proposal: SelfModProposal, receipt: ApprovalReceipt, now: Date = new Date()): boolean {
  try {
    assertContract("approval-receipt", receipt);
  } catch {
    return false;
  }
  if (receipt.decision !== "approved") return false;
  if (receipt.proposalId !== proposal.proposalId) return false;
  if (receipt.subjectDigest !== digestOfDiff(proposal.diff)) return false;
  if (receipt.proposalHash !== proposalHash(proposal)) return false;
  if (now.getTime() >= new Date(receipt.expiresAt).getTime()) return false;
  if (now.getTime() < new Date(receipt.decidedAt).getTime()) return false;
  return true;
}
