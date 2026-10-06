import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { LiveSession, type SessionConfig, type WebSocketLike } from "@jarhead/live";
import type { LedgerRow } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { rows, settle, until, world, type World } from "./world.ts";

/**
 * The room-talk gate (LC-7, 2026-10-06: lc-7-room-talk-034251-542 after F4, 5/10; 002009-399 before it, 4/10).
 *
 * GPT-Live-1 answers what it hears on its own. The protocol has no turn-detection setting, no `create_response`
 * switch and no cancel (packages/live/src/events.ts), and its `response.create` continues the Responses backend, not
 * the voice. F4's orders asked it to stay silent for the room; it answered the room anyway ("on it. done. night. on
 * it. done. i didn't catch it. what happened?"), delegated two room commands ("Say hello in five words. scroll down a
 * bit" reached the brain), and every answer re-armed the idle clock, so the session never slept. So the engine is
 * where the ask lives: a voice turn is heard, run or counted only when the engine asked for it — a typed line, words
 * that name Jarhead, words that begin inside the exchange, an append of the engine's own. Everything else the server
 * says stays on the record and is dropped: off the speaker, off the brain, off the hands, off the idle clock.
 *
 * Replayed on a real LiveSession over a fake socket, on the engine's clock, with LC-7's frames at their recorded
 * session times: the output transcript and its audible frames, Live's input transcript of the room, its delegations,
 * the usage beats, and the ear fed as the app's recogniser would. The server answers the engine's own appends as
 * GPT-Live-1 does (LC-5 medians: first transcript +1586 ms, first audible frame +1888 ms).
 */

type SleepRow = Extract<LedgerRow, { type: "sleep" }>;
type HeardRow = Extract<LedgerRow, { type: "heard" }>;
type CreatedRow = Extract<LedgerRow, { type: "delegation.created" }>;
type FinishedRow = Extract<LedgerRow, { type: "delegation.finished" }>;

const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: { at: number; line: string }[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;
  constructor(private readonly clock: () => number) {}
  send(data: string): void {
    this.sent.push({ at: this.clock(), line: data });
    // The server answers a graceful close at once, as GPT-Live-1 did in LC-4 (630 ms) — here in the same turn.
    if ((JSON.parse(data) as { type: string }).type === "session.close") {
      queueMicrotask(() => {
        this.receive({ type: "session.closed", event_id: "c", reason: "close_requested", session: resource("live_1"), usage: { seconds: 60 } });
        this.close();
      });
    }
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = true;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(obj: unknown): void {
    if (this.readyState === 3) return;
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** The client events sent, with the engine clock they left at. */
  events(): { at: number; type: string; content?: string; delegationId?: string | null }[] {
    return this.sent.map((s) => {
      const e = JSON.parse(s.line) as { type: string; content?: string; delegation_id?: string | null };
      return { at: s.at, type: e.type, ...(e.content !== undefined ? { content: e.content } : {}), ...(e.delegation_id !== undefined ? { delegationId: e.delegation_id } : {}) };
    });
  }
}

const resource = (id: string) => ({ id, expires_at: Math.floor(Date.now() / 1000) + 3600, model: "gpt-live-1", status: "active" as const });
/** 100 ms of PCM16 at 24 kHz: silence, or a level `rms()` reads as ~0.09 (Live's audible frames read 0.013–0.039). */
const SILENT = Buffer.alloc(4800).toString("base64");
const VOICED = (() => {
  const b = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) b.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);
  return b.toString("base64");
})();
const level = (pcm: Buffer): number => {
  let sum = 0;
  for (let i = 0; i < pcm.length >> 1; i++) sum += (pcm.readInt16LE(i * 2) / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / Math.max(1, pcm.length >> 1)) * 3);
};

/** GPT-Live-1 answers an append: first transcript +1586 ms, first audible frame +1888 ms (LC-5 medians, n=10). */
const APPEND_TRANSCRIPT_MS = 1586;
const APPEND_AUDIBLE_MS = 1888;

/** A scripted session: events at session ms, frames every 100 ms (audible inside `voiced` runs), a tick each second. */
interface Script {
  /** [from, to] session ms of audible output frames (frame times, inclusive). */
  readonly voiced: readonly (readonly [number, number])[];
  /** How far off the 100 ms frame grid a run may start or end: LC-7's recorded runs are off it (50), a scripted run is on it (0). */
  readonly slop?: number;
  readonly at: readonly { readonly t: number; readonly run: () => void | Promise<void> }[];
  /** The server answers the pre-sleep clause's append with " going to sleep." (transcript, then sound). */
  readonly answerClause?: boolean;
}

