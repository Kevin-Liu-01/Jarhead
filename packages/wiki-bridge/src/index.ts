/**
 * The seam between Jarvis and Kevin's wiki brain.
 *
 * Everything Jarvis borrows from kevin-wiki passes through this file, so the
 * coupling is one grep away. The wiki packages export raw `./src/index.ts`
 * with no build step, and `@kevin-wiki/contracts` resolves its JSON schemas
 * relative to its own directory via `import.meta.url` — which is why these are
 * pnpm `link:` deps pointing at the real checkout rather than vendored copies.
 * Copying `src/` alone would break schema resolution.
 *
 * Verified working from this standalone repo on 2026-08-10.
 */

export { assertContract, validateContract, validatorFor, CONTRACT_NAMES } from "@kevin-wiki/contracts";
export { EventStore, canonicalJson, snapshotDigest } from "@kevin-wiki/store";
export { ArtifactStore } from "@kevin-wiki/artifact-store";
export { AutomationRuntime, buildSchedulerRegistrations } from "@kevin-wiki/automation-runtime";
export { localSearch, doctorLocalSearch } from "@kevin-wiki/local-search";

/**
 * Things deliberately NOT bridged, and why:
 *
 * - `@kevin-wiki/cli` index      — top-level script, executes on import. Shell out to
 *                                  `pnpm kw` instead, and never on the voice path
 *                                  (~3s startup measured).
 * - `apps/briefd`                — reachable over HTTP (`GET /brief/latest`,
 *                                  `POST /brief/compile`). Kept as a service boundary
 *                                  so a stale wiki checkout can't wedge the daemon.
 * - review / brain-compiler /    — coupled to wiki repo layout. Drive via `kw`.
 *   corpus / automation-audit
 * - qmd vsearch / query          — ~7s + a Metal compile error on this machine.
 *                                  BM25 via localSearch is the only retrieval mode
 *                                  inside the voice budget.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WikiLinkStatus {
  readonly root: string;
  readonly present: boolean;
  readonly branch: string | undefined;
  readonly missing: readonly string[];
}

const REQUIRED_PATHS = [
  "packages/contracts/schemas",
  "packages/store/src",
  "packages/artifact-store/src",
  "packages/automation-runtime/src",
  "packages/local-search/src",
  "apps/briefd/src",
  "automations/_schema.md",
  "schedulers/registrations.json",
  "workflows/catalog.json",
] as const;

/** Cheap filesystem check. Does not import anything — safe to call at startup. */
export function checkWikiLink(root: string): WikiLinkStatus {
  const present = existsSync(root);
  const missing = present ? REQUIRED_PATHS.filter((p) => !existsSync(join(root, p))) : [...REQUIRED_PATHS];
  return { root, present, branch: readBranch(root), missing };
}

/**
 * The live wiki checkout is a linked git worktree, so `.git` is a FILE
 * containing `gitdir: <path>`, not a directory. Handle both shapes.
 */
function readBranch(root: string): string | undefined {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return undefined;
  try {
    let gitDir = dotGit;
    const stat = readFileSync(dotGit, "utf8");
    // Reading a directory throws, so reaching here means .git is a file.
    const match = /^gitdir:\s*(.+)$/m.exec(stat.trim());
    if (!match?.[1]) return undefined;
    gitDir = match[1].trim();
    return parseHead(join(gitDir, "HEAD"));
  } catch {
    // .git is a real directory.
    return parseHead(join(dotGit, "HEAD"));
  }
}

function parseHead(headFile: string): string | undefined {
  if (!existsSync(headFile)) return undefined;
  try {
    const head = readFileSync(headFile, "utf8").trim();
    return head.startsWith("ref: refs/heads/")
      ? head.slice("ref: refs/heads/".length)
      : `detached@${head.slice(0, 8)}`;
  } catch {
    return undefined;
  }
}

export const BRIDGED_PACKAGES = [
  "@kevin-wiki/contracts",
  "@kevin-wiki/store",
  "@kevin-wiki/artifact-store",
  "@kevin-wiki/automation-runtime",
  "@kevin-wiki/local-search",
] as const;

export interface PackageProbe {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Probe from inside this package so resolution uses wiki-bridge's own
 * node_modules. Probing from the repo root would fail even when the links
 * are healthy, because the `link:` deps are declared here, not there.
 */
export async function probeWikiPackages(): Promise<readonly PackageProbe[]> {
  const out: PackageProbe[] = [];
  for (const name of BRIDGED_PACKAGES) {
    try {
      const mod = (await import(name)) as Record<string, unknown>;
      const exports = Object.keys(mod).filter((k) => k !== "default");
      out.push({ name, ok: true, detail: `${exports.length} exports` });
    } catch (e) {
      out.push({ name, ok: false, detail: (e as Error).message.split("\n")[0] ?? "import failed" });
    }
  }
  return out;
}
