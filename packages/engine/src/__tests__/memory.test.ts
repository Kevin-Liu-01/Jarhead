import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_MEMORY_TOKENS, VOICE_MEMORY_TOKENS, type LedgerRow } from "@jarhead/protocol";
import { EXTRACT_MIN_KEVIN_LINES, RETRIEVE_RACE_MS } from "../memory-bridge.ts";
import { FakeMemoryService, delegate, nextUtterance, rows, settle, world, type World } from "./world.ts";

/**
 * The engine's side of durable memory: the voice block rides the session's
 * instructions between `# Language` and `# Continuity`; the brain's block is bounded
 * (tokens and time); extraction runs only at a quiet tick — never while a session is
 * started, opening, paused or waiting on a reconnect, never under
 * EXTRACT_MIN_KEVIN_LINES new Kevin lines, once per closed CONVERSATION (the chain a
 * pause → resume → reconnect makes, whatever its segments hold); the spoken reflexes
 * cost nothing and need their connective; the memory.* verbs round-trip; memory off
 * means no block, no store call, no audio row; nothing on the wire ever carries a vector.
 */

/** A shared CI runner is slower and noisier than a Mac on a desk: its wall-clock ceilings are three times ours. The [measure] lines carry the real numbers either way. */
const RUNNER_SLACK = process.env["GITHUB_ACTIONS"] ? 3 : 1;

const tokens = (s: string): number => Math.ceil(s.length / 3.2);
const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();

/** Kevin says a line and the transcript closes it: the session clock moves past the merge gap and a tick settles it (the ledger's heard row, the memory hook — async, so a beat is waited). */
async function heard(w: World, text: string): Promise<void> {
  const live = w.lives.at(-1)!;
  const s = live.nowMs;
  live.nowMs += 900;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  nextUtterance(w);
  tick(w);
  await settle(1);
}

