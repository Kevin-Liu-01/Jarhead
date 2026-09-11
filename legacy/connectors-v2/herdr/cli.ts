import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin wrapper over the herdr CLI (v0.7.4).
 *
 * Every control command prints one JSON envelope on stdout:
 *   {"id":"cli:agent:list","result":{"type":"agent_list","agents":[...]}}
 *   {"id":"cli:agent:get","error":{"code":"agent_not_found","message":"..."}}   (exit 1)
 * `pane read` is the exception: it prints the raw text. When the server is down
 * herdr prints a Rust io error on stderr and exits 1:
 *   Error: Os { code: 61, kind: ConnectionRefused, message: "Connection refused" }  (stale socket)
 *   Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }     (no socket file)
 * Those are the "offline" cases; they are results here, never exceptions.
 */

export interface HerdrExecResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn-level failure (ENOENT, EACCES). Absent for ordinary non-zero exits. */
  readonly spawnError?: NodeJS.ErrnoException;
}

export type HerdrExec = (
  bin: string,
  args: readonly string[],
  opts: { readonly timeoutMs: number },
) => Promise<HerdrExecResult>;

export type HerdrOfflineReason = "not-running" | "no-socket" | "no-binary" | "timeout";

export interface HerdrOffline {
  readonly reason: HerdrOfflineReason;
  readonly message: string;
}

export interface HerdrApiError {
  readonly code: string;
  readonly message: string;
}

export interface HerdrRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed stdout when herdr printed JSON. */
  readonly json?: unknown;
  /** The `result` member of the envelope, when present. */
  readonly result?: unknown;
  /** The `error` member of the envelope, when herdr answered with one. */
  readonly error?: HerdrApiError;
  /** Set when the failure means "herdr is not available", not "herdr said no". */
  readonly offline?: HerdrOffline;
}

export interface HerdrCliOptions {
  readonly bin?: string;
  /** Named persistent session (`herdr --session <name>`); undefined = the default session. */
  readonly session?: string;
  /** Only used to make offline messages point at the right socket. */
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly exec?: HerdrExec;
}

export const DEFAULT_HERDR_TIMEOUT_MS = 8_000;

export function defaultHerdrBin(): string {
  return join(homedir(), ".local", "bin", "herdr");
}

/** Observed via `herdr status`: the default session and named sessions live in different dirs. */
export function defaultHerdrSocketPath(session?: string): string {
  const root = join(homedir(), ".config", "herdr");
  return session ? join(root, "sessions", session, "herdr.sock") : join(root, "herdr.sock");
}

export const defaultHerdrExec: HerdrExec = (bin, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      // SIGKILL: herdr blocks inside the socket call when the server hangs; a
      // polite signal would leave a zombie CLI behind the voice loop.
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ code: 0, signal: null, stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null };
        // execFile reuses `code` for both the exit status (number) and spawn errno (string).
        const exitCode = typeof e.code === "number" ? e.code : null;
        const base = { code: exitCode, signal: e.signal ?? null, stdout: stdout ?? "", stderr: stderr ?? "" };
        resolve(typeof e.code === "string" ? { ...base, spawnError: e } : base);
      },
    );
  });

export async function runHerdr(args: readonly string[], opts: HerdrCliOptions = {}): Promise<HerdrRun> {
  const bin = opts.bin ?? defaultHerdrBin();
  const exec = opts.exec ?? defaultHerdrExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HERDR_TIMEOUT_MS;
  const full = opts.session ? ["--session", opts.session, ...args] : [...args];
  const res = await exec(bin, full, { timeoutMs });
  return interpret(res, { bin, timeoutMs, socketPath: opts.socketPath ?? defaultHerdrSocketPath(opts.session) });
}

function interpret(
  res: HerdrExecResult,
  ctx: { readonly bin: string; readonly timeoutMs: number; readonly socketPath: string },
): HerdrRun {
  const base: HerdrRun = { code: res.code, stdout: res.stdout, stderr: res.stderr };
  const json = parseJson(res.stdout);
  if (json !== undefined) {
    const envelope = json as { result?: unknown; error?: unknown };
    const error = toApiError(envelope.error);
    if (error) return { ...base, json, error };
    if ("result" in envelope) return { ...base, json, result: envelope.result };
    return { ...base, json };
  }
  const offline = classifyOffline(res, ctx);
  return offline ? { ...base, offline } : base;
}

function classifyOffline(
  res: HerdrExecResult,
  ctx: { readonly bin: string; readonly timeoutMs: number; readonly socketPath: string },
): HerdrOffline | undefined {
  if (res.spawnError?.code === "ENOENT") {
    return { reason: "no-binary", message: `herdr binary not found at ${ctx.bin}` };
  }
  if (res.code === null && res.signal === "SIGKILL") {
    return { reason: "timeout", message: `herdr did not answer within ${ctx.timeoutMs} ms` };
  }
  if (res.code === 0) return undefined;
  const err = res.stderr;
  if (/ConnectionRefused|Connection refused|ECONNREFUSED/.test(err)) {
    return { reason: "not-running", message: `herdr server not running (stale socket ${ctx.socketPath})` };
  }
  if (/NotFound|No such file or directory|ENOENT/.test(err)) {
    return { reason: "no-socket", message: `herdr server not running (no socket at ${ctx.socketPath})` };
  }
  return undefined;
}

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toApiError(value: unknown): HerdrApiError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : "unknown",
    message: typeof e.message === "string" ? e.message : JSON.stringify(value),
  };
}
