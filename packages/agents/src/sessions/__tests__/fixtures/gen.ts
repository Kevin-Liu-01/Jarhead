import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generators for the durability tests: session files the shape of Kevin's, at the
 * sizes that broke things — a 50 MB session, a rollout with a single 48 MB line, a
 * thread whose process died mid-tool, a rollout that Codex moved. Deterministic
 * (seeded), written in 4 MB batches so generating 50 MB costs one second, not a
 * 50 MB string.
 *
 * Shapes follow the fixtures in this folder: Claude Code 2.1.260 lines (one content
 * block per line, `stop_reason` on the last line of a message: `tool_use` when a
 * call follows, `end_turn` when the turn is over, null before), codex 0.153 rollouts
 * (session_meta, event_msg task_started / token_count / item_completed /
 * task_complete, response_item message / reasoning / function_call / _output).
 */

/** A small LCG: the same seed writes the same bytes. */
export function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

class Writer {
  private readonly fd: number;
  private parts: string[] = [];
  private pending = 0;
  bytes = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w");
  }

  /** Where the next line starts. */
  get offset(): number {
    return this.bytes;
  }

  line(text: string): number {
    const at = this.bytes;
    this.parts.push(text, "\n");
    const n = Buffer.byteLength(text) + 1;
    this.pending += n;
    this.bytes += n;
    if (this.pending >= 4 * 1024 * 1024) this.flush();
    return at;
  }

  /** One line whose body is `fill` repeated to `fillBytes`, written in pieces (never a giant JS string). */
  hugeLine(prefix: string, fillBytes: number, suffix: string, fill = "x"): number {
    this.flush();
    const at = this.bytes;
    writeSync(this.fd, prefix);
    const chunk = Buffer.alloc(Math.min(fillBytes, 8 * 1024 * 1024), fill);
    let left = fillBytes;
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      writeSync(this.fd, chunk, 0, n);
      left -= n;
    }
    writeSync(this.fd, `${suffix}\n`);
    this.bytes += Buffer.byteLength(prefix) + fillBytes + Buffer.byteLength(suffix) + 1;
    return at;
  }

  private flush(): void {
    if (this.parts.length) writeSync(this.fd, this.parts.join(""));
    this.parts = [];
    this.pending = 0;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

const BASE = Date.parse("2026-09-01T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** A tool result body: 1–2 KB usually, 200 KB one time in fifty. */
function resultBody(r: () => number, i: number): string {
  const big = r() < 0.02;
  const n = big ? 200 * 1024 : 1024 + Math.floor(r() * 1024);
  return `${i} `.repeat(Math.ceil(n / (String(i).length + 1)));
}

export interface Generated {
  readonly path: string;
  readonly bytes: number;
  /** Visible message ids in file order, as the transcript parser names them. */
  readonly ids: string[];
  /** Wall clock of the last turn-bearing line. */
  readonly lastAt: number;
}

export interface ClaudeOptions {
  readonly seed?: number;
  /** Every this many rounds the turn closes with an `end_turn` text line. Default 3. */
  readonly endTurnEvery?: number;
  readonly sessionId?: string;
  readonly cwd?: string;
  /**
   * Tool calls per round, issued in parallel the way Claude Code does (N tool_use lines of
   * one message, then N tool_result lines): a page boundary can then fall between a call
   * and its result. Default 1 (the result on the very next line). Ids `toolu_<i>_<j>`.
   */
  readonly toolsPerRound?: number;
}

/**
 * A Claude Code session of about `bytes`: rounds of user / thinking / text / tool_use /
 * tool_result, a closing `end_turn` line every few rounds. Ids per round: `u<i>`,
 * `msg_<i>:thinking`, `msg_<i>`, `toolu_<i>` (+ `msg_<i>f` on closing rounds).
 */
export function bigClaude(path: string, bytes: number, opts: ClaudeOptions = {}): Generated {
  const r = rng(opts.seed ?? 7);
  const every = opts.endTurnEvery ?? 3;
  const perRound = Math.max(1, opts.toolsPerRound ?? 1);
  const sessionId = opts.sessionId ?? "50505050-5050-4505-8505-505050505050";
  const cwd = opts.cwd ?? "/Users/kevinliu/big-app";
  const w = new Writer(path);
  const ids: string[] = [];
  let lastAt = BASE;
  const line = (o: Record<string, unknown>): number => w.line(JSON.stringify(o));
  const user = (uuid: string, content: unknown, ts: number, extra: Record<string, unknown> = {}): number =>
    line({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content }, uuid, timestamp: iso(ts), cwd, sessionId, version: "2.1.260", ...extra });
  const block = (uuid: string, messageId: string, blockBody: Record<string, unknown>, stop: string | null, ts: number): number =>
    line({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", id: messageId, type: "message", role: "assistant", content: [blockBody], stop_reason: stop, stop_sequence: null }, uuid, timestamp: iso(ts), cwd, sessionId });
  line({ type: "queue-operation", operation: "enqueue", timestamp: iso(BASE), sessionId, content: "start" });
  for (let i = 0; w.bytes < bytes; i += 1) {
    const t = BASE + i * 60_000;
    const msg = `msg_${String(i).padStart(5, "0")}`;
    const tool = `toolu_${String(i).padStart(5, "0")}`;
    user(`u${i}`, `round ${i}: do the thing`, t);
    block(`t${i}`, msg, { type: "thinking", thinking: `plan ${i}: read, then edit`, signature: "sig" }, null, t + 1_000);
    block(`a${i}`, msg, { type: "text", text: `Working on ${i}.` }, null, t + 2_000);
    if (perRound === 1) {
      block(`b${i}`, msg, { type: "tool_use", id: tool, name: "Bash", input: { command: `echo ${i}` } }, "tool_use", t + 3_000);
      user(`r${i}`, [{ type: "tool_result", content: resultBody(r, i), is_error: false, tool_use_id: tool }], t + 4_000);
      ids.push(`u${i}`, `${msg}:thinking`, msg, tool);
    } else {
      // Parallel calls: every tool_use line first (stop_reason on the last), then every result.
      const tools = Array.from({ length: perRound }, (_, j) => `${tool}_${j}`);
      tools.forEach((id, j) => block(`b${i}_${j}`, msg, { type: "tool_use", id, name: "Read", input: { file_path: `/src/${i}/${j}.ts` } }, j === perRound - 1 ? "tool_use" : null, t + 3_000 + j));
      tools.forEach((id, j) => user(`r${i}_${j}`, [{ type: "tool_result", content: resultBody(r, i), is_error: false, tool_use_id: id }], t + 4_000 + j));
      ids.push(`u${i}`, `${msg}:thinking`, msg, ...tools);
    }
    lastAt = t + 4_000;
    if (i % every === every - 1) {
      block(`f${i}`, `${msg}f`, { type: "text", text: `Done with ${i}.` }, "end_turn", t + 5_000);
      ids.push(`${msg}f`);
      lastAt = t + 5_000;
    }
    // Housekeeping the CLI writes between turns: never a turn marker.
    if (i % 10 === 9) line({ type: "system", subtype: "stop_hook_summary", timestamp: iso(t + 5_500), sessionId });
  }
  line({ type: "ai-title", aiTitle: "The big one", sessionId });
  w.close();
  return { path, bytes: w.bytes, ids, lastAt };
}

export interface CodexOptions {
  readonly seed?: number;
  readonly id?: string;
  readonly cwd?: string;
  /** One turn's function_call_output is this long (bytes of fill); 0 for none. Default 8 MiB. */
  readonly hugeLineBytes?: number;
  /** Which turn (fraction of the file) carries the huge line. Default 0.5. */
  readonly hugeAt?: number;
  /** Leave the last turn open: task_started, user message, a function_call with no output, no task_complete. */
  readonly openLastTurn?: boolean;
  /** Timestamps start here. Default 2026-09-01T10:00Z. */
  readonly startAt?: number;
}

export interface GeneratedCodex extends Generated {
  readonly id: string;
  /** call_id of the huge output's call, when one was written. */
  readonly hugeCallId: string | undefined;
  /** call_id of the call left running by `openLastTurn`. */
  readonly openCallId: string | undefined;
  /** Byte where the huge line starts, and the byte after its newline. */
  readonly hugeLineOffset: number | undefined;
  readonly hugeLineEnd: number | undefined;
}

/**
 * A Codex rollout of about `bytes`: turns of task_started, user message, reasoning,
 * function_call, token_count (noise), function_call_output, item_completed (noise),
 * assistant message, task_complete. Ids per turn: `m<k>u`, `rs<k>`, `call_<k>`, `m<k>a`.
 */
export function bigCodex(path: string, bytes: number, opts: CodexOptions = {}): GeneratedCodex {
  const r = rng(opts.seed ?? 11);
  const id = opts.id ?? "01a05050-0000-7000-8000-000000005050";
  const cwd = opts.cwd ?? "/Users/kevinliu/big-site";
  const start = opts.startAt ?? BASE;
  const hugeBytes = opts.hugeLineBytes ?? 8 * 1024 * 1024;
  const w = new Writer(path);
  const ids: string[] = [];
  let lastAt = start;
  let hugeCallId: string | undefined;
  let hugeLineOffset: number | undefined;
  let hugeLineEnd: number | undefined;
  let openCallId: string | undefined;
  let ordinal = 0;
  const line = (ts: number, type: string, payload: Record<string, unknown>): number => w.line(JSON.stringify({ timestamp: iso(ts), ordinal: ordinal++, type, payload }));
  line(start, "session_meta", { session_id: id, id, timestamp: iso(start - 1_000), cwd, originator: "Codex Desktop", cli_version: "0.153.4", source: "vscode", thread_source: "user" });
  line(start + 50, "turn_context", { turn_id: "t0", cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-5.5-codex" });
  const hugeTurnBytes = hugeBytes > 0 ? Math.floor(bytes * (opts.hugeAt ?? 0.5)) : Number.POSITIVE_INFINITY;
  let hugeWritten = hugeBytes <= 0;
  for (let k = 0; w.bytes < bytes || (!hugeWritten && hugeBytes > 0); k += 1) {
    const t = start + k * 30_000;
    const call = `call_${k}`;
    line(t, "event_msg", { type: "task_started", turn_id: `t${k}`, started_at: Math.floor(t / 1000), model_context_window: null });
    line(t + 100, "response_item", { type: "message", id: `m${k}u`, role: "user", content: [{ type: "input_text", text: `turn ${k}: change the thing` }] });
    line(t + 150, "event_msg", { type: "item_completed", thread_id: id, turn_id: `t${k}`, item: { type: "UserMessage", id: `item_${k}u` } });
    line(t + 5_000, "response_item", { type: "reasoning", id: `rs${k}`, summary: [{ type: "summary_text", text: `**Looking at ${k}**` }], content: null });
    line(t + 6_000, "response_item", { type: "function_call", id: `fc_${k}`, name: "exec_command", arguments: JSON.stringify({ cmd: `rg thing src/${k}.ts` }), call_id: call });
    line(t + 6_100, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 1000 + k, output_tokens: 20 } }, rate_limits: null });
    ids.push(`m${k}u`, `rs${k}`, call);
    if (opts.openLastTurn && w.bytes >= bytes && hugeWritten) {
      openCallId = call;
      lastAt = t + 6_000;
      break;
    }
    if (!hugeWritten && w.bytes >= hugeTurnBytes) {
      hugeWritten = true;
      hugeCallId = call;
      const prefix = JSON.stringify({ timestamp: iso(t + 7_000), ordinal: ordinal++, type: "response_item", payload: { type: "function_call_output", id: `fco_${k}`, call_id: call, output: "@@" } }).replace('"@@"', '"');
      hugeLineOffset = w.hugeLine(prefix, hugeBytes, '"}}');
      hugeLineEnd = w.offset;
    } else {
      line(t + 7_000, "response_item", { type: "function_call_output", id: `fco_${k}`, call_id: call, output: JSON.stringify({ chunk_id: `c${k}`, exit_code: 0, output: resultBody(r, k) }) });
    }
    line(t + 7_100, "event_msg", { type: "item_completed", thread_id: id, turn_id: `t${k}`, item: { type: "CommandExecution", id: `item_${k}c` } });
    line(t + 8_000, "response_item", { type: "message", id: `m${k}a`, role: "assistant", content: [{ type: "output_text", text: `Changed the thing in ${k}.` }] });
    line(t + 8_050, "event_msg", { type: "item_completed", thread_id: id, turn_id: `t${k}`, item: { type: "AgentMessage", id: `item_${k}a` } });
    line(t + 9_000, "event_msg", { type: "task_complete", turn_id: `t${k}`, last_agent_message: `Changed the thing in ${k}.` });
    line(t + 9_100, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 2000 + k, output_tokens: 40 } }, rate_limits: null });
    ids.push(`m${k}a`);
    lastAt = t + 9_000;
  }
  w.close();
  return { path, bytes: w.bytes, ids, lastAt, id, hugeCallId, openCallId, hugeLineOffset, hugeLineEnd };
}

