import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo, AgentMessage, ConnectorHealth } from "@jarhead/protocol";
import { ClaudeCodeConnector } from "../../claude-code/connector.ts";
import { AsyncQueue } from "../../claude-code/queue.ts";
import type { SdkLike, SdkMessage, SdkUserMessage } from "../../claude-code/session.ts";
import { AgentRegistry } from "../../registry.ts";
import type { AgentConnector, TranscriptDelta } from "../../types.ts";
import { ClaudeStore, projectSlug } from "../claude-store.ts";
import { ClaudeTranscriptParser } from "../claude-transcript.ts";
import { CodexTranscriptParser } from "../codex-transcript.ts";
import { SessionsConnector } from "../connector.ts";
import { FileTail, READ_CHUNK_BYTES, splitLines, type Line } from "../tail.ts";
import { MAX_PAGE_BYTES, TranscriptSource, clip, formatBytes, outputText, prettyInput, readTranscriptPage, readWhole } from "../transcript.ts";

// ------------------------------------------------------------------ fixtures ---
// The same anonymised transcripts the listing tests use (fixtures/claude, fixtures/codex),
// extended with the tool shapes of Kevin's files: Claude Code 2.1.260 tool_use blocks and
// tool_result lines (array content, is_error), codex 0.153 custom_tool_call/_output,
// function_call (arguments as a JSON string, call_id) and function_call_output (the exec
// tool's JSON body), a reasoning summary. Big files for paging are generated here.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const S1 = "11111111-1111-4111-8111-111111111111";
const C1 = "01a0aaaa-0000-7000-8000-000000000001";
const C2 = "01a0bbbb-0000-7000-8000-000000000002";
const S1_PATH = join(FIXTURES, "claude", "-Users-kevinliu-demo-app", `${S1}.jsonl`);
const C1_PATH = join(FIXTURES, "codex", "sessions", "2026", "09", "01", `rollout-2026-09-01T09-00-00-${C1}.jsonl`);
const C2_PATH = join(FIXTURES, "codex", "archived_sessions", `rollout-2026-08-30T12-00-00-${C2}.jsonl`);
const T = (iso: string): number => Date.parse(iso);

const claude = (): ClaudeTranscriptParser => new ClaudeTranscriptParser();
const codex = (): CodexTranscriptParser => new CodexTranscriptParser();

function tmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function until(check: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Claude Code lines the way 2.1.260 writes them. */
const claudeLines = {
  user: (uuid: string, text: string, ts: string): string =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid, timestamp: ts, cwd: "/x", sessionId: S1 }),
  block: (uuid: string, messageId: string, block: Record<string, unknown>, ts: string): string =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", id: messageId, type: "message", role: "assistant", content: [block] }, uuid, timestamp: ts, cwd: "/x", sessionId: S1 }),
  result: (uuid: string, toolUseId: string, content: unknown, isError: boolean, ts: string): string =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", content, is_error: isError, tool_use_id: toolUseId }] }, uuid, timestamp: ts, cwd: "/x", sessionId: S1 }),
};

/** `rounds` × (user, thinking, text, tool_use, tool_result): 4 messages a round, big enough to need several tail slices. */
function bigClaudeFile(path: string, rounds: number, padding = 6_000): { ids: string[] } {
  const ids: string[] = [];
  const out: string[] = [];
  const base = T("2026-09-01T10:00:00.000Z");
  for (let i = 0; i < rounds; i += 1) {
    const ts = (k: number): string => new Date(base + i * 60_000 + k * 1_000).toISOString();
    const msg = `msg_${String(i).padStart(4, "0")}`;
    const tool = `toolu_${String(i).padStart(4, "0")}`;
    out.push(claudeLines.user(`u${i}`, `round ${i}: do the thing`, ts(0)));
    out.push(claudeLines.block(`t${i}`, msg, { type: "thinking", thinking: `plan ${i}`, signature: "s" }, ts(1)));
    out.push(claudeLines.block(`a${i}`, msg, { type: "text", text: `Working on ${i}.` }, ts(2)));
    out.push(claudeLines.block(`b${i}`, msg, { type: "tool_use", id: tool, name: "Bash", input: { command: `echo ${i}` } }, ts(3)));
    out.push(claudeLines.result(`r${i}`, tool, `${i} `.repeat(padding / 2), false, ts(4)));
    ids.push(`u${i}`, `${msg}:thinking`, msg, tool);
  }
  writeFileSync(path, `${out.join("\n")}\n`);
  return { ids };
}

// -------------------------------------------------------------------- claude ---

test("Claude JSONL: turns, thinking, tool calls with their results, one message per message.id, sidechains skipped", async () => {
  const page = await readWhole(S1_PATH, claude);
  assert.equal(page.complete, true);
  assert.equal(page.total, 5);
  const [prompt, thinking, read, reply, bash] = page.messages as [AgentMessage, AgentMessage, AgentMessage, AgentMessage, AgentMessage];
  assert.deepEqual(prompt, { id: "u1", role: "user", text: "fix the login redirect", at: T("2026-09-01T10:00:00.100Z") });
  assert.deepEqual(thinking, { id: "msg_01Demo000000000000000A1:thinking", role: "assistant", text: "Read the login module before changing anything.", at: T("2026-09-01T10:00:04.000Z"), thinking: true });
  assert.deepEqual(read, {
    id: "toolu_01Demo00000000000000TU1",
    role: "tool",
    text: "",
    at: T("2026-09-01T10:00:05.000Z"),
    tool: { name: "Read", input: '{\n  "file_path": "src/login.ts"\n}', output: "export function login() {}", status: "done" },
  });
  assert.deepEqual(reply, { id: "msg_01Demo000000000000000A2", role: "assistant", text: "The redirect now points at /dashboard after login.", at: T("2026-09-01T10:01:00.000Z") });
  assert.equal(bash.id, "toolu_01Demo00000000000000TU2");
  assert.equal(bash.tool?.name, "Bash");
  assert.equal(bash.tool?.input, "pnpm test -- login\n# Run the login tests", "the command, its description as a comment");
  assert.equal(bash.tool?.status, "error", "is_error on the result");
  assert.match(bash.tool?.output ?? "", /^Exit code 1\nFAIL src\/login\.test\.ts/, "array content joined");
  assert.ok(!page.messages.some((m) => /sidechain/.test(m.text)), "the isSidechain line is not a turn");
  assert.equal(page.endOffset, readFileSync(S1_PATH).length, "the file ends on a newline: parsed to the end");
});

