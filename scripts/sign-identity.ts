/**
 * Which code-signing identity `pnpm build:mac` signs with, and why. Decided from the
 * names `security find-identity -v -p codesigning` lists and the JARHEAD_SIGN_IDENTITY
 * pin, and printed as one line BEFORE the first codesign call, so a wrong pick is seen
 * before it signs rather than in the summary after. The order:
 *
 *   JARHEAD_SIGN_IDENTITY (pinned; `-` = ad-hoc)
 *   → a name starting `Apple Development`
 *   → a name starting `Developer ID Application`
 *   → a name matching /jarhead|jarvis/i (the certificate made for this app)
 *   → a name matching /code signing/i
 *   → the first name listed
 *   → none: ad-hoc.
 *
 * Pure: build-mac.ts supplies the environment and the keychain's listing. The codesign
 * arguments themselves are build-mac.ts's and do not depend on how the name was found.
 */

export type IdentityHow = "pinned" | "Apple Development" | "Developer ID" | "name match" | "first listed" | "none → ad-hoc";

export interface IdentityChoice {
  /** What `codesign --sign` gets; undefined means ad-hoc (`-`). */
  readonly identity: string | undefined;
  readonly how: IdentityHow;
}

export function chooseIdentity(names: readonly string[], pinned: string | undefined): IdentityChoice {
  if (pinned) return { identity: pinned === "-" ? undefined : pinned, how: "pinned" };
  const apple = names.find((n) => n.startsWith("Apple Development"));
  if (apple !== undefined) return { identity: apple, how: "Apple Development" };
  const developerId = names.find((n) => n.startsWith("Developer ID Application"));
  if (developerId !== undefined) return { identity: developerId, how: "Developer ID" };
  const named = names.find((n) => /jarhead|jarvis/i.test(n)) ?? names.find((n) => /code signing/i.test(n));
  if (named !== undefined) return { identity: named, how: "name match" };
  const first = names[0];
  if (first !== undefined) return { identity: first, how: "first listed" };
  return { identity: undefined, how: "none → ad-hoc" };
}

/** The quoted names in a `security find-identity -v -p codesigning` listing, in its order. */
export function identityNames(listing: string): string[] {
  return [...listing.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").filter(Boolean);
}

/** The one line printed before the first codesign call. */
export function identityLine(choice: IdentityChoice): string {
  return `[build-mac] signing identity: ${choice.identity ?? "ad-hoc"} (${choice.how})`;
}
