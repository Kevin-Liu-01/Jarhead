import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertContract } from "@jarvis/wiki-bridge";
import { git, readMarker, runGit } from "./worktree.ts";

/**
 * A proposal is the exact bytes of a diff plus a digest over them.
 *
 * The digest is the unit of consent for everything downstream: the gate
 * certifies it, the approval binds to it, and the push re-derives it from the
 * live tree before touching a remote. That is the wiki's exact-bytes
 * discipline — approving "the patch" means approving these bytes, so a
 * one-byte change must produce a different digest and void every prior yes.
 */

export interface DiffStats {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface SelfModProposal {
  readonly schemaVersion: "1";
  readonly proposalId: string;
  readonly summary: string;
  /** Full `git diff --binary` output. The artifact Kevin's consent is about. */
  readonly diff: string;
  /** sha256 over the utf8 bytes of `diff`. Convenience only — verifiers recompute it. */
  readonly digest: string;
  readonly files: readonly string[];
  readonly createdAt: string;
  readonly stats: DiffStats;
  readonly baseRef: string;
  readonly branch: string;
  readonly worktreePath: string;
}

/**
 * The canonical bytes are the utf8 encoding of the stored diff string, so a
 * proposal read back from disk re-digests to the same value it was born with.
 */
export function digestOfDiff(diff: string): string {
  return createHash("sha256").update(Buffer.from(diff, "utf8")).digest("hex");
}

/**
 * Digest over the proposal's identity and metadata (everything except the
 * diff bytes, which `digest` already covers, and the worktree path, which is
 * an ephemeral location rather than content). Editing a summary after
 * approval is as invalidating as editing the patch.
 */
export function proposalHash(p: SelfModProposal): string {
  const core = {
    proposalId: p.proposalId,
    summary: p.summary,
    digest: p.digest,
    files: [...p.files],
    createdAt: p.createdAt,
    stats: p.stats,
    baseRef: p.baseRef,
    branch: p.branch,
  };
  return createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

/**
 * The current diff of a selfmod worktree against its pinned base.
 *
 * Everything is staged first because `git diff <base>` alone is blind to
 * newly created files, and an approval that silently excluded a new file
 * would be consent to bytes Kevin never saw. The index is ours to mutate —
 * this only ever runs inside a selfmod-created worktree.
 */
export async function captureDiff(worktreePath: string, baseRef: string): Promise<string> {
  await git(["add", "-A"], worktreePath);
  const res = await runGit(
    ["diff", "--binary", "--no-color", "--no-ext-diff", "--cached", baseRef],
    worktreePath,
  );
  if (res.code !== 0) throw new Error(`git diff failed: ${res.stderr.trim()}`);
  return res.stdout.toString("utf8");
}

export interface BuildProposalRequest {
  readonly worktreePath: string;
  readonly summary: string;
  readonly stateDir: string;
  readonly now: Date;
}

export function proposalPathFor(stateDir: string, proposalId: string): string {
  return join(stateDir, "proposals", `${proposalId}.json`);
}

export async function buildProposal(req: BuildProposalRequest): Promise<SelfModProposal> {
  const marker = readMarker(req.worktreePath);

  const diff = await captureDiff(req.worktreePath, marker.baseRef);
  if (diff.length === 0) throw new Error("nothing to propose: the worktree matches its base");

  const digest = digestOfDiff(diff);
  const files = (await git(["diff", "--cached", "--name-only", marker.baseRef], req.worktreePath))
    .split("\n")
    .filter((f) => f.length > 0);
  const stats = parseNumstat(await git(["diff", "--cached", "--numstat", marker.baseRef], req.worktreePath));

  // Digest-derived, so re-proposing identical bytes on the same day yields the
  // same id instead of a duplicate queue entry.
  const proposalId = `selfmod-${req.now.toISOString().slice(0, 10)}-${digest.slice(0, 12)}`;

  const proposal: SelfModProposal = {
    schemaVersion: "1",
    proposalId,
    summary: req.summary,
    diff,
    digest,
    files,
    createdAt: req.now.toISOString(),
    stats,
    baseRef: marker.baseRef,
    branch: marker.branch,
    worktreePath: marker.worktreePath,
  };

  // Fail closed against the wiki's real proposal contract before anything
  // persists — a proposal the governance surface cannot read is worse than none.
  assertContract("proposal", toWikiProposal(proposal));

  mkdirSync(join(req.stateDir, "proposals"), { recursive: true });
  writeFileSync(proposalPathFor(req.stateDir, proposalId), `${JSON.stringify(proposal, null, 2)}\n`);

  return proposal;
}

export function readProposal(stateDir: string, proposalId: string): SelfModProposal {
  const path = proposalPathFor(stateDir, proposalId);
  if (!existsSync(path)) throw new Error(`no proposal ${proposalId} under ${stateDir}`);
  return JSON.parse(readFileSync(path, "utf8")) as SelfModProposal;
}

/** Projection into the wiki's `proposal` contract, so promotion into the review queue is a file move. */
export function toWikiProposal(p: SelfModProposal): Record<string, unknown> {
  return {
    schemaVersion: "1",
    proposalId: p.proposalId,
    kind: "jarvis.self-modify",
    target: p.branch,
    createdAt: p.createdAt,
    proposalHash: proposalHash(p),
    subjectDigest: p.digest,
    sourceRefs: [p.baseRef],
    payload: {
      summary: p.summary,
      files: [...p.files],
      stats: p.stats,
    },
  };
}

function parseNumstat(numstat: string): DiffStats {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    filesChanged++;
    // Binary files report "-\t-\tpath"; they count as changed, not as lines.
    const [ins, del] = line.split("\t");
    if (ins && ins !== "-") insertions += Number(ins);
    if (del && del !== "-") deletions += Number(del);
  }
  return { filesChanged, insertions, deletions };
}
