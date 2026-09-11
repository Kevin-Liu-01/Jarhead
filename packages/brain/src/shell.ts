import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger, newId } from "@jarhead/core";
import { SECRET_KEYS } from "@jarhead/protocol";

/**
 * Running commands for the brain: one shell, one AppleScript, one background
 * job. The policy decision is the runner's; this module only executes, with
 * the properties every execution needs — Jarhead's secrets never enter the
 * child's environment (not through the daemon's env, not through the login
 * shell's rc files), secret values are redacted from whatever comes back, and
 * output is bounded (head and tail) so a chatty command cannot flood a model's
 * context.
 */

const log = logger("brain.shell");

/** Results longer than this are cut to head + tail. */
export const OUTPUT_CAP = 12_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const MAX_SHELL_TIMEOUT_MS = 600_000;
/** Bytes kept per stream while a command runs; the rest is dropped from the middle. */
const STREAM_KEEP = 256 * 1024;

/** The daemon's environment minus Jarhead's own keys (the voice's OPENAI_API_KEY and the brain keys). */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SECRET_KEYS) delete env[key];
  return env;
}

/**
 * The command as the login shell runs it. `zsh -l` sources ~/.zprofile, which on
 * Kevin's Mac exports the very key scrubbedEnv removed; so the keys are unset
 * again after the rc files ran and before the command starts.
 */
export function loginShellCommand(command: string): string {
  return `unset ${SECRET_KEYS.join(" ")} 2>/dev/null; ${command}`;
}

// ------------------------------------------------------------ redaction ---

const REDACTED = "[redacted secret]";
/** The shape of a secret, whoever it belongs to: API keys, tokens, private key blocks. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP) [A-Z ]*-----[\s\S]*?-----END (?:OPENSSH|RSA|EC|DSA|PGP) [A-Z ]*-----/g,
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:glpat|npm|pypi|hf|dop_v1|shpat|shpss|sq0atp|sq0csp|rpa|pk_live|sk_live|rk_live)[-_][A-Za-z0-9_-]{20,}\b/g,
];

/** A variable whose name says it holds a secret. */
const SECRET_NAME = /(^|_)(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|AUTH)(_|$)/i;

/**
 * The secret values Jarhead knows about: its own keys from the environment and
 * every secret-named value in ~/.jarhead/env (the file also carries settings such
 * as JARHEAD_BRAIN_MODEL, which must not be blanked out of results). A value
 * shorter than 8 characters is not redacted (it would blank ordinary words); a
 * file that cannot be read adds nothing.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const values = new Set<string>();
  for (const key of SECRET_KEYS) {
    const v = env[key];
    if (v && v.length >= 8) values.add(v);
  }
  try {
    const text = readFileSync(join(home, ".jarhead", "env"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      if (!(SECRET_KEYS as readonly string[]).includes(key) && !SECRET_NAME.test(key)) continue;
      const raw = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
      if (raw.length >= 8) values.add(raw);
    }
  } catch {
    // no file, or unreadable: nothing to add
  }
  return [...values];
}

/** Every known secret value (and its base64 form) and every secret-shaped string in `text`, replaced. */
export function redactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    if (!v || v.length < 8) continue;
    out = out.split(v).join(REDACTED);
    const b64 = Buffer.from(v, "utf8").toString("base64");
    if (b64.length >= 12) out = out.split(b64).join(REDACTED).split(b64.replace(/=+$/, "")).join(REDACTED);
    const uri = encodeURIComponent(v);
    if (uri !== v) out = out.split(uri).join(REDACTED);
  }
  for (const re of SECRET_SHAPES) out = out.replace(re, REDACTED);
  return out;
}

/**
 * The redactor the runner applies to every text a model reads. The env file is
 * re-read when it changed, so a key Kevin rotates through Setup is covered without
 * a restart.
 */
export class SecretRedactor {
  private values: string[] = [];
  private mtime = -1;
  private readAt = 0;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly home: string = homedir(), private readonly now: () => number = Date.now) {}

  private refresh(): void {
    const t = this.now();
    if (t - this.readAt < 5_000 && this.mtime !== -1) return;
    this.readAt = t;
    let mtime = 0;
    try {
      mtime = statSync(join(this.home, ".jarhead", "env")).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime === this.mtime && this.values.length > 0) return;
    this.mtime = mtime;
    this.values = secretValues(this.env, this.home);
  }

  redact(text: string): string {
    this.refresh();
    return redactSecrets(text, this.values);
  }

  /** How many values are being watched for (the doctor and tests). */
  get count(): number {
    this.refresh();
    return this.values.length;
  }
}

/** Head and tail of a long text, with a note about what fell out. */
export function truncateOutput(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  return `${text.slice(0, head)}\n… [${text.length - cap} characters omitted] …\n${text.slice(-tail)}`;
}

/** Keeps the first and last STREAM_KEEP bytes of a stream. */
class BoundedBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;
  push(chunk: string): void {
    if (this.head.length < STREAM_KEEP) {
      const room = STREAM_KEEP - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > STREAM_KEEP) {
      this.dropped += this.tail.length - STREAM_KEEP;
      this.tail = this.tail.slice(-STREAM_KEEP);
    }
  }
  toString(): string {
    return this.dropped > 0 || this.tail ? `${this.head}${this.dropped ? `\n… [${this.dropped} bytes dropped] …\n` : ""}${this.tail}` : this.head;
  }
}

