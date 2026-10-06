import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { TranscriptItem } from "@jarhead/protocol";
import { EXCHANGE_MAX_MS, VoiceAttention, type VoiceGrant } from "../voice-attention.ts";

/**
 * The room-talk gate on its own (LC-7): the verdict per utterance, the voice turn and its grant, the late name, the
 * delegation's verdict, the exchange and its cap. One clock, moved by hand; Live's 100 ms output frames where sound
 * matters. A fresh gate starts as a session that opened with no exchange (`reset(false)`), unless a case says so.
 */

const pcm = Buffer.alloc(4800);

function gate(o: { readonly open?: boolean; readonly echoes?: readonly string[] } = {}) {
  const clock = { t: 1_000_000 };
  const state = { inExchange: false, working: false };
  const spoken: { grant: VoiceGrant; clause: boolean }[] = [];
  const a = new VoiceAttention({
    now: () => clock.t,
    echo: (text) => (o.echoes ?? []).some((e) => text.toLowerCase().includes(e)),
    inExchange: () => state.inExchange,
    working: () => state.working,
    spoke: (grant, clause) => spoken.push({ grant, clause }),
  });
  a.reset(o.open ?? false);
  let seq = 0;
  const items = new Map<string, TranscriptItem>();
  /** One fragment of Kevin's side on Live's transcript; a new item unless `id` continues one. */
  const say = (text: string, startMs: number, id = `t_${++seq}`, endMs = startMs + 400) => {
    const prev = items.get(id);
    const item: TranscriptItem = { id, speaker: "kevin", text: prev ? `${prev.text}${text}` : text.trim(), startMs: prev?.startMs ?? startMs, endMs: Math.max(prev?.endMs ?? 0, endMs), at: prev?.at ?? clock.t, final: false };
    items.set(id, item);
    return { ...a.heard(item, text), item };
  };
  /** One output transcript delta of the voice's, on Live's output item `itemId`. */
  const voice = (text: string, startMs: number, itemId: string, endMs = startMs + 200) => a.output(text, startMs, endMs, itemId);
  /** `ms` of Live's output frames; how many were let through. */
  const frames = (ms: number, audible = true, nowMs = 0): number => {
    let played = 0;
    for (let k = 0; k < ms; k += 100) {
      clock.t += 100;
      if (a.frame(pcm, audible, nowMs)) played++;
    }
    return played;
  };
  return { a, clock, state, spoken, say, voice, frames };
}

test("a room line: the voice's reply to it never plays and counts for nothing; a name later is answered", () => {
  const { say, voice, frames, spoken, clock } = gate();
  assert.equal(say(" did you see the game last night", 10_000).verdict, "room");
  assert.equal(voice(" i didn't", 11_000, "o1"), "pending", "undecided until its first audible frame");
  assert.equal(frames(800), 0, "the room's reply is kept off the speaker");
  assert.equal(spoken.length, 0, "and it is not Jarhead's speech");
  clock.t += 3000;
  assert.equal(say(" jarhead what time is it", 15_000).verdict, "named");
  assert.equal(voice(" three.", 16_000, "o2"), "spoke");
  assert.equal(frames(500), 5);
  assert.deepEqual(spoken.map((s) => s.grant), ["named"]);
});

test("the pre-sleep clause is heard and counts for nothing; a TV over it does not cut it; a reply to the TV after it does not play", () => {
  const { a, say, voice, frames, spoken, clock } = gate();
  a.ask(true);
  assert.equal(voice(" going", 11_000, "o1"), "spoke");
  assert.equal(frames(200), 2);
  // The TV, over the line: the voice's next words land on a new output item, mid-sentence — the line going on.
  say(" in other news tonight", 11_300);
  assert.equal(voice(" to", 11_200, "o2"), "spoke");
  assert.equal(voice(" sleep.", 11_400, "o2"), "spoke");
  assert.equal(frames(300), 3, "the line is heard to its end");
  assert.ok(spoken.every((s) => s.clause), "the clause's words are not an addressed turn");
  // A gap, then the voice answers the TV: a turn of its own, nobody asked for it.
  frames(1000, false);
  clock.t += 100;
  say(" and the traffic report", 13_000);
  assert.equal(voice(" traffic's fine.", 13_500, "o3"), "pending");
  assert.equal(frames(300), 0);
});