interface Rig {
  readonly w: World;
  readonly sock: () => FakeSocket;
  /** Engine clock of a session ms. */
  readonly wall: (s: number) => number;
  /** Every frame the speaker got, with the session ms it went out at and whether it was audible. */
  readonly played: { s: number; audible: boolean }[];
  /** Session ms the pre-sleep clause's append left at, once it did. */
  clauseS: number | undefined;
  run(script: Script, untilS: number): Promise<void>;
  input(delta: string, startMs: number, endMs: number): void;
  output(delta: string, startMs: number, endMs: number): void;
  delegation(id: string, offsetMs: number): void;
}

async function rig(idleMinutes: number): Promise<Rig> {
  const socks: FakeSocket[] = [];
  let t0 = 0;
  const w = world({
    makeLive: (config: SessionConfig): LiveSession => {
      const sock = new FakeSocket(() => w.clock.t);
      socks.push(sock);
      const live = new LiveSession({ apiKey: "k", config, webSocketFactory: () => sock });
      // The session timeline on the engine's clock (LiveSession reads Date.now), so typed lines and Live's own stamps agree.
      Object.defineProperty(live, "nowMs", { get: () => (t0 === 0 ? 0 : w.clock.t - t0) });
      return live;
    },
  });
  const { engine, clock } = w;
  await engine.start();
  await engine.ready();
  engine.updateSettings({ idleSleepMinutes: idleMinutes });
  const waking = engine.wake("test");
  await until(() => socks.length === 1);
  socks[0]!.open();
  t0 = clock.t;
  socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
  await waking;
  const played: { s: number; audible: boolean }[] = [];
  engine.on("audio", (pcm: Buffer) => played.push({ s: clock.t - t0, audible: level(pcm) >= Engine.AUDIBLE_OUTPUT_LEVEL }));
  const sock = (): FakeSocket => socks[socks.length - 1]!;
  let seq = 0;
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
  const r: Rig = {
    w,
    sock,
    wall: (s) => t0 + s,
    played,
    clauseS: undefined,
    async run(script, untilS) {
      type Ev = { t: number; k: number; run: () => void | Promise<void> };
      const voiced: (readonly [number, number])[] = [...script.voiced];
      const slop = script.slop ?? 0;
      const evs: Ev[] = [];
      const from = clock.t - t0;
      for (let t = Math.ceil(from / 100) * 100 + 48; t <= untilS; t += 100) {
        evs.push({ t, k: 1, run: () => sock().receive({ type: "session.output_audio.delta", delta: voiced.some(([a, b]) => t >= a - slop && t <= b + slop) ? VOICED : SILENT }) });
      }
      for (let t = Math.ceil(from / 1000) * 1000; t <= untilS; t += 1000) evs.push({ t, k: 2, run: () => tick(engine) });
      for (const e of script.at) if (e.t >= from && e.t <= untilS) evs.push({ t: e.t, k: 0, run: e.run });
      evs.sort((a, b) => a.t - b.t || a.k - b.k);
      let seen = sock().sent.length;
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i]!;
        clock.t = t0 + e.t;
        await e.run();
        if (e.k !== 1) await flush();
        // The server answers the engine's own pre-sleep clause, as GPT-Live-1 answers any append.
        if (script.answerClause && sock().sent.length > seen) {
          for (const sent of sock().events().slice(seen)) {
            if (sent.type !== "session.instructions.append" || !/going to sleep in about/.test(sent.content ?? "") || r.clauseS !== undefined) continue;
            const c = sent.at - t0;
            r.clauseS = c;
            voiced.push([c + APPEND_AUDIBLE_MS, c + APPEND_AUDIBLE_MS + 700]);
            const say = { t: c + APPEND_TRANSCRIPT_MS, k: 0, run: () => r.output(" going to sleep.", c + APPEND_TRANSCRIPT_MS - 200, c + APPEND_TRANSCRIPT_MS + 300) };
            const at = evs.findIndex((x, j) => j > i && (x.t > say.t || (x.t === say.t && x.k > say.k)));
            evs.splice(at < 0 ? evs.length : at, 0, say);
          }
          seen = sock().sent.length;
        }
      }
      await flush();
    },
    input(delta, startMs, endMs) {
      sock().receive({ type: "session.input_transcript.delta", event_id: `i${++seq}`, delta, start_ms: startMs, end_ms: endMs });
    },
    output(delta, startMs, endMs) {
      sock().receive({ type: "session.output_transcript.delta", event_id: `o${++seq}`, delta, start_ms: startMs, end_ms: endMs });
    },
    delegation(id, offsetMs) {
      sock().receive({ type: "session.delegation.created", event_id: `d${++seq}`, offset_ms: offsetMs, delegation: { id, type: "delegation", target: "client" } });
    },
  };
  return r;
}

