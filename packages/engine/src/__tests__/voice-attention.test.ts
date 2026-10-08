import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { TranscriptItem } from "@jarhead/protocol";
import { ANSWER_WINDOW_MS, EXCHANGE_MAX_MS, EXCHANGE_WINDOW_MS, VoiceAttention, type VoiceGrant } from "../voice-attention.ts";

/**
 * The room-talk gate on its own (LC-7): the verdict per utterance, the voice turn and its grant, the late name, the
 * delegation's verdict, the exchange and its cap. One clock, moved by hand; Live's 100 ms output frames where sound
 * matters. A fresh gate starts as a session that opened with no exchange (`reset(false)`), unless a case says so.
 */

const pcm = Buffer.alloc(4800);

function gate(o: { readonly open?: boolean; readonly echoes?: readonly string[]; readonly acks?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const state: { inExchange: boolean; working: boolean | string; confirming: string | undefined } = { inExchange: false, working: false, confirming: undefined };
  const spoken: { grant: VoiceGrant; clause: boolean }[] = [];
  const decided: string[] = [];
  const a = new VoiceAttention({
    now: () => clock.t,
    echo: (text) => (o.echoes ?? []).some((e) => text.toLowerCase().includes(e)),
    inExchange: () => state.inExchange,
    working: () => (state.working === false ? undefined : state.working === true ? "item_work" : state.working),
    confirming: () => state.confirming,
    spoke: (grant, clause) => spoken.push({ grant, clause }),
    decided: (ids) => decided.push(...ids),
  });
  a.reset(o.open ?? false, { acks: o.acks === true });
  let seq = 0;
  const items = new Map<string, TranscriptItem>();
  /** One fragment of Kevin's side on Live's transcript; a new item unless `id` continues one. */
  const say = (text: string, startMs: number, id = `t_${++seq}`, endMs = startMs + 400) => {
    const prev = items.get(id);
    const item: TranscriptItem = { id, speaker: "kevin", text: prev ? `${prev.text}${text}` : text.trim(), startMs: prev?.startMs ?? startMs, endMs: Math.max(prev?.endMs ?? 0, endMs), at: prev?.at ?? clock.t, final: false };
    items.set(id, item);
    return { ...a.heard(item, text, startMs), item };
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
  return { a, clock, state, spoken, decided, say, voice, frames };
}

test("a room line: the voice's reply to it never plays and counts for nothing; a name later is answered", () => {
  const { say, voice, frames, spoken, clock } = gate();
  assert.equal(say(" did you see the game last night", 10_000).verdict, "room");
  assert.equal(voice(" i didn't", 11_000, "o1"), "pending", "undecided until its first audible frame");
  assert.equal(frames(800), 0, "the room's reply is kept off the speaker");
  assert.equal(spoken.length, 0, "and it is not Jarhead's speech");
  clock.t += 3000;
  assert.equal(say(" jarhead what time is it", 15_000).verdict, "named");
  assert.equal(voice(" three.", 16_000, "o2"), "spoke", "inside the exchange the name opened: decided at its words");
  assert.equal(frames(500), 5);
  assert.deepEqual(spoken.map((s) => s.grant), ["named"]);
});

test("the pre-sleep clause is heard and counts for nothing; a TV over it does not cut it; a reply to the TV after it does not play", () => {
  const { a, say, voice, frames, spoken, clock } = gate();
  a.ask({ aside: true });
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
  a.ask({ aside: true });
  assert.equal(voice(" going to sleep.", 11_000, "o1"), "spoke");
  say(" and the traffic report", 11_300);
  assert.equal(voice(" traffic's fine.", 11_800, "o2"), "pending", "the voice had finished a sentence and the room spoke in between");
  // Its sound, past the clause's own still streaming (SPLIT_SOUND_LAG_MS behind its words' start on the timeline).
  assert.equal(frames(200, true, 11_800 + VoiceAttention.SPLIT_SOUND_LAG_MS), 0);
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

test("a room-looking delegation still waiting for a late name when the session closes is the room's at the close, not at the deadline (its backup timer is unref'd)", async () => {
  const { a, say, clock } = gate();
  clock.t += 30_000;
  const tv = say(" hit the like button", 30_000);
  const v = a.delegation("item_tv", tv.item);
  assert.ok(v instanceof Promise, "a room-looking delegation waits for a late name");
  let settled: string | undefined;
  void v.then((x) => (settled = x));
  clock.t += 400;
  a.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, "room", "the wait outlived the close");
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
  a.ask({ aside: true });
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
  // The engine's wall-clock exchange holds only with its cap open (Engine.inExchange): an anchor, as a name gives.
  a.anchor();
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
    clock.t += 4400;
    const s = 2000 + k * 5000;
    if (say(` and in other news, story ${k}`, s - 1500, `tv_${k}`, s - 500).verdict === "room") roomAt = clock.t - t0;
    else {
      voice(` big story ${k}.`, s, `o${k}`);
      frames(300);
    }
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
  voice(" still on it.", 30_000, "o1");
  assert.equal(frames(300), 3, "work Kevin asked for");
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

// ---- the review of 7263f2a (ADV-1 … ADV-9b): the gate's own rules ------------------------------------------------------

test("ADV-2: the result of work the window admitted asks as `window` — heard, the exchange goes on from it, but it anchors no cap and counts only on the idle clock", () => {
  const { a, say, voice, frames, spoken, clock } = gate();
  say(" jarhead what's the weather", 1000);
  voice(" cold.", 2000, "o0");
  frames(300);
  // A TV line inside the window; Live delegates it: `window`.
  clock.t += 3000;
  const tv = say(" tell me more about story one", 5000);
  assert.equal(tv.verdict, "window");
  assert.equal(a.delegation("item_tv", tv.item), "window");
  // Its result comes back as commentary on that delegation: the voice's turn for it is heard, granted as `window`.
  a.ask({ delegationId: "item_tv", content: "Story one is about the weather." });
  assert.equal(voice(" story one is about the weather.", 6500, "o1"), "spoke");
  assert.equal(frames(300), 3);
  assert.equal(spoken[spoken.length - 1]!.grant, "window", "not `asked`: the engine's ceiling and the cap ignore it");
  // The cap still counts from the name: 120 s on, nothing is the exchange's, however many window results were spoken.
  clock.t += EXCHANGE_MAX_MS;
  assert.equal(a.capOpen(), false);
  // Work Kevin named asks as `asked`, and anchors.
  const named = say(" jarhead draft the reply", 200_000);
  assert.equal(a.delegation("item_named", named.item), "named");
  clock.t += 1000;
  a.ask({ delegationId: "item_named", content: "Drafted." });
  voice(" drafted.", 202_000, "o2");
  assert.equal(spoken[spoken.length - 1]!.grant, "asked");
});

test("ADV-7, ADV-8: a `window` utterance that talks on past the exchange lapses to the room (a name can still upgrade it); its delegation then waits for a name and is refused", async () => {
  const { a, say, clock } = gate();
  say(" jarhead play the next video", 1000, "t_k", 1900);
  clock.t += 3000;
  // The video starts talking inside the window, without a gap.
  let v = say(" so the host", 4000, "t_v", 4200);
  assert.equal(v.verdict, "window");
  for (let s = 4300; s < 12_000; s += 300) v = say(" keeps talking", s, "t_v", s + 200);
  assert.equal(v.verdict, "window", "8 s of its own: still the exchange's");
  v = say(" press enter.", 12_100, "t_v", 12_400);
  assert.equal(v.verdict, "room", "past the exchange (and 8 s of its own): the room's");
  const d = a.delegation("item_video", v.item);
  assert.ok(d instanceof Promise);
  clock.t += VoiceAttention.DELEGATION_LATE_MS;
  a.tick();
  assert.equal(await d, "room");
  // A name later in the same utterance still upgrades it.
  assert.equal(say(" jarhead stop the video", 12_500, "t_v", 13_000).verdict, "named");
});

test("ADV-7: a delegation on a `window` utterance once the cap has closed is the room's, as a reply to it is", async () => {
  const { a, say, clock } = gate();
  say(" jarhead", 1000);
  clock.t += 2000;
  const w = say(" and scroll down", 3000);
  assert.equal(w.verdict, "window");
  clock.t += EXCHANGE_MAX_MS;
  const d = a.delegation("item_late", w.item);
  assert.ok(d instanceof Promise, "past the cap a window utterance is not addressed");
  clock.t += VoiceAttention.DELEGATION_LATE_MS;
  a.tick();
  assert.equal(await d, "room");
});

test("ADV-8: an item Live split around the voice's words carries only the name across the split, never the window", () => {
  const { a, say, voice, state, clock } = gate();
  // Inside the exchange on the wall clock (an addressed turn a moment ago): the TV's words are the window's.
  a.anchor();
  state.inExchange = true;
  assert.equal(say(" and the anchors keep", 30_000, "t_a", 30_800).verdict, "window");
  state.inExchange = false;
  // The voice's aside to it, outside the exchange on the timeline: undecided, and Live splits the TV's speech around it.
  assert.equal(voice(" mm.", 30_900, "o1"), "pending");
  clock.t += 500;
  assert.equal(say(" talking about the game", 31_200, "t_b", 31_800).verdict, "room", "the rest of the same speech is judged on its own");
  assert.equal(a.verdictOf({ id: "t_a" }), "window");
});

test("ADV-9: the ear names Live's open utterance only when it is the same speech — begun after the ear's segment opened, sharing words that say something — and the name, spent on it, names no next utterance", () => {
  const { a, say, clock } = gate();
  // The TV's line, on Live's transcript, before Kevin begins.
  const tv = say(" now press enter on the keyboard.", 10_000);
  clock.t += 1400;
  // Kevin's speech: the ear's segment opens 1.4 s after Live began sending the TV's line, and shares 'the' with it.
  a.ear("what's", 7, false);
  clock.t += 600;
  assert.equal(a.ear("what's the time jarhead", 7, false), undefined, "the TV's line is not Kevin's speech");
  assert.equal(a.verdictOf(tv.item), "room");
  // Live's transcript of Kevin's words, 0.5 s on: the next utterance, named by the ear.
  clock.t += 500;
  assert.equal(say(" what's the time,", 11_200).verdict, "named");
  // Spent: an utterance 1.5 s later is not named by it (inside the exchange Kevin's name opened, it is the window's).
  clock.t += 1500;
  assert.equal(say(" hit the like button", 13_000).verdict, "window");
  // Same speech, the name last: Live's open item (begun after the segment) upgraded, and the name spent on it.
  clock.t += 20_000;
  a.ear("draft", 8, false);
  clock.t += 800;
  const k = say(" draft a reply to sam,", 40_000);
  assert.equal(k.verdict, "room");
  clock.t += 200;
  assert.equal(a.ear("draft a reply to sam jarhead", 8, false)?.named, true);
  assert.equal(a.verdictOf(k.item), "named");
  clock.t += 1500;
  assert.equal(say(" press enter", 44_000).verdict, "window", "the name was spent on Kevin's own utterance: not named again");
});

test("ADV-1: an ask that lands while an answer to the room streams starts a turn of its own at the words it asked for, and the room answer's sound still on its way stays out", () => {
  const { a, say, voice, frames, clock } = gate();
  say(" did you see the game last night?", 10_000);
  assert.equal(voice(" no, what happened in it", 11_200, "o1", 12_800), "pending");
  assert.equal(frames(700, true, 11_500), 0);
  a.ask({ content: "Your pasta timer is done. Say so once." });
  assert.equal(frames(200, true, 12_100), 0, "the answer to the room streams on");
  void clock;
  assert.equal(voice(" your pasta timer is done.", 12_900, "o1", 13_700), "spoke", "the asked-for words are a turn of their own");
  assert.equal(frames(200, true, 12_950), 0, "the room answer's sound still on its way");
  assert.equal(frames(300, true, 12_900 + VoiceAttention.SPLIT_SOUND_LAG_MS), 3, "the timer line's sound");
});

test("ADV-1: …or at its first sentence end once the server has the ask; mid-sentence, before the ack, the reply goes on as it was", () => {
  const { a, say, voice, frames, clock } = gate({ acks: true });
  say(" we need more coffee filters", 10_000);
  voice(" yeah, they", 11_000, "o1");
  frames(200, true, 11_200);
  a.ask({ eventId: "steer_1", content: "Spotify: playing Focus." });
  assert.equal(voice(" ran out.", 11_300, "o1"), "dropped", "mid-sentence: still the room answer");
  assert.equal(voice(" so did we.", 11_500, "o1"), "dropped", "a sentence end, but the server has not taken the ask in");
  clock.t += 300;
  a.acked("steer_1");
  assert.equal(voice(" spotify is playing focus.", 11_800, "o1"), "spoke", "the first sentence end after the ack");
});

test("ADV-9b: in a session that acknowledges appends, a new voice turn before the ask's ack does not take it (a reply to the room already on its way); the turn after the ack does; one never acked is takeable after ASK_UNACKED_MS", () => {
  const { a, say, voice, frames, clock } = gate({ acks: true });
  say(" now press enter on the keyboard.", 10_000);
  clock.t += 2000;
  a.ask({ eventId: "steer_1", content: "Say this: it's 3:27." });
  clock.t += 200;
  assert.equal(voice(" on it.", 12_000, "o1"), "pending", "before the ack: not the ask's answer");
  assert.equal(frames(300, true, 12_300), 0, "and it answers the room");
  clock.t += 400;
  a.acked("steer_1");
  clock.t += 600;
  assert.equal(voice(" it's three twenty-seven.", 13_500, "o2"), "spoke");
  // An ask whose ack never comes: takeable ASK_UNACKED_MS after it left.
  clock.t += 10_000;
  a.ask({ eventId: "steer_2", content: "Your timer is done." });
  clock.t += VoiceAttention.ASK_UNACKED_MS;
  assert.equal(voice(" your timer is done.", 25_000, "o3"), "spoke");
});

test("a granted turn that runs on past the ask's ack answers the ask: no later answer to the room takes it", () => {
  const { a, say, voice, frames, clock } = gate({ acks: true });
  say(" jarhead what's on my screen", 10_000);
  assert.equal(voice(" looking.", 11_000, "o1"), "spoke");
  a.ask({ eventId: "say_1", content: "Notes is in front." });
  clock.t += 500;
  a.acked("say_1");
  clock.t += 100;
  assert.equal(voice(" notes is in front.", 11_600, "o1"), "spoke");
  frames(300, true, 12_000);
  // 3 s on, the TV; the voice answers it: the ask was spent, so nothing grants it.
  clock.t += 3000;
  say(" in other news tonight", 25_000);
  assert.equal(voice(" big news.", 26_000, "o2"), "pending");
  assert.equal(frames(300, true, 26_300), 0);
});

test("ADV-5: a turn outside the exchange is decided at its first audible frame, on Kevin's last utterance begun before it on the timeline — a room line whose transcript lands after the voice's words is what it answers", () => {
  const { say, voice, frames, state, clock } = gate();
  say(" jarhead draft a long reply to sam", 10_000);
  state.working = true;
  clock.t += 40_000;
  assert.equal(voice(" yes?", 50_900, "o1"), "pending", "outside the exchange: undecided at its words");
  say(" Yes!", 49_700);
  assert.equal(frames(300, true, 51_200), 0, "it answers the TV's 'Yes!', not Kevin's task");
});

test("ADV-4: Jarhead's own question opens the answer window: Kevin's first utterance after it within ANSWER_WINDOW_MS is the exchange's, unnamed; the second is not, nor one while a confirmation waits", () => {
  const { a, say, voice, frames, state, clock } = gate();
  a.anchor();
  a.ask({ content: "Ask Kevin: which file, the first or the second?" });
  voice(" which file, the first or the second?", 1600, "o1", 2600);
  frames(300, true, 2000);
  clock.t += 9000;
  assert.equal(say(" the second one.", 11_600).verdict, "window", "9 s after the question: an answer to it");
  clock.t += 10_000;
  assert.equal(say(" and open it.", 21_600).verdict, "room", "the window is one utterance");
  // A question asked while a confirmation waits: its yes needs the name past the exchange.
  clock.t += 20_000;
  state.confirming = "confirm_1";
  a.ask({ content: "Ask Kevin: send it to Ben?" });
  voice(" send it to ben?", 41_600, "o2", 42_400);
  frames(300, true, 42_000);
  clock.t += 10_000;
  assert.equal(say(" yes.", 52_400).verdict, "room");
  // Past ANSWER_WINDOW_MS: the room's.
  state.confirming = undefined;
  clock.t += 10_000;
  a.ask({ content: "Ask Kevin: keep the draft?" });
  voice(" keep the draft?", 70_000, "o3", 70_700);
  frames(300, true, 70_400);
  clock.t += ANSWER_WINDOW_MS + 5000;
  assert.equal(say(" yeah keep it.", 70_700 + ANSWER_WINDOW_MS + 5000).verdict, "room");
});

test("the cue owed when an unnamed answer is refused: once per waiting confirmation, once per unanswered question under ANSWER_CUE_MS old, never for room talk with nothing asked", () => {
  const { a, voice, frames, state, clock, say } = gate();
  assert.equal(a.cue(), undefined, "nothing asked: silent");
  state.confirming = "confirm_1";
  assert.equal(a.cue(), "confirm");
  assert.equal(a.cue(), undefined, "once per confirmation");
  state.confirming = "confirm_2";
  assert.equal(a.cue(), "confirm");
  state.confirming = undefined;
  a.anchor();
  a.ask({ content: "Ask Kevin: keep the draft?" });
  voice(" keep the draft?", 1000, "o1", 1700);
  frames(300, true, 1400);
  assert.equal(a.cue(), "answer");
  assert.equal(a.cue(), undefined, "once per question");
  a.ask({ content: "Ask Kevin: which one?" });
  voice(" which one?", 3000, "o2", 3500);
  frames(300, true, 3400);
  clock.t += 2000;
  say(" jarhead the first", 5000);
  assert.equal(a.cue(), undefined, "answered by name");
  a.ask({ content: "Ask Kevin: anything else?" });
  voice(" anything else?", 9000, "o3", 9500);
  frames(300, true, 9400);
  clock.t += VoiceAttention.ANSWER_CUE_MS + 1;
  assert.equal(a.cue(), undefined, "too old");
});

test("finding 7: Jarhead's Transcript items say whether Kevin heard them — pending until the turn is decided, unheard when it was dropped, heard when any turn that said it was granted, and heard after all when a late name releases it", () => {
  const { a, say, voice, frames, decided, clock } = gate();
  say(" did you see the game", 10_000);
  voice(" no.", 11_000, "o1");
  assert.equal(a.saidState("o1"), "pending");
  frames(200);
  assert.equal(a.saidState("o1"), "unheard");
  assert.ok(decided.includes("o1"));
  a.ask();
  voice(" spotify is playing.", 14_000, "o2");
  assert.equal(a.saidState("o2"), "heard");
  assert.equal(a.saidState("nope"), undefined);
  // The late name, past the exchange the asked line opened: "scroll down a bit, Jar" … reply … "head".
  clock.t += 30_000;
  say(" scroll down a bit, Jar", 50_000, "t_a");
  voice(" on it.", 50_600, "o3");
  frames(200, true);
  assert.equal(a.saidState("o3"), "unheard");
  say("head", 50_600, "t_b");
  assert.equal(a.saidState("o3"), "heard");
});

test("EXCHANGE_WINDOW_MS and the window's lapse share one clock: an utterance begun in the window keeps it for EXCHANGE_WINDOW_MS from the later of the exchange's end and its own start", () => {
  const g = gate({ open: true });
  g.a.anchor();
  assert.equal(g.say(" first", 7000, "t_x", 7200).verdict, "window");
  assert.equal(g.say(" more", 7000 + EXCHANGE_WINDOW_MS - 1, "t_x", 7000 + EXCHANGE_WINDOW_MS).verdict, "window");
  assert.equal(g.say(" more", 7000 + EXCHANGE_WINDOW_MS, "t_x", 7000 + EXCHANGE_WINDOW_MS + 200).verdict, "room");
});

test("an aside is one clause: once 'going to sleep.' has ended, the voice's next words are a turn of their own, even when they begin inside the turn gap while the TV that spoke into it is still talking", () => {
  const { a, say, voice, frames, clock } = gate();
  a.ask({ aside: true, content: "Nothing has been said for a while: you are going to sleep in about 5 seconds." });
  assert.equal(voice(" going to sleep.", 11_000, "o1", 11_500), "spoke");
  assert.equal(frames(300, true, 11_300), 3);
  // The TV starts over the end of the clause and talks on; the voice answers it 400 ms after the clause's sound.
  say(" my sister is visiting next weekend", 11_400, "t_tv", 12_600);
  clock.t += 400;
  assert.equal(voice(" yeah, sounds right.", 12_000, "o2", 12_400), "pending", "not the clause's");
  assert.equal(frames(300, true, 12_000 + VoiceAttention.SPLIT_SOUND_LAG_MS), 0, "the answer to the TV played as the clause");
});
