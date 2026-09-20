import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "@jarhead/protocol";
import { accountFullName, capitalizeName, effectiveUserName, parseRealName } from "../user.ts";

/**
 * The user's name (release F1): the setting wins when set, the account's full name is the
 * fallback, and the fallback is read from `dscl` once with the login name behind it.
 */

test("effectiveUserName: the setting when set (trimmed), the fallback when unset or blank", () => {
  assert.equal(effectiveUserName({ userName: "Sam" }, "Kevin Liu"), "Sam");
  assert.equal(effectiveUserName({ userName: "  Sam  " }, "Kevin Liu"), "Sam");
  assert.equal(effectiveUserName({ userName: "" }, "Kevin Liu"), "Kevin Liu");
  assert.equal(effectiveUserName({ userName: "   " }, "Kevin Liu"), "Kevin Liu");
  assert.equal(effectiveUserName(DEFAULT_SETTINGS, "Ada"), "Ada", "the default setting is unset");
  assert.equal(effectiveUserName({ userName: undefined as unknown as string }, "Ada"), "Ada", "a settings.json from before the key");
});

test("parseRealName reads dscl's two shapes", () => {
  assert.equal(parseRealName("RealName:\n Kevin Liu\n"), "Kevin Liu");
  assert.equal(parseRealName("RealName: Kevin Liu\n"), "Kevin Liu");
  assert.equal(parseRealName("RealName:\n  Ada   Lovelace  \n"), "Ada Lovelace");
  assert.equal(parseRealName("dsRecTypeStandard:Users\n"), "");
  assert.equal(parseRealName(""), "");
});

test("accountFullName: dscl's RealName on darwin; the capitalised login name when dscl fails, is empty, or off darwin", () => {
  const calls: string[][] = [];
  const exec = (file: string, args: readonly string[]): string => {
    calls.push([file, ...args]);
    return "RealName:\n Kevin Liu\n";
  };
  assert.equal(accountFullName({ exec, username: "kevinliu", platform: "darwin" }), "Kevin Liu");
  assert.deepEqual(calls, [["dscl", ".", "-read", "/Users/kevinliu", "RealName"]], "one read, argv only");
  assert.equal(accountFullName({ exec: () => { throw new Error("no dscl"); }, username: "kevinliu", platform: "darwin" }), "Kevinliu");
  assert.equal(accountFullName({ exec: () => "RealName:\n\n", username: "sam", platform: "darwin" }), "Sam");
  assert.equal(accountFullName({ exec: () => { throw new Error("never called"); }, username: "sam", platform: "linux" }), "Sam");
  assert.equal(accountFullName({ exec: () => { throw new Error("never called"); }, username: "bad name;rm", platform: "darwin" }), "Bad name;rm", "a login name that is not a record path is never handed to dscl");
  assert.equal(accountFullName({ exec: () => "", username: "", platform: "linux" }), "there", "never empty");
  assert.equal(capitalizeName("kevin"), "Kevin");
  assert.equal(capitalizeName(""), "");
});
