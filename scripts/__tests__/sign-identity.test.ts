import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseIdentity, identityLine, identityNames } from "../sign-identity.ts";

/**
 * The signing identity `pnpm build:mac` picks, pinned in order: the pin wins, then Apple's
 * two kinds, then a certificate named for this app, then any "Code Signing" name, then the
 * first listed, then ad-hoc — and the line that says which before anything is signed.
 * The keychain listing below is the shape `security find-identity -v -p codesigning` prints.
 */

const LISTING = `Policy: Code Signing
  Matching identities
  1) 8B79555CA54FF1C95D3E044805F34D5ADAC36055 "Some Other Cert"
  2) 1111111111111111111111111111111111111111 "Jarvis Local Signing"
  3) 2222222222222222222222222222222222222222 "Apple Development: Kevin Liu (ABCDE12345)"
     3 identities found

  Valid identities only
  1) 8B79555CA54FF1C95D3E044805F34D5ADAC36055 "Some Other Cert"
  2) 1111111111111111111111111111111111111111 "Jarvis Local Signing"
  3) 2222222222222222222222222222222222222222 "Apple Development: Kevin Liu (ABCDE12345)"
     3 valid identities found
`;

test("identityNames: every quoted name in the listing, in the listing's order", () => {
  assert.deepEqual(identityNames(LISTING).slice(0, 3), ["Some Other Cert", "Jarvis Local Signing", "Apple Development: Kevin Liu (ABCDE12345)"]);
  assert.deepEqual(identityNames("     0 valid identities found\n"), []);
});

test("chooseIdentity: the pin wins over everything, and `-` pins ad-hoc", () => {
  assert.deepEqual(chooseIdentity(["Apple Development: X"], "My Cert"), { identity: "My Cert", how: "pinned" });
  assert.deepEqual(chooseIdentity(["Apple Development: X"], "-"), { identity: undefined, how: "pinned" });
  assert.equal(identityLine(chooseIdentity([], "-")), "[build-mac] signing identity: ad-hoc (pinned)");
  // An empty pin is no pin.
  assert.equal(chooseIdentity(["Some Other Cert"], "").how, "first listed");
});

test("chooseIdentity: Apple Development before Developer ID before a name for this app before a Code Signing name before the first listed", () => {
  const names = ["Some Other Cert", "Local Code Signing", "Jarvis Local Signing", "Developer ID Application: Kevin Liu (ABCDE12345)", "Apple Development: Kevin Liu (ABCDE12345)"];
  assert.deepEqual(chooseIdentity(names, undefined), { identity: "Apple Development: Kevin Liu (ABCDE12345)", how: "Apple Development" });
  assert.deepEqual(chooseIdentity(names.slice(0, 4), undefined), { identity: "Developer ID Application: Kevin Liu (ABCDE12345)", how: "Developer ID" });
  assert.deepEqual(chooseIdentity(names.slice(0, 3), undefined), { identity: "Jarvis Local Signing", how: "name match" });
  assert.deepEqual(chooseIdentity(["Some Other Cert", "Jarhead Dev"], undefined), { identity: "Jarhead Dev", how: "name match" });
  assert.deepEqual(chooseIdentity(names.slice(0, 2), undefined), { identity: "Local Code Signing", how: "name match" });
  assert.deepEqual(chooseIdentity(names.slice(0, 1), undefined), { identity: "Some Other Cert", how: "first listed" });
  assert.deepEqual(chooseIdentity([], undefined), { identity: undefined, how: "none → ad-hoc" });
});

test("identityLine: the name and how it was chosen, before the first codesign call", () => {
  assert.equal(identityLine(chooseIdentity(identityNames(LISTING), undefined)), "[build-mac] signing identity: Apple Development: Kevin Liu (ABCDE12345) (Apple Development)");
  assert.equal(identityLine(chooseIdentity(["Jarvis Local Signing"], undefined)), "[build-mac] signing identity: Jarvis Local Signing (name match)");
  assert.equal(identityLine(chooseIdentity([], undefined)), "[build-mac] signing identity: ad-hoc (none → ad-hoc)");
});
