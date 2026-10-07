import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@jarhead/protocol";
import { VoiceAttention } from "../voice-attention.ts";

/**
 * A split's tail, bounded by the old turn's own sound (CI 1c140d8, LC-7 dry: three frames of an answer to the room
 * played as the pre-sleep clause). Once a granted turn has had as much PCM from its first audible frame as its words
 * cover on Live's timeline, every later frame is the next turn's, however soon after that turn's words it comes. A
 * dropped turn's tail keeps SPLIT_SOUND_LAG_MS: cutting it short could only play its last sound as the next turn's.
 *
 * Frames carry their real length: Live's are 100 ms (4800 bytes of PCM16 at 24 kHz), the dry stand-in's 10 ms (480).
 * Wall clock and session timeline move together here. Five of the first six fail on b7525e8. Two of the last three
 * fail on 60f1996: a pause of the stand-in's clock counted as words (WORD_GAP_MS), and a handed-over frame that
 * started the next turn's late-name clock.
 */

const LIVE_FRAME = Buffer.alloc(4800);
const DRY_FRAME = Buffer.alloc(480);
const CLAUSE = "Nothing has been said for a while: you are going to sleep in about 5 seconds.";

function gate() {
  const clock = { t: 1_000_000 };
  const a = new VoiceAttention({ now: () => clock.t, echo: () => false, inExchange: () => false, working: () => undefined, spoke: () => undefined });
  a.reset(false, { acks: false });
  /** Wall and session timeline move together here: `at` is both, from the session's start. */
  const at = (ms: number) => void (clock.t = 1_000_000 + ms);
  const items = new Map<string, TranscriptItem>();
  const say = (text: string, startMs: number, endMs: number, id: string) => {
    const prev = items.get(id);
    const item: TranscriptItem = { id, speaker: "kevin", text: prev ? `${prev.text}${text}` : text.trim(), startMs: prev?.startMs ?? startMs, endMs, at: clock.t, final: false };
    items.set(id, item);
    return a.heard(item, text, startMs);
  };
  /** One frame at session ms `ms`; true: it played. */
  const frame = (ms: number, pcm: Buffer, audible = true) => {
    at(ms);
    return a.frame(pcm, audible, ms);
  };
  return { a, clock, at, say, frame };
}

test("LC-7 dry (CI 1c140d8): the clause has had its sound; the answer to the room 219 ms behind its words, inside SPLIT_SOUND_LAG_MS, is the answer's and is dropped", () => {
  const { a, at, say, frame } = gate();
  at(0);
  a.ask({ aside: true, content: CLAUSE });
  // The stand-in: a sound frame, and on every other one a word of 20 ms on its timeline (it runs late under load).
  const clause: [number, string | undefined][] = [[39, " Going"], [49, undefined], [61, " to"], [71, undefined], [85, " sleep."], [95, undefined]];
  let played = 0;
  for (const [t, word] of clause) {
    if (frame(t, DRY_FRAME)) played++;
    if (word) assert.equal(a.output(word, t, t + 20, "o1"), "spoke");
  }
  assert.equal(played, 6, "the clause is heard to its end");
  // The TV, then the stand-in's answer to it: its words first, its sound 219 ms later, no silence in between.
  at(200);
  say(" my sister is visiting next weekend", 120, 280, "t_tv");
  at(310);
  assert.equal(a.output(" yeah,", 310, 330, "o2"), "pending", "a turn of its own");
  const answer = [529, 540, 552].filter((t) => frame(t, DRY_FRAME)).length;
  assert.equal(answer, 0, "the answer to the room played as the clause");
  assert.equal(a.stats.droppedAudibleFrames, 3);
});

test("Live's 100 ms frames: the clause still streaming when the answer's words land plays to its words' worth; the answer's first frames in the same burst do not", () => {
  const { a, at, say, frame } = gate();
  at(10_900);
  a.ask({ aside: true, content: CLAUSE });
  // Live's transcript on its 200 ms grid, a slot skipped while the voice sounds: 900 ms of words.
  at(11_000);
  a.output(" going", 11_000, 11_200, "o1");
  a.output(" to", 11_200, 11_400, "o1");
  a.output(" sleep.", 11_700, 11_900, "o1");
  let played = 0;
  for (let k = 0; k < 6; k++) if (frame(11_450 + 100 * k, LIVE_FRAME)) played++;
  say(" my sister is visiting", 11_600, 12_000, "t_tv");
  at(12_050);
  assert.equal(a.output(" yeah,", 12_100, 12_300, "o2"), "pending");
  // One late burst at 12_150, inside the old 250 ms tail (12_350): the clause's last three frames, then the answer's two.
  for (let k = 0; k < 3; k++) if (frame(12_150, LIVE_FRAME)) played++;
  assert.equal(played, 9, "the clause plays all 900 ms of its sound");
  assert.equal(frame(12_150, LIVE_FRAME), false, "the answer's first frame");
  assert.equal(frame(12_150, LIVE_FRAME), false);
});

