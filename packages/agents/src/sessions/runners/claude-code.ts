import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentStatus } from "@jarhead/protocol";
import { ClaudeSession, claudeEnv, loadSdk, type PermissionDecision, type SdkLike } from "../../claude-code/session.ts";
import { cliVersion, findCli, notFoundText, type FindCliOptions } from "../codex-bin.ts";
import type { DiscoveredSession } from "../store.ts";
import type { Continuation, ContinueOptions, ContinueOutcome, DescribeContext, OwnershipSnapshot, RunEvent, RunHandle, RunSink, SessionRunner } from "./types.ts";

/**
 * Claude Code sessions, continued through the Agent SDK's `resume`.
 *
 * This is the driver the connector always had, moved behind the runner interface
 * unchanged: the same ownership refusals, the same session options, the same
 * permission callback (the connector's ask-Kevin loop plugs in through
 * `ContinueOptions.canUseTool`).
 */

export interface ClaudeCodeRunnerOptions {
  readonly sdk?: SdkLike;
  readonly permissionMode?: string;
  /** Keep ANTHROPIC_API_KEY away from the CLI so it uses Kevin's login. Default true. */
  readonly dropApiKey?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly applicationsDir?: string;
  readonly systemDirs?: readonly string[];
  /** Sessions are named for the Console; the connector supplies its own naming. */
  readonly nameOf?: (s: DiscoveredSession) => string;
}

export class ClaudeCodeRunner implements SessionRunner {
  readonly tool = "claude" as const;
  private sdkPromise: Promise<SdkLike> | undefined;

  constructor(private readonly opts: ClaudeCodeRunnerOptions = {}) {}

  private sdk(): Promise<SdkLike> {
    if (this.opts.sdk) return Promise.resolve(this.opts.sdk);
    this.sdkPromise ??= loadSdk();
    return this.sdkPromise;
  }

  private findOpts(): FindCliOptions {
    return {
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(this.opts.home ? { home: this.opts.home } : {}),
      ...(this.opts.applicationsDir ? { applicationsDir: this.opts.applicationsDir } : {}),
      ...(this.opts.systemDirs ? { systemDirs: this.opts.systemDirs } : {}),
    };
  }