/** The app's recogniser on a line: partials word by word across the speech, then the final. */
function earLine(r: Rig, segment: number, text: string, fromS: number, toS: number, finalS: number): { t: number; run: () => void }[] {
  const words = text.split(" ");
  const out: { t: number; run: () => void }[] = [];
  words.forEach((_, k) => {
    const t = Math.round(fromS + 150 + ((toS - fromS) * (k + 1)) / words.length);
    out.push({ t, run: () => r.w.engine.ear(words.slice(0, k + 1).join(" ").replace(/[.,!?]+$/, ""), false, segment, r.wall(t)) });
  });
  out.push({ t: finalS, run: () => r.w.engine.ear(text, true, segment, r.wall(finalS)) });
  return out;
}

/** The first audible frame played at or after `fromS` (session ms), if any. */
function firstVoicedPlayedAt(r: Rig, fromS: number): number | undefined {
  return r.played.find((p) => p.audible && p.s >= fromS)?.s;
}

// ---- LC-7's frames, in session ms (session.started = 0) ------------------------------------------------------------

/** The audible output runs LC-7 recorded: the typed reply, then every answer the voice gave the room. */
const LC7_VOICED: readonly (readonly [number, number])[] = [
  [1859, 2359], [2660, 3560], // "hello kevin, here and listening."
  [16240, 16540], [17439, 17647], // "on it." … "done."
  [33012, 33114], [33414, 33414], // "night."
  [67947, 68248], [69150, 69249], // "on it." … "done."
  [85947, 85947], [86250, 86447], [87148, 87547], // "i didn't catch it. what happened?"
];
/** The typed reply's last audible frame: everything after it that sounds, the clause aside, is an answer to the room. */
const TYPED_REPLY_END_S = 3560;
/** The typed reply's last transcript delta (arrival): the last addressed turn LC-7's judge counts from. */
const LAST_ADDRESSED_S = 3166;
/** The first room line's first word on Live's transcript. */
const FIRST_ROOM_S = 13_875;