test("…and a reply to the room straight after the clause's last sentence, inside the turn gap, is split off and dropped", () => {
  const { a, say, voice, frames } = gate();
  a.ask(true);
  assert.equal(voice(" going to sleep.", 11_000, "o1"), "spoke");
  say(" and the traffic report", 11_300);
  assert.equal(voice(" traffic's fine.", 11_800, "o2"), "pending", "the voice had finished a sentence and the room spoke in between");
  assert.equal(frames(200), 0);
});

test("a bare 'jarhead' opens the exchange for 8 s on the timeline; a TV after it is the room's, and its delegation is refused at the deadline", async () => {
  const { a, say, clock } = gate();
  assert.equal(say(" jarhead", 10_000).verdict, "named");
  clock.t += 9000;
  const tv = say(" hit the like button", 19_000);
  assert.equal(tv.verdict, "room");
  const v = a.delegation("item_tv", tv.item);
  assert.ok(v instanceof Promise, "a room-looking delegation waits for a late name");
  clock.t += VoiceAttention.DELEGATION_LATE_MS;
  a.tick();
  assert.equal(await v, "room");
  assert.equal(a.stats.refused, 1);
});

test("room talk inside the window of a bare 'jarhead' belongs to the exchange (it flows ~8 s); past the window it is the room's", () => {
  const { say, voice, frames, clock } = gate();
  say(" jarhead", 10_000);
  clock.t += 3000;
  assert.equal(say(" and in other news tonight", 13_000).verdict, "window");
  assert.equal(voice(" big news.", 14_000, "o1"), "spoke", "a reply inside the exchange");
  assert.equal(frames(300), 3);
  clock.t += 20_000;
  assert.equal(say(" more news at eleven", 35_000).verdict, "room");
  assert.equal(voice(" can't wait.", 36_000, "o2"), "pending");
  assert.equal(frames(300), 0);
});

test("the engine's own append asks for one turn: heard; the ask is spent by it, and one nobody takes lapses", () => {
  const { a, say, voice, frames, clock } = gate();
  say(" the meeting ran long", 10_000);
  a.ask();
  assert.equal(voice(" spotify is playing.", 11_000, "o1"), "spoke");
  assert.equal(frames(400), 4);
  // Jarhead's line opened the exchange for ~8 s; past it, the room again.
  clock.t += 9000;
  say(" anyway", 20_000);
  assert.equal(voice(" right.", 21_000, "o2"), "pending", "the ask was the line's, and is spent");
  assert.equal(frames(200), 0);
  clock.t += 2000;
  a.ask();
  clock.t += VoiceAttention.ASK_GRANT_MS + 1;
  say(" so then she said", 32_000);
  assert.equal(voice(" no way.", 33_000, "o3"), "pending", "an ask nothing answered in 6 s lets no room line through");
  assert.equal(frames(200), 0);
});

test("an ask while the voice has paused a dropped answer to the room starts a turn of its own: the engine's line is heard, and the next answer to the room is not", () => {
  const { a, say, voice, frames, spoken, clock } = gate();
  say(" we need more coffee filters", 10_000);
  assert.equal(voice(" yeah, sounds right.", 11_000, "o1"), "pending");
  assert.equal(frames(300), 0);
  // Half a second later — inside the turn gap — the engine asks for the pre-sleep clause, and the voice says it at once.
  clock.t += 500;
  a.ask(true);
  assert.equal(voice(" going to sleep.", 11_800, "o1"), "spoke", "the clause's words did not join the dropped turn");
  assert.equal(frames(200), 2);
  assert.ok(spoken.every((s) => s.clause));
  clock.t += 900;
  say(" my sister is visiting", 13_000);
  assert.equal(voice(" yeah,", 14_000, "o2"), "pending", "the clause's ask was spent on the clause");
  assert.equal(frames(300), 0);
});

test("…while a reply still streaming when the ask lands goes on as the turn it was", () => {
  const { a, say, voice, frames } = gate();
  say(" we need more coffee filters", 10_000);
  voice(" yeah, sounds", 11_000, "o1");
  frames(200);
  a.ask();
  assert.equal(frames(100), 0, "the tail of the answer to the room stays out");
  assert.equal(voice(" right.", 11_300, "o1"), "dropped");
});

