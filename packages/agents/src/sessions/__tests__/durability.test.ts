import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLogSink } from "@jarhead/core";
import type { AgentInfo, AgentMessage, ConnectorHealth } from "@jarhead/protocol";
import { ClaudeCodeConnector } from "../../claude-code/connector.ts";
import { AsyncQueue } from "../../claude-code/queue.ts";
import { ClaudeSession, type SdkLike, type SdkMessage, type SdkUserMessage } from "../../claude-code/session.ts";
import { AgentRegistry } from "../../registry.ts";
import type { AgentConnector, TranscriptDelta } from "../../types.ts";
import { projectSlug } from "../claude-store.ts";
import { ClaudeTranscriptParser, claudeTurnMark } from "../claude-transcript.ts";
import { CodexTranscriptParser, codexTurnMark } from "../codex-transcript.ts";
import { SessionsConnector } from "../connector.ts";
import { DEFAULT_LEASES, deriveStatus, type Evidence } from "../liveness.ts";
import type { AgentProcess } from "../processes.ts";
import { CodexRun } from "../runners/codex.ts";
import { FileTail, LINE_HEAD_BYTES, LineAssembler, MAX_LINE_BYTES, splitLines, type Line, type TailEnd } from "../tail.ts";
import { TranscriptSource, readBackward, readTailPage, readWhole } from "../transcript.ts";
import { bigClaude, bigCodex, codexHome, fakeCodex, hugeLine, midTurn, signIn } from "./fixtures/gen.ts";

/**
 * Long-horizon durability, the connector's half (DECISIONS §1): status that cannot
 * stick, follows that end, paging by cursor, a parser that never assembles a 48 MB
 * line, and a poll that goes quiet. Every number the acceptance list asks for is
 * measured here and printed as a `[measure]` line.
 */

const ROOT = mkdtempSync(join(tmpdir(), "jarhead-durability-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const MiB = 1024 * 1024;
const claude = (): ClaudeTranscriptParser => new ClaudeTranscriptParser();
const codex = (): CodexTranscriptParser => new CodexTranscriptParser();
const T = (iso: string): number => Date.parse(iso);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const measure = (what: string, value: string): void => console.log(`[measure] ${what}: ${value}`);
const ms = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10;

async function until(check: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Generated once, shared by the tests below (about two seconds, 100 MB). */
let big: { claude: ReturnType<typeof bigClaude>; codex: ReturnType<typeof bigCodex> } | undefined;
function fixtures(): NonNullable<typeof big> {
  if (big) return big;
  const t0 = performance.now();
  big = { claude: bigClaude(join(ROOT, "big-claude.jsonl"), 50 * MiB), codex: bigCodex(join(ROOT, "big-codex.jsonl"), 50 * MiB) };
  measure("generate 50 MB Claude + 50 MB Codex fixtures", `${ms(t0)} ms (${big.claude.ids.length} + ${big.codex.ids.length} messages)`);
  return big;
}

const codexProc = (held: string[], over: Partial<AgentProcess> = {}): AgentProcess => ({
  pid: 4083,
  ppid: 686,
  startedAt: T("2026-08-31T00:00:00.000Z"),
  tool: "codex",
  command: "codex app-server",
  cwd: "/",
  interactive: false,
  sessionId: undefined,
  heldSessionIds: held,
  ...over,
});

/** Discovery pinned to the temp home (empty PATH, no Applications); `extra` are knobs for the fake codex child. */
function pinned(home: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; applicationsDir: string; cliSystemDirs: string[] } {
  const emptyBin = join(home, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  return { env: { PATH: emptyBin, HOME: home, ...extra }, applicationsDir: join(home, "Applications"), cliSystemDirs: [] };
}

/** One Codex rollout line. */
const codexLine = (ts: number, type: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: new Date(ts).toISOString(), ordinal: 1, type, payload });

/** A Claude that reports a fixed session id and answers every prompt with one text block (the transcript comes from the file). */
function fakeSdk(sessionId: string): SdkLike {
  return {
    query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }) {
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fable-5-1" });
      void (async () => {
        for await (const _m of prompt) {
          out.push({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
          out.push({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0 });
        }
        out.close();
      })();
      return Object.assign(out, { interrupt: async () => undefined });
    },
  } as SdkLike;
}

/** The fake SDK reports its id on the next tick; the connector looks the file up by it. */
function sdkIdKnown(c: ClaudeCodeConnector, id: string): boolean {
  return (c as unknown as { sessions: Map<string, { sessionId: string | undefined }> }).sessions.get(id.split(":")[1] ?? "")?.sessionId !== undefined;
}

// ------------------------------------------------------------------ liveness ---

test("deriveStatus: the table — archived, blocked, runs with their stall and finishing bounds, ended with no owner at any age, unknown only when degraded, the 30 s lease and the closing marker", () => {
  const now = 1_000_000_000;
  const base: Evidence = { archived: false, owners: 1, degraded: undefined, mtimeMs: now - 5_000, lastTurn: { kind: "open", at: now - 5_000 }, run: undefined, ask: false };
  const at = (e: Partial<Evidence>): [string, string] => {
    const r = deriveStatus({ ...base, ...e }, now, DEFAULT_LEASES);
    return [r.status, r.hint];
  };
  assert.deepEqual(at({ archived: true, owners: 0 }), ["done", "archived"]);
  assert.deepEqual(at({ ask: true, owners: 0 }), ["blocked", "blocked"], "an open question wins over everything but archived");
  // Runs of our own.
  assert.deepEqual(at({ run: { status: "working", detail: "thinking", since: now - 10_000 } }), ["working", "resumed"]);
  assert.deepEqual(at({ run: { status: "working", detail: "finishing", since: now - 10_000 } }), ["working", "resumed"], "finishing inside its grace");
  assert.deepEqual(at({ run: { status: "working", detail: "finishing", since: now - 31_000 } }), ["idle", "resumed"], "a turn that completed 31 s ago is idle whether or not the child exited");
  assert.deepEqual(at({ run: { status: "working", detail: "thinking", since: now - 299_000 } }), ["working", "resumed"]);
  assert.deepEqual(at({ run: { status: "working", detail: "thinking", since: now - 301_000 } }), ["unknown", "resumed"], "a working run with no event for 5 min has stalled");
  assert.deepEqual(at({ run: { status: "idle", detail: undefined, since: now - 3_600_000 } }), ["idle", "resumed"], "an idle run stays idle however long");
  assert.deepEqual(at({ run: { status: "blocked", detail: "permission: Bash", since: now } }), ["blocked", "resumed"]);
  assert.deepEqual(at({ owners: 0, run: { status: "offline", detail: "closed", since: now } }), ["ended", "ended"], "an offline run is no run: the file and the processes decide");
  // No run: owners and the lease.
  assert.deepEqual(at({ owners: 0 }), ["ended", "ended"]);
  assert.deepEqual(at({ owners: 0, mtimeMs: now - 3 * 86_400_000, lastTurn: undefined }), ["ended", "ended"], "three days old: still ended, never unknown for age");
  assert.deepEqual(at({ owners: 0, degraded: "ps failed" }), ["unknown", "unseen"], "no owner found while the snapshot is incomplete is not a verdict");
  assert.deepEqual(at({ owners: 2, degraded: "lsof failed" }), ["working", "running"], "owners found despite a degraded snapshot still count");
  assert.deepEqual(at({ lastTurn: { kind: "open", at: now - 30_000 } }), ["working", "running"], "at the edge of the lease");
  assert.deepEqual(at({ lastTurn: { kind: "open", at: now - 30_001 } }), ["idle", "quiet"], "past it");
  assert.deepEqual(at({ lastTurn: { kind: "closed", at: now - 1_000 } }), ["idle", "quiet"], "a closing marker ends the lease at once");
  assert.deepEqual(at({ mtimeMs: now, lastTurn: { kind: "open", at: now - 60_000 } }), ["idle", "quiet"], "a token_count write moved the mtime, not the lease");
  assert.deepEqual(at({ mtimeMs: now - 10_000, lastTurn: undefined }), ["working", "running"], "no markers at all: the mtime is the clock");
  assert.deepEqual(at({ mtimeMs: now - 31_000, lastTurn: undefined }), ["idle", "quiet"]);
});

test("turn markers: Codex task_started opens and task_complete/turn_aborted close, items keep the turn open, token_count and item_completed are noise; Claude user and tool_result lines open, end_turn closes, isMeta and sidechain lines are noise", () => {
  const ev = (type: string): string => JSON.stringify({ timestamp: "2026-09-01T09:00:00.000Z", ordinal: 1, type: "event_msg", payload: { type, x: 1 } });
  const item = (type: string): string => JSON.stringify({ timestamp: "2026-09-01T09:00:00.000Z", ordinal: 1, type: "response_item", payload: { type, id: "i" } });
  assert.equal(codexTurnMark(ev("task_started")), "open");
  assert.equal(codexTurnMark(ev("task_complete")), "closed");
  assert.equal(codexTurnMark(ev("turn_aborted")), "closed");
  assert.equal(codexTurnMark(ev("token_count")), undefined);
  assert.equal(codexTurnMark(ev("item_completed")), undefined);
  assert.equal(codexTurnMark(ev("thread_settings_applied")), undefined);
  for (const t of ["message", "reasoning", "function_call", "custom_tool_call", "local_shell_call", "function_call_output", "custom_tool_call_output"]) assert.equal(codexTurnMark(item(t)), "open", t);
  assert.equal(codexTurnMark(item("compaction")), undefined);
  assert.equal(codexTurnMark(JSON.stringify({ timestamp: "x", type: "token_usage_record", payload: {} })), undefined);
  assert.equal(codexTurnMark(JSON.stringify({ timestamp: "x", type: "session_meta", payload: { id: "a" } })), undefined);

  const cl = (o: Record<string, unknown>): string => JSON.stringify({ parentUuid: null, isSidechain: false, ...o, timestamp: "2026-09-01T10:00:00.000Z" });
  assert.equal(claudeTurnMark(cl({ type: "user", message: { role: "user", content: "go" } })), "open");
  assert.equal(claudeTurnMark(cl({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } })), "open");
  assert.equal(claudeTurnMark(cl({ type: "user", isMeta: true, message: { role: "user", content: "meta" } })), undefined);
  assert.equal(claudeTurnMark(cl({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi" }], stop_reason: null } })), "open");
  assert.equal(claudeTurnMark(cl({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }], stop_reason: "tool_use" } })), "open");
  assert.equal(claudeTurnMark(cl({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } })), "closed");
  assert.equal(claudeTurnMark(cl({ type: "assistant", isSidechain: true, message: { id: "m", content: [], stop_reason: "end_turn" } })), undefined);
  assert.equal(claudeTurnMark(JSON.stringify({ type: "queue-operation", operation: "enqueue" })), undefined);
  assert.equal(claudeTurnMark(JSON.stringify({ type: "system", subtype: "stop_hook_summary" })), undefined);

  // The parsers carry the same mark, with the line's time.
  const p = codex();
  p.push({ text: ev("task_started"), offset: 0 });
  assert.deepEqual(p.lastTurn, { kind: "open", at: T("2026-09-01T09:00:00.000Z") });
  p.push({ text: JSON.stringify({ timestamp: "2026-09-01T09:00:10.000Z", ordinal: 2, type: "event_msg", payload: { type: "token_count" } }), offset: 300 });
  assert.equal(p.lastTurn?.at, T("2026-09-01T09:00:00.000Z"), "token_count did not move it");
  p.push({ text: JSON.stringify({ timestamp: "2026-09-01T09:00:20.000Z", ordinal: 3, type: "event_msg", payload: { type: "task_complete" } }), offset: 400 });
  assert.deepEqual(p.lastTurn, { kind: "closed", at: T("2026-09-01T09:00:20.000Z") });
});

test("turn markers are not fooled by a transcript quoted inside a line: a tool_result whose content carries '\"type\":\"assistant\"' and '\"stop_reason\":\"end_turn\"' is still an open user turn (JSON escaping keeps the substrings apart); a Codex message quoting task_complete is still an item", () => {
  // `cat session.jsonl` as a tool result: the file's own lines land inside a string, every quote escaped.
  const quoted = JSON.stringify({ type: "assistant", isSidechain: false, message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
  const line = JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cat", content: `$ cat session.jsonl\n${quoted}\n${quoted}` }] }, uuid: "r", timestamp: "2026-09-01T10:00:00.000Z" });
  assert.ok(line.includes('\\"type\\":\\"assistant\\"') && line.includes('\\"stop_reason\\":\\"end_turn\\"'), "the quoted transcript is there, escaped");
  assert.ok(!line.includes('"type":"assistant"') && !line.includes('"stop_reason":"end_turn"'), "and never as the bare substrings the marker looks for");
  assert.equal(claudeTurnMark(line), "open");
  const p = claude();
  p.push({ text: line, offset: 0 });
  assert.deepEqual(p.lastTurn, { kind: "open", at: T("2026-09-01T10:00:00.000Z") }, "the parser marks the same");
  // A user line quoting an assistant line the other way round: `"type":"user"` inside an assistant's text.
  const assistant = JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: JSON.stringify({ type: "user", isMeta: true }) }], stop_reason: "end_turn" }, uuid: "a", timestamp: "2026-09-01T10:00:01.000Z" });
  assert.equal(claudeTurnMark(assistant), "closed");
  // Codex: an assistant message whose text quotes an event line is an item (open), not the event.
  const cx = codexLine(T("2026-09-01T09:00:00.000Z"), "response_item", { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) }] });
  assert.equal(codexTurnMark(cx), "open");
  const output = codexLine(T("2026-09-01T09:00:00.000Z"), "response_item", { type: "function_call_output", call_id: "c", output: JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted" } }) });
  assert.equal(codexTurnMark(output), "open");
});

