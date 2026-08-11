import { test } from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter } from "../tts.ts";

/** Feed a whole string one token at a time, the way the model streams it. */
function stream(splitter: SentenceSplitter, text: string): string[] {
  const out: string[] = [];
  for (const ch of text) out.push(...splitter.push(ch));
  const tail = splitter.flush();
  if (tail) out.push(tail);
  return out;
}

test("splits on sentence boundaries", () => {
  const s = new SentenceSplitter(false);
  const chunks = stream(s, "The first thing happened. The second thing happened too. Done.");
  assert.deepEqual(chunks, [
    "The first thing happened.",
    "The second thing happened too.",
    "Done.",
  ]);
});

test("does not split inside an abbreviation", () => {
  const s = new SentenceSplitter(false);
  const chunks = stream(s, "It runs on macOS, i.e. this machine, and nowhere else.");
  assert.equal(chunks.length, 1, `expected one chunk, got ${JSON.stringify(chunks)}`);
});

test("eager mode breaks the first chunk at a clause to cut dead air", () => {
  const eager = new SentenceSplitter(true);
  const chunks = stream(
    eager,
    "Muse Glimmer is topping the board right now, with over a thousand points on it.",
  );
  assert.ok(chunks.length >= 2, "eager mode should emit an early first chunk");
  assert.ok(
    chunks[0]!.length < 60,
    `first chunk should be short so TTS starts early, got ${chunks[0]!.length} chars`,
  );
});

test("eager mode applies only to the first chunk", () => {
  const eager = new SentenceSplitter(true);
  const chunks = stream(eager, "Short opener here, then more. Second sentence, with a comma, stays whole.");
  const second = chunks[chunks.length - 1]!;
  assert.ok(
    second.includes(",") && second.trim().endsWith("."),
    `later chunks should keep their commas, got ${JSON.stringify(second)}`,
  );
});

test("does not emit a chunk too short to sound natural", () => {
  const s = new SentenceSplitter(false);
  const chunks = stream(s, "Yes. That is the answer to your question.");
  assert.ok(
    chunks[0]!.length > 4,
    `should not flush a two-character fragment, got ${JSON.stringify(chunks[0])}`,
  );
});

test("flush returns the trailing fragment with no terminator", () => {
  const s = new SentenceSplitter(false);
  const chunks = stream(s, "This one never got a full stop");
  assert.deepEqual(chunks, ["This one never got a full stop"]);
});

test("empty stream produces nothing", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(stream(s, ""), []);
});
