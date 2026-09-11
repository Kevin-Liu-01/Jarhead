import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, NotFoundError, PermissionDeniedError, RateLimitError } from "@anthropic-ai/sdk";
import { logger } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import type { Effort } from "@jarhead/protocol";
import type { Brain, BrainAttachment, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { brainSystemPrompt } from "./brain.ts";
import { ALL_TOOL_SPECS, type ToolSpec } from "./tools.ts";
import { progressLine } from "./responses.ts";
import { resultText, type ToolRunner } from "./runner.ts";
import { attachmentsPreamble, attachmentsRecap, loadAttachments } from "./attachments.ts";

/**
 * The Anthropic brain: the Messages API with ANTHROPIC_API_KEY.
 *
 * Same tools, same runner, same sink as the other brains; only the transport
 * differs. Each delegation is one tool-use loop: the task goes in as the user
 * turn, every `tool_use` block runs through the ToolRunner, results (screenshots
 * as base64 image blocks) go back as `tool_result` blocks, and the loop ends on
 * the first turn without tool calls. The final text is the spoken answer.
 *
 * Unlike the Claude Code brain there is no persistent session: the last few
 * request/answer pairs are carried as plain text so a "yes" to a pending
 * confirmation still knows what it is confirming.
 */

const log = logger("brain.anthropic");

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

export interface AnthropicBrainOptions {
  readonly runner: ToolRunner;
  /** ANTHROPIC_API_KEY; without it the brain reports not ready. */
  readonly apiKey: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
  /** For gateways and tests; the SDK appends /v1/... itself. */
  readonly baseUrl?: string | undefined;
  readonly userName?: string | undefined;
  /** Tool calls per delegation before the brain gives up (default 40). */
  readonly maxSteps?: number | undefined;
  /** Wall clock per delegation (default 5 min). */
  readonly maxWallMs?: number | undefined;
  /** Per request (default 3 min), never more than what is left of the wall clock. */
  readonly requestTimeoutMs?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly probeTimeoutMs?: number | undefined;
  /** Extra probe attempts after a connection error or 5xx (default 1); the SDK never retries 401/403/404. */
  readonly probeRetries?: number | undefined;
  /** Request/answer pairs carried into the next delegation (default 3). */
  readonly historyTurns?: number | undefined;
  readonly maxRetries?: number | undefined;
}

/**
 * Settings.brainModel can still hold another brain's model after a switch in
 * Settings; an OpenAI id would only 404 here, so those fall back to the default.
 * Anything else (a Claude id, a gateway's alias) goes through untouched.
 */
export function resolveAnthropicModel(model: string | undefined): string {
  const m = model?.trim();
  if (!m) return DEFAULT_ANTHROPIC_MODEL;
  if (/^(gpt-|o\d|chatgpt|gemini|llama|mistral|qwen|deepseek)/i.test(m)) return DEFAULT_ANTHROPIC_MODEL;
  return m;
}

/** `claude-opus-4-8` → 4.8, `claude-opus-5` → 5.0, `claude-3-5-sonnet-…` → 3.5; undefined for non-Claude ids. */
export function claudeGeneration(model: string): { major: number; minor: number } | undefined {
  const m = /^claude-(?:[a-z]+-)*(\d+)(?:-(\d+))?/i.exec(model);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: m[2] !== undefined ? Number(m[2]) : 0 };
}

/**
 * Claude 4.6 and later take adaptive thinking and an effort level; `budget_tokens`
 * is gone (a 400 on 4.7+), so older ids get no thinking block at all. Non-Claude
 * ids (a gateway alias) get neither and are passed through as-is.
 */
export function anthropicReasoning(model: string, effort: Effort | undefined): { thinking?: Anthropic.ThinkingConfigParam; effort?: NonNullable<Anthropic.OutputConfig["effort"]> } {
  const gen = claudeGeneration(model);
  if (!gen) return {};
  const adaptive = gen.major >= 5 || (gen.major === 4 && gen.minor >= 6);
  if (!adaptive) return {};
  // xhigh arrived with 4.7.
  const e = effort === "xhigh" && gen.major === 4 && gen.minor === 6 ? "high" : effort;
  return { thinking: { type: "adaptive" }, ...(e ? { effort: e } : {}) };
}

export function toAnthropicTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: {
      type: "object",
      properties: spec.parameters.properties,
      ...(spec.parameters.required ? { required: [...spec.parameters.required] } : {}),
    },
  };
}

/**
 * The user turn every brain sends. Attached images (circled regions) are named
 * here, numbered as `attachments` lists them; pass the ones the transport really
 * sends (the loaded or existing files), not the task's list, so the model is never
 * told about an image it does not get. Each transport carries the pixels its own way.
 */
export function delegationPrompt(task: BrainTask, userName = "Kevin", attachments: readonly BrainAttachment[] | undefined = task.attachments): string {
  return promptParts(task, userName, attachmentsPreamble(attachments)).join("\n\n");
}

