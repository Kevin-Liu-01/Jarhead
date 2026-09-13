import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTranscript, EngineEvent } from "@jarhead/protocol";
import type { TranscriptPage } from "@jarhead/agents";
import { FakeConnector, fakeAgent, fakeMessage, settle, until, world } from "./world.ts";

/**
 * Agent conversations over the long horizon (Kevin: "threads don't break after a
 * while … some remain open with a flashing indicator"). Opens are per viewer, so a
 * re-open after a reconnect never double-counts and a client that dies takes its
 * tails with it; a tail that ends says so — `gone` → live:false plus the calls left
 * running as `interrupted`, `replaced` → the page read again and followed on; an agent
 * whose process is gone (status `ended`) has its running calls settled once; older
 * pages arrive as `prepend`, asked for by byte offset; a clean shutdown tells every
 * open pane live:false first.
 */

const ID = "sessions:codex:abc";

const page = (messages: ReturnType<typeof fakeMessage>[], extra: Partial<TranscriptPage> = {}): TranscriptPage => ({ messages, total: 40, complete: false, cursor: { startOffset: 4096, endOffset: 9000 }, ...extra });

const transcripts = (events: EngineEvent[]): Extract<EngineEvent, { type: "agent.transcript" }>[] => events.filter((e): e is Extract<EngineEvent, { type: "agent.transcript" }> => e.type === "agent.transcript");

function connector(): FakeConnector {
  const fake = new FakeConnector();
  fake.agents = [fakeAgent(ID, "working")];
  fake.pages.set(ID, page([fakeMessage("m1", "user", "make the hero font DM Sans"), fakeMessage("m2", "tool", "", { name: "shell", input: "ls", status: "running" })]));
  return fake;
}

test("agent.open twice from one viewer keeps one tail and re-sends the page (a pane re-opens after a reconnect); close from that viewer ends it; two viewers need two closes; an open without a token counts as before", async () => {
  const fake = connector();
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    assert.ok(await until(() => engine.snapshot().agents.length === 1), "the fake connector is listed");
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    assert.equal(fake.liveTails(ID).length, 1, "one tail however often the same pane opens");
    const replaces = transcripts(events).filter((e) => e.mode === "replace");
    assert.equal(replaces.length, 2, "each open answers with the newest page (the pane wants it again after a reconnect)");
    assert.equal(replaces[0]!.transcript.live, true);
    assert.deepEqual(replaces[0]!.transcript.cursor, { startOffset: 4096, endOffset: 9000 }, "the page's byte span rides along");
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c2/p7" });
    assert.equal(fake.liveTails(ID).length, 1, "a second viewer shares the tail");
    await engine.command({ type: "agent.close", agentId: ID, viewer: "c1/p1" });
    assert.equal(fake.liveTails(ID).length, 1, "the other viewer still follows");
    await engine.command({ type: "agent.close", agentId: ID, viewer: "c2/p7" });
    assert.equal(fake.liveTails(ID).length, 0, "the last viewer gone: the tail ends");
    // A delta after the close reaches nobody (the tail is stopped; nothing is emitted for a closed conversation).
    events.length = 0;
    fake.emitDelta(ID, [fakeMessage("m3", "assistant", "done")]);
    assert.equal(transcripts(events).length, 0);
    // The old counting behaviour for a surface that sends no token: two opens, two closes.
    await engine.command({ type: "agent.open", agentId: ID });
    await engine.command({ type: "agent.open", agentId: ID });
    assert.equal(fake.liveTails(ID).length, 1);
    await engine.command({ type: "agent.close", agentId: ID });
    assert.equal(fake.liveTails(ID).length, 1, "one anonymous viewer left");
    await engine.command({ type: "agent.close", agentId: ID });
    assert.equal(fake.liveTails(ID).length, 0);
  } finally {
    await engine.stop();
  }
});

