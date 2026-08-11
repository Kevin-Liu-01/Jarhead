import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { digestOfDiff, type SelfModProposal } from "../proposal.ts";
import {
  APPROVAL_TTL_MS,
  approvalPathFor,
  GateNotProvenError,
  recordApproval,
  requestApproval,
  verifyApproval,
} from "../approval.ts";
import type { GateResult } from "../gate.ts";
import { NOW, makeStateDir, passedGateFor } from "./helpers.ts";

/**
 * The value of this package is entirely in its refusals, so these tests are
 * adversarial: each one plays an attack (tamper, replay, ambiguity, stale
 * yes) and asserts it is refused.
 */

function fakeProposal(diff: string, proposalId = "selfmod-2026-08-11-aaaaaaaaaaaa"): SelfModProposal {
  return {
    schemaVersion: "1",
    proposalId,
    summary: "Bump the answer",
    diff,
    digest: digestOfDiff(diff),
    files: ["app.ts"],
    createdAt: NOW.toISOString(),
    stats: { filesChanged: 1, insertions: 1, deletions: 1 },
    baseRef: "0".repeat(40),
    branch: "jarvis/fake",
    worktreePath: "/nonexistent",
  };
}

const DIFF_A = "--- a/app.ts\n+++ b/app.ts\n-42\n+43\n";
const DIFF_B = "--- a/app.ts\n+++ b/app.ts\n-42\n+44\n";

test("digest is stable for identical diffs and moves on a one-byte change", () => {
  assert.equal(digestOfDiff(DIFF_A), digestOfDiff(DIFF_A));
  assert.match(digestOfDiff(DIFF_A), /^[a-f0-9]{64}$/);
  assert.notEqual(digestOfDiff(DIFF_A), digestOfDiff(`${DIFF_A} `));
  assert.notEqual(digestOfDiff(DIFF_A), digestOfDiff(DIFF_A.replace("43", "44")));
});

test("a failing gate blocks approval entirely, even with explicit consent", () => {
  const proposal = fakeProposal(DIFF_A);
  const redGate: GateResult = { ...passedGateFor(proposal), passed: false, exitCode: 1, output: "1 failing test" };

  assert.throws(() => requestApproval(proposal, redGate), GateNotProvenError);
  assert.throws(
    () =>
      recordApproval({
        proposal,
        gate: redGate,
        spokenConsent: "go for it",
        stateDir: makeStateDir(),
        now: NOW,
      }),
    GateNotProvenError,
  );
});

test("a green gate that proved different bytes blocks approval", () => {
  const proposal = fakeProposal(DIFF_A);
  const wrongBytesGate: GateResult = { ...passedGateFor(proposal), digest: digestOfDiff(DIFF_B) };
  assert.throws(() => requestApproval(proposal, wrongBytesGate), GateNotProvenError);
});

test("a gate result for another proposal cannot be borrowed", () => {
  const proposal = fakeProposal(DIFF_A);
  const other = fakeProposal(DIFF_A, "selfmod-2026-08-11-bbbbbbbbbbbb");
  assert.throws(() => requestApproval(proposal, passedGateFor(other)), GateNotProvenError);
});

test("the spoken prompt binds the digest it is asking about", () => {
  const proposal = fakeProposal(DIFF_A);
  const prompt = requestApproval(proposal, passedGateFor(proposal));
  assert.ok(prompt.includes(proposal.digest.slice(0, 8)), prompt);
  assert.match(prompt, /approve\?$/);
  assert.match(prompt, /doctor green/);
});

test("explicit consent produces an approved, contract-valid, persisted receipt", () => {
  const proposal = fakeProposal(DIFF_A);
  const stateDir = makeStateDir();
  const record = recordApproval({
    proposal,
    gate: passedGateFor(proposal),
    spokenConsent: "go for it",
    stateDir,
    now: NOW,
  });

  assert.equal(record.receipt.decision, "approved");
  assert.equal(record.receipt.subjectDigest, digestOfDiff(DIFF_A));
  assert.equal(record.spokenConsent, "go for it");
  assert.ok(existsSync(approvalPathFor(stateDir, record.receipt.approvalId)));
  assert.ok(verifyApproval(proposal, record.receipt, NOW));
});

