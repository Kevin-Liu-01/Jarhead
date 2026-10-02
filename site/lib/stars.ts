/**
 * The repo's star count (ITERATE.md §2): GitHub's public endpoint, no token, fetched in the server component with an
 * hour's revalidation, refreshed once on the client (lib/stars is shared by both). A failure is silent: the glyph alone.
 */
const STARS_URL = "https://api.github.com/repos/Kevin-Liu-01/Jarhead";
export const STARS_KEY = "jh-stars";

function read(j: unknown): number | null {
  if (!j || typeof j !== "object") return null;
  const v = (j as { stargazers_count?: unknown }).stargazers_count;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Server: cached an hour by Next's fetch cache; null when the endpoint fails (build without a network, a rate limit). */
export async function fetchStars(): Promise<number | null> {
  try {
    const r = await fetch(STARS_URL, { next: { revalidate: 3600 }, headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    return read(await r.json());
  } catch {
    return null;
  }
}

/** Client: the same endpoint, once per tab (sessionStorage), silent on failure. */
export async function refreshStars(): Promise<number | null> {
  try {
    const r = await fetch(STARS_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    return read(await r.json());
  } catch {
    return null;
  }
}

/** `6` · `1.2k` · `12k`. */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}
