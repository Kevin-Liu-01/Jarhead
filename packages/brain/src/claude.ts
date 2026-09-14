import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { logger } from "@jarhead/core";
import { ClaudeSession, claudeEnv, loadSdk, type PermissionDecision, type SdkLike } from "@jarhead/agents";
import type { Brain, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { SYSTEM_PROMPT_VERSION, brainSystemPrompt } from "./brain.ts";
import { ALL_TOOL_SPECS, type ToolSpec } from "./tools.ts";
import { progressLine } from "./responses.ts";
import { delegationPrompt } from "./anthropic.ts";
import { loadAttachments } from "./attachments.ts";
import type { ToolRunner } from "./runner.ts";

/**
 * The Claude brain: one persistent headless Claude Code session (Agent SDK) with
 * Jarhead's tools mounted as an in-process MCP server.
 *
 * Why Claude Code rather than the bare API: it is authenticated on this machine
 * without a key, it inherits Kevin's CLAUDE.md and skills, and its built-in
 * WebSearch/Read/Grep cover the "look something up" half of a desktop assistant
 * for free. Each delegation is one user turn on the same session, so context
 * (what it saw, what it did) carries across turns without us managing it.
 */

const log = logger("brain.claude");

export interface ClaudeBrainOptions {
  readonly runner: ToolRunner;
  /** Where to remember a failed probe so the next launch does not wait again. */
  readonly stateDir?: string;
  /** How long a remembered failure stays valid. */
  readonly probeMemoryMs?: number;
  /** Test seam: how the API key(s) Claude Code would use are validated. */
  readonly authProbe?: () => Promise<AuthProbe>;
  /** How long the first "reply ok" turn may take before the brain is declared unavailable. */
  readonly probeTimeoutMs?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  readonly pathToClaudeCodeExecutable?: string;
  /** Skip ~/.claude/settings.json (which may pin a stale ANTHROPIC_API_KEY). */
  readonly settingSources?: readonly string[];
  readonly dropApiKey?: boolean;
  readonly sdk?: SdkLike;
  /** Test seam: builds the MCP server config from tool specs. */
  readonly mcpFactory?: (specs: readonly ToolSpec[], call: (name: string, args: unknown) => Promise<McpResult>) => Promise<Record<string, unknown>>;
}

export interface McpResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}


export type AuthProbe = "valid" | "invalid" | "none";

/**
 * Claude Code takes its key from ANTHROPIC_API_KEY or ~/.claude/settings.json;
 * a stale key there fails every turn after eleven retries (~3 min of silence).
 * Validating it up front with one cheap request is what lets the engine fall
 * back to the OpenAI brain before Kevin has said a word.
 */
export async function probeAnthropicAuth(): Promise<AuthProbe> {
  let key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    try {
      const { readFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      key = (JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as { env?: { ANTHROPIC_API_KEY?: string } }).env?.ANTHROPIC_API_KEY;
    } catch {
      key = undefined;
    }
  }
  if (!key) return "none";
  try {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(6000) });
    return r.status === 200 ? "valid" : r.status === 401 || r.status === 403 ? "invalid" : "none";
  } catch {
    return "none";
  }
}

export class ClaudeBrain implements Brain {
  readonly kind = "claude-code";
  private session: ClaudeSession | undefined;
  private current: { task: BrainTask; sink: BrainSink; resolve: (r: BrainResult) => void } | undefined;
  private ready = false;
  private readyDetail = "not started";

