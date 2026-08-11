import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntities,
  extractTitle,
  htmlToText,
  looksJsGated,
  parseDuckDuckGoHtml,
  searchUrlFor,
} from "../research.ts";

test("script, style, and head content never reach the model", () => {
  const html = `<html><head><title>T</title><style>body{color:red}</style></head>
    <body><script>var secret = "tracking";</script><p>Visible prose.</p>
    <noscript>Enable JS</noscript></body></html>`;
  const text = htmlToText(html);
  assert.equal(text.includes("tracking"), false);
  assert.equal(text.includes("color:red"), false);
  assert.equal(text.includes("Enable JS"), false);
  assert.match(text, /Visible prose\./);
});

test("entities decode: named, decimal, and hex", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry&#39;s &#x27;caf&eacute;&#x27;"), "Tom & Jerry's 'caf&eacute;'");
  assert.equal(decodeEntities("a&nbsp;b &mdash; c&hellip;"), "a b — c…");
  assert.equal(decodeEntities("2 &lt; 3 &gt; 1"), "2 < 3 > 1");
});

test("unknown and malformed entities pass through untouched", () => {
  assert.equal(decodeEntities("&notarealentity; &#xzz;"), "&notarealentity; &#xzz;");
});

test("decoded angle brackets do not resurrect as tags", () => {
  const text = htmlToText("<p>use &lt;script&gt; carefully</p>");
  assert.match(text, /use <script> carefully/);
});

test("whitespace collapses and block boundaries become newlines", () => {
  const html = "<div>first   line\t\t</div><p>second</p><ul><li>one</li><li>two</li></ul>";
  const text = htmlToText(html);
  assert.equal(text, "first line\nsecond\n- one\n- two");
});

test("output is bounded even on huge input", () => {
  const html = `<p>${"word ".repeat(20_000)}</p>`;
  const text = htmlToText(html, 500);
  assert.ok(text.length <= 500, String(text.length));
  assert.match(text, /…$/);
});

test("titles are extracted, decoded, and bounded", () => {
  assert.equal(extractTitle("<title>News &amp; Weather</title>"), "News & Weather");
  assert.equal(extractTitle("<html><body>no title</body></html>"), undefined);
  const long = extractTitle(`<title>${"t".repeat(500)}</title>`);
  assert.equal(long?.length, 200);
});

test("JS-shell pages are recognized as gated", () => {
  assert.equal(looksJsGated("You need to enable JavaScript to run this app."), true);
  assert.equal(looksJsGated("tiny"), true);
  assert.equal(looksJsGated(`This is a real article. ${"Substantial prose follows. ".repeat(20)}`), false);
});

test("search URL encodes the question", () => {
  assert.equal(searchUrlFor("a b&c"), "https://html.duckduckgo.com/html/?q=a%20b%26c");
});

test("DDG result parsing unwraps uddg redirects and skips ads", () => {
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=abc">Example &amp; Co</a>
    <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&u3=x">Sponsored</a>
    <a class="result__a" href="https://plain.example.org/page">Plain link</a>
    <a class="other" href="https://ignored.example.com">not a result</a>`;
  const hits = parseDuckDuckGoHtml(html, 5);
  assert.deepEqual(hits, [
    { url: "https://example.com/article", title: "Example & Co" },
    { url: "https://plain.example.org/page", title: "Plain link" },
  ]);
});

test("DDG parsing respects the limit and dedupes", () => {
  const row = '<a class="result__a" href="https://same.example.com/x">Same</a>';
  const hits = parseDuckDuckGoHtml(row.repeat(6), 3);
  assert.equal(hits.length, 1);
});