test("liveness: a Codex process that died mid-tool — working while the pid holds the rollout, ended at the next poll (hint ended), its open call interrupted through settle(), never working 30 s after the last turn-bearing write", async () => {
  const home = mkdtempSync(join(ROOT, "home-midturn-"));
  const id = "01a0dead-0000-7000-8000-00000000dead";
  const paths = codexHome(home, id);
  const gen = midTurn(paths.rolloutPath, { id, cwd: join(home, "site") });
  let procs: AgentProcess[] = [codexProc([id])];
  let now = gen.lastAt + 5_000;
  const c = new SessionsConnector({ home, ...pinned(home), processes: async () => procs, now: () => now, processCacheMs: 0, pollMs: 20, maxAgeDays: 100_000 });
  const agentId = `sessions:codex:${id}`;
  const listed = (await c.list()).find((a) => a.id === agentId);
  assert.equal(listed?.status, "working", "task_started 5 s ago and the app-server holds the rollout");
  assert.equal(listed?.hint, "running");
  assert.equal(listed?.detail, `codex · ${listed?.messageCount ?? 0} msgs · site`, "no relative time in the detail");

  // The conversation is open in the Console: the last tool call is running.
  const page = await c.transcript(agentId, { limit: 10 });
  const open = page.messages.find((m) => m.id === gen.openCallId);
  assert.equal(open?.tool?.status, "running");

  // The process dies: at the next poll the session is ended, at any age.
  const seen: AgentInfo[] = [];
  const stop = c.subscribe((a) => seen.push(a));
  await sleep(60);
  const t0 = performance.now();
  procs = [];
  await until(() => seen.some((a) => a.id === agentId && a.status === "ended"), 3_000, "ended after the kill");
  const latency = ms(t0);
  measure("status → ended after the process died (poll 20 ms)", `${latency} ms; production bound POLL_ACTIVE_MS 5 s + ps timeout 2 s = 7 s`);
  assert.ok(latency < 500, `ended within a few polls (${latency} ms)`);
  const ended = seen.find((a) => a.status === "ended");
  assert.equal(ended?.hint, "ended");
  stop();

  // Its open call is cut off, not running for ever.
  const settled = await c.settle(agentId);
  assert.deepEqual(settled?.messages.map((m) => [m.id, m.tool?.status]), [[gen.openCallId, "interrupted"]]);
  assert.equal(await c.settle(agentId), undefined, "settled once");

  // Alive again but silent: the lease runs out 30 s after the last turn-bearing write, however often the mtime moves.
  procs = [codexProc([id])];
  now = gen.lastAt + 29_000;
  assert.equal((await c.list()).find((a) => a.id === agentId)?.status, "working");
  now = gen.lastAt + 31_000;
  appendFileSync(paths.rolloutPath, `${JSON.stringify({ timestamp: new Date(now).toISOString(), ordinal: 99, type: "event_msg", payload: { type: "token_count", info: {} } })}\n`);
  const quiet = (await c.list()).find((a) => a.id === agentId);
  assert.equal(quiet?.status, "idle", "a token_count write does not renew the lease");
  assert.equal(quiet?.hint, "quiet");
  // A closing marker ends it at once, even inside the lease.
  now = gen.lastAt + 32_000;
  appendFileSync(paths.rolloutPath, `${JSON.stringify({ timestamp: new Date(now).toISOString(), ordinal: 100, type: "event_msg", payload: { type: "task_complete", turn_id: "t" } })}\n`);
  assert.equal((await c.list()).find((a) => a.id === agentId)?.status, "idle");
  // And a new turn renews it.
  now = gen.lastAt + 33_000;
  appendFileSync(paths.rolloutPath, `${JSON.stringify({ timestamp: new Date(now).toISOString(), ordinal: 101, type: "event_msg", payload: { type: "task_started", turn_id: "t2" } })}\n`);
  assert.equal((await c.list()).find((a) => a.id === agentId)?.status, "working");
  await c.closeAll();
});