export interface ShellRunOptions {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Every chunk as it arrives, for progress lines. */
  readonly onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  /** stdin contents; closed at once when absent. */
  readonly stdin?: string | undefined;
  /** Program and argv instead of a zsh command line. */
  readonly argv?: readonly string[] | undefined;
}

export interface ShellRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly ms: number;
  readonly error?: string | undefined;
}

/**
 * Run to completion under a timeout. The command goes through `zsh -lc` so
 * Kevin's PATH applies, with Jarhead's keys unset again after the rc files ran;
 * `argv` bypasses the shell for programs the caller spawns itself (git, pnpm,
 * osascript).
 */
export function runShell(opts: ShellRunOptions): Promise<ShellRunResult> {
  const started = Date.now();
  const timeoutMs = Math.min(MAX_SHELL_TIMEOUT_MS, Math.max(1000, opts.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS));
  return new Promise((resolve) => {
    const out = new BoundedBuffer();
    const err = new BoundedBuffer();
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let child: ChildProcess;
    const [file, args] = opts.argv && opts.argv.length > 0 ? [opts.argv[0]!, opts.argv.slice(1)] : ["/bin/zsh", ["-lc", loginShellCommand(opts.command)]];
    try {
      // Its own process group, so a timeout or a stop reaches the whole tree (zsh and the sleep it spawned), not just the shell.
      child = spawn(file, args, { cwd: opts.cwd ?? process.env["HOME"], env: scrubbedEnv(opts.env ?? process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, ms: Date.now() - started, error: (e as Error).message });
      return;
    }
    const signalTree = (sig: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // gone
        }
      }
    };
    const kill = (): void => {
      signalTree("SIGTERM");
      setTimeout(() => signalTree("SIGKILL"), 2000).unref();
    };
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout: out.toString(), stderr: err.toString(), timedOut, cancelled, ms: Date.now() - started, ...(spawnError ? { error: spawnError } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out.push(chunk);
      opts.onOutput?.(chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: string) => {
      err.push(chunk);
      opts.onOutput?.(chunk, "stderr");
    });
    child.on("error", (e) => {
      spawnError = e.message;
      if (child.pid === undefined) finish(null, null);
    });
    // close waits for every holder of the pipes; an orphan that survived the kill must not hold the result hostage.
    child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 300).unref());
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin?.on("error", (e) => log.debug(`stdin: ${e.message}`));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

/** The text a model reads for a finished command. */
export function describeShellResult(r: ShellRunResult, cap = OUTPUT_CAP): string {
  const body = `${r.stdout}${r.stderr ? `${r.stdout ? "\n" : ""}[stderr] ${r.stderr}` : ""}`.trim();
  const status = r.error ? `[could not start: ${r.error}] ` : r.timedOut ? `[stopped after ${Math.round(r.ms / 1000)} s] ` : r.cancelled ? "[cancelled] " : r.code === 0 ? "" : `[exit ${r.code ?? r.signal ?? "?"}] `;
  return `${status}${truncateOutput(body, cap) || "(no output)"}`;
}

// -------------------------------------------------------------- background ---

export interface BackgroundJob {
  readonly pid: number;
  readonly command: string;
  readonly logPath: string;
  readonly startedAt: number;
  readonly cwd: string;
}

/**
 * Long-running commands (a dev server, a build watcher) started for Kevin and
 * left running. Each one logs to <stateDir>/shell/<id>.log; its pid is what the
 * policy calls an owned process, so a later `kill <pid>` runs without asking.
 */
export class BackgroundJobs {
  private readonly jobs = new Map<number, BackgroundJob>();

  constructor(private readonly stateDir: string) {}

  start(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): BackgroundJob {
    const dir = join(this.stateDir, "shell");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${newId("job")}.log`);
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn("/bin/zsh", ["-lc", loginShellCommand(command)], { cwd, env: scrubbedEnv(env), detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    if (child.pid === undefined) throw new Error("the process did not start");
    child.unref();
    const job: BackgroundJob = { pid: child.pid, command, logPath, startedAt: Date.now(), cwd };
    this.jobs.set(job.pid, job);
    child.on("exit", (code, signal) => {
      log.info(`background job ${job.pid} ended (${code ?? signal ?? "?"}): ${command.slice(0, 60)}`);
      this.jobs.delete(job.pid);
    });
    child.on("error", (e) => log.warn(`background job ${job.pid}: ${e.message}`));
    return job;
  }

  /** Pids of the jobs still running. */
  pids(): number[] {
    return [...this.jobs.keys()];
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  /** Stop the jobs started at or after `since` (Kevin pressed stop mid-task); returns how many were signalled. */
  stopSince(since: number): number {
    let n = 0;
    for (const job of this.list()) {
      if (job.startedAt < since) continue;
      n++;
      try {
        process.kill(-job.pid, "SIGTERM");
      } catch {
        try {
          process.kill(job.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    return n;
  }

  /** Stop every job Jarhead started (the whole process group of each). */
  stopAll(): void {
    for (const pid of this.pids()) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  }
}

// ------------------------------------------------------------- applescript ---

/** osascript with the script on stdin, 60 s cap; the result or the error text. */
export async function runAppleScript(script: string, opts: { readonly timeoutMs?: number | undefined; readonly signal?: AbortSignal | undefined; readonly env?: NodeJS.ProcessEnv | undefined } = {}): Promise<ShellRunResult> {
  return runShell({ command: "osascript", argv: ["/usr/bin/osascript", "-"], stdin: script, timeoutMs: opts.timeoutMs ?? 60_000, signal: opts.signal, env: opts.env });
}