test("Claude JSONL: text blocks of one message merge; a result for a call that is out of view is kept as an orphan (never a message); harness user lines are not turns", () => {
  const p = claude();
  const push = (text: string, offset: number): void => p.push({ text, offset });
  push(claudeLines.user("u1", "go", "2026-09-01T10:00:00.000Z"), 0);
  push(claudeLines.block("a1", "msg_X", { type: "text", text: "First," }, "2026-09-01T10:00:01.000Z"), 100);
  push(claudeLines.block("a2", "msg_X", { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a" } }, "2026-09-01T10:00:02.000Z"), 200);
  push(claudeLines.block("a3", "msg_X", { type: "text", text: "then second." }, "2026-09-01T10:00:03.000Z"), 300);
  push(claudeLines.result("r0", "toolu_from_an_earlier_page", "old", false, "2026-09-01T10:00:04.000Z"), 400);
  push(claudeLines.user("m1", "<local-command-stdout>Set model</local-command-stdout>", "2026-09-01T10:00:05.000Z"), 500);
  push(JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "meta" }, uuid: "m2", timestamp: "2026-09-01T10:00:06.000Z" }), 600);
  push(JSON.stringify({ type: "summary", summary: "A title" }), 700);
  push(JSON.stringify({ type: "system", subtype: "stop_hook_summary", timestamp: "2026-09-01T10:00:07.000Z" }), 800);
  push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no id at all" }] }, timestamp: "2026-09-01T10:00:08.000Z" }), 900);
  const all = p.all();
  assert.deepEqual(
    all.map((m) => [m.id, m.role, m.text]),
    [
      ["u1", "user", "go"],
      ["msg_X", "assistant", "First,\nthen second."],
      ["toolu_1", "tool", ""],
      ["L900", "assistant", "no id at all"],
    ],
    "merged text keeps the message's first position; a line with neither message id nor uuid is named for its offset",
  );
  assert.equal(all[2]?.tool?.status, "running", "no result seen");
  assert.equal(all[1]?.at, T("2026-09-01T10:00:01.000Z"), "a message's time is its first block's");
  assert.deepEqual([...p.orphans.keys()], ["toolu_from_an_earlier_page"], "the out-of-view result waits as an orphan for the page that holds its call");
  assert.deepEqual(p.resultFor("toolu_from_an_earlier_page"), { output: "old", error: false });

  // take(): only what moved since last time, in order.
  assert.deepEqual(p.take().map((m) => m.id), ["u1", "msg_X", "toolu_1", "L900"]);
  assert.deepEqual(p.take(), []);
  push(claudeLines.result("r1", "toolu_1", [{ type: "text", text: "contents" }, { type: "image", source: {} }], false, "2026-09-01T10:00:09.000Z"), 1000);
  const [changed] = p.take();
  assert.deepEqual(changed?.tool, { name: "Read", input: '{\n  "file_path": "/a"\n}', output: "contents\n[image]", status: "done" }, "the call comes again, same id, with its output");
  assert.equal(p.count, 4);
});

test("paging: the newest page from the tail, older pages before an id, ids and order the same as one whole read", async () => {
  const t = tmp("jarhead-transcript-page-");
  try {
    const path = join(t.dir, `${S1}.jsonl`);
    const { ids } = bigClaudeFile(path, 150);
    assert.ok(readFileSync(path).length > 4 * 256 * 1024, "several tail slices are needed");
    const whole = await readWhole(path, claude);
    assert.deepEqual(whole.messages.map((m) => m.id), ids, "600 messages, 4 a round, in file order");
    assert.ok(whole.messages.every((m) => m.role !== "tool" || (m.tool?.status === "done" && (m.tool.output?.length ?? 0) > 0)), "every tool call found its result");

    const newest = await readTranscriptPage(path, claude, { limit: 60 });
    assert.equal(newest.messages.length, 60);
    assert.equal(newest.complete, false);
    assert.equal(newest.total, undefined, "a partial read does not know the total");
    assert.deepEqual(newest.messages.map((m) => m.id), ids.slice(-60), "the last 60, in order");
    assert.deepEqual(newest.messages, whole.messages.slice(-60), "identical to the same messages read whole (results attached, texts merged)");
    assert.equal(newest.endOffset, readFileSync(path).length);

    // Walk back page by page until the start; the pages tile the whole file exactly.
    const pages: AgentMessage[][] = [newest.messages];
    let before = newest.messages[0]!.id;
    for (;;) {
      const older = await readTranscriptPage(path, claude, { limit: 60, before });
      pages.unshift(older.messages);
      if (older.complete) {
        assert.equal(older.total, 600, "the read that reaches the start of the file knows the total");
        break;
      }
      assert.ok(older.total === undefined || older.total === 600, `read from the end, the total is known only once a slice reaches the start (${older.total})`);
      assert.equal(older.messages.length, 60);
      before = older.messages[0]!.id;
    }
    assert.deepEqual(pages.flat().map((m) => m.id), ids, "no gap, no overlap");
    assert.deepEqual(pages.flat(), whole.messages);

    const small = await readTranscriptPage(path, claude, { limit: 1000 });
    assert.equal(small.complete, true, "a limit larger than the file yields everything");
    assert.equal(small.messages.length, 600);
    await assert.rejects(readTranscriptPage(path, claude, { before: "nope" }), /no message nope/);
  } finally {
    t.cleanup();
  }
});