test("subscribe: three quiet simulated minutes emit zero changes; a session that leaves the listing is reported gone; a list() that never settles is abandoned after pollStuckMs with one info line, and later ticks run", async () => {
  const home = mkdtempSync(join(ROOT, "home-quiet-"));
  const id = "01a0c001-0000-7000-8000-00000000c001";
  const paths = codexHome(home, id);
  const gen = bigCodex(paths.rolloutPath, 20 * 1024, { id, hugeLineBytes: 0 });
  const other = codexHome(home, "01a0c002-0000-7000-8000-00000000c002", "2026/09/01", "2026-09-01T11-00-00");
  bigCodex(other.rolloutPath, 8 * 1024, { id: "01a0c002-0000-7000-8000-00000000c002", hugeLineBytes: 0, startAt: gen.lastAt + 60_000 });
  let now = gen.lastAt + 120_000;
  const lines: string[] = [];
  const unsink = addLogSink((level, scope, message) => {
    if (scope === "agents.sessions" && level === "info") lines.push(message);
  });
  try {
    const c = new SessionsConnector({ home, ...pinned(home), processes: async () => [codexProc([id])], now: () => now, processCacheMs: 0, pollMs: 15, pollQuietMs: 15, pollStuckMs: 120, maxAgeDays: 100_000 });
    await c.list();
    const changes: AgentInfo[] = [];
    const gone: string[] = [];
    const stop = c.subscribe((a) => changes.push(a), (goneId) => gone.push(goneId));
    // Three minutes pass with nothing written: the clock alone changes nothing.
    for (let i = 0; i < 12; i += 1) {
      now += 15_000;
      await sleep(25);
    }
    assert.equal(changes.length, 0, `no relative-time churn: zero onChange in three quiet minutes (${changes.map((a) => `${a.id} ${a.status}`).join(", ")})`);

    // A file leaves the listing (aged out here by deleting the test copy): its id is reported gone once.
    unlinkSync(other.rolloutPath);
    await until(() => gone.length === 1, 2_000, "the gone id");
    assert.equal(gone[0], "sessions:codex:01a0c002-0000-7000-8000-00000000c002");
    await sleep(60);
    assert.equal(gone.length, 1);

    // One scan hangs for ever: the poll abandons it after pollStuckMs, says so once, and goes on.
    const realScan = c.claude.scan.bind(c.claude);
    let hung = 0;
    c.claude.scan = () => {
      if (hung === 0) {
        hung += 1;
        return new Promise(() => undefined);
      }
      return realScan();
    };
    await until(() => hung === 1, 1_000, "the hanging scan");
    await sleep(40);
    assert.equal(changes.length, 0, "nothing delivered while stuck");
    // A real write lands meanwhile; it must reach the subscriber once the stuck tick is abandoned.
    now += 1_000;
    appendFileSync(paths.rolloutPath, `${JSON.stringify({ timestamp: new Date(now).toISOString(), ordinal: 9_000, type: "event_msg", payload: { type: "task_started", turn_id: "tz" } })}\n`);
    await until(() => changes.some((a) => a.id === `sessions:codex:${id}`), 3_000, "a change after the stuck tick was abandoned");
    assert.equal(lines.filter((l) => /poll stuck for \d+ s; abandoning it/.test(l)).length, 1, `one info line: ${lines.join(" | ")}`);
    stop();
    await c.closeAll();
  } finally {
    unsink();
  }
});

test("waitSettled on a run whose child stopped talking: resolves when the rail's rule reads unknown (runStallMs), long before the turn budget — agent_wait and the rail agree", async () => {
  const home = mkdtempSync(join(ROOT, "home-stall-"));
  const id = "01a0c0ff-0000-7000-8000-00000000c0ff";
  const paths = codexHome(home, id);
  const cwd = join(home, "site");
  mkdirSync(cwd);
  bigCodex(paths.rolloutPath, 6 * 1024, { id, cwd, hugeLineBytes: 0 });
  signIn(home);
  // The fake answers `exec resume` with thread.started + turn.started, then nothing, for ever.
  const c = new SessionsConnector({ home, ...pinned(home, { FAKE_CODEX_MODE: "hang" }), codexBin: fakeCodex(home), processes: async () => [], processCacheMs: 0, leases: { runStallMs: 150 }, codexTurnBudgetMs: 20_000, codexKillGraceMs: 100, maxAgeDays: 100_000 });
  const agentId = `sessions:codex:${id}`;
  assert.equal((await c.list()).find((a) => a.id === agentId)?.status, "ended", "no process owns the rollout");
  assert.deepEqual(await c.send(agentId, "go on"), { accepted: true, detail: "resumed headlessly" }, "an ended thread is still resumable");
  const t0 = performance.now();
  const settled = await c.waitSettled(agentId, 5_000);
  const took = ms(t0);
  measure("waitSettled on a stalled run (runStallMs 150)", `${took} ms; production RUN_STALL_MS 5 min against a 15 min turn budget`);
  assert.equal(settled.status, "unknown");
  assert.equal(settled.hint, "resumed");
  assert.match(settled.detail ?? "", /^codex · \d+ msgs · site · resumed: thinking$/, "the run's own detail, no relative time");
  assert.ok(took >= 120 && took < 2_000, `settled when the stall bound ran out, not at the turn budget (${took} ms)`);
  assert.equal((await c.list()).find((a) => a.id === agentId)?.status, "unknown", "the rail reads the same");
  await c.closeAll();
});