test("the voice block sits between # Language and # Continuity, within VOICE_MEMORY_TOKENS and without markdown; with memory off there is no block, no store call, no embedding call and no memory.* row", async () => {
  const w = world();
  const { engine, lives, clock } = w;
  const fake = w.memory!;
  fake.voiceText = "# Kevin, in brief\nKevin prefers short answers. Kevin goes by Kev.\nUse this quietly; never announce that you remember it.";
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const text = lives[0]!.config?.instructions ?? "";
    const block = text.slice(text.indexOf("# Kevin, in brief"));
    assert.ok(text.includes(fake.voiceText), "the block as the store rendered it");
    assert.ok(tokens(fake.voiceText) <= VOICE_MEMORY_TOKENS);
    assert.ok(!/[*`]/.test(block), "no markdown in a spoken prompt");
    assert.ok(text.indexOf("# Language") < text.indexOf("# Kevin, in brief"));
    assert.equal(fake.voiceRetrievals, 1);
    assert.equal(engine.snapshot().memory?.budgetUsed?.voice, tokens(fake.voiceText));
    await engine.command({ type: "pause" });
    clock.t += 60_000;
    await engine.command({ type: "resume" });
    const resumed = lives[1]!.config?.instructions ?? "";
    assert.ok(resumed.indexOf("# Kevin, in brief") < resumed.indexOf("# Continuity"), "before the continuity on a resume");
    await engine.command({ type: "stop" });
    // Off: the next session carries no block; the store is not asked; nothing embeds; no audit row.
    engine.updateSettings({ memory: false });
    const embedsBefore = fake.embeds;
    const voiceBefore = fake.voiceRetrievals;
    await engine.wake("test");
    assert.doesNotMatch(lives[2]!.config?.instructions ?? "", /# Kevin, in brief/);
    assert.equal(fake.voiceRetrievals, voiceBefore, "the store was not asked");
    await heard(w, "jarhead remember that I prefer dark mode");
    await heard(w, "and forget that");
    await heard(w, "open safari");
    await heard(w, "close it again");
    await engine.command({ type: "stop" });
    tick(w);
    await settle();
    assert.equal(fake.ingested.length, 0, "no extraction while off");
    assert.equal(fake.embeds, embedsBefore, "no embedding call while off");
    assert.equal(fake.primed.length, 0);
    assert.equal(rows<LedgerRow>(w, "memory.run").length + rows<LedgerRow>(w, "memory.added").length, 0, "no memory.* row while off");
    assert.equal(engine.snapshot().memory?.enabled, false);
    assert.equal(fake.items.length, 0, "the store itself was not touched");
  } finally {
    await engine.stop();
  }
});

test("brainBlock: within BRAIN_MEMORY_TOKENS and absent when the store is empty; the retrieval race is bounded at RETRIEVE_RACE_MS; a final heard line is embedded ahead of the delegation; what was used lands in the snapshot", async () => {
  const w = world();
  const { engine, live } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(await engine.memory.brainBlock("what is on my screen"), undefined, "an empty store gives no block");
    assert.equal(fake.retrievals.length, 1);
    await fake.remember("I prefer dark mode", "preference", "extracted");
    await fake.remember("my dentist is Dr Chen", "contact", "extracted");
    const block = await engine.memory.brainBlock("open the dentist's email");
    assert.ok(block && /Kevin prefers dark mode/.test(block));
    assert.ok(tokens(block!) <= BRAIN_MEMORY_TOKENS);
    assert.deepEqual(engine.snapshot().memory?.lastUsedIds, ["m_1", "m_2"], "the Now rail's 'used this turn'");
    assert.equal(engine.snapshot().memory?.budgetUsed?.brain, tokens(block!));
    assert.equal(engine.snapshot().memory?.count, 2);
    assert.ok(!JSON.stringify(engine.snapshot()).includes('"vec"'), "no vector on the wire");
    // The race: a store that never answers costs the turn at most RETRIEVE_RACE_MS.
    fake.hangRetrieve = true;
    const t0 = Date.now();
    assert.equal(await engine.memory.brainBlock("slow one"), undefined);
    const took = Date.now() - t0;
    assert.ok(took >= RETRIEVE_RACE_MS - 20 && took < RETRIEVE_RACE_MS + 300 * RUNNER_SLACK, `${took} ms (under ${RETRIEVE_RACE_MS + 300 * RUNNER_SLACK})`);
    fake.hangRetrieve = false;
    // Every final Kevin line that is not a reflex is pre-embedded, so the delegation's query is a cache hit.
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await heard(w, "open safari");
    assert.deepEqual(fake.primed, ["open safari"]);
    live.emit("inputTranscript", " and", live.nowMs, live.nowMs + 300);
    assert.equal(fake.primed.length, 1, "an open utterance is not embedded yet");
    // The delegator's hook is wired: the engine hands a memory function to the brain's task builder.
    delegate(w, "jarhead what is on my screen", "item_1");
    await settle();
    assert.equal(w.brain.tasks.length, 1);
  } finally {
    await engine.stop();
  }
});

test("extraction: 0 runs while the fake Live is started, none while connecting, none while paused; the conversation (pause and resume: one chain) is read once at the first quiet tick, the whole chain in one read; a later tick runs nothing more; the memory.run row lands", async () => {
  const w = world();
  const { engine, clock } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    for (const line of ["jarhead open safari", "call me Kev", "I prefer dark mode", "from now on read the diff first", "what time is it"]) await heard(w, line);
    assert.equal(rows<LedgerRow>(w, "heard").length, 5);
    for (let i = 0; i < 5; i++) {
      clock.t += 1000;
      tick(w);
    }
    await settle();
    assert.equal(fake.ingested.length, 0, "never while the session is started");
    assert.equal(engine.snapshot().memory?.pending, 0);
    await engine.command({ type: "pause" });
    assert.equal(engine.snapshot().memory?.pending, 1, "the closed session is queued");
    clock.t += 1000;
    tick(w);
    await settle();
    assert.equal(fake.ingested.length, 0, "never while paused (the conversation is held; a resume would be read again)");
    clock.t += 1000;
    await engine.command({ type: "resume" });
    tick(w);
    await settle();
    assert.equal(fake.ingested.length, 0, "not while the resumed session is up");
    await engine.command({ type: "stop" });
    assert.equal(engine.ledger.chainRootOf("sess_2"), "sess_1", "the resume is the same conversation");
    assert.equal(engine.snapshot().memory?.pending, 1, "one conversation queued, however many sessions closed in it");
    clock.t += 1000;
    tick(w);
    await settle();
    assert.deepEqual(fake.ingested, ["sess_1"], "the conversation, by its chain root, once");
    assert.equal(fake.ingestCalls[0]!.kevinLines, 5, "every Kevin line of the chain in the one read");
    assert.ok(fake.ingestCalls[0]!.rows > engine.ledger.readSession("sess_1").length, "the resumed session's rows ride along (readChain, not readSession)");
    clock.t += 1000;
    tick(w);
    await settle();
    assert.deepEqual(fake.ingested, ["sess_1"], "nothing more was queued");
    assert.equal(engine.snapshot().memory?.pending, 0);
    clock.t += 1000;
    tick(w);
    await settle();
    assert.deepEqual(fake.ingested, ["sess_1"], "nothing pending: nothing runs");
    assert.ok(fake.consolidations >= 1, "a quiet tick with nothing pending consolidates a chunk");
    const runs = rows<Extract<LedgerRow, { type: "memory.run" }>>(w, "memory.run");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.sessionId, "sess_1");
    assert.equal(runs[0]!.added, 1);
    assert.deepEqual(engine.snapshot().memory?.lastRun, { extractor: "rules", added: 1, updated: 0, noop: 0, refused: 0, ms: 3 });
    assert.equal(engine.snapshot().memory?.lastRunAt, clock.t - 2000);
    // The audit row is the record's, not the session's: readSession does not carry it.
    assert.ok(!engine.ledger.readSession("sess_1").some((r) => r.type === "memory.run"));
  } finally {
    await engine.stop();
  }
});

test("extraction: a closed conversation under EXTRACT_MIN_KEVIN_LINES new Kevin lines is not read; a run the embedder cannot serve is deferred and retried at most three times", async () => {
  const w = world();
  const { engine, clock } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    for (let i = 0; i < EXTRACT_MIN_KEVIN_LINES - 1; i++) await heard(w, `line ${i}`);
    await engine.command({ type: "stop" });
    clock.t += 1000;
    tick(w);
    await settle();
    assert.equal(fake.ingested.length, 0, `${EXTRACT_MIN_KEVIN_LINES - 1} lines are under the gate`);
    // Enough lines, but the embedder is down: the service defers (its candidates wait in it) and the
    // bridge asks again at the next quiet ticks until the service lands the run (by words, after its
    // DEFER_MAX_TRIES) — never two runs at once, never a run while a session is up.
    await engine.wake("test");
    for (let i = 0; i < EXTRACT_MIN_KEVIN_LINES; i++) await heard(w, `more ${i}`);
    fake.deferTries = 2;
    clock.t += 1000;
    tick(w);
    await settle();
    assert.equal(fake.ingested.length, 0, "not while the session is started");
    await engine.command({ type: "stop" });
    for (let i = 0; i < 6; i++) {
      clock.t += 1000;
      tick(w);
      await settle();
    }
    assert.deepEqual(fake.ingested, ["sess_2", "sess_2", "sess_2"], "deferred, deferred, landed — then nothing more");
    assert.equal(engine.snapshot().memory?.pending, 0);
    assert.deepEqual(rows<LedgerRow>(w, "memory.run").length, 1, "one run row: the landing");
    // memory.run (Learn now) queues the week's closed conversations forced past the line gate; the store's watermark makes a rerun a skip.
    await engine.command({ type: "memory.run" });
    await settle();
    assert.equal(fake.ingested.length, 4);
    assert.equal(fake.ingestCalls.at(-1)!.opts.force, true, "Kevin pressed it: the gate is skipped");
  } finally {
    await engine.stop();
  }
});

test("spoken reflexes: 'remember that …' adds one item of origin kevin and toasts 'remembered'; 'forget that' tombstones what the last ten minutes learned and toasts; nothing costs a brain turn", async () => {
  const w = world();
  const { engine, events, brain, clock } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    events.length = 0;
    await heard(w, "Jarhead, remember that I prefer dark mode.");
    assert.equal(fake.items.length, 1);
    assert.equal(fake.items[0]!.origin, "kevin");
    assert.equal(fake.items[0]!.text, "Kevin prefers dark mode", "the clause, with its case; the store rewrites the person");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "remembered"));
    assert.equal(engine.snapshot().memory?.count, 1);
    assert.equal(rows<LedgerRow>(w, "memory.added").length, 1);
    assert.equal(brain.tasks.length, 0, "no delegation was needed");
    assert.deepEqual(fake.primed, [], "a reflex line is not embedded as a query");
    // "forget it" is how Kevin says never mind: not a memory verb.
    events.length = 0;
    await heard(w, "forget it");
    assert.equal(fake.forgets.length, 0);
    // "forget that": everything learned in the last ten minutes goes.
    clock.t += 5 * 60_000;
    await heard(w, "jarhead forget that");
    assert.deepEqual(fake.forgets.map((f) => f.ms), [10 * 60_000]);
    assert.equal(fake.forgets[0]!.sessionId, "sess_1");
    assert.equal(fake.items[0]!.state, "forgotten");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "forgot 1 memory"));
    assert.equal(engine.snapshot().memory?.count, 0);
    assert.equal(engine.snapshot().memory?.forgotten, 1);
    assert.equal(rows<LedgerRow>(w, "memory.forgotten").length, 1);
    events.length = 0;
    await heard(w, "forget that");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "nothing recent to forget"));
    // A secret shape is refused by the store; the toast says so and nothing is kept.
    events.length = 0;
    await heard(w, "remember that my password is hunter22");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "not remembered"));
    assert.equal(fake.items.length, 1);
    // The store, its list and the snapshot's memory summary never carry it (the transcript of what Kevin said is another matter: the ledger keeps his words verbatim by design).
    assert.ok(!JSON.stringify(engine.memory.list("all")).includes("hunter22"));
    assert.ok(!JSON.stringify(engine.snapshot().memory).includes("hunter22"));
    assert.ok(!JSON.stringify(engine.ledger.read(clock.t).filter((r) => r.type.startsWith("memory."))).includes("hunter22"), "no memory.* row carries text");
    // "remember to …" is a task and "remember the last time …" a recollection: neither is the verb, so neither is stored nor toasted — they are ordinary lines, embedded ahead of a delegation.
    events.length = 0;
    const kept = fake.items.length;
    await heard(w, "remember to email Ben at five");
    await heard(w, "remember the last time we did this");
    assert.equal(fake.items.length, kept);
    assert.ok(!events.some((e) => e.type === "toast" && /remembered/.test(e.text)), "no toast for a line that is not the verb");
    assert.deepEqual(fake.primed.slice(-2), ["remember to email Ben at five", "remember the last time we did this"]);
    // A line the redactor changes is not embedded either: a key read aloud never reaches the embeddings endpoint.
    const primedBefore = fake.primed.length;
    await heard(w, "the key is sk-test-abcdefghijklmnopqrstuvwxyz0123456789");
    assert.equal(fake.primed.length, primedBefore, "not primed");
    assert.ok(!fake.primed.some((p: string) => p.includes("sk-test-")));
  } finally {
    await engine.stop();
  }
});

test("memory.* commands round-trip: add, forget (a state; Restore brings it back), restore, edit, run — run while a session is up is queued, asleep it reads now; forget and restore work with memory off", async () => {
  const w = world();
  const { engine, events, clock } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    events.length = 0;
    await engine.command({ type: "memory.add", text: "Kevin goes by Kev", kind: "fact" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "remembered"));
    assert.equal(engine.memory.list().length, 1);
    assert.equal(engine.memory.list()[0]!.kind, "fact");
    const id = fake.items[0]!.id;
    events.length = 0;
    await engine.command({ type: "memory.forget", id });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "forgotten · Restore brings it back"));
    assert.equal(engine.snapshot().memory?.forgotten, 1);
    assert.equal(engine.memory.list("forgotten").length, 1);
    assert.equal(engine.memory.list().length, 0);
    events.length = 0;
    await engine.command({ type: "memory.forget", id: "m_nope" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "no such memory"));
    await engine.command({ type: "memory.restore", id });
    assert.equal(engine.snapshot().memory?.count, 1);
    await engine.command({ type: "memory.edit", id, text: "Kevin goes by Kevin", kind: "fact" });
    assert.equal(fake.items[0]!.text, "Kevin goes by Kevin");
    assert.deepEqual((await engine.memory.search("goes by")).map((i) => i.id), [id]);
    assert.deepEqual(rows<LedgerRow>(w, "memory.added").length + rows<LedgerRow>(w, "memory.forgotten").length + rows<LedgerRow>(w, "memory.restored").length + rows<LedgerRow>(w, "memory.updated").length, 4, "one audit row per verb, ids only");
    assert.ok(!JSON.stringify(engine.ledger.read(clock.t).filter((r) => r.type.startsWith("memory."))).includes("Kevin goes by"), "no item text in a day file");
    // Run: while a session is up it is queued; asleep it reads now.
    await engine.wake("test");
    for (let i = 0; i < EXTRACT_MIN_KEVIN_LINES; i++) await heard(w, `line ${i}`);
    events.length = 0;
    await engine.command({ type: "memory.run" });
    assert.ok(events.some((e) => e.type === "toast" && /nothing new to read|queued/.test(e.text)));
    assert.equal(fake.ingested.length, 0, "never while the session is started");
    await engine.command({ type: "stop" });
    events.length = 0;
    await engine.command({ type: "memory.run" });
    await settle();
    assert.deepEqual(fake.ingested, ["sess_1"]);
    assert.ok(events.some((e) => e.type === "toast" && /^learned 1 · updated 0/.test(e.text)));
    // Off: Forget and Restore are Kevin's decisions about what is stored; Add and Run wait for the toggle.
    engine.updateSettings({ memory: false });
    events.length = 0;
    await engine.command({ type: "memory.forget", id });
    assert.equal(fake.items[0]!.state, "forgotten");
    await engine.command({ type: "memory.restore", id });
    assert.equal(fake.items[0]!.state, "live");
    await engine.command({ type: "memory.add", text: "Kevin likes tea" });
    assert.ok(events.some((e) => e.type === "toast" && /memory is off/.test(e.text)));
    assert.equal(fake.items.length, 1);
  } finally {
    await engine.stop();
  }
});

test("extraction: 0 runs inside the reconnect window — the server drops the session, a tick lands before the 500 ms reconnect: the conversation is held, not read; none after the new session starts; once after the whole conversation closed", async () => {
  const w = world();
  const { engine, live, lives, clock } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    for (const line of ["jarhead open safari", "call me Kev", "I prefer dark mode", "from now on read the diff first", "what time is it"]) await heard(w, line);
    live.serverClosed("connection_lost", 42);
    assert.equal(engine.snapshot().memory?.pending, 1, "the closed session queued its conversation");
    clock.t += 100;
    tick(w);
    await settle(1);
    assert.deepEqual(fake.ingested, [], "inside the window the conversation is about to continue: not read");
    await settle(650);
    assert.equal(lives.length, 2, "reconnected");
    assert.equal(lives[1]!.currentState, "started");
    clock.t += 1000;
    tick(w);
    await settle();
    assert.deepEqual(fake.ingested, [], "not while the reconnected session is up");
    await engine.command({ type: "stop" });
    clock.t += 1000;
    tick(w);
    await settle();
    assert.deepEqual(fake.ingested, ["sess_1"], "once, after the whole conversation closed");
    assert.equal(fake.ingestCalls[0]!.kevinLines, 5);
    assert.equal(rows<LedgerRow>(w, "memory.run").length, 1);
  } finally {
    await engine.stop();
  }
});

test("extraction: a conversation held across two pauses (three Kevin lines a segment) is one conversation — read once, all nine lines, at the first quiet tick after the stop; queued again it finds nothing new", async () => {
  const w = world();
  const { engine, clock } = w;
  const fake = w.memory!;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    for (let segment = 0; segment < 3; segment++) {
      if (segment > 0) {
        await engine.command({ type: "pause" });
        clock.t += 1000;
        tick(w);
        await settle();
        assert.deepEqual(fake.ingested, [], `paused after segment ${segment}: held, not read`);
        await engine.command({ type: "resume" });
      }
      for (let i = 0; i < 3; i++) await heard(w, `segment ${segment} line ${i}`);
    }
    assert.equal(rows<LedgerRow>(w, "heard").length, 9);
    assert.equal(engine.ledger.chainRootOf("sess_3"), "sess_1", "three sessions, one conversation");
    await engine.command({ type: "stop" });
    assert.equal(engine.snapshot().memory?.pending, 1, "the conversation is queued once, not per segment");
    for (let i = 0; i < 6; i++) {
      clock.t += 1000;
      tick(w);
      await settle();
    }
    assert.deepEqual(fake.ingested, ["sess_1"], "one run over the whole chain (no segment alone clears the four-line gate)");
    assert.equal(fake.ingestCalls[0]!.kevinLines, 9);
    const runs = rows<Extract<LedgerRow, { type: "memory.run" }>>(w, "memory.run");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.sessionId, "sess_1", "the run row names the conversation");
    // Queued again (a late close, a re-listed session): nothing landed since the watermark, so it is not read.
    engine.memory.sessionClosed("sess_3");
    clock.t += 1000;
    tick(w);
    await settle();
    assert.deepEqual(fake.ingested, ["sess_1"], "a second pass finds nothing new");
    assert.equal(engine.snapshot().memory?.pending, 0);
  } finally {
    await engine.stop();
  }
});

test("a memory store that cannot start (the path is taken): memory reads as off-by-absence — no block, empty lists, the verbs say so — and the engine runs on", async () => {
  // <stateDir>/memory is a file, so the store's first write fails; with no fake injected the bridge builds the real service and catches the failure.
  const dir = mkdtempSync(join(tmpdir(), "jh-engine-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "memory"), "not a directory\n");
  const w = world({ memory: {} }, { dir });
  const { engine, live, events } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.memory.ready();
    assert.equal(w.memory, undefined, "the world handed its own seams");
    await engine.wake("test");
    assert.doesNotMatch(live.config?.instructions ?? "", /# Kevin, in brief/);
    assert.match(live.config?.instructions ?? "", /# Language/);
    assert.equal(await engine.memory.brainBlock("anything"), undefined);
    assert.deepEqual(engine.memory.list(), []);
    assert.deepEqual(await engine.memory.search("x"), []);
    const summary = engine.snapshot().memory!;
    assert.equal(summary.enabled, true);
    assert.equal(summary.count, 0);
    assert.equal(summary.pending, 0);
    events.length = 0;
    await engine.command({ type: "memory.run" });
    assert.ok(events.some((e) => e.type === "toast" && /memory is not available/.test(e.text)));
  } finally {
    await engine.stop();
  }
});

test("FakeMemoryService itself: a remember counts as one embedding call and a twin is a noop, forgetRecent honours the window, list filters by state", async () => {
  let t = 1_000_000;
  const fake = new FakeMemoryService(() => t);
  assert.equal((await fake.remember("I like tea"))?.op, "added");
  assert.equal((await fake.remember("I like tea"))?.op, "noop");
  assert.equal(fake.embeds, 2);
  t += 11 * 60_000;
  assert.equal(fake.forgetRecent(10 * 60_000), 0, "older than the window");
  assert.ok(await fake.remember("I like coffee"));
  assert.equal(fake.forgetRecent(10 * 60_000), 1);
  assert.equal(fake.list().length, 1);
  assert.equal(fake.list("forgotten").length, 1);
  assert.equal(fake.list("all").length, 2);
  assert.equal(await fake.remember("my password is hunter22"), undefined, "a secret shape is refused");
});