test("in the exchange window without the name: addressed, and its delegation is addressed at once", () => {
  const { a, say, state } = gate();
  state.inExchange = true;
  const heard = say(" and scroll down a bit", 10_000);
  assert.equal(heard.verdict, "window");
  assert.equal(a.delegation("item_ex", heard.item), "window");
});

test("the name split around the voice's reply (the Transcript splits the item): one utterance, the waiting delegation is addressed, the reply plays from its first audible frame", async () => {
  const { a, say, voice, frames, clock } = gate();
  say(" what's on my screen,", 10_000, "t_a", 10_400);
  const jar = say(" Jar", 10_500, "t_a", 10_600);
  assert.equal(jar.verdict, "room");
  const v = a.delegation("item_late", jar.item);
  assert.ok(v instanceof Promise);
  clock.t += 10;
  assert.equal(voice(" looking.", 10_700, "o1"), "pending");
  assert.equal(frames(300, false), 3, "silence before the sound: harmless, played");
  // 'head' lands on an item of its own (the voice's words came in between), 410 ms after the reply began.
  const head = say("head", 10_700, "t_b", 10_900);
  assert.equal(head.verdict, "named");
  assert.equal(head.named, true, "the utterance's one named turn");
  assert.equal(head.released.length, 0, "nothing audible was held yet: nothing to release");
  assert.equal(await v, "named");
  assert.equal(frames(300), 3, "its sound plays from the first frame");
});

test("…a late name after the reply's sound was locked out releases it, from its first audible frame", () => {
  const { a, say, voice, frames } = gate();
  say(" scroll down a bit, Jar", 10_000, "t_a");
  assert.equal(voice(" on it.", 10_600, "o1"), "pending");
  frames(200, false);
  assert.equal(frames(200, true), 0, "locked out at its first audible frame");
  const head = say("head", 10_600, "t_b");
  assert.equal(head.released.length, 2, "the two audible frames held since it began");
  assert.equal(a.stats.releasedFrames, 2);
  assert.equal(frames(100), 1, "and the rest of it plays");
});

test("…but not one that began sounding longer ago than LATE_NAME_MS, nor a reply to some other utterance", () => {
  const { say, voice, frames, clock } = gate();
  say(" scroll down a bit, Jar", 10_000, "t_a");
  voice(" on it.", 10_600, "o1");
  frames(100, true);
  frames(700, false);
  assert.equal(say("head", 10_600, "t_b").released.length, 0, "too late: the reply stays out");
  clock.t += 5000;
  say(" did you see the game", 20_000, "t_c");
  voice(" no.", 21_000, "o2");
  frames(100, true);
  clock.t += 2000;
  assert.equal(say(" jarhead what time is it", 24_000, "t_d").released.length, 0, "a named question is not the room line's reply");
});

test("the ear's name upgrades the utterance Live is still transcribing (sharing its words), never an older room line", () => {
  const { a, say, clock } = gate();
  const old = say(" the game went to overtime", 10_000);
  clock.t += 5000;
  assert.equal(a.ear("jarhead", 1, false), undefined, "a room line 5 s old stays the room's");
  assert.equal(a.verdictOf(old.item), "room");
  clock.t += 10_000;
  const open = say(" scroll down a bit", 30_000);
  assert.equal(open.verdict, "room");
  clock.t += 300;
  assert.equal(a.ear("scroll down a bit jarhead", 2, false)?.named, true);
  assert.equal(a.verdictOf(open.item), "named");
  assert.equal(a.ear("scroll down a bit jarhead", 2, false), undefined, "a partial that repeats the segment's name is not a new name");
  clock.t += 10_000;
  const tv = say(" did you see the game", 45_000);
  clock.t += 300;
  assert.equal(a.ear("jarhead open safari", 3, false), undefined, "the ear's words are not Live's open utterance");
  assert.equal(a.verdictOf(tv.item), "room");
  assert.equal(say(" open safari", 46_000).verdict, "named", "the next Live utterance within EAR_NAME_MS is the named one");
});

test("a delegation before any words waits for them: named words make it addressed, room words refuse it at the deadline", async () => {
  const { a, say, clock } = gate();
  const early = a.delegation("item_early", undefined);
  assert.ok(early instanceof Promise);
  say(" jarhead open safari", 10_000);
  assert.equal(await early, "named");
  clock.t += 20_000;
  const early2 = a.delegation("item_early2", undefined);
  assert.ok(early2 instanceof Promise);
  say(" press enter", 30_000);
  clock.t += VoiceAttention.DELEGATION_LATE_MS;
  a.tick();
  assert.equal(await early2, "room");
});

