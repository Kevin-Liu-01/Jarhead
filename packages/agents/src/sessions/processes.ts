import { execFile } from "node:child_process";

/**
 * Which agent CLIs are running right now, and where.
 *
 * `ps -axo pid,ppid,lstart,command` is one cheap call (~50 ms). The cwd of each
 * matched pid comes from a single batched `lsof -a -p a,b,c -d cwd -Fn`, which
 * macOS may deny for some processes; that is a missing cwd, not an error. Codex pids
 * get a second lsof over every open file (~100 ms): Codex Desktop's app-server runs
 * with cwd `/` and drives many threads at once, and the rollout .jsonl plus
 * `~/.codex/thread-writer-locks/<id>.lock` it keeps open are the only thing that says
 * which threads those are. When ps or either lsof fails outright (timeout, not
 * installed, denied for everything) the snapshot is `degraded`: callers that would
 * act on "nobody owns this session" must not.
 */

export type AgentTool = "claude" | "codex" | "cursor-agent" | "gemini" | "opencode" | "amp" | "droid" | "hermes" | "pi";

export interface AgentProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly startedAt: number | undefined;
  readonly tool: AgentTool;
  readonly command: string;
  readonly cwd: string | undefined;
  /**
   * A human is typing into this one (a TUI in a terminal). Headless children —
   * Claude Desktop's `--output-format stream-json`, Codex's `app-server`, `-p`
   * one-shots — are not interactive.
   */
  readonly interactive: boolean;
  /**
   * The session argv names: `claude --resume=<id>` / `--resume <id>` / `-r <id>` /
   * `--session-id <id>` (Claude Desktop's children carry `--resume=`), `codex resume <id>`,
   * `codex exec resume [flags…] [--] <id> [prompt]` (the sessions connector's own children).
   */
  readonly sessionId: string | undefined;
  /**
   * Codex thread ids whose rollout file or writer lock this process holds open — an
   * exact owner signal for app-servers whose cwd says nothing. Empty for other tools
   * and for processes that hold no rollout.
   */
  readonly heldSessionIds: readonly string[];
}

export interface ProcessSnapshot {
  readonly processes: AgentProcess[];
  /** Every pid ps listed, agent or not; how registry entries are checked for life. */
  readonly pids: ReadonlySet<number>;
  /** Why the snapshot cannot be trusted (ps or lsof failed or timed out); undefined when both ran. */
  readonly degraded: string | undefined;
}

export type ExecFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

export const defaultExec: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      // lsof exits 1 when any pid yields nothing; its stdout is still good. A process the
      // timeout killed, or one that overran maxBuffer, left stdout cut short: whatever
      // arrived is a partial listing, not a snapshot, so it fails like an empty one.
      if (err && (err.killed || err.signal || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || !stdout)) reject(err);
      else resolve(stdout);
    });
  });

const TOOLS: ReadonlySet<string> = new Set<AgentTool>(["claude", "codex", "cursor-agent", "gemini", "opencode", "amp", "droid", "hermes", "pi"]);
const MONTHS: Readonly<Record<string, number>> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startedAt: number | undefined;
  readonly command: string;
}

/** Parse `ps -axo pid,ppid,lstart,command` output (header included). */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, , mon, day, hh, mm, ss, year, command] = m;
    const month = MONTHS[mon ?? ""];
    const startedAt = month === undefined ? undefined : new Date(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)).getTime();
    rows.push({ pid: Number(pid), ppid: Number(ppid), startedAt, command: (command ?? "").trim() });
  }
  return rows;
}

const TOOL_TOKEN = new RegExp(`(?:^|\\s)(?:\\S*/)?(${[...TOOLS].join("|")})(?=\\s|$)`);

/**
 * Which agent CLI a command line is, if any.
 *
 * The executable is the whitespace-delimited token whose basename is a tool name,
 * looked for before the first flag so paths inside arguments do not count.
 * `.app` bundle paths contain spaces ("Application Support/Claude/.../claude");
 * matching on the tail token still finds them. Case matters: "Codex (Renderer)"
 * and "Claude Helper" are Electron helpers, not agents.
 */
