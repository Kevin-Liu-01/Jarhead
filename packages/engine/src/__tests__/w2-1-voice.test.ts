/**
 * W2-1, the voice session's engine half (launch triage), adopted from the audit's reproductions:
 *
 * - V3: a Live socket that goes silent (no frame, no close) is noticed within LIVE_SILENCE_MS and takes the path a
 *   real drop takes: the row, one new session that carries the conversation on.
 * - V5: a long typed line reaches Live in appends that each fit the 500-token cap, then one short line to answer.
 * - V6: typed while paused and the resume fails, the words are "not sent" and the conversation is still paused;
 *   typed during a handshake, the line waits for its session.
 * - V11: `response_input_buffer_full` is a per-session cap, read from its code; its one press reopens the session, and
 *   the row does not clear itself while the cap still holds. Pressed while a task runs, it cancels nothing: the
 *   session reopens once the task is done.
 *
 * Temp state dir, no network, no audio: the sessions are FakeLive, or a real LiveSession over a fake socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPEND_CHAR_BUDGET, LiveSession, estimateTokens, type SessionConfig, type WebSocketLike } from "@jarhead/live";
import type { Brain } from "@jarhead/brain";
import type { EngineEvent } from "@jarhead/protocol";
import { Engine, splitTyped, typedTokens } from "../engine.ts";
import { FakeLive, current, delegate, rows, settle, until, world } from "./world.ts";

const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
const toasts = (events: readonly EngineEvent[]): string[] => events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast").map((e) => e.text);

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;
  send(data: string): void {
    this.sent.push(data);
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
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}
const resource = (id: string) => ({ id, expires_at: Math.floor(Date.now() / 1000) + 3600, model: "gpt-live-1", status: "active" as const });
const silence = Buffer.alloc(4800).toString("base64");

/** A world whose sessions are real LiveSessions over fake sockets, one socket per session. */
function socketWorld(): { w: ReturnType<typeof world>; socks: FakeSocket[] } {
  const socks: FakeSocket[] = [];
  const makeLive = (config: SessionConfig): LiveSession => {
    const sock = new FakeSocket();
    socks.push(sock);
    return new LiveSession({ apiKey: "k", config, webSocketFactory: () => sock });
  };
  return { w: world({ makeLive }), socks };
}

test("V3 (audit repro): a Live socket that goes silent is dropped as connection_lost within LIVE_SILENCE_MS, and one new session carries the conversation on", async () => {
  const { w, socks } = socketWorld();
  const { engine, clock, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    const waking = engine.wake("test");
    await settle();
    socks[0]!.open();
    socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
    await waking;
    // A healthy session streams output audio continuously, silence included: a second of it.
    for (let i = 0; i < 10; i++) socks[0]!.receive({ type: "session.output_audio.delta", delta: silence });
    // Then the network drops silently: nothing more arrives, no close. Kevin keeps talking (mic frames go out).
    let droppedAfter = 0;
    for (let s = 1; s <= 60 && !socks[0]!.closed; s++) {
      clock.t += 1000;
      engine.feedMic(Buffer.alloc(960, 1));
      tick(engine);
      droppedAfter = s;
    }
    assert.ok(socks[0]!.closed, "60 s of a silent socket was never noticed");
    assert.ok(droppedAfter <= Math.ceil(Engine.LIVE_SILENCE_MS / 1000) + 1, `dropped after ${droppedAfter} s`);
    assert.ok(toasts(events).includes("connection lost; reconnecting"), JSON.stringify(toasts(events)));
    assert.ok(engine.typedProblems().some((p) => p.kind === "voice.connection" && p.text.startsWith("connection lost")));
    // The reconnect: one new socket, the conversation carried on from the dropped session.
    assert.ok(await until(() => socks.length === 2), "no reconnect");
    socks[1]!.open();
    socks[1]!.receive({ type: "session.started", event_id: "e2", session: resource("live_2") });
    assert.ok(await until(() => engine.transportState === "awake" && engine.snapshot().session?.id === "live_2"));
    const started = rows<{ type: string; sessionId: string; resumedFrom?: string }>(w, "session.started");
    assert.deepEqual(started.map((r) => [r.sessionId, r.resumedFrom]), [["live_1", undefined], ["live_2", "live_1"]]);
    const closed = rows<{ type: string; sessionId: string; reason: string }>(w, "session.closed");
    assert.deepEqual(closed.map((r) => [r.sessionId, r.reason]), [["live_1", "connection_lost"]]);
  } finally {
    await engine.stop();
  }
});