test("a granted turn whose sound ran short of its words: Live's silence after it is its stream too, so the next turn's sound is the next turn's", () => {
  const { a, at, say, frame } = gate();
  at(10_900);
  a.ask({ aside: true, content: CLAUSE });
  at(11_000);
  a.output(" going to sleep.", 11_000, 11_600, "o1");
  let played = 0;
  for (let k = 0; k < 3; k++) if (frame(11_400 + 100 * k, LIVE_FRAME)) played++;
  for (let k = 0; k < 3; k++) frame(11_700 + 100 * k, LIVE_FRAME, false);
  assert.equal(played, 3);
  say(" my sister is visiting", 11_500, 11_900, "t_tv");
  at(12_000);
  assert.equal(a.output(" yeah,", 12_000, 12_200, "o2"), "pending");
  assert.equal(frame(12_100, LIVE_FRAME), false, "600 ms of stream for 600 ms of words, inside the old 250 ms tail: the answer's");
});

test("the old turn's sound counts from its first audible frame: Live's silence before it (its words come first) is not its sound", () => {
  const { a, at, say, frame } = gate();
  at(10_900);
  a.ask({ aside: true, content: CLAUSE });
  at(11_000);
  a.output(" going", 11_000, 11_200, "o1");
  assert.equal(frame(11_050, LIVE_FRAME, false), true, "silence before its sound");
  assert.equal(frame(11_150, LIVE_FRAME, false), true);
  at(11_200);
  a.output(" to sleep.", 11_200, 11_500, "o1");
  assert.equal(frame(11_250, LIVE_FRAME, false), true);
  assert.equal(frame(11_350, LIVE_FRAME, false), true);
  say(" my sister is visiting", 11_300, 11_700, "t_tv");
  at(11_650);
  assert.equal(a.output(" yeah,", 11_650, 11_850, "o2"), "pending");
  let played = 0;
  for (let k = 0; k < 5; k++) if (frame(11_750, LIVE_FRAME)) played++;
  assert.equal(played, 5, "all 500 ms of the clause");
  assert.equal(frame(11_750, LIVE_FRAME), false, "then the answer's");
});

test("a dropped turn's tail is unchanged: the room answer's sound still on its way stays out to SPLIT_SOUND_LAG_MS, even past its words' worth", () => {
  const { a, at, say, frame } = gate();
  at(10_000);
  say(" did you see the game last night?", 10_000, 10_800, "t_tv");
  at(11_000);
  assert.equal(a.output(" no, what happened", 11_000, 11_300, "o1"), "pending");
  for (let k = 0; k < 4; k++) assert.equal(frame(11_200 + 100 * k, LIVE_FRAME), false);
  a.ask({ content: "Your pasta timer is done. Say so once." });
  at(11_550);
  assert.equal(a.output(" your pasta timer is done.", 11_600, 12_200, "o1"), "spoke", "the asked-for words are a turn of their own");
  assert.equal(frame(11_650, LIVE_FRAME), false, "inside the old 250 ms tail: still the room answer's, though it has had 400 ms for 300 ms of words");
  assert.equal(frame(11_860, LIVE_FRAME), true, "past it: the timer line's");
});

test("a late name releases the answer's frames the clause no longer takes", () => {
  const { a, at, say, frame } = gate();
  at(10_000);
  say(" what time is it,", 10_000, 10_400, "t_k");
  at(10_900);
  a.ask({ aside: true, content: CLAUSE });
  at(11_000);
  a.output(" going to sleep.", 11_000, 11_300, "o1");
  for (let k = 0; k < 3; k++) assert.equal(frame(11_300 + 100 * k, LIVE_FRAME), true);
  at(11_550);
  say(" Jar", 10_400, 10_600, "t_k");
  // Live's answer to Kevin's question goes on as a new output item after his words.
  at(11_600);
  assert.equal(a.output(" three", 11_600, 11_800, "o2"), "pending");
  assert.equal(frame(11_700, LIVE_FRAME), false, "the answer's first frame: locked out, held");
  assert.equal(frame(11_800, LIVE_FRAME), false);
  at(11_900);
  const head = say("head", 10_600, 10_800, "t_k2");
  assert.equal(head.verdict, "named");
  assert.equal(head.released.length, 2, "the answer's two held frames go to the speaker after all");
});

