import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, isBareWake } from "../wake.ts";
import { applySilence, endpointFrom, INITIAL_ENDPOINT, isBargeIn, parseSilence } from "../vad.ts";

test("wakes on the canonical phrase", () => {
  const m = detect("hey jarvis");
  assert.equal(m.woke, true);
  assert.equal(m.bare, true);
  assert.equal(m.command, "");
});

test("wakes on documented mishearings", () => {
  for (const u of ["hey travis", "hey jervis", "hi javis", "hello jarvus"]) {
    assert.equal(detect(u).woke, true, u);
  }
});

test("separates the command from the wake phrase", () => {
  const m = detect("hey jarvis what's on hackernews");
  assert.equal(m.woke, true);
  assert.equal(m.bare, false);
  assert.equal(m.command, "what's on hackernews");
});

test("does not wake when the name appears late in the sentence", () => {
  // The false accept that makes an always-on assistant intolerable.
  assert.equal(detect("I was telling Sarah about jarvis yesterday").woke, false);
});

test("a bare name with no greeting and no command is not a wake", () => {
  assert.equal(detect("jarvis").woke, false);
});

test("a bare name followed by a command does wake", () => {
  const m = detect("jarvis what time is it");
  assert.equal(m.woke, true);
  assert.equal(m.command, "what time is it");
});

test("punctuation and casing do not matter", () => {
  assert.equal(detect("Hey, Jarvis! ").woke, true);
});

test("empty input never wakes", () => {
  assert.equal(detect("").woke, false);
  assert.equal(detect("   ").woke, false);
});

test("isBareWake distinguishes greeting-only from a command", () => {
  assert.equal(isBareWake("hey jarvis"), true);
  assert.equal(isBareWake("hey jarvis what's up"), false);
});

test("parses ffmpeg silence events", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 0.5",
    "[silencedetect @ 0x1] silence_end: 2.13 | silence_duration: 1.63",
  ].join("\n");

  const events = parseSilence(stderr);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: "start", at: 0.5, duration: undefined });
  assert.equal(events[1]?.kind, "end");
  assert.equal(events[1]?.duration, 1.63);
});

test("silence before any speech does not end the recording", () => {
  // The pause while the user gets around to talking.
  const state = applySilence(INITIAL_ENDPOINT, { kind: "start", at: 0.4, duration: undefined });
  assert.equal(state.shouldCut, false);
  assert.equal(state.heardSpeech, false);
});

test("silence after speech does end the recording", () => {
  const after = endpointFrom(
    [
      "silence_end: 1.0 | silence_duration: 1.0",
      "silence_start: 3.2",
    ].join("\n"),
  );
  assert.equal(after.heardSpeech, true);
  assert.equal(after.shouldCut, true);
  assert.equal(after.silenceSince, 3.2);
});

test("ignores malformed stderr rather than throwing", () => {
  assert.deepEqual(parseSilence("frame= 12 fps=0.0 q=-1.0 size=  4kB"), []);
  assert.deepEqual(parseSilence(""), []);
});

test("barge-in requires sustained speech, not a blip", () => {
  const blip = parseSilence(
    ["silence_end: 1.00 | silence_duration: 1.0", "silence_start: 1.10"].join("\n"),
  );
  assert.equal(isBargeIn(blip, 0.4), false, "a 100ms blip is Jarvis hearing itself");

  const sustained = parseSilence(
    ["silence_end: 1.00 | silence_duration: 1.0", "silence_start: 1.80"].join("\n"),
  );
  assert.equal(isBargeIn(sustained, 0.4), true);
});

test("barge-in is false when nothing was said at all", () => {
  assert.equal(isBargeIn([], 0.4), false);
  assert.equal(isBargeIn(parseSilence("silence_start: 2.0"), 0.4), false);
});