test("subscribe with the real clock: a list() that never settles is abandoned at pollStuckMs, said once, and the next tick delivers", async () => {
  const home = mkdtempSync(join(ROOT, "home-stuck-"));
  const id = "01a0c003-0000-7000-8000-00000000c003";
  const paths = codexHome(home, id);
  bigCodex(paths.rolloutPath, 6 * 1024, { id, hugeLineBytes: 0, startAt: Date.now() - 600_000 });
  const lines: string[] = [];
  const unsink = addLogSink((level, scope, message) => {
    if (scope === "agents.sessions" && level === "info") lines.push(message);
  });
  try {
    // No `now` here: Date.now, as in production, drives the watchdog.
    const c = new SessionsConnector({ home, ...pinned(home), processes: async () => [codexProc([id])], processCacheMs: 0, pollMs: 15, pollQuietMs: 15, pollStuckMs: 100, maxAgeDays: 100_000 });
    const agentId = `sessions:codex:${id}`;
    assert.equal((await c.list()).find((a) => a.id === agentId)?.status, "idle", "task_complete closed the last turn ten minutes ago");
    const realScan = c.claude.scan.bind(c.claude);
    let hung = 0;
    c.claude.scan = () => {
      if (hung++ === 0) return new Promise(() => undefined);
      return realScan();
    };
    const changes: AgentInfo[] = [];
    const stop = c.subscribe((a) => changes.push(a));
    await until(() => hung >= 1, 1_000, "the hanging scan");
    const t0 = performance.now();
    appendFileSync(paths.rolloutPath, `${codexLine(Date.now(), "event_msg", { type: "task_started", turn_id: "tz" })}\n`);
    await until(() => changes.some((a) => a.id === agentId && a.status === "working"), 3_000, "a change once the stuck tick was abandoned");
    measure("stuck poll abandoned with Date.now (pollStuckMs 100)", `${ms(t0)} ms until the next tick delivered; production POLL_STUCK_MS 60 s`);
    assert.equal(lines.filter((l) => /poll stuck for \d+ s; abandoning it/.test(l)).length, 1, `one info line: ${lines.join(" | ")}`);
    stop();
    await c.closeAll();
  } finally {
    unsink();
  }
});

test("registry: onGone prunes a known agent and broadcasts without it; refresh() still rebuilds", async () => {
  let onChange: ((a: AgentInfo) => void) | undefined;
  let onGone: ((id: string) => void) | undefined;
  const fake: AgentConnector = {
    kind: "sessions",
    health: async (): Promise<ConnectorHealth> => ({ kind: "sessions", ok: true, detail: "" }),
    list: async (): Promise<AgentInfo[]> => [],
    send: async () => ({ accepted: true }),
    read: async () => "",
    subscribe: (c, g) => {
      onChange = c;
      onGone = g;
      return () => undefined;
    },
  };
  const reg = new AgentRegistry([fake], 0);
  const broadcasts: string[][] = [];
  reg.onChange((agents) => broadcasts.push(agents.map((a) => a.id)));
  const a: AgentInfo = { id: "sessions:codex:a", kind: "sessions", name: "a", status: "working", updatedAt: 1 };
  onChange?.(a);
  onChange?.({ ...a, id: "sessions:codex:b" });
  onGone?.("sessions:codex:a");
  onGone?.("sessions:codex:a");
  assert.deepEqual(broadcasts, [["sessions:codex:a"], ["sessions:codex:a", "sessions:codex:b"], ["sessions:codex:b"]], "gone once: pruned and broadcast once");
  await reg.refresh();
  assert.deepEqual(broadcasts.at(-1), [], "refresh rebuilds from list()");
});

// ---------------------------------------------------------------------- tail ---

test("tail: a deleted file ends the follow within goneAfterMs (gone); a new inode at the path ends it (replaced); a shrink ends it (truncated); a file not yet written never ends", async () => {
  const dir = mkdtempSync(join(ROOT, "tail-"));
  const follow = (path: string): { ends: TailEnd[]; lines: Line[]; tail: FileTail } => {
    const ends: TailEnd[] = [];
    const lines: Line[] = [];
    const tail = new FileTail({ path, offset: 0, onLines: (l) => lines.push(...l), onEnd: (r) => ends.push(r), pollMs: 20, coalesceMs: 5, goneAfterMs: 100 });
    return { ends, lines, tail };
  };

  const gonePath = join(dir, "gone.jsonl");
  writeFileSync(gonePath, "a\n");
  const gone = follow(gonePath);
  await until(() => gone.lines.length === 1, 2_000, "first line");
  const t0 = performance.now();
  unlinkSync(gonePath);
  await until(() => gone.ends.length === 1, 2_000, "gone");
  const took = ms(t0);
  measure("FileTail gone after unlink (goneAfterMs 100, poll 20)", `${took} ms`);
  assert.deepEqual(gone.ends, ["gone"]);
  assert.ok(took >= 90 && took < 400, `ended after the grace, not before (${took} ms)`);

  const replacedPath = join(dir, "replaced.jsonl");
  writeFileSync(replacedPath, "a\n");
  const replaced = follow(replacedPath);
  await until(() => replaced.lines.length === 1, 2_000, "first line");
  unlinkSync(replacedPath);
  writeFileSync(replacedPath, "b\nc\n");
  await until(() => replaced.ends.length === 1, 2_000, "replaced");
  assert.deepEqual(replaced.ends, ["replaced"]);
  assert.deepEqual(replaced.lines.map((l) => l.text), ["a"], "nothing of the other file is read as this one");

  const truncatedPath = join(dir, "truncated.jsonl");
  writeFileSync(truncatedPath, "a\nb\n");
  const truncated = follow(truncatedPath);
  await until(() => truncated.lines.length === 2, 2_000, "two lines");
  truncateSync(truncatedPath, 0);
  await until(() => truncated.ends.length === 1, 2_000, "truncated");
  assert.deepEqual(truncated.ends, ["truncated"]);

  const laterPath = join(dir, "later.jsonl");
  const later = follow(laterPath);
  await sleep(250);
  assert.deepEqual(later.ends, [], "a file that was never there is waited for, not given up on");
  writeFileSync(laterPath, "z\n");
  await until(() => later.lines.length === 1, 2_000, "the late file");
  later.tail.close();
});

test("watch: a rollout Codex moved to archived_sessions is followed on from the same byte — no gap, no replay, no end signal; a rollout that vanishes ends the watch 'gone' within goneAfterMs", async () => {
  const home = mkdtempSync(join(ROOT, "home-move-"));
  const id = "01a0abcd-0000-7000-8000-00000000abcd";
  const paths = codexHome(home, id);
  const gen = bigCodex(paths.rolloutPath, 6 * 1024, { id, hugeLineBytes: 0 });
  const c = new SessionsConnector({ home, ...pinned(home), processes: async () => [codexProc([id])], now: () => gen.lastAt + 1_000, processCacheMs: 0, tailPollMs: 20, tailCoalesceMs: 5, tailGoneAfterMs: 100, maxAgeDays: 100_000 });
  const agentId = `sessions:codex:${id}`;
  const page = await c.transcript(agentId, { limit: 4 });
  assert.equal(page.messages.length, 4);
  const deltas: TranscriptDelta[] = [];
  const ends: string[] = [];
  const stop = c.watch(agentId, (d) => deltas.push(d), (r) => ends.push(r));
  await sleep(80);
  const turn = (k: number, ts: number): string =>
    [
      JSON.stringify({ timestamp: new Date(ts).toISOString(), ordinal: 500 + k, type: "event_msg", payload: { type: "task_started", turn_id: `x${k}` } }),
      JSON.stringify({ timestamp: new Date(ts).toISOString(), ordinal: 510 + k, type: "response_item", payload: { type: "message", id: `mx${k}`, role: "user", content: [{ type: "input_text", text: `after ${k}` }] } }),
    ].join("\n") + "\n";
  appendFileSync(paths.rolloutPath, turn(1, gen.lastAt + 2_000));
  await until(() => deltas.length === 1, 2_000, "a delta before the move");
  assert.deepEqual(deltas[0]?.messages.map((m) => m.id), ["mx1"]);

  // Codex archives the thread: the rollout moves. The follow goes on from the same byte in the new file.
  renameSync(paths.rolloutPath, paths.archivedPath);
  await sleep(250); // past goneAfterMs: the old path is gone, the new one resolved
  assert.deepEqual(ends, [], "no end signal for a move");
  appendFileSync(paths.archivedPath, turn(2, gen.lastAt + 3_000));
  await until(() => deltas.length === 2, 3_000, "a delta from the archived file");
  assert.deepEqual(deltas[1]?.messages.map((m) => m.id), ["mx2"], "only the new turn: nothing replayed, nothing missed");
  assert.equal((await c.list()).find((a) => a.id === agentId)?.hint, "archived");

  // Gone for good: the watch ends, once, with the reason.
  const t0 = performance.now();
  unlinkSync(paths.archivedPath);
  await until(() => ends.length === 1, 3_000, "gone");
  measure("watch ended after the file vanished (goneAfterMs 100)", `${ms(t0)} ms; production goneAfterMs 10 s`);
  assert.deepEqual(ends, ["gone"]);
  stop();
  await c.closeAll();
});

