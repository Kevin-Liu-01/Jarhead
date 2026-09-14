import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rect } from "@jarhead/protocol";
import type { BrainAttachment } from "../brain.ts";
import { attachmentsPreamble, attachmentsRecap, markNote } from "../attachments.ts";

/**
 * The words every brain reads with a mark. Two kinds ride the same note: a
 * stroke ("circled this region") and a front window captured whole by the
 * notch's Window box ("captured this window", `source: "window"`). The verb,
 * the age suffix and the preamble's one closing sentence are pinned here so a
 * "what is this?" means the same thing to every backend.
 */

const REGION: Rect = { x: 10, y: 20, w: 100, h: 50.4 };
const WINDOW: Rect = { x: 0, y: 25, w: 1280, h: 800 };
const CIRCLE_NOTE = "Kevin circled this region of his screen: 10,20 100×50 (global points)";
const WINDOW_NOTE = "Kevin captured this window of his screen: 0,25 1280×800 (global points)";

const mark = (note: string): BrainAttachment => ({ path: "/tmp/never-read.png", mediaType: "image/png", note, kind: "mark" });

test('a window mark is "captured this window"', () => {
  assert.equal(markNote(WINDOW, 0, "window"), WINDOW_NOTE);
  assert.match(markNote(WINDOW, 0, "window"), /^Kevin captured this window of his screen: /);
  assert.doesNotMatch(markNote(WINDOW, 0, "window"), /circled/);
});

test("a circle's note is unchanged: with no source, and with source \"circle\"", () => {
  assert.equal(markNote(REGION), CIRCLE_NOTE);
  assert.equal(markNote(REGION, 0), CIRCLE_NOTE);
  assert.equal(markNote(REGION, 0, undefined), CIRCLE_NOTE);
  assert.equal(markNote(REGION, 0, "circle"), CIRCLE_NOTE);
});

test("the age suffix says captured for a window and circled for a stroke; under a minute there is none", () => {
  assert.equal(markNote(REGION, 59_000), CIRCLE_NOTE);
  assert.equal(markNote(WINDOW, 59_000, "window"), WINDOW_NOTE);
  assert.equal(markNote(REGION, 3 * 60_000), `${CIRCLE_NOTE}, circled 3 min ago`);
  assert.equal(markNote(WINDOW, 3 * 60_000, "window"), `${WINDOW_NOTE}, captured 3 min ago`);
  assert.equal(markNote(REGION, 5 * 3_600_000), `${CIRCLE_NOTE}, circled 5 h ago`);
  assert.equal(markNote(WINDOW, 5 * 3_600_000, "window"), `${WINDOW_NOTE}, captured 5 h ago`);
  assert.equal(markNote(WINDOW, Number.NaN, "window"), WINDOW_NOTE, "a non-finite age is no age");
});

test("the preamble closes with the one sentence for both kinds, once, whether the marks are circles, windows or both", () => {
  const sentence = 'Treat what Kevin circled or captured as what he means by "this"; look at it before answering.';
  const circles = attachmentsPreamble([mark(CIRCLE_NOTE)]);
  assert.equal(circles, `Attached image 1: ${CIRCLE_NOTE}\n${sentence}`);
  const windows = attachmentsPreamble([mark(WINDOW_NOTE)]);
  assert.equal(windows, `Attached image 1: ${WINDOW_NOTE}\n${sentence}`);
  const both = attachmentsPreamble([mark(CIRCLE_NOTE), mark(WINDOW_NOTE)]);
  assert.equal(both, `Attached image 1: ${CIRCLE_NOTE}\nAttached image 2: ${WINDOW_NOTE}\n${sentence}`);
  assert.equal(both.split(sentence).length - 1, 1, "the sentence is said once");
  assert.doesNotMatch(both, /Treat the circled region/, "the old one-kind sentence is gone");
});

test("the pre-warm screenshot alone gets no closing sentence; the recap names the marks without one", () => {
  const screen: BrainAttachment = { path: "/tmp/never-read.png", mediaType: "image/png", note: "the screen right now", kind: "screen" };
  assert.equal(attachmentsPreamble([screen]), "Attached image 1: the screen right now");
  assert.equal(attachmentsPreamble(undefined), "");
  assert.equal(attachmentsPreamble([]), "");
  assert.equal(attachmentsRecap([mark(CIRCLE_NOTE), mark(WINDOW_NOTE)]), `${CIRCLE_NOTE}\n${WINDOW_NOTE}`);
});
