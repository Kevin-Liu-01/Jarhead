import { logger } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import type { Brain, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { brainSystemPrompt } from "./brain.ts";
import { ALL_TOOL_SPECS, type ToolSpec } from "./tools.ts";
import { progressLine } from "./responses.ts";
import { resultText, type ToolRunner } from "./runner.ts";
import { delegationPrompt, historyPrompt } from "./anthropic.ts";
import { loadAttachments } from "./attachments.ts";

/**
 * The OpenAI-compatible brain: Chat Completions with function tools over plain
 * fetch, against whatever server Kevin points it at — OpenAI, OpenRouter,
 * Ollama, LM Studio, vLLM. No SDK, because the servers differ in small ways
 * and a thin client is easier to keep honest than a thick one.
 *
 * Screenshots are the one place servers diverge: OpenAI and OpenRouter accept
 * `image_url` data URLs, most local servers do not. Images are therefore behind
 * a capability flag that defaults to on for those two hosts and off elsewhere,
 * where the model is told to use the text tools instead.
 */

const log = logger("brain.compatible");

export interface CompatibleCapabilities {
  /** The server accepts `image_url` content parts; otherwise screenshots become text. */
  readonly images: boolean;
}

export interface OpenAICompatibleBrainOptions {
  readonly runner: ToolRunner;
  /** Server root, with or without a trailing /v1. */
  readonly baseUrl: string | undefined;
  /** Bearer token; undefined sends no Authorization header (local servers). */
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
  readonly capabilities?: Partial<CompatibleCapabilities> | undefined;
  /** Test seam. */
  readonly fetch?: typeof fetch | undefined;
  readonly userName?: string | undefined;
  /** Tool calls per delegation before the brain gives up (default 40). */
  readonly maxSteps?: number | undefined;
  /** Wall clock per delegation (default 5 min). */
  readonly maxWallMs?: number | undefined;
  /** Per request (default 2 min; local models can be slow). */
  readonly requestTimeoutMs?: number | undefined;
  readonly probeTimeoutMs?: number | undefined;
  /** Extra probe attempts after a connection error or 5xx (default 1); 401/403/404 never retry. */
  readonly probeRetries?: number | undefined;
  readonly probeRetryDelayMs?: number | undefined;
  /** Retries per request on 429/502/503/529, honouring Retry-After (default 2). */
  readonly requestRetries?: number | undefined;
  /** Longest Retry-After the brain will honour before giving up (default 8 s). */
  readonly maxRetryAfterMs?: number | undefined;
  /** Request/answer pairs carried into the next delegation (default 3). */
  readonly historyTurns?: number | undefined;
}

// Chat Completions wire shapes: only what this brain sends and reads.
type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "high" | "low" | "auto" } };
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: ToolSpec["parameters"] };
}
/** A tool call as servers actually send it: ids can be missing, arguments may already be parsed. */
type RawToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: unknown } };
interface ChatCompletion {
  choices?: Array<{
    message?: { role?: string; content?: string | null | Array<{ type?: string; text?: string }>; tool_calls?: RawToolCall[] | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string } | string;
}

/** `https://host/`, `https://host/v1`, `https://host/v1/` → `https://host` (endpoints add /v1 themselves). */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(u)) u = u.slice(0, -3).replace(/\/+$/, "");
  return u;
}

/** Only the hosts known to take images get them; everything else is text-only until proven otherwise. */
export function detectCapabilities(baseUrl: string): CompatibleCapabilities {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return { images: host === "api.openai.com" || host.endsWith(".openai.com") || host === "openrouter.ai" || host.endsWith(".openrouter.ai") };
  } catch {
    return { images: false };
  }
}

function hostOf(baseUrl: string): { protocol: string; hostname: string } | undefined {
  try {
    const u = new URL(baseUrl);
    return { protocol: u.protocol, hostname: u.hostname.toLowerCase().replace(/^\[|\]$/g, "") };
  } catch {
    return undefined;
  }
}