test("paging: a tail slice that opens mid-message drops its suspect first message and asks for more; a torn last line waits", async () => {
  const t = tmp("jarhead-transcript-cut-");
  try {
    const path = join(t.dir, "s.jsonl");
    // Two rounds of 4 messages with ~6 KB results; the newest page of 2 is the last tool call and... the previous one.
    bigClaudeFile(path, 2);
    const two = await readTranscriptPage(path, claude, { limit: 2 });
    assert.deepEqual(two.messages.map((m) => m.id), ["msg_0001", "toolu_0001"]);
    assert.equal(two.messages[1]?.tool?.status, "done");
    const one = await readTranscriptPage(path, claude, { limit: 1 });
    assert.deepEqual(one.messages.map((m) => m.id), ["toolu_0001"]);
    assert.equal(one.complete, false);

    // A write in progress: the last line has no newline yet, so it is not parsed and the read ends where it starts.
    const size = readFileSync(path).length;
    appendFileSync(path, claudeLines.user("u9", "half", "2026-09-01T11:00:00.000Z").slice(0, 40));
    const torn = await readTranscriptPage(path, claude, { limit: 60 });
    assert.equal(torn.endOffset, size, "the tail resumes at the torn line");
    assert.ok(!torn.messages.some((m) => m.id === "u9"));
  } finally {
    t.cleanup();
  }
});

test("paging: bounded — no page reaches further back than maxBytes from ITS cursor, so Load earlier always moves; an id the tail cannot locate is a plain Error, not a whole-file read; lines are reassembled across small read chunks", async () => {
  const t = tmp("jarhead-transcript-cap-");
  try {
    const path = join(t.dir, `${S1}.jsonl`);
    const { ids } = bigClaudeFile(path, 24); // ~6 KB a round: ~150 KB, 96 messages
    const size = readFileSync(path).length;
    const cap = 64 * 1024;
    const limits = { maxBytes: cap, chunkBytes: 512 }; // every line spans several chunks
    assert.ok(size > 2 * cap, "the bound is well inside the file");
    const whole = await readWhole(path, claude);

    // The newest page: whatever the last 64 KB hold, fewer than asked, and not the whole story.
    const tail = await readTranscriptPage(path, claude, { limit: 60 }, limits);
    assert.ok(tail.messages.length > 5 && tail.messages.length < 60, `the window's worth, not 60 (${tail.messages.length})`);
    assert.equal(tail.complete, false);
    assert.equal(tail.total, undefined);
    assert.deepEqual(tail.messages, whole.messages.slice(-tail.messages.length), "identical to the whole read, though read 512 bytes at a time");
    assert.equal(tail.endOffset, size);

    // Older pages are read backward from the cursor, so the page before message 5 reaches 64 KB further back than the tail did: those 5, and more before them.
    const inWindow = await readTranscriptPage(path, claude, { limit: 60, before: tail.messages[5]!.id }, limits);
    assert.deepEqual(inWindow.messages.slice(-5), tail.messages.slice(0, 5));
    assert.ok(inWindow.messages.length > 5, `the bound is per page, from its own cursor (${inWindow.messages.length})`);
    assert.equal(inWindow.complete, false);
    const tailStart = whole.messages.length - tail.messages.length;
    assert.deepEqual(inWindow.messages, whole.messages.slice(tailStart + 5 - inWindow.messages.length, tailStart + 5), "identical to the whole read");
    // The tail's first message has something before it now — never "nothing before … within the last 64 KB".
    const beyond = await readTranscriptPage(path, claude, { limit: 60, before: tail.messages[0]!.id }, limits);
    assert.ok(beyond.messages.length >= 1, "Load earlier yields a message or the start of the file, every time");
    assert.equal(beyond.messages.at(-1)?.id, whole.messages[tailStart - 1]?.id, "and it ends just before the tail page");
    // An id outside the last 64 KB cannot be located from the end; a source that served it knows its byte instead (durability tests).
    await assert.rejects(readTranscriptPage(path, claude, { limit: 60, before: ids[0]! }, limits), /no message u0 in the last 64 KB of/);
    await assert.rejects(readTranscriptPage(path, claude, { limit: 60, before: "nope" }, limits), /no message nope in the last 64 KB of/, "an unknown id does not read the file whole");

    // Through a source the total never says the page is everything there is.
    const source = new TranscriptSource({ path, makeParser: claude, storeCount: () => 3, limits });
    const page = await source.page({ limit: 60 });
    assert.equal(page.complete, false);
    assert.ok(page.total >= page.messages.length + 1, `total ${page.total} admits more than the ${page.messages.length} shown`);
    assert.equal(page.cursor?.endOffset, size, "the page says which bytes it covers");
    assert.ok(page.cursor && page.cursor.startOffset > 0 && page.cursor.startOffset < size);
    const older = await source.page({ limit: 60, before: page.messages[5]!.id });
    assert.ok(older.total >= page.total, "a later read never lowers the total");

    // The production bound: a slice that keeps doubling reaches 2^31 bytes on Kevin's 2 GB+ rollouts, and fs.read aborts the process there.
    assert.equal(MAX_PAGE_BYTES, 256 * 1024 * 1024);
    assert.ok(READ_CHUNK_BYTES < 2 ** 31 && MAX_PAGE_BYTES < 2 ** 31);
  } finally {
    t.cleanup();
  }
});

// --------------------------------------------------------------------- codex ---

