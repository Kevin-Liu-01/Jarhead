import { AgentBrowser } from "./agentBrowser.ts";
import { detectBrowserTools } from "./detect.ts";

/**
 * "Go look this up on the web" — the voice research path.
 *
 * The plain-fetch route comes first, deliberately: most article reads are
 * static HTML, and Node's fetch answers in a few hundred ms where launching
 * Chrome costs seconds. agent-browser is the escalation for pages that come
 * back JS-gated, never the default. Search is DuckDuckGo's html endpoint
 * because it is the one mainstream search surface that works from a plain
 * fetch with no API key and no JavaScript.
 *
 * Like hn.ts, this runs in the context-gathering stage before the model
 * speaks, with a hard budget on every network call — it must never be awaited
 * from the live audio path.
 */

export interface PageRead {
  readonly url: string;
  readonly title: string | undefined;
  readonly text: string;
  readonly via: "fetch" | "agent-browser";
}

export type FetchOutcome =
  | { readonly ok: true; readonly page: PageRead }
  | { readonly ok: false; readonly error: string };

export interface SearchHit {
  readonly url: string;
  readonly title: string;
}

export interface ResearchOptions {
  /** Per network call, not for the whole errand. */
  readonly timeoutMs?: number;
  /** Ceiling on the returned context. Voice answers are three sentences; default keeps it small. */
  readonly maxChars?: number;
  readonly maxPages?: number;
  /** Injected so tests run on canned HTML instead of the network. */
  readonly fetchImpl?: typeof fetch;
  /** Injected so tests (and callers with a warm session) control escalation. */
  readonly browser?: AgentBrowser;
}

export interface ResearchResult {
  readonly question: string;
  /** Source-labeled, bounded text for the model to answer from. */
  readonly context: string;
  /** Full provenance: every page that contributed, with its URL. */
  readonly sources: readonly PageRead[];
  readonly degraded: string | undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  deg: "°",
  times: "×",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML to readable text, no dependencies. Not a Readability port — for the
 * "what does this article say" use case, dropping script/style/head and
 * collapsing whitespace recovers the prose well enough for a model to answer
 * from, and it runs in microseconds.
 */
export function htmlToText(html: string, maxChars = 8000): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const withBreaks = withoutBlocks
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n");

  // Decode AFTER stripping tags so "&lt;script&gt;" in prose stays prose.
  const decoded = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "));

  const collapsed = decoded
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const raw = m?.[1];
  if (raw === undefined) return undefined;
  const title = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title.slice(0, 200) : undefined;
}

/**
 * Did the plain fetch actually get the content? A JS-shell page strips down
 * to almost nothing, or to an explicit "enable JavaScript" plea. Sub-200-char
 * pages that are genuinely static are useless for answering anyway, so
 * treating them as gated costs nothing.
 */
export function looksJsGated(text: string): boolean {
  if (/(enable|requires?|turn on) javascript|javascript is (disabled|required|not enabled)/i.test(text)) {
    return true;
  }
  return text.replace(/\s+/g, " ").trim().length < 200;
}