test("a typed line is addressed whatever the room said; Jarhead's own words back through the mic never name it", () => {
  const { a, say, clock } = gate({ echoes: ["say jarhead to wake me"] });
  say(" the meeting ran long", 10_000);
  const typed: TranscriptItem = { id: "t_typed", speaker: "kevin", text: "what time is it", startMs: 11_000, endMs: 11_000, at: clock.t, final: true, source: "typed" };
  a.typed(typed);
  assert.equal(a.delegation("item_typed", typed), "typed");
  clock.t += 60_000;
  assert.equal(say(" say jarhead to wake me", 80_000).verdict, "room");
});

test("the exchange's cap: a room the voice keeps answering inside the window stops being the exchange's EXCHANGE_MAX_MS after the name", () => {
  const { say, voice, frames, clock } = gate();
  const t0 = clock.t;
  say(" jarhead what's the weather", 1000);
  voice(" cold.", 2000, "o0");
  frames(300);
  let roomAt: number | undefined;
  for (let k = 1; k <= 40 && roomAt === undefined; k++) {
    clock.t += 4700;
    const s = 2000 + k * 5000;
    if (say(` and in other news, story ${k}`, s - 1500, `tv_${k}`, s - 500).verdict === "room") roomAt = clock.t - t0;
    else voice(` big story ${k}.`, s, `o${k}`);
  }
  assert.ok(roomAt !== undefined && roomAt >= EXCHANGE_MAX_MS && roomAt <= EXCHANGE_MAX_MS + 6000, `the room was the exchange's until ${roomAt} ms`);
});

test("a line the engine asked for (a brain's question 3 min into the work) re-opens the exchange past the cap: Kevin's unnamed answer is the exchange's", () => {
  const { a, say, voice, frames, state, clock } = gate();
  say(" jarhead send ben the deck", 10_000);
  state.working = true;
  clock.t += 3 * 60_000;
  a.ask();
  assert.equal(voice(" send it to ben?", 190_000, "o1", 191_000), "spoke");
  frames(300);
  clock.t += 2000;
  assert.equal(say(" yes", 193_000).verdict, "window");
});

test("work Kevin asked for: the voice's own words while it runs are heard — until the room speaks; then an answer to the room is not", () => {
  const { say, voice, frames, state, clock } = gate();
  say(" jarhead find the invoice", 10_000);
  state.working = true;
  clock.t += 20_000;
  assert.equal(voice(" still on it.", 30_000, "o1"), "spoke", "work Kevin asked for");
  frames(300);
  clock.t += 10_000;
  assert.equal(say(" hit the like button", 45_000).verdict, "room");
  assert.equal(voice(" liked.", 46_000, "o2"), "pending", "a TV answered mid-task is not the work's");
  assert.equal(frames(200), 0);
});

test("the exchange on the session timeline: Kevin's answer whose transcript lands past the wall-clock window is still inside it", () => {
  const { a, say, voice, clock } = gate();
  a.anchor(); // the Go
  a.ask();
  voice(" anything else?", 1000, "o1", 1500);
  clock.t += 8200;
  assert.equal(say(" and on friday", 8000).verdict, "window", "began 6.5 s after Jarhead's words; arrived 8.2 s after");
});

test("a new session carries the exchange only when it was open (a reconnect mid-exchange); a cold one starts closed", () => {
  const open = gate({ open: true });
  open.a.anchor();
  assert.equal(open.say(" scroll down", 500).verdict, "window");
  const cold = gate({ open: false });
  assert.equal(cold.say(" scroll down", 500).verdict, "room");
});

test("the gate's own cost per frame and per delta is microseconds", () => {
  const { a, clock } = gate();
  const n = 200_000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    clock.t += 100;
    a.frame(pcm, i % 3 === 0, i * 100);
    if (i % 10 === 0) a.output(" x", i * 100, i * 100 + 200, `o${i >> 6}`);
  }
  const perFrameUs = ((performance.now() - t0) * 1000) / n;
  console.log(`[measure] gate: ${perFrameUs.toFixed(3)} µs per frame (with an output delta every 10th)`);
  assert.ok(perFrameUs < 20, `${perFrameUs} µs per frame`);
});