/** A rollout with one line of `lineBytes` — a tool output (default) or, with `asOutput: false`, a reasoning item — between normal turns. */
export function hugeLine(path: string, lineBytes = 48 * 1024 * 1024, opts: { readonly asOutput?: boolean; readonly id?: string } = {}): GeneratedCodex {
  if (opts.asOutput ?? true) return bigCodex(path, 40 * 1024, { hugeLineBytes: lineBytes, hugeAt: 0.5, ...(opts.id ? { id: opts.id } : {}) });
  // The same file, but the huge line is a reasoning item nobody can attach to a call.
  const id = opts.id ?? "01a05151-0000-7000-8000-000000005151";
  const w = new Writer(path);
  const ids: string[] = [];
  let ordinal = 0;
  const line = (ts: number, type: string, payload: Record<string, unknown>): number => w.line(JSON.stringify({ timestamp: iso(ts), ordinal: ordinal++, type, payload }));
  line(BASE, "session_meta", { session_id: id, id, timestamp: iso(BASE - 1000), cwd: "/x", cli_version: "0.153.4", thread_source: "user" });
  line(BASE + 1_000, "event_msg", { type: "task_started", turn_id: "t0" });
  line(BASE + 1_100, "response_item", { type: "message", id: "m0u", role: "user", content: [{ type: "input_text", text: "think hard" }] });
  ids.push("m0u");
  const prefix = JSON.stringify({ timestamp: iso(BASE + 2_000), ordinal: ordinal++, type: "response_item", payload: { type: "reasoning", id: "rs_huge", summary: [{ type: "summary_text", text: "@@" }], content: null } }).replace('"@@"', '"');
  const hugeLineOffset = w.hugeLine(prefix, lineBytes, '"}],"content":null}}');
  const hugeLineEnd = w.offset;
  line(BASE + 3_000, "response_item", { type: "message", id: "m0a", role: "assistant", content: [{ type: "output_text", text: "Thought about it." }] });
  line(BASE + 4_000, "event_msg", { type: "task_complete", turn_id: "t0" });
  ids.push("m0a");
  w.close();
  return { path, bytes: w.bytes, ids, lastAt: BASE + 4_000, id, hugeCallId: undefined, openCallId: undefined, hugeLineOffset, hugeLineEnd };
}

