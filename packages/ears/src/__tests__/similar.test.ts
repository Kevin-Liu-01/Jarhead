import { test } from "node:test";
import assert from "node:assert/strict";
import { detect } from "../wake.ts";
import { editDistance, looksLikeName, nameLengthAt } from "../similar.ts";

/**
 * Every one of these was produced by the transcriber for a clear "jarhead".
 * The enumerated list this replaced lost the race — each session invented a
 * spelling it did not have, and every miss read to Kevin as being ignored.
 */
const OBSERVED = ["jarhead", "jawhead", "chathead", "jared", "jarhed"];

test("mishearings observed in the wild all match", () => {
  for (const w of OBSERVED) assert.equal(looksLikeName(w), true, w);
});

test("plausible manglings nobody enumerated also match", () => {
  // The point of structure over a list: these were never written down anywhere.
  for (const w of ["garhead", "charhead", "shathead", "zarhead", "jarheart", "jahead", "carhead"]) {
    assert.equal(looksLikeName(w), true, w);
  }
});

test("ordinary compounds ending in head do not", () => {
  // All of these end in "head" and none of them are the name. The initial-sound
  // guard is what separates them.
  for (const w of ["letterhead", "arrowhead", "forehead", "redhead", "overhead", "ahead", "head"]) {
    assert.equal(looksLikeName(w), false, w);
  }
});

test("a split name is consumed as two words, not one", () => {
  // Matching only the first token would leave "head" stranded in the command.
  assert.equal(nameLengthAt(["jar", "head", "whats", "up"], 0), 2);
  assert.equal(detect("hey jar head whats on hackernews").command, "whats on hackernews");
});

test("joining adjacent words cannot invent a match", () => {
  // "go ahead" joined to "goahead" has a g prefix and a head suffix, and woke
  // him on an ordinary sentence. The second token must be a head-word itself.
  assert.equal(nameLengthAt(["go", "ahead", "and"], 0), 0);
  assert.equal(detect("go ahead and do that").woke, false);
  assert.equal(detect("i went ahead and shipped it").woke, false);
});

test("bed and bad only count as the tail of a pair", () => {
  // "jar bed" is a real transcription; the words alone are far too common.
  assert.equal(detect("hey jar bed").woke, true);
  assert.equal(looksLikeName("bed"), false);
  assert.equal(detect("time for bed").woke, false);
});

test("edit distance is symmetric and zero only for identity", () => {
  assert.equal(editDistance("jarhead", "jarhead"), 0);
  assert.equal(editDistance("jarhead", "jawhead"), editDistance("jawhead", "jarhead"));
  assert.equal(editDistance("", "abc"), 3);
});

test("a name still has to be addressed, however well it matched", () => {
  // Fuzzy matching widens what counts as the name; it must not widen what
  // counts as talking TO him.
  assert.equal(detect("the thing about jawhead is that it never listens").woke, false);
});
