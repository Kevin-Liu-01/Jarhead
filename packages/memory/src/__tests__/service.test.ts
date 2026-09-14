import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_MEMORY_TOKENS, VOICE_MEMORY_TOKENS, type LedgerRow } from "@jarhead/protocol";
import { FakeEmbedder } from "../embed/embedder.ts";
import { KeywordEmbedder } from "../embed/keyword.ts";
import { LocalEmbedder } from "../embed/local.ts";
import { EmbedError } from "../embed/openai.ts";
import { ExtractUnavailableError, type Decider, type Extractor } from "../extract/extractor.ts";
import { RulesExtractor } from "../extract/rules.ts";
import { DEFER_MAX_TRIES, FORGET_RECENT_MS, MIN_NEW_KEVIN_LINES } from "../limits.ts";
import { MAX_SLICES, MemoryService, type MemoryServiceOptions } from "../service.ts";
import type { Candidate, ExtractInput } from "../types.ts";
import { clock, fakeFetch, fixtureRows, fresh, heard, ids, jsonResponse, redactFake, said, ScriptedExtractor, T0 } from "./helpers.ts";

/**
 * The façade, end to end over the fixture: idempotent ingestion behind the
 * watermark and the four-line gate, deferral on embedding failure (never mixed
 * spaces), rules fallback with one warning, the spoken reflexes, the Console
 * verbs, the two budgets, id-only audit rows, and no vector anywhere outside
 * the store.
 */

const SECRETS = ["4111", "hunter22", "sk-proj", "[redacted secret]", "123-45-6789", "ghp_"];

/** Extracts by rule from the numbered input — what the Responses model would do, deterministic. */
const rulesLike = (input: ExtractInput): Candidate[] => input.lines.filter((l) => l.speaker === "Kevin").flatMap((l) => {
  const c = RulesExtractor.classify(l.text);
  return c ? [{ ...c, evidence: [l.n] }] : [];
});

function world(over: Partial<MemoryServiceOptions> = {}): { svc: MemoryService; rows: LedgerRow[]; c: ReturnType<typeof clock>; warns: string[]; infos: string[]; dir: string; extractor: ScriptedExtractor } {
  const dir = fresh();
  const c = clock();
  const rows: LedgerRow[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const extractor = new ScriptedExtractor(rulesLike);
  const svc = new MemoryService({
    dir,
    now: c.now,
    embedder: new FakeEmbedder(),
    extractor,
    redact: redactFake,
    onRow: (r) => rows.push(r),
    newId: ids(),
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
    ...over,
  });
  return { svc, rows, c, warns, infos, dir, extractor };
}

test("ingest: the fixture yields six items with sources on Kevin's lines, the watermark lands on the last row, a second run is nothing-new, and the same words from another session are all NOOP", async () => {
  const { svc, rows, extractor } = world();
  const r = await svc.ingestSession("A", fixtureRows());
  assert.equal(r.status, "ran");
  assert.equal(r.extractor, "responses");
  assert.deepEqual([r.added, r.updated, r.noop, r.refused], [6, 0, 0, 0]);
  assert.equal(r.upToAt, T0 + 80_000);
  assert.equal(svc.store.watermark("A")?.upToAt, T0 + 80_000);
  const live = svc.list("live", 50);
  assert.deepEqual(live.map((i) => i.text).sort(), ["How Kevin likes it done: read the diff before saying a PR is fine", "Kevin goes by Kev", "Kevin likes dark mode", "Kevin prefers short answers", "Kevin wants answers in English", "Kevin's dentist is Dr. Patel"]);
  const kev = live.find((i) => i.text === "Kevin goes by Kev")!;
  assert.deepEqual(kev.sources, [{ sessionId: "A", at: T0 + 10_000, type: "heard" }], "the source is the Kevin line cited");
  assert.equal(live.find((i) => i.text === "Kevin likes dark mode")!.origin, "kevin", "a spoken remember keeps its origin");

  const again = await svc.ingestSession("A", fixtureRows());
  assert.deepEqual([again.status, again.reason], ["skipped", "nothing-new"]);
  assert.equal(extractor.inputs.length, 1, "no second extractor call — nothing past the watermark");

  const relabelled = fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "B" } : row));
  const other = await svc.ingestSession("B", relabelled);
  assert.equal(other.status, "ran");
  assert.deepEqual([other.added, other.updated, other.noop], [0, 0, 6], "the same six things again: six touches, no twins");
  assert.equal(svc.list("live").length, 6);
  assert.ok(svc.list("live").every((i) => i.seenCount === 2));

  const runs = rows.filter((x) => x.type === "memory.run");
  assert.equal(runs.length, 2);
  assert.deepEqual(rows.filter((x) => x.type === "memory.added").length, 6);
  const dump = JSON.stringify(rows);
  for (const it of live) assert.ok(!dump.includes(it.text), `item text leaked into a ledger row: ${it.text}`);
  assert.ok(!dump.includes("vec"));
});