  constructor(private readonly opts: ClaudeBrainOptions) {}

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.session) return { ready: this.ready, detail: this.readyDetail };
    try {
      const sdk = this.opts.sdk ?? (await loadSdk());
      const mcp = await (this.opts.mcpFactory ?? defaultMcpFactory)(ALL_TOOL_SPECS, (name, args) => this.callTool(name, args));
      const session = new ClaudeSession({
        sdk,
        cwd: this.opts.cwd ?? process.env["HOME"] ?? "/",
        name: "jarhead-brain",
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        ...(this.opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable } : {}),
        systemPromptAppend: brainSystemPrompt(),
        // The brain's transcript is Jarhead's, not Kevin's: keep it out of his resume list.
        persistSession: false,
        mcpServers: { jarhead: mcp },
        permissionMode: "default",
        settingSources: this.opts.settingSources ?? ["project", "local"],
        env: claudeEnv(process.env, { dropApiKey: this.opts.dropApiKey ?? true }),
        includePartialMessages: true,
        canUseTool: (toolName, input) => this.permission(toolName, input),
      });
      session.on("tool", (t) => {
        const name = t.name.replace(/^mcp__jarhead__/, "");
        // Our own MCP tools report through the runner; built-ins only get a line here.
        if (!t.name.startsWith("mcp__jarhead__")) this.current?.sink.thinking(progressLine(name, t.input));
      });
      session.on("assistant", (text) => this.current?.sink.step({ kind: "note", text: text.slice(0, 1000) }));
      session.on("result", (msg) => {
        const cur = this.current;
        if (!cur) return;
        this.current = undefined;
        this.opts.runner.attach(undefined);
        if (msg.is_error) {
          const err = msg.result ?? "turn failed";
          this.readyDetail = err;
          cur.resolve({ status: "failed", error: err });
          return;
        }
        const answer = (session.lastAssistantText || "done.").trim();
        cur.resolve({ status: "done", summary: answer });
      });
      session.on("error", (e) => {
        log.warn(`session error: ${e.message}`);
        if (/authenticat|401|OAuth/i.test(e.message)) {
          this.ready = false;
          this.readyDetail = `Claude Code is not authenticated: ${e.message}`;
        }
      });
      session.on("closed", () => {
        this.ready = false;
        this.readyDetail = "session closed";
        const cur = this.current;
        this.current = undefined;
        cur?.resolve({ status: "failed", error: "Claude session closed" });
      });
      this.session = session;
      const remembered = this.rememberedFailure();
      if (remembered) {
        this.readyDetail = `${remembered} (remembered from ${Math.round((Date.now() - this.rememberedAt) / 60000)} min ago; delete ${this.probeFile()} to retry)`;
        return { ready: false, detail: this.readyDetail };
      }
      const auth = await (this.opts.authProbe ?? probeAnthropicAuth)();
      if (auth === "invalid" && !(this.opts.dropApiKey ?? true)) {
        this.readyDetail = "ANTHROPIC_API_KEY is rejected by the API";
        return { ready: false, detail: this.readyDetail };
      }
      session.start();
      if (auth !== "valid") {
        // No valid key: the CLI will try OAuth. Prove it with one tiny turn
        // rather than discovering the failure on Kevin's first real request.
        const ok = await this.probeTurn(session, this.opts.probeTimeoutMs ?? 30_000);
        if (!ok.ok) {
          await session.close();
          this.session = undefined;
          this.readyDetail = ok.detail;
          this.rememberFailure(ok.detail);
          return { ready: false, detail: this.readyDetail };
        }
        this.forgetFailure();
      }
      this.ready = true;
      this.readyDetail = `headless Claude Code (${this.opts.model || "default model"}, ${auth === "valid" ? "api key" : "oauth"})`;
      log.info(`ready; standing orders v${SYSTEM_PROMPT_VERSION}`);
      return { ready: true, detail: this.readyDetail };
    } catch (e) {
      this.ready = false;
      this.readyDetail = (e as Error).message;
      return { ready: false, detail: this.readyDetail };
    }
  }

  /** The Agent SDK session is the warm thread: one process, one `send` per task; there is nothing more to start. */
  async warmUp(): Promise<{ warm: boolean; detail: string }> {
    return { warm: this.ready && this.session !== undefined, detail: this.ready ? `${this.readyDetail}; one session reused across tasks` : this.readyDetail };
  }

  private rememberedAt = 0;

  private probeFile(): string | undefined {
    return this.opts.stateDir ? `${this.opts.stateDir}/claude-brain-probe.json` : undefined;
  }

  private rememberedFailure(): string | undefined {
    const file = this.probeFile();
    if (!file) return undefined;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { at: number; detail: string };
      if (Date.now() - j.at > (this.opts.probeMemoryMs ?? 30 * 60_000)) return undefined;
      this.rememberedAt = j.at;
      return j.detail;
    } catch {
      return undefined;
    }
  }

  private rememberFailure(detail: string): void {
    const file = this.probeFile();
    if (!file) return;
    try {
      writeFileSync(file, JSON.stringify({ at: Date.now(), detail }));
    } catch {
      // cosmetic
    }
  }

  private forgetFailure(): void {
    const file = this.probeFile();
    if (!file) return;
    try {
      rmSync(file, { force: true });
    } catch {
      // cosmetic
    }
  }

  private probeTurn(session: ClaudeSession, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, detail: `Claude Code did not answer a probe within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      const onResult = (msg: { is_error?: boolean; result?: string }): void => {
        cleanup();
        resolve(msg.is_error ? { ok: false, detail: msg.result ?? "probe turn failed" } : { ok: true, detail: "ok" });
      };
      const onError = (e: Error): void => {
        cleanup();
        resolve({ ok: false, detail: e.message });
      };
      const onClosed = (): void => {
        cleanup();
        resolve({ ok: false, detail: "Claude Code session closed during the probe" });
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        session.off("result", onResult);
        session.off("error", onError);
        session.off("closed", onClosed);
      };
      session.on("result", onResult);
      session.on("error", onError);
      session.on("closed", onClosed);
      try {
        session.send("Reply with exactly: ok");
      } catch (e) {
        cleanup();
        resolve({ ok: false, detail: (e as Error).message });
      }
    });
  }

  private async permission(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    if (toolName.startsWith("mcp__jarhead__")) return { behavior: "allow" };
    if (toolName === "TodoWrite") return { behavior: "allow" };
    // The SDK's own Read/Glob/Grep/WebFetch/WebSearch would bypass classifyPath and
    // classifyUrl (a Read of ~/.jarhead/env, a WebFetch of 10.0.0.1). Every read goes
    // through the jarhead tools so the secret stores and private hosts stay gated.
    const redirect: Record<string, string> = { Read: "read_file", Glob: "list_dir or search_files", Grep: "search_files", LS: "list_dir", WebFetch: "web_fetch", WebSearch: "web_search", Edit: "edit_file", Write: "write_file", MultiEdit: "edit_file", NotebookEdit: "edit_file" };
    if (redirect[toolName]) return { behavior: "deny", message: `${toolName} is not available to the desktop brain; use the jarhead tool ${redirect[toolName]} so the path and URL gates apply` };
    if (toolName === "Bash") {
      // Route shell through the same policy as run_shell so the confirmation
      // handshake is one mechanism, not two.
      const command = String(input["command"] ?? "");
      const outcome = await this.opts.runner.run("run_shell", { command });
      if (outcome.result.kind === "text") return { behavior: "deny", message: `already ran via Jarhead's run_shell; output:\n${outcome.result.text.slice(0, 4000)}` };
      if (outcome.result.kind === "needs-confirmation") return { behavior: "deny", message: outcome.result.question };
      return { behavior: "deny", message: outcome.result.kind === "error" ? outcome.result.message : "denied" };
    }
    return { behavior: "deny", message: `${toolName} is not available to the desktop brain; use the jarhead tools` };
  }

  private async callTool(name: string, args: unknown): Promise<McpResult> {
    this.current?.sink.thinking(progressLine(name, args));
    const outcome = await this.opts.runner.run(name, args);
    const r = outcome.result;
    switch (r.kind) {
      case "image":
        return { content: [{ type: "image", data: r.pngBase64, mimeType: "image/png" }, { type: "text", text: `${r.width}x${r.height} px${r.note ? `; ${r.note}` : ""}` }] };
      case "text":
        return { content: [{ type: "text", text: r.text }] };
      case "needs-confirmation":
        return { content: [{ type: "text", text: `needs_confirmation: ${r.question}` }] };
      case "error":
        return { content: [{ type: "text", text: `error: ${r.message}` }], isError: true };
    }
  }

  handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const session = this.session;
    if (!session || !this.ready) return Promise.resolve({ status: "failed", error: this.readyDetail });
    if (this.current) return Promise.resolve({ status: "failed", error: "already handling a task" });
    this.opts.runner.attach(sink, task);
    return new Promise<BrainResult>((resolve) => {
      this.current = { task, sink, resolve };
      task.signal.addEventListener("abort", () => {
        if (this.current?.task === task) {
          void session.interrupt();
          this.current = undefined;
          this.opts.runner.attach(undefined);
          resolve({ status: "cancelled" });
        }
      }, { once: true });
      // The same words as the API brains; the circled regions ride as image blocks of
      // this user turn (ClaudeSession builds Anthropic-shaped content), and the prompt
      // says what each one is.
      const attachments = loadAttachments(task);
      const prompt = delegationPrompt(task, undefined, attachments);
      try {
        session.send(prompt, attachments.map((a) => ({ pngBase64: a.pngBase64 })));
      } catch (e) {
        this.current = undefined;
        resolve({ status: "failed", error: (e as Error).message });
      }
    });
  }

  async cancel(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    await this.session?.interrupt();
    cur.resolve({ status: "cancelled" });
  }

  async stop(): Promise<void> {
    await this.cancel();
    await this.session?.close();
    this.session = undefined;
    this.ready = false;
  }
}