function lc7Script(r: Rig, typed: { ms?: number }): Script {
  const IN: [number, string, number, number][] = [
    [13875, " scroll", 13800, 14000], [14052, " down", 14000, 14200], [14215, " a", 14200, 14400], [14602, " bit", 14600, 14800],
    [30613, " Okay", 30600, 30800], [31048, ", I'm", 31000, 31200], [31458, " heading", 31400, 31600], [31671, " out", 31600, 31800], [32289, ". Good", 32200, 32400], [32636, "night.", 32400, 32600],
    [48282, " Press", 48200, 48400], [48849, " Enter", 48800, 49000],
    [64670, " Hit", 64600, 64800], [65494, " the", 65400, 65600], [65648, " like", 65600, 65800], [66017, " button", 66000, 66200],
    [81893, " Did", 81800, 82000], [82104, " you", 82000, 82200], [82452, " see the", 82400, 82600], [82807, " game", 82800, 83000], [83268, " last", 83200, 83400], [83448, " night", 83400, 83600], [84310, "? It", 84200, 84400], [84430, " went to", 84400, 84600], [85419, " overtime.", 85200, 85400],
  ];
  const OUT: [number, string, number, number][] = [
    [1685, " hello ke", 1400, 1600], [1862, "vin,", 1600, 1800], [2126, " here", 2000, 2200], [2548, " and", 2400, 2600], [2752, " listening", 2600, 2800], [3166, ".", 3000, 3200],
    [15947, " on it", 15800, 16000], [16117, ".", 16000, 16200], [17146, " done.", 17000, 17200],
    [32804, " night.", 32600, 32800],
    [67785, " on it", 67600, 67800], [67935, ".", 67800, 68000], [68952, " done.", 68800, 69000],
    [85596, " i didn't", 85400, 85600], [85872, " catch", 85600, 85800], [86039, " it.", 85800, 86000], [86640, " what", 86400, 86600], [87055, " happened?", 86800, 87000],
  ];
  const at: { t: number; run: () => void | Promise<void> }[] = [
    {
      t: 2,
      run: async () => {
        const t0 = performance.now();
        await r.w.engine.sayText("Say hello in five words.");
        typed.ms = performance.now() - t0;
      },
    },
    ...IN.map(([t, d, a, b]) => ({ t, run: () => r.input(d, a, b) })),
    ...OUT.map(([t, d, a, b]) => ({ t, run: () => r.output(d, a, b) })),
    { t: 15503, run: () => r.delegation("item_EVwvUEDuDCKwI3UfjiQa6", 15400) },
    { t: 67565, run: () => r.delegation("item_EVwwKOsBBHKP8n1r1t5jj", 67400) },
    ...[14730, 29732, 44734, 59737, 74736, 89737].map((t, i) => ({ t, run: () => r.sock().receive({ type: "session.usage.updated", event_id: `u${i}`, usage: { seconds: 14 + 15 * i } }) })),
    ...earLine(r, 1, "Scroll down a bit.", 12187, 13625, 14345),
    ...earLine(r, 2, "Okay I'm heading out, goodnight.", 29345, 31496, 31970),
    ...earLine(r, 3, "Press enter.", 46971, 47905, 48476),
    ...earLine(r, 4, "Hit the like button.", 63477, 65144, 65789),
    ...earLine(r, 5, "Did you see the game last night? It went to overtime.", 80792, 84308, 84748),
  ];
  return { voiced: LC7_VOICED, slop: 50, at, answerClause: true };
}