test("ambiguous consent is refusal", () => {
  const proposal = fakeProposal(DIFF_A);
  for (const utterance of ["i guess", "hmm", "maybe", "tell me more", ""]) {
    const record = recordApproval({
      proposal,
      gate: passedGateFor(proposal),
      spokenConsent: utterance,
      stateDir: makeStateDir(),
      now: NOW,
    });
    assert.equal(record.receipt.decision, "rejected", `"${utterance}" must not approve`);
    assert.ok(!verifyApproval(proposal, record.receipt, NOW), `"${utterance}" must not verify`);
  }
});

test("explicit refusal is recorded as rejected, not dropped", () => {
  const proposal = fakeProposal(DIFF_A);
  const stateDir = makeStateDir();
  const record = recordApproval({
    proposal,
    gate: passedGateFor(proposal),
    spokenConsent: "no, don't push that",
    stateDir,
    now: NOW,
  });
  assert.equal(record.receipt.decision, "rejected");
  assert.ok(existsSync(approvalPathFor(stateDir, record.receipt.approvalId)), "the refusal is part of the audit trail");
});

test("a changed diff invalidates a prior approval", () => {
  const proposal = fakeProposal(DIFF_A);
  const { receipt } = recordApproval({
    proposal,
    gate: passedGateFor(proposal),
    spokenConsent: "yes",
    stateDir: makeStateDir(),
    now: NOW,
  });
  assert.ok(verifyApproval(proposal, receipt, NOW), "sanity: the original bytes verify");

  // One added byte, digest field left stale.
  const tampered: SelfModProposal = { ...proposal, diff: `${DIFF_A} ` };
  assert.ok(!verifyApproval(tampered, receipt, NOW));

  // One added byte, digest field updated to match — the receipt still refuses,
  // because verification recomputes from the bytes rather than trusting fields.
  const recomputed: SelfModProposal = { ...proposal, diff: `${DIFF_A} `, digest: digestOfDiff(`${DIFF_A} `) };
  assert.ok(!verifyApproval(recomputed, receipt, NOW));
});

test("editing proposal metadata after approval also invalidates it", () => {
  const proposal = fakeProposal(DIFF_A);
  const { receipt } = recordApproval({
    proposal,
    gate: passedGateFor(proposal),
    spokenConsent: "yes",
    stateDir: makeStateDir(),
    now: NOW,
  });
  const editedSummary: SelfModProposal = { ...proposal, summary: "Totally harmless cleanup" };
  assert.ok(!verifyApproval(editedSummary, receipt, NOW));
});

test("an approval for proposal A cannot be replayed for proposal B", () => {
  const a = fakeProposal(DIFF_A, "selfmod-2026-08-11-aaaaaaaaaaaa");
  const b = fakeProposal(DIFF_B, "selfmod-2026-08-11-bbbbbbbbbbbb");
  const { receipt } = recordApproval({
    proposal: a,
    gate: passedGateFor(a),
    spokenConsent: "go for it",
    stateDir: makeStateDir(),
    now: NOW,
  });

  assert.ok(verifyApproval(a, receipt, NOW));
  assert.ok(!verifyApproval(b, receipt, NOW), "different bytes, different proposal");

  // Same bytes under a different proposal id is still a replay.
  const sameBytesNewId = fakeProposal(DIFF_A, "selfmod-2026-08-12-cccccccccccc");
  assert.ok(!verifyApproval(sameBytesNewId, receipt, NOW));
});

test("approval expires — a standing yes is not approval", () => {
  const proposal = fakeProposal(DIFF_A);
  const { receipt } = recordApproval({
    proposal,
    gate: passedGateFor(proposal),
    spokenConsent: "yes",
    stateDir: makeStateDir(),
    now: NOW,
  });

  assert.ok(verifyApproval(proposal, receipt, new Date(NOW.getTime() + 60_000)));
  assert.ok(!verifyApproval(proposal, receipt, new Date(NOW.getTime() + APPROVAL_TTL_MS)));
  assert.ok(!verifyApproval(proposal, receipt, new Date(NOW.getTime() + APPROVAL_TTL_MS + 1)));
});

test("a malformed receipt verifies false instead of throwing", () => {
  const proposal = fakeProposal(DIFF_A);
  const { receipt } = recordApproval({
    proposal,
    gate: passedGateFor(proposal),
    spokenConsent: "yes",
    stateDir: makeStateDir(),
    now: NOW,
  });
  const garbage = { ...receipt, subjectDigest: "not-a-digest" };
  assert.equal(verifyApproval(proposal, garbage, NOW), false);
});