function isOpenAIHost(hostname: string): boolean {
  return hostname === "api.openai.com" || hostname.endsWith(".openai.com");
}

/** localhost, 127/8, ::1, and the *.localhost names. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === "0.0.0.0";
}

/** RFC 1918 / link-local / ULA / .local: the same LAN, not the internet. */
export function isPrivateHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".lan") || hostname.endsWith(".home.arpa")) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname) || /^fe80:/i.test(hostname)) return true;
  return false;
}

export interface CompatibleKeyChoice {
  readonly apiKey: string | undefined;
  /** Why a key was withheld or is being sent somewhere worth a warning; for a problem(). */
  readonly warning?: string;
}

/**
 * Which bearer token, if any, goes to the configured server. Only a key Kevin
 * set for this brain (JARHEAD_BRAIN_API_KEY) is sent to an arbitrary host; his
 * OPENAI_API_KEY is only ever sent to OpenAI itself. Loopback servers (Ollama,
 * LM Studio) get whatever he set; a key over plain http to a LAN host is sent
 * with a warning, and never to a public host.
 */
export function resolveCompatibleApiKey(input: { baseUrl: string | undefined; explicitKey: string | undefined; openaiKey: string | undefined }): CompatibleKeyChoice {
  const base = input.baseUrl?.trim();
  if (!base) return { apiKey: undefined };
  const target = hostOf(normalizeBaseUrl(base));
  if (!target) return { apiKey: undefined };
  const explicit = input.explicitKey?.trim() || undefined;
  const openai = input.openaiKey?.trim() || undefined;
  const key = isOpenAIHost(target.hostname) ? explicit ?? openai : explicit;
  if (!key) return { apiKey: undefined };
  if (target.protocol === "http:" && !isLoopbackHost(target.hostname)) {
    if (isPrivateHost(target.hostname)) {
      return { apiKey: key, warning: `sending the brain API key over plain http to ${target.hostname}; use https if that server is reachable from outside your network` };
    }
    return { apiKey: undefined, warning: `refusing to send an API key over plain http to ${target.hostname}; use an https URL (or run the server locally)` };
  }
  return { apiKey: key };
}

export function toChatTool(spec: ToolSpec): ChatTool {
  return { type: "function", function: { name: spec.name, description: spec.description, parameters: spec.parameters } };
}

/** Make every call addressable, whatever the server left out. */
function normalizeToolCalls(raw: RawToolCall[] | null | undefined): Array<ChatToolCall & { args: unknown }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((call, i) => {
    const name = call.function?.name;
    if (!name) return [];
    const rawArgs = call.function?.arguments;
    let args: unknown = {};
    let argumentsText = "{}";
    if (typeof rawArgs === "string") {
      argumentsText = rawArgs || "{}";
      try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs;
      argumentsText = JSON.stringify(rawArgs);
    }
    return [{ id: call.id || `call_${i + 1}`, type: "function" as const, function: { name, arguments: argumentsText }, args }];
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((p: { text?: string }) => p.text ?? "").join("").trim();
  return "";
}

function errorMessage(body: unknown, status: number): string {
  const b = body as ChatCompletion | undefined;
  const e = b?.error;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof e.message === "string") return e.message;
  return `HTTP ${status}`;
}