test("LC-7 replayed: the room is heard and kept, never answered — nothing reaches the brain, the hands or the speaker, and the session sleeps at the idle limit with the talk going on", async () => {
  const r = await rig(1);
  const { w } = r;
  const typed: { ms?: number } = {};
  // The canned brain answers "Done." at once, as LC-7's did: whatever reached it would show as a task.
  const brainDone = setInterval(() => w.brain.resolve?.({ status: "done", summary: "Done." }), 5);
  try {
    await r.run(lc7Script(r, typed), 100_000);

    // The premise: Live heard the room while the session was open, and the room is on the record (heard rows), kept as
    // context. Lines 4 and 5 come after the sleep: the socket is closed, only the ear hears them.
    const heard = rows<HeardRow>(w, "heard").map((row) => row.item.text);
    for (const words of ["scroll down a bit", "Goodnight", "Press Enter"]) assert.ok(heard.some((h) => h.includes(words)), `not on the record: ${words} (${JSON.stringify(heard)})`);
    assert.ok(!heard.some((h) => /like button|overtime/.test(h)), `Live heard the room after the sleep: ${JSON.stringify(heard)}`);

    // Nothing unaddressed reached the brain, the eyes or the hands: Live's room delegation refused before the brain's first look.
    assert.deepEqual(w.brain.tasks.map((t) => t.request), [], "the room reached the brain");
    const acting = w.hands.ops.filter((o) => o.at >= r.wall(FIRST_ROOM_S) && !["hello", "frontmost_app", "user_idle", "list_windows", "ax_tree", "find_element", "focused_text", "read_focused_text"].includes(o.op)).map((o) => o.op);
    assert.deepEqual(acting, [], "the room reached the hands (or the delegation's first look)");
    const created = rows<CreatedRow>(w, "delegation.created").filter((row) => row.delegation.liveId === "item_EVwvUEDuDCKwI3UfjiQa6");
    const finished = rows<FinishedRow>(w, "delegation.finished").filter((row) => row.delegationId === created[0]?.delegation.id);
    assert.deepEqual(finished.map((row) => row.status), ["cancelled"], `the room delegation is on the ledger as refused: ${JSON.stringify(rows<FinishedRow>(w, "delegation.finished"))}`);
    assert.match(finished[0]!.summary ?? "", /not addressed/);
    // Refused after a bounded wait for a late name (1.2 s on the engine's clock, read at the next frame or tick; here the
    // rig's frames come every 100 ms and the refusal lands a few frames on), never much later.
    const refusedAfter = finished[0]!.at - r.wall(15503);
    assert.ok(refusedAfter >= 1200 && refusedAfter <= 1700, `refused ${refusedAfter} ms after Live's delegation`);
    // Its second delegation (67.6 s) never comes: asleep by then.
    assert.equal(rows<CreatedRow>(w, "delegation.created").filter((row) => row.delegation.liveId === "item_EVwwKOsBBHKP8n1r1t5jj").length, 0);
    // Closed for the voice with one silent thinking append on its id; no commentary, no line that asks for words.
    const sent = r.sock().events().filter((e) => e.at >= r.wall(FIRST_ROOM_S));
    assert.deepEqual(sent.filter((e) => e.type === "session.thinking.append").map((e) => e.delegationId), ["item_EVwvUEDuDCKwI3UfjiQa6"]);
    assert.deepEqual(sent.filter((e) => e.type === "session.commentary.append").map((e) => e.content), [], "commentary after a refused room delegation");

    // Nothing the voice said to the room reached the speaker; the typed reply did, from its first audible frame, and so
    // did the pre-sleep clause (it was asked for).
    assert.ok(r.clauseS !== undefined, "no pre-sleep clause");
    const clauseFrom = r.clauseS + APPEND_AUDIBLE_MS - 100;
    const clauseTo = r.clauseS + APPEND_AUDIBLE_MS + 700 + 100;
    const roomSound = r.played.filter((p) => p.audible && p.s > TYPED_REPLY_END_S + 100 && !(p.s >= clauseFrom && p.s <= clauseTo));
    assert.deepEqual(roomSound.map((p) => p.s), [], "the voice's answers to the room were played");
    const replySound = r.played.filter((p) => p.audible && p.s <= TYPED_REPLY_END_S + 100);
    assert.ok(replySound.length >= 12 && replySound[0]!.s <= 1859 + 100, `the typed reply was not played whole: ${JSON.stringify(replySound.slice(0, 3))}`);
    const clauseSound = r.played.filter((p) => p.audible && p.s >= clauseFrom && p.s <= clauseTo);
    assert.ok(clauseSound.length >= 6, `the clause was not heard: ${clauseSound.length} audible frames`);

    // The idle clock ran through the room: the clause 5 s before the limit, the sleep at it, counted from the typed reply.
    const clauseAfter = r.clauseS - LAST_ADDRESSED_S;
    assert.ok(Math.abs(clauseAfter - 55_000) <= 1500, `the clause ${clauseAfter} ms after the last addressed turn, not 55 s ± 1.5`);
    const sleeps = rows<SleepRow>(w, "sleep");
    assert.deepEqual(sleeps.map((row) => [row.cause, row.phrase]), [["idle", undefined]], "one idle sleep, no 'said goodnight'");
    const sleepAfter = sleeps[0]!.at - r.wall(LAST_ADDRESSED_S);
    assert.ok(Math.abs(sleepAfter - 60_000) <= 1500, `asleep ${sleepAfter} ms after the last addressed turn, not 60 s ± 1.5`);
    assert.equal(w.engine.currentPhase, "asleep");
    assert.ok(r.sock().closed, "the paid socket is closed");

    console.log(`[measure] LC-7 replay: typed sayText → append ${typed.ms?.toFixed(2)} ms; refused +${refusedAfter} ms; clause +${clauseAfter} ms; sleep +${sleepAfter} ms`);
  } finally {
    clearInterval(brainDone);
    await w.engine.stop();
  }
});

// ---- addressed speech keeps its latency -------------------------------------------------------------------------