export function classifyCommand(command: string): { tool: AgentTool; interactive: boolean; sessionId: string | undefined } | undefined {
  // Claude Desktop wraps its CLI child: ".../Helpers/disclaimer -- /path/to/claude ...". Skip the wrapper; the child is listed too.
  if (/\/disclaimer\s+--\s/.test(command)) return undefined;
  if (/Codex Desktop/.test(command)) return { tool: "codex", interactive: false, sessionId: undefined };
  const flagIdx = command.search(/\s-/);
  const headPart = flagIdx === -1 ? command : command.slice(0, flagIdx);
  const m = TOOL_TOKEN.exec(headPart);
  if (!m || !TOOLS.has(m[1] ?? "")) return undefined;
  // The token must be the executable itself: at the start, after an interpreter
  // ("node /usr/local/bin/claude"), or the tail of one bundle path with spaces.
  // "vim /tmp/claude notes" is an editor, not an agent.
  const prefix = headPart.slice(0, m.index).trim();
  const pathPart = m[0].trimStart();
  const joined = `${prefix} ${pathPart}`;
  const isExecutable =
    prefix === "" ||
    /^(\S*\/)?(node|bun|deno)\d*$/.test(prefix) ||
    (prefix.startsWith("/") && !pathPart.startsWith("/") && /\.app\/|Application Support\//.test(joined));
  if (!isExecutable) return undefined;
  const tool = m[1] as AgentTool;
  const args = command.slice(m.index + m[0].length);
  let interactive = true;
  if (/(^|\s)(-p|--print)(\s|$)/.test(args) || /--(output|input)-format\s+stream-json/.test(args)) interactive = false;
  // Codex Desktop runs `codex [-c key=value ...] app-server`; `exec`/`mcp-server` are non-interactive too.
  if (tool === "codex" && /(^|\s)(app-server|exec|mcp-server|mcp|login|logout)(\s|$)/.test(args)) interactive = false;
  return { tool, interactive, sessionId: sessionIdFromArgs(tool, args) };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLAUDE_SESSION_ARG = new RegExp(`(?:^|\\s)(?:--resume|-r|--session-id)(?:=|\\s+)(${UUID})(?=\\s|$)`, "i");
/**
 * `resume <id>`, or `resume` with flags and their values (`--json`, `-c key=value`) and an
 * optional `--` before the id: the first UUID after `resume` is the thread. A UUID inside a
 * prompt that follows `--last` would be taken for it; nobody writes that on argv.
 */
const CODEX_SESSION_ARG = new RegExp(`(?:^|\\s)resume\\b(?:\\s+\\S+)*?\\s+(?:--\\s+)?(${UUID})(?=\\s|$)`, "i");

/** The session id on an agent CLI's argv, if it names one. */
export function sessionIdFromArgs(tool: AgentTool, args: string): string | undefined {
  if (tool === "claude") return CLAUDE_SESSION_ARG.exec(args)?.[1]?.toLowerCase();
  if (tool === "codex") return CODEX_SESSION_ARG.exec(args)?.[1]?.toLowerCase();
  return undefined;
}

/** Parse `lsof -a -p ... -d cwd -Fn` into pid → cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) out.set(pid, line.slice(1));
  }
  return out;
}

const CODEX_ROLLOUT_PATH = /\/\.codex\/(?:sessions\/.*\/|archived_sessions\/)rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([^/]+)\.jsonl$/;
const CODEX_LOCK_PATH = /\/\.codex\/thread-writer-locks\/([^/]+)\.lock$/;

/** Parse `lsof -a -p ... -Fn` (every open file) into pid → Codex thread ids held open, in first-seen order. */
export function parseLsofSessionFiles(output: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith("n") || pid === undefined) continue;
    const id = CODEX_ROLLOUT_PATH.exec(line)?.[1] ?? CODEX_LOCK_PATH.exec(line)?.[1];
    if (!id) continue;
    const held = out.get(pid) ?? [];
    if (!held.includes(id)) held.push(id);
    out.set(pid, held);
  }
  return out;
}

export interface ListProcessesOptions {
  readonly exec?: ExecFn;
  readonly timeoutMs?: number;
}

/** Running agent CLIs with their cwd where lsof allows it. Never throws; failures make the snapshot `degraded`. */
export async function listAgentProcesses(opts: ListProcessesOptions = {}): Promise<ProcessSnapshot> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  let rows: PsRow[];
  try {
    rows = parsePs(await exec("ps", ["-axo", "pid,ppid,lstart,command"], timeoutMs));
  } catch (e) {
    return { processes: [], pids: new Set(), degraded: `ps failed: ${errorText(e)}` };
  }
  const pids = new Set(rows.map((r) => r.pid));
  const matched: { row: PsRow; tool: AgentTool; interactive: boolean; sessionId: string | undefined }[] = [];
  for (const row of rows) {
    const c = classifyCommand(row.command);
    if (c) matched.push({ row, ...c });
  }
  if (matched.length === 0) return { processes: [], pids, degraded: undefined };
  const codexPids = matched.filter((m) => m.tool === "codex").map((m) => m.row.pid);
  // Both lsof calls at once; each failure is recorded, and processes are still reported
  // without the missing facts. `-n -P` keep the open-files pass from resolving hosts and ports.
  const [cwds, held] = await Promise.all([
    attempt(exec("lsof", ["-a", "-p", matched.map((m) => m.row.pid).join(","), "-d", "cwd", "-Fn"], timeoutMs).then(parseLsofCwd)),
    codexPids.length > 0
      ? attempt(exec("lsof", ["-n", "-P", "-a", "-p", codexPids.join(","), "-Fn"], timeoutMs).then(parseLsofSessionFiles))
      : Promise.resolve<Attempt<Map<number, string[]>>>({ value: new Map() }),
  ]);
  // lsof missing, timed out, or denied for every pid: the caller is told not to trust an
  // empty owner list. The cwd pass names the snapshot's failure when both fail.
  let degraded: string | undefined;
  if ("error" in held) degraded = `lsof (open files) failed: ${errorText(held.error)}`;
  if ("error" in cwds) degraded = `lsof failed: ${errorText(cwds.error)}`;
  const processes = matched.map(({ row, tool, interactive, sessionId }) => ({
    pid: row.pid,
    ppid: row.ppid,
    startedAt: row.startedAt,
    tool,
    command: row.command,
    cwd: "value" in cwds ? cwds.value.get(row.pid) : undefined,
    interactive,
    sessionId,
    heldSessionIds: "value" in held ? (held.value.get(row.pid) ?? []) : [],
  }));
  return { processes, pids, degraded };
}

type Attempt<T> = { readonly value: T } | { readonly error: unknown };

function attempt<T>(p: Promise<T>): Promise<Attempt<T>> {
  return p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
