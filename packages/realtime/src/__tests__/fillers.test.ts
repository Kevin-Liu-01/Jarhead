import { test } from "node:test";
import assert from "node:assert/strict";
import { FILLERS, fillerInstruction, pickFiller } from "../fillers.ts";

test("there are enough fillers that a long session does not loop audibly", () => {
  assert.ok(FILLERS.length >= 50, `expected 50+, got ${FILLERS.length}`);
  assert.equal(new Set(FILLERS).size, FILLERS.length, "duplicates would repeat sooner than intended");
});

test("every filler is short enough to finish before the tool does", () => {
  // A filler that outlasts the work it covers is just a slower answer.
  for (const f of FILLERS) {
    assert.ok(f.split(/\s+/).length <= 7, `too long to land in under a second: "${f}"`);
  }
});

test("no filler asks a question or promises a result", () => {
  for (const f of FILLERS) {
    assert.ok(!f.includes("?"), `a question invites Kevin to talk over the reply: "${f}"`);
    assert.ok(
      !/\b(found|here it is|it's at|i see)\b/i.test(f),
      `promises an answer the tool may not produce: "${f}"`,
    );
  }
});

test("the same filler never comes twice in a row", () => {
  // Immediate repetition is what reveals a canned list; a repeat five turns
  // later is invisible.
  let last: string | undefined;
  for (let i = 0; i < 200; i++) {
    const next = pickFiller(last);
    assert.notEqual(next, last);
    last = next;
  }
});

test("picking is deterministic under an injected source", () => {
  assert.equal(pickFiller(undefined, () => 0), FILLERS[0]);
  assert.equal(pickFiller(FILLERS[0], () => 0), FILLERS[1], "the excluded one shifts the pool");
});

test("the instruction carries every phrase and forbids embellishment", () => {
  const text = fillerInstruction();
  for (const f of FILLERS) assert.ok(text.includes(f), `missing from the prompt: "${f}"`);
  assert.match(text, /never repeat the one you just used/i);
  assert.match(text, /Do not promise a result/i);
});

test("expiry is recognised from the message the API actually sends", () => {
  // Verbatim from a live session: "Your session hit the maximum duration of 60
  // minutes." An always-on assistant that does not reconnect goes deaf after an
  // hour while still holding the microphone.
  const EXPIRY = /maximum duration|session expired/i;
  assert.ok(EXPIRY.test("Your session hit the maximum duration of 60 minutes."));
  assert.ok(EXPIRY.test("session expired"));
  assert.ok(!EXPIRY.test("Conversation already has an active response in progress"));
});