test("addressed speech is not slower: typed, the name first, the name last in Live's tightest race, inside the exchange, the engine's own line — each reply's first audible frame plays on arrival and each delegation runs; the room after the exchange shuts is not answered", async () => {
  const r = await rig(10);
  const { w } = r;
  const typed: { ms?: number } = {};
  try {
    // 1. Typed (LC-5's path): the append leaves in the same turn, the reply's first audible frame plays on arrival.
    await r.run({ voiced: [[1948, 2400]], at: [
      { t: 2, run: async () => { const t0 = performance.now(); await w.engine.sayText("What day is it?"); typed.ms = performance.now() - t0; } },
      { t: 1588, run: () => r.output(" it's tuesday.", 1500, 2300) },
    ] }, 3000);
    const append = r.sock().events().find((e) => e.type === "session.instructions.append" && /What day is it/.test(e.content ?? ""));
    assert.equal(append?.at, r.wall(2), "the typed line's append left in the same turn");
    assert.equal(firstVoicedPlayedAt(r, 1800), 1948, "the typed reply's first audible frame was held or dropped");

    // 2. The name first (LC-10, "Jarhead, what's on my screen?"): Live's name delta 1.0 s before the speech ends, the
    //    delegation +0.95 s after, the first text +1.42 s, the first audible frame +1.73 s.
    const E1 = 14_000;
    let tasksAtDelegation = -1;
    await r.run({ voiced: [[E1 + 1748, E1 + 2300]], at: [
      { t: E1 - 1000, run: () => r.input(" Jarhead,", E1 - 2300, E1 - 1900) },
      { t: E1 + 950, run: () => r.input(" what's on my screen?", E1 - 1800, E1) },
      { t: E1 + 952, run: () => r.delegation("item_n1", E1 + 900) },
      { t: E1 + 953, run: () => void (tasksAtDelegation = w.brain.tasks.length) },
      { t: E1 + 1422, run: () => r.output(" looking.", E1 + 1350, E1 + 1700) },
    ] }, E1 + 3000);
    assert.equal(firstVoicedPlayedAt(r, E1), E1 + 1748, "name first: the reply's first audible frame");
    assert.equal(tasksAtDelegation, 1, "name first: the brain had the request in the turn Live delegated");
    assert.match(w.brain.tasks[0]!.request, /what's on my screen/);
    w.brain.resolve?.({ status: "done", summary: "Notes." });

    // 3. The name last, Live only (no ear), its tightest race on record (LC-6: the last input delta and the first
    //    output text in the same ms, the first audible frame +1281 ms): the name lands after the voice began.
    const E2 = 40_000;
    await r.run({ voiced: [[E2 + 1348, E2 + 1900]], at: [
      { t: E2 + 400, run: () => r.input(" what's the weather tomorrow,", E2 - 1900, E2 - 500) },
      { t: E2 + 1072, run: () => r.output(" looking.", E2 + 1000, E2 + 1400) },
      { t: E2 + 1072, run: () => r.input(" jarhead?", E2 - 400, E2) },
      { t: E2 + 1080, run: () => r.delegation("item_n2", E2 + 1000) },
    ] }, E2 + 3000);
    assert.equal(firstVoicedPlayedAt(r, E2), E2 + 1348, "name last: the reply's first audible frame");
    assert.ok(await until(() => w.brain.tasks.length === 2, 1000), "name last: the delegation did not reach the brain");
    assert.match(w.brain.tasks[1]!.request, /weather tomorrow.*jarhead/i);
    w.brain.resolve?.({ status: "done", summary: "Rain." });

    // 4. Inside the exchange, no name: Kevin starts 6.5 s after Jarhead's last words, Live's first delta arrives 8.2 s
    //    after them (past the 8 s window on the wall clock), its start on the timeline inside it.
    const R = E2 + 1900;
    await r.run({ voiced: [[R + 11_048, R + 11_600]], at: [
      { t: R + 8200, run: () => r.input(" and on friday?", R + 6500, R + 7400) },
      { t: R + 8400, run: () => r.delegation("item_w1", R + 8300) },
      { t: R + 10_700, run: () => r.output(" looking.", R + 10_600, R + 11_000) },
    ] }, R + 12_000);
    assert.equal(firstVoicedPlayedAt(r, R + 9000), R + 11_048, "in the exchange: the reply's first audible frame");
    assert.ok(await until(() => w.brain.tasks.length === 3, 1000), "in the exchange: the delegation did not reach the brain");
    assert.match(w.brain.tasks[2]!.request, /friday/);
    w.brain.resolve?.({ status: "done", summary: "Sun." });

    // 5. The exchange shuts: room talk 9 s after the last granted words is not answered and not run.
    const R2 = R + 11_600;
    await r.run({ voiced: [[R2 + 11_348, R2 + 11_900]], at: [
      { t: R2 + 10_200, run: () => r.input(" press enter.", R2 + 9000, R2 + 9800) },
      { t: R2 + 10_900, run: () => r.delegation("item_r1", R2 + 10_800) },
      { t: R2 + 11_000, run: () => r.output(" on it.", R2 + 10_900, R2 + 11_300) },
    ] }, R2 + 13_000);
    assert.equal(firstVoicedPlayedAt(r, R2 + 9000), undefined, "room talk after the exchange shut was answered aloud");
    assert.equal(w.brain.tasks.length, 3, "room talk after the exchange shut reached the brain");
    assert.equal(w.hands.ops.filter((o) => o.op === "key" && o.at >= r.wall(R2)).length, 0, "room talk after the exchange shut pressed a key");

    // 6. Kevin names Jarhead over an answer to the room: the room answer's tail never plays (Live's barge-in cuts the
    //    words at once and the sound 800 ms later, LC-6 trial 2), the answer to Kevin does, from its first frame.
    const R3 = R2 + 30_000;
    await r.run({ voiced: [[R3 + 1500, R3 + 4300], [R3 + 5300, R3 + 5800]], at: [
      { t: R3 + 1000, run: () => r.input(" did you see the game?", R3 - 600, R3 + 400) },
      { t: R3 + 1300, run: () => r.output(" no, what happened", R3 + 1200, R3 + 2400) },
      { t: R3 + 3500, run: () => r.input(" Jarhead, what time is it?", R3 + 2400, R3 + 3400) },
      { t: R3 + 5100, run: () => r.output(" three.", R3 + 5000, R3 + 5300) },
    ] }, R3 + 6500);
    const roomTail = r.played.filter((p) => p.audible && p.s >= R3 && p.s <= R3 + 4400);
    assert.deepEqual(roomTail.map((p) => p.s), [], "the answer to the room played, or its tail did once Kevin named Jarhead");
    assert.equal(firstVoicedPlayedAt(r, R3 + 5000), R3 + 5348, "the answer to Kevin's named question");

    // 7. The engine's own line after room talk (an automation's, a thread's): the append asks, and its reply is heard.
    const R4 = R3 + 30_000;
    await r.run({ voiced: [[R4 + 3500, R4 + 3900]], at: [
      { t: R4 + 1000, run: () => r.input(" in other news tonight", R4 - 500, R4 + 600) },
      { t: R4 + 1500, run: () => void (w.engine as unknown as { live: LiveSession }).live.appendCommentary(null, "Spotify: playing Focus.") },
      { t: R4 + 3100, run: () => r.output(" spotify is playing focus.", R4 + 3000, R4 + 3400) },
    ] }, R4 + 4500);
    assert.equal(firstVoicedPlayedAt(r, R4 + 2000), R4 + 3548, "the engine's own line was held or dropped");

    console.log(`[measure] addressed: typed sayText → append ${typed.ms?.toFixed(2)} ms (same engine turn); first audible frame held 0 ms on every addressed path`);
  } finally {
    await w.engine.stop();
  }
});

/**
 * LC-6 (034154-454) trial 3's shape, outside any exchange and with no ear: "What's on my screen, Jar" … the voice
 * begins … "head". The Transcript splits the item when the voice's words land between Kevin's fragments, so 'head'
 * arrives alone, 582 ms after 'Jar'. Live's delegation came before the name: it waits for it (bounded), and runs.
 */
test("the name split around the voice's reply (LC-6 trial 3, no ear): one utterance, named; every audible frame of the reply plays and the delegation that waited for the name runs with the whole request", async () => {
  const r = await rig(10);
  const { w } = r;
  try {
    const T = 30_000;
    await r.run({ voiced: [[T + 1948, T + 2248]], at: [
      { t: T + 1200, run: () => r.input(" What's on my screen,", T + 200, T + 1200) },
      { t: T + 1327, run: () => r.input(" Jar", T + 1400, T + 1600) },
      { t: T + 1499, run: () => r.delegation("item_late", T + 1700) },
      { t: T + 1499, run: () => r.output(" on it.", T + 1800, T + 2000) },
      { t: T + 1909, run: () => r.input("head", T + 1800, T + 2000) },
    ] }, T + 3500);
    assert.ok(await until(() => w.brain.tasks.length === 1, 1500), "the delegation that waited for the name did not run");
    assert.match(w.brain.tasks[0]!.request, /what's on my screen, jar ?head/i);
    const heard = r.played.filter((p) => p.audible && p.s >= T);
    assert.deepEqual(heard.map((p) => p.s), [T + 1948, T + 2048, T + 2148, T + 2248], "the reply's audible frames on the speaker");
  } finally {
    w.brain.resolve?.({ status: "done", summary: "a browser" });
    await w.engine.stop();
  }
});

/** …and when the name lands after the reply's first audible frame: the frames held since it go to the speaker at the name. */
test("a name that lands after the reply began to sound (within 600 ms) releases the reply from its first audible frame", async () => {
  const r = await rig(10);
  const { w } = r;
  try {
    const T = 30_000;
    await r.run({ voiced: [[T + 1648, T + 2248]], at: [
      { t: T + 1200, run: () => r.input(" scroll down a bit,", T + 200, T + 1200) },
      { t: T + 1327, run: () => r.input(" Jar", T + 1400, T + 1600) },
      { t: T + 1499, run: () => r.output(" on it.", T + 1800, T + 2000) },
      { t: T + 1909, run: () => r.input("head", T + 1800, T + 2000) },
    ] }, T + 3000);
    const audible = r.played.filter((p) => p.audible && p.s >= T);
    // Nothing audible is lost: three frames (1648, 1748, 1848) may wait for 'head' at 1909, never longer; the rest play on arrival.
    assert.equal(audible.length, 7, `${audible.length} of 7 audible frames reached the speaker: ${JSON.stringify(audible.map((p) => p.s))}`);
    assert.ok(audible.slice(0, 3).every((p) => p.s <= T + 1909), `the reply's start waited past the name: ${JSON.stringify(audible.slice(0, 3))}`);
    assert.deepEqual(audible.slice(3).map((p) => p.s), [T + 1948, T + 2048, T + 2148, T + 2248], "the rest of the reply on arrival");
  } finally {
    await w.engine.stop();
  }
});

/**
 * The exchange chain. A reply the voice gives inside the 8 s window is Jarhead's words and extends the window, so a TV
 * that talks every few seconds after one named turn, with the voice answering each line (GPT-Live-1 answered 4 of 5 in
 * LC-7), would stay "mid-exchange" for ever and hold the paid session open (B2). The exchange lasts at most
 * EXCHANGE_MAX_MS (120 s) after the last turn that named Jarhead, was typed or circled, or pressed Go.
 */
test("the exchange chain is bounded: a TV answered every 5 s after one named turn sleeps by the cap plus the idle limit", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 1 });
    await engine.wake("test");
    // The session timeline follows the test clock (world.ts's FakeLive): Live's stamps are "now" on it.
    const live = w.lives[w.lives.length - 1]!;
    const t0 = clock.t;
    const tickTo = (ms: number): void => {
      while (clock.t - t0 < ms) {
        clock.t += 500;
        if ((clock.t - t0) % 1000 === 0) tick(engine);
      }
    };
    const hear = (text: string): void => {
      const s = live.nowMs;
      live.emit("inputTranscript", ` ${text}`, s - 1500, s);
    };
    const reply = (text: string): void => {
      const s = live.nowMs;
      live.emit("outputTranscript", ` ${text}`, s, s + 800);
      live.emit("audio", Buffer.from(VOICED, "base64"));
    };
    tickTo(2000);
    hear("jarhead what's the weather like");
    tickTo(3500);
    reply("cold and wet.");
    let asleepAt: number | undefined;
    for (let k = 1; k <= 120 && asleepAt === undefined; k++) {
      tickTo(3500 + k * 5000 - 1500);
      if (engine.transportState !== "awake") asleepAt = clock.t - t0;
      else hear(`and in other news tonight, story number ${k}`);
      tickTo(3500 + k * 5000);
      if (engine.transportState !== "awake") asleepAt = clock.t - t0;
      else reply(`sounds like a big story, number ${k}.`);
    }
    await settle(50);
    const bound = 3500 + 120_000 + 60_000 + 6000;
    assert.ok(asleepAt !== undefined && asleepAt <= bound, `asleep at ${asleepAt === undefined ? "never (10 min)" : `${asleepAt / 1000} s`}, bound ${bound / 1000} s`);
    assert.deepEqual(rows<SleepRow>(w, "sleep").map((r) => r.cause), ["idle"]);
    console.log(`[measure] exchange chain: asleep at ${(asleepAt ?? 0) / 1000} s`);
  } finally {
    await engine.stop();
  }
});