test("V3: a session whose server keeps sending (silence frames, once a second) is never dropped", async () => {
  const { w, socks } = socketWorld();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    const waking = engine.wake("test");
    await settle();
    socks[0]!.open();
    socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
    await waking;
    for (let s = 0; s < 60; s++) {
      socks[0]!.receive({ type: "session.output_audio.delta", delta: silence });
      clock.t += 1000;
      tick(engine);
    }
    assert.equal(socks[0]!.closed, false);
    assert.equal(socks.length, 1);
    assert.equal(engine.transportState, "awake");
  } finally {
    await engine.stop();
  }
});

test("V3 (review): a tick that runs late after the event loop stalled starts the watch over; the frames queued meanwhile are read on the next tick, and a socket that stays silent is still dropped", async () => {
  const { w, socks } = socketWorld();
  const { engine, clock } = w;
  // A stalled loop, simulated on the process's own clock: the stall moves performance.now(), not the session's frames.
  const realNow = performance.now.bind(performance);
  let stall = 0;
  performance.now = () => realNow() + stall;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    const waking = engine.wake("test");
    await settle();
    socks[0]!.open();
    socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
    await waking;
    socks[0]!.receive({ type: "session.output_audio.delta", delta: silence });
    tick(engine);
    // A 6 s synchronous block (a long search): the timer fires before the socket messages that queued meanwhile.
    stall += 6000;
    clock.t += 6000;
    tick(engine);
    assert.equal(socks[0]!.closed, false, "a stalled loop read as a dead socket");
    // The queued frames are read, and the next tick is on time.
    for (let i = 0; i < 5; i++) socks[0]!.receive({ type: "session.output_audio.delta", delta: silence });
    clock.t += 1000;
    tick(engine);
    assert.equal(socks[0]!.closed, false);
    // Then the socket really goes silent: on-time ticks still notice it within LIVE_SILENCE_MS.
    let droppedAfter = 0;
    for (let s = 1; s <= 30 && !socks[0]!.closed; s++) {
      clock.t += 1000;
      tick(engine);
      droppedAfter = s;
    }
    assert.ok(socks[0]!.closed, "a silent socket was never noticed after the stall");
    assert.ok(droppedAfter <= Math.ceil(Engine.LIVE_SILENCE_MS / 1000) + 1, `dropped after ${droppedAfter} s`);
  } finally {
    performance.now = realNow;
    await engine.stop();
  }
});

test("V5 (audit repro): a long typed line reaches Live in parts that each fit the 500-token cap, then one short line that says to answer", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const paste = "Here is the paragraph from the doc I want you to summarise for me. ".repeat(40).trim(); // ~2.7k chars
    await engine.sayText(paste);
    const appended = current(w).instructions.filter((i) => i.includes("just typed"));
    assert.ok(appended.length >= 3, `${appended.length} appends`);
    for (const a of appended) assert.ok(estimateTokens(a) <= 500, `an append of ~${estimateTokens(a)} tokens`);
    for (const a of appended) assert.ok(a.length <= APPEND_CHAR_BUDGET, `an append of ${a.length} chars`);
    // Every word arrives, in order; the last append is the one that asks for the answer.
    const parts = appended.slice(0, -1).map((a) => /: "(.*)"$/s.exec(a)?.[1] ?? "");
    assert.equal(parts.join(" "), paste);
    assert.match(appended[0]!, /^Kevin just typed a long message, part 1 of \d+\. Read it and do not answer yet: "/);
    assert.match(appended.at(-1)!, /^That was all of what Kevin just typed, in \d+ parts\. Treat it exactly like speech\. Respond to it now/);
    // A short line is still one append, as before.
    await engine.sayText("what time is it in Tokyo");
    assert.equal(current(w).instructions.at(-1), 'Kevin just typed (treat it exactly like speech): "what time is it in Tokyo". Respond to it now; delegate if it asks for anything the backend does.');
  } finally {
    await engine.stop();
  }
});