test("Codex rollout (0.153): prompt, reasoning summary, custom_tool_call and function_call with outputs, commentary and final answer; chatter and injected context skipped", async () => {
  const page = await readWhole(C1_PATH, codex);
  assert.deepEqual(
    page.messages.map((m) => [m.id, m.role, m.thinking ? "thinking" : m.tool ? `${m.tool.name}:${m.tool.status}` : m.text]),
    [
      ["m4", "user", "make the hero font DM Sans"],
      ["call_1", "tool", "exec:done"],
      ["rs_1", "assistant", "thinking"],
      ["call_2", "tool", "exec_command:done"],
      ["m5", "assistant", "Looking at the hero styles first."],
      ["m6", "assistant", "Switched the hero heading to DM Sans and rebuilt."],
    ],
    "developer context, AGENTS.md, plugin lists, the empty-summary reasoning and the inter-agent agent_message are not turns",
  );
  const [, exec, thinking, sed] = page.messages as [AgentMessage, AgentMessage, AgentMessage, AgentMessage];
  assert.equal(exec.tool?.input, "text(await tools.exec_command({cmd:\"rg 'font-family' src/hero.css\"}))", "custom_tool_call input as written");
  assert.equal(exec.tool?.output, "src/hero.css:12:  font-family: Inter;\n", "input_text blocks joined");
  assert.equal(thinking.text, "**Checking the current hero font before editing**");
  assert.equal(sed.tool?.input, "sed -n '1,20p' src/hero.css", "arguments parsed, the cmd shown");
  assert.match(sed.tool?.output ?? "", /^\{"chunk_id":"a1b2c3"/, "the exec tool's JSON body, as written");
  assert.equal(sed.at, T("2026-09-01T09:00:31.600Z"));
  assert.equal(page.total, 6);
});

test("Codex rollout (0.145): event echoes hide behind response_item turns; an event-only file shows them, named by offset", async () => {
  const both = await readWhole(C2_PATH, codex);
  assert.deepEqual(both.messages.map((m) => [m.id, m.text]), [["om1", "rename the package"], ["om2", "Renamed it to old-thing-core."]]);
  const t = tmp("jarhead-transcript-events-");
  try {
    const path = join(t.dir, "events.jsonl");
    const lines = [
      JSON.stringify({ timestamp: "2026-08-30T12:00:00.000Z", type: "session_meta", payload: { session_id: C2, id: C2, cwd: "/x", cli_version: "0.145.0" } }),
      JSON.stringify({ timestamp: "2026-08-30T12:00:05.000Z", type: "event_msg", payload: { type: "user_message", message: "rename the package" } }),
      JSON.stringify({ timestamp: "2026-08-30T12:00:06.000Z", type: "event_msg", payload: { type: "user_message", message: "<environment_context>injected</environment_context>" } }),
      JSON.stringify({ timestamp: "2026-08-30T12:01:00.000Z", type: "event_msg", payload: { type: "agent_message", message: "Renamed it." } }),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);
    const events = await readWhole(path, codex);
    const secondOffset = lines[0]!.length + 1;
    const fourthOffset = secondOffset + lines[1]!.length + 1 + lines[2]!.length + 1;
    assert.deepEqual(events.messages.map((m) => [m.id, m.role, m.text]), [
      [`L${secondOffset}`, "user", "rename the package"],
      [`L${fourthOffset}`, "assistant", "Renamed it."],
    ]);
  } finally {
    t.cleanup();
  }
});

test("Codex tool status: a non-zero exit_code in the JSON body or 'exited with code N' in prose is an error; web_search_call completes on its own", () => {
  const p = codex();
  const item = (payload: Record<string, unknown>, ts = "2026-09-01T09:00:00.000Z"): string => JSON.stringify({ timestamp: ts, type: "response_item", payload });
  p.push({ text: item({ type: "function_call", id: "fc_a", name: "exec_command", arguments: '{"cmd":"false"}', call_id: "call_a" }), offset: 0 });
  p.push({ text: item({ type: "function_call_output", id: "fco_a", call_id: "call_a", output: '{"chunk_id":"x","exit_code":1,"output":""}' }), offset: 1 });
  p.push({ text: item({ type: "custom_tool_call", id: "ctc_b", name: "exec", input: "ls", call_id: "call_b" }), offset: 2 });
  p.push({ text: item({ type: "custom_tool_call_output", id: "ctco_b", call_id: "call_b", output: [{ type: "input_text", text: "Process exited with code 2\n" }] }), offset: 3 });
  p.push({ text: item({ type: "local_shell_call", id: "lsc_c", call_id: "call_c", action: { type: "exec", command: ["bash", "-lc", "pwd"] } }), offset: 4 });
  p.push({ text: item({ type: "local_shell_call_output", id: "lsco_c", call_id: "call_c", output: "/x\n" }), offset: 5 });
  p.push({ text: item({ type: "web_search_call", id: "ws_d", status: "completed", action: { type: "search", query: "DM Sans" } }), offset: 6 });
  p.push({ text: item({ type: "function_call", id: "fc_e", name: "spawn_agent", namespace: "collaboration", arguments: "not json", call_id: "call_e" }), offset: 7 });
  const tools = p.all().map((m) => [m.id, m.tool?.name, m.tool?.input, m.tool?.status]);
  assert.deepEqual(tools, [
    ["call_a", "exec_command", "false", "error"],
    ["call_b", "exec", "ls", "error"],
    ["call_c", "shell", "bash -lc pwd", "done"],
    ["ws_d", "web_search", "DM Sans", "done"],
    ["call_e", "spawn_agent", "not json", "running"],
  ]);
});

// ---------------------------------------------------------------------- tail ---

test("FileTail: appended lines arrive in bursts with their offsets; a torn line waits for its end; a file that appears later is followed", async () => {
  const t = tmp("jarhead-tail-");
  try {
    const path = join(t.dir, "grow.jsonl");
    writeFileSync(path, '{"n":0}\n');
    const bursts: Line[][] = [];
    const tail = new FileTail({ path, offset: 8, onLines: (lines) => bursts.push(lines), pollMs: 30, coalesceMs: 20 });
    appendFileSync(path, '{"n":1}\n{"n":2}\n');
    await until(() => bursts.flat().length === 2, 3_000, "two lines");
    assert.deepEqual(bursts.flat(), [{ text: '{"n":1}', offset: 8 }, { text: '{"n":2}', offset: 16 }]);
    appendFileSync(path, '{"n":3,"long":"abc');
    await sleep(150);
    assert.equal(bursts.flat().length, 2, "half a line is not a line");
    appendFileSync(path, 'def"}\n{"n":4}\n');
    await until(() => bursts.flat().length === 4, 3_000, "the completed line and the next");
    assert.deepEqual(bursts.flat().slice(2), [{ text: '{"n":3,"long":"abcdef"}', offset: 24 }, { text: '{"n":4}', offset: 48 }]);
    tail.close();
    appendFileSync(path, '{"n":5}\n');
    await sleep(120);
    assert.equal(bursts.flat().length, 4, "closed tails hear nothing");

    const later = join(t.dir, "later.jsonl");
    const got: Line[] = [];
    const waiting = new FileTail({ path: later, offset: 0, onLines: (lines) => got.push(...lines), pollMs: 20, coalesceMs: 10 });
    await sleep(60);
    writeFileSync(later, "a\n");
    appendFileSync(later, "b\n");
    await until(() => got.length === 2, 3_000, "lines of a file created after the tail started");
    assert.deepEqual(got, [{ text: "a", offset: 0 }, { text: "b", offset: 2 }]);
    waiting.close();
  } finally {
    t.cleanup();
  }
});

test("FileTail: a backlog wider than one read chunk is caught up chunk by chunk, every line whole and in order", async () => {
  const t = tmp("jarhead-tail-chunks-");
  try {
    const path = join(t.dir, "grow.jsonl");
    writeFileSync(path, "");
    const got: Line[] = [];
    const tail = new FileTail({ path, offset: 0, onLines: (lines) => got.push(...lines), pollMs: 30, coalesceMs: 20, chunkBytes: 64 });
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ n: i, pad: "x".repeat(i % 37) }));
    appendFileSync(path, `${lines.join("\n")}\n`);
    await until(() => got.length === 200, 3_000, "every line of a 6 KB append read 64 bytes at a time");
    let offset = 0;
    const expected = lines.map((text) => {
      const line = { text, offset };
      offset += Buffer.byteLength(text) + 1;
      return line;
    });
    assert.deepEqual(got, expected);
    tail.close();
  } finally {
    t.cleanup();
  }
});

