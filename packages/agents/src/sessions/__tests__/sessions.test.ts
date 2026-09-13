import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "@jarhead/protocol";
import { AsyncQueue } from "../../claude-code/queue.ts";
import type { PermissionDecision, SdkLike, SdkMessage, SdkUserMessage } from "../../claude-code/session.ts";
import { parseRegistryEntry, readClaudeRegistry, type SessionOwner } from "../claude-registry.ts";
import { ClaudeStore, decodeProjectSlug, parseClaudeSession, userText } from "../claude-store.ts";
import { CodexStore, idFromFilename, parseCodexSession } from "../codex-store.ts";
import { SessionsConnector, formatMessageCount, liveProcessesFor, parseSessionsAgentId, sessionDetail, sessionName, statusFor, summarizeToolInput, type SessionsConnectorOptions } from "../connector.ts";
import { detectOthers } from "../others.ts";
import { classifyCommand, defaultExec, listAgentProcesses, parseLsofCwd, parseLsofSessionFiles, parsePs, sessionIdFromArgs } from "../processes.ts";
import type { AgentProcess } from "../processes.ts";
import { ago, readHeadTail, truncate } from "../store.ts";

// ------------------------------------------------------------------ fixtures ---
// Anonymised copies of the shapes on Kevin's machine: Claude Code 2.1.260 transcripts
// (a Desktop scratch session whose first user line opens with <system-reminder>, isMeta
// caveat lines, slash-command echoes, a summary line, sidechain/agentId lines, assistant
// messages split over several lines sharing one message.id), codex 0.153.4 rollouts (a
// user thread, the sub-agent rollout it spawned, an automation run) plus a 0.145 archived
// thread with the old double-recorded turns, Claude Code's ~/.claude/sessions/<pid>.json
// registry, and lsof output from Codex Desktop's app-server (cwd `/`, rollouts and
// thread-writer-locks held open). Tests copy them into a temp "home" and set mtimes, so
// nothing depends on the real ~/.claude or ~/.codex.

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S4 = "44444444-4444-4444-8444-444444444444";
const C1 = "01a0aaaa-0000-7000-8000-000000000001";
const C2 = "01a0bbbb-0000-7000-8000-000000000002";
const C3 = "01a0cccc-0000-7000-8000-000000000003"; // sub-agent of C1
const C4 = "01a0dddd-0000-7000-8000-000000000004"; // automation run
const SLUG = "-Users-kevinliu-demo-app";
const SCRATCH_SLUG = "-Users-kevinliu-scratch-demo";

const T = (iso: string): number => Date.parse(iso);
const NOW = T("2026-09-02T12:00:00.000Z");
const LEASES = { workingLeaseMs: 30_000, finishingMaxMs: 30_000, runStallMs: 300_000 };

interface Home {
  readonly home: string;
  readonly claudeRoot: string;
  readonly codexRoot: string;
  readonly registryDir: string;
  readonly paths: Readonly<Record<"s1" | "s2" | "s4" | "c1" | "c2" | "c3" | "c4", string>>;
  touch(path: string, whenMs: number): void;
  /** Point a Claude fixture's cwd at a real folder under the temp home (resume needs one). */
  realCwd(path: string, fixtureCwd: string): string;
  cleanup(): void;
}

function makeHome(): Home {
  const home = mkdtempSync(join(tmpdir(), "jarhead-sessions-"));
  const claudeRoot = join(home, ".claude", "projects");
  const codexRoot = join(home, ".codex");
  const registryDir = join(home, ".claude", "sessions");
  cpSync(join(FIXTURES, "claude"), claudeRoot, { recursive: true });
  cpSync(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  cpSync(join(FIXTURES, "claude-sessions"), registryDir, { recursive: true });
  const paths = {
    s1: join(claudeRoot, SLUG, `${S1}.jsonl`),
    s2: join(claudeRoot, SLUG, `${S2}.jsonl`),
    s4: join(claudeRoot, SCRATCH_SLUG, `${S4}.jsonl`),
    c1: join(codexRoot, "sessions", "2026", "09", "01", `rollout-2026-09-01T09-00-00-${C1}.jsonl`),
    c2: join(codexRoot, "archived_sessions", `rollout-2026-08-30T12-00-00-${C2}.jsonl`),
    c3: join(codexRoot, "sessions", "2026", "09", "01", `rollout-2026-09-01T09-02-00-${C3}.jsonl`),
    c4: join(codexRoot, "sessions", "2026", "09", "01", `rollout-2026-09-01T07-00-00-${C4}.jsonl`),
  };
  const touch = (path: string, whenMs: number): void => utimesSync(path, new Date(whenMs), new Date(whenMs));
  touch(paths.s1, T("2026-09-01T10:01:00.000Z"));
  touch(paths.s2, T("2026-08-10T09:02:00.000Z")); // 23 days old: outside the 14-day window
  touch(paths.s4, T("2026-09-01T12:04:00.000Z"));
  touch(paths.c1, T("2026-09-01T09:05:00.000Z"));
  touch(paths.c3, T("2026-09-01T09:06:00.000Z")); // the sub-agent is the newest codex file on disk
  touch(paths.c4, T("2026-09-01T07:01:00.000Z"));
  touch(paths.c2, T("2026-08-30T12:01:00.000Z"));
  const realCwd = (path: string, fixtureCwd: string): string => {
    const cwd = join(home, fixtureCwd.split("/").pop() ?? "cwd");
    mkdirSync(cwd, { recursive: true });
    const when = readFileSync(path, "utf8");
    writeFileSync(path, when.replaceAll(fixtureCwd, cwd));
    return cwd;
  };
  return { home, claudeRoot, codexRoot, registryDir, paths, touch, realCwd, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);

type FakeSdk = SdkLike & { received: string[]; options: Record<string, unknown>[]; decisions: PermissionDecision[]; asked: number };
type FakeAsk = { tool: string; input: Record<string, unknown> };

/**
 * A scripted Claude that answers every user message with one text block and a result.
 * With `ask`, it first requests permission for those tools (through options.canUseTool,
 * the way the real SDK does — several at once when given several, as the CLI does for
 * parallel tool_use blocks) and answers with the outcome. `decisions` fills in the order
 * the questions are answered; `asked` counts canUseTool calls made so far.
 */
function fakeSdk(answer = "resumed and done", delayMs = 10, ask?: FakeAsk | readonly FakeAsk[]): FakeSdk {
  const holder = { received: [] as string[], options: [] as Record<string, unknown>[], decisions: [] as PermissionDecision[], asked: 0 };
  const asks: readonly FakeAsk[] = ask === undefined ? [] : Array.isArray(ask) ? ask : [ask as FakeAsk];
  return Object.assign(holder, {
    query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }) {
      holder.options.push(options ?? {});
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: String(options?.["resume"] ?? "new"), model: "claude-fable-5-1" });
      (async () => {
        for await (const m of prompt) {
          holder.received.push(typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content));
          await new Promise((r) => setTimeout(r, delayMs));
          let text = answer;
          if (asks.length) {
            const canUseTool = options?.["canUseTool"] as (t: string, i: Record<string, unknown>) => Promise<PermissionDecision>;
            const decisions = await Promise.all(
              asks.map((a) => {
                holder.asked += 1;
                return canUseTool(a.tool, a.input).then((d) => {
                  holder.decisions.push(d);
                  return d;
                });
              }),
            );
            const denied = decisions.find((d) => d.behavior === "deny");
            text = denied ? `refused: ${denied.message}` : answer;
          }
          out.push({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } });
          out.push({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.001 });
        }
        out.close();
      })();
      return Object.assign(out, { interrupt: async () => undefined });
    },
  }) as FakeSdk;
}

const proc = (over: Partial<AgentProcess>): AgentProcess => ({
  pid: 100,
  ppid: 1,
  startedAt: T("2026-09-01T09:00:00.000Z"),
  tool: "claude",
  command: "claude",
  cwd: "/Users/kevinliu/demo-app",
  interactive: true,
  sessionId: undefined,
  heldSessionIds: [],
  ...over,
});

const owner = (over: Partial<SessionOwner>): SessionOwner => ({
  pid: 4242,
  sessionId: S1,
  cwd: "/Users/kevinliu/demo-app",
  startedAt: T("2026-09-01T09:00:00.000Z"),
  kind: "interactive",
  entrypoint: "claude-desktop",
  ...over,
});

const pick = (r: { status: string; hint: string }): [string, string] => [r.status, r.hint];