test("V5 (review): a long paste keeps its line breaks; a CJK paste is split by what its script costs; text that fits one part is not 'part 1 of 1'", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // A list and a code block: every line arrives as typed, on its own line.
    const lines = Array.from({ length: 119 }, (_, i) => (i % 10 === 9 ? "" : `${i + 1}. buy item number ${i + 1} from the list`));
    const list = lines.join("\n");
    await engine.sayText(list);
    const appended = current(w).instructions.filter((i) => i.includes("just typed"));
    assert.ok(appended.length >= 3, `${appended.length} appends`);
    const parts = appended.slice(0, -1).map((a) => /: "([\s\S]*)"$/.exec(a)?.[1] ?? "");
    assert.ok(parts.every((p) => p.includes("\n")), "a part lost its line breaks");
    assert.equal(parts.join("\n").replace(/\n+/g, "\n"), list.replace(/\n+/g, "\n"), "every line arrives, in order");
    for (const a of appended) assert.ok(typedTokens(a) <= Engine.APPEND_TOKENS, `an append of ~${typedTokens(a)} tokens`);
    // A CJK paste: about 2.4k characters, which the old character budget sent as two ~1.4k-token appends.
    const cjk = "这是我想让你帮我总结的文档中的一段话。".repeat(130);
    const before = current(w).instructions.length;
    await engine.sayText(cjk);
    const cjkAppends = current(w).instructions.slice(before);
    assert.ok(cjkAppends.length >= 8, `${cjkAppends.length} appends`);
    for (const a of cjkAppends) {
      const cjkChars = [...a].filter((c) => c.codePointAt(0)! >= 0x3000).length;
      assert.ok(cjkChars <= 320, `an append with ${cjkChars} CJK characters`);
      assert.ok(typedTokens(a) <= Engine.APPEND_TOKENS, `an append of ~${typedTokens(a)} tokens`);
    }
    assert.equal(cjkAppends.slice(0, -1).map((a) => /: "([\s\S]*)"$/.exec(a)?.[1] ?? "").join(""), cjk);
  } finally {
    await engine.stop();
  }
  // Long only because of what Jarhead answered: one part, said without "part 1 of 1" or "in 1 parts".
  const answer = `Here is the status: ${"thread one is still working on the slides. ".repeat(60)}`;
  const respond = `Jarhead already answered it: "${answer}" Say that to Kevin, in these words, and wait.`;
  const one = Engine.typedAppends("Kevin", "how is everything going", respond);
  assert.equal(one.length, 2);
  assert.equal(one[0], 'Kevin just typed a long message. Read it and do not answer yet: "how is everything going"');
  assert.match(one[1]!, /^That was all of what Kevin just typed\. Treat it exactly like speech\. Jarhead already answered it/);
  assert.ok(!one.some((a) => /part 1 of 1|in 1 parts/.test(a)));
  // A short line is still one append.
  assert.deepEqual(Engine.typedAppends("Kevin", "hi", "Respond to it now."), ['Kevin just typed (treat it exactly like speech): "hi". Respond to it now.']);
});