  async usable(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.sdk();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `agent sdk unavailable: ${(e as Error).message}` };
    }
  }

  async canContinue(s: DiscoveredSession, snap: OwnershipSnapshot): Promise<Continuation> {
    if (snap.live.length > 0) {
      const where = snap.live.some((p) => p.interactive) ? "a terminal" : "Claude Desktop";
      return { ok: false, reason: `that session is open in ${where}; ask Kevin to type it there or start a Jarhead session in that folder` };
    }
    if (snap.degraded) {
      // No owner found, but the search was incomplete. Resuming would append to a transcript
      // some other process may still be writing; the safe answer is no.
      return { ok: false, reason: `cannot tell whether that session is open (${snap.degraded}); not resuming it` };
    }
    const cwd = await checkCwd(s.cwd);
    if (cwd.error) return { ok: false, reason: cwd.error };
    return { ok: true, mode: "resume" };
  }

  async continue(s: DiscoveredSession, text: string, _mode: string, sink: RunSink, opts: ContinueOptions = {}): Promise<ContinueOutcome> {
    const cwd = await checkCwd(s.cwd);
    if (cwd.error || !s.cwd) return { kind: "refused", reason: cwd.error ?? "that session has no working directory on record" };
    let sdk: SdkLike;
    try {
      sdk = await this.sdk();
    } catch (e) {
      return { kind: "refused", reason: `agent sdk unavailable: ${(e as Error).message}` };
    }
    const handle = this.open(sdk, { cwd: s.cwd, resume: s.id, name: this.opts.nameOf?.(s) ?? basename(s.cwd) }, sink, opts);
    handle.send(text);
    return { kind: "run", handle, detail: "resumed headlessly" };
  }

  async start(cwd: string, prompt: string, sink: RunSink, opts: ContinueOptions = {}): Promise<RunHandle> {
    const check = await checkCwd(cwd);
    if (check.error) throw new Error(check.error);
    const sdk = await this.sdk();
    const handle = this.open(sdk, { cwd, name: basename(cwd) }, sink, opts);
    if (prompt.trim()) handle.send(prompt);
    return handle;
  }

  private open(sdk: SdkLike, target: { cwd: string; resume?: string; name: string }, sink: RunSink, opts: ContinueOptions): ClaudeRunHandle {
    const session: ClaudeSession = new ClaudeSession({
      sdk,
      cwd: target.cwd,
      ...(target.resume ? { resume: target.resume } : {}),
      name: target.name,
      permissionMode: this.opts.permissionMode ?? "acceptEdits",
      env: claudeEnv(this.opts.env ?? process.env, { dropApiKey: this.opts.dropApiKey ?? true }),
      includePartialMessages: false,
      ...(opts.canUseTool ? { canUseTool: (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => opts.canUseTool!(toolName, input, session) } : {}),
    });
    const handle = new ClaudeRunHandle(session);
    const emit = (e: RunEvent): void => sink(e, handle);
    session.on("status", (status, detail) => emit({ type: "status", status, detail }));
    // The session id arrives with init; a new thread is filed by the connector on this event.
    session.on("init", () => emit({ type: "status", status: session.status, detail: session.statusDetail }));
    session.on("result", () => {
      if (session.lastAssistantText) emit({ type: "reply", text: session.lastAssistantText });
    });
    session.on("error", (e) => emit({ type: "error", message: e.message }));
    session.on("closed", () => emit({ type: "closed" }));
    session.start();
    return handle;
  }

  async describe(ctx: DescribeContext): Promise<string> {
    const parts: string[] = [];
    const found = await findCli("claude", this.findOpts());
    if (found) {
      const version = await cliVersion(found.path);
      parts.push(`Claude Code ${version ?? "?"} (${found.origin})`);
    } else {
      parts.push(await notFoundText("claude", this.findOpts()));
    }
    parts.push(ctx.storePresent ? `${ctx.listed} session${ctx.listed === 1 ? "" : "s"}` : "no sessions yet");
    const running = ctx.processes.filter((p) => p.tool === "claude").length;
    if (running) parts.push(`${running} running`);
    return parts.join(" · ");
  }
}

/** The session's cwd must still be a folder before anything is spawned in it. */
async function checkCwd(cwd: string | undefined): Promise<{ error?: string }> {
  if (!cwd) return { error: "that session has no working directory on record" };
  try {
    if (!(await stat(cwd)).isDirectory()) return { error: `${cwd} is not a folder any more` };
  } catch {
    return { error: `${cwd} no longer exists` };
  }
  return {};
}

class ClaudeRunHandle implements RunHandle {
  readonly tool = "claude" as const;
  /** Resolves once the CLI reports its session id (the SDK's init message); rejects if the session ends first. */
  readonly ready: Promise<void>;

  constructor(readonly session: ClaudeSession) {
    this.ready = new Promise<void>((resolve, reject) => {
      if (session.sessionId) {
        resolve();
        return;
      }
      session.once("init", () => resolve());
      session.once("closed", () => reject(new Error(session.statusDetail ?? "session ended before it started")));
      session.once("error", (e) => reject(e));
    });
    this.ready.catch(() => undefined);
  }

  get sessionId(): string | undefined {
    return this.session.sessionId;
  }

  get cwd(): string {
    return this.session.cwd;
  }

  get status(): AgentStatus {
    return this.session.status;
  }

  get statusDetail(): string | undefined {
    return this.session.statusDetail;
  }

  get lastReply(): string {
    return this.session.lastAssistantText;
  }

  get lastActivityAt(): number {
    return this.session.lastActivityAt;
  }

  /** The SDK does not expose its CLI child's pid; ownership checks never consult it for Claude. */
  get pids(): readonly number[] {
    return [];
  }

  get pendingPermissionTool(): string | undefined {
    return this.session.pendingPermissionTool;
  }

  send(text: string): void {
    this.session.send(text);
  }

  resolvePermission(allow: boolean): boolean {
    return this.session.resolvePermission(allow);
  }

  interrupt(): Promise<void> {
    return this.session.interrupt();
  }

  close(): Promise<void> {
    return this.session.close();
  }
}