test("ingest: fewer than MIN_NEW_KEVIN_LINES new Kevin lines → skipped and the watermark stays; force runs anyway; a trashed chain is never read", async () => {
  const { svc, extractor } = world();
  const rows = [heard(T0 + 1000, "call me Kev"), said(T0 + 2000, "Sure."), heard(T0 + 3000, "I prefer short answers"), heard(T0 + 4000, "my dentist is Dr. Patel")];
  assert.equal(MIN_NEW_KEVIN_LINES, 4);
  const r = await svc.ingestSession("S", rows);
  assert.deepEqual([r.status, r.reason], ["skipped", "too-few-lines"]);
  assert.equal(svc.store.watermark("S"), undefined);
  assert.equal(extractor.inputs.length, 0);
  const forced = await svc.ingestSession("S", rows, { force: true });
  assert.equal(forced.status, "ran");
  assert.equal(forced.added, 3);
  assert.deepEqual((await svc.ingestSession("T", fixtureRows(), { trashed: true })).reason, "trashed");
});

test("ingest: redaction — a card, an SSN, a password, a redactor-marked key never reach the extractor input or the store; refused candidates are counted", async () => {
  const leaky: Extractor = {
    kind: "responses",
    async extract(input) {
      // a model that tries to record a secret it was never shown, plus one citing only Jarhead
      return [...rulesLike(input), { kind: "fact", text: "Kevin's card is 4111 1111 1111 1111.", subjects: [], importance: 2, confidence: 0.9, evidence: [1] }, { kind: "fact", text: "Kevin is tired.", subjects: [], importance: 1, confidence: 0.3, evidence: [2] }];
    },
  };
  const seen: ExtractInput[] = [];
  const spy: Extractor = { kind: "responses", async extract(input) { seen.push(input); return leaky.extract(input); } };
  const { svc, dir } = world({ extractor: spy });
  const r = await svc.ingestSession("A", fixtureRows());
  assert.equal(r.refused, 2);
  assert.equal(r.added, 6);
  const shown = JSON.stringify(seen);
  for (const s of SECRETS) assert.ok(!shown.includes(s), `${s} reached the extractor`);
  const log = readFileSync(join(dir, "memory.jsonl"), "utf8");
  for (const s of SECRETS) assert.ok(!log.includes(s), `${s} reached the store`);
  const everything = JSON.stringify(svc.list("all", 100));
  for (const s of SECRETS) assert.ok(!everything.includes(s));
});

test("ingest: an embedding failure defers the run (nothing written, extractor not called again); the third failure lands the items without vectors; consolidation embeds them later", async () => {
  let failing = true;
  const embedder = new FakeEmbedder({ fail: () => (failing ? new EmbedError("http", "503", 503) : undefined) });
  const { svc, extractor, warns, dir } = world({ embedder });
  const rows = fixtureRows();
  const lines = () => (existsSync(join(dir, "memory.jsonl")) ? readFileSync(join(dir, "memory.jsonl"), "utf8").split("\n").filter(Boolean).length : 0);
  const r1 = await svc.ingestSession("A", rows);
  assert.deepEqual([r1.status, r1.reason, r1.tries], ["deferred", "embedding-failed", 1]);
  assert.equal(lines(), 0, "nothing written while deferred");
  assert.deepEqual(svc.deferredSessions(), ["A"]);
  const r2 = await svc.ingestSession("A", rows);
  assert.deepEqual([r2.status, r2.tries], ["deferred", 2]);
  assert.equal(extractor.inputs.length, 1, "the candidates are kept; the paid extractor is not asked twice");
  assert.equal(DEFER_MAX_TRIES, 3);
  const r3 = await svc.ingestSession("A", rows);
  assert.equal(r3.status, "ran");
  assert.equal(r3.added, 6);
  assert.deepEqual(svc.deferredSessions(), []);
  assert.equal(warns.filter((w) => /without vectors/.test(w)).length, 1);
  assert.ok(svc.list().every((i) => svc.store.vectorFor(i.id, embedder) === undefined), "landed by words, no vector of another space");
  assert.equal(svc.store.cache.size, 0);
  const voice = svc.retrieveForVoice();
  assert.ok(voice.text && voice.tokens <= VOICE_MEMORY_TOKENS, "vector-less items still render");
  failing = false;
  const cons = await svc.consolidateStep();
  assert.equal(cons.embedded, 6);
  assert.ok(svc.list().every((i) => svc.store.vectorFor(i.id, embedder)));
  assert.equal(svc.store.watermark("A")?.upToAt, T0 + 80_000);

  // the same words again would be cache hits (no call to fail): a second deferral needs new words
  failing = true;
  const zRows = [heard(T0 + 200_000, "remember that my barber is Tony"), heard(T0 + 201_000, "I usually walk to the office"), heard(T0 + 202_000, "call me Kevin"), heard(T0 + 203_000, "my gym is Equinox on Market")];
  const cached = await svc.ingestSession("Y", fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "Y" } : row)));
  assert.equal(cached.status, "ran", "every text of the fixture already has a vector: the embedder is not asked, nothing can fail");
  assert.equal(cached.noop, 6);
  const dr = await svc.ingestSession("Z", zRows);
  assert.equal(dr.status, "deferred");
  failing = false;
  const landed = await svc.ingestSession("Z", []);
  assert.equal(landed.status, "ran");
  assert.equal(landed.added, 4, "the deferred candidates land once the embedder answers");
  assert.deepEqual(svc.deferredSessions(), []);
});