test("the stand-in's clock pausing 100-180 ms mid-clause is not sound: the answer to the room still plays nothing", () => {
  // LC-7 dry under load stalled 135 ms between two words of a reply. Live's transcript gaps are whole 200 ms slots.
  for (const pause of [100, 105, 135, 180]) {
    const { a, at, say, frame } = gate();
    at(0);
    a.ask({ aside: true, content: CLAUSE });
    // The CI 1c140d8 clause, with " sleep." `pause` ms after " to" ends (81): 60 ms of words, 60 ms of sound.
    const s = 81 + pause;
    const clause: [number, string | undefined][] = [[39, " Going"], [49, undefined], [61, " to"], [71, undefined], [s, " sleep."], [s + 10, undefined]];
    let played = 0;
    for (const [t, word] of clause) {
      if (frame(t, DRY_FRAME)) played++;
      if (word) a.output(word, t, t + 20, "o1");
    }
    assert.equal(played, 6, `pause ${pause}: the clause is heard to its end`);
    const d = s - 85;
    at(200 + d);
    say(" my sister is visiting next weekend", 120 + d, 280 + d, "t_tv");
    at(310 + d);
    assert.equal(a.output(" yeah,", 310 + d, 330 + d, "o2"), "pending");
    const answer = [529 + d, 540 + d, 552 + d].filter((t) => frame(t, DRY_FRAME)).length;
    assert.equal(answer, 0, `pause ${pause} ms: frames of the answer to the room that played as the clause`);
  }
});

/**
 * Real Live (LC-7): a reply sounds 347-547 ms after its words' `start_ms`, and a word can sound longer than its slot
 * (" night.": 200 ms of words, 500 ms of sound). Here the clause has 400 ms of words and 500 ms of sound; its fifth
 * frame comes after its words' worth. Live's answer to Kevin starts at 11_200, its words land 150 ms later, its sound
 * 400 ms after its start. The name lands 410 ms after that sound's first frame (LC-6 trial 3).
 */
function clauseThenAnswer(nameAfterMs: number) {
  const { a, at, say, frame } = gate();
  at(10_000);
  say(" what time is it,", 10_000, 10_400, "t_k");
  at(10_500);
  a.ask({ aside: true, content: CLAUSE });
  at(10_800);
  a.output(" going to", 10_600, 10_800, "o1");
  at(11_000);
  a.output(" sleep.", 10_800, 11_000, "o1");
  for (const t of [11_000, 11_100, 11_200, 11_300]) assert.equal(frame(t, LIVE_FRAME), true, "the clause");
  at(11_330);
  say(" Jar", 10_400, 10_600, "t_k");
  at(11_350);
  assert.equal(a.output(" it's", 11_200, 11_400, "o2"), "pending");
  frame(11_400, LIVE_FRAME); // the clause's last sound, past its words' worth
  frame(11_500, LIVE_FRAME, false);
  for (const t of [11_600, 11_700, 11_800, 11_900, 12_000]) assert.equal(frame(t, LIVE_FRAME), false, "the answer, held");
  at(11_600 + nameAfterMs);
  return say("head", 10_600, 10_800, "t_k2");
}

test("real Live: a frame the clause's sounded tail hands over does not start the answer's late-name clock; a name 410 ms after the answer's own first frame releases it", () => {
  const head = clauseThenAnswer(410);
  assert.equal(head.verdict, "named");
  assert.equal(head.released.length, 6, "the answer's five held frames, and the handed-over one before them");
});

test("real Live: the late-name clock is still LATE_NAME_MS from the answer's own first audible frame", () => {
  const head = clauseThenAnswer(VoiceAttention.LATE_NAME_MS + 50);
  assert.equal(head.verdict, "named");
  assert.equal(head.released.length, 0);
});

test("real Live: a name that lands after the answer's words and before the hand-over frame grants it, and the handed-over frame plays", () => {
  const { a, at, say, frame } = gate();
  at(10_000);
  say(" what time is it,", 10_000, 10_400, "t_k");
  at(10_500);
  a.ask({ aside: true, content: CLAUSE });
  at(10_800);
  a.output(" going to", 10_600, 10_800, "o1");
  at(11_000);
  a.output(" sleep.", 10_800, 11_000, "o1");
  for (const t of [11_000, 11_100, 11_200, 11_300]) assert.equal(frame(t, LIVE_FRAME), true, "the clause");
  at(11_330);
  say(" Jar", 10_400, 10_600, "t_k");
  at(11_350);
  a.output(" it's", 11_200, 11_400, "o2");
  at(11_370);
  const head = say("head", 10_600, 10_800, "t_k2");
  assert.equal(head.verdict, "named");
  assert.equal(frame(11_400, LIVE_FRAME), true, "the handed-over frame plays: the answer is granted");
  frame(11_500, LIVE_FRAME, false);
  for (const t of [11_600, 11_700, 11_800]) assert.equal(frame(t, LIVE_FRAME), true, "the answer's own sound");
});
