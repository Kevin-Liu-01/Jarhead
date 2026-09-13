import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_THREAD_ID, THREADS_MAX, THREAD_LINGER_MS, THREAD_STATUSES, THREAD_TERMINAL, type LedgerRow, type Thread, type ThreadEvent, type ThreadStatus } from "@jarhead/protocol";
import { ACTING_HOLD_MS, RESTART_REASON, THREAD_APPS_MAX, THREAD_EVENTS_RING, THREAD_TABLE_MAX, ThreadEventCoalescer, ThreadTable } from "../threads/table.ts";
import { joinNames, mainLine, phraseForLine, phraseForTool, threadLine } from "../threads/lines.ts";
import { THREAD_IDLE_END_MS } from "../threads/scheduler.ts";

/**
 * The task table, pure: Maps and a ring, no I/O. A seeded walk of a thousand random
 * transitions keeps the status count vector equal to a recount; eviction past the
 * cap drops the oldest FINISHED record and never a live one; the ring keeps the
 * newest 512 events with a monotonic seq; names are released at the end and answer
 * from `recent` for the linger; apps index while live; the acting→thinking flip
 * follows the clock; the status line is deterministic English; the rebuild from
 * ledger rows across a midnight boundary equals the table the live writes made.
 */

const T0 = 1_757_500_000_000;

