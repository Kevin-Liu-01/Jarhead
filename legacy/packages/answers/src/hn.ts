/**
 * Hacker News.
 *
 * Nothing in kevin-wiki covers HN, so this is new. It is deliberately a plain
 * Firebase fetch with an in-process TTL cache: the whole point is that "what's
 * on hackernews" answers from cache in ~250ms instead of doing a fan-out of
 * HTTP requests while Kevin waits.
 *
 * M1 moves the refresh onto jarvisd's timer so the cache is always warm.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://hacker-news.firebaseio.com/v0";

export interface Story {
  readonly id: number;
  readonly title: string;
  readonly score: number;
  readonly by: string;
  readonly descendants: number;
  readonly url: string | undefined;
}

interface CacheEntry {
  readonly at: number;
  readonly stories: readonly Story[];
}

let cache: CacheEntry | undefined;

export const HN_TTL_MS = 15 * 60 * 1000;

/**
 * The cache is backed by disk as well as memory.
 *
 * In-memory alone is useless for a one-shot CLI: every `jarvis ask` is a fresh
 * process, so `jarvis warm` warmed a cache that immediately died with it. That
 * showed up as a 408ms route on a turn that should have been ~5ms. Once jarvisd
 * is resident (M1) the memory tier does the work and this becomes the cold-start
 * path, but it has to exist either way.
 */
let cacheFile: string | undefined;

export function useCacheDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    cacheFile = join(dir, "hn-cache.json");
  } catch {
    cacheFile = undefined;
  }
}

function readDiskCache(): CacheEntry | undefined {
  if (!cacheFile || !existsSync(cacheFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as CacheEntry;
    return typeof parsed?.at === "number" && Array.isArray(parsed.stories) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeDiskCache(entry: CacheEntry): void {
  if (!cacheFile) return;
  try {
    writeFileSync(cacheFile, JSON.stringify(entry));
  } catch {
    // A cache we can't write is a slow turn, not a broken one.
  }
}

export interface FetchOptions {
  readonly count?: number;
  readonly force?: boolean;
  readonly timeoutMs?: number;
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`hn ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export function cachedStories(): readonly Story[] | undefined {
  cache ??= readDiskCache();
  if (!cache) return undefined;
  return Date.now() - cache.at < HN_TTL_MS ? cache.stories : undefined;
}

export async function topStories(opts: FetchOptions = {}): Promise<readonly Story[]> {
  const count = opts.count ?? 8;
  const timeoutMs = opts.timeoutMs ?? 6000;

  if (!opts.force) {
    const hit = cachedStories();
    if (hit && hit.length >= count) return hit.slice(0, count);
  }

  const ids = await getJson<number[]>(`${BASE}/topstories.json`, timeoutMs);
  const wanted = ids.slice(0, count);

  const settled = await Promise.allSettled(
    wanted.map((id) =>
      getJson<{
        id: number;
        title?: string;
        score?: number;
        by?: string;
        descendants?: number;
        url?: string;
      }>(`${BASE}/item/${id}.json`, timeoutMs),
    ),
  );

  const stories: Story[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value?.title) continue;
    stories.push({
      id: s.value.id,
      title: s.value.title,
      score: s.value.score ?? 0,
      by: s.value.by ?? "unknown",
      descendants: s.value.descendants ?? 0,
      url: s.value.url,
    });
  }

  cache = { at: Date.now(), stories };
  writeDiskCache(cache);
  return stories;
}

/** Compact context for the model. Deliberately not pre-narrated — the model speaks it. */
export function storiesAsContext(stories: readonly Story[]): string {
  return stories
    .map((s, i) => `${i + 1}. ${s.title} — ${s.score} points, ${s.descendants} comments, by ${s.by}`)
    .join("\n");
}