async function until(check: () => boolean, ms = 2_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * CLI discovery pinned to the temp home: an empty PATH, an empty Applications folder and no
 * system dirs, so "codex not found" / "claude not found" is what these tests see whatever
 * is installed on the machine running them. The Codex driver tests (codex.test.ts) install
 * a fake binary on top of this.
 */
function pinned(home: string): Pick<SessionsConnectorOptions, "env" | "applicationsDir" | "cliSystemDirs"> {
  const emptyBin = join(home, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  return { env: { PATH: emptyBin, HOME: home }, applicationsDir: join(home, "Applications"), cliSystemDirs: [] };
}

// ------------------------------------------------------------- claude store ---

test("parseClaudeSession: cwd, ai-title, first prompt, last text, exact count", () => {
  const h = makeHome();
  try {
    const s = parseClaudeSession(S1, h.paths.s1, SLUG, lines(h.paths.s1), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-09-01T10:01:00.000Z") });
    assert.equal(s.tool, "claude");
    assert.equal(s.id, S1);
    assert.equal(s.source, "user");
    assert.equal(s.cwd, "/Users/kevinliu/demo-app");
    assert.equal(s.title, "Fix login redirect to dashboard");
    assert.equal(s.firstPrompt, "fix the login redirect");
    assert.equal(s.lastAssistantText, "The redirect now points at /dashboard after login.");
    assert.equal(s.messageCount, 3, "1 human prompt + 2 assistant messages: the thinking and tool_use lines share one message.id; tool results and sidechains do not count");
    assert.equal(s.messageCountExact, true);
    assert.equal(s.startedAt, T("2026-09-01T10:00:00.000Z"));
    assert.equal(s.lastActivityAt, T("2026-09-01T10:01:00.000Z"));
  } finally {
    h.cleanup();
  }
});

test("parseClaudeSession: slug decode when no cwd, slash command kept as the prompt", () => {
  const h = makeHome();
  try {
    const s = parseClaudeSession(S2, h.paths.s2, SLUG, lines(h.paths.s2), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-08-10T09:02:00.000Z") });
    assert.equal(s.cwd, "/Users/kevinliu/demo/app", "slug dashes are ambiguous; decode is the fallback only");
    assert.equal(s.title, undefined);
    assert.equal(s.firstPrompt, "/review PR 12", "the slash command and its arguments are what Kevin typed");
    assert.equal(s.lastAssistantText, "PR 12 looks good; one nit on naming.");
  } finally {
    h.cleanup();
  }
});

test("parseClaudeSession: Desktop scratch session — harness blocks skipped, real prompt and summary found", () => {
  const h = makeHome();
  try {
    const s = parseClaudeSession(S4, h.paths.s4, SCRATCH_SLUG, lines(h.paths.s4), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-09-01T12:04:00.000Z") });
    assert.equal(s.cwd, "/Users/kevinliu/scratch-demo");
    assert.equal(s.firstPrompt, "port the sessions list to the new sidebar", "the <system-reminder> preamble ahead of the prompt is not the prompt");
    assert.equal(s.title, "Sessions sidebar port", "the summary line names the session");
    assert.equal(s.lastAssistantText, "The sidebar now lists sessions newest first.", "the sidechain assistant line is not the last text");
    assert.equal(s.messageCount, 4, "prompt + '/model claude-fable-5-1' + 2 assistant messages (the last one's thinking line shares its id); isMeta, local-command output, task notifications, bare /clear and sidechains do not count");
    assert.equal(sessionName(s), "Sessions sidebar port");
    assert.equal(sessionName({ ...s, title: undefined }), "port the sessions list to the new sidebar");
    assert.equal(s.startedAt, T("2026-09-01T11:58:10.818Z"));
  } finally {
    h.cleanup();
  }
});

test("userText: injected blocks, unclosed blocks, slash commands, interrupts, block content", () => {
  const u = (content: unknown): string | undefined => userText({ role: "user", content });
  assert.equal(u("<system-reminder>\nscratch workspace notes\n</system-reminder>"), undefined, "a reminder with nothing after it is not a prompt");
  assert.equal(u("<system-reminder>\nscratch workspace notes\n</system-reminder>\nfix the tests"), "fix the tests");
  assert.equal(u("<system-reminder>\ncut off by the head budget and never closed"), undefined);
  assert.equal(u("<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"), undefined);
  assert.equal(u("<local-command-stdout>Set model to claude-fable-5-1</local-command-stdout>"), undefined);
  assert.equal(u("<task-notification>\n<task-id>x</task-id>\n<summary>done</summary>\n</task-notification>"), undefined);
  assert.equal(u("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"), undefined, "a bare housekeeping command is not a prompt");
  assert.equal(u("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 12</command-args>"), "/review PR 12");
  assert.equal(u("<ide_selection>const x = 1</ide_selection>\nwhy is this unused"), "why is this unused");
  assert.equal(u("[Request interrupted by user]"), undefined);
  assert.equal(u([{ type: "text", text: "hello  there" }]), "hello there");
  assert.equal(u([{ type: "tool_result", tool_use_id: "t", content: "x" }]), undefined);
  assert.equal(u(42), undefined);
});

test("decodeProjectSlug", () => {
  assert.equal(decodeProjectSlug("-Users-kevinliu-gt-gt-cloud"), "/Users/kevinliu/gt/gt/cloud");
  assert.equal(decodeProjectSlug("weird"), "weird");
});

test("parseClaudeSession: an assistant message split over thinking/text/tool_use lines counts once; lines without an id count each", () => {
  const facts = { whole: true, bytesRead: 1, size: 1, mtimeMs: 0 };
  const line = (id: string | undefined, block: Record<string, unknown>, uuid: string): string =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", ...(id ? { id } : {}), type: "message", role: "assistant", content: [block] }, uuid, timestamp: "2026-09-01T10:00:00.000Z", cwd: "/x" });
  const user = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "go" }, timestamp: "2026-09-01T09:59:00.000Z", cwd: "/x" });
  const oneMessage = [
    user,
    line("msg_01A", { type: "thinking", thinking: "plan", signature: "s" }, "l1"),
    line("msg_01A", { type: "text", text: "Two commands coming." }, "l2"),
    line("msg_01A", { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } }, "l3"),
    line("msg_01A", { type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "pwd" } }, "l4"),
    line("msg_01B", { type: "text", text: "Both ran." }, "l5"),
  ];
  const s = parseClaudeSession("s", "/x/s.jsonl", "-x", oneMessage, [], facts);
  assert.equal(s.messageCount, 3, "1 prompt + 2 assistant messages over 5 assistant lines");
  assert.equal(s.lastAssistantText, "Both ran.");
  const noIds = [user, line(undefined, { type: "text", text: "a" }, "l1"), line(undefined, { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/x" } }, "l2")];
  assert.equal(parseClaudeSession("s", "/x/s.jsonl", "-x", noIds, [], facts).messageCount, 3, "no message.id (older builds): every line is its own message");
  const toolIdOnly = [user, line(undefined, { type: "tool_use", id: "msg_looks_like_one", name: "Read", input: { id: "msg_also" } }, "l1"), line(undefined, { type: "tool_use", id: "msg_looks_like_one", name: "Read", input: {} }, "l2")];
  assert.equal(parseClaudeSession("s", "/x/s.jsonl", "-x", toolIdOnly, [], facts).messageCount, 3, "ids inside content blocks are not the message id");
});

test("large files: first prompt from the head, title and last text from the tail, count extrapolated", async () => {
  const h = makeHome();
  try {
    const path = join(h.claudeRoot, SLUG, "33333333-3333-4333-8333-333333333333.jsonl");
    const sid = "33333333-3333-4333-8333-333333333333";
    const head = [
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "refactor the billing module" }, timestamp: "2026-09-01T11:00:00.000Z", cwd: "/Users/kevinliu/demo-app", sessionId: sid }),
      JSON.stringify({ type: "ai-title", aiTitle: "Early title that gets replaced", sessionId: sid }),
    ];
    const filler = JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "x".repeat(300) } }] }, timestamp: "2026-09-01T11:30:00.000Z", sessionId: sid });
    const tail = [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Billing is split into invoices and payments." }] }, timestamp: "2026-09-01T12:00:00.000Z", sessionId: sid }),
      JSON.stringify({ type: "custom-title", customTitle: "Billing refactor", sessionId: sid }),
    ];
    const body = [...head, ...Array.from({ length: 1500 }, () => filler), ...tail].join("\n") + "\n";
    writeFileSync(path, body);
    assert.ok(body.length > 64 * 1024 + 256 * 1024, "fixture must exceed the head+tail budget");
    h.touch(path, T("2026-09-01T12:00:00.000Z"));

    const slices = await readHeadTail(path, 64 * 1024, 256 * 1024);
    assert.equal(slices.whole, false);
    for (const l of [...slices.head, ...slices.tail]) JSON.parse(l); // every kept line is complete

    const store = new ClaudeStore({ root: h.claudeRoot, now: () => NOW });
    const s = (await store.scan()).find((x) => x.id === sid);
    assert.ok(s);
    assert.equal(s.firstPrompt, "refactor the billing module");
    assert.equal(s.title, "Billing refactor", "custom-title beats ai-title");
    assert.equal(s.lastAssistantText, "Billing is split into invoices and payments.");
    assert.equal(s.messageCountExact, false);
    assert.ok(s.messageCount > 1000 && s.messageCount < 2000, `extrapolated ${s.messageCount}`);
  } finally {
    h.cleanup();
  }
});