test("ingest: the primary extractor being unavailable (no key, bad JSON, HTTP) means one warning and the rules extractor for that run; the run row says rules", async () => {
  const dead: Extractor = { kind: "responses", async extract() { throw new ExtractUnavailableError("no-key", "no OpenAI key"); } };
  const { svc, rows, warns } = world({ extractor: dead });
  const r = await svc.ingestSession("A", fixtureRows());
  assert.equal(r.status, "ran");
  assert.equal(r.extractor, "rules");
  assert.equal(r.added, 6);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /unavailable \(no-key/);
  const run = rows.find((x) => x.type === "memory.run");
  assert.ok(run && run.type === "memory.run" && run.extractor === "rules" && run.added === 6 && run.sessionId === "A");
  await svc.ingestSession("B", fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "B" } : row)));
  assert.equal(warns.length, 1, "the same reason warns once, not per run");
  assert.equal(svc.summary().lastRun?.extractor, "rules");
});

test("ingest: a long delta is read in slices, each advancing the watermark, in one call", async () => {
  const { svc, extractor } = world({ maxChars: 200 });
  const r = await svc.ingestSession("A", fixtureRows());
  assert.equal(r.status, "ran");
  assert.ok(extractor.inputs.length >= 2, `slices: ${extractor.inputs.length}`);
  assert.ok(extractor.inputs.every((i) => JSON.stringify(i).length < 2000));
  assert.equal(svc.store.watermark("A")?.upToAt, T0 + 80_000);
  assert.equal(svc.list().length, 6);
});

