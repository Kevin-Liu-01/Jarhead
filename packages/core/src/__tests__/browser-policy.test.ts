import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAction, riskyUrlReason, type Verdict } from "../policy.ts";

/**
 * The browser fast path and dictation gates. Reads run; clicks, typing and navigation run
 * on ordinary pages and ask on payment / sign-in pages or irreversible controls; password
 * fields refuse typing whatever else is true; dictation refuses password fields and
 * hands-off apps outright (no question mid-sentence).
 */

test("browser reads run whatever the page", () => {
  for (const kind of ["browser_read", "browser_find", "browser_tabs"]) {
    assert.equal(classifyAction({ kind, app: "Google Chrome", url: "https://checkout.stripe.com/pay/x" }).verdict, "run", kind);
  }
});

/** [kind, url, target, verdict] — without a yes. */
const CASES: ReadonlyArray<readonly [string, string, string, Verdict, string?]> = [
  ["browser_click", "https://docs.google.com/document/d/abc/edit", "Bold", "run"],
  ["browser_type", "https://en.wikipedia.org/wiki/Lantern", "Search", "run"],
  ["browser_navigate", "https://news.ycombinator.com/", "", "run"],
  ["browser_click", "https://shop.example.com/checkout", "Continue", "confirm", "checkout page"],
  ["browser_click", "https://www.amazon.com/gp/buy/spc/handlers/display.html", "Place your order", "confirm", "irreversible label"],
  ["browser_type", "https://accounts.google.com/signin/v2/identifier", "Email", "confirm", "sign-in page"],
  ["browser_type", "https://github.com/login", "Username", "confirm", "login path"],
  ["browser_navigate", "https://www.chase.com/personal/banking", "", "confirm", "bank"],
  ["browser_navigate", "https://example.com/reset-password", "", "confirm", "password reset"],
  ["browser_click", "https://app.example.com/settings/security", "Enable", "confirm", "security page"],
  ["browser_click", "https://mail.google.com/mail/u/0/#inbox", "Send", "confirm", "irreversible control on an ordinary page"],
  ["browser_click", "https://example.com/payload/download", "Open", "run", "'pay' inside a longer word is not a payment page"],
  ["browser_click", "https://example.com/authors/kevin", "Follow", "run", "'auth' inside 'authors' is not an auth page"],
  ["browser_click", "https://example.com/?next=/login", "OK", "run", "the query string is not judged"],
];

test("browser actions: ordinary pages run; payment, sign-in and bank pages ask; irreversible controls ask; a yes unlocks", () => {
  for (const [kind, url, target, verdict, note] of CASES) {
    const d = classifyAction({ kind, app: "Google Chrome", url, target });
    assert.equal(d.verdict, verdict, `${kind} ${url} "${target}" (${note ?? ""}): ${d.reason}`);
    if (verdict === "confirm") assert.equal(classifyAction({ kind, app: "Google Chrome", url, target, confirmed: true }).verdict, "run", `confirmed ${url}`);
  }
});

test("browser_type into a password field is refused, yes or no; a hands-off app asks", () => {
  assert.equal(classifyAction({ kind: "browser_type", app: "Safari", url: "https://example.com/", secureField: true }).verdict, "refuse");
  assert.equal(classifyAction({ kind: "browser_type", app: "Safari", url: "https://example.com/", secureField: true, confirmed: true }).verdict, "refuse");
  assert.equal(classifyAction({ kind: "browser_click", app: "1Password", url: "https://my.1password.com/", target: "Copy" }).verdict, "confirm");
});

test("riskyUrlReason names the keyword and host; harmless and malformed URLs give nothing", () => {
  assert.match(riskyUrlReason("https://pay.example.com/") ?? "", /payment or sign-in page \(pay in pay\.example\.com/);
  assert.match(riskyUrlReason("https://example.com/account/login?next=x") ?? "", /login/);
  assert.equal(riskyUrlReason("https://example.com/about"), undefined);
  assert.equal(riskyUrlReason("not a url"), undefined);
  assert.equal(riskyUrlReason(undefined), undefined);
});

test("dictation: ordinary fields run; password fields and hands-off apps are refused, not asked", () => {
  assert.equal(classifyAction({ kind: "dictate", app: "Notes" }).verdict, "run");
  assert.equal(classifyAction({ kind: "dictate", app: "Google Chrome", text: "hello there" }).verdict, "run");
  const secure = classifyAction({ kind: "dictate", app: "Safari", secureField: true });
  assert.equal(secure.verdict, "refuse");
  assert.match(secure.reason, /password field/);
  const vault = classifyAction({ kind: "dictate", app: "1Password" });
  assert.equal(vault.verdict, "refuse");
  assert.match(vault.reason, /types there himself/);
  assert.equal(classifyAction({ kind: "dictate", app: "System Settings", confirmed: true }).verdict, "refuse", "a yes does not open a hands-off app to dictation");
});
