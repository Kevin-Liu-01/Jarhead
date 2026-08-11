import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localSearch } from "@jarvis/wiki-bridge";

/**
 * "What do I know about X" — BM25 over the private qmd collection.
 *
 * The wiki's `localSearch` returns file paths only, so this reads excerpts to
 * turn paths into something the model can actually answer from. Semantic
 * search (`qmd vsearch`) is deliberately not used: it was measured at ~7s with
 * a Metal compile error on this machine, which is an order of magnitude
 * outside the voice budget.
 */

export interface MemoryHit {
  readonly ref: string;
  readonly path: string | undefined;
  readonly excerpt: string;
}

export interface MemoryResult {
  readonly hits: readonly MemoryHit[];
  readonly ms: number;
  readonly degraded: string | undefined;
}

/**
 * Pull a qmd ref out of a result row.
 *
 * `qmd search --format files` does NOT return bare paths despite the name — each
 * row is `#colour,score,qmd://collection/path.md,"collection description"`. The
 * wiki's `localSearch` passes those rows through verbatim, so extracting the ref
 * is our job, not its bug.
 */
function extractRef(row: string): string | undefined {
  const m = /(qmd:\/\/[^\s,"]+)/.exec(row);
  if (m?.[1]) return m[1];
  return row.startsWith("/") ? row.trim() : undefined;
}

/**
 * Resolve a qmd ref to a file on disk.
 *
 * The `wiki-rebuild-private` collection is rooted at `<wikiRoot>/wiki`, not at
 * the repo root, so `qmd://wiki-rebuild-private/design/x.md` lives at
 * `<wikiRoot>/wiki/design/x.md`. Both bases are tried rather than hardcoding
 * one, so this keeps working if a collection is re-rooted.
 */
function resolvePath(ref: string, wikiRoot: string): string | undefined {
  if (ref.startsWith("/")) return existsSync(ref) ? ref : undefined;

  const m = /^qmd:\/\/[^/]+\/(.+)$/.exec(ref);
  const rel = m?.[1];
  if (!rel) return undefined;

  for (const base of [join(wikiRoot, "wiki"), wikiRoot]) {
    const abs = join(base, rel);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

function excerptFor(path: string, query: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3);

  const lines = text.split("\n");
  let bestIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + 4).join(" ").toLowerCase();
    const score = terms.reduce((n, t) => n + (window.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return lines
    .slice(bestIndex, bestIndex + 6)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function searchMemory(query: string, wikiRoot: string, limit = 5): MemoryResult {
  const startedAt = Date.now();

  let refs: string[];
  try {
    refs = localSearch(query);
  } catch (e) {
    return {
      hits: [],
      ms: Date.now() - startedAt,
      degraded: `qmd search failed: ${(e as Error).message.split("\n")[0]}`,
    };
  }

  const hits: MemoryHit[] = [];
  for (const row of refs.slice(0, limit)) {
    const ref = extractRef(row);
    if (!ref) continue;
    const path = resolvePath(ref, wikiRoot);
    hits.push({ ref, path, excerpt: path ? excerptFor(path, query) : "" });
  }

  const unresolved = hits.filter((h) => !h.path).length;

  return {
    hits,
    ms: Date.now() - startedAt,
    degraded:
      hits.length === 0
        ? "no matches in the private collection"
        : unresolved === hits.length
          ? "matches found but none resolved to readable files"
          : undefined,
  };
}

export function memoryAsContext(result: MemoryResult): string {
  if (result.hits.length === 0) {
    return `Nothing found in Kevin's wiki. ${result.degraded ?? ""}`.trim();
  }
  return result.hits
    .map((h) => {
      const name = h.path?.split("/").slice(-2).join("/") ?? h.ref;
      return h.excerpt ? `From ${name}: ${h.excerpt}` : `From ${name}: (no readable excerpt)`;
    })
    .join("\n\n");
}

/** True if the qmd binary is on PATH at all. Cheap startup check. */
export function qmdAvailable(): boolean {
  try {
    execFileSync("qmd", ["--version"], { stdio: "ignore", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}