test("TranscriptSource: a page, then live deltas — new turns, a tool call again with its output, the total growing", async () => {
  const t = tmp("jarhead-source-");
  try {
    const path = join(t.dir, `${S1}.jsonl`);
    writeFileSync(path, `${[claudeLines.user("u1", "start", "2026-09-01T10:00:00.000Z"), claudeLines.block("a1", "msg_1", { type: "text", text: "Starting." }, "2026-09-01T10:00:01.000Z")].join("\n")}\n`);
    const source = new TranscriptSource({ path, makeParser: claude, storeCount: () => 2, pollMs: 30, coalesceMs: 20 });
    const page = await source.page({ limit: 60 });
    assert.deepEqual(page.messages.map((m) => m.id), ["u1", "msg_1"]);
    assert.deepEqual([page.total, page.complete], [2, true]);

    const deltas: TranscriptDelta[] = [];
    const stop = source.follow((d) => deltas.push(d));
    appendFileSync(path, `${claudeLines.block("a2", "msg_2", { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "pnpm test" } }, "2026-09-01T10:00:02.000Z")}\n`);
    await until(() => deltas.length === 1, 3_000, "the tool call");
    assert.deepEqual(deltas[0]?.messages.map((m) => [m.id, m.tool?.status]), [["toolu_9", "running"]]);
    assert.equal(deltas[0]?.total, 3);

    appendFileSync(path, `${claudeLines.result("r9", "toolu_9", "all green", false, "2026-09-01T10:00:03.000Z")}\n`);
    await until(() => deltas.length === 2, 3_000, "the result");
    assert.deepEqual(deltas[1]?.messages.map((m) => [m.id, m.tool?.status, m.tool?.output]), [["toolu_9", "done", "all green"]], "same id, now with its output");
    assert.equal(deltas[1]?.total, 3, "an update is not a new message");

    // Two lines in one write: one burst, two messages (a merged reply and Kevin's next turn).
    appendFileSync(path, `${[claudeLines.block("a3", "msg_2", { type: "text", text: "Tests pass." }, "2026-09-01T10:00:04.000Z"), claudeLines.user("u2", "ship it", "2026-09-01T10:00:05.000Z")].join("\n")}\n`);
    await until(() => deltas.flatMap((d) => d.messages).some((m) => m.id === "u2"), 3_000, "the next turn");
    const tailMessages = deltas.slice(2).flatMap((d) => d.messages);
    assert.deepEqual(tailMessages.map((m) => [m.id, m.text]), [["msg_2", "Tests pass."], ["u2", "ship it"]]);
    assert.equal(deltas[deltas.length - 1]?.total, 5);
    stop();
    appendFileSync(path, `${claudeLines.user("u3", "after close", "2026-09-01T10:00:06.000Z")}\n`);
    await sleep(120);
    assert.ok(!deltas.flatMap((d) => d.messages).some((m) => m.id === "u3"), "unsubscribed");

    // follow() without a page first: the tail is seeded from the file's end, so a result finds its call and nothing old is replayed.
    const fresh = new TranscriptSource({ path, makeParser: claude, pollMs: 30, coalesceMs: 20 });
    const seeded: TranscriptDelta[] = [];
    const stopFresh = fresh.follow((d) => seeded.push(d));
    await sleep(100);
    assert.equal(seeded.length, 0, "nothing replayed");
    appendFileSync(path, `${claudeLines.block("a4", "msg_3", { type: "tool_use", id: "toolu_10", name: "Read", input: { file_path: "/y" } }, "2026-09-01T10:00:07.000Z")}\n`);
    await until(() => seeded.length === 1, 3_000, "a call after seeding");
    appendFileSync(path, `${claudeLines.result("r10", "toolu_10", "y", false, "2026-09-01T10:00:08.000Z")}\n`);
    await until(() => seeded.length === 2, 3_000, "its result");
    assert.equal(seeded[1]?.messages[0]?.tool?.output, "y");
    stopFresh();

    // No file yet: an empty, complete page; the tail waits for it.
    const missing = new TranscriptSource({ path: join(t.dir, "not-yet.jsonl"), makeParser: claude, pollMs: 20, coalesceMs: 10 });
    assert.deepEqual(await missing.page(), { messages: [], total: 0, complete: true });
    const late: TranscriptDelta[] = [];
    const stopLate = missing.follow((d) => late.push(d));
    await sleep(50);
    writeFileSync(join(t.dir, "not-yet.jsonl"), `${claudeLines.user("u1", "hello", "2026-09-01T10:00:00.000Z")}\n`);
    await until(() => late.length === 1, 3_000, "the first line of a new file");
    assert.deepEqual(late[0]?.messages.map((m) => m.text), ["hello"]);
    stopLate();
    missing.close();
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- connectors ---

function pinned(home: string): { env: NodeJS.ProcessEnv; applicationsDir: string; cliSystemDirs: string[] } {
  const emptyBin = join(home, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  return { env: { PATH: emptyBin, HOME: home }, applicationsDir: join(home, "Applications"), cliSystemDirs: [] };
}

test("SessionsConnector: list() names the tool and message count; transcript() pages a session; watch() follows its file", async () => {
  const t = tmp("jarhead-sessions-transcript-");
  try {
    const claudeRoot = join(t.dir, ".claude", "projects");
    cpSync(join(FIXTURES, "claude"), claudeRoot, { recursive: true });
    cpSync(join(FIXTURES, "codex"), join(t.dir, ".codex"), { recursive: true });
    const c = new SessionsConnector({ home: t.dir, ...pinned(t.dir), processes: async () => [], processCacheMs: 0, tailPollMs: 30, tailCoalesceMs: 20 });
    const list = await c.list();
    const s1 = list.find((a) => a.id === `sessions:claude:${S1}`);
    const c1 = list.find((a) => a.id === `sessions:codex:${C1}`);
    assert.equal(s1?.tool, "claude");
    assert.equal(s1?.messageCount, 3, "the listing's count: Kevin's turns and assistant replies");
    assert.equal(c1?.tool, "codex");
    assert.equal(c1?.messageCount, 3);

    const page = await c.transcript(`sessions:claude:${S1}`);
    assert.deepEqual(page.messages.map((m) => m.id), ["u1", "msg_01Demo000000000000000A1:thinking", "toolu_01Demo00000000000000TU1", "msg_01Demo000000000000000A2", "toolu_01Demo00000000000000TU2"]);
    assert.deepEqual([page.total, page.complete], [5, true]);
    const last2 = await c.transcript(`sessions:codex:${C1}`, { limit: 2 });
    assert.deepEqual(last2.messages.map((m) => m.id), ["m5", "m6"]);
    assert.equal(last2.complete, false);
    assert.equal(last2.total, 6, "a small file is read whole even for a short page, so the total is exact");
    const older = await c.transcript(`sessions:codex:${C1}`, { limit: 2, before: "m5" });
    assert.deepEqual(older.messages.map((m) => m.id), ["rs_1", "call_2"]);
    assert.deepEqual([older.total, older.complete], [6, false]);
    await assert.rejects(c.transcript("sessions:claude:ffffffff-ffff-4fff-8fff-ffffffffffff"), /no claude session/);
    await assert.rejects(c.transcript("herdr:x"), TypeError);

    const deltas: TranscriptDelta[] = [];
    const stop = c.watch(`sessions:claude:${S1}`, (d) => deltas.push(d));
    await sleep(80); // the watch resolves the session and opens the tail
    const path = join(claudeRoot, "-Users-kevinliu-demo-app", `${S1}.jsonl`);
    appendFileSync(path, `${claudeLines.user("u4", "also the logout path", "2026-09-01T10:02:00.000Z")}\n`);
    await until(() => deltas.length === 1, 3_000, "the new turn");
    assert.deepEqual(deltas[0]?.messages.map((m) => [m.id, m.text]), [["u4", "also the logout path"]]);
    assert.equal(deltas[0]?.total, 6);
    stop();
    appendFileSync(path, `${claudeLines.user("u5", "gone", "2026-09-01T10:03:00.000Z")}\n`);
    await sleep(120);
    assert.equal(deltas.length, 1);
    await c.closeAll();
  } finally {
    t.cleanup();
  }
});

/** The fake SDK reports its id on the next tick; the transcript file is looked up by that id. */
function deltasReady(c: ClaudeCodeConnector, id: string): boolean {
  return (c as unknown as { sessions: Map<string, { sessionId: string | undefined }> }).sessions.get(id.split(":")[1] ?? "")?.sessionId !== undefined;
}

/** A Claude that reports a fixed session id and answers every prompt with one text block. */
function fakeSdk(sessionId: string): SdkLike {
  return {
    query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }) {
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fable-5-1" });
      (async () => {
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

test("ClaudeCodeConnector: tool is claude; transcript() and watch() read the CLI's own file once it exists", async () => {
  const t = tmp("jarhead-claude-code-transcript-");
  try {
    const sid = "abcdefab-1234-4abc-8abc-abcdefabcdef";
    const claudeRoot = join(t.dir, "projects");
    mkdirSync(claudeRoot);
    const c = new ClaudeCodeConnector({ sdk: fakeSdk(sid), claudeRoot, tailPollMs: 20, tailCoalesceMs: 10 });
    const info = await c.start({ cwd: t.dir, name: "helper" });
    assert.equal(info.tool, "claude");
    await until(() => deltasReady(c, info.id), 2_000, "the session id from init");
    assert.deepEqual(await c.transcript(info.id), { messages: [], total: 0, complete: true }, "no file yet");
    const deltas: TranscriptDelta[] = [];
    const stop = c.watch(info.id, (d) => deltas.push(d));
    await sleep(60);
    // The CLI writes the session under its project slug; here it is copied from the fixture under the reported id.
    const dir = join(claudeRoot, "-tmp-helper");
    mkdirSync(dir);
    const path = join(dir, `${sid}.jsonl`);
    writeFileSync(path, readFileSync(S1_PATH));
    await until(() => deltas.length >= 1, 3_000, "the file's turns once it appears");
    assert.equal(deltas.flatMap((d) => d.messages).length, 5, "a file that appears after the watch started is read from its start");
    const page = await c.transcript(info.id, { limit: 2 });
    assert.deepEqual(page.messages.map((m) => m.id), ["msg_01Demo000000000000000A2", "toolu_01Demo00000000000000TU2"]);
    assert.equal(page.complete, false);
    stop();
    await c.closeAll();
  } finally {
    t.cleanup();
  }
});

const S1_IDS = ["u1", "msg_01Demo000000000000000A1:thinking", "toolu_01Demo00000000000000TU1", "msg_01Demo000000000000000A2", "toolu_01Demo00000000000000TU2"];

test("ClaudeCodeConnector: the file is found where the CLI writes it with one stat; a file that landed between the empty page and watch() is replayed whole; a served source is not; an unknown session ends the watch", async () => {
  const t = tmp("jarhead-claude-code-direct-");
  try {
    const sid = "abcdefab-1234-4abc-8abc-abcdefabcd01";
    const claudeRoot = join(t.dir, "projects");
    mkdirSync(claudeRoot);
    const c = new ClaudeCodeConnector({ sdk: fakeSdk(sid), claudeRoot, tailPollMs: 20, tailCoalesceMs: 10 });
    const info = await c.start({ cwd: t.dir, name: "helper" });
    await until(() => deltasReady(c, info.id), 2_000, "the session id from init");
    assert.deepEqual(await c.transcript(info.id), { messages: [], total: 0, complete: true }, "no file yet: the Console shows an empty conversation");

    // The CLI files the session under the slug of its cwd; here it lands before the Console's watch is wired.
    const dir = join(claudeRoot, projectSlug(t.dir));
    mkdirSync(dir);
    const path = join(dir, `${sid}.jsonl`);
    writeFileSync(path, readFileSync(S1_PATH));
    assert.equal((await new ClaudeStore({ root: claudeRoot }).findAt(t.dir, sid))?.path, path, "the direct lookup, no walk of every project");
    assert.equal(await new ClaudeStore({ root: claudeRoot }).findAt("/somewhere/else", sid), undefined);

    const deltas: TranscriptDelta[] = [];
    const ends: string[] = [];
    const stop = c.watch(info.id, (d) => deltas.push(d), (reason) => ends.push(reason));
    await until(() => deltas.flatMap((d) => d.messages).some((m) => m.id === S1_IDS[4]), 3_000, "every message of a file nobody has seen");
    assert.deepEqual([...new Set(deltas.flatMap((d) => d.messages).map((m) => m.id))], S1_IDS, "replayed from the first line, in order");
    assert.deepEqual(ends, []);
    stop();

    // A page served from the file, then a watch: it continues from the page, nothing is replayed.
    const page = await c.transcript(info.id, { limit: 2 });
    assert.deepEqual(page.messages.map((m) => m.id), S1_IDS.slice(-2));
    const again: TranscriptDelta[] = [];
    const stopAgain = c.watch(info.id, (d) => again.push(d));
    await sleep(100);
    assert.equal(again.length, 0);
    appendFileSync(path, `${claudeLines.user("u7", "and the signup path", "2026-09-01T10:05:00.000Z")}\n`);
    await until(() => again.length === 1, 3_000, "only the new turn");
    assert.deepEqual(again[0]?.messages.map((m) => m.id), ["u7"]);
    stopAgain();

    const gone: string[] = [];
    c.watch("claude-code:s99", () => undefined, (reason) => gone.push(reason));
    await until(() => gone.length === 1, 1_000, "the end reason");
    assert.match(gone[0]!, /no claude-code session/);
    await c.closeAll();
  } finally {
    t.cleanup();
  }
});

test("SessionsConnector: a thread started here is followed from its first line once its file lands; nothing is written at the placeholder; a watch on a session that is gone ends", async () => {
  const t = tmp("jarhead-sessions-pending-");
  try {
    const claudeRoot = join(t.dir, ".claude", "projects");
    cpSync(join(FIXTURES, "claude"), claudeRoot, { recursive: true });
    const sid = "abcdefab-1234-4abc-8abc-abcdefabcd02";
    const c = new SessionsConnector({ home: t.dir, ...pinned(t.dir), sdk: fakeSdk(sid), processes: async () => [], processCacheMs: 0, tailPollMs: 20, tailCoalesceMs: 10 });
    const info = await c.start({ tool: "claude", cwd: t.dir, prompt: "hello" });
    assert.equal(info.id, `sessions:claude:${sid}`);
    assert.deepEqual(await c.transcript(info.id), { messages: [], total: 0, complete: true }, "the CLI has not written the file yet");

    const deltas: TranscriptDelta[] = [];
    const ends: string[] = [];
    const stop = c.watch(info.id, (d) => deltas.push(d), (reason) => ends.push(reason));
    await sleep(70); // several looks while only the placeholder exists
    assert.equal(existsSync(join(t.dir, `.jarhead-claude-${sid}.pending`)), false, "the placeholder path is never created");
    assert.equal(deltas.length, 0);
    const dir = join(claudeRoot, projectSlug(t.dir));
    mkdirSync(dir);
    const path = join(dir, `${sid}.jsonl`);
    writeFileSync(path, readFileSync(S1_PATH));
    await until(() => deltas.flatMap((d) => d.messages).some((m) => m.id === S1_IDS[4]), 3_000, "the file's messages once it lands");
    assert.deepEqual([...new Set(deltas.flatMap((d) => d.messages).map((m) => m.id))], S1_IDS, "from the first line: the Console saw an empty conversation");
    assert.deepEqual(ends, []);
    appendFileSync(path, `${claudeLines.user("u8", "next", "2026-09-01T10:06:00.000Z")}\n`);
    await until(() => deltas.flatMap((d) => d.messages).some((m) => m.id === "u8"), 3_000, "and it keeps following the real file");
    stop();

    const gone: string[] = [];
    c.watch("sessions:claude:ffffffff-ffff-4fff-8fff-ffffffffffff", () => undefined, (reason) => gone.push(reason));
    await until(() => gone.length === 1, 1_000, "the end reason");
    assert.match(gone[0]!, /no claude session/);
    await c.closeAll();
  } finally {
    t.cleanup();
  }
});

test("AgentRegistry: transcript() and watch() go to the agent's connector; a connector without them says so", async () => {
  const calls: string[] = [];
  const base = (kind: "sessions" | "claude-code"): AgentConnector => ({
    kind,
    health: async (): Promise<ConnectorHealth> => ({ kind, ok: true, detail: "" }),
    list: async (): Promise<AgentInfo[]> => [],
    send: async () => ({ accepted: true }),
    read: async () => "",
  });
  const withTranscript: AgentConnector = {
    ...base("sessions"),
    transcript: async (id, opts) => {
      calls.push(`transcript ${id} ${opts?.before ?? "-"}`);
      return { messages: [], total: 0, complete: true };
    },
    watch: (id, onDelta, onEnd) => {
      calls.push(`watch ${id}`);
      onDelta({ messages: [], total: 0 });
      onEnd?.("file vanished");
      return () => calls.push(`unwatch ${id}`);
    },
  };
  const reg = new AgentRegistry([withTranscript, base("claude-code")], 0);
  await reg.transcript("sessions:claude:x", { before: "m1" });
  const stop = reg.watch(
    "sessions:claude:x",
    () => calls.push("delta"),
    (reason) => calls.push(`end ${reason}`),
  );
  stop?.();
  assert.deepEqual(calls, ["transcript sessions:claude:x m1", "watch sessions:claude:x", "delta", "end file vanished", "unwatch sessions:claude:x"]);
  assert.equal(reg.watch("claude-code:s1", () => undefined), undefined, "no watch on that connector");
  await assert.rejects(reg.transcript("claude-code:s1"), /keeps no conversation transcript/);
  await assert.rejects(reg.transcript("nope"), /malformed agent id/);
});

// ------------------------------------------------------------------- helpers ---

test("helpers: clip, prettyInput, outputText, splitLines", () => {
  assert.equal(clip("abc", 5), "abc");
  assert.equal(clip("abcdefgh", 5), "abcde… (+3 chars)");
  assert.equal(prettyInput({ command: "ls -la", description: "list" }), "ls -la\n# list");
  assert.equal(prettyInput({ cmd: "pwd" }), "pwd");
  assert.equal(prettyInput({ command: ["bash", "-lc", "pwd"] }), "bash -lc pwd");
  assert.equal(prettyInput({ file_path: "/a", limit: 5 }), '{\n  "file_path": "/a",\n  "limit": 5\n}');
  assert.equal(prettyInput("  raw  "), "raw");
  assert.equal(prettyInput(""), undefined);
  assert.equal(prettyInput({}), undefined);
  assert.equal(prettyInput(undefined), undefined);
  assert.equal(prettyInput("x".repeat(5_000))?.length, 4_000 + "… (+1000 chars)".length);
  assert.equal(outputText("plain"), "plain");
  assert.equal(outputText([{ type: "text", text: "a" }, { type: "input_text", text: "b" }, { type: "output_text", text: "c" }, { type: "image", source: {} }, "d", { type: "other", v: 1 }]), 'a\nb\nc\n[image]\nd\n{"type":"other","v":1}');
  assert.equal(outputText({ k: 1 }), '{"k":1}');
  assert.equal(outputText(undefined), undefined);
  const { lines, rest } = splitLines(Buffer.from("ab\ncd\r\n\nef"), 100);
  assert.deepEqual(lines, [{ text: "ab", offset: 100 }, { text: "cd", offset: 103 }]);
  assert.deepEqual(rest && { offset: rest.offset, text: rest.bytes.toString() }, { offset: 108, text: "ef" });
  assert.equal(splitLines(Buffer.from("x\n"), 0).rest, undefined);
  assert.equal(projectSlug("/Users/kevinliu/gt/gt-cloud"), "-Users-kevinliu-gt-gt-cloud");
  assert.equal(projectSlug("/Users/kevinliu/.claude/x_y.z"), "-Users-kevinliu--claude-x-y-z", "every non-alphanumeric becomes a dash, as the CLI does");
  assert.equal(formatBytes(64 * 1024), "64 KB");
  assert.equal(formatBytes(256 * 1024 * 1024), "256 MB");
  assert.equal(formatBytes(2.3 * 1024 * 1024 * 1024), "2.3 GB");
});