/** A small LCG: the same sequence on every run, so a failure replays. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function mk(id: string, name: string, at: number, extra: Partial<Thread> = {}): Thread {
  return { id, name, lane: "background", status: "starting", parentId: MAIN_THREAD_ID, parentDelegationId: "dlg_p", liveId: "item_1", task: `${name}'s job`, apps: [], startedAt: at, updatedAt: at, turns: 0, steps: 0, waits: 0, budget: { steps: 25, seconds: 180 }, canSay: true, canStop: true, ...extra };
}

function main(at: number): Thread {
  return { ...mk(MAIN_THREAD_ID, "Jarhead", at), lane: "voice", status: "idle", task: "" };
}

function recount(table: ThreadTable): number[] {
  const v = new Array<number>(THREAD_STATUSES.length).fill(0);
  for (const t of table.all()) v[THREAD_STATUSES.indexOf(t.status)]!++;
  return v;
}

test("1000 random transitions over 40 threads keep the count vector equal to a recount, the live set to the non-terminal records, and the name index to the live ones", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  const random = rng(42);
  const ids: string[] = [];
  const live: ThreadStatus[] = ["starting", "thinking", "acting", "waiting-screen", "waiting-kevin", "paused", "queued"];
  for (let i = 0; i < 1000; i++) {
    clock.t += 100;
    const roll = random();
    if (ids.length < 40 && (roll < 0.15 || ids.length === 0)) {
      const id = `t_${ids.length}`;
      ids.push(id);
      table.started(mk(id, `T${ids.length}`, clock.t));
      continue;
    }
    const id = ids[Math.floor(random() * ids.length)]!;
    const t = table.get(id)!;
    if (THREAD_TERMINAL.has(t.status)) {
      // Nothing moves a finished thread: every write is a no-op.
      assert.equal(table.status(id, "thinking"), undefined);
      assert.equal(table.step(id, { tool: "x", ok: true }), undefined);
      assert.equal(table.ended(id, "done"), undefined);
      continue;
    }
    if (roll < 0.35) table.status(id, live[Math.floor(random() * live.length)]!);
    else if (roll < 0.7) table.step(id, { tool: "frontmost_app", ok: random() < 0.9 });
    else if (roll < 0.8) table.question(id, `question ${i}?`);
    else if (roll < 0.9) table.ended(id, (["done", "failed", "stopped"] as const)[Math.floor(random() * 3)]!);
    else table.tick(clock.t + ACTING_HOLD_MS);
    assert.deepEqual(table.countVector(), recount(table), `after transition ${i}`);
    const liveIds = table.liveIds();
    assert.deepEqual(new Set(liveIds), new Set(table.all().filter((x) => !THREAD_TERMINAL.has(x.status)).map((x) => x.id)));
    assert.equal(table.liveCount(), liveIds.length);
    for (const x of table.all()) {
      const byName = table.byNameLive(x.name);
      if (THREAD_TERMINAL.has(x.status)) assert.notEqual(byName?.id, x.id, "a finished thread's name is released");
      else assert.equal(byName?.id, x.id);
    }
  }
  const sum = table.countVector().reduce((a, b) => a + b, 0);
  assert.equal(sum, table.all().length);
  assert.ok(table.lastSeq > 300 && table.lastSeq <= 1000, `${table.lastSeq} events: a write on a finished thread appends nothing`);
});

test("eviction past THREAD_TABLE_MAX drops the oldest FINISHED record and never a live one; the ring keeps the newest THREAD_EVENTS_RING events with a monotonic seq and since(seq) pages", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  // 70 threads: the first four stay live for the whole test.
  for (let i = 0; i < 70; i++) {
    clock.t += 10;
    table.started(mk(`t_${i}`, `N${i}`, clock.t));
    if (i >= 4) table.ended(`t_${i}`, "done", "fine");
  }
  assert.equal(table.all().length, THREAD_TABLE_MAX);
  assert.equal(table.evicted, 70 - THREAD_TABLE_MAX);
  for (let i = 0; i < 4; i++) assert.ok(table.get(`t_${i}`), `live t_${i} survives`);
  assert.equal(table.get("t_4"), undefined, "the oldest finished record went first");
  assert.equal(table.get("t_9"), undefined);
  assert.ok(table.get("t_10"), "the newer finished records stay");
  assert.equal(table.liveCount(), 4);
  assert.deepEqual(table.countVector(), recount(table));
  // Only finished records evict: with 64 live ones nothing would.
  const small = new ThreadTable({ now: () => clock.t, max: 2 });
  small.started(mk("a", "A", clock.t));
  small.started(mk("b", "B", clock.t));
  small.started(mk("c", "C", clock.t));
  assert.equal(small.all().length, 3, "three live: none evicted past a cap of two");
  small.ended("a", "done");
  small.started(mk("d", "D", clock.t));
  assert.equal(small.get("a"), undefined, "the finished one went as soon as a record was added");

  // The ring: 70 started + 66 ended = 136 events so far; step up to well past 512.
  const before = table.lastSeq;
  for (let i = 0; i < 600; i++) table.step("t_0", { tool: "frontmost_app", ok: true });
  assert.equal(table.lastSeq, before + 600);
  const all = table.since(0);
  assert.equal(all.length, THREAD_EVENTS_RING);
  for (let i = 1; i < all.length; i++) assert.equal(all[i]!.seq, all[i - 1]!.seq + 1, "monotonic, no gap");
  assert.equal(all[all.length - 1]!.seq, table.lastSeq);
  assert.equal(all[0]!.seq, table.lastSeq - THREAD_EVENTS_RING + 1, "the oldest kept is exactly ring-size back");
  const page = table.since(table.lastSeq - 10);
  assert.equal(page.length, 10);
  assert.equal(page[0]!.seq, table.lastSeq - 9);
  assert.equal(table.since(table.lastSeq).length, 0);
});

test("byNameLive answers only live threads (case-insensitive) and releases the name at the end; byNameRecent answers within THREAD_LINGER_MS and not after; byApp indexes claimed apps (≤ 4, newest is `app`) while live", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  table.started(mk("t_1", "Spotify", clock.t));
  assert.equal(table.byNameLive("spotify")?.id, "t_1");
  assert.equal(table.byNameLive(" SPOTIFY ")?.id, "t_1");
  assert.equal(table.byNameRecent("spotify"), undefined, "live, not recent");
  table.claimApp("t_1", "Spotify");
  table.claimApp("t_1", "open.spotify.com");
  table.claimApp("t_1", "Finder");
  table.claimApp("t_1", "Notes");
  table.claimApp("t_1", "spotify");
  const t = table.get("t_1")!;
  assert.equal(t.apps.length, THREAD_APPS_MAX);
  assert.deepEqual(t.apps, ["open.spotify.com", "Finder", "Notes", "spotify"], "deduped case-insensitively, newest last, the oldest dropped past four");
  assert.equal(t.app, "spotify");
  assert.equal(table.byApp("SPOTIFY")[0]?.id, "t_1");
  assert.equal(table.byApp("finder")[0]?.id, "t_1");
  assert.equal(table.byApp("Mail").length, 0);
  table.ended("t_1", "done", "playing Focus.");
  assert.equal(table.byNameLive("spotify"), undefined, "released");
  assert.equal(table.byNameRecent("spotify")?.id, "t_1");
  assert.equal(table.byApp("spotify").length, 0, "no longer a live claim");
  clock.t += THREAD_LINGER_MS;
  assert.equal(table.byNameRecent("spotify")?.id, "t_1", "still within the linger");
  clock.t += 1;
  assert.equal(table.byNameRecent("spotify"), undefined, "gone after it");
  // A new thread may take the released name; recent then points at the newest ended one.
  table.started(mk("t_2", "spotify", clock.t));
  assert.equal(table.byNameLive("Spotify")?.id, "t_2");
  table.ended("t_2", "failed", "no such playlist");
  assert.equal(table.byNameRecent("spotify")?.id, "t_2");
});

test("tick() flips acting→thinking after ACTING_HOLD_MS without a step and back to acting on the next ok step; a failed step does not make a thread acting; the count vector follows", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  table.started(mk("t_1", "Slack", clock.t));
  table.status("t_1", "thinking");
  assert.equal(table.get("t_1")!.status, "thinking");
  table.step("t_1", { tool: "click_element", ok: false });
  assert.equal(table.get("t_1")!.status, "thinking", "a refused click is not acting");
  table.step("t_1", { tool: "click_element", ok: true });
  assert.equal(table.get("t_1")!.status, "acting");
  assert.equal(table.count("acting"), 1);
  clock.t += ACTING_HOLD_MS - 1;
  assert.deepEqual(table.tick(), [], "not yet");
  clock.t += 1;
  const flipped = table.tick();
  assert.equal(flipped.length, 1);
  assert.equal(flipped[0]!.kind, "status");
  assert.equal(table.get("t_1")!.status, "thinking");
  assert.equal(table.count("thinking"), 1);
  assert.equal(table.count("acting"), 0);
  table.step("t_1", { screenshot: true });
  assert.equal(table.get("t_1")!.status, "acting", "a screenshot counts as a step");
  table.status("t_1", "waiting-screen");
  clock.t += ACTING_HOLD_MS;
  assert.deepEqual(table.tick(), [], "only an acting thread flips");
  assert.equal(table.get("t_1")!.steps, 3);
});

test("statusLine: one deterministic line per status, the phrase quoted when the thread said what it is doing, an unknown name names the live ones, the overview for 0 / 1 / 3 threads", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  assert.equal(table.statusLine(), "nothing is running");
  table.started(main(clock.t));
  assert.equal(table.statusLine(), "nothing is running", "an idle main thread is nothing running");
  table.started(mk("t_1", "Spotify", clock.t));
  assert.equal(table.statusLine("spotify"), "Spotify is starting");
  table.status("t_1", "thinking");
  clock.t += 6000;
  assert.equal(table.statusLine("Spotify"), "Spotify is thinking — 6 seconds in");
  table.step("t_1", { tool: "applescript", ok: true, phrase: "running an Apple event" });
  clock.t += 3000;
  assert.equal(table.statusLine("spotify"), "Spotify is running an Apple event — 9 seconds in");
  table.phrase("t_1", "playing Focus");
  clock.t += 3000;
  assert.equal(table.statusLine("spotify"), "Spotify is playing Focus — 12 seconds in");
  assert.equal(table.statusLine(), "Spotify is playing Focus — 12 seconds in", "one thread: its own line is the overview");
  assert.equal(table.statusLine("Mail"), "nothing called Mail is running; Spotify is");
  table.started(mk("t_2", "Slack", clock.t, { lane: "screen" }));
  table.status("t_2", "waiting-screen");
  assert.equal(table.statusLine("slack"), "Slack is waiting for the screen — 0 seconds in");
  table.question("t_2", 'Send it to Ben in Slack?');
  assert.equal(table.statusLine("slack"), "Slack is waiting on you: send it to Ben in Slack?");
  assert.equal(table.statusLine("Mail"), "nothing called Mail is running; Spotify and Slack are");
  table.started(mk("t_3", "Mail", clock.t));
  table.status("t_3", "paused");
  assert.equal(table.statusLine("mail"), "Mail is paused at step 0");
  assert.equal(table.statusLine(), "Three threads: Spotify working, Slack waiting on you, Mail paused");
  table.ended("t_1", "done", "playing Focus.");
  clock.t += 12_000;
  assert.equal(table.statusLine("spotify"), "Spotify finished 12 seconds ago — playing Focus");
  table.ended("t_3", "failed", "Mail is not running");
  assert.equal(table.statusLine("mail"), "Mail failed: Mail is not running");
  table.ended("t_2", "stopped", "Kevin stopped it");
  assert.equal(table.statusLine("slack"), "Slack was stopped");
  assert.equal(table.statusLine(), "nothing is running");
  table.status(MAIN_THREAD_ID, "acting");
  assert.equal(table.statusLine(), "I am working on it — 24 seconds in", "main alone and busy");
  // The line stays under 80 chars whatever the phrase.
  table.started(mk("t_4", "Notes", clock.t));
  table.status("t_4", "acting");
  table.phrase("t_4", "x".repeat(200));
  assert.ok(table.statusLine("notes").length <= 80);
  assert.equal(threadLine({ ...mk("t_9", "Zed", clock.t), status: "idle" }, clock.t), "Zed is idle");
  assert.equal(phraseForTool("open_app", { name: "Slack" }), "opening Slack");
  assert.equal(phraseForTool("frontmost_app", {}), "checking which app is in front", "a look's phrase is the spoken progress line, lower-cased, no full stop");
  assert.equal(phraseForTool("thread_start", { name: "Slack" }), undefined, "a tool the voice has no words for gives nothing");
  assert.equal(phraseForLine("Spotify: Playing Focus."), "playing Focus");
  // Only a phrase that reads after "<Name> is" is quoted: a doing-word first, two words at least, never a continuation.
  assert.equal(phraseForLine("I am pressing play now"), "pressing play now", "the subject goes");
  assert.equal(phraseForLine("Now typing the message."), "typing the message");
  assert.equal(phraseForLine("and now the volume"), undefined, "a fragment is no phrase");
  assert.equal(phraseForLine("but first the queue"), undefined);
  assert.equal(phraseForLine("done"), undefined, "one word is no phrase");
  assert.equal(phraseForLine("Done with the playlist."), undefined, "no doing-word first");
  assert.equal(phraseForLine("nothing found here"), undefined, "-ing without doing");
  assert.equal(phraseForLine("Spotify: 42."), undefined);
  assert.equal(phraseForLine(""), undefined);
  // Main alone, in the first person, per status.
  const m = main(clock.t);
  assert.equal(mainLine({ ...m, status: "acting" }, clock.t + 24_000), "I am working on it — 24 seconds in");
  assert.equal(mainLine({ ...m, status: "thinking" }, clock.t + 3_000), "I am working on it — 3 seconds in");
  assert.equal(mainLine({ ...m, status: "waiting-kevin", question: "Send it to Ben?" }, clock.t), "I am waiting on your yes: send it to Ben?");
  assert.equal(mainLine({ ...m, status: "waiting-kevin" }, clock.t), "I am waiting on your yes");
  assert.equal(mainLine({ ...m, status: "waiting-screen" }, clock.t + 2_000), "I am waiting for the screen — 2 seconds in");
  assert.equal(mainLine({ ...m, status: "paused" }, clock.t), "I am paused");
  assert.equal(mainLine({ ...m, status: "idle" }, clock.t), "nothing is running");
  table.ended("t_4", "stopped");
  table.status(MAIN_THREAD_ID, "waiting-kevin");
  assert.equal(table.statusLine(), "I am waiting on your yes", "never 'I am waiting on you on it'");
  assert.equal(joinNames(["Slack", "Spotify", "Mail"]), "Slack, Spotify and Mail");
});

test("question(): two events — status waiting-kevin then the question — the record carries it; a later status clears it; ended clears it and cuts the summary to 200", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  table.started(mk("t_1", "Slack", clock.t));
  const events = table.question("t_1", "send it to Ben?");
  assert.deepEqual(events.map((e) => e.kind), ["status", "question"]);
  assert.equal((events[0] as { status: string }).status, "waiting-kevin");
  assert.equal((events[1] as { question: string }).question, "send it to Ben?");
  assert.equal(table.get("t_1")!.question, "send it to Ben?");
  assert.equal(table.count("waiting-kevin"), 1);
  table.status("t_1", "paused");
  assert.equal(table.get("t_1")!.question, "send it to Ben?", "a pause keeps the question");
  table.status("t_1", "thinking");
  assert.equal(table.get("t_1")!.question, undefined, "answered or moved on: gone");
  table.question("t_1", "q".repeat(300));
  assert.equal(table.get("t_1")!.question!.length, 160);
  table.ended("t_1", "done", "s".repeat(300));
  assert.equal(table.get("t_1")!.question, undefined);
  assert.equal(table.get("t_1")!.detail!.length, 200);
  assert.equal(table.get("t_1")!.canStop, false);
  assert.equal(table.get("t_1")!.canSay, false);
  // The same status with the same detail is not a change; a new detail is.
  table.started(mk("t_2", "Mail", clock.t));
  table.status("t_2", "thinking");
  assert.equal(table.status("t_2", "thinking"), undefined);
  assert.equal(table.status("t_2", "thinking", "reading the inbox")?.kind, "status");
  assert.equal(table.status("t_2", "done" as ThreadStatus), undefined, "a terminal status goes through ended()");
});

test("summaries(): main first, live by age, then ended within the linger newest first, at most THREADS_MAX with live ones never dropped", () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  for (let i = 0; i < 30; i++) {
    clock.t += 10;
    table.started(mk(`t_${i}`, `N${i}`, clock.t));
    if (i < 26) table.ended(`t_${i}`, "done");
  }
  clock.t += 10;
  table.started(main(clock.t));
  const s = table.summaries();
  assert.equal(s.length, THREADS_MAX);
  assert.equal(s[0]!.id, MAIN_THREAD_ID, "main first");
  assert.deepEqual(s.slice(1, 5).map((t) => t.id), ["t_26", "t_27", "t_28", "t_29"], "live by age");
  assert.ok(s.slice(5).every((t) => t.status === "done"));
  assert.equal(s[5]!.id, "t_25", "the newest finished first");
  clock.t += THREAD_LINGER_MS + 1;
  assert.deepEqual(
    table.summaries().map((t) => t.id),
    [MAIN_THREAD_ID, "t_26", "t_27", "t_28", "t_29"],
    "finished ones leave after the linger; the live ones stay",
  );
  assert.deepEqual(table.liveNames(), ["N26", "N27", "N28", "N29"]);
  assert.equal(table.spawnedLiveCount(), 4);
});

test("the coalescer: a burst of ten steps in one window costs the wire two events (the first, then the newest); a status never waits behind a step; started / ended / question / said go at once and flush what waited; a summary and a step event stay under their budgets", async () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  const out: ThreadEvent[] = [];
  const co = new ThreadEventCoalescer((e) => out.push(e), 30);
  const push = (e: ThreadEvent | readonly ThreadEvent[] | undefined): void => {
    if (!e) return;
    if (Array.isArray(e)) for (const x of e as readonly ThreadEvent[]) co.push(x);
    else co.push(e as ThreadEvent);
  };
  push(table.started(mk("t_1", "Spotify", clock.t)));
  assert.equal(out.length, 1, "started at once");
  assert.ok(JSON.stringify(out[0]).length <= 700, "a started event carries the summary");
  push(table.status("t_1", "thinking"));
  assert.equal(out.length, 2, "the first status of a quiet moment at once");
  for (let i = 0; i < 10; i++) push(table.step("t_1", { tool: "frontmost_app", ok: true }));
  assert.equal(out.length, 2, "the burst waits");
  push(table.status("t_1", "waiting-screen", "jarhead has the screen"));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(out.length, 4, "the window closed: the newest step and the status");
  assert.deepEqual(out.slice(2).map((e) => e.kind).sort(), ["status", "step"]);
  const step = out.find((e) => e.kind === "step") as Extract<ThreadEvent, { kind: "step" }>;
  assert.equal(step.steps, 10, "the newest counter wins");
  assert.ok(JSON.stringify(step).length <= 200, `${JSON.stringify(step).length} B`);
  const status = out[3]!.kind === "status" ? out[3] : out[2]!;
  assert.ok(JSON.stringify(status).length <= 200);
  // A question while a step waits: the step goes first, then both question events, at once.
  await new Promise((r) => setTimeout(r, 40));
  push(table.step("t_1", { tool: "type", ok: true }));
  push(table.step("t_1", { tool: "type", ok: true }));
  const n = out.length;
  push(table.question("t_1", "send it?"));
  assert.equal(out.length, n + 3, "the pending step flushed, then status + question");
  assert.deepEqual(out.slice(n).map((e) => e.kind), ["step", "status", "question"]);
  push(table.said("t_1", "Slack asks: send it?"));
  assert.equal(out[out.length - 1]!.kind, "said");
  push(table.ended("t_1", "stopped", "Kevin stopped it"));
  assert.equal(out[out.length - 1]!.kind, "ended");
  // A long detail is cut on the wire so a status event stays under 200 B.
  push(table.started(mk("t_2", "Slack", clock.t)));
  await new Promise((r) => setTimeout(r, 40));
  const long = table.status("t_2", "waiting-screen", "w".repeat(190))!;
  assert.ok(JSON.stringify(long).length <= 200, `${JSON.stringify(long).length} B`);
  assert.equal(table.get("t_2")!.detail!.length, 190, "the record keeps the whole detail (≤ 200)");
  co.dispose();
});

test("the coalescer holds a slot only for a live thread that coalesced something: fifty threads that step, speak their finish line and end — and are spoken about after their end — leave no slot; the same question again appends no event", async () => {
  const clock = { t: T0 };
  const table = new ThreadTable({ now: () => clock.t });
  const out: ThreadEvent[] = [];
  const co = new ThreadEventCoalescer((e) => out.push(e), 30);
  const push = (e: ThreadEvent | readonly ThreadEvent[] | undefined): void => {
    if (!e) return;
    if (Array.isArray(e)) for (const x of e as readonly ThreadEvent[]) co.push(x);
    else co.push(e as ThreadEvent);
  };
  for (let i = 0; i < 50; i++) {
    const id = `t_${i}`;
    push(table.started(mk(id, `T${i}`, clock.t)));
    push(table.status(id, "thinking"));
    push(table.step(id, { tool: "frontmost_app", ok: true }));
    push(table.step(id, { tool: "frontmost_app", ok: true }));
    assert.equal(co.slots, 1, "one live thread coalescing");
    // The scheduler's order: the finish line, then the end.
    push(table.said(id, `T${i}: done.`));
    push(table.ended(id, "done", "done."));
    assert.equal(co.slots, 0, "the end took the slot with it");
    // A line about a finished thread (a late `said`, a rebuild's) makes no slot.
    push(table.said(id, "late"));
    assert.equal(co.slots, 0);
    assert.equal(out[out.length - 3]!.kind, "said");
    assert.equal(out[out.length - 2]!.kind, "ended");
    assert.equal(out[out.length - 1]!.kind, "said");
  }
  assert.equal(co.slots, 0, "fifty finished threads: no slot left behind");
  assert.equal(table.evicted, 0, "under the table's cap; the coalescer's map is bounded on its own");
  // A live thread keeps one slot; main never ends and keeps at most one.
  push(table.started(main(clock.t)));
  push(table.status(MAIN_THREAD_ID, "thinking"));
  push(table.step(MAIN_THREAD_ID, { tool: "type", ok: true }));
  assert.equal(co.slots, 1);
  // The same question twice: the second is nothing.
  push(table.started(mk("t_q", "Slack", clock.t)));
  push(table.status("t_q", "thinking"));
  const first = table.question("t_q", "send it?");
  assert.equal(first.length, 2, "status + question");
  assert.deepEqual(table.question("t_q", "send it?"), [], "the same words again: no change, no event");
  assert.equal(table.question("t_q", "send it to Ben?").length, 2, "new words: a change");
  assert.equal(table.get("t_q")!.question, "send it to Ben?");
  co.dispose();
});

test("rebuild(rows) across a midnight boundary equals the table the live writes made; a thread still live when the rows end is ended failed 'the daemon restarted' with one row to append; main comes back idle; steps are recounted from its delegation rows", () => {
  const clock = { t: T0 };
  const live = new ThreadTable({ now: () => clock.t });
  const rows: LedgerRow[] = [];
  const row = (r: LedgerRow): void => {
    rows.push(r);
  };
  // Yesterday: main registered; A started and worked; B started and finished; C started (its end is today).
  clock.t = T0 - 3 * 3600_000;
  const m = main(clock.t);
  live.started(m);
  row({ at: clock.t, type: "thread.started", thread: m });
  const a = mk("t_a", "Spotify", clock.t);
  live.started(a);
  row({ at: clock.t, type: "thread.started", thread: a });
  const dlgA = { id: "dlg_a1", liveId: "item_1", createdAt: clock.t, offsetMs: 0, request: "play focus", status: "running" as const, steps: [], timings: { delegatedAt: clock.t }, threadId: "t_a" };
  live.turn("t_a", dlgA.id, dlgA.request);
  row({ at: clock.t, type: "delegation.created", delegation: dlgA });
  for (let i = 0; i < 3; i++) {
    clock.t += 1000;
    live.step("t_a", { tool: "applescript", ok: true });
    row({ at: clock.t, type: "delegation.step", delegationId: dlgA.id, step: { id: `s${i}`, at: clock.t, kind: "tool", tool: { name: "applescript", input: {}, ok: true, ms: 5 } } });
  }
  live.status("t_a", "waiting-screen", "jarhead has the screen");
  row({ at: clock.t, type: "thread.status", threadId: "t_a", status: "waiting-screen", detail: "jarhead has the screen" });
  const b = mk("t_b", "Slack", clock.t, { lane: "screen" });
  live.started(b);
  row({ at: clock.t, type: "thread.started", thread: b });
  live.said("t_b", "Slack: sent.");
  row({ at: clock.t, type: "thread.said", threadId: "t_b", text: "Slack: sent." });
  live.ended("t_b", "done", "sent.");
  row({ at: clock.t, type: "thread.ended", threadId: "t_b", status: "done", summary: "sent.", steps: 0, seconds: 1 });
  const c = mk("t_c", "Mail", clock.t);
  live.started(c);
  row({ at: clock.t, type: "thread.started", thread: c });
  // Today: C ends; the daemon dies with A still live.
  clock.t = T0 + 60_000;
  live.ended("t_c", "stopped", "Kevin stopped it");
  row({ at: clock.t, type: "thread.ended", threadId: "t_c", status: "stopped", summary: "Kevin stopped it", steps: 0, seconds: 3 });

  clock.t = T0 + 120_000;
  const { table, orphans, rows: appended } = ThreadTable.rebuild(rows, { now: () => clock.t });
  assert.deepEqual(orphans.map((t) => t.id), ["t_a"]);
  assert.equal(appended.length, 1, "one thread.ended row to append");
  assert.equal(appended[0]!.type, "thread.ended");
  assert.equal(appended[0]!.threadId, "t_a");
  assert.equal(appended[0]!.status, "failed");
  assert.equal(appended[0]!.summary, RESTART_REASON);
  assert.equal(appended[0]!.steps, 3, "steps recounted from its delegation rows");
  const ra = table.get("t_a")!;
  assert.equal(ra.status, "failed");
  assert.equal(ra.detail, RESTART_REASON);
  assert.equal(ra.steps, 3);
  assert.equal(ra.turns, 1);
  assert.equal(ra.currentDelegationId, "dlg_a1");
  assert.equal(table.get(MAIN_THREAD_ID)!.status, "idle", "main comes back idle, never failed");
  assert.equal(table.get("t_b")!.status, "done");
  assert.equal(table.get("t_c")!.status, "stopped");
  assert.equal(table.liveCount(), 1, "only main is live");
  assert.deepEqual(table.countVector(), recount(table));
  // The rebuilt records equal the live table's, but for A (ended by the restart) and main (idle).
  for (const id of ["t_b", "t_c"]) {
    const { updatedAt: _u1, ...x } = live.get(id)!;
    const { updatedAt: _u2, ...y } = table.get(id)!;
    assert.deepEqual(y, x, id);
  }
  assert.equal(table.statusLine("spotify"), `Spotify failed: ${RESTART_REASON}`);
  assert.ok(table.summaries().some((t) => t.id === "t_a"), "the orphan shows within the linger");
  // A second rebuild over the rows plus the appended ones finds no orphan.
  const again = ThreadTable.rebuild([...rows, ...appended], { now: () => clock.t + 1000 });
  assert.equal(again.orphans.length, 0);
  assert.equal(again.rows.length, 0);
  assert.equal(again.table.get("t_a")!.status, "failed");
});

test("rebuild edge cases: a thread found paused or waiting on Kevin longer than THREAD_IDLE_END_MS ends failed 'the daemon restarted' (never 'idle' — nothing acts, nothing decides for it); two live records by one name leave the name free and both failed", () => {
  const clock = { t: T0 };
  const rows: LedgerRow[] = [];
  // Paused an hour ago, never resumed; waiting on a yes for as long.
  const p = mk("t_p", "Spotify", T0 - 3 * THREAD_IDLE_END_MS, { status: "thinking" });
  rows.push({ at: p.startedAt, type: "thread.started", thread: p });
  rows.push({ at: p.startedAt + 1000, type: "thread.status", threadId: "t_p", status: "paused", detail: "Kevin paused it" });
  const w = mk("t_w", "Slack", T0 - 2 * THREAD_IDLE_END_MS, { lane: "screen", status: "thinking" });
  rows.push({ at: w.startedAt, type: "thread.started", thread: w });
  rows.push({ at: w.startedAt + 1000, type: "thread.status", threadId: "t_w", status: "waiting-kevin", detail: "send it to Ben?" });
  // Two started rows for one name with no end between them (a process that died between them, or a file the daemon
  // never got to close): the rebuild must not leave a live name pointing at a failed record.
  const a = mk("t_a1", "Mail", T0 - 20_000);
  const b = mk("t_a2", "mail", T0 - 10_000);
  rows.push({ at: a.startedAt, type: "thread.started", thread: a });
  rows.push({ at: b.startedAt, type: "thread.started", thread: b });
  const { table, orphans, rows: appended } = ThreadTable.rebuild(rows, { now: () => clock.t });
  assert.deepEqual(orphans.map((t) => t.id).sort(), ["t_a1", "t_a2", "t_p", "t_w"]);
  assert.equal(appended.length, 4, "one row each");
  for (const id of ["t_p", "t_w", "t_a1", "t_a2"]) {
    assert.equal(table.get(id)!.status, "failed", id);
    assert.equal(table.get(id)!.detail, RESTART_REASON, id);
    assert.notEqual(table.get(id)!.detail, "idle");
  }
  assert.equal(table.get("t_w")!.question, undefined, "the question went with the end");
  assert.equal(table.liveCount(), 0, "nothing is live, nothing acts");
  assert.equal(table.byNameLive("mail"), undefined, "the colliding name is free");
  assert.equal(table.byNameLive("Mail"), undefined);
  assert.ok(table.byNameRecent("mail") !== undefined, "and answers from `recent` for the linger");
  assert.deepEqual(table.countVector(), recount(table));
  // A new Mail is admissible now: the live name index has no stale entry.
  table.started(mk("t_a3", "Mail", clock.t));
  assert.equal(table.byNameLive("mail")!.id, "t_a3");
  assert.equal(table.liveCount(), 1);
});