/** Build the in-process MCP server with the real Agent SDK. */
async function defaultMcpFactory(specs: readonly ToolSpec[], call: (name: string, args: unknown) => Promise<McpResult>): Promise<Record<string, unknown>> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
    createSdkMcpServer: (o: { name: string; version?: string; instructions?: string; tools: unknown[] }) => unknown;
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<McpResult>) => unknown;
  };
  const tools = specs.map((spec) => sdk.tool(spec.name, spec.description, zodShape(spec), (args) => call(spec.name, args)));
  return sdk.createSdkMcpServer({ name: "jarhead", version: "2.0.0", instructions: "Jarhead's eyes, hands, and agents on Kevin's Mac.", tools }) as Record<string, unknown>;
}

/** Our tool schemas use a small vocabulary; map it to zod for the SDK. */
export function zodShape(spec: ToolSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(spec.parameters.required ?? []);
  for (const [key, raw] of Object.entries(spec.parameters.properties)) {
    const prop = raw as { type?: string | string[]; enum?: string[]; items?: { type?: string }; description?: string; minimum?: number; maximum?: number };
    let t: z.ZodTypeAny;
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    if (prop.enum) t = z.enum(prop.enum as [string, ...string[]]);
    else if (type === "number" || type === "integer") t = z.number();
    else if (type === "boolean") t = z.boolean();
    // Arrays of numbers (coordinates), of [x, y] pairs (show_stroke), or of strings.
    else if (type === "array") t = z.array(prop.items?.type === "number" ? z.number() : prop.items?.type === "array" ? z.array(z.number()) : z.string());
    else if (Array.isArray(prop.type)) t = z.union([z.string(), z.number()]);
    // A nested object (thread_start's `budget`): its own shape, extra keys allowed — the bridge and the
    // Responses/Anthropic brains pass the JSON schema through untouched; only this SDK path needs zod.
    else if (type === "object") {
      const nested = raw as { properties?: Record<string, unknown>; required?: readonly string[] };
      t = z.object(zodShape({ name: `${spec.name}.${key}`, description: "", parameters: { type: "object", properties: nested.properties ?? {}, ...(nested.required ? { required: nested.required } : {}) } })).passthrough();
    }
    else t = z.string();
    if (prop.description) t = t.describe(prop.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}