test("reflexes: 'remember that I prefer dark mode' → one preference, origin kevin; saying it again is a noop; 'forget that' tombstones what the last 10 minutes taught and writes the exclusion so a later run cannot re-learn it", async () => {
  const { svc, rows, c } = world();
  const r = await svc.remember("Hey Jarhead, remember that I prefer dark mode");
  assert.ok(r);
  assert.equal(r.op, "added");
  assert.equal(r.item.kind, "preference");
  assert.equal(r.item.text, "Kevin prefers dark mode");
  assert.equal(r.item.origin, "kevin");
  assert.deepEqual(r.item.sources, [{ at: c.now(), type: "kevin" }]);
  const again = await svc.remember("remember that I prefer dark mode");
  assert.equal(again?.op, "noop");
  assert.equal(svc.list().length, 1);
  assert.equal(svc.list()[0]!.seenCount, 2);
  const added = rows.filter((x) => x.type === "memory.added");
  assert.equal(added.length, 1);
  assert.deepEqual(Object.keys(added[0]!).sort(), ["at", "id", "kind", "origin", "type"], "ids only, never text");
  assert.equal(await svc.remember("remember that my password is hunter22"), undefined, "refused");
  assert.equal(await svc.remember("remember the key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"), undefined, "the redactor changed it");
  const cli = await svc.remember("Kevin's office is in SoMa", "place", "kevin");
  assert.equal(cli?.item.kind, "place");
  assert.equal(cli?.item.text, "Kevin's office is in SoMa");

  // the session just closed (its words are 28–90 s old), then a spoken forget: everything recent goes
  c.set(T0 + 100_000);
  const rows2 = fixtureRows();
  const learned = await svc.ingestSession("A", rows2);
  assert.deepEqual([learned.added, learned.updated], [5, 1], "the session's 'remember that I like dark mode' folds into the remembered preference");
  assert.equal(svc.list().length, 7);
  const gone = svc.forgetRecent(FORGET_RECENT_MS, "A");
  assert.equal(FORGET_RECENT_MS, 600_000);
  assert.equal(gone, 7, "everything said in the last ten minutes, the remembers included");
  assert.equal(svc.list("live").length, 0);
  assert.equal(svc.list("forgotten").length, 7);
  assert.deepEqual(svc.store.exclusions(), [{ from: T0 + 100_000 - FORGET_RECENT_MS, to: T0 + 100_000, sessionId: "A" }]);
  assert.equal(rows.filter((x) => x.type === "memory.forgotten" && x.by === "reflex").length, 7);
  // the forgotten items stay in the record and are not re-learned
  assert.equal(svc.store.items("all").length, 7);
  const relearn = await svc.ingestSession("C", rows2.map((row) => ("sessionId" in row ? { ...row, sessionId: "C" } : row)));
  assert.equal(relearn.status, "skipped", "every row of the session sits inside the window");
  assert.equal(svc.list("live").length, 0);
});

test("verbs: forget/restore/edit round-trip with id-only rows; edit refuses secrets and over-long text; 'Delete' is not a word this module knows", async () => {
  const { svc, rows } = world();
  await svc.ingestSession("A", fixtureRows());
  const kev = svc.list().find((i) => i.text === "Kevin goes by Kev")!;
  assert.ok(svc.forget(kev.id, "kevin"));
  assert.equal(svc.store.get(kev.id)!.state, "forgotten");
  assert.ok(!svc.forget(kev.id, "kevin"), "already forgotten");
  assert.ok(svc.restore(kev.id));
  assert.equal(svc.store.get(kev.id)!.state, "live");
  assert.ok(svc.edit(kev.id, "Kevin goes by Kev, never Kevin", "fact"));
  assert.equal(svc.store.get(kev.id)!.text, "Kevin goes by Kev, never Kevin");
  assert.ok(!svc.edit(kev.id, "Kevin's SSN is 123-45-6789"));
  assert.ok(!svc.edit(kev.id, "x".repeat(201)));
  assert.ok(!svc.edit("m_nope", "whatever"));
  assert.ok(!svc.restore("m_nope"));
  const kinds = rows.map((r) => r.type);
  assert.ok(kinds.includes("memory.forgotten") && kinds.includes("memory.restored") && kinds.includes("memory.updated"));
  for (const r of rows) assert.ok(!("text" in r), `row ${r.type} carries text`);
  assert.ok(!Object.keys(svc).some((k) => /delete/i.test(k)));
});