test("dropViewers closes the tails of one client's panes and leaves another's; deltas keep flowing to the one that stayed", async () => {
  const fake = connector();
  const other = "sessions:claude:def";
  fake.agents.push(fakeAgent(other, "idle"));
  fake.pages.set(other, page([fakeMessage("k1", "user", "hi")]));
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c2/p2" });
    await engine.command({ type: "agent.open", agentId: other, viewer: "c1/p3" });
    assert.equal(fake.liveTails().length, 2);
    engine.dropViewers("c1");
    assert.equal(fake.liveTails(other).length, 0, "the conversation only c1 showed is closed");
    assert.equal(fake.liveTails(ID).length, 1, "c2 still follows the shared one");
    events.length = 0;
    fake.emitDelta(ID, [fakeMessage("m3", "assistant", "done")], 41);
    const appends = transcripts(events).filter((e) => e.mode === "append");
    assert.equal(appends.length, 1);
    assert.equal(appends[0]!.transcript.live, true);
    assert.equal(appends[0]!.transcript.total, 41);
    engine.dropViewers("c2");
    assert.equal(fake.liveTails().length, 0);
  } finally {
    await engine.stop();
  }
});

test("closeConversations (the engine stopping) emits live:false for every open conversation before the tails close", async () => {
  const fake = connector();
  const other = "sessions:claude:def";
  fake.agents.push(fakeAgent(other, "idle"));
  fake.pages.set(other, page([fakeMessage("k1", "user", "hi")], { total: 7 }));
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  await engine.start();
  await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
  await engine.command({ type: "agent.open", agentId: other, viewer: "c1/p2" });
  events.length = 0;
  await engine.stop();
  const ends = transcripts(events).filter((e) => e.mode === "append" && e.transcript.live === false);
  assert.deepEqual(ends.map((e) => e.transcript.agentId).sort(), [other, ID].sort());
  assert.deepEqual(ends.map((e) => e.transcript.messages.length), [0, 0]);
  assert.equal(ends.find((e) => e.transcript.agentId === other)?.transcript.total, 7, "the total the pane knows is kept");
  assert.equal(fake.liveTails().length, 0);
});

test("a tail ending gone emits live:false plus the interrupted calls; a tail ending replaced re-reads the page (mode replace) and follows on with the viewers untouched", async () => {
  const fake = connector();
  fake.interrupted.set(ID, [fakeMessage("m2", "tool", "", { name: "shell", input: "ls", status: "interrupted" })]);
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    events.length = 0;
    fake.endTail(ID, "gone");
    assert.ok(await until(() => transcripts(events).some((e) => e.transcript.live === false)), "live:false reaches the pane");
    const end = transcripts(events).find((e) => e.transcript.live === false)!;
    assert.equal(end.mode, "append");
    assert.equal(end.transcript.messages[0]?.tool?.status, "interrupted", "the call the process left running is interrupted in the same delta");
    assert.equal(fake.liveTails(ID).length, 0);
    // Replaced: the file was rewritten under the tail — read again, follow on.
    fake.pages.set(ID, page([fakeMessage("n1", "user", "fresh file")], { total: 1, complete: true, cursor: { startOffset: 0, endOffset: 100 } }));
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    assert.equal(fake.liveTails(ID).length, 1);
    events.length = 0;
    fake.endTail(ID, "replaced");
    assert.ok(await until(() => transcripts(events).some((e) => e.mode === "replace")), "a new page");
    const again = transcripts(events).find((e) => e.mode === "replace")!;
    assert.equal(again.transcript.messages[0]?.id, "n1");
    assert.equal(again.transcript.live, true, "followed on");
    assert.equal(again.transcript.complete, true);
    assert.equal(fake.liveTails(ID).length, 1, "one live tail after the re-read");
    assert.ok(!transcripts(events).some((e) => e.transcript.live === false), "a replaced file is not a gone one");
  } finally {
    await engine.stop();
  }
});

