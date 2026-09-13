import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LineSplitter, logger } from "@jarhead/core";
import type { AgentStatus } from "@jarhead/protocol";
import { cliVersion, findCli, notFoundText, readCodexAuth, type FindCliOptions, type FoundCli } from "../codex-bin.ts";
import { FINISHING_MAX_MS } from "../liveness.ts";
import { isRecord, parseJsonLine, str, truncate, type DiscoveredSession } from "../store.ts";
import type { Continuation, ContinueMode, ContinueOutcome, DescribeContext, OwnershipSnapshot, RunEvent, RunHandle, RunSink, SessionRunner } from "./types.ts";

const log = logger("agents.codex");

/**
 * Codex threads, driven through the Codex CLI (codex-cli 0.153, the copy bundled in
 * ChatGPT.app or any other one `findCli` turns up).
 *
 * Two ways in, chosen by who was seen holding the thread (ps + lsof, see processes.ts):
 *
 *  - A live process holds its rollout or writer lock open (Codex Desktop's app-server, a
 *    `codex resume <id>` in a terminal): `codex queue --thread <id> --message <text>` files
 *    the text for that thread, exactly as if Kevin typed it there. Nothing of ours runs.
 *  - Nobody holds it: `codex exec resume <id> <text> --json` continues the saved thread
 *    headlessly; the rollout on disk grows, so the rail shows the new turn. A writer lock
 *    with no process behind it is a leftover from a crash: the CLI takes stale locks itself
 *    ("failed to remove stale thread writer lock" is its complaint when it cannot), so the
 *    lock file alone is no reason to queue.
 *  - Ownership could not be told (ps or lsof failed): refused, as for Claude Code.
 *
 * `codex queue` says nothing about ownership. Checked against 0.153.4 with and without an
 * app-server: it inserts a row into $CODEX_HOME/queue_1.sqlite and exits 0 whenever the
 * rollout exists ("Queued message <uuid> for thread <id>." on stdout), daemon or no daemon;
 * it exits 1 only when the rollout is missing. A queue nobody drains would look delivered,
 * so the choice above is made from the process snapshot alone, never from the queue's exit.
 * Sub-agent and automation rollouts are refused outright: they are not threads Kevin sat in.
 *
 * New threads are `codex exec --json -C <cwd> <prompt>`: persisted (no --ephemeral), so
 * they show up in ~/.codex/sessions like any other.
 *
 * `codex exec resume` takes neither -C nor -s (checked against 0.153.4: "unexpected
 * argument"), so the child is spawned in the session's cwd and the sandbox is set with
 * `-c sandbox_mode="workspace-write"` — what a human continuing that thread gets, never
 * danger-full-access. Positionals follow `--` so a prompt that starts with a dash is a
 * prompt.
 *
 * `--json` event shapes, recorded from `codex exec --json` on this machine (see
 * __tests__/fixtures/codex-exec-events.jsonl):
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started"|"item.updated"|"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"error","message":"…"}}      informational; the turn went on
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}}
 * and, recorded from a run whose API key was refused (codex-exec-reconnect-events.jsonl):
 *   {"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 …)"}   ×4, then an
 *   item.completed error "Falling back from WebSockets to HTTPS transport", ×5 more, one
 *   {"type":"error","message":"unexpected status 401 …"} with the bare message, and
 *   {"type":"turn.failed","error":{"message":"unexpected status 401 …"}}, exit 1.
 * A top-level `error` is a notice — a transport retry the turn may still survive, or the
 * failure turn.failed is about to report — so it only changes the status detail; the turn
 * fails on turn.failed or on an exit without turn.completed. From the CLI's documented
 * protocol, tolerated here: items of type reasoning, command_execution {command,
 * aggregated_output, exit_code, status}, mcp_tool_call {server, tool, status}, file_change,
 * web_search, todo_list.
 */

