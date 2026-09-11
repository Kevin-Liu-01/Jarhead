import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildListWindowsScript,
  buildShallowCountScript,
  buildWalkScript,
  escapeAppleScriptString,
  pathToReference,
} from "../ax.ts";
import { buildKeyScript, buildTypeScript } from "../input.ts";

/**
 * Quotes still active as syntax after escape sequences are stripped. If a
 * hostile title added even one, it closed the literal and got to write script.
 */
const unescapedQuotes = (script: string): number => (script.replace(/\\[\s\S]/g, "").match(/"/g) ?? []).length;

const HOSTILE = `Cursor" \n tell application "Finder" to delete every item \\ of desktop \\" x`;

test("escapes backslashes before quotes so escapes cannot be re-broken", () => {
  assert.equal(escapeAppleScriptString('\\"'), '\\\\\\"');
});

test("escapes quotes, newlines, carriage returns and tabs", () => {
  assert.equal(escapeAppleScriptString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeAppleScriptString("a\nb"), "a\\nb");
  assert.equal(escapeAppleScriptString("a\rb"), "a\\rb");
  assert.equal(escapeAppleScriptString("a\tb"), "a\\tb");
});

test("a hostile app name cannot terminate the string literal", () => {
  for (const build of [
    (name: string) => buildListWindowsScript(name),
    (name: string) => buildWalkScript(name, 100),
    (name: string) => buildShallowCountScript(name),
  ]) {
    const evil = build(HOSTILE);
    const benign = build("Safari");
    assert.equal(unescapedQuotes(evil), unescapedQuotes(benign), "hostile name added an active quote");
    assert.equal(evil.split("\n").length, benign.split("\n").length, "hostile name injected a raw newline");
    assert.ok(evil.includes(escapeAppleScriptString(HOSTILE)), "hostile name should land verbatim-but-escaped");
  }
});

test("typed text cannot break out of the keystroke literal", () => {
  const script = buildTypeScript('" & (do shell script "rm -rf ~") & "');
  assert.equal(unescapedQuotes(script), unescapedQuotes(buildTypeScript("hello")), "hostile text added an active quote");
});

test("key combos map to key codes and modifiers", () => {
  assert.equal(buildKeyScript("enter"), `tell application "System Events" to key code 36`);
  assert.equal(
    buildKeyScript("cmd+shift+p"),
    `tell application "System Events" to keystroke "p" using {command down, shift down}`,
  );
  assert.equal(buildKeyScript("ctrl+left"), `tell application "System Events" to key code 123 using {control down}`);
});

test("key combos reject what they cannot express instead of guessing", () => {
  assert.throws(() => buildKeyScript(""));
  assert.throws(() => buildKeyScript("hyper+p"), /unknown modifier/);
  assert.throws(() => buildKeyScript("cmd+definitely-not-a-key"), /unknown key/);
});

test("a quote as the key itself stays escaped", () => {
  assert.equal(unescapedQuotes(buildKeyScript('cmd+"')), unescapedQuotes(buildKeyScript("cmd+p")));
});

test("pathToReference builds an index-only reference", () => {
  assert.equal(pathToReference("/w/2/5"), "UI element 5 of UI element 2 of window 1");
  assert.equal(pathToReference("/m/1"), "UI element 1 of menu bar 1");
});

test("pathToReference rejects anything but slash-separated indexes", () => {
  const bad = [
    "",
    "/w",
    "/m",
    "w/1",
    "/x/1",
    "/w/1/x",
    "/w/-1",
    "/w/1/2 ",
    "/w/1;/2",
    `/w/1" of window "Evil`,
    "/w/1/2\ndo shell script",
  ];
  for (const path of bad) {
    assert.throws(() => pathToReference(path), /invalid element path/, `should reject ${JSON.stringify(path)}`);
  }
});

test("buildWalkScript rejects a nonsense element cap", () => {
  assert.throws(() => buildWalkScript("Safari", 0));
  assert.throws(() => buildWalkScript("Safari", -5));
  assert.throws(() => buildWalkScript("Safari", 1.5));
});