test("readHeadTail: a cut that lands exactly on a line break keeps the complete lines beside it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarhead-headtail-"));
  try {
    const L = ['{"n":1,"text":"first prompt"}', '{"n":2}', '{"n":3,"pad":"xxxxxxxxxxxx"}', '{"n":4}', '{"n":5,"pad":"yyyyyy"}', '{"n":6,"text":"last answer"}'];
    const path = join(dir, "f.jsonl");
    writeFileSync(path, `${L.join("\n")}\n`);
    const onBreak = await readHeadTail(path, L[0]!.length + 1, L[5]!.length + 1);
    assert.equal(onBreak.whole, false);
    assert.deepEqual(onBreak.head, [L[0]], "the head ends on the newline after line 1: line 1 is complete and stays");
    assert.deepEqual(onBreak.tail, [L[5]], "the tail starts right after the newline before line 6: line 6 is complete and stays");
    assert.equal(onBreak.bytesRead, L[0]!.length + 1 + L[5]!.length + 1);
    const midLine = await readHeadTail(path, L[0]!.length + 4, L[5]!.length + 4);
    assert.deepEqual(midLine.head, [L[0]], "a torn line 2 is dropped");
    assert.deepEqual(midLine.tail, [L[5]], "a torn line 5 is dropped");
    const twoEach = await readHeadTail(path, L[0]!.length + L[1]!.length + 2, L[4]!.length + L[5]!.length + 2);
    assert.deepEqual(twoEach.head, [L[0], L[1]]);
    assert.deepEqual(twoEach.tail, [L[4], L[5]]);
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const e = await readHeadTail(empty, 64, 256);
    assert.deepEqual([e.head, e.tail, e.whole, e.size], [[], [], true, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ClaudeStore.scan: skips files older than maxAgeDays, honours limit, caches by mtime", async () => {
  const h = makeHome();
  try {
    const store = new ClaudeStore({ root: h.claudeRoot, now: () => NOW });
    const first = await store.scan();
    assert.deepEqual(first.map((s) => s.id), [S4, S1], "newest first; the 23-day-old session is outside the window");
    const again = await store.scan();
    assert.equal(again[1], first[1], "unchanged file → same cached object");
    appendFileSync(h.paths.s1, JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Also fixed the logout path." }] }, timestamp: "2026-09-01T10:05:00.000Z", sessionId: S1 }) + "\n");
    h.touch(h.paths.s1, T("2026-09-01T10:05:00.000Z"));
    const changed = (await store.scan()).find((s) => s.id === S1);
    assert.equal(changed?.lastAssistantText, "Also fixed the logout path.");
    assert.equal(changed?.messageCount, 4);

    const all = new ClaudeStore({ root: h.claudeRoot, now: () => NOW, maxAgeDays: 365, limit: 1 });
    assert.equal((await all.scan()).length, 1);
    assert.equal((await all.find(S2))?.firstPrompt, "/review PR 12", "find() ignores the age window");
  } finally {
    h.cleanup();
  }
});

// -------------------------------------------------------------- codex store ---

test("parseCodexSession (0.153 user thread): meta, real first prompt, last text, turns counted once", () => {
  const h = makeHome();
  try {
    const s = parseCodexSession(h.paths.c1, lines(h.paths.c1), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-09-01T09:05:00.000Z"), archived: false });
    assert.equal(s.tool, "codex");
    assert.equal(s.id, C1);
    assert.equal(s.source, "user");
    assert.equal(s.parentId, undefined);
    assert.equal(s.cwd, "/Users/kevinliu/demo-site");
    assert.equal(s.firstPrompt, "make the hero font DM Sans", "AGENTS.md, plugin lists and developer context are not prompts");
    assert.equal(s.lastAssistantText, "Switched the hero heading to DM Sans and rebuilt.", "inter-agent agent_message chatter is skipped");
    assert.equal(s.startedAt, T("2026-09-01T08:59:59.000Z"), "session_meta payload timestamp is the earliest");
    assert.equal(s.lastActivityAt, T("2026-09-01T09:05:00.000Z"));
    assert.equal(s.messageCount, 3, "1 user + 2 assistant response_item messages; item_completed events are not turns");
    assert.equal(s.messageCountExact, true);
    assert.equal(s.archived, false);
  } finally {
    h.cleanup();
  }
});

test("parseCodexSession: sub-agent rollout keeps its own id and names its parent; automation run has no prompt", () => {
  const h = makeHome();
  try {
    const sub = parseCodexSession(h.paths.c3, lines(h.paths.c3), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-09-01T09:06:00.000Z"), archived: false });
    assert.equal(sub.id, C3, "payload.id (the filename's), not session_id (the parent's)");
    assert.equal(sub.source, "subagent", "the parent's session_meta copied in as line 2 does not make this a user thread");
    assert.equal(sub.parentId, C1);
    assert.equal(sub.cwd, "/Users/kevinliu/demo-site");
    assert.equal(sub.firstPrompt, "Find every hero font declaration and report the files.");
    assert.equal(sub.messageCount, 2);

    const auto = parseCodexSession(h.paths.c4, lines(h.paths.c4), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-09-01T07:01:00.000Z"), archived: false });
    assert.equal(auto.id, C4);
    assert.equal(auto.source, "automation");
    assert.equal(auto.parentId, undefined);
    assert.equal(auto.firstPrompt, undefined, "its only user message is an injected plugin list");
    assert.equal(auto.lastAssistantText, "Compiled the wiki sources; nothing changed.");
  } finally {
    h.cleanup();
  }
});

test("parseCodexSession: 0.145 double-recorded turns count once; event-only slices fall back to events", () => {
  const h = makeHome();
  try {
    const s = parseCodexSession(h.paths.c2, lines(h.paths.c2), [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-08-30T12:01:00.000Z"), archived: true });
    assert.equal(s.messageCount, 2, "event_msg echoes of response_item turns are not extra messages");
    assert.equal(s.firstPrompt, "rename the package");
    assert.equal(s.lastAssistantText, "Renamed it to old-thing-core.");
    assert.equal(s.archived, true);

    const eventsOnly = [
      JSON.stringify({ timestamp: "2026-08-30T12:00:00.000Z", type: "session_meta", payload: { session_id: C2, id: C2, cwd: "/x", cli_version: "0.145.0" } }),
      JSON.stringify({ timestamp: "2026-08-30T12:00:05.000Z", type: "event_msg", payload: { type: "user_message", message: "rename the package" } }),
      JSON.stringify({ timestamp: "2026-08-30T12:01:00.000Z", type: "event_msg", payload: { type: "agent_message", message: "Renamed it." } }),
    ];
    const e = parseCodexSession(h.paths.c2, eventsOnly, [], { whole: true, bytesRead: 10, size: 10, mtimeMs: T("2026-08-30T12:01:00.000Z"), archived: true });
    assert.equal(e.messageCount, 2, "no response_item messages at all → the event echo is the count");
    assert.equal(e.source, "unknown", "no thread_source before 0.148");

    const legacyChild = [JSON.stringify({ timestamp: "2026-08-30T12:00:00.000Z", type: "session_meta", payload: { session_id: C1, parent_thread_id: C1, cwd: "/x" } })];
    const l = parseCodexSession(h.paths.c3, legacyChild, [], { whole: true, bytesRead: 10, size: 10, mtimeMs: 0, archived: false });
    assert.equal(l.id, C3, "no payload.id → the filename id, never the parent's session_id");
    assert.equal(l.source, "subagent", "a parent that is not itself marks a child even without thread_source");

    const nestedOnly = [JSON.stringify({ timestamp: "2026-09-01T09:02:00.000Z", type: "session_meta", payload: { session_id: C1, id: C3, cwd: "/x", thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: C1, depth: 1, agent_path: "/root/x", agent_nickname: "Nash", agent_role: null } } } } })];
    const n = parseCodexSession(h.paths.c3, nestedOnly, [], { whole: true, bytesRead: 10, size: 10, mtimeMs: 0, archived: false });
    assert.equal(n.parentId, C1, "the parent under source.subagent.thread_spawn when there is no top-level parent_thread_id");
    assert.equal(n.source, "subagent");
  } finally {
    h.cleanup();
  }
});

test("CodexStore.scan: lists user threads only, one per id, cap applied after the filter; find() reaches everything", async () => {
  const h = makeHome();
  try {
    const store = new CodexStore({ root: h.codexRoot, now: () => NOW });
    const got = await store.scan();
    assert.deepEqual(got.map((s) => [s.id, s.archived]), [[C1, false], [C2, true]], "the newer sub-agent rollout and the automation run are not sessions");
    assert.equal(new Set(got.map((s) => s.id)).size, got.length, "ids are unique");
    assert.equal(got[0]?.path, h.paths.c1, "the parent's own file, not its sub-agent's");
    assert.equal(got[0]?.title, "Hero font swap", "session_index.jsonl names the thread; the last line for an id wins");
    assert.equal(got[0]?.firstPrompt, "make the hero font DM Sans");
    assert.equal(got[1]?.title, "Rename package");
    assert.equal(got[1]?.firstPrompt, "rename the package");
    assert.equal(sessionName({ ...got[0]!, title: undefined }), "make the hero font DM Sans", "no index entry → the prompt names it");

    const capped = new CodexStore({ root: h.codexRoot, now: () => NOW, limit: 1 });
    assert.deepEqual((await capped.scan()).map((s) => s.id), [C1], "a cap of 1 still yields the newest listed thread, not the newest file");

    assert.equal((await store.find(C2))?.cwd, "/Users/kevinliu/old-thing");
    const sub = await store.find(C3);
    assert.equal(sub?.source, "subagent");
    assert.equal(sub?.parentId, C1);
    assert.equal(sub?.title, undefined, "sub-agents are not in the index");
    const auto = await store.find(C4);
    assert.equal(auto?.source, "automation");
    assert.equal(auto?.title, "Wiki source compile");

    writeFileSync(join(h.codexRoot, "session_index.jsonl"), `{"id":"${C1}","thread_name":"Hero font, renamed","updated_at":"2026-09-01T09:10:00Z"}\n`);
    h.touch(join(h.codexRoot, "session_index.jsonl"), T("2026-09-01T09:10:00.000Z"));
    assert.equal((await store.scan())[0]?.title, "Hero font, renamed", "a changed index is re-read even though the rollout parse is cached");
    assert.equal((await store.scan())[1]?.title, undefined, "C2 is no longer in the index");
    rmSync(join(h.codexRoot, "session_index.jsonl"));
    assert.equal((await store.find(C2))?.title, undefined, "no index file → no titles, no error");
    assert.equal(idFromFilename("rollout-2026-08-25T20-39-07-01a03c26-7303-7693-9bd8-8e3f3a41d79a.jsonl"), "01a03c26-7303-7693-9bd8-8e3f3a41d79a");
    assert.equal(idFromFilename("notes.jsonl"), undefined);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------- processes ---

const PS_SAMPLE = [
  "  PID  PPID                  STARTED COMMAND",
  "  295  9304 Wed Sep  9 17:28:00 2026 /Applications/Claude.app/Contents/Helpers/disclaimer -- /Users/kevinliu/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude --output-format stream-json",
  `  297   295 Wed Sep  9 17:28:00 2026 /Users/kevinliu/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude --output-format stream-json --verbose --input-format stream-json --model claude-fable-5-1 --permission-prompt-tool stdio --resume=${S1} --replay-user-messages`,
  " 4083   686 Tue Sep  8 09:33:04 2026 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled",
  " 4415   686 Tue Sep  8 09:33:05 2026 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer",
  " 4587   686 Tue Sep  8 09:33:09 2026 /Users/kevinliu/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
  " 5633   686 Tue Sep  8 09:33:09 2026 /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host",
  "13996     1 Tue Sep  8 09:40:00 2026 /Applications/ChatGPT.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate com.openai.codex /Users/kevinliu kevinliu",
  "47447 34610 Thu Sep 10 13:16:38 2026 /Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://",
  "60001 60000 Thu Sep 10 13:20:00 2026 claude",
  "60002 60000 Thu Sep 10 13:21:00 2026 node /usr/local/bin/claude -p hello",
  "60003 60000 Thu Sep 10 13:22:00 2026 codex",
  "60004 60000 Thu Sep 10 13:23:00 2026 /opt/homebrew/bin/gemini --model x",
  "60005 60000 Thu Sep 10 13:24:00 2026 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility",
  "60006 60000 Thu Sep 10 13:25:00 2026 vim /tmp/claude notes",
  `60007 60000 Thu Sep 10 13:26:00 2026 codex resume ${C1}`,
  `60008 60000 Thu Sep 10 13:27:00 2026 claude -r ${S2} --model claude-fable-5-1`,
].join("\n");

test("parsePs + classifyCommand match agent CLIs, skip Electron helpers, read session ids off argv", () => {
  const rows = parsePs(PS_SAMPLE);
  assert.equal(rows.length, 16);
  assert.equal(rows[0]?.pid, 295);
  assert.equal(rows[0]?.startedAt, new Date(2026, 8, 9, 17, 28, 0).getTime());
  const classified = rows.map((r) => [r.pid, classifyCommand(r.command)] as const).filter(([, c]) => c !== undefined);
  assert.deepEqual(
    classified.map(([pid, c]) => `${pid}:${c?.tool}:${c?.interactive ? "tui" : "headless"}${c?.sessionId ? `:${c.sessionId.slice(0, 8)}` : ""}`),
    ["297:claude:headless:11111111", "4083:codex:headless", "47447:codex:headless", "60001:claude:tui", "60002:claude:headless", "60003:codex:tui", "60004:gemini:tui", "60007:codex:tui:01a0aaaa", "60008:claude:tui:22222222"],
  );
  assert.equal(sessionIdFromArgs("claude", `--resume ${S1.toUpperCase()}`), S1, "space-separated and case-folded");
  assert.equal(sessionIdFromArgs("claude", `--session-id=${S1}`), S1);
  assert.equal(sessionIdFromArgs("claude", "-r"), undefined, "a bare -r opens the picker; no id");
  assert.equal(sessionIdFromArgs("claude", "--resume=not-a-uuid"), undefined);
  assert.equal(sessionIdFromArgs("codex", "app-server"), undefined);
  assert.equal(sessionIdFromArgs("gemini", `--resume ${S1}`), undefined);
  // The sessions connector's own children: `codex exec resume --json … -c key=value -- <id> <prompt>`.
  assert.equal(sessionIdFromArgs("codex", `exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" -- ${C1} fix the header`), C1, "flags and their values before --, then the id");
  assert.equal(sessionIdFromArgs("codex", `exec resume ${C1} fix the header`), C1);
  assert.equal(sessionIdFromArgs("codex", "exec resume --last"), undefined, "--last names no id");
  assert.equal(sessionIdFromArgs("codex", `exec --json -C /tmp/x -- ${C1}`), undefined, "a new thread whose prompt is a UUID is not a resume");
  assert.deepEqual(classifyCommand(`/Applications/ChatGPT.app/Contents/Resources/codex exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" -- ${C1} fix the header`), { tool: "codex", interactive: false, sessionId: C1 });
});

/** `lsof -n -P -a -p <codex pids> -Fn`: Codex Desktop's app-server (cwd `/`) holds the rollouts and writer locks of the threads it drives. */
const LSOF_FILES_SAMPLE = [
  "p4083",
  "fcwd",
  "n/",
  "f40",
  `n/Users/kevinliu/.codex/sessions/2026/09/01/rollout-2026-09-01T09-00-00-${C1}.jsonl`,
  "f41",
  `n/Users/kevinliu/.codex/thread-writer-locks/${C1}.lock`,
  "f42",
  `n/Users/kevinliu/.codex/sessions/2026/09/01/rollout-2026-09-01T09-02-00-${C3}.jsonl`,
  "f43",
  `n/Users/kevinliu/.codex/thread-writer-locks/${C3}.lock`,
  "f44",
  "n/Users/kevinliu/.codex/state_5.sqlite",
  "f45",
  "n/Users/kevinliu/.codex/session_index.jsonl",
  "f46",
  "n/Users/kevinliu/.codex/sessions/2026/09/01/notes.jsonl",
  "p47447",
  "fcwd",
  "n/Users/kevinliu/repos/other",
  "f5",
  "n/dev/null",
  "",
].join("\n");

test("parseLsofCwd, parseLsofSessionFiles and listAgentProcesses: snapshot, held rollouts, pids, and degraded when lsof or ps fail", async () => {
  assert.deepEqual([...parseLsofCwd("p297\nfcwd\nn/Users/kevinliu/gt/gt-cloud\np4083\nfcwd\nn/\n")], [[297, "/Users/kevinliu/gt/gt-cloud"], [4083, "/"]]);
  assert.deepEqual([...parseLsofSessionFiles(LSOF_FILES_SAMPLE)], [[4083, [C1, C3]]], "rollout files and writer locks name threads, once each; other files and pids do not");
  assert.deepEqual([...parseLsofSessionFiles(`p1\nf3\nn/Users/k/.codex/archived_sessions/rollout-2026-08-30T12-00-00-${C2}.jsonl\n`)], [[1, [C2]]]);
  const calls: string[][] = [];
  const snap = await listAgentProcesses({
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === "ps") return PS_SAMPLE;
      assert.equal(file, "lsof");
      if (args.includes("cwd")) return "p297\nfcwd\nn/Users/kevinliu/gt/gt-cloud\np60001\nfcwd\nn/Users/kevinliu/demo-app\n";
      return LSOF_FILES_SAMPLE;
    },
  });
  assert.equal(calls.length, 3, "one ps, one batched lsof for cwds, one for the codex pids' open files");
  assert.equal(calls[1]?.[3], "297,4083,47447,60001,60002,60003,60004,60007,60008");
  assert.deepEqual(calls[2], ["lsof", "-n", "-P", "-a", "-p", "4083,47447,60003,60007", "-Fn"]);
  assert.equal(snap.degraded, undefined);
  assert.equal(snap.processes.find((p) => p.pid === 297)?.cwd, "/Users/kevinliu/gt/gt-cloud");
  assert.equal(snap.processes.find((p) => p.pid === 297)?.sessionId, S1);
  assert.deepEqual(snap.processes.find((p) => p.pid === 297)?.heldSessionIds, []);
  assert.equal(snap.processes.find((p) => p.pid === 60001)?.cwd, "/Users/kevinliu/demo-app");
  assert.equal(snap.processes.find((p) => p.pid === 4083)?.cwd, undefined, "lsof denied for one pid → no cwd, still listed, not degraded");
  assert.deepEqual(snap.processes.find((p) => p.pid === 4083)?.heldSessionIds, [C1, C3], "the app-server's open rollouts");
  assert.deepEqual(snap.processes.find((p) => p.pid === 47447)?.heldSessionIds, []);
  assert.ok(snap.pids.has(4415) && snap.pids.has(60006), "every ps row's pid, agent or not");

  const denied = await listAgentProcesses({
    exec: async (file) => {
      if (file === "ps") return PS_SAMPLE;
      throw new Error("lsof: permission denied");
    },
  });
  assert.equal(denied.processes.length, 9, "processes are still reported");
  assert.match(denied.degraded ?? "", /^lsof failed: lsof: permission denied$/);
  assert.ok(denied.processes.every((p) => p.cwd === undefined && p.heldSessionIds.length === 0));

  const noFiles = await listAgentProcesses({
    exec: async (file, args) => {
      if (file === "ps") return PS_SAMPLE;
      if (args.includes("cwd")) return "p297\nfcwd\nn/Users/kevinliu/gt/gt-cloud\n";
      throw new Error("lsof: timed out");
    },
  });
  assert.match(noFiles.degraded ?? "", /^lsof \(open files\) failed: lsof: timed out$/, "the open-files pass failing degrades the snapshot too");
  assert.equal(noFiles.processes.find((p) => p.pid === 297)?.cwd, "/Users/kevinliu/gt/gt-cloud", "cwds from the pass that worked are kept");

  const claudeOnly = await listAgentProcesses({
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === "ps") return PS_SAMPLE.split("\n").filter((l) => !/codex/.test(l)).join("\n");
      return "";
    },
  });
  assert.equal(claudeOnly.degraded, undefined);
  assert.ok(!calls.slice(3).some((c) => c[0] === "lsof" && c.includes("-n")), "no codex pid → no open-files pass");

  const noPs = await listAgentProcesses({ exec: async () => { throw new Error("no ps"); } });
  assert.deepEqual(noPs.processes, []);
  assert.equal(noPs.pids.size, 0);
  assert.match(noPs.degraded ?? "", /^ps failed: no ps$/);
});

test("defaultExec: a child the timeout kills rejects even with partial stdout; lsof's exit 1 with output resolves", async () => {
  // A ps that prints its header and one row, then hangs past the timeout.
  const partialPs = ["-c", "printf '  PID  PPID                  STARTED COMMAND\\n 4083   686 Tue Sep  8 09:33:04 2026 /Applications/ChatGPT.app/Contents/Resources/codex app-server\\n'; sleep 3"];
  await assert.rejects(defaultExec("sh", partialPs, 200), (e: unknown) => (e as { killed?: boolean }).killed === true, "killed by the timeout → rejected, partial rows and all");
  assert.equal(await defaultExec("sh", ["-c", "printf 'p1\\nfcwd\\nn/x\\n'; exit 1"], 2_000), "p1\nfcwd\nn/x\n", "lsof's exit 1 with output is fine");
  await assert.rejects(defaultExec("sh", ["-c", "exit 1"], 2_000), "exit 1 with nothing to show is not");

  // The connector below uses its default 2 s timeout; 200 ms is plenty for a child that never finishes.
  const exec = (file: string, _args: readonly string[], timeoutMs: number): Promise<string> => (file === "ps" ? defaultExec("sh", partialPs, Math.min(timeoutMs, 200)) : Promise.resolve(""));
  const snap = await listAgentProcesses({ exec, timeoutMs: 200 });
  assert.match(snap.degraded ?? "", /^ps failed: /, "a truncated ps is a failed ps");
  assert.deepEqual(snap.processes, []);
  assert.equal(snap.pids.size, 0, "a truncated pid list is no pid list");

  const h = makeHome();
  try {
    h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    const sdk = fakeSdk("ok", 10);
    const c = new SessionsConnector({ home: h.home, ...pinned(h.home), now: () => NOW, sdk, processCacheMs: 0, exec });
    const refused = await c.send(`sessions:claude:${S1}`, "hello");
    assert.equal(refused.accepted, false);
    assert.match(refused.detail ?? "", /^cannot tell whether that session is open \(ps failed: /);
    assert.equal(sdk.options.length, 0, "nothing resumed on a truncated snapshot");
  } finally {
    h.cleanup();
  }
});

test("readClaudeRegistry: <pid>.json entries only; .key files and malformed entries are skipped", async () => {
  const h = makeHome();
  try {
    const entries = (await readClaudeRegistry(h.registryDir)).sort((a, b) => a.pid - b.pid);
    assert.deepEqual(
      entries,
      [
        { pid: 4242, sessionId: S1, cwd: "/Users/kevinliu/demo-app", startedAt: 1788598800000, kind: "interactive", entrypoint: "claude-desktop" },
        { pid: 9999, sessionId: S2, cwd: "/Users/kevinliu/demo-app", startedAt: 1786785600000, kind: "interactive", entrypoint: "cli" },
      ],
      "7.json is not JSON; the .key secret is never read",
    );
    assert.deepEqual(await readClaudeRegistry(join(h.home, "missing")), []);
    assert.equal(parseRegistryEntry('{"pid":"12","sessionId":"x"}'), undefined, "pid must be a number");
    assert.equal(parseRegistryEntry('{"pid":12}'), undefined);
    assert.equal(parseRegistryEntry("[]"), undefined);
    assert.deepEqual(parseRegistryEntry('{"pid":12,"sessionId":"x"}'), { pid: 12, sessionId: "x", cwd: undefined, startedAt: undefined, kind: undefined, entrypoint: undefined });
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------------- status ---

test("liveProcessesFor: registry first, argv second, cwd + start-time heuristic only for unregistered processes", () => {
  const h = makeHome();
  try {
    const s = parseClaudeSession(S1, h.paths.s1, SLUG, lines(h.paths.s1), [], { whole: true, bytesRead: 1, size: 1, mtimeMs: T("2026-09-01T10:01:00.000Z") });
    const last = s.lastActivityAt;

    // 1. Registry: the pid Claude Code recorded for this id owns it, whatever cwd or start time say.
    const elsewhere = proc({ pid: 4242, cwd: "/elsewhere", startedAt: last + 60_000, interactive: false });
    assert.deepEqual(liveProcessesFor(s, [elsewhere], [owner({ pid: 4242 })]).map((p) => p.pid), [4242]);
    assert.deepEqual(liveProcessesFor(s, [elsewhere], []), [], "without the registry, wrong cwd and late start rule it out");
    const ghost = liveProcessesFor(s, [], [owner({ pid: 4242, cwd: "/Users/kevinliu/demo-app" })]);
    assert.equal(ghost.length, 1, "an alive registry entry ps did not classify still counts");
    assert.equal(ghost[0]?.interactive, false, "Desktop, not a terminal");
    assert.match(ghost[0]?.command ?? "", /registry/);
    assert.equal(liveProcessesFor(s, [], [owner({ pid: 4242, entrypoint: "cli" })])[0]?.interactive, true);

    // A registered pid on another session is not this one's, even in the same folder and started in time.
    const sameFolder = proc({ pid: 9999, cwd: "/Users/kevinliu/demo-app", startedAt: T("2026-09-01T09:00:00.000Z") });
    assert.deepEqual(liveProcessesFor(s, [sameFolder], [owner({ pid: 9999, sessionId: S2 })]), []);
    assert.deepEqual(liveProcessesFor(s, [sameFolder], []).map((p) => p.pid), [9999], "unregistered, the heuristic applies");

    // 2. argv: --resume=<id> names the session; a different id rules it out.
    assert.deepEqual(liveProcessesFor(s, [proc({ pid: 7777, cwd: undefined, startedAt: undefined, sessionId: S1 })]).map((p) => p.pid), [7777]);
    assert.deepEqual(liveProcessesFor(s, [proc({ pid: 7778, sessionId: S2 })]), [], "same cwd, but argv says another session");

    // 3. Heuristic for the rest.
    const own = proc({ startedAt: T("2026-09-01T09:00:00.000Z") });
    assert.deepEqual(liveProcessesFor(s, [own]).map((p) => p.pid), [100]);
    assert.deepEqual(liveProcessesFor(s, [proc({ startedAt: last + 60_000 })]), [], "a process started after the last write cannot own the file");
    assert.deepEqual(liveProcessesFor(s, [proc({ cwd: "/elsewhere" })]), []);
    assert.deepEqual(liveProcessesFor(s, [proc({ tool: "codex" })]), [], "a codex process never owns a claude session");
    assert.deepEqual(liveProcessesFor({ ...s, archived: true }, [own]), []);

    // 2 again, for Codex: the rollouts a process holds open name its threads; cwd `/` says nothing.
    const c1 = parseCodexSession(h.paths.c1, lines(h.paths.c1), [], { whole: true, bytesRead: 1, size: 1, mtimeMs: T("2026-09-01T09:05:00.000Z"), archived: false });
    const desktop = proc({ pid: 4083, tool: "codex", cwd: "/", startedAt: T("2026-08-31T00:00:00.000Z"), interactive: false, heldSessionIds: [C1, C3] });
    assert.deepEqual(liveProcessesFor(c1, [desktop]).map((p) => p.pid), [4083], "Codex Desktop's app-server holds this thread's rollout");
    assert.deepEqual(liveProcessesFor({ ...c1, id: C2, cwd: "/" }, [desktop]), [], "a thread in the app-server's own cwd is not its unless it holds the rollout");
    assert.deepEqual(liveProcessesFor({ ...c1, id: "01a0ffff-0000-7000-8000-00000000000f" }, [desktop]), [], "same folder as a held thread, but its rollout is not open: not live");
    const bare = proc({ pid: 60003, tool: "codex", cwd: "/Users/kevinliu/demo-site", startedAt: T("2026-09-01T09:00:00.000Z") });
    assert.deepEqual(liveProcessesFor(c1, [bare]).map((p) => p.pid), [60003], "a codex process holding no rollout falls back to cwd and start time");
    assert.deepEqual(liveProcessesFor(c1, [proc({ pid: 60007, tool: "codex", cwd: undefined, sessionId: C1 })]).map((p) => p.pid), [60007], "`codex resume <id>` on argv");
    assert.deepEqual(liveProcessesFor(c1, [desktop, bare]).map((p) => p.pid), [4083, 60003]);
  } finally {
    h.cleanup();
  }
});

test("statusFor: archived; working under the 30 s lease from the last turn-bearing write, idle past it or after a closing marker; ended with no process at any age; unknown only when the snapshot is degraded; names and details", () => {
  const h = makeHome();
  try {
    const s = parseClaudeSession(S1, h.paths.s1, SLUG, lines(h.paths.s1), [], { whole: true, bytesRead: 1, size: 1, mtimeMs: T("2026-09-01T10:01:00.000Z") });
    const last = s.lastActivityAt;
    assert.deepEqual(s.lastTurn, { kind: "open", at: last }, "the fixture ends on a tool_result line: a turn is open");
    assert.equal(statusFor({ ...s, archived: true }, [proc({})], last, LEASES).status, "done");
    assert.equal(statusFor({ ...s, archived: true }, [], last, LEASES).hint, "archived");

    const own = proc({ startedAt: T("2026-09-01T09:00:00.000Z") });
    assert.deepEqual(pick(statusFor(s, [own], last + 10_000, LEASES)), ["working", "running"], "a turn-bearing write 10 s ago with its process alive");
    assert.equal(statusFor(s, [own], last + 30_000, LEASES).status, "working", "at the edge of the lease");
    assert.deepEqual(pick(statusFor(s, [own], last + 31_000, LEASES)), ["idle", "quiet"], "past the lease: alive, quiet");
    assert.equal(statusFor(s, [own], last + 10 * 60_000, LEASES).status, "idle", "alive but quiet for 10 min");
    assert.equal(statusFor({ ...s, lastTurn: { kind: "closed", at: last } }, [own], last + 1_000, LEASES).status, "idle", "a closing marker (end_turn / task_complete) ends the lease at once");
    assert.equal(statusFor({ ...s, mtimeMs: last + 20_000, lastTurn: { kind: "open", at: last - 60_000 } }, [own], last + 25_000, LEASES).status, "idle", "token counts move the mtime, never the lease");
    assert.equal(statusFor({ ...s, lastTurn: undefined }, [own], last + 10_000, LEASES).status, "working", "a file with no markers falls back to its mtime");
    assert.equal(statusFor({ ...s, lastTurn: undefined }, [own], last + 31_000, LEASES).status, "idle");
    assert.equal(statusFor(s, [proc({ startedAt: last + 60_000 })], last + 90_000, LEASES).status, "ended", "a process started after the last write is not its owner: nobody is");
    assert.equal(statusFor(s, [], last + 10 * 60_000, LEASES, [owner({ pid: 4242 })]).status, "idle", "registry-owned: alive even with no classified process");
    assert.equal(statusFor(s, [], last + 30_000, LEASES, [owner({ pid: 4242 })]).status, "working");

    const ended = statusFor(s, [], last + 3_600_000, LEASES);
    assert.deepEqual(pick(ended), ["ended", "ended"], "no process, an hour old: ended (not done)");
    assert.equal(statusFor(s, [], last + 3 * 86_400_000, LEASES).status, "ended", "no process, three days old: still ended, never unknown for age");
    assert.equal(statusFor(s, [], last + 10_000, LEASES).status, "ended", "no process, ten seconds old: ended too");
    assert.deepEqual(pick(statusFor(s, [], last + 3_600_000, LEASES, [], "ps failed: timed out")), ["unknown", "unseen"], "degraded evidence is unknown, not a verdict");
    assert.equal(statusFor(s, [own], last + 10_000, LEASES, [], "lsof failed").status, "working", "an owner found despite a degraded snapshot still counts");

    assert.equal(sessionName(s), "Fix login redirect to dashboard");
    assert.equal(sessionName({ ...s, title: undefined }), "fix the login redirect");
    assert.equal(sessionName({ ...s, title: undefined, firstPrompt: undefined }), "claude · demo-app");
    assert.equal(sessionDetail(s), "claude · 3 msgs · demo-app", "no relative time: the rail formats that from updatedAt");
    assert.equal(sessionDetail(s, "resumed: thinking"), "claude · 3 msgs · demo-app · resumed: thinking");
    assert.equal(formatMessageCount(1, true), "1 msg");
    assert.equal(formatMessageCount(23654, false), "~24k msgs");
    assert.equal(formatMessageCount(2345, false), "~2.3k msgs");
    assert.equal(formatMessageCount(257, false), "~260 msgs");
  } finally {
    h.cleanup();
  }
});

test("helpers: ago, truncate, parseSessionsAgentId, summarizeToolInput", () => {
  assert.equal(ago(NOW - 10_000, NOW), "just now");
  assert.equal(ago(NOW - 12 * 60_000, NOW), "12m ago");
  assert.equal(ago(NOW - 5 * 3_600_000, NOW), "5h ago");
  assert.equal(truncate("  a   very\n long   prompt ", 12), "a very long…");
  assert.deepEqual(parseSessionsAgentId(`sessions:claude:${S1}`), { tool: "claude", localId: S1 });
  assert.deepEqual(parseSessionsAgentId(`codex:${C1}`), { tool: "codex", localId: C1 });
  assert.equal(parseSessionsAgentId("sessions:gemini:x"), undefined);
  assert.equal(parseSessionsAgentId("herdr:w1:p1"), undefined);
  assert.equal(parseSessionsAgentId("sessions:claude:"), undefined);
  assert.equal(summarizeToolInput("Bash", { command: "rm -rf build", description: "clean" }), "rm -rf build");
  assert.equal(summarizeToolInput("Write", { file_path: "/tmp/x.ts", content: "..." }), "/tmp/x.ts");
  assert.equal(summarizeToolInput("WebFetch", { url: "https://example.com" }), "https://example.com");
  assert.equal(summarizeToolInput("Thing", { n: 1 }), "");
});

// ---------------------------------------------------------------- connector ---

function connector(h: Home, over: { procs?: AgentProcess[]; sdk?: SdkLike; now?: () => number; permissionTimeoutMs?: number } = {}): SessionsConnector {
  return new SessionsConnector({
    home: h.home,
    ...pinned(h.home),
    now: over.now ?? (() => NOW),
    processes: async () => over.procs ?? [],
    ...(over.sdk ? { sdk: over.sdk } : {}),
    ...(over.permissionTimeoutMs !== undefined ? { permissionTimeoutMs: over.permissionTimeoutMs } : {}),
    pollMs: 30,
    settlePollMs: 10,
    settleQuietMs: 40,
    processCacheMs: 0,
  });
}

test("list(): ids unique, no sub-agent or automation rows, names, details, statuses, sort, and health()", async () => {
  const h = makeHome();
  try {
    mkdirSync(join(h.home, ".gemini"));
    // pid 4242 is registered to S1 in ~/.claude/sessions/4242.json; ps shows it alive.
    const desktop = proc({ pid: 4242, cwd: "/Users/kevinliu/demo-app", startedAt: T("2026-09-01T09:00:00.000Z"), interactive: false });
    // Codex Desktop's app-server: cwd `/`, holding the rollouts of C1 and its sub-agent C3.
    const codexDesktop = proc({ pid: 4083, tool: "codex", command: "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled", cwd: "/", startedAt: T("2026-08-31T00:00:00.000Z"), interactive: false, heldSessionIds: [C1, C3] });
    const c = connector(h, { procs: [desktop, codexDesktop], now: () => T("2026-09-01T10:01:30.000Z") });
    const list = await c.list();
    assert.deepEqual(
      list.map((a) => a.id),
      [`sessions:claude:${S4}`, `sessions:claude:${S1}`, `sessions:codex:${C1}`, `sessions:codex:${C2}`],
      "newest first; the 23-day-old claude session, the codex sub-agent and the automation run are out",
    );
    assert.equal(new Set(list.map((a) => a.id)).size, list.length);
    const [scratch, claude, codex, archived] = list as [AgentInfo, AgentInfo, AgentInfo, AgentInfo];
    assert.equal(scratch.name, "Sessions sidebar port");
    assert.equal(scratch.status, "ended", "no process owns it");
    assert.equal(scratch.hint, "ended");
    assert.equal(claude.kind, "sessions");
    assert.equal(claude.name, "Fix login redirect to dashboard");
    assert.equal(claude.cwd, "/Users/kevinliu/demo-app");
    assert.equal(claude.status, "working", "its registered process is alive and its last tool_result line is 30 s old");
    assert.equal(claude.detail, "claude · 3 msgs · demo-app");
    assert.equal(claude.hint, "running");
    assert.equal(claude.updatedAt, T("2026-09-01T10:01:00.000Z"));
    assert.equal(codex.name, "Hero font swap", "Codex Desktop's thread name from session_index.jsonl");
    assert.equal(codex.status, "idle", "the app-server holds its rollout open: alive, and its last turn closed (task_complete) 56 min ago");
    assert.equal(codex.detail, "codex · 3 msgs · demo-site");
    assert.equal(codex.hint, "quiet");
    assert.equal(archived.name, "Rename package");
    assert.equal(archived.status, "done");
    assert.equal(archived.detail, "codex · 2 msgs · old-thing");
    assert.equal(archived.hint, "archived");

    const health = await c.health();
    assert.equal(health.ok, true);
    // Discovery is pinned to an empty PATH and an empty Applications folder (see connector()), so the
    // binaries are reported missing and the line still names every place that was searched.
    const [codexLine, claudeLine, alsoFound] = health.detail.split(" | ");
    assert.equal(codexLine, "codex not found: looked in JARHEAD_CODEX_BIN (unset), PATH, ChatGPT.app, Codex.app, ~/.codex/bin, ~/.bun/bin, ~/.local/bin · desktop app running · 2 threads");
    assert.equal(claudeLine, "claude not found: looked in JARHEAD_CLAUDE_BIN (unset), PATH, ~/.local/bin, ~/.claude/local, ~/.bun/bin · 2 sessions · 1 running");
    assert.equal(alsoFound, "also found: gemini");

    const noHolder = connector(h, { procs: [desktop], now: () => T("2026-09-01T10:01:30.000Z") });
    const alone = (await noHolder.list()).find((a) => a.id === `sessions:codex:${C1}`);
    assert.equal(alone?.status, "ended", "with no process holding the rollout the thread is over");
    assert.equal(alone?.detail, "codex · 3 msgs · demo-site");
    assert.equal(alone?.hint, "ended");
    assert.deepEqual(await detectOthers(h.home), ["gemini"]);

    const empty = new SessionsConnector({ home: join(h.home, "nothing-here"), ...pinned(h.home), processes: async () => [] });
    assert.deepEqual(await empty.list(), []);
    const bad = await empty.health();
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /^no Claude Code or Codex session store under .* \| codex not found: looked in .* · no threads yet \| claude not found: .* · no sessions yet$/);
  } finally {
    h.cleanup();
  }
});

test("read(): one line of context, then the last assistant text", async () => {
  const h = makeHome();
  try {
    const c = connector(h);
    await c.list();
    const text = await c.read(`sessions:claude:${S1}`);
    assert.equal(text, "Fix login redirect to dashboard — /Users/kevinliu/demo-app — 26h ago\nThe redirect now points at /dashboard after login.");
    const fresh = connector(h);
    assert.match(await fresh.read(`sessions:codex:${C2}`), /^Rename package — \/Users\/kevinliu\/old-thing — 3d ago\nRenamed it to old-thing-core\.$/, "unlisted ids resolve straight from disk");
    assert.match(await fresh.read(`sessions:codex:${C3}`), /^Find every hero font declaration/, "a sub-agent rollout is readable by its own id even though it is never listed");
    await assert.rejects(fresh.read("sessions:claude:ffffffff-ffff-4fff-8fff-ffffffffffff"), /no claude session/);
    await assert.rejects(fresh.read("herdr:w1:p1"), TypeError);
  } finally {
    h.cleanup();
  }
});

test("send(): codex refused, open-in-terminal refused, otherwise resumed headlessly and reused", async () => {
  const h = makeHome();
  try {
    const sdk = fakeSdk("Logout now clears the cookie too.", 300);
    const cwd = h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    h.touch(h.paths.s1, T("2026-09-01T10:01:00.000Z"));

    let procs: AgentProcess[] = [proc({ cwd, interactive: true, startedAt: T("2026-09-01T09:00:00.000Z") })];
    const c = new SessionsConnector({ home: h.home, ...pinned(h.home), now: () => NOW, processes: async () => procs, sdk, processCacheMs: 0, pollMs: 30 });
    const id = `sessions:claude:${S1}`;

    const codex = await c.send(`sessions:codex:${C1}`, "hi");
    assert.equal(codex.accepted, false);
    assert.match(codex.detail ?? "", /^codex not found: looked in JARHEAD_CODEX_BIN \(unset\), PATH, ChatGPT\.app/, "no Codex on this (pinned) machine: the refusal says where it looked, not 'no driver'");

    const busy = await c.send(id, "also fix logout");
    assert.equal(busy.accepted, false);
    assert.match(busy.detail ?? "", /open in a terminal; ask Kevin to type it there/);
    assert.equal(sdk.options.length, 0, "nothing was spawned");

    procs = [proc({ cwd, interactive: false, startedAt: NOW })]; // a newer headless claude elsewhere in time does not own this file
    const changes: AgentInfo[] = [];
    const unsubscribe = c.subscribe((a) => changes.push(a));
    const sent = await c.send(id, "also fix logout");
    assert.equal(sent.accepted, true);
    assert.equal(sent.detail, "resumed headlessly");
    assert.equal(sdk.options.length, 1);
    assert.equal(sdk.options[0]?.["resume"], S1);
    assert.equal(sdk.options[0]?.["cwd"], cwd);
    assert.equal(sdk.options[0]?.["permissionMode"], "acceptEdits");
    assert.equal((sdk.options[0]?.["env"] as Record<string, unknown>)["ANTHROPIC_API_KEY"], undefined);
    assert.equal(typeof sdk.options[0]?.["canUseTool"], "function");

    const live = (await c.list()).find((a) => a.id === id);
    assert.equal(live?.status, "working");
    assert.match(live?.detail ?? "", /^claude · 3 msgs · demo-app · resumed: thinking$/);

    const settled = await c.waitSettled(id, 2_000);
    assert.equal(settled.status, "idle");
    assert.deepEqual(sdk.received, ["also fix logout"]);
    assert.match(await c.read(id), /\nLogout now clears the cookie too\.$/);

    const again = await c.send(id, "and the signup path");
    assert.equal(again.accepted, true);
    assert.equal(sdk.options.length, 1, "second send continues the same resumed session");
    await c.waitSettled(id, 2_000);
    assert.deepEqual(sdk.received, ["also fix logout", "and the signup path"]);
    assert.ok(changes.some((a) => a.id === id && a.status === "working"), "status changes reach subscribers");
    assert.ok(changes.some((a) => a.id === id && a.status === "idle"));
    unsubscribe();
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

test("send(): the registry decides ownership — a Desktop pane on the session refuses; a neighbour on another session does not", async () => {
  const h = makeHome();
  try {
    const sdk = fakeSdk("ok", 10);
    const cwd = h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    h.touch(h.paths.s1, T("2026-09-01T10:01:00.000Z"));
    const id = `sessions:claude:${S1}`;

    // pid 4242 is registered to S1: it owns the session even from another folder, started after the last write.
    let procs: AgentProcess[] = [proc({ pid: 4242, cwd: "/elsewhere", startedAt: NOW, interactive: false })];
    const c = new SessionsConnector({ home: h.home, ...pinned(h.home), now: () => NOW, processes: async () => procs, sdk, processCacheMs: 0 });
    const owned = await c.send(id, "hello");
    assert.equal(owned.accepted, false);
    assert.match(owned.detail ?? "", /open in Claude Desktop/);
    assert.equal((await c.list()).find((a) => a.id === id)?.status, "idle", "alive, quiet");

    // pid 9999 is registered to S2; same folder, started in time, but the registry says it is not on S1.
    procs = [proc({ pid: 9999, cwd, startedAt: T("2026-09-01T09:00:00.000Z"), interactive: true })];
    const free = await c.send(id, "hello");
    assert.equal(free.accepted, true);
    assert.equal(free.detail, "resumed headlessly");
    assert.equal(sdk.options.length, 1);
    await c.waitSettled(id, 2_000);
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

test("send(): refuses to resume while process detection is degraded (lsof or ps failed)", async () => {
  const h = makeHome();
  try {
    const cwd = h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    h.touch(h.paths.s1, T("2026-09-01T10:01:00.000Z"));
    const id = `sessions:claude:${S1}`;
    let lsof: (() => string) | undefined;
    let ps: (() => string) | undefined = () => PS_SAMPLE;
    const sdk = fakeSdk("ok", 10);
    const c = new SessionsConnector({
      home: h.home,
      ...pinned(h.home),
      now: () => NOW,
      sdk,
      processCacheMs: 0,
      exec: async (file) => {
        if (file === "ps" && ps) return ps();
        if (file === "lsof" && lsof) return lsof();
        throw new Error(`${file}: timed out`);
      },
    });

    // The sample's pid 297 carries --resume=<S1>: argv ownership needs no lsof, so the refusal names the owner.
    const argvOwned = await c.send(id, "hello");
    assert.equal(argvOwned.accepted, false);
    assert.match(argvOwned.detail ?? "", /open in Claude Desktop/);

    // Without an owner in sight and lsof down, nobody can say the session is free.
    ps = () => PS_SAMPLE.replaceAll(S1, S4);
    const noLsof = await c.send(id, "hello");
    assert.equal(noLsof.accepted, false);
    assert.match(noLsof.detail ?? "", /^cannot tell whether that session is open \(lsof failed: lsof: timed out\); not resuming it$/);
    assert.equal(sdk.options.length, 0, "no resume spawned on a guess");
    assert.match((await c.health()).detail, /process detection degraded \(lsof failed/);

    ps = undefined;
    const noPs = await c.send(id, "hello");
    assert.equal(noPs.accepted, false);
    assert.match(noPs.detail ?? "", /cannot tell whether that session is open \(ps failed/);
    assert.equal(sdk.options.length, 0);

    // Both tools back: the sample's claude processes are on other sessions or started after the last write, so the resume goes ahead.
    ps = () => PS_SAMPLE.replaceAll(S1, S4);
    lsof = () => `p60001\nfcwd\nn${cwd}\n`;
    const ok = await c.send(id, "hello");
    assert.equal(ok.accepted, true, ok.detail);
    assert.equal(sdk.options.length, 1);
    await c.waitSettled(id, 2_000);
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

test("send(): concurrent sends for one session spawn a single resume and both texts reach it", async () => {
  const h = makeHome();
  try {
    const sdk = fakeSdk("done", 20);
    h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    h.touch(h.paths.s1, T("2026-09-01T10:01:00.000Z"));
    const c = connector(h, { sdk });
    const id = `sessions:claude:${S1}`;
    const [a, b, d] = await Promise.all([c.send(id, "first"), c.send(id, "second"), c.send(id, "third")]);
    assert.equal(a.accepted, true);
    assert.equal(b.accepted, true);
    assert.equal(d.accepted, true);
    assert.equal(sdk.options.length, 1, "one ClaudeSession, one CLI child");
    assert.deepEqual([a.detail, b.detail, d.detail].sort(), ["resumed headlessly", "sent to the resumed session", "sent to the resumed session"]);
    await until(() => sdk.received.length === 3, 2_000, "all three turns");
    assert.deepEqual([...sdk.received].sort(), ["first", "second", "third"]);
    await c.closeAll();
  } finally {
    h.cleanup();
  }
});

test("permissions: a resumed session's question stays open until Kevin answers; read-only tools pass; no answer denies", async () => {
  const h = makeHome();
  try {
    h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    h.touch(h.paths.s1, T("2026-09-01T10:01:00.000Z"));
    const id = `sessions:claude:${S1}`;

    const sdk = fakeSdk("Build directory removed.", 10, { tool: "Bash", input: { command: "rm -rf build", description: "clean" } });
    const c = connector(h, { sdk, now: Date.now });
    const seen: AgentInfo[] = [];
    const stop = c.subscribe((a) => seen.push(a));
    assert.equal((await c.send(id, "clean the build dir")).accepted, true);
    await until(() => c.pendingPermission(id) !== undefined, 2_000, "the question");
    assert.deepEqual({ ...c.pendingPermission(id), askedAt: 0 }, { toolName: "Bash", summary: "rm -rf build", askedAt: 0 });
    const blocked = (await c.list()).find((a) => a.id === id);
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.detail, "claude · 3 msgs · demo-app · needs Kevin's yes or no: Bash — rm -rf build");
    assert.match(await c.read(id), /\nwaiting for Kevin's yes or no before Bash: rm -rf build$/);
    assert.equal(c.resolvePermission(`sessions:codex:${C1}`, true), false);

    const yes = await c.send(id, "yes, go ahead");
    assert.deepEqual(yes, { accepted: true, detail: "allowed Bash", mode: "answer" });
    assert.equal(c.pendingPermission(id), undefined);
    assert.equal((await c.waitSettled(id, 2_000)).status, "idle");
    assert.deepEqual(sdk.decisions, [{ behavior: "allow" }]);
    assert.match(await c.read(id), /\nBuild directory removed\.$/);
    assert.deepEqual(sdk.received, ["clean the build dir"], "the yes answered the question; it was not a new turn");

    assert.equal((await c.send(id, "and again")).detail, "sent to the resumed session");
    await until(() => c.pendingPermission(id) !== undefined, 2_000, "the second question");
    assert.equal(c.resolvePermission(id, false), true);
    assert.equal(c.resolvePermission(id, false), false, "nothing left to answer");
    await c.waitSettled(id, 2_000);
    assert.deepEqual(sdk.decisions[1], { behavior: "deny", message: "denied by Kevin" });
    assert.match(await c.read(id), /\nrefused: denied by Kevin$/);
    assert.ok(seen.some((a) => a.id === id && a.status === "blocked" && /needs Kevin's yes or no: Bash/.test(a.detail ?? "")), "the question reached subscribers");
    stop();
    await c.closeAll();

    // Read-only tools never block.
    const quiet = fakeSdk("read it", 10, { tool: "Read", input: { file_path: "/tmp/x" } });
    const q = connector(h, { sdk: quiet, now: Date.now });
    const statuses: string[] = [];
    const stopQ = q.subscribe((a) => statuses.push(a.status));
    await q.send(id, "read the file");
    assert.equal((await q.waitSettled(id, 2_000)).status, "idle");
    assert.deepEqual(quiet.decisions, [{ behavior: "allow" }]);
    assert.ok(!statuses.includes("blocked"), `never blocked: ${statuses.join(",")}`);
    stopQ();
    await q.closeAll();

    // No answer within the timeout: denied, not allowed.
    const slow = fakeSdk("removed", 10, { tool: "Bash", input: { command: "rm -rf /" } });
    const t = connector(h, { sdk: slow, now: Date.now, permissionTimeoutMs: 60 });
    await t.send(id, "wipe it");
    assert.equal((await t.waitSettled(id, 2_000)).status, "blocked", "waitSettled treats an open question as settled; the timeout has not run yet");
    await until(() => slow.decisions.length === 1, 2_000, "the timeout's decision");
    assert.equal((await t.waitSettled(id, 2_000)).status, "idle");
    assert.equal(slow.decisions[0]?.behavior, "deny");
    assert.match((slow.decisions[0] as { message: string }).message, /did not answer within 0 s; Bash was not run/);
    assert.equal(t.pendingPermission(id), undefined);
    await t.closeAll();
  } finally {
    h.cleanup();
  }
});

test("permissions: parallel tool calls each reach Kevin in turn, and the session reads blocked until the last is answered", async () => {
  const h = makeHome();
  try {
    h.realCwd(h.paths.s1, "/Users/kevinliu/demo-app");
    h.touch(h.paths.s1, T("2026-09-01T10:01:00.000Z"));
    const id = `sessions:claude:${S1}`;

    // Claude issues two non-allowlisted Bash calls in one message; the CLI asks for both at once.
    const sdk = fakeSdk("Cleaned and posted.", 10, [
      { tool: "Bash", input: { command: "rm -rf build" } },
      { tool: "Bash", input: { command: "curl -X POST https://example.com/hook" } },
    ]);
    const c = connector(h, { sdk, now: Date.now });
    const seen: AgentInfo[] = [];
    const stop = c.subscribe((a) => seen.push(a));
    assert.equal((await c.send(id, "clean and post")).accepted, true);
    await until(() => sdk.asked === 2 && c.pendingPermission(id) !== undefined, 2_000, "both questions");
    await new Promise((r) => setTimeout(r, 30)); // room for a wrongly auto-denied second ask to come back
    assert.deepEqual(sdk.decisions, [], "neither tool was decided without Kevin");
    assert.equal(c.pendingPermission(id)?.summary, "rm -rf build", "the first question is shown first");
    const first = (await c.list()).find((a) => a.id === id);
    assert.equal(first?.status, "blocked");
    assert.equal(first?.detail, "claude · 3 msgs · demo-app · needs Kevin's yes or no: Bash — rm -rf build");
    const t0 = Date.now();
    assert.equal((await c.waitSettled(id, 2_000)).status, "blocked", "an open question is settled");
    assert.ok(Date.now() - t0 < 500, `and settled at once, not at the timeout (${Date.now() - t0} ms)`);

    assert.deepEqual(await c.send(id, "yes"), { accepted: true, detail: "allowed Bash", mode: "answer" });
    await until(() => sdk.decisions.length === 1, 2_000, "the first decision");
    assert.deepEqual(sdk.decisions, [{ behavior: "allow" }]);
    assert.equal(c.pendingPermission(id)?.summary, "curl -X POST https://example.com/hook", "the second question follows");
    const second = (await c.list()).find((a) => a.id === id);
    assert.equal(second?.status, "blocked", "still blocked, although the ClaudeSession's own flag cleared with the first answer");
    assert.match(second?.detail ?? "", /needs Kevin's yes or no: Bash — curl -X POST/);
    assert.match(await c.read(id), /waiting for Kevin's yes or no before Bash: curl -X POST/);
    assert.equal((await c.waitSettled(id, 2_000)).status, "blocked");

    assert.equal(c.resolvePermission(id, false), true);
    assert.equal(c.pendingPermission(id), undefined, "nothing left to ask");
    assert.equal((await c.waitSettled(id, 2_000)).status, "idle");
    assert.deepEqual(sdk.decisions, [{ behavior: "allow" }, { behavior: "deny", message: "denied by Kevin" }], "both answered by Kevin, in order");
    assert.deepEqual(sdk.received, ["clean and post"], "yes/no answered questions; neither was a new turn");
    assert.match(await c.read(id), /\nrefused: denied by Kevin$/);
    const asking = seen.filter((a) => a.id === id && /needs Kevin's yes or no/.test(a.detail ?? ""));
    assert.ok(asking.some((a) => /rm -rf build/.test(a.detail ?? "")) && asking.some((a) => /curl -X POST/.test(a.detail ?? "")), "both questions reached subscribers");
    assert.ok(asking.every((a) => a.status === "blocked"), `a question is never reported as working: ${asking.map((a) => a.status).join(",")}`);
    stop();
    await c.closeAll();

    // Unanswered, each question gets its own clock once shown; both end denied, neither allowed.
    const slow = fakeSdk("wiped", 10, [{ tool: "Bash", input: { command: "rm -rf a" } }, { tool: "Bash", input: { command: "rm -rf b" } }]);
    const t = connector(h, { sdk: slow, now: Date.now, permissionTimeoutMs: 60 });
    await t.send(id, "wipe both");
    await until(() => slow.asked === 2 && t.pendingPermission(id) !== undefined, 2_000, "both questions");
    assert.equal(t.pendingPermission(id)?.summary, "rm -rf a");
    await until(() => slow.decisions.length === 1, 2_000, "the first timeout");
    assert.equal(t.pendingPermission(id)?.summary, "rm -rf b", "the second is shown once the first times out");
    await until(() => slow.decisions.length === 2, 2_000, "the second timeout");
    assert.ok(slow.decisions.every((d) => d.behavior === "deny"), JSON.stringify(slow.decisions));
    assert.equal((await t.waitSettled(id, 2_000)).status, "idle");
    assert.equal(t.pendingPermission(id), undefined);

    // Shutdown with questions open denies them all.
    const open = fakeSdk("x", 10, [{ tool: "Bash", input: { command: "rm -rf a" } }, { tool: "Bash", input: { command: "rm -rf b" } }]);
    const o = connector(h, { sdk: open, now: Date.now });
    await o.send(id, "wipe both");
    await until(() => open.asked === 2 && o.pendingPermission(id) !== undefined, 2_000, "both questions");
    await o.closeAll();
    assert.equal(open.decisions.length, 2);
    assert.ok(open.decisions.every((d) => d.behavior === "deny" && /shutting down/.test(d.message)));
    assert.equal(o.pendingPermission(id), undefined);
    await t.closeAll();
  } finally {
    h.cleanup();
  }
});

test("waitSettled(): without a driver, an owned session waits for its file to go quiet; a session nobody owns is settled at once, as ended", async () => {
  const h = makeHome();
  try {
    const id = `sessions:claude:${S1}`;
    // pid 4242 is registered to S1 and alive: the file is the only signal, and quiet means settled.
    const owned = connector(h, { now: Date.now, procs: [proc({ pid: 4242, cwd: "/Users/kevinliu/demo-app", startedAt: T("2026-09-01T09:00:00.000Z"), interactive: false })] });
    const t0 = Date.now();
    const info = await owned.waitSettled(id, 5_000);
    const took = Date.now() - t0;
    assert.ok(took >= 35 && took < 1_500, `quiet window ~40 ms, took ${took}`);
    assert.equal(info.id, id);
    assert.equal(info.status, "idle", "alive; its last turn was written in 2026, long before the real now");

    const c = connector(h, { now: Date.now });
    const t1 = Date.now();
    const ended = await c.waitSettled(id, 5_000);
    assert.ok(Date.now() - t1 < 30, `nothing can write a file nobody owns: settled without the quiet wait (${Date.now() - t1} ms)`);
    assert.equal(ended.status, "ended");
  } finally {
    h.cleanup();
  }
});

test("subscribe(): polling emits changed sessions only", async () => {
  const h = makeHome();
  try {
    let now = T("2026-09-01T10:02:00.000Z");
    const c = connector(h, { now: () => now });
    await c.list();
    const seen: AgentInfo[] = [];
    const stop = c.subscribe((a) => seen.push(a));
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(seen.length, 0, "nothing changed, nothing emitted");
    appendFileSync(h.paths.s1, JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "Done." }] }, timestamp: "2026-09-01T10:03:00.000Z", sessionId: S1 }) + "\n");
    h.touch(h.paths.s1, T("2026-09-01T10:03:00.000Z"));
    now = T("2026-09-01T10:03:10.000Z");
    await new Promise((r) => setTimeout(r, 120));
    stop();
    const ids = new Set(seen.map((a) => a.id));
    assert.ok(ids.has(`sessions:claude:${S1}`), "the appended session was emitted");
    assert.equal(seen.find((a) => a.id === `sessions:claude:${S1}`)?.updatedAt, T("2026-09-01T10:03:00.000Z"));
    // Nothing else changed, so nothing else was emitted: no relative-time churn in `detail` any more.
    assert.deepEqual([...ids], [`sessions:claude:${S1}`], "only the appended session");
    assert.ok(seen.every((a) => a.status !== "offline"));
  } finally {
    h.cleanup();
  }
});