// -------------------------------------------------------------------- parser ---

test("parser: a 48 MB single line is never assembled — skipped as one line with its 4 KB head, the tool output it was becomes '[output of 48 MB skipped]', the lines around it parse, under 300 ms with bounded memory", async () => {
  const path = join(ROOT, "huge-line.jsonl");
  const gen = hugeLine(path, 48 * MiB);
  assert.ok(gen.bytes > 48 * MiB);
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const page = await readTailPage(path, codex, 60);
  const took = ms(t0);
  const grew = process.memoryUsage().rss - rss0;
  measure("48 MB single line: tail page", `${took} ms, RSS +${Math.round(grew / MiB)} MB, ${page.bytesRead / MiB | 0} MB read`);
  assert.ok(took < 300, `under 300 ms (${took} ms)`);
  assert.ok(grew < 64 * MiB, `RSS growth under 64 MB (+${Math.round(grew / MiB)} MB)`);
  assert.equal(page.complete, true);
  const huge = page.messages.find((m) => m.id === gen.hugeCallId);
  assert.equal(huge?.tool?.status, "done", "the call whose output was skipped is not left running");
  assert.equal(huge?.tool?.output, "[output of 48 MB skipped]");
  assert.ok(!page.messages.some((m) => m.role === "system"), "an output that found its call needs no system row");
  const around = page.messages.filter((m) => m.role === "tool" && m.id !== gen.hugeCallId);
  assert.ok(around.length >= 4 && around.every((m) => m.tool?.status === "done" && (m.tool.output?.length ?? 0) > 10), "the calls before and after have their outputs");
  assert.deepEqual(page.messages.map((m) => m.id), gen.ids, "every message, in order, as generated");

  // A huge line that is not an output stands in the conversation as one system row.
  const reasoningPath = join(ROOT, "huge-reasoning.jsonl");
  const other = hugeLine(reasoningPath, 5 * MiB, { asOutput: false });
  const whole = await readWhole(reasoningPath, codex);
  assert.deepEqual(whole.messages.map((m) => [m.id, m.role, m.text]), [
    ["m0u", "user", "think hard"],
    [`L${other.hugeLineOffset}`, "system", "[one 5 MB line skipped]"],
    ["m0a", "assistant", "Thought about it."],
  ]);
});

test("LineAssembler / splitLines: a line over MAX_LINE_BYTES comes back skipped with its head, whether it arrives in one buffer or across chunks; the lines after it are intact; a torn line still waits", () => {
  const head = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_z", output: "" } }).slice(0, -3);
  const one = Buffer.concat([Buffer.from("a\n"), Buffer.from(head), Buffer.alloc(MAX_LINE_BYTES + 10, "y"), Buffer.from('"}}\nb\n')]);
  const { lines, rest } = splitLines(one, 100);
  assert.equal(rest, undefined);
  assert.deepEqual(lines.map((l) => [l.text, l.offset, l.skippedBytes]), [["a", 100, undefined], ["", 102, head.length + MAX_LINE_BYTES + 10 + 3], ["b", 102 + head.length + MAX_LINE_BYTES + 10 + 3 + 1, undefined]]);
  assert.equal(lines[1]?.head?.length, LINE_HEAD_BYTES);
  assert.ok(lines[1]?.head?.toString("utf8", 0, head.length) === head, "the head is the start of the line");

  const asm = new LineAssembler(1024);
  const chunks = [Buffer.from("x\n" + "q".repeat(600)), Buffer.alloc(700, "q"), Buffer.concat([Buffer.alloc(300, "q"), Buffer.from("\nafter\ntorn")])];
  let base = 0;
  const got: Line[] = [];
  for (const c of chunks) {
    got.push(...asm.push(c, base));
    base += c.length;
  }
  assert.deepEqual(got.map((l) => [l.text, l.offset, l.skippedBytes]), [["x", 0, undefined], ["", 2, 1600], ["after", 1603, undefined]]);
  assert.equal(got[1]?.head?.toString(), "q".repeat(1300), "the head is what had arrived when the line was found too long (up to 4 KB)");
  assert.equal(asm.pendingOffset, 1609, "the torn tail waits");
  assert.deepEqual(asm.push(Buffer.from(" line\n"), base).map((l) => l.text), ["torn line"]);
  assert.equal(asm.pendingOffset, undefined);
});

test("parser: results whose call is out of view are kept as orphans and adopted by the page that holds the call; offsetOf survives trimming; interruptOpenCalls flips every running call once", () => {
  const item = (payload: Record<string, unknown>, ts = "2026-09-01T09:00:00.000Z"): string => JSON.stringify({ timestamp: ts, type: "response_item", payload });
  const older = codex();
  older.push({ text: item({ type: "function_call", id: "fc_a", name: "exec_command", arguments: '{"cmd":"a"}', call_id: "call_a" }), offset: 0 });
  older.push({ text: item({ type: "function_call", id: "fc_b", name: "exec_command", arguments: '{"cmd":"b"}', call_id: "call_b" }), offset: 200 });
  older.push({ text: item({ type: "function_call", id: "fc_c", name: "exec_command", arguments: '{"cmd":"c"}', call_id: "call_c" }), offset: 400 });
  older.take(); // the page is on screen
  const newer = codex();
  newer.push({ text: item({ type: "function_call_output", id: "o_a", call_id: "call_a", output: '{"exit_code":0,"output":"A"}' }), offset: 600 });
  newer.push({ text: item({ type: "function_call_output", id: "o_b", call_id: "call_b", output: '{"exit_code":2,"output":"B"}' }), offset: 800 });
  assert.deepEqual([...newer.orphans.keys()], ["call_a", "call_b"], "results with no call in view are orphans, not dropped");
  assert.equal(newer.all().length, 0);
  assert.equal(older.adoptResults(newer), 2);
  assert.deepEqual(older.all().map((m) => [m.id, m.tool?.status, m.tool?.output]), [["call_a", "done", '{"exit_code":0,"output":"A"}'], ["call_b", "error", '{"exit_code":2,"output":"B"}'], ["call_c", "running", undefined]]);
  assert.deepEqual(older.take().map((m) => m.id), ["call_a", "call_b"], "adopted results are changes");
  assert.deepEqual(older.interruptOpenCalls().map((m) => [m.id, m.tool?.status]), [["call_c", "interrupted"]]);
  assert.deepEqual(older.interruptOpenCalls(), [], "once");
  assert.equal(older.offsetOf("call_b"), 200);

  // A parser bounded for a long follow keeps offsets of what it dropped.
  const long = codex();
  long.bound(3);
  for (let i = 0; i < 10; i += 1) long.push({ text: item({ type: "message", id: `m${i}`, role: "user", content: [{ type: "input_text", text: `turn ${i}` }] }), offset: i * 100 });
  assert.equal(long.count, 3, "three drafts held");
  assert.equal(long.added, 10, "ten ever added");
  assert.equal(long.offsetOf("m0"), 0, "offsets outlive the drafts");
  assert.deepEqual(long.all().map((m) => m.id), ["m7", "m8", "m9"]);
});