/**
 * The same turn as it is kept in history, or sent where images cannot go: the
 * words and where Kevin circled, without claiming pixels that are not there.
 */
export function historyPrompt(task: BrainTask, userName = "Kevin"): string {
  return promptParts(task, userName, attachmentsRecap(task.attachments)).join("\n\n");
}

function promptParts(task: BrainTask, userName: string, regions: string): string[] {
  return [
    task.confirmation ? `${userName} just said YES to the pending confirmation. Do that action now, then report.` : "",
    `${userName} said: "${task.request}"`,
    regions,
    task.dialogue ? `Recent conversation:\n${task.dialogue}` : "",
  ].filter(Boolean);
}

function toolResultBlock(toolUseId: string, r: ToolResult): Anthropic.ToolResultBlockParam {
  switch (r.kind) {
    case "image":
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: r.pngBase64 } },
          { type: "text", text: `${r.width}x${r.height} px${r.note ? `; ${r.note}` : ""}. Coordinates for clicks are pixels of this image.` },
        ],
      };
    case "error":
      return { type: "tool_result", tool_use_id: toolUseId, content: resultText(r), is_error: true };
    default:
      return { type: "tool_result", tool_use_id: toolUseId, content: resultText(r) };
  }
}

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export class AnthropicBrain implements Brain {
  readonly kind = "anthropic-api";
  readonly model: string;
  private client: Anthropic | undefined;
  private ready = false;
  private readyDetail = "not started";
  private current: { task: BrainTask; abort: AbortController } | undefined;
  private history: Anthropic.MessageParam[] = [];
  private readonly tools: Anthropic.Tool[] = ALL_TOOL_SPECS.map(toAnthropicTool);
  private readonly reasoning: ReturnType<typeof anthropicReasoning>;

  constructor(private readonly opts: AnthropicBrainOptions) {
    this.model = resolveAnthropicModel(opts.model);
    this.reasoning = anthropicReasoning(this.model, opts.effort);
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.client) return { ready: this.ready, detail: this.readyDetail };
    if (!this.opts.apiKey) {
      this.readyDetail = "ANTHROPIC_API_KEY is not set; add it in Settings or ~/.jarhead/env";
      return { ready: false, detail: this.readyDetail };
    }
    const client = new Anthropic({
      apiKey: this.opts.apiKey,
      ...(this.opts.baseUrl ? { baseURL: this.opts.baseUrl } : {}),
      maxRetries: this.opts.maxRetries ?? 2,
    });
    this.client = client;
    try {
      // One cheap, read-only request proves the key and the model before Kevin speaks.
      const info = await client.models.retrieve(this.model, undefined, { timeout: this.opts.probeTimeoutMs ?? 8000, maxRetries: Math.max(0, this.opts.probeRetries ?? 1) });
      this.ready = true;
      const flags = [this.reasoning.thinking ? "adaptive thinking" : "", this.reasoning.effort ? `effort ${this.reasoning.effort}` : ""].filter(Boolean);
      this.readyDetail = `Anthropic Messages API (${info.display_name || this.model}${flags.length ? `, ${flags.join(", ")}` : ""})`;
    } catch (e) {
      this.ready = false;
      this.readyDetail = this.describeProbeError(e);
      log.warn(`probe failed: ${this.readyDetail}`);
    }
    return { ready: this.ready, detail: this.readyDetail };
  }

  private describeProbeError(e: unknown): string {
    if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) return `ANTHROPIC_API_KEY is rejected by the API (${e.status})`;
    if (e instanceof NotFoundError) return `model ${this.model} is not available to this key`;
    if (e instanceof APIConnectionError) return `could not reach the Anthropic API: ${e.message}`;
    if (e instanceof APIError) return `Anthropic API error${e.status ? ` ${e.status}` : ""}: ${e.message}`;
    return (e as Error).message;
  }

  private params(messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: this.opts.maxTokens ?? 16000,
      system: brainSystemPrompt(this.opts.userName),
      tools: this.tools,
      // Desktop actions depend on each other (click, then look); one call per turn.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      ...(this.reasoning.thinking ? { thinking: this.reasoning.thinking } : {}),
      ...(this.reasoning.effort ? { output_config: { effort: this.reasoning.effort } } : {}),
      messages,
    };
  }

  async handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const client = this.client;
    if (!client || !this.ready) return { status: "failed", error: this.readyDetail };
    if (this.current) return { status: "failed", error: "already handling a task" };
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    task.signal.addEventListener("abort", onAbort, { once: true });
    if (task.signal.aborted) abort.abort();
    this.current = { task, abort };
    this.opts.runner.attach(sink);
    try {
      return await this.loop(client, task, sink, abort.signal);
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      // A cancelled loop may outlive its task (a tool call in flight); never
      // clobber the runner's sink once a newer task owns it.
      if (this.current?.task === task) {
        this.current = undefined;
        this.opts.runner.attach(undefined);
      } else if (!this.current) {
        this.opts.runner.attach(undefined);
      }
    }
  }

  private async loop(client: Anthropic, task: BrainTask, sink: BrainSink, signal: AbortSignal): Promise<BrainResult> {
    // Circled regions go in as base64 image blocks ahead of the words; the prompt
    // names exactly the ones that loaded.
    const attachments = loadAttachments(task);
    const prompt = delegationPrompt(task, this.opts.userName, attachments);
    const content: Anthropic.MessageParam["content"] = attachments.length
      ? [...attachments.map((a): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: "image/png", data: a.pngBase64 } })), { type: "text", text: prompt }]
      : prompt;
    const messages: Anthropic.MessageParam[] = [...this.history, { role: "user", content }];
    const started = Date.now();
    const maxSteps = this.opts.maxSteps ?? 40;
    const maxWallMs = this.opts.maxWallMs ?? 5 * 60_000;
    let steps = 0;

    for (;;) {
      if (signal.aborted) return { status: "cancelled" };
      const remaining = maxWallMs - (Date.now() - started);
      if (remaining <= 0) return { status: "failed", error: `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds` };

      // The SDK's default is 10 minutes per request; a stalled call must not
      // outlive the delegation's own budget. Near the end, retries are off too.
      const timeout = Math.max(1000, Math.min(this.opts.requestTimeoutMs ?? 180_000, remaining));
      const maxRetries = remaining > 2 * timeout ? this.opts.maxRetries ?? 2 : 0;
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(this.params(messages), { signal, timeout, maxRetries });
      } catch (e) {
        return this.apiFailure(e, signal, timeout);
      }
      // Append the whole turn, thinking blocks included: the API needs them back unchanged.
      messages.push({ role: "assistant", content: response.content });
      const text = textOf(response.content);
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      if (response.stop_reason === "pause_turn") continue;

      // A turn cut off mid tool call cannot be trusted: the input may be partial
      // and any preamble ("Let me click…") is not an answer.
      if (toolUses.length > 0 && response.stop_reason === "max_tokens") {
        return { status: "failed", error: "the answer was cut off by the token limit before the tool call could run" };
      }

      if (toolUses.length > 0) {
        if (text) sink.step({ kind: "note", text: text.slice(0, 1000) });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          if (signal.aborted) return { status: "cancelled" };
          if (++steps > maxSteps) return { status: "failed", error: `I stopped after ${maxSteps} tool calls without finishing` };
          sink.thinking(progressLine(use.name, use.input));
          const outcome = await this.opts.runner.run(use.name, use.input);
          results.push(toolResultBlock(use.id, outcome.result));
        }
        // All results of a turn go back in one user message.
        messages.push({ role: "user", content: results });
        continue;
      }

      switch (response.stop_reason) {
        case "refusal": {
          const why = response.stop_details?.explanation;
          return { status: "failed", error: `the model declined${why ? `: ${why}` : ""}` };
        }
        case "max_tokens":
          if (text) break;
          return { status: "failed", error: "the answer was cut off by the token limit" };
        case "model_context_window_exceeded":
          return { status: "failed", error: "the task no longer fits the model's context; ask again in smaller steps" };
        default:
          break;
      }
      const summary = text || "done.";
      // History keeps the words and the regions, not the pixels — so it must not say "attached image".
      this.remember(historyPrompt(task, this.opts.userName), summary);
      log.debug(`done in ${steps} step(s), ${Date.now() - started}ms`);
      return { status: "done", summary };
    }
  }

  private apiFailure(e: unknown, signal: AbortSignal, timeoutMs: number): BrainResult {
    if (signal.aborted || e instanceof APIUserAbortError) return { status: "cancelled" };
    if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) {
      this.ready = false;
      this.readyDetail = `ANTHROPIC_API_KEY is rejected by the API (${e.status})`;
      return { status: "failed", error: this.readyDetail };
    }
    if (e instanceof RateLimitError) return { status: "failed", error: "the Anthropic API is rate limiting us; try again in a moment" };
    if (e instanceof APIConnectionTimeoutError) return { status: "failed", error: `the Anthropic API did not answer within ${Math.round(timeoutMs / 1000)} seconds` };
    if (e instanceof APIConnectionError) return { status: "failed", error: `could not reach the Anthropic API: ${e.message}` };
    if (e instanceof APIError) return { status: "failed", error: `Anthropic API error${e.status ? ` ${e.status}` : ""}: ${e.message}` };
    return { status: "failed", error: (e as Error).message };
  }

  /** Keep the last few exchanges as plain text; tool calls and screenshots are not worth their tokens twice. */
  private remember(prompt: string, answer: string): void {
    const turns = this.opts.historyTurns ?? 3;
    if (turns <= 0) return;
    this.history.push({ role: "user", content: prompt }, { role: "assistant", content: answer });
    if (this.history.length > turns * 2) this.history.splice(0, this.history.length - turns * 2);
  }

  async cancel(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    cur.abort.abort();
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.client = undefined;
    this.ready = false;
    this.readyDetail = "stopped";
    this.history = [];
  }
}