/** A Codex thread whose process died mid-tool: complete turns, then task_started + user message + a function_call with no output and no task_complete. */
export function midTurn(path: string, opts: { readonly id?: string; readonly cwd?: string; readonly startAt?: number } = {}): GeneratedCodex {
  return bigCodex(path, 8 * 1024, { hugeLineBytes: 0, openLastTurn: true, ...opts });
}

/**
 * The fake Codex CLI (fake-codex.mjs) as a spawnable binary: a shell wrapper around this
 * node, so it runs with an empty PATH. Knobs go in the child's env (FAKE_CODEX_MODE …);
 * it writes rollouts only under CODEX_HOME, which the runner pins to the temp home.
 */
export function fakeCodex(dir: string): string {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "codex");
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(dirname(fileURLToPath(import.meta.url)), "fake-codex.mjs")}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A ChatGPT login in the temp `~/.codex`, the shape 0.153 writes, so the runner will resume threads. */
export function signIn(home: string): void {
  const codexRoot = join(home, ".codex");
  mkdirSync(codexRoot, { recursive: true });
  writeFileSync(join(codexRoot, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id.x", access_token: "at.x", refresh_token: "rt.x", account_id: "acct" }, last_refresh: "2026-09-10T00:00:00Z" }));
}

/** A temp `~/.codex` with one rollout under sessions/YYYY/MM/DD; returns the paths the store expects. */
export function codexHome(home: string, id: string, day = "2026/09/01", ts = "2026-09-01T10-00-00"): { codexRoot: string; sessionsDir: string; archivedDir: string; rolloutPath: string; archivedPath: string } {
  const codexRoot = join(home, ".codex");
  const sessionsDir = join(codexRoot, "sessions", ...day.split("/"));
  const archivedDir = join(codexRoot, "archived_sessions");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(archivedDir, { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const name = `rollout-${ts}-${id}.jsonl`;
  return { codexRoot, sessionsDir, archivedDir, rolloutPath: join(sessionsDir, name), archivedPath: join(archivedDir, name) };
}