// -------------------------------------------------------------------- paging ---

test("open: the 50 MB fixture's newest page — cold and warm timings, cursor, exact ids", async () => {
  const { claude: cl, codex: cx } = fixtures();
  for (const [name, gen, make] of [["Claude", cl, claude], ["Codex", cx, codex]] as const) {
    const cold0 = performance.now();
    const source = new TranscriptSource({ path: gen.path, makeParser: make });
    const page = await source.page({ limit: 60 });
    const cold = ms(cold0);
    const warm0 = performance.now();
    const again = await new TranscriptSource({ path: gen.path, makeParser: make }).page({ limit: 60 });
    const warm = ms(warm0);
    measure(`open 50 MB ${name} (newest 60)`, `cold ${cold} ms, warm ${warm} ms`);
    assert.ok(cold < 300, `${name} cold under 300 ms (${cold} ms)`);
    assert.ok(warm < 30, `${name} warm under 30 ms (${warm} ms)`);
    assert.deepEqual(page.messages.map((m) => m.id), gen.ids.slice(-60));
    assert.deepEqual(again.messages, page.messages);
    assert.equal(page.complete, false);
    assert.equal(page.cursor?.endOffset, gen.bytes);
    assert.ok(page.cursor && page.cursor.startOffset < gen.bytes && page.cursor.startOffset > gen.bytes - 2 * MiB, "the cursor points into the tail of the file");
    assert.ok(page.total > 60);
  }
});

test("Load earlier by cursor: pages tile the 50 MB fixture exactly (ids identical to one whole read), each read costs at most twice its own span plus one slice, never the distance from the end; a `before` id the app still holds after trimming resolves; an unknown id pages on from the oldest byte served", async () => {
  const { claude: gen } = fixtures();
  const source = new TranscriptSource({ path: gen.path, makeParser: claude });
  const LIMIT = 500;
  const first = await source.page({ limit: LIMIT });
  const pages: AgentMessage[][] = [[...first.messages]];
  let before = first.messages[0]!.id;
  let complete = first.complete;
  const t0 = performance.now();
  let maxPageMs = 0;
  while (!complete) {
    const p0 = performance.now();
    const older = await source.page({ limit: LIMIT, before });
    maxPageMs = Math.max(maxPageMs, ms(p0));
    assert.ok(older.messages.length >= 1 || older.complete, "every ask yields a message or the start of the file");
    pages.unshift([...older.messages]);
    complete = older.complete;
    if (!complete) {
      assert.equal(older.messages.length, LIMIT);
      before = older.messages[0]!.id;
    }
  }
  const walk = ms(t0);
  measure(`Load earlier through 50 MB Claude (${pages.length} pages of ${LIMIT})`, `${walk} ms total, slowest page ${maxPageMs} ms`);
  const whole0 = performance.now();
  const whole = await readWhole(gen.path, claude);
  measure("readWhole 50 MB Claude (reference)", `${ms(whole0)} ms`);
  const tiled = pages.flat();
  assert.equal(tiled.length, whole.messages.length);
  assert.deepEqual(tiled.map((m) => m.id), whole.messages.map((m) => m.id), "no gap, no overlap");
  assert.ok(tiled.every((m) => m.role !== "tool" || m.tool?.status === "done"), "every call found its result, across page boundaries too");
  const last = pages[0]!;
  assert.equal((await source.page({ limit: LIMIT, before: last[0]!.id })).complete, true, "before the very first message: an empty, complete page");

  // Cost per page: read backward from the cursor, doubling from 256 KB — never from the file's end.
  const size = statSync(gen.path).size;
  let worst = 0;
  for (const fraction of [0.9, 0.5, 0.1, 0.02]) {
    const from = Math.floor(size * fraction);
    const read = await readBackward(gen.path, claude, 60, from);
    assert.equal(read.messages.length, 60);
    assert.equal(read.endOffset, from);
    const span = read.endOffset - read.startOffset;
    worst = Math.max(worst, read.bytesRead / span);
    assert.ok(read.bytesRead <= 2 * span + 256 * 1024, `bytes read ${read.bytesRead} ≤ 2 × span ${span} + 256 KB at ${fraction}`);
  }
  measure("readBackward bytes read / page span (worst of 4 cursors)", `${worst.toFixed(2)}×`);

  // The app trimmed to its newest 400 and asks for the page before one of them: the id resolves to its byte, wherever the page it came from.
  const fresh = new TranscriptSource({ path: gen.path, makeParser: claude });
  const newest = await fresh.page({ limit: 60 });
  const older = await fresh.page({ limit: 60, before: newest.messages[0]!.id });
  const mid = older.messages[30]!;
  const beforeMid = await fresh.page({ limit: 20, before: mid.id });
  assert.deepEqual(beforeMid.messages.map((m) => m.id), older.messages.slice(10, 30).map((m) => m.id), "a message from the middle of an older page is a cursor too");
  // An id nobody here served: page on from the oldest byte this source has covered.
  const unknown = await fresh.page({ limit: 20, before: "never-seen" });
  assert.deepEqual(unknown.messages.map((m) => m.id), gen.ids.slice(gen.ids.indexOf(older.messages[0]!.id) - 20, gen.ids.indexOf(older.messages[0]!.id)));
  // And by byte, straight from a cursor the app was told.
  const byOffset = await fresh.page({ limit: 20, beforeOffset: older.cursor!.startOffset });
  assert.deepEqual(byOffset.messages, unknown.messages);
});

test("Load earlier across parallel tool calls: a page boundary inside a group of four calls leaves none of them running at limits 7, 13, 23 and 60 — the older page adopts what the newer page's slices held", async () => {
  const gen = bigClaude(join(ROOT, "parallel-claude.jsonl"), 6 * MiB, { toolsPerRound: 4, seed: 3 });
  const whole = await readWhole(gen.path, claude);
  const calls = whole.messages.filter((m) => m.role === "tool").length;
  assert.ok(calls >= 600, `enough calls to split (${calls})`);
  assert.deepEqual(whole.messages.map((m) => m.id), gen.ids);
  for (const limit of [7, 13, 23, 60]) {
    const source = new TranscriptSource({ path: gen.path, makeParser: claude });
    const t0 = performance.now();
    let page = await source.page({ limit });
    const pages: AgentMessage[][] = [[...page.messages]];
    while (!page.complete) {
      page = await source.page({ limit, before: pages[0]![0]!.id });
      assert.ok(page.messages.length >= 1 || page.complete, `limit ${limit}: every ask yields a message or the start`);
      pages.unshift([...page.messages]);
    }
    const tiled = pages.flat();
    assert.deepEqual(tiled.map((m) => m.id), gen.ids, `limit ${limit}: the pages tile the file exactly`);
    const running = tiled.filter((m) => m.role === "tool" && m.tool?.status !== "done");
    assert.equal(running.length, 0, `limit ${limit}: ${running.length} of ${calls} calls not done (${running.slice(0, 6).map((m) => `${m.id} ${m.tool?.status}`).join(", ")})`);
    assert.ok(tiled.every((m) => m.role !== "tool" || (m.tool?.output?.length ?? 0) > 10), `limit ${limit}: every call has its output`);
    measure(`parallel calls tiled at limit ${limit} (${pages.length} pages)`, `${ms(t0)} ms`);
  }

  // The mechanism, bare: a backward read spills the results its slices held for calls it did not show,
  // and a read told about them shows none of its calls running.
  const size = statSync(gen.path).size;
  const newer = await readBackward(gen.path, claude, 13, size);
  // Walk to a cursor that splits a group of four: the page's first message is one of the group's later calls.
  let cursor = newer;
  let spilled = newer.orphans;
  for (let i = 0; i < 40 && !/^toolu_\d+_[123]$/.test(cursor.messages[0]?.id ?? ""); i += 1) {
    cursor = await readBackward(gen.path, claude, 13, cursor.startOffset, {}, { resultFor: (id) => spilled.get(id) });
    spilled = new Map([...spilled, ...cursor.orphans]);
  }
  assert.match(cursor.messages[0]?.id ?? "", /^toolu_\d+_[123]$/, "found a boundary inside a group");
  assert.ok(cursor.orphans.size >= 1, `the newer page spilled what the older one needs (${cursor.orphans.size})`);
  const blind = await readBackward(gen.path, claude, 13, cursor.startOffset);
  assert.ok(blind.messages.some((m) => m.tool?.status === "running"), "without the spill the older side of the group reads running (the bug)");
  const told = await readBackward(gen.path, claude, 13, cursor.startOffset, {}, { resultFor: (id) => cursor.orphans.get(id) });
  assert.deepEqual(told.messages.map((m) => m.id), blind.messages.map((m) => m.id));
  assert.ok(told.messages.every((m) => m.role !== "tool" || m.tool?.status === "done"), "told, every call is done");
});

