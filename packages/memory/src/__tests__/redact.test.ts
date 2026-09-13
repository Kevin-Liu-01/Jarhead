import { test } from "node:test";
import assert from "node:assert/strict";
import { luhnValid, normalizeText, redactThenDrop, refuseReason } from "../redact.ts";
import { redactFake } from "./helpers.ts";

/**
 * Redact-then-drop: the runner's mark drops the whole line; memory's own
 * shapes drop cards, SSNs, spoken passwords and codes, secret paths and env
 * names; contact details survive only for an explicit remembered contact.
 */

test("redact: a line the injected redactor changed is dropped whole — the extractor never sees '[redacted secret]'", () => {
  const out = redactThenDrop(redactFake, "the key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
  assert.ok("dropped" in out);
  assert.equal(refuseReason("here: [redacted secret]"), "redacted secret");
  const kept = redactThenDrop(redactFake, "Kevin prefers short answers");
  assert.deepEqual(kept, { text: "Kevin prefers short answers" });
});

test("redact: a Luhn-valid card with spaces or dashes is dropped; a 16-digit non-Luhn order number is kept", () => {
  assert.ok(luhnValid("4111111111111111"));
  assert.ok(!luhnValid("4111111111111112"));
  assert.equal(refuseReason("my card is 4111 1111 1111 1111"), "card number");
  assert.equal(refuseReason("card 4111-1111-1111-1111 please"), "card number");
  assert.equal(refuseReason("order number 1234 5678 9012 3457"), undefined);
  assert.equal(refuseReason("Kevin's flight is at 10:45 on 2026-09-08"), undefined);
});

test("redact: SSN, spoken passwords and one-time codes are dropped; ordinary uses of the words are kept", () => {
  assert.equal(refuseReason("my SSN is 123-45-6789"), "SSN");
  assert.equal(refuseReason("my password is hunter22"), "password");
  assert.equal(refuseReason("set the wifi password to correct-horse"), "password");
  assert.equal(refuseReason("password: abc12345"), "password");
  assert.equal(refuseReason("I forgot my password again"), undefined);
  assert.equal(refuseReason("the verification code is 493201"), "one-time code");
  assert.equal(refuseReason("otp 1234"), "one-time code");
  assert.equal(refuseReason("my pin is 4821"), "one-time code");
  assert.equal(refuseReason("pin that conversation"), undefined);
  assert.equal(refuseReason("cvv 123"), "one-time code");
});

test("redact: secret paths and env names refuse; emails and phones survive only for kind contact + origin kevin", () => {
  assert.match(refuseReason("copy ~/.ssh/id_ed25519 to the server") ?? "", /secret path/);
  assert.equal(refuseReason("echo $OPENAI_API_KEY"), "secret env name");
  assert.equal(refuseReason("Ben's email is ben@example.com"), "email address");
  assert.equal(refuseReason("Ben's email is ben@example.com", { kind: "contact", origin: "kevin" }), undefined);
  assert.equal(refuseReason("Ben's email is ben@example.com", { kind: "contact", origin: "extracted" }), "email address");
  assert.equal(refuseReason("call Ben at +1 (415) 555-0123"), "phone number");
  assert.equal(refuseReason("call Ben at +1 (415) 555-0123", { kind: "contact", origin: "kevin" }), undefined);
  assert.equal(refuseReason("Kevin prefers dark mode"), undefined);
});

test("redact: normalizeText folds case, whitespace and trailing punctuation (the sha and equality key)", () => {
  assert.equal(normalizeText("  Kevin   goes by Kev. "), "kevin goes by kev");
  assert.equal(normalizeText("Kevin goes by Kev"), normalizeText("kevin goes by kev!"));
  assert.notEqual(normalizeText("Kevin prefers dark mode"), normalizeText("Kevin prefers light mode"));
});