test("a tail that cannot start: the page says live:false and no tail is kept; then exactly one append (live:false, the interrupted calls) — never a second live:false for the same ending; a later close is harmless", async () => {
  const fake = connector();
  fake.failWatch.add(ID);
  fake.interrupted.set(ID, [fakeMessage("m2", "tool", "", { name: "shell", input: "ls", status: "interrupted" })]);
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    await settle();
    const all = transcripts(events);
    const replaces = all.filter((e) => e.mode === "replace");
    assert.equal(replaces.length, 1);
    assert.equal(replaces[0]!.transcript.live, false);
    const ends = all.filter((e) => e.mode === "append" && e.transcript.live === false);
    assert.equal(ends.length, 1, "one live:false append per ending");
    assert.equal(ends[0]!.transcript.messages[0]?.tool?.status, "interrupted", "what the process left running, settled once");
    assert.ok(all.indexOf(replaces[0]!) < all.indexOf(ends[0]!), "the page first, then what it left running");
    assert.equal(fake.settles, 1);
    assert.equal(fake.liveTails(ID).length, 0);
    events.length = 0;
    await engine.command({ type: "agent.close", agentId: ID, viewer: "c1/p1" });
    await settle();
    assert.equal(transcripts(events).length, 0, "a close emits nothing more");
  } finally {
    await engine.stop();
  }
});

test("an open conversation whose agent turns ended has its running calls flipped to interrupted in one append — once, not on every poll", async () => {
  const fake = connector();
  fake.interrupted.set(ID, [fakeMessage("m2", "tool", "", { name: "shell", input: "ls", status: "interrupted" })]);
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    assert.ok(await until(() => engine.snapshot().agents.length === 1));
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    events.length = 0;
    fake.change(fakeAgent(ID, "idle"));
    await settle();
    assert.equal(transcripts(events).length, 0, "idle settles nothing");
    fake.change(fakeAgent(ID, "ended", { hint: "ended" }));
    assert.ok(await until(() => transcripts(events).length === 1), "one append");
    const delta = transcripts(events)[0]!;
    assert.equal(delta.mode, "append");
    assert.equal(delta.transcript.messages[0]?.tool?.status, "interrupted");
    assert.equal(delta.transcript.live, true, "the tail is still attached (the file may still be read); the app derives 'live' from the status");
    assert.equal(engine.snapshot().agents[0]?.status, "ended");
    fake.change(fakeAgent(ID, "ended", { hint: "ended", updatedAt: 2 }));
    await settle();
    assert.equal(transcripts(events).length, 1, "a second poll saying ended again settles nothing more");
    assert.equal(fake.settles, 1);
  } finally {
    await engine.stop();
  }
});

test("agent.history emits mode prepend with the page's complete and asks the connector by byte offset from the newest page's start", async () => {
  const fake = connector();
  fake.history.set(ID, page([fakeMessage("h1", "user", "first words"), fakeMessage("h2", "assistant", "hello")], { complete: true, cursor: { startOffset: 0, endOffset: 4096 } }));
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    events.length = 0;
    await engine.command({ type: "agent.history", agentId: ID, before: "m1" });
    const older = transcripts(events);
    assert.equal(older.length, 1);
    assert.equal(older[0]!.mode, "prepend");
    assert.equal(older[0]!.transcript.complete, true);
    assert.equal(older[0]!.transcript.live, true, "still following");
    assert.deepEqual(older[0]!.transcript.messages.map((m) => m.id), ["h1", "h2"]);
    const ask = fake.transcriptCalls.at(-1)!;
    assert.equal(ask.opts?.before, "m1");
    assert.equal(ask.opts?.beforeOffset, 4096, "the newest page began at byte 4096: read backward from there, never from the file's end");
    // A second Load earlier starts from where the older page began.
    fake.history.set(ID, page([], { complete: true, cursor: { startOffset: 0, endOffset: 0 } }));
    await engine.command({ type: "agent.history", agentId: ID, before: "h1" });
    assert.equal(fake.transcriptCalls.at(-1)!.opts?.beforeOffset, 0);
    // History on a conversation nobody opened: no offset to give, the page is not live.
    events.length = 0;
    await engine.command({ type: "agent.close", agentId: ID, viewer: "c1/p1" });
    await engine.command({ type: "agent.history", agentId: ID, before: "m1" });
    const closedPage = transcripts(events).find((e) => e.mode === "prepend") as { transcript: AgentTranscript } | undefined;
    assert.equal(closedPage?.transcript.live, false);
    assert.equal(fake.transcriptCalls.at(-1)!.opts?.beforeOffset, undefined);
  } finally {
    await engine.stop();
  }
});

