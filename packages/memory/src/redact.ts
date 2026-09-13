import { secretEnvReason, secretPathReason } from "@jarhead/core";
import type { MemoryKind, MemoryOrigin } from "@jarhead/protocol";

/**
 * Privacy on the way in: redact-then-drop.
 *
 * The runner's redactor (injected — it is not exported from the brain's index, a
 * rail) strikes known secret values and secret shapes. Memory never shows a
 * masked line to the extractor: a line the redactor changed is DROPPED, so the
 * model never sees "[redacted secret]" and cannot record that a secret exists.
 * Then memory's own refusal shapes drop what the runner does not know about —
 * card numbers, SSNs, spoken passwords and codes, secret paths and env names —
 * from every input line and from every candidate, edit and add.
 */

export const REDACTED_MARK = "[redacted secret]";

/** The normalised form used for equality and cache keys: lowercase, one space, no trailing punctuation. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[\s.!?,;:]+$/g, "").toLowerCase();
}

/** Luhn check over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD_RUN = /(?:\d[ -]?){12,18}\d/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
/** "my password is hunter22", "password: abc123", "set the wifi password to …" — a connector word keeps "I forgot my password again" out. */
const PASSWORD = /\b(?:password|passcode|passphrase|pass ?word)\b(?:\s+(?:for|of|to|on)\s+[\w'.-]+(?:\s+[\w'.-]+)?)?\s*(?:is|was|:|=|to|becomes?)\s*["']?\S{4,}/i;
const CODE_WORDS = /\b(?:verification|security|one[- ]time|auth(?:entication)?|2fa|otp|login|recovery|backup)\s+codes?\b.{0,40}?\b\d{4,}\b/i;
const CODE_SHORT = /\b(?:otp|2fa|cvv|cvc)\b.{0,20}?\b\d{3,}\b/i;
const PIN = /\bpin\b.{0,20}?\b\d{4,}\b/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;

export interface RefuseContext {
  readonly kind?: MemoryKind;
  readonly origin?: MemoryOrigin;
}

/**
 * Why a line or a candidate must not be remembered, or undefined when it may.
 * Contact details survive only for an explicit "remember" of a contact
 * (kind contact, origin kevin) — anything else that carries an email or a phone
 * is refused.
 */
export function refuseReason(text: string, ctx: RefuseContext = {}): string | undefined {
  if (text.includes(REDACTED_MARK)) return "redacted secret";
  for (const m of text.matchAll(CARD_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (luhnValid(digits)) return "card number";
  }
  if (SSN.test(text)) return "SSN";
  if (PASSWORD.test(text)) return "password";
  if (CODE_WORDS.test(text) || CODE_SHORT.test(text) || PIN.test(text)) return "one-time code";
  const path = secretPathReason(text);
  if (path) return `secret path (${path})`;
  const env = secretEnvReason(text);
  if (env) return "secret env name";
  const contactOk = ctx.kind === "contact" && ctx.origin === "kevin";
  if (!contactOk) {
    if (EMAIL.test(text)) return "email address";
    for (const m of text.matchAll(PHONE)) {
      const digits = m[0].replace(/\D/g, "").length;
      if (digits >= 10 && digits <= 15) return "phone number";
    }
  }
  return undefined;
}

export type Redact = (text: string) => string;

/**
 * Run the injected redactor, drop the line if it changed anything, then apply
 * memory's own shapes. Returns the line to use, or undefined with the reason
 * it was dropped.
 */
export function redactThenDrop(redact: Redact, text: string, ctx?: RefuseContext): { readonly text: string } | { readonly dropped: string } {
  const r = redact(text);
  if (r !== text) return { dropped: "redactor changed the line" };
  const why = refuseReason(r, ctx);
  if (why) return { dropped: why };
  return { text: r };
}