test("retrieval: the brain block ≤ 250 tokens with ids and lastUsedIds; the voice block ≤ 120 starting '# Kevin, in brief'; empty store → no text; a hung embedder is bounded by the race and the words still rank", async () => {
  const { svc } = world();
  assert.deepEqual(await svc.retrieveForBrain("anything"), { tokens: 0, ids: [] });
  assert.deepEqual(svc.retrieveForVoice(), { tokens: 0, ids: [] });
  await svc.ingestSession("A", fixtureRows());
  for (let i = 0; i < 40; i++) await svc.remember(`Kevin's fact number ${i} about his world and how he likes it handled every time`, "fact");
  const brain = await svc.retrieveForBrain("what does Kevin like about answers and dentists");
  assert.ok(brain.text && brain.tokens <= BRAIN_MEMORY_TOKENS, `${brain.tokens}`);
  assert.ok(brain.ids.length > 0);
  assert.ok(brain.text!.split("\n").every((l) => l.startsWith("- ")));
  assert.deepEqual(svc.summary().lastUsedIds, brain.ids.slice(0, 8));
  assert.equal(svc.summary().budgetUsed?.brain, brain.tokens);
  const voice = svc.retrieveForVoice();
  assert.ok(voice.text!.startsWith("# Kevin, in brief\n") && voice.text!.endsWith("\nUse this quietly; never announce that you remember it."));
  assert.ok(voice.tokens <= VOICE_MEMORY_TOKENS, `${voice.tokens}`);
  assert.ok(!/[*`]/.test(voice.text!));
  assert.ok(voice.ids.includes(svc.list().find((i) => i.text === "Kevin wants answers in English")!.id), "a strong spoken preference is pinned into the voice block");

  const hung = new FakeEmbedder();
  const slow = new MemoryService({ dir: fresh(), now: () => T0, embedder: hung, extractor: new RulesExtractor(), redact: redactFake, newId: ids(), retrieveTimeoutMs: 30, log: { info() {}, warn() {} } });
  await slow.ingestSession("A", fixtureRows());
  hung.embed = () => new Promise(() => undefined); // the network stalls after the items are in
  const t0 = Date.now();
  const block = await slow.retrieveForBrain("short answers");
  assert.ok(Date.now() - t0 < 500, "bounded by the race");
  assert.ok(block.text && block.ids.length > 0, "ranked by words when the vector is late");
});

test("list/search: newest first, capped, no vector anywhere in the JSON; search ranks by words and exact substrings; summary counts follow the states", async () => {
  const { svc } = world({ embedder: new KeywordEmbedder() });
  await svc.ingestSession("A", fixtureRows());
  const all = svc.list("live", 3);
  assert.equal(all.length, 3);
  assert.ok(all[0]!.lastSeenAt >= all[1]!.lastSeenAt);
  const dump = JSON.stringify([...svc.list("all", 100), ...(await svc.search("dentist"))]);
  assert.ok(!/"vec"|"embedding"/.test(dump));
  assert.ok(!/\[(?:-?\d+\.\d+,){20,}/.test(dump), "no long float arrays");
  const hits = await svc.search("dentist");
  assert.equal(hits[0]!.text, "Kevin's dentist is Dr. Patel");
  assert.deepEqual((await svc.search("nothing relevant here at all")).length, 0);
  const s = svc.summary();
  assert.deepEqual([s.count, s.forgotten, s.archived, s.embeddings], [6, 0, 0, "keyword"]);
  svc.forget(hits[0]!.id, "cli");
  assert.equal(svc.summary().forgotten, 1);
  assert.equal(svc.list("forgotten").length, 1);
  assert.equal((await svc.search("dentist", 10, "forgotten")).length, 1);
  assert.ok(s.lastRunAt && s.lastRun?.added === 6 && s.lastRun.extractor === "responses");
  assert.equal(s.embeddingModel, undefined, "keyword matching names no model");
  assert.equal(s.embeddingDims, undefined);
});

/** A fake Ollama that answers /api/embed with `dims`-wide unit vectors (position i of each batch lit). */
function ollamaEmbedder(dims: number): Promise<LocalEmbedder> {
  const ff = fakeFetch((call) => jsonResponse({ embeddings: (call.body as { input: string[] }).input.map((_, i) => Array.from({ length: dims }, (__, k) => (k === i % dims ? 1 : 0.001 * (i + 1)))) }));
  return LocalEmbedder.probe({ flavor: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text:latest", fetchImpl: ff.fetch });
}

test("a vector embedder reports its kind: openai for OpenAI, local for local — and the summary names the model and dims; the fake reports openai (it pins OpenAI-scale cosines)", async () => {
  const fake = world();
  assert.equal(fake.svc.embeddings(), "openai");
  assert.deepEqual([fake.svc.summary().embeddingModel, fake.svc.summary().embeddingDims], ["fake", 512]);
  const local = world({ embedder: await ollamaEmbedder(768) });
  assert.equal(local.svc.embeddings(), "local");
  const s = local.svc.summary();
  assert.deepEqual([s.embeddings, s.embeddingModel, s.embeddingDims], ["local", "nomic-embed-text:latest", 768]);
  const words = world({ embedder: new KeywordEmbedder() });
  assert.equal(words.svc.embeddings(), "keyword");
});

test("reembed embeds only misses and returns 0 when done: a store filled under one embedder is re-vectored under the next, `limit` at a time, through the cache; forgotten items are left alone; keyword mode is always done", async () => {
  const dir = fresh();
  const first = world({ dir });
  await first.svc.ingestSession("A", fixtureRows());
  assert.equal(first.svc.list().length, 6);
  first.svc.forget(first.svc.list()[0]!.id, "kevin");
  // the brain moved to local: the same <stateDir>/memory under a local embedding model
  const local = await ollamaEmbedder(768);
  const calls: string[][] = [];
  const spy = local.embed.bind(local);
  local.embed = (texts, signal) => {
    calls.push([...texts]);
    return spy(texts, signal);
  };
  const svc = new MemoryService({ dir, now: () => T0 + 200_000, embedder: local, extractor: new RulesExtractor(), redact: redactFake, newId: ids("n"), log: { info() {}, warn() {} } });
  assert.equal(svc.list().length, 5);
  assert.ok(svc.list().every((i) => svc.store.vectorFor(i.id, local) === undefined), "nothing is in the new space yet");
  assert.equal(await svc.reembed(2), 2);
  assert.deepEqual(calls.map((c) => c.length), [2]);
  assert.equal(await svc.reembed(2), 2);
  assert.equal(await svc.reembed(2), 1, "only the last miss; hits never reach the model");
  assert.deepEqual(calls.map((c) => c.length), [2, 2, 1]);
  assert.equal(await svc.reembed(2), 0, "done");
  assert.equal(await svc.reembed(), 0);
  assert.equal(calls.length, 3, "a done sweep makes no call");
  assert.ok(svc.list("live").every((i) => svc.store.vectorFor(i.id, local)));
  assert.equal(svc.store.vectorFor(svc.list("forgotten")[0]!.id, local), undefined, "the forgotten item was not embedded");
  assert.equal(svc.summary().embeddings, "local");
  const rows = readFileSync(join(dir, "embeddings.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { model: string; dims: number });
  assert.equal(rows.filter((r) => r.model === "fake").length, 6, "the old space's rows stay");
  assert.equal(rows.filter((r) => r.model === "nomic-embed-text:latest" && r.dims === 768).length, 5);
  assert.equal(await world({ embedder: new KeywordEmbedder() }).svc.reembed(), 0);
});

test("retrieval: the delegator's `${request}\\n${kevinRecent}` query is an LRU hit when its lines were primed — 0 embedder calls on the delegation path, the composed vector lands under the full query's sha, and only a query with no primed line races the network", async () => {
  const { svc } = world();
  const embedder = new FakeEmbedder();
  const s = new MemoryService({ dir: fresh(), now: () => T0, embedder, extractor: new RulesExtractor(), redact: redactFake, newId: ids(), log: { info() {}, warn() {} } });
  await s.ingestSession("A", fixtureRows());
  void svc;
  const lines = ["okay so I merged the feature branch this morning", "can you read the diff before you tell me the PR is fine", "and keep the answer short"];
  for (const l of lines) await s.prime(l);
  const primed = embedder.calls.length;
  // the request is the last heard line; kevinRecent is every recent line, one per line — the bridge primed each as it landed
  const query = `${lines[2]}\n${lines.join("\n")}`;
  const block = await s.retrieveForBrain(query);
  assert.equal(embedder.calls.length, primed, "no embedding call at delegation time: the primed lines composed the vector");
  assert.ok(block.text && block.ids.length > 0, `a block from the composed vector; got ${JSON.stringify(block)}`);
  assert.ok(block.text!.includes("read the diff before saying a PR is fine"), "the procedure the words point at");
  const again = await s.retrieveForBrain(query);
  assert.equal(embedder.calls.length, primed, "the composed vector landed under the full query's sha: a direct hit");
  assert.deepEqual(again.ids, block.ids);
  // a request joined from two utterances is not itself primed, but its lines are
  const joined = `${lines[1]} ${lines[2]}\n${lines[1]}\n${lines[2]}`;
  await s.retrieveForBrain(joined);
  assert.equal(embedder.calls.length, primed, "still no network");
  // nothing primed at all → the race runs (one embed call) and lands the vector for next time
  await s.retrieveForBrain("something never heard before\nnor this");
  assert.equal(embedder.calls.length, primed + 1);
  await s.retrieveForBrain("something never heard before\nnor this");
  assert.equal(embedder.calls.length, primed + 1, "landed");
  // prime is idempotent and never throws
  await s.prime(lines[0]!);
  assert.equal(embedder.calls.length, primed + 1);
  await new MemoryService({ dir: fresh(), now: () => T0, embedder: new FakeEmbedder({ fail: () => new EmbedError("no-key", "no key") }), extractor: new RulesExtractor(), redact: redactFake, log: { info() {}, warn() {} } }).prime("anything");
});

test("retrieval in keyword mode (no key): a realistic request + recent-lines query returns the relevant items in the brain block, not an empty one", async () => {
  const { svc } = world({ embedder: new KeywordEmbedder(), extractor: new RulesExtractor() });
  await svc.ingestSession("A", fixtureRows());
  const request = "open the pull request for the auth work, read through the diff and tell me if the PR is fine, then push it if it is";
  const recent = ["okay so I merged the feature branch this morning and the CI was green", "I'd like you to open the pull request for the auth work and read through the diff", "then tell me if the PR is fine and push it if it is", "also the standup moved to ten so keep the summary short"].join("\n");
  const block = await svc.retrieveForBrain(`${request}\n${recent}`);
  assert.ok(block.text, "the query lane is alive without a key");
  assert.ok(block.text!.includes("read the diff before saying a PR is fine"), block.text);
  assert.ok(block.text!.includes("Kevin prefers short answers"));
  assert.ok(!block.text!.includes("dentist"));
  assert.ok(block.tokens <= BRAIN_MEMORY_TOKENS);
  assert.deepEqual(svc.summary().lastUsedIds, block.ids.slice(0, 8));
});

test("ingest: a session longer than MAX_SLICES × maxChars reports `more` and is finished across calls without the gate stopping the continuation; a deferral mid-run emits the run row for the committed slices and the rest is read once the deferred slice lands", async () => {
  // ~one line per slice: ten lines need three calls of four slices
  const { svc, rows, extractor } = world({ maxChars: 60 });
  const r1 = await svc.ingestSession("A", fixtureRows());
  assert.equal(r1.status, "ran");
  assert.equal(r1.more, true, "the slice cap was hit with rows left");
  assert.equal(MAX_SLICES, 4);
  assert.equal(extractor.inputs.length, 4);
  assert.ok((svc.store.watermark("A")?.upToAt ?? 0) < T0 + 80_000, "the watermark sits mid-session");
  assert.deepEqual(svc.continuingSessions(), ["A"]);
  let calls = 1;
  let r = r1;
  while (r.more) {
    r = await svc.ingestSession("A", fixtureRows());
    assert.equal(r.status, "ran", `call ${calls + 1} continued the approved run (no too-few-lines gate on the tail)`);
    calls++;
    assert.ok(calls < 10);
  }
  assert.equal(svc.store.watermark("A")?.upToAt, T0 + 80_000, "the tail was read");
  assert.equal(svc.list().length, 6);
  assert.deepEqual(svc.continuingSessions(), []);
  assert.equal(rows.filter((x) => x.type === "memory.run").length, calls, "one run row per call");
  assert.deepEqual((await svc.ingestSession("A", fixtureRows())).reason, "nothing-new");

  // a deferral on the second of five two-line slices: slice 0 is committed with its own run row; the deferred slice lands on the next call and the three after it follow in that same call
  let embedCalls = 0;
  let failOn = 2;
  const flaky = new FakeEmbedder({ fail: () => (++embedCalls === failOn ? new EmbedError("http", "503", 503) : undefined) });
  const w2 = world({ maxChars: 100, embedder: flaky });
  const d1 = await w2.svc.ingestSession("B", fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "B" } : row)));
  assert.deepEqual([d1.status, d1.reason, d1.more, d1.tries], ["deferred", "embedding-failed", true, 1]);
  assert.ok(d1.added >= 1, "the committed first slice's counts ride the deferred result");
  const runs1 = w2.rows.filter((x) => x.type === "memory.run");
  assert.equal(runs1.length, 1, "the committed slice got its run row at once, not when the tail lands");
  assert.ok(runs1[0]!.type === "memory.run" && runs1[0]!.added === d1.added);
  const wm1 = w2.svc.store.watermark("B")?.upToAt ?? 0;
  assert.ok(wm1 > 0 && wm1 < T0 + 80_000, "the watermark covers only the committed slice");
  assert.deepEqual(w2.svc.deferredSessions(), ["B"]);
  const before = w2.extractor.inputs.length;
  failOn = -1;
  const d2 = await w2.svc.ingestSession("B", fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "B" } : row)));
  assert.equal(d2.status, "ran");
  assert.ok(w2.extractor.inputs.length > before, "the slices after the deferred one were read in the same call");
  assert.equal(w2.svc.store.watermark("B")?.upToAt, T0 + 80_000);
  assert.equal(w2.svc.list().length, 6, "every item of the session, none read twice");
  assert.deepEqual(w2.svc.deferredSessions(), []);
  assert.equal(w2.rows.filter((x) => x.type === "memory.run").length, 2);
});

test("ingest: two 'never mind' lines across two sessions never produce a pinned procedure — rules mode leaves ordinary chatter alone", async () => {
  const { svc } = world({ embedder: new KeywordEmbedder(), extractor: new RulesExtractor() });
  const chatter = (sid: string, base: number): LedgerRow[] => [
    heard(base + 1000, "never mind"),
    heard(base + 2000, "call me back when it's done"),
    heard(base + 3000, "I like that"),
    heard(base + 4000, "I never said that"),
    heard(base + 5000, "call me later"),
    heard(base + 6000, "I always forget"),
    { at: base + 7000, type: "session.closed", sessionId: sid, reason: "idle", usageSeconds: 7 },
  ];
  const a = await svc.ingestSession("A", chatter("A", T0));
  assert.equal(a.status, "ran");
  assert.equal(a.added, 0, "nothing durable in six lines of chatter");
  const b = await svc.ingestSession("B", chatter("B", T0 + 100_000));
  assert.equal(b.added + b.updated + b.noop, 0);
  assert.equal(svc.list("all").length, 0);
  assert.equal(svc.retrieveForVoice().text, undefined, "nothing pinned into the spoken prompt");
});

test("ingest: an HTTP 400 from the extractor (a wrong model id, a rejected schema) warns on every run — a configuration fault is not a transient", async () => {
  const bad: Extractor = { kind: "responses", async extract() { throw new ExtractUnavailableError("http", "responses: HTTP 400 model not found", 400); } };
  const { svc, warns } = world({ extractor: bad });
  await svc.ingestSession("A", fixtureRows());
  await svc.ingestSession("B", fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "B" } : row)));
  assert.equal(warns.length, 2, "once per run, not once per process");
  assert.ok(warns.every((w) => /HTTP 400 is a configuration fault/.test(w)));
  assert.equal(svc.summary().lastRun?.extractor, "rules");
});

test("consolidateStep: five idle calls on an unchanged store append zero rows and never rewrite index.json", async () => {
  const { svc, dir } = world();
  await svc.ingestSession("A", fixtureRows());
  const first = await svc.consolidateStep();
  assert.equal(first.done, true);
  assert.ok(first.wrote, "the first pass over six fresh items is real");
  const lines = svc.store.lineCount;
  const indexBefore = readFileSync(join(dir, "index.json"), "utf8");
  const indexMtime = statSync(join(dir, "index.json")).mtimeMs;
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < 5; i++) {
    const r = await svc.consolidateStep();
    assert.deepEqual([r.done, r.wrote, r.pairs, r.merged, r.archived], [true, false, 0, 0, 0]);
  }
  assert.equal(svc.store.lineCount, lines, "no consolidated row for a no-op");
  assert.equal(svc.store.log.read().rows.filter((r) => r.op === "consolidated").length, 1);
  assert.equal(readFileSync(join(dir, "index.json"), "utf8"), indexBefore);
  assert.equal(statSync(join(dir, "index.json")).mtimeMs, indexMtime, "index.json was not rewritten");
});

test("writers are serialised: two concurrent remembers of the same new thing make one item, and a remember during an ingest never lands as a twin of what the ingest adds", async () => {
  // a decider that yields to the event loop before answering, so an unserialised second writer would snapshot a pool without the first's add
  const slow: Decider = {
    kind: "responses",
    async decide(_c, n) {
      await new Promise((r) => setTimeout(r, 5));
      return { op: "ADD", ...(n[0] ? { target: n[0].item.id } : {}), contradicts: false };
    },
  };
  const { svc } = world({ decider: slow });
  await svc.remember("I prefer dark mode");
  const [a, b] = await Promise.all([svc.remember("I prefer dark mode in every editor"), svc.remember("I prefer dark mode in every editor")]);
  assert.equal(a?.op, "added");
  assert.equal(b?.op, "noop", "the second saw the first's add and touched it");
  assert.equal(svc.list().length, 2, "dark mode, and dark mode in every editor — no twin");
  const rowsB = fixtureRows().map((row) => ("sessionId" in row ? { ...row, sessionId: "B" } : row));
  const [ing, rem] = await Promise.all([svc.ingestSession("B", rowsB), svc.remember("I prefer short answers")]);
  assert.equal(ing.status, "ran");
  assert.equal(rem?.op, "noop", "the ingest added 'Kevin prefers short answers' first; the remember touched it");
  assert.equal(svc.list().filter((i) => /short answers/.test(i.text)).length, 1);
  const [c1, c2] = await Promise.all([svc.consolidateStep(), svc.consolidateStep()]);
  assert.ok(c1.done && c2.done);
});
