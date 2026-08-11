import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "@jarvis/core";

/**
 * Disposable git worktrees for self-modification (DECISION.md §7 step 1).
 *
 * Jarvis never edits its own live checkout: a worktree shares the object
 * store but gets its own directory and branch, so nothing here can clobber
 * whatever Kevin has half-finished in the real tree. Two refusals carry the
 * safety story:
 *
 * 1. `disposeWorktree` only removes trees this module created, proven by an
 *    ownership marker. The marker lives BESIDE the worktree, not inside it,
 *    so it can never leak into a proposal diff.
 * 2. A dirty worktree is not disposed without `force` — the same "preserve
 *    uncommitted work you did not create" rule the wiki's AGENTS.md imposes.
 */

/** Branches a proposal may never be created on or pushed to. */
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "release",
]);

const MARKER_FILENAME = "jarvis-selfmod-marker.json";

export interface GitResult {
  readonly code: number;
  /** Kept as a Buffer so diff bytes are digested exactly as git produced them. */
  readonly stdout: Buffer;
  readonly stderr: string;
}

export function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`git failed to spawn: ${e.message}`)));
    p.on("close", (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
  });
}

/** Like `runGit`, but a nonzero exit is an error. Returns trimmed stdout. */
export async function git(args: readonly string[], cwd: string): Promise<string> {
  const res = await runGit(args, cwd);
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.toString("utf8").trim() || `exit ${res.code}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return res.stdout.toString("utf8").trim();
}

export interface WorktreeMarker {
  readonly schemaVersion: "1";
  readonly worktreePath: string;
  readonly branch: string;
  /** Commit sha proposals are diffed against. Pinned at creation so a moving HEAD can't shift the base. */
  readonly baseRef: string;
  readonly repoRoot: string;
  readonly createdAt: string;
}

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface CreateWorktreeOptions {
  readonly repoRoot?: string;
  readonly now?: Date;
}

/**
 * Create a disposable worktree of the Jarvis repo on a fresh branch.
 *
 * A dirty index in the main tree is fine here: `git worktree add` from HEAD
 * reads only committed state and writes only the new directory plus refs, so
 * uncommitted work is untouched — it just isn't part of the proposal base.
 * What we refuse instead is reusing an existing branch, because clobbering a
 * branch we did not create is exactly the destruction this module exists to
 * prevent.
 */
export async function createWorktree(branchName: string, opts: CreateWorktreeOptions = {}): Promise<Worktree> {
  const repoRoot = resolve(opts.repoRoot ?? REPO_ROOT);
  const now = opts.now ?? new Date();

  if (PROTECTED_BRANCHES.has(branchName)) {
    throw new Error(`refusing branch "${branchName}": proposals never ride a default branch`);
  }
  const format = await runGit(["check-ref-format", "--branch", branchName], repoRoot);
  if (format.code !== 0) {
    throw new Error(`"${branchName}" is not a valid branch name`);
  }
  const existing = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot);
  if (existing.code === 0) {
    throw new Error(`branch "${branchName}" already exists — refusing to reuse or clobber it`);
  }

  const baseRef = await git(["rev-parse", "HEAD"], repoRoot);
  const parent = mkdtempSync(join(tmpdir(), "jarvis-selfmod-"));
  const worktreePath = join(parent, "worktree");
  await git(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], repoRoot);

  const marker: WorktreeMarker = {
    schemaVersion: "1",
    worktreePath,
    branch: branchName,
    baseRef,
    repoRoot,
    createdAt: now.toISOString(),
  };
  writeFileSync(join(parent, MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`);

  return { path: worktreePath, branch: branchName, baseRef };
}

/**
 * Prove a path is a worktree this module created. Everything downstream —
 * proposals, the gate, the push — goes through this, so no selfmod operation
 * can ever run against a tree someone else owns.
 */
export function readMarker(worktreePath: string): WorktreeMarker {
  const p = resolve(worktreePath);
  const markerPath = join(dirname(p), MARKER_FILENAME);
  if (!existsSync(markerPath)) {
    throw new Error(`refusing to operate on ${p}: no selfmod marker — this tree was not created here`);
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as WorktreeMarker;
  if (marker.worktreePath !== p) {
    throw new Error(`marker at ${markerPath} describes a different worktree (${marker.worktreePath})`);
  }
  return marker;
}

export interface DisposeOptions {
  /** Required to discard uncommitted changes. Off by default so nothing is destroyed silently. */
  readonly force?: boolean;
}

export async function disposeWorktree(path: string, opts: DisposeOptions = {}): Promise<void> {
  const p = resolve(path);
  const marker = readMarker(p);

  // A linked worktree has a `.git` FILE pointing back at the repo; the user's
  // main tree has a `.git` directory. Belt-and-suspenders on top of the marker:
  // even a forged marker cannot aim this at a main working tree.
  const dotGit = join(p, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isFile()) {
    throw new Error(`refusing to dispose ${p}: not a linked worktree`);
  }

  const dirty = await git(["status", "--porcelain"], p);
  if (dirty.length > 0 && !opts.force) {
    throw new Error(
      `worktree at ${p} has uncommitted changes — capture a proposal first, then dispose with force`,
    );
  }

  await git(["worktree", "remove", ...(opts.force ? ["--force"] : []), p], marker.repoRoot);
  // The branch was ours by construction (createWorktree refuses to reuse one),
  // and its content survives in the proposal record or on the remote, so -D
  // loses nothing that was not already captured.
  await git(["branch", "-D", marker.branch], marker.repoRoot);
  rmSync(dirname(p), { recursive: true, force: true });
}