test("readBackward at its bound: a single line longer than the doubling slices' summed reach is still read whole when the bound allows it — every ask yields a message or the start of the file (maxBytes 2 MiB, a 1.5 MiB output line)", async () => {
  const gen = bigCodex(join(ROOT, "cap-reach.jsonl"), 3 * MiB, { hugeLineBytes: Math.floor(1.5 * MiB), hugeAt: 0.9, seed: 5 });
  const whole = await readWhole(gen.path, codex);
  const k = gen.hugeCallId!.slice("call_".length);
  // The cursor sits just past the 1.5 MiB output: the page before it must read back across the line.
  const cursor = whole.parser.offsetOf(`m${k}a`)!;
  assert.ok(cursor > 2 * MiB, "more than the bound lies before the cursor: the file's start is out of reach");
  const read = await readBackward(gen.path, codex, 60, cursor, { maxBytes: 2 * MiB });
  measure("readBackward across a 1.5 MiB line with a 2 MiB bound", `${read.messages.length} messages, ${(read.bytesRead / MiB).toFixed(2)} MB read, reach ${((cursor - read.startOffset) / MiB).toFixed(2)} MB`);
  assert.ok(read.messages.length >= 1, `a page, not an empty one (${read.messages.length})`);
  assert.equal(read.complete, false);
  assert.ok(cursor - read.startOffset <= 2 * MiB, "the bound is the reach back from the cursor");
  assert.ok(read.bytesRead > 2 * MiB, "the unproductive slices still count as cost (256 KB + 512 KB + 1 MiB before the 2 MiB one)");
  const huge = read.messages.find((m) => m.id === gen.hugeCallId);
  assert.equal(huge?.tool?.status, "done", "the call whose output is the long line");
  assert.match(huge?.tool?.output ?? "", /… \(\+\d+ chars\)$/, "a 1.5 MiB output is assembled (under MAX_LINE_BYTES) and clipped");
  // And the ask before it goes on from where this one began, as before.
  const before = await readBackward(gen.path, codex, 60, read.startOffset, { maxBytes: 2 * MiB });
  assert.equal(before.messages.length, 60);
  assert.equal(before.messages.at(-1)!.id, gen.ids[gen.ids.indexOf(read.messages[0]!.id) - 1]);
});

test("event loop: while a 14 MB page parses and while the Codex fixture with an 8 MiB line is read, setImmediate latency stays under 100 ms", async () => {
  const { claude: cl, codex: cx } = fixtures();
  const probe = (): { stop: () => number } => {
    let max = 0;
    let last = performance.now();
    let on = true;
    const tick = (): void => {
      const now = performance.now();
      max = Math.max(max, now - last);
      last = now;
      if (on) setImmediate(tick);
    };
    setImmediate(tick);
    return {
      stop: () => {
        on = false;
        return Math.round(max * 10) / 10;
      },
    };
  };
  const size = statSync(cl.path).size;
  const p1 = probe();
  const t1 = performance.now();
  const big = await readBackward(cl.path, claude, 20_000, size);
  const bigMs = ms(t1);
  const gap1 = p1.stop();
  measure(`setImmediate max gap during a ${(big.bytesRead / MiB).toFixed(1)} MB backward read (${big.messages.length} msgs, ${bigMs} ms)`, `${gap1} ms`);
  assert.ok(gap1 < 100, `gap ${gap1} ms`);

  const p2 = probe();
  const t2 = performance.now();
  // A cursor just past the 8 MiB line: the page before it has to read back across the line to fill up.
  const huge = await readBackward(cx.path, codex, 60, cx.hugeLineEnd! + 600);
  assert.ok(huge.bytesRead > 8 * MiB, `read across the line (${(huge.bytesRead / MiB).toFixed(1)} MB)`);
  const hugeMs = ms(t2);
  const gap2 = p2.stop();
  measure(`setImmediate max gap reading across the 8 MiB line (${(huge.bytesRead / MiB).toFixed(1)} MB, ${hugeMs} ms)`, `${gap2} ms`);
  assert.ok(gap2 < 100, `gap ${gap2} ms`);
  const skipped = huge.messages.find((m) => m.id === cx.hugeCallId);
  assert.equal(skipped?.tool?.output, "[output of 8 MB skipped]", "the 8 MiB output line was skipped, its call closed");
});

// ------------------------------------------------------------------- runners ---

test("runs: a Codex turn.completed whose child never exits reads idle after finishingMaxMs; a Claude turn with no SDK message for turnStallMs reads unknown", async () => {
  const dir = mkdtempSync(join(ROOT, "runs-"));
  // The fake codex in `linger` mode: turn.completed, then the child never exits. CODEX_HOME is pinned so nothing lands under ~/.codex.
  const events: string[] = [];
  const run = new CodexRun({ bin: fakeCodex(dir), threadId: "t1", cwd: dir, env: { ...process.env, CODEX_HOME: join(dir, "codex-home"), FAKE_CODEX_MODE: "linger" }, budget: { turnMs: 20_000, startMs: 5_000, killGraceMs: 200, finishingMs: 150 }, sink: (e) => events.push(e.type === "status" ? `${e.status}:${e.detail ?? ""}` : e.type), now: Date.now });
  const t0 = performance.now();
  run.send("go");
  await until(() => run.status === "idle", 3_000, "idle after the finishing grace");
  measure("Codex run idle after turn.completed with a lingering child (finishingMs 150)", `${ms(t0)} ms`);
  assert.equal(run.statusDetail, "turn done; child still flushing");
  assert.ok(events.includes("working:finishing"));
  assert.ok(run.pids.length === 1, "the child is still there");
  await run.close();
  assert.equal(run.status, "offline");

  const silent: SdkLike = {
    query({ prompt }: { prompt: AsyncIterable<SdkUserMessage> }) {
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: "s-stall", model: "m" });
      void (async () => {
        for await (const _m of prompt) {
          /* never answers */
        }
        out.close();
      })();
      return Object.assign(out, { interrupt: async () => undefined });
    },
  } as SdkLike;
  const session = new ClaudeSession({ sdk: silent, cwd: dir, turnStallMs: 60 });
  const statuses: string[] = [];
  session.on("status", (s, d) => statuses.push(`${s}:${d ?? ""}`));
  session.start();
  await sleep(10);
  session.send("hello?");
  assert.equal(session.status, "working");
  await until(() => session.status === "unknown", 2_000, "the stall");
  assert.equal(session.statusDetail, "no output for 60 ms");
  assert.ok(statuses.includes("working:thinking"));
  await session.close();
});