export interface CodexRunnerOptions {
  /** ~/.codex: auth.json, thread-writer-locks/, and CODEX_HOME for the child when it is not the default. */
  readonly codexRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly applicationsDir?: string;
  readonly systemDirs?: readonly string[];
  /**
   * With a ChatGPT login, keep OPENAI_API_KEY (Jarhead's own, for the voice) out of the
   * child's environment so Codex bills Kevin's plan, not the key. Default true.
   */
  readonly dropApiKey?: boolean;
  /** Wall clock per turn before the child is interrupted. Default 15 min. */
  readonly turnBudgetMs?: number;
  /** How long a new thread may take to report its id. Default 30 s. */
  readonly startTimeoutMs?: number;
  /** `codex queue` must finish within this. Default 15 s. */
  readonly queueTimeoutMs?: number;
  /** SIGINT → SIGKILL grace. Default 3 s. */
  readonly killGraceMs?: number;
  /** After turn.completed, how long the child may keep flushing before the run reads idle anyway. Default 30 s. */
  readonly finishingMaxMs?: number;
  readonly now?: () => number;
}

interface QueueResult {
  readonly ok: boolean;
  readonly error: string;
}

export class CodexRunner implements SessionRunner {
  readonly tool = "codex" as const;
  private readonly now: () => number;
  private binCache: { at: number; found: FoundCli | undefined } | undefined;

