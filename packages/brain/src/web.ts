import { classifyUrl, type Decision } from "@jarhead/core";

/**
 * The web for a brain that has no browser of its own: a page as readable text,
 * and a search without an API key. Every URL — the one asked for and every
 * redirect after it — goes through classifyUrl first, so a public page cannot
 * bounce the fetch onto a private host.
 */

export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_CAP = 30_000;
export const SEARCH_RESULTS = 8;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Jarhead/2.0";

export interface WebOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly cap?: number | undefined;
  readonly request?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** What a refusal calls the person Jarhead works for; default "Kevin". */
  readonly userName?: string | undefined;
}

export interface FetchedPage {
  readonly url: string;
  readonly status: number;
  readonly title: string | undefined;
  readonly text: string;
  readonly contentType: string;
  readonly truncated: boolean;
}

export type FetchOutcome = { readonly ok: true; readonly page: FetchedPage } | { readonly ok: false; readonly decision?: Decision; readonly error: string };

/** GET with manual redirects, each hop re-checked by policy; HTML becomes text, everything else is returned as-is (text) or described (binary). */
export async function fetchReadable(url: string, opts: WebOptions = {}): Promise<FetchOutcome> {
  const doFetch = opts.fetch ?? fetch;
  const cap = opts.cap ?? FETCH_CAP;
  let current = url.trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const decision = classifyUrl({ url: current, request: opts.request, userName: opts.userName });
    if (decision.verdict !== "run") return { ok: false, decision, error: decision.reason };
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
      res = await doFetch(current, { method: "GET", redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en" }, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: err.name === "TimeoutError" ? `${hostOf(current)} did not answer within ${Math.round((opts.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000)} s` : `could not reach ${hostOf(current)}: ${err.message}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, error: `${hostOf(current)} answered ${res.status} without a location` };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, error: `${hostOf(current)} redirected to an invalid URL` };
      }
      continue;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const raw = await readBody(res, MAX_BODY_BYTES);
    if (isBinaryType(contentType)) {
      return { ok: true, page: { url: current, status: res.status, title: undefined, text: `(${contentType.split(";")[0] || "binary"} content, ${raw.length} bytes; not text)`, contentType, truncated: false } };
    }
    const body = raw.toString("utf8");
    const html = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
    const title = html ? titleOf(body) : undefined;
    const text = html ? htmlToText(body, current) : body;
    const truncated = text.length > cap;
    return { ok: true, page: { url: current, status: res.status, title, text: truncated ? `${text.slice(0, cap)}\n… [cut at ${cap} characters]` : text, contentType, truncated } };
  }
  return { ok: false, error: `too many redirects from ${hostOf(url)}` };
}

async function readBody(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

function isBinaryType(ct: string): boolean {
  return /^(image|audio|video|font)\//.test(ct) || /(octet-stream|zip|pdf|gzip|x-tar|msword|officedocument)/.test(ct);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

export function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()).slice(0, 200) || undefined : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * HTML → readable text. Scripts, styles, navigation, headers, footers and forms
 * go; headings become "# …" lines, list items "- …", links "text (url)";
 * whitespace collapses. Good enough for a model to read an article or a docs
 * page; not a browser.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas|nav|header|footer|aside|form|button|select|dialog)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, tag: string, inner: string) => `\n\n${"#".repeat(Number(tag[1]))} ${inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n\n`);
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let target = href.trim();
    if (baseUrl) {
      try {
        target = new URL(target, baseUrl).toString();
      } catch {
        // keep as written
      }
    }
    if (!/^https?:/i.test(target) || !text) return text;
    return text === target || text.replace(/\/$/, "") === target.replace(/^https?:\/\//, "").replace(/\/$/, "") ? target : `${text} (${target})`;
  });
  s = s.replace(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => (alt.trim() ? ` [image: ${alt.trim()}] ` : " "));
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li\s*>/gi, "");
  s = s.replace(/<(td|th)\b[^>]*>/gi, " | ");
  s = s.replace(/<blockquote\b[^>]*>/gi, "\n> ");
  s = s.replace(/<\/?(p|div|section|article|main|ul|ol|tr|table|thead|tbody|pre|blockquote|dl|dt|dd|figure|figcaption|details|summary)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, " ");
  s = s
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

// ------------------------------------------------------------------ search ---

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type SearchOutcome = { readonly ok: true; readonly results: SearchResult[] } | { readonly ok: false; readonly error: string };

/** DuckDuckGo's HTML endpoint, parsed; no key. When it is blocked (a challenge page, 403, 429) the outcome says so. */
export async function searchWeb(query: string, opts: WebOptions = {}): Promise<SearchOutcome> {
  const doFetch = opts.fetch ?? fetch;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS);
    res = await doFetch(url, { method: "GET", headers: { "user-agent": USER_AGENT, accept: "text/html", "accept-language": "en" }, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "TimeoutError" ? "the search did not answer in time" : `could not reach the search engine: ${err.message}` };
  }
  if (res.status === 403 || res.status === 429 || res.status === 503) return { ok: false, error: `the search engine blocked the request (${res.status}); fetch a site you know instead` };
  if (!res.ok) return { ok: false, error: `the search engine answered ${res.status}` };
  const html = (await readBody(res, MAX_BODY_BYTES)).toString("utf8");
  if (/anomaly|captcha|unusual traffic|verify you are human/i.test(html) && !/result__a/.test(html)) return { ok: false, error: "the search engine asked for a bot check; fetch a site you know instead" };
  return { ok: true, results: parseDuckDuckGo(html).slice(0, SEARCH_RESULTS) };
}

/** The `result__a` links and `result__snippet` blocks of the HTML endpoint. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = resolveDuckUrl(decodeEntities(link[1]!));
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const title = decodeEntities(link[2]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|span)>/i.exec(block);
    const snippet = snip ? decodeEntities(snip[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
    if (title && !results.some((r) => r.url === url)) results.push({ title, url, snippet });
  }
  return results;
}

function resolveDuckUrl(href: string): string | undefined {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  try {
    const u = new URL(h, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return undefined;
  }
}
