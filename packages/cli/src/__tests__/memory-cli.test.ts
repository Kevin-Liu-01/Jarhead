import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryItem, MemorySummary } from "@jarhead/protocol";
import { DEFAULT_MEMORY_MODEL } from "@jarhead/memory";
import { FRAME_JSON, FrameParser, encodeJson, type ClientMessage } from "@jarhead/daemon";
import { AGENT_STATUSES, MEMORY_ID, agentsByStatus, agoWords, extractorPlan, memoryChecks, memoryLine, render, type MemoryCheckInput } from "../doctor.ts";

/**
 * `jarhead memory`, `jarhead status`'s words and the doctor's memory rows, without a
 * real daemon, a key, a store or the network: the extractor plan is a table over the
 * memory module's own rule, the rows are a function of what the doctor read, the
 * status words are pure, and the CLI is run as a process — refusing a bad id or an
 * unknown state/kind before it opens any socket, and rendering `memory.items` from a
 * daemon stand-in on a unix socket.
 */

// One temp dir for every CLI spawn (state dir, sockets); removed at the end — a test's scratch, not Kevin's data.
const stateDir = mkdtempSync(join(tmpdir(), "jh-cli-mem-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));

const NOW = 1_800_000_000_000;

test("doctor: extractorPlan — what runs is the override or the module's default, never the list's pick; the list only says listed or not and names the best mini by the memory module's own rule", () => {
  const listed = ["gpt-live-1", "gpt-5.6-terra", "gpt-5-mini", "gpt-5.6-mini", "gpt-4o-mini", "gpt-4o-mini-tts", "gpt-4o-mini-realtime-preview", "text-embedding-3-small", "gpt-5-mini-search-preview", "gpt-5-nano", "o4-mini"];
  assert.equal(DEFAULT_MEMORY_MODEL, "gpt-5-mini", "the id the engine builds its ResponsesExtractor with when nothing is pinned");
  assert.deepEqual(extractorPlan(listed, undefined), { runs: "gpt-5-mini", pinned: false, listed: true, best: "gpt-5.6-mini" }, "unpinned runs the default even when a newer mini is listed — the doctor never claims the pick runs");
  assert.deepEqual(extractorPlan(listed, "gpt-5.6-mini"), { runs: "gpt-5.6-mini", pinned: true, listed: true, best: "gpt-5.6-mini" });
  assert.deepEqual(extractorPlan(listed, "gpt-9-mini"), { runs: "gpt-9-mini", pinned: true, listed: false, best: "gpt-5.6-mini" }, "an override the key lacks still runs (and falls to rules); the best mini is what to pin instead");
  assert.deepEqual(extractorPlan(["gpt-live-1", "gpt-5.6-terra"], undefined), { runs: "gpt-5-mini", pinned: false, listed: false, best: undefined }, "no mini on the key: the default still runs; the frontier id is never proposed");
  assert.deepEqual(extractorPlan(undefined, undefined), { runs: "gpt-5-mini", pinned: false, listed: undefined, best: undefined }, "no list at all");
  assert.deepEqual(extractorPlan(undefined, "gpt-9-mini"), { runs: "gpt-9-mini", pinned: true, listed: undefined, best: undefined });
  // @jarhead/memory's rule, not a copy of it: o*-mini counts, dated snapshots lose to undated, tts/search/nano never match.
  assert.equal(extractorPlan(["o3-mini", "o4-mini", "gpt-4o-mini-tts", "gpt-5-nano"], undefined).best, "o4-mini");
  assert.equal(extractorPlan(["gpt-5-mini-2025-08-07", "gpt-5-mini"], undefined).best, "gpt-5-mini");
  assert.equal(extractorPlan(["gpt-4o-mini", "gpt-4.1-mini"], undefined).best, "gpt-4.1-mini");
});

const base: MemoryCheckInput = { enabled: true, hasOpenAIKey: true, modelIds: new Set(["gpt-live-1", "gpt-5.6-terra", "gpt-5-mini", "gpt-5.6-mini"]), override: undefined, summary: undefined, storeDir: "/tmp/jh/memory", storeRows: undefined };
const summary: MemorySummary = { enabled: true, count: 142, forgotten: 3, archived: 7, embeddings: "openai", pending: 1, lastRunAt: NOW - 12 * 60_000, lastRun: { extractor: "responses", added: 3, updated: 1, noop: 4, refused: 1, ms: 1800 }, budgetUsed: { brain: 143, voice: 96 }, lastUsedIds: ["m_a", "m_b"] };
/** The same summary with its last learn measured from the real clock (memoryChecks renders "ago" from Date.now()). */
const liveSummary: MemorySummary = { ...summary, lastRunAt: Date.now() - 12 * 60_000 };

test("doctor: memory rows — counts and the last learn from a running daemon, the store's row count without one, exactly one row (no extractor) when Kevin switched it off; the cost words are the caps", () => {
  const withDaemon = memoryChecks({ ...base, summary: liveSummary });
  assert.equal(withDaemon.length, 2);
  const [row, extractor] = withDaemon;
  assert.equal(row!.group, "memory");
  assert.equal(row!.status, "ok");
  assert.match(row!.detail, /^142 remembered · 3 forgotten · 7 archived · matching openai · learned 12 min ago \(\+3 · ~1 · 4 noop · responses\) · 1 conversation waiting · last prompts 143 brain \/ 96 voice tokens \(caps 250 brain \/ 120 voice tokens per prompt\)$/);
  assert.equal(extractor!.name, "extractor");
  assert.equal(extractor!.status, "ok");
  assert.match(extractor!.detail, /^runs gpt-5-mini \(the memory module's default, listed for this key\)/, "what the engine runs, as fact");
  assert.match(extractor!.detail, /never the ChatGPT plan/);

  const noDaemon = memoryChecks({ ...base, storeRows: 88 });
  assert.match(noDaemon[0]!.detail, /^on · matching openai embeddings .* · 88 rows in \/tmp\/jh\/memory\/memory\.jsonl \(counts come from a running daemon\) · caps 250 brain \/ 120 voice tokens per prompt$/);
  const noStore = memoryChecks({ ...base });
  assert.match(noStore[0]!.detail, /no store yet at \/tmp\/jh\/memory \(it appears after the first closed conversation\)/);

  const off = memoryChecks({ ...base, enabled: false, summary: liveSummary });
  assert.equal(off.length, 1, "off: nothing is configured to run, so no extractor row");
  assert.equal(off[0]!.status, "ok", "off is Kevin's choice, not a finding");
  assert.match(off[0]!.detail, /^off \(Settings › Memory\) — nothing is extracted, injected or embedded; the store under \/tmp\/jh\/memory stays as it is$/);

  const disagree = memoryChecks({ ...base, summary: { ...liveSummary, enabled: false } });
  assert.equal(disagree[0]!.status, "warn");
  assert.match(disagree[0]!.fix ?? "", /restart the daemon or flip Settings › Memory/);

  // Never the word delete: forget is a state.
  for (const c of [...withDaemon, ...noDaemon, ...off]) assert.doesNotMatch(`${c.detail} ${c.fix ?? ""}`, /delet/i);
  // The rows render under their own group.
  assert.match(render(withDaemon).text, /\n  memory\n    ✔ memory {23}142 remembered/);
});

test("doctor: extractor row — names the model the engine WILL run (the default when unpinned), warns when the key does not list it, names the key's best mini only as the thing to pin, never proposes the frontier id; rules without a key", () => {
  const row = (input: Partial<MemoryCheckInput>) => memoryChecks({ ...base, ...input })[1]!;

  const noKey = row({ hasOpenAIKey: false, modelIds: undefined });
  assert.equal(noKey.status, "ok");
  assert.match(noKey.detail, /^rules \(regex over the user's lines\) — no OPENAI_API_KEY/);
  assert.match(memoryChecks({ ...base, hasOpenAIKey: false, modelIds: undefined })[0]!.detail, /keywords \(no OPENAI_API_KEY — nothing leaves the Mac\)/);

  // Unpinned: the default runs; a newer mini on the key is a hint, not a claim.
  const unpinned = row({});
  assert.equal(unpinned.status, "ok");
  assert.equal(unpinned.detail, `runs ${DEFAULT_MEMORY_MODEL} (the memory module's default, listed for this key) — the key's best mini-class id is gpt-5.6-mini: pin it with JARHEAD_MEMORY_MODEL=gpt-5.6-mini. Dollars on the key, never the ChatGPT plan; ≤ 5 runs a day, ≤ ~8k in + 0.9k out each`);
  const unpinnedBest = row({ modelIds: new Set(["gpt-live-1", "gpt-5-mini"]) });
  assert.equal(unpinnedBest.detail, `runs gpt-5-mini (the memory module's default, listed for this key). Dollars on the key, never the ChatGPT plan; ≤ 5 runs a day, ≤ ~8k in + 0.9k out each`, "no hint when the default is already the key's best");

  // Unpinned and the default is not on the key: every run falls to rules — the fix is the pin.
  const defaultMissing = row({ modelIds: new Set(["gpt-live-1", "gpt-5.6-mini"]) });
  assert.equal(defaultMissing.status, "warn");
  assert.equal(defaultMissing.detail, `runs ${DEFAULT_MEMORY_MODEL} (the memory module's default) — not listed for this key, so every run falls back to rules with one warning`);
  assert.equal(defaultMissing.fix, "pin JARHEAD_MEMORY_MODEL=gpt-5.6-mini in ~/.jarhead/env (the key's best mini-class Responses id)");
  const noMini = row({ modelIds: new Set(["gpt-live-1", "gpt-5.6-terra"]) });
  assert.equal(noMini.status, "warn");
  assert.match(noMini.detail, /not listed for this key/);
  assert.match(noMini.fix ?? "", /or leave the rules extractor to it/);

  // Pinned: Kevin's word runs; listed or not is the only finding.
  assert.equal(row({ override: "gpt-5.6-mini" }).status, "ok");
  assert.equal(row({ override: "gpt-5.6-mini" }).detail, "runs gpt-5.6-mini (JARHEAD_MEMORY_MODEL, listed for this key). Dollars on the key, never the ChatGPT plan; ≤ 5 runs a day, ≤ ~8k in + 0.9k out each");
  assert.match(row({ override: "gpt-5-mini" }).detail, /^runs gpt-5-mini \(JARHEAD_MEMORY_MODEL, listed for this key\) — the key also lists gpt-5\.6-mini\./);
  const unlisted = row({ override: "gpt-9-mini" });
  assert.equal(unlisted.status, "warn");
  assert.equal(unlisted.detail, "runs gpt-9-mini (JARHEAD_MEMORY_MODEL) — not listed for this key, so every run falls back to rules with one warning");
  assert.match(unlisted.fix ?? "", /pin JARHEAD_MEMORY_MODEL=gpt-5\.6-mini/);

  // No list (the keys row says why): a pin is Kevin's word, the default is only unverified.
  const pinnedUnchecked = row({ modelIds: undefined, override: "gpt-9-mini" });
  assert.equal(pinnedUnchecked.status, "ok");
  assert.match(pinnedUnchecked.detail, /^runs gpt-9-mini \(JARHEAD_MEMORY_MODEL, not checked: the key's model list could not be read\)/);
  const unread = row({ modelIds: undefined });
  assert.equal(unread.status, "warn");
  assert.match(unread.detail, new RegExp(`^runs ${DEFAULT_MEMORY_MODEL} \\(the memory module's default, not checked`));

  // The frontier id is never a proposal, and nothing here says delete.
  for (const r of [noKey, unpinned, unpinnedBest, defaultMissing, noMini, unlisted, pinnedUnchecked, unread]) {
    assert.doesNotMatch(`${r.detail} ${r.fix ?? ""}`, /terra|frontier/i, r.detail);
    assert.doesNotMatch(`${r.detail} ${r.fix ?? ""}`, /delet/i);
  }
});

test("status words: agentsByStatus lists ended and unknown apart in AGENT_STATUSES order (empty for none); agoWords carries its own suffix so memoryLine never says 'just now ago'; MEMORY_ID is the store's shape", () => {
  assert.deepEqual([...AGENT_STATUSES], ["working", "idle", "blocked", "done", "ended", "unknown", "offline"]);
  assert.equal(agentsByStatus([]), "");
  assert.equal(agentsByStatus([{ status: "ended" }, { status: "working" }, { status: "unknown" }, { status: "ended" }, { status: "offline" }]), "1 working · 2 ended · 1 unknown · 1 offline");

  assert.equal(agoWords(NOW - 10_000, NOW), "just now");
  assert.equal(agoWords(NOW - 12 * 60_000, NOW), "12 min ago");
  assert.equal(agoWords(NOW - 3 * 3_600_000, NOW), "3 h ago");
  assert.equal(agoWords(NOW - 4 * 86_400_000, NOW), "4 d ago");

  assert.equal(memoryLine(undefined), "(no summary in the snapshot)");
  assert.equal(memoryLine({ ...summary, enabled: false }), "off — nothing is extracted, injected or embedded; the store stays as it is");
  assert.equal(memoryLine(summary, NOW), "142 remembered · 3 forgotten · 7 archived · matching openai · 1 conversation waiting · learned 12 min ago (+3 · ~1 · responses) · last prompts 143 brain / 96 voice tokens (caps 250 / 120) · 2 used this turn");
  const { lastRun: _lastRun, budgetUsed: _budget, lastUsedIds: _ids, ...bare } = summary;
  const fresh = memoryLine({ ...bare, pending: 0, lastRunAt: NOW - 5000 }, NOW);
  assert.equal(fresh, "142 remembered · 3 forgotten · 7 archived · matching openai · learned just now");
  assert.doesNotMatch(fresh, /just now ago/);
  const { lastRunAt: _at, ...never } = bare;
  assert.match(memoryLine({ ...never, pending: 2 }, NOW), /2 conversations waiting · never learned yet$/);

  // core's newId("m"): "m_", base-36 time, six of [0-9a-z].
  assert.ok(MEMORY_ID.test("m_mtzb9x1abc2"));
  assert.ok(MEMORY_ID.test("m_abc123"));
  for (const bad of ["not-an-id", "m_", "m_ab", "M_abcdef", "m_abc def", "s_mtzb9x1abc2", `m_${"a".repeat(41)}`]) assert.ok(!MEMORY_ID.test(bad), bad);
});

// ---- the CLI itself, as a process: parsing and refusals happen before any socket; rendering comes from a daemon stand-in.

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "main.ts");

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** Run `jarhead <args>` against the temp state dir with no audio and no auto-wake; `socket` is where it looks for a daemon (default: one that is not there). */
function jarhead(args: readonly string[], socket = join(stateDir, "nobody.sock")): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], {
      env: { ...process.env, JARHEAD_STATE_DIR: stateDir, JARHEAD_AUTO_WAKE: "0", JARHEAD_NO_AUDIO: "1", JARHEAD_SOCKET: socket },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("jarhead memory: a bad id, an unknown state or kind, an empty text and an unknown verb are refused before a socket is opened; well-formed verbs reach the daemon step; help names the verbs and never says delete", async () => {
  const [badId, badState, badKind, emptyAdd, badVerb, forgetOk, listOk, runOk, help] = await Promise.all([
    jarhead(["memory", "forget", "not-an-id"]),
    jarhead(["memory", "list", "--state", "bogus"]),
    jarhead(["memory", "add", "Kevin likes tea", "--kind", "flavour"]),
    jarhead(["memory", "add"]),
    jarhead(["memory", "purge"]),
    jarhead(["memory", "forget", "m_mtzb9x1abc2"]),
    jarhead(["memory"]),
    jarhead(["memory", "run"]),
    jarhead(["help"]),
  ]);
  assert.equal(badId.code, 1);
  assert.match(badId.err, /usage: jarhead memory forget <id>.*an id looks like m_….*forget hides the item, nothing is deleted/);
  assert.equal(badState.code, 1);
  assert.match(badState.err, /usage: jarhead memory list \[--state live\|forgotten\|merged\|archived\|all\] \[--limit N\]/);
  assert.equal(badKind.code, 1);
  assert.match(badKind.err, /--kind must be one of preference, fact, episode, procedure, contact, place \(got flavour\)/);
  assert.equal(emptyAdd.code, 1);
  assert.match(emptyAdd.err, /usage: jarhead memory add "<text>"/);
  assert.equal(badVerb.code, 1);
  assert.match(badVerb.err, /unknown memory verb: purge — list \| search \| forget \| restore \| add \| run/);
  // Parsed fine, then the socket: the only error left is that nothing listens on it.
  for (const [name, r] of [
    ["forget", forgetOk],
    ["list", listOk],
    ["run", runOk],
  ] as const) {
    assert.equal(r.code, 1, name);
    assert.match(r.err, /no daemon on .*nobody\.sock — start Jarhead\.app or `pnpm jarheadd`/, name);
    assert.doesNotMatch(r.err, /usage|unknown/, name);
  }
  assert.equal(help.code, 0);
  for (const verb of ["memory [list]", 'memory search "<words>"', "memory forget <id>", "memory restore <id>", 'memory add "<text>"', "memory run"]) assert.ok(help.out.includes(`pnpm jarhead ${verb}`), verb);
  const memoryHelp = help.out.split("\n").filter((l) => /jarhead memory|--state|--kind/.test(l));
  assert.ok(memoryHelp.length >= 8, "the memory lines and their flags are in HELP");
  // Forget is a state: no memory verb is ever offered as "Delete"; the one mention says nothing is.
  for (const l of memoryHelp) assert.doesNotMatch(l, /\bDelete\b|\bdelete\b/, l);
  assert.match(help.out, /memory forget <id>.*Nothing is deleted/);
  assert.match(help.out, /ended \(no live process\) · unknown \(evidence missing\)/, "status rows know the new words");
});

/**
 * A daemon stand-in on a unix socket: the wire's frames in, `answer(msg)` out
 * (undefined = stay silent, like a daemon from before the memory module). Records
 * every frame the CLI sent so the test can read them back.
 */
function fakeDaemon(path: string, answer: (msg: ClientMessage) => unknown): Promise<{ server: Server; seen: ClientMessage[] }> {
  const seen: ClientMessage[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      const parser = new FrameParser();
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        for (const f of parser.push(chunk)) {
          if (f.type !== FRAME_JSON) continue;
          const msg = JSON.parse(f.payload.toString("utf8")) as ClientMessage;
          seen.push(msg);
          const reply = answer(msg);
          if (reply !== undefined) socket.write(encodeJson(reply));
        }
      });
    });
    server.listen(path, () => resolve({ server, seen }));
  });
}

const item = (id: string, text: string, state: MemoryItem["state"] = "live", kind: MemoryItem["kind"] = "preference"): MemoryItem => ({ id, kind, text, subjects: [], confidence: 0.9, importance: 0.5, createdAt: Date.now() - 86_400_000, lastSeenAt: Date.now() - 3 * 3_600_000, seenCount: state === "live" ? 2 : 1, sources: [], state, origin: "extracted" });

test("jarhead memory list|search against a daemon: the frames carry state and limit, items render one per line with the state suffix only when not live, the limit tail and the forget/restore words; a daemon that never answers is said so after the wait", async () => {
  const items = [item("m_tea1ab2", "Kevin likes his tea strong"), item("m_vim2cd3", "Kevin used Vim once, in 2019", "forgotten", "episode")];
  const answering = await fakeDaemon(join(stateDir, "a.sock"), (msg) => {
    if (msg.type === "memory.list") return { type: "memory.items", id: msg.id, items };
    if (msg.type === "memory.search") return { type: "memory.items", id: msg.id, items: items.slice(0, 1) };
    return undefined;
  });
  // Hears every frame, answers none: the daemon from before the memory module.
  const silent = await fakeDaemon(join(stateDir, "b.sock"), () => undefined);
  try {
    const t0 = Date.now();
    const [list, search, older] = await Promise.all([jarhead(["memory", "list", "--state", "all", "--limit", "2"], join(stateDir, "a.sock")), jarhead(["memory", "search", "tea", "please"], join(stateDir, "a.sock")), jarhead(["memory", "list"], join(stateDir, "b.sock"))]);

    assert.equal(list.code, 0, list.err);
    assert.match(list.out, /m_tea1ab2\s+preference\s+Kevin likes his tea strong  · seen 2× · 3 h ago/);
    assert.match(list.out, /m_vim2cd3\s+episode\s+Kevin used Vim once, in 2019 \(forgotten\)  · seen 1× · 3 h ago/, "the state suffix only when it is not the default");
    assert.match(list.out, /2 items · limit 2 \(--limit N for more\) · forget <id> hides one \(nothing is deleted\); restore <id> brings it back/);
    assert.doesNotMatch(list.out, /\bdelete\b|\bDelete\b/);

    assert.equal(search.code, 0, search.err);
    assert.match(search.out, /m_tea1ab2\s+preference\s+Kevin likes his tea strong  · seen 2×/);
    assert.doesNotMatch(search.out, /m_vim2cd3|\(forgotten\)/);
    assert.match(search.out, /\n  1 item\n/, "under the limit: no limit tail");

    // The frames as the daemon saw them: hello first, then the read with its state and limit.
    const frames = answering.seen.filter((m) => m.type !== "hello");
    const listFrame = frames.find((m) => m.type === "memory.list") as { type: string; id: string; state?: string; limit?: number };
    assert.equal(listFrame.state, "all");
    assert.equal(listFrame.limit, 2);
    assert.match(listFrame.id, /^cli_\d+_\d+$/);
    const searchFrame = frames.find((m) => m.type === "memory.search") as { type: string; query: string; limit?: number };
    assert.equal(searchFrame.query, "tea please", "the words after the verb, joined");
    assert.equal(searchFrame.limit, 30);
    assert.ok(answering.seen.some((m) => m.type === "hello"), "the client said hello first");

    assert.equal(older.code, 1);
    assert.match(older.err, /the daemon did not answer within 5 s \(a daemon from before the memory module has no memory frames\)/);
    assert.ok(Date.now() - t0 >= 5000, "it waited the whole bound before giving up");
    assert.ok(silent.seen.some((m) => m.type === "memory.list"), "the frame was sent; nothing came back");
  } finally {
    answering.server.close();
    silent.server.close();
  }
});