  constructor(private readonly opts: CodexRunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  private findOpts(): FindCliOptions {
    return {
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(this.opts.home ? { home: this.opts.home } : {}),
      ...(this.opts.applicationsDir ? { applicationsDir: this.opts.applicationsDir } : {}),
      ...(this.opts.systemDirs ? { systemDirs: this.opts.systemDirs } : {}),
    };
  }

  /** The codex binary, re-looked-up every 10 s so an install or a PATH fix is noticed. */
  async binary(): Promise<FoundCli | undefined> {
    const now = this.now();
    if (this.binCache && now - this.binCache.at < 10_000) return this.binCache.found;
    const found = await findCli("codex", this.findOpts());
    this.binCache = { at: now, found };
    return found;
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  async usable(): Promise<{ ok: boolean; reason?: string }> {
    const found = await this.binary();
    if (!found) return { ok: false, reason: await notFoundText("codex", this.findOpts()) };
    const auth = await readCodexAuth(this.opts.codexRoot, this.env());
    if (!auth.signedIn) return { ok: false, reason: `Codex is ${auth.reason ?? "not signed in"}` };
    return { ok: true };
  }

  private lockPath(threadId: string): string {
    return join(this.opts.codexRoot, "thread-writer-locks", `${threadId}.lock`);
  }

  async canContinue(s: DiscoveredSession, snap: OwnershipSnapshot): Promise<Continuation> {
    // The listing hides these; a send() that reaches one by id gets the same answer, whatever else is true.
    if (s.source === "subagent") return { ok: false, reason: `that rollout is a Codex sub-agent run${s.parentId ? ` of thread ${s.parentId.slice(0, 8)}` : ""}; continue its parent thread instead` };
    if (s.source === "automation") return { ok: false, reason: "that rollout is a Codex automation run, not a thread to continue" };
    const usable = await this.usable();
    if (!usable.ok) return { ok: false, reason: usable.reason ?? "codex unavailable" };
    if (s.archived) return { ok: false, reason: "that Codex thread is archived; unarchive it in Codex first" };
    if (snap.live.length > 0) return { ok: true, mode: "queue" };
    // No owner found, but the search was incomplete. `codex queue` exits 0 whether or not
    // anyone would drain it, so it cannot stand in for the missing answer; the safe one is no.
    if (snap.degraded) return { ok: false, reason: `cannot tell whether that thread is open in Codex (${snap.degraded}); not resuming it` };
    const cwd = await checkCwd(s.cwd);
    if (cwd.error) return { ok: false, reason: cwd.error };
    if (await exists(this.lockPath(s.id))) log.info(`thread ${s.id.slice(0, 8)}: writer lock with no process holding it; a leftover, resuming`);
    return { ok: true, mode: "resume" };
  }

  async continue(s: DiscoveredSession, text: string, mode: ContinueMode, sink: RunSink): Promise<ContinueOutcome> {
    const usable = await this.usable();
    if (!usable.ok) return { kind: "refused", reason: usable.reason ?? "codex unavailable" };
    const bin = (await this.binary())!;
    if (mode === "queue") {
      const q = await this.queue(bin, s.id, text);
      if (q.ok) return { kind: "delivered", detail: "queued into the open Codex thread; Codex will run it there" };
      return { kind: "refused", reason: `that thread is open in Codex and queueing into it failed: ${q.error}` };
    }
    const cwd = await checkCwd(s.cwd);
    if (cwd.error || !s.cwd) return { kind: "refused", reason: cwd.error ?? "that thread has no working directory on record" };
    const handle = new CodexRun({ bin: bin.path, threadId: s.id, cwd: s.cwd, env: await this.childEnv(), budget: this.budgets(), sink, now: this.now });
    handle.send(text);
    return { kind: "run", handle, detail: "resumed headlessly" };
  }

  async start(cwd: string, prompt: string, sink: RunSink): Promise<RunHandle> {
    const usable = await this.usable();
    if (!usable.ok) throw new Error(usable.reason ?? "codex unavailable");
    const check = await checkCwd(cwd);
    if (check.error) throw new Error(check.error);
    if (!prompt.trim()) throw new Error("a new Codex thread needs a prompt");
    const bin = (await this.binary())!;
    const handle = new CodexRun({ bin: bin.path, threadId: undefined, cwd, env: await this.childEnv(), budget: this.budgets(), sink, now: this.now });
    handle.send(prompt);
    return handle;
  }

  private budgets(): Budgets {
    return {
      turnMs: this.opts.turnBudgetMs ?? 15 * 60_000,
      startMs: this.opts.startTimeoutMs ?? 30_000,
      killGraceMs: this.opts.killGraceMs ?? 3_000,
      finishingMs: this.opts.finishingMaxMs ?? FINISHING_MAX_MS,
    };
  }

  /** The environment the CLI child sees: CODEX_HOME when the root is not the real ~/.codex, no stray API key with a ChatGPT login. */
  private async childEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...this.env() };
    if (this.opts.codexRoot !== join(homedir(), ".codex")) env["CODEX_HOME"] = this.opts.codexRoot;
    if (this.opts.dropApiKey ?? true) {
      const auth = await readCodexAuth(this.opts.codexRoot, this.env());
      if (auth.how === "chatgpt") delete env["OPENAI_API_KEY"];
    }
    return env;
  }