export class OpenAICompatibleBrain implements Brain {
  readonly kind = "openai-compatible";
  readonly baseUrl: string | undefined;
  readonly model: string | undefined;
  readonly capabilities: CompatibleCapabilities;
  private ready = false;
  private readyDetail = "not started";
  private started = false;
  private current: { task: BrainTask; abort: AbortController } | undefined;
  private history: ChatMessage[] = [];
  private readonly tools: ChatTool[] = ALL_TOOL_SPECS.map(toChatTool);
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleBrainOptions) {
    this.baseUrl = opts.baseUrl?.trim() ? normalizeBaseUrl(opts.baseUrl) : undefined;
    this.model = opts.model?.trim() || undefined;
    this.capabilities = { ...(this.baseUrl ? detectCapabilities(this.baseUrl) : { images: false }), ...(opts.capabilities ?? {}) };
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json",
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    if (this.started) return { ready: this.ready, detail: this.readyDetail };
    this.started = true;
    if (!this.baseUrl) {
      this.readyDetail = "no server URL configured; set the brain server in Settings or JARHEAD_BRAIN_BASE_URL";
      return { ready: false, detail: this.readyDetail };
    }
    if (!this.model) {
      this.readyDetail = "no model configured; set the brain model in Settings";
      return { ready: false, detail: this.readyDetail };
    }
    const host = (() => {
      try {
        return new URL(this.baseUrl).host;
      } catch {
        return this.baseUrl;
      }
    })();
    // A local server still starting or a gateway hiccup should not pin the
    // fallback for the whole session: connection errors and 5xx get one more go.
    const retries = Math.max(0, this.opts.probeRetries ?? 1);
    for (let attempt = 0; ; attempt++) {
      const verdict = await this.probeOnce(host);
      if (verdict.kind === "ready") {
        this.ready = true;
        this.readyDetail = verdict.detail;
        return { ready: true, detail: this.readyDetail };
      }
      this.readyDetail = verdict.detail;
      if (verdict.kind === "final" || attempt >= retries) {
        if (verdict.kind === "transient") log.warn(`probe failed: ${this.readyDetail}`);
        return { ready: false, detail: this.readyDetail };
      }
      log.info(`probe failed (${this.readyDetail}); retrying`);
      await sleep(this.opts.probeRetryDelayMs ?? 1000);
    }
  }

  /** One GET /v1/models. `final` verdicts (auth, missing model) are not worth a retry; `transient` ones are. */
  private async probeOnce(host: string): Promise<{ kind: "ready" | "final" | "transient"; detail: string }> {
    const timeoutMs = this.opts.probeTimeoutMs ?? 5000;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { method: "GET", headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 401 || res.status === 403) {
        return { kind: "final", detail: this.opts.apiKey ? `${host} rejected the API key (${res.status})` : `${host} requires an API key (${res.status}); set JARHEAD_BRAIN_API_KEY` };
      }
      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        return { kind: res.status >= 500 || res.status === 429 ? "transient" : "final", detail: `${host}/v1/models answered ${res.status}: ${errorMessage(body, res.status)}` };
      }
      let ids: string[] | undefined;
      try {
        const json = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> };
        const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : undefined;
        ids = list?.map((m) => String(m.id ?? (m as { name?: string }).name ?? "")).filter(Boolean);
      } catch {
        ids = undefined;
      }
      const mode = this.capabilities.images ? "images" : "text-only";
      if (ids && ids.length > 0 && !ids.some((id) => modelMatches(id, this.model!))) {
        // A definite list without our model means the first request would fail; better to say so now.
        const shown = ids.slice(0, 8).join(", ");
        return { kind: "final", detail: `${host} does not offer ${this.model}; it lists ${shown}${ids.length > 8 ? ` and ${ids.length - 8} more` : ""}` };
      }
      return { kind: "ready", detail: `OpenAI-compatible ${host} (${this.model}, ${mode}${ids === undefined ? ", models not listed" : ids.length === 0 ? ", empty model list" : ""})` };
    } catch (e) {
      const err = e as Error;
      return { kind: "transient", detail: err.name === "TimeoutError" ? `${host} did not answer /v1/models within ${Math.round(timeoutMs / 1000)}s` : `could not reach ${host}: ${err.message}` };
    }
  }

  async handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    if (!this.ready || !this.baseUrl || !this.model) return { status: "failed", error: this.readyDetail };
    if (this.current) return { status: "failed", error: "already handling a task" };
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    task.signal.addEventListener("abort", onAbort, { once: true });
    if (task.signal.aborted) abort.abort();
    this.current = { task, abort };
    this.opts.runner.attach(sink);
    try {
      return await this.loop(task, sink, abort.signal, this.model);
    } finally {
      task.signal.removeEventListener("abort", onAbort);
      if (this.current?.task === task) {
        this.current = undefined;
        this.opts.runner.attach(undefined);
      } else if (!this.current) {
        this.opts.runner.attach(undefined);
      }
    }
  }

  private async loop(task: BrainTask, sink: BrainSink, signal: AbortSignal, model: string): Promise<BrainResult> {
    const messages: ChatMessage[] = [{ role: "system", content: brainSystemPrompt(this.opts.userName) }, ...this.history, { role: "user", content: this.userContent(task) }];
    const started = Date.now();
    const maxSteps = this.opts.maxSteps ?? 40;
    const maxWallMs = this.opts.maxWallMs ?? 5 * 60_000;
    let steps = 0;

    for (;;) {
      if (signal.aborted) return { status: "cancelled" };
      if (Date.now() - started > maxWallMs) return { status: "failed", error: `I ran out of time after ${Math.round(maxWallMs / 1000)} seconds` };

      const completion = await this.complete(model, messages, signal, started + maxWallMs);
      if ("failure" in completion) return completion.failure;
      const choice = completion.body.choices?.[0];
      const message = choice?.message;
      if (!message) return { status: "failed", error: "the server returned no choices" };

      const calls = normalizeToolCalls(message.tool_calls);
      const text = contentText(message.content);
      messages.push({ role: "assistant", content: typeof message.content === "string" ? message.content : text || null, ...(calls.length ? { tool_calls: calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })) } : {}) });

      if (calls.length === 0) {
        if (choice.finish_reason === "length" && !text) return { status: "failed", error: "the answer was cut off by the token limit" };
        if (choice.finish_reason === "content_filter") return { status: "failed", error: "the server's content filter declined" };
        const summary = text || "done.";
        // History keeps the words and the regions, not the pixels — so it must not say "attached image".
        this.remember(historyPrompt(task, this.opts.userName), summary);
        log.debug(`done in ${steps} step(s), ${Date.now() - started}ms`);
        return { status: "done", summary };
      }

      if (text) sink.step({ kind: "note", text: text.slice(0, 1000) });
      const images: Array<{ name: string; result: Extract<ToolResult, { kind: "image" }> }> = [];
      for (const call of calls) {
        if (signal.aborted) return { status: "cancelled" };
        if (++steps > maxSteps) return { status: "failed", error: `I stopped after ${maxSteps} tool calls without finishing` };
        sink.thinking(progressLine(call.function.name, call.args));
        const outcome = await this.opts.runner.run(call.function.name, call.args);
        const r = outcome.result;
        messages.push({ role: "tool", tool_call_id: call.id, content: this.toolText(call.function.name, r) });
        if (r.kind === "image" && this.capabilities.images) images.push({ name: call.function.name, result: r });
      }
      if (images.length > 0) {
        // Tool messages are text-only in Chat Completions; the pixels ride in the next user turn.
        messages.push({
          role: "user",
          content: images.flatMap(({ name, result }): ChatContentPart[] => [
            { type: "text", text: `Screenshot from ${name} (${result.width}x${result.height} px). Coordinates for clicks are pixels of this image.` },
            { type: "image_url", image_url: { url: `data:image/png;base64,${result.pngBase64}`, detail: "high" } },
          ]),
        });
      }
    }
  }

  /**
   * The first user turn: the words, plus the circled regions as image_url parts
   * where the server takes them. A text-only server gets the regions by their
   * coordinates alone, and the prompt does not call them attached images.
   */
  private userContent(task: BrainTask): string | ChatContentPart[] {
    const attachments = loadAttachments(task);
    if (attachments.length === 0) return delegationPrompt(task, this.opts.userName, []);
    if (!this.capabilities.images) {
      return `${historyPrompt(task, this.opts.userName)}\n\nThis server cannot receive images, so the circled region is known only by the coordinates above: zoom on it, or use element_at and read_focused_text, to learn what is there.`;
    }
    return [
      { type: "text", text: delegationPrompt(task, this.opts.userName, attachments) },
      ...attachments.flatMap((a): ChatContentPart[] => [
        { type: "text", text: a.note },
        { type: "image_url", image_url: { url: `data:image/png;base64,${a.pngBase64}`, detail: "high" } },
      ]),
    ];
  }

  private toolText(name: string, r: ToolResult): string {
    if (r.kind === "image" && !this.capabilities.images) {
      return `${name} took a ${r.width}x${r.height} px screenshot${r.note ? ` (${r.note})` : ""}, but this server cannot receive images. Use list_windows, frontmost_app, read_focused_text and element_at to learn what is on screen instead.`;
    }
    return resultText(r);
  }

  /**
   * One Chat Completions request, retried on 429/502/503/529 (a burst limit or a
   * gateway blip is not a reason to fail the task) as long as Retry-After and the
   * wall budget allow. Each attempt is bounded by the request timeout and the
   * time left before `deadline`.
   */
  private async complete(model: string, messages: ChatMessage[], signal: AbortSignal, deadline: number): Promise<{ body: ChatCompletion } | { failure: BrainResult }> {
    const retries = Math.max(0, this.opts.requestRetries ?? 2);
    const maxRetryAfter = this.opts.maxRetryAfterMs ?? 8000;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { failure: { status: "failed", error: "I ran out of time" } };
      const timeoutMs = Math.max(1000, Math.min(this.opts.requestTimeoutMs ?? 120_000, remaining));
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ model, messages, tools: this.tools, tool_choice: "auto" }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (e) {
        if (signal.aborted) return { failure: { status: "cancelled" } };
        const err = e as Error;
        if (err.name === "TimeoutError") return { failure: { status: "failed", error: `the server did not answer within ${Math.round(timeoutMs / 1000)} seconds` } };
        return { failure: { status: "failed", error: `could not reach the server: ${err.message}` } };
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (e) {
        if (signal.aborted) return { failure: { status: "cancelled" } };
        body = undefined;
        if (res.ok) return { failure: { status: "failed", error: `the server sent a non-JSON reply (${(e as Error).message})` } };
      }
      if (res.status === 401 || res.status === 403) {
        this.ready = false;
        this.readyDetail = `the server rejected the API key (${res.status})`;
        return { failure: { status: "failed", error: this.readyDetail } };
      }
      const transient = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 529;
      if (transient && attempt < retries) {
        const wait = retryAfterMs(res.headers, attempt);
        if (wait <= maxRetryAfter && Date.now() + wait < deadline) {
          log.info(`${res.status} from ${this.baseUrl}; retrying in ${wait}ms (${retries - attempt} left)`);
          const aborted = await sleep(wait, signal);
          if (aborted) return { failure: { status: "cancelled" } };
          continue;
        }
      }
      if (res.status === 429) return { failure: { status: "failed", error: "the server is rate limiting us; try again in a moment" } };
      if (!res.ok) return { failure: { status: "failed", error: `server error ${res.status}: ${errorMessage(body, res.status)}` } };
      return { body: (body ?? {}) as ChatCompletion };
    }
  }

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
    this.ready = false;
    this.readyDetail = "stopped";
    this.started = false; // a later start() probes again, like the Anthropic brain
    this.history = [];
  }
}

/** Retry-After in seconds or as an HTTP date, else 0.5 s, 1 s, 2 s… */
function retryAfterMs(headers: Headers, attempt: number): number {
  const ms = headers.get("retry-after-ms");
  if (ms && !Number.isNaN(Number(ms))) return Math.max(0, Number(ms));
  const h = headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(h);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return 500 * 2 ** attempt;
}

/** Resolves true if the signal fired first. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Ollama lists `llama3.1:latest` for a model configured as `llama3.1`. */
function modelMatches(listed: string, wanted: string): boolean {
  return listed === wanted || listed === `${wanted}:latest` || listed.split(":")[0] === wanted;
}