test("Load earlier after the pane's trim: a `before` that arrived as an append is asked by id alone (no beforeOffset — the connector gives the offset precedence, and the page start would skip the span between); only the first message of the served range uses the offset, and that range grows backward only when a page reaches below it", async () => {
  const fake = connector();
  const w = world({ connectors: [fake] });
  const { engine, events } = w;
  try {
    await engine.start();
    await engine.command({ type: "agent.open", agentId: ID, viewer: "c1/p1" });
    // The tail appends m3, m4; the pane trims m1, m2 away (its 400-message cap) and its oldest is m3.
    fake.emitDelta(ID, [fakeMessage("m3", "assistant", "on it"), fakeMessage("m4", "user", "thanks")], 42);
    events.length = 0;
    // The connector resolves m3 by id and answers the span the pane lost: m1, m2 from the same page start.
    fake.history.set(ID, page([fakeMessage("m1", "user", "make the hero font DM Sans"), fakeMessage("m2", "tool", "", { name: "shell", input: "ls", status: "running" })], { cursor: { startOffset: 4096, endOffset: 9000 } }));
    await engine.command({ type: "agent.history", agentId: ID, before: "m3" });
    let ask = fake.transcriptCalls.at(-1)!;
    assert.equal(ask.opts?.before, "m3");
    assert.equal(ask.opts?.beforeOffset, undefined, "m3 sits after the page start: reading backward from byte 4096 would skip m1 and m2");
    assert.equal(transcripts(events)[0]!.mode, "prepend");
    assert.deepEqual(transcripts(events)[0]!.transcript.messages.map((m) => m.id), ["m1", "m2"]);
    // The range's first message is still m1: before m1 → the page's offset.
    fake.history.set(ID, page([fakeMessage("h1", "user", "first words"), fakeMessage("h2", "assistant", "hello")], { cursor: { startOffset: 2048, endOffset: 4096 } }));
    await engine.command({ type: "agent.history", agentId: ID, before: "m1" });
    ask = fake.transcriptCalls.at(-1)!;
    assert.equal(ask.opts?.beforeOffset, 4096, "the first message of what was served: by offset");
    // That page reached below the range: h1 is now its first message. before h1 → 2048; before h2 (inside the range) → by id.
    await engine.command({ type: "agent.history", agentId: ID, before: "h1" });
    assert.equal(fake.transcriptCalls.at(-1)!.opts?.beforeOffset, 2048);
    await engine.command({ type: "agent.history", agentId: ID, before: "h2" });
    assert.equal(fake.transcriptCalls.at(-1)!.opts?.beforeOffset, undefined, "not the first message: the connector resolves it");
    // A gap fill that does not reach below the range leaves its start where it was.
    fake.history.set(ID, page([fakeMessage("m0", "user", "between")], { cursor: { startOffset: 3000, endOffset: 4096 } }));
    await engine.command({ type: "agent.history", agentId: ID, before: "m1" });
    await engine.command({ type: "agent.history", agentId: ID, before: "h1" });
    assert.equal(fake.transcriptCalls.at(-1)!.opts?.beforeOffset, 2048, "h1 is still the first message served; its offset did not move");
  } finally {
    await engine.stop();
  }
});