  /**
   * `codex queue --thread <id> --message <text>`. It talks to the thread store, not to a
   * working directory, so it is spawned in none: a thread whose folder is gone can still
   * take a message. Exit 0 is filed ("Queued message <uuid> for thread <id>." on stdout);
   * anything else carries stderr's last line.
   */
  private async queue(bin: FoundCli, threadId: string, text: string): Promise<QueueResult> {
    const env = await this.childEnv();
    const timeoutMs = this.opts.queueTimeoutMs ?? 15_000;
    return new Promise<QueueResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin.path, ["queue", "--thread", threadId, "--message", text], { env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message });
        return;
      }
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, error: `codex queue did not finish within ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e.message });
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          log.info(`thread ${threadId.slice(0, 8)}: ${stderrTail(out) || "queued"}`);
          resolve({ ok: true, error: "" });
        } else resolve({ ok: false, error: stderrTail(err) || stderrTail(out) || `exit ${code ?? signal ?? "?"}` });
      });
    });
  }

  /** "Codex 0.153.4 (ChatGPT.app) · signed in · desktop app running · 39 threads", or the exact reason it is not that. */
  async describe(ctx: DescribeContext): Promise<string> {
    const parts: string[] = [];
    const found = await this.binary();
    if (found) {
      const version = await cliVersion(found.path);
      parts.push(`Codex ${version ?? "?"} (${found.origin})`);
      const auth = await readCodexAuth(this.opts.codexRoot, this.env());
      parts.push(auth.signedIn ? (auth.how === "api-key" ? "signed in (API key)" : auth.how === "env-key" ? "signed in (OPENAI_API_KEY from the environment)" : "signed in") : (auth.reason ?? "not signed in"));
    } else {
      parts.push(await notFoundText("codex", this.findOpts()));
    }
    const desktop = ctx.processes.some((p) => p.tool === "codex" && /\bapp-server\b/.test(p.command));
    parts.push(desktop ? "desktop app running" : "desktop app not running");
    parts.push(ctx.storePresent ? `${ctx.listed} thread${ctx.listed === 1 ? "" : "s"}` : "no threads yet");
    return parts.join(" · ");
  }
}

interface Budgets {
  readonly turnMs: number;
  readonly startMs: number;
  readonly killGraceMs: number;
  readonly finishingMs: number;
}

interface CodexRunOptions {
  readonly bin: string;
  /** Known for a resume; learned from thread.started for a new thread. */
  readonly threadId: string | undefined;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly budget: Budgets;
  readonly sink: RunSink;
  readonly now: () => number;
}

/**
 * One Codex thread this process drives. Each turn is its own `codex exec` child; turns
 * sent while one is running wait their turn. The handle outlives its children — it is
 * "idle" between turns and "offline" only after close().
 */
export class CodexRun implements RunHandle {
  readonly tool = "codex" as const;
  readonly cwd: string;
  sessionId: string | undefined;
  status: AgentStatus = "idle";
  statusDetail: string | undefined = "starting";
  lastReply = "";
  lastActivityAt: number;
  readonly pendingPermissionTool: string | undefined = undefined;
  readonly ready: Promise<void>;
  private readyDone = false;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private child: ChildProcess | undefined;
  private readonly pending: string[] = [];
  private closed = false;
  private closedEmitted = false;
  private stderr = "";
  /** The last top-level `error` event of this turn: the reason when the child exits without turn.completed or turn.failed. */
  private lastStreamError: string | undefined;
  private turnCompleted = false;
  private interrupted: string | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Exit of the current child, awaited by close(). */
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CodexRunOptions) {
    this.cwd = opts.cwd;
    this.sessionId = opts.threadId;
    this.lastActivityAt = opts.now();
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined); // observed by whoever awaits it; never an unhandled rejection here
  }

  /** Every child this run spawned, latest last: a ps snapshot taken seconds ago may still list one that has exited. */
  private readonly spawned: number[] = [];

  get pids(): readonly number[] {
    return this.spawned;
  }

  private emit(e: RunEvent): void {
    this.opts.sink(e, this);
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    this.lastActivityAt = this.opts.now();
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.emit({ type: "status", status, detail });
  }

  send(text: string): void {
    if (this.closed) throw new Error("codex run is closed");
    this.pending.push(text);
    this.setStatus("working", "thinking");
    this.pump();
  }

  private pump(): void {
    if (this.child || this.closed) return;
    const text = this.pending.shift();
    if (text === undefined) return;
    this.spawnTurn(text);
  }

  private spawnTurn(text: string): void {
    const common = ["--json", "--skip-git-repo-check"];
    // Resume takes neither -C nor -s: cwd goes on the spawn, the sandbox through config.
    const args = this.sessionId
      ? ["exec", "resume", ...common, "-c", 'sandbox_mode="workspace-write"', "--", this.sessionId, text]
      : ["exec", ...common, "-C", this.cwd, "-s", "workspace-write", "--", text];
    this.turnCompleted = false;
    this.interrupted = undefined;
    this.stderr = "";
    this.lastStreamError = undefined;
    let child: ChildProcess;
    try {
      child = spawn(this.opts.bin, args, { cwd: this.cwd, env: this.opts.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.fail((e as Error).message);
      return;
    }
    this.child = child;
    if (child.pid) {
      this.spawned.push(child.pid);
      if (this.spawned.length > 20) this.spawned.shift();
    }
    this.setStatus("working", "thinking");
    const lines = new LineSplitter(4 * 1024 * 1024);
    child.stdout?.on("data", (d: Buffer) => {
      let got: string[];
      try {
        got = lines.push(d);
      } catch (e) {
        log.warn(`thread ${(this.sessionId ?? "new").slice(0, 8)}: ${(e as Error).message}`);
        return;
      }
      for (const line of got) this.handleLine(line);
    });
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr += d.toString("utf8");
      if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-32 * 1024);
    });
    this.exited = new Promise<void>((resolve) => {
      child.on("error", (e) => {
        this.child = undefined;
        this.clearTimers();
        this.fail(e.message);
        resolve();
        this.pump();
      });
      child.on("exit", (code, signal) => {
        this.child = undefined;
        this.clearTimers();
        this.onExit(code, signal);
        resolve();
        if (!this.closed) this.pump();
      });
    });
    this.timers.push(setTimeout(() => void this.stopChild(`timed out after ${humanMs(this.opts.budget.turnMs)}`), this.opts.budget.turnMs));
    if (!this.sessionId) {
      this.timers.push(
        setTimeout(() => {
          if (!this.readyDone) void this.stopChild(`codex did not start a thread within ${Math.round(this.opts.budget.startMs / 1000)} s`);
        }, this.opts.budget.startMs),
      );
    }
    for (const t of this.timers) t.unref?.();
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private handleLine(line: string): void {
    const o = parseJsonLine(line);
    if (!o) return;
    this.lastActivityAt = this.opts.now();
    const type = str(o["type"]);
    switch (type) {
      case "thread.started": {
        // A resume already knows its id; only a new thread learns it here.
        const id = str(o["thread_id"]);
        if (id && !this.sessionId) this.sessionId = id;
        this.markReady();
        this.setStatus("working", "thinking");
        return;
      }
      case "turn.started":
        this.markReady();
        this.setStatus("working", "thinking");
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.handleItem(type, o["item"]);
        return;
      case "turn.completed": {
        // The child is still flushing the rollout; it is idle once it has exited — or,
        // should the exit never come (a child wedged on the way out), once the finishing
        // grace is up: the turn is over either way, and a rail row must not say
        // `working` for a turn that completed a minute ago.
        this.turnCompleted = true;
        this.setStatus("working", "finishing");
        const finishing = setTimeout(() => {
          if (this.child && this.turnCompleted && this.status === "working") this.setStatus("idle", "turn done; child still flushing");
        }, this.opts.budget.finishingMs);
        finishing.unref?.();
        this.timers.push(finishing);
        return;
      }
      case "turn.failed": {
        const err = o["error"];
        const message = (isRecord(err) ? str(err["message"]) : str(err)) ?? "turn failed";
        this.fail(message);
        return;
      }
      case "error": {
        // A transport retry ("Reconnecting... 2/5 (…)") the turn may still survive, or the bare
        // message turn.failed is about to carry. Not the end of the turn: that is turn.failed's
        // or the exit's to say. Meanwhile the detail tells what is going on.
        const message = str(o["message"]) ?? "codex error";
        this.lastStreamError = message;
        const retry = /^Reconnecting\.{3}\s*(\d+\/\d+)/.exec(message);
        this.setStatus("working", retry ? `reconnecting ${retry[1]}` : truncate(message, 80));
        this.emit({ type: "error", message });
        return;
      }
      default:
        return;
    }
  }

  private handleItem(event: string, item: unknown): void {
    if (!isRecord(item)) return;
    const kind = str(item["type"]);
    switch (kind) {
      case "agent_message": {
        if (event !== "item.completed") return;
        const text = str(item["text"])?.trim();
        if (!text) return;
        this.lastReply = speakable(text);
        this.emit({ type: "reply", text: this.lastReply });
        return;
      }
      case "reasoning":
        if (event === "item.started") this.setStatus("working", "thinking");
        return;
      case "command_execution": {
        if (event === "item.started") this.setStatus("working", `running ${truncate(str(item["command"]) ?? "a command", 60)}`);
        else if (event === "item.completed") this.setStatus("working", "thinking");
        return;
      }
      case "mcp_tool_call": {
        if (event === "item.started") this.setStatus("working", `calling ${[str(item["server"]), str(item["tool"])].filter(Boolean).join(".") || "a tool"}`);
        else if (event === "item.completed") this.setStatus("working", "thinking");
        return;
      }
      case "file_change":
        if (event !== "item.completed") this.setStatus("working", "editing files");
        return;
      case "web_search":
        if (event !== "item.completed") this.setStatus("working", "searching the web");
        return;
      case "error": {
        // Seen live: "Exceeded skills context budget…" while the turn went on to complete. A note, not a failure.
        const message = str(item["message"]);
        if (message) this.emit({ type: "error", message });
        return;
      }
      default:
        return;
    }
  }

  private markReady(): void {
    if (this.readyDone) return;
    this.readyDone = true;
    this.resolveReady();
  }

  private fail(message: string): void {
    this.setStatus("unknown", message);
    this.emit({ type: "error", message });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) {
      this.setStatus("offline", "closed");
      this.emitClosed();
      return;
    }
    if (this.interrupted) {
      this.setStatus("idle", this.interrupted);
    } else if (this.turnCompleted) {
      this.setStatus("idle");
    } else if (this.status !== "unknown") {
      this.fail(this.lastStreamError || stderrTail(this.stderr) || (code === 0 ? "codex exited before the turn completed" : `codex exited with ${code ?? signal ?? "?"}`));
    }
    if (!this.readyDone) {
      this.readyDone = true;
      this.rejectReady(new Error(this.statusDetail ?? "codex did not start"));
    }
  }

  private emitClosed(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit({ type: "closed" });
  }

  /** SIGINT, then SIGKILL after the grace period; resolves when the child is gone. */
  private async stopChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.interrupted = reason;
    child.kill("SIGINT");
    const gone = await Promise.race([this.exited.then(() => true), sleep(this.opts.budget.killGraceMs).then(() => false)]);
    if (!gone) {
      child.kill("SIGKILL");
      await Promise.race([this.exited, sleep(this.opts.budget.killGraceMs)]);
    }
  }

  resolvePermission(): boolean {
    return false;
  }

  async interrupt(): Promise<void> {
    this.pending.length = 0;
    await this.stopChild("interrupted");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    if (this.child) await this.stopChild("closed");
    else {
      this.setStatus("offline", "closed");
      this.emitClosed();
    }
    if (!this.readyDone) {
      this.readyDone = true;
      this.rejectReady(new Error("closed before the thread started"));
    }
  }
}

/** Stderr's last useful line; the CLI's stdin notice is noise, not an error. */
function stderrTail(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Reading additional input from stdin/i.test(l));
  return truncate(lines[lines.length - 1] ?? "", 300);
}

async function checkCwd(cwd: string | undefined): Promise<{ error?: string }> {
  if (!cwd) return { error: "that thread has no working directory on record" };
  try {
    if (!(await stat(cwd)).isDirectory()) return { error: `${cwd} is not a folder any more` };
  } catch {
    return { error: `${cwd} no longer exists` };
  }
  return {};
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "15 min", "45 s", "200 ms". */
function humanMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${ms} ms`;
}

/**
 * A reply as something to say out loud: fenced code becomes "(code)", inline code keeps
 * its text, emphasis and heading marks go, links keep their words, list bullets become
 * sentences. The rollout keeps the original.
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