export function searchUrlFor(question: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(question)}`;
}

function resolveDuckDuckGoHref(href: string): string | undefined {
  const unescaped = href.replace(/&amp;/g, "&");
  const uddg = /[?&]uddg=([^&"]+)/.exec(unescaped)?.[1];
  let raw: string;
  try {
    raw = uddg ? decodeURIComponent(uddg) : unescaped;
  } catch {
    return undefined;
  }
  const abs = raw.startsWith("//") ? `https:${raw}` : raw;
  if (!/^https?:\/\//i.test(abs)) return undefined;
  // DDG ad rows link through y.js with an ad_domain param; skip them.
  if (/duckduckgo\.com\/y\.js|[?&]ad_domain=/i.test(abs)) return undefined;
  return abs;
}

/** Result anchors carry class "result__a"; organic hrefs redirect through /l/?uddg=<real url>. */
export function parseDuckDuckGoHtml(html: string, limit = 4): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m !== null && hits.length < limit; m = re.exec(html)) {
    const href = m[1];
    const label = m[2];
    if (href === undefined || label === undefined) continue;
    const url = resolveDuckDuckGoHref(href);
    if (!url || hits.some((h) => h.url === url)) continue;
    hits.push({ url, title: htmlToText(label, 200) });
  }
  return hits;
}

// Some CDNs 403 Node's default UA on sight; a browser UA is the difference
// between reading an article and reading an error page.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface FetchReadableOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxChars?: number;
}

/** The no-browser path: fetch the HTML and strip tags. Covers most article reads. */
export async function fetchReadable(url: string, opts: FetchReadableOptions = {}): Promise<FetchOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const maxChars = opts.maxChars ?? 8000;
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `${res.status} for ${url}` };
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("html") || /^\s*</.test(body);
    return {
      ok: true,
      page: {
        url: res.url || url,
        title: isHtml ? extractTitle(body) : undefined,
        text: isHtml ? htmlToText(body, maxChars) : body.trim().slice(0, maxChars),
        via: "fetch",
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Escalation: render the page in agent-browser, then read the live DOM.
 * Two invocations (open, then read) instead of one batch because batch's
 * read result shape was not probed — correctness over one saved spawn on
 * what is already the rare path.
 */
async function browserRead(
  url: string,
  injected: AgentBrowser | undefined,
  timeoutMs: number,
  maxChars: number,
): Promise<PageRead | undefined> {
  const browser = injected ?? new AgentBrowser({ session: "jarvis-research" });
  const opened = await browser.open(url, { timeoutMs });
  if (!opened.ok) return undefined;
  const got = await browser.extract("full readable page text", { timeoutMs });
  if (!got.ok || got.value.content.trim() === "") return undefined;
  return {
    url: got.value.url || url,
    title: opened.value.title === "" ? undefined : opened.value.title,
    text: got.value.content.slice(0, maxChars),
    via: "agent-browser",
  };
}

export async function research(question: string, opts: ResearchOptions = {}): Promise<ResearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxChars = opts.maxChars ?? 2400;
  const maxPages = opts.maxPages ?? 2;

  const failed = (why: string): ResearchResult => ({
    question,
    context: "",
    sources: [],
    degraded: why,
  });

  let hits: SearchHit[];
  try {
    const res = await fetchImpl(searchUrlFor(question), {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return failed(`web search returned ${res.status}`);
    hits = parseDuckDuckGoHtml(await res.text(), maxPages + 2);
  } catch (e) {
    return failed(`web search failed: ${(e as Error).message}`);
  }
  if (hits.length === 0) return failed("web search returned no results");

  const targets = hits.slice(0, maxPages);
  const perPage = Math.max(500, Math.floor(maxChars / targets.length));

  // All plain fetches in parallel; escalations run after, and only for the
  // pages that proved gated — Chrome launches are too expensive to guess at.
  const fetched = await Promise.all(
    targets.map((h) => fetchReadable(h.url, { fetchImpl, timeoutMs, maxChars: perPage })),
  );

  const sources: PageRead[] = [];
  const problems: string[] = [];
  const caps = detectBrowserTools();

  for (let i = 0; i < targets.length; i++) {
    const hit = targets[i];
    const outcome = fetched[i];
    if (!hit || !outcome) continue;

    if (outcome.ok && !looksJsGated(outcome.page.text)) {
      sources.push(outcome.page);
      continue;
    }
    if (!caps.agentBrowser) {
      problems.push(`${hit.url} needs a real browser and agent-browser is not installed`);
      continue;
    }
    const rendered = await browserRead(hit.url, opts.browser, timeoutMs, perPage);
    if (rendered) sources.push(rendered);
    else problems.push(`${hit.url} unreadable (${outcome.ok ? "page requires JavaScript" : outcome.error})`);
  }

  if (sources.length === 0) {
    return failed(problems.length > 0 ? problems.join("; ") : "no readable pages among the search results");
  }

  const context = sources
    .map((s, i) => `[${i + 1}] ${s.title ?? s.url} — ${s.url}\n${s.text}`)
    .join("\n\n")
    .slice(0, maxChars);

  return {
    question,
    context,
    sources,
    degraded: problems.length > 0 ? problems.join("; ") : undefined,
  };
}