test("settle after a replay: a source whose page was 'no file yet' follows the file from its first line and owns what it replayed — interruptOpenCalls flips the running call, total and cursor speak for the replay; the same through a thread started here (placeholder → rollout) and through a Claude Code session's 'no file yet' page", async () => {
  // The source alone: no page served, a replay from byte 0.
  const dir = mkdtempSync(join(ROOT, "replay-"));
  const later = join(dir, "later.jsonl");
  const source = new TranscriptSource({ path: later, makeParser: codex, pollMs: 20, coalesceMs: 5 });
  const deltas: TranscriptDelta[] = [];
  const stop = source.follow((d) => deltas.push(d), { fromStart: true });
  await sleep(40);
  assert.deepEqual(source.interruptOpenCalls(), [], "nothing to interrupt before the file exists");
  writeFileSync(later, `${codexLine(T("2026-09-01T09:00:00.000Z"), "response_item", { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "go" }] })}\n${codexLine(T("2026-09-01T09:00:01.000Z"), "response_item", { type: "function_call", id: "fc", name: "exec_command", arguments: "{}", call_id: "call_1" })}\n`);
  await until(() => deltas.flatMap((d) => d.messages).some((m) => m.id === "call_1"), 2_000, "the replayed running call");
  assert.equal(source.total, 2, "the replay counts");
  assert.deepEqual(source.cursor, { startOffset: 0, endOffset: statSync(later).size }, "the served range is the whole file");
  assert.deepEqual(source.interruptOpenCalls().map((m) => [m.id, m.tool?.status]), [["call_1", "interrupted"]]);
  assert.deepEqual(source.interruptOpenCalls(), [], "once");
  stop();
  source.close();

  // Through the sessions connector: a thread started here has a placeholder page until Codex writes the rollout;
  // the watch replays the rollout from its first line, and settle() must know what it replayed.
  const home = mkdtempSync(join(ROOT, "home-start-"));
  const id = "01a0feed-0000-7000-8000-00000000feed";
  const cwd = join(home, "site");
  mkdirSync(cwd);
  const paths = codexHome(home, id);
  signIn(home);
  const c = new SessionsConnector({ home, ...pinned(home, { FAKE_CODEX_MODE: "hang", FAKE_CODEX_THREAD_ID: id }), codexBin: fakeCodex(home), processes: async () => [], processCacheMs: 0, tailPollMs: 20, tailCoalesceMs: 5, codexKillGraceMs: 100, maxAgeDays: 100_000 });
  const started = await c.start({ tool: "codex", cwd, prompt: "go" });
  assert.equal(started.id, `sessions:codex:${id}`);
  assert.deepEqual(await c.transcript(started.id), { messages: [], total: 0, complete: true }, "no rollout yet: the placeholder page");
  const seen: TranscriptDelta[] = [];
  const ends: string[] = [];
  const unwatch = c.watch(started.id, (d) => seen.push(d), (r) => ends.push(r));
  await sleep(60);
  const gen = midTurn(paths.rolloutPath, { id, cwd }); // the rollout lands, its last call still running
  await until(() => seen.flatMap((d) => d.messages).some((m) => m.id === gen.openCallId), 3_000, "the replayed running call through watch()");
  const settled = await c.settle(started.id);
  assert.deepEqual(settled?.messages.map((m) => [m.id, m.tool?.status]), [[gen.openCallId, "interrupted"]], "settle() knows the replayed call");
  assert.equal(settled?.total, gen.ids.length, "and how many messages the pane was shown");
  assert.equal(await c.settle(started.id), undefined, "once");
  assert.deepEqual(ends, []);
  unwatch();
  await c.closeAll();

  // Through the Claude Code connector's 'no file yet' page: the same replay, the same settle.
  const home2 = mkdtempSync(join(ROOT, "home-claude-code-"));
  const claudeRoot = join(home2, "projects");
  mkdirSync(claudeRoot);
  const sid = "abcdefab-1234-4abc-8abc-abcdefab0d0d";
  const cc = new ClaudeCodeConnector({ sdk: fakeSdk(sid), claudeRoot, tailPollMs: 20, tailCoalesceMs: 10 });
  const worker = await cc.start({ cwd: home2, name: "worker" });
  await until(() => sdkIdKnown(cc, worker.id), 2_000, "the session id from init");
  assert.deepEqual(await cc.transcript(worker.id), { messages: [], total: 0, complete: true }, "no file yet");
  assert.equal(await cc.settle(worker.id), undefined, "nothing read, nothing to settle");
  const got: TranscriptDelta[] = [];
  const stopCc = cc.watch(worker.id, (d) => got.push(d));
  await sleep(60);
  const pdir = join(claudeRoot, projectSlug(home2));
  mkdirSync(pdir);
  const cl = (o: Record<string, unknown>, ts: string): string => JSON.stringify({ parentUuid: null, isSidechain: false, ...o, timestamp: ts, cwd: home2, sessionId: sid });
  writeFileSync(
    join(pdir, `${sid}.jsonl`),
    `${cl({ type: "user", uuid: "u1", message: { role: "user", content: "run it" } }, "2026-09-01T10:00:00.000Z")}\n${cl({ type: "assistant", uuid: "a1", message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_open", name: "Bash", input: { command: "pnpm test" } }], stop_reason: "tool_use" } }, "2026-09-01T10:00:01.000Z")}\n`,
  );
  await until(() => got.flatMap((d) => d.messages).some((m) => m.id === "toolu_open"), 3_000, "the replayed running call through the Claude Code watch");
  const ccSettled = await cc.settle(worker.id);
  assert.deepEqual(ccSettled?.messages.map((m) => [m.id, m.tool?.status]), [["toolu_open", "interrupted"]]);
  assert.equal(ccSettled?.total, 2);
  stopCc();
  await cc.closeAll();
});

test("resumed under a new file: a source that takes over another's state follows on from the same byte with the same parser — the running call in the old file gets its result from the new one", async () => {
  const dir = mkdtempSync(join(ROOT, "handoff-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  const item = (payload: Record<string, unknown>, ts: string): string => JSON.stringify({ timestamp: ts, ordinal: 1, type: "response_item", payload });
  writeFileSync(a, `${item({ type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "go" }] }, "2026-09-01T09:00:00.000Z")}\n${item({ type: "function_call", id: "fc", name: "exec_command", arguments: "{}", call_id: "call_1" }, "2026-09-01T09:00:01.000Z")}\n`);
  const first = new TranscriptSource({ path: a, makeParser: codex, pollMs: 20, coalesceMs: 5, goneAfterMs: 60 });
  const page = await first.page({ limit: 10 });
  assert.deepEqual(page.messages.map((m) => [m.id, m.tool?.status]), [["m1", undefined], ["call_1", "running"]]);
  const ends: TailEnd[] = [];
  const deltas: TranscriptDelta[] = [];
  first.follow((d) => deltas.push(d), { onEnd: (r) => ends.push(r) });
  await sleep(50);
  renameSync(a, b); // the same bytes under a new name
  await until(() => ends.length === 1, 2_000, "gone");
  assert.deepEqual(ends, ["gone"]);
  const second = new TranscriptSource({ path: b, makeParser: codex, pollMs: 20, coalesceMs: 5 });
  second.continueFrom(first);
  assert.deepEqual(second.cursor, first.cursor);
  second.follow((d) => deltas.push(d));
  await sleep(40);
  assert.equal(deltas.length, 0, "nothing replayed");
  appendFileSync(b, `${item({ type: "function_call_output", id: "o", call_id: "call_1", output: "ok" }, "2026-09-01T09:00:02.000Z")}\n`);
  await until(() => deltas.length === 1, 2_000, "the result");
  assert.deepEqual(deltas[0]?.messages.map((m) => [m.id, m.tool?.status, m.tool?.output]), [["call_1", "done", "ok"]], "the parser that knew the call came along");
  first.close();
  second.close();
});
