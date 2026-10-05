import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { KeywordEmbedder, MemoryService, RulesExtractor } from "@jarhead/memory";
import { MemoryBridge, type MemoryBridgeOptions } from "../memory-bridge.ts";
import { delegate, nextUtterance, settle, world, type World } from "./world.ts";

/**
 * W2-3 on the engine's side of memory: memory off means no embedding call, the Memory rail's
 * filter included (LM-3); a filter the redactor changes is matched by words; and Move to Trash
 * hides what memory learned only from that conversation until Restore brings it back (D5).
 */

/** A recording fetch that answers like the embeddings endpoint; nothing leaves the Mac. */
function recording(): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: Array.from({ length: 512 }, (_v, i) => (i === index ? 1 : 0)) })) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function bridge(over: Partial<MemoryBridgeOptions> & { fetchImpl: typeof fetch }): MemoryBridge {
  const dir = mkdtempSync(join(tmpdir(), "jh-w23-bridge-"));
  return new MemoryBridge({
    stateDir: dir,
    ledger: new Ledger(dir),
    now: Date.now,
    redact: (s) => s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted]"),
    apiKey: () => "sk-test-not-sent",
    brainApiKey: () => undefined,
    model: () => "gpt-5-mini",
    enabled: () => true,
    local: () => undefined,
    onChange: () => undefined,
    ...over,
  });
}

test("LM-3: memory off, a Memory-rail filter never reaches the embeddings endpoint", async () => {
  const net = recording();
  const b = bridge({ fetchImpl: net.fetchImpl, enabled: () => false });
  await b.ready();
  await b.search("my sister's address");
  assert.deepEqual(net.calls, [], "memory is off: nothing is embedded");
});

test("LM-3: memory on, a filter the redactor changes is matched by words; a plain one is embedded", async () => {
  const net = recording();
  const b = bridge({ fetchImpl: net.fetchImpl });
  await b.ready();
  await b.search("my ssn is 123-45-6789");
  assert.deepEqual(net.calls, [], "the redactor changed it: no embedding call");
  await b.search("my sister's address");
  assert.equal(net.calls.length, 1);
  assert.match(net.calls[0]!, /\/v1\/embeddings$/);
});

/** A recording fetch that names the method and answers the model list, OpenAI's embeddings and Ollama's /api/embed. */
function wire(): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const input = (JSON.parse(String(init?.body ?? "{}")) as { input?: string[] }).input ?? [];
    const vec = (i: number): number[] => Array.from({ length: 512 }, (_v, k) => (k === i ? 1 : 0));
    return new Response(JSON.stringify({ embeddings: input.map((_, i) => vec(i)), data: input.map((_, index) => ({ index, embedding: vec(index) })) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** What a `drain` tick starts (a relink after the toggle moved) has finished. */
async function afterTick(b: MemoryBridge): Promise<void> {
  b.drain(false);
  await new Promise((resolve) => setImmediate(resolve));
  await b.ready();
}

test("LM-3: memory off, the start asks the key for no model list and embeds no probe on the local server", async () => {
  const keyed = wire();
  const withKey = bridge({ fetchImpl: keyed.fetchImpl, enabled: () => false, model: () => undefined });
  await withKey.ready();
  await withKey.search("my sister's address");
  assert.deepEqual(keyed.calls, [], "an OpenAI key and no pinned model: nothing asked");
  assert.equal(withKey.summary().embeddings, "keyword");

  const local = wire();
  const onMac = bridge({ fetchImpl: local.fetchImpl, enabled: () => false, local: () => ({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", chatModel: "qwen3.5:27b", embedModel: "nomic-embed-text" }) });
  await onMac.ready();
  await onMac.search("my sister's address");
  assert.deepEqual(local.calls, [], "a local embedding model: no probe");
  assert.equal(onMac.summary().embeddings, "keyword");
});

test("LM-3: turning memory on rebuilds over the providers the settings name at the next tick; off again asks nothing", async () => {
  const net = wire();
  let on = false;
  const b = bridge({ fetchImpl: net.fetchImpl, enabled: () => on, model: () => undefined });
  await b.ready();
  await afterTick(b);
  assert.deepEqual(net.calls, [], "off at start, off at the tick");
  on = true;
  await afterTick(b);
  assert.deepEqual(net.calls, ["GET https://api.openai.com/v1/models"], "on: the key's model list, once");
  assert.equal(b.summary().embeddings, "openai");
  await b.search("my sister's address");
  assert.deepEqual(net.calls.slice(1), ["POST https://api.openai.com/v1/embeddings"], "on: the filter is embedded");
  on = false;
  await afterTick(b);
  assert.equal(b.summary().embeddings, "keyword");
  const before = net.calls.length;
  await b.search("my brother's address");
  await afterTick(b);
  assert.equal(net.calls.length, before, "off again: nothing leaves");
});

const tick = (w: World): void => (w.engine as unknown as { tick(): void }).tick();

async function heard(w: World, text: string): Promise<void> {
  const live = w.lives.at(-1)!;
  const s = live.nowMs;
  live.nowMs += 900;
  live.emit("inputTranscript", ` ${text}`, s, live.nowMs);
  nextUtterance(w);
  tick(w);
  await settle(1);
}

test("D5: Move to Trash hides the memory items learned only from that conversation; Restore brings them back; nothing is deleted", async () => {
  const memDir = mkdtempSync(join(tmpdir(), "jh-w23-d5-"));
  let clk: { t: number } = { t: 0 };
  const service = new MemoryService({ dir: memDir, now: () => clk.t, embedder: new KeywordEmbedder(), extractor: new RulesExtractor(), redact: (s) => s, log: { info() {}, warn() {} } });
  const w = world({ memory: { service } });
  clk = w.clock;
  const { engine, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    for (const line of ["I prefer short answers", "call me Kev", "from now on read the diff first", "what time is it", "open safari"]) await heard(w, line);
    await engine.command({ type: "stop" });
    for (let i = 0; i < 6; i++) {
      clock.t += 1000;
      tick(w);
      await settle(20);
    }
    const learned = service.list("live");
    assert.ok(learned.length >= 1, "memory learned something from the conversation");
    const lines = service.store.lineCount;
    const root = engine.ledger.chainRootOf("sess_1")!;

    await engine.command({ type: "conversation.trash", chainId: root });
    assert.equal(engine.ledger.conversation(root)?.state, "trashed");
    assert.deepEqual(engine.memory.list("live"), [], "the Memory rail no longer lists them");
    assert.equal(engine.snapshot().memory?.count, 0);
    assert.equal(engine.memory.voiceBlock(), undefined, "the voice is not told");
    await engine.wake("test");
    delegate(w, "jarhead how should you answer me", "item_9");
    await settle(400);
    assert.equal(w.brain.tasks.at(-1)?.memory, undefined, "the brain is not told");
    await engine.command({ type: "stop" });
    assert.equal(service.store.lineCount, lines, "the store wrote nothing: hidden, not forgotten");
    assert.equal(service.list("live").length, learned.length, "every item is still in the record");

    await engine.command({ type: "conversation.restore", chainId: root });
    assert.deepEqual(engine.memory.list("live").map((i) => i.id).sort(), learned.map((i) => i.id).sort(), "Restore brings them back");
    assert.ok(engine.memory.voiceBlock());
    await engine.wake("test");
    delegate(w, "jarhead how should you answer me", "item_10");
    await settle(400);
    assert.ok(w.brain.tasks.at(-1)?.memory, "the brain is told again");
  } finally {
    await engine.stop();
  }
});