test("V5: splitTyped keeps every character in order and cuts at paragraphs, then lines, then sentences, then characters", () => {
  const para = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of a paragraph.`).join("\n");
  const text = [para(20), para(20), para(20)].join("\n\n");
  const parts = splitTyped(text, 200);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(typedTokens(p) <= 200, `a part of ${typedTokens(p)} tokens`);
  assert.equal(parts.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));
  assert.ok(!parts[0]!.startsWith("\n") && !parts.some((p) => /\s$/.test(p)), "no part starts or ends on whitespace");
  // One huge line with no punctuation is cut between characters, never lost.
  const run = "x".repeat(5000);
  const cut = splitTyped(run, 100);
  assert.equal(cut.join(""), run);
  for (const p of cut) assert.ok(typedTokens(p) <= 100);
  // Emoji are never split in half.
  const emoji = "🙂".repeat(400);
  assert.equal(splitTyped(emoji, 50).join(""), emoji);
});

test("V6 (audit repro): typed while paused and the resume fails: 'not sent · could not resume, still paused', and the conversation is still held", async () => {
  const w = world();
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await engine.command({ type: "pause" });
    assert.equal(engine.transportState, "paused");
    // The network is down: the resume's socket closes before session.started.
    const next = new FakeLive("sess_2");
    next.failStart = true;
    w.lives.push(next);
    await engine.sayText("are you there");
    await settle(20);
    assert.equal(engine.transportState, "paused", "the conversation is still held");
    assert.ok(!toasts(events).includes("asleep — press Go"), "a paused Jarhead is not asleep");
    assert.equal(toasts(events).at(-1), "not sent · could not resume, still paused");
  } finally {
    await engine.stop();
  }
});

test("V6: a line typed during a handshake waits for its session and reaches it, never 'asleep — press Go'", async () => {
  let ready!: () => void;
  const brain: Brain = {
    kind: "fake",
    // The brain is still proving itself: Go's connect waits on it, with no session yet.
    start: () => new Promise((resolve) => (ready = () => resolve({ ready: true, detail: "fake" }))),
    handle: async () => ({ status: "done", summary: "done." }),
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const w = world({ brain });
  const { engine, events } = w;
  try {
    await engine.start();
    const waking = engine.wake("test");
    assert.equal(engine.transportState, "connecting");
    const typing = engine.sayText("open my calendar");
    await settle(20);
    ready();
    await waking;
    await typing;
    assert.ok(!toasts(events).some((t) => /asleep|not sent/.test(t)), JSON.stringify(toasts(events)));
    assert.ok(current(w).instructions.some((i) => i.includes('"open my calendar"')), JSON.stringify(current(w).instructions));
  } finally {
    await engine.stop();
  }
});

test("V11 (audit repro): response_input_buffer_full is a per-session cap; its row stays while the cap holds and its one press reopens the session with the conversation", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    current(w).emit("error", new Error("response_input_buffer_full: Backend response input history is limited to 128 items and 32768 UTF-8 bytes per session."), "item_49");
    const row = engine.typedProblems().find((p) => p.text.includes("response_input_buffer_full"));
    assert.equal(row?.kind, "voice.limit");
    assert.deepEqual(row?.remedy, { label: "Reopen", command: { type: "problem.retry", kind: "voice.limit" } });
    // Waiting does not clear a per-session cap: the row stays past the 30 s a passing limit gets.
    clock.t += Engine.VOICE_LIMIT_CLEAR_MS + 1000;
    tick(engine);
    assert.ok(engine.typedProblems().some((p) => p.text.includes("response_input_buffer_full")), "the row cleared itself while the cap still holds");
    // Kevin presses Reopen: a new session, resumed from the full one.
    await engine.retryProblem("voice.limit");
    assert.equal(w.lives.length, 2);
    assert.equal(engine.snapshot().session?.id, "sess_2");
    assert.equal(engine.transportState, "awake");
    const started = rows<{ type: string; sessionId: string; resumedFrom?: string }>(w, "session.started");
    assert.equal(started.at(-1)?.resumedFrom, "sess_1");
    assert.equal(engine.typedProblems().filter((p) => p.kind === "voice.limit").length, 0);
  } finally {
    await engine.stop();
  }
});

test("V11: a cap that passes (a rate limit) keeps its 'Retry in 30 s' and clears itself; its press opens nothing", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    current(w).emit("error", new Error("rate_limit_exceeded: Too many requests"), undefined);
    assert.deepEqual(engine.typedProblems().find((p) => p.kind === "voice.limit")?.remedy, { label: "Retry in 30 s", command: { type: "problem.retry", kind: "voice.limit" } });
    await engine.retryProblem("voice.limit");
    assert.equal(w.lives.length, 1);
    current(w).emit("error", new Error("rate_limit_exceeded: Too many requests"), undefined);
    clock.t += Engine.VOICE_LIMIT_CLEAR_MS + 1000;
    tick(engine);
    assert.equal(engine.typedProblems().filter((p) => p.kind === "voice.limit").length, 0);
  } finally {
    await engine.stop();
  }
});

const REOPEN = { label: "Reopen", command: { type: "problem.retry", kind: "voice.limit" } };

test("V11: Reopen pressed while a task runs cancels nothing; the row stays, and the session reopens with the conversation once the task is done", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead summarize my inbox", "item_1");
    assert.ok(await until(() => w.brain.tasks.length === 1));
    current(w).emit("error", new Error("response_input_buffer_full: Backend response input history is limited to 128 items and 32768 UTF-8 bytes per session."), "item_2");
    await engine.retryProblem("voice.limit");
    await settle(50);
    assert.equal(w.brain.tasks[0]!.signal.aborted, false, "the running task was not cancelled");
    assert.equal(w.brain.cancels, 0);
    assert.equal(w.lives.length, 1, "no reopen while the task runs");
    assert.ok(toasts(w.events).includes("busy · reopens when the task is done"), JSON.stringify(toasts(w.events)));
    assert.deepEqual(engine.typedProblems().find((p) => p.kind === "voice.limit")?.remedy, REOPEN, "the row stays while the cap holds");
    tick(engine);
    await settle(20);
    assert.equal(w.lives.length, 1, "a tick while the task runs opens nothing");
    // The task is done: a tick reopens the session, resumed from the full one.
    w.brain.resolve!({ status: "done", summary: "three new emails." });
    assert.ok(
      await until(() => {
        tick(engine);
        return w.lives.length === 2 && engine.transportState === "awake";
      }),
      `sessions: ${w.lives.length}, transport: ${engine.transportState}`,
    );
    const started = rows<{ type: string; sessionId: string; resumedFrom?: string }>(w, "session.started");
    assert.equal(started.at(-1)?.resumedFrom, "sess_1");
    assert.equal(engine.typedProblems().filter((p) => p.kind === "voice.limit").length, 0);
  } finally {
    await engine.stop();
  }
});

test("V11: the session cap is read from its code, so a truncated line still gets Reopen; any cap the server says is per-session does too; a new session clears them", async () => {
  const w = world();
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    current(w).emit("error", new Error("response_input_buffer_full: Backend response input history is limited to 128 items"), "item_9");
    current(w).emit("error", new Error("context_window: this conversation has reached its per-session token budget"), "item_10");
    const limits = engine.typedProblems().filter((p) => p.kind === "voice.limit");
    assert.equal(limits.length, 2, JSON.stringify(limits));
    for (const row of limits) assert.deepEqual(row.remedy, REOPEN, row.text);
    clock.t += Engine.VOICE_LIMIT_CLEAR_MS + 1000;
    tick(engine);
    assert.equal(engine.typedProblems().filter((p) => p.kind === "voice.limit").length, 2, "neither clears itself");
    // The server drops the session: the new one starts with an empty buffer, so the rows go with the old one.
    (current(w) as FakeLive).serverClosed("connection_lost", 5);
    assert.ok(await until(() => w.lives.length === 2 && engine.transportState === "awake", 3000));
    assert.equal(engine.typedProblems().filter((p) => p.kind === "voice.limit").length, 0, JSON.stringify(engine.typedProblems()));
  } finally {
    await engine.stop();
  }
});
