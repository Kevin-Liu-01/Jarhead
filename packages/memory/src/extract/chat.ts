import type { Candidate, Decision, ExtractInput, Neighbour } from "../types.ts";
import { ExtractUnavailableError, type DecideContext, type Decider, type Extractor } from "./extractor.ts";
import { parseCandidates, parseDecision } from "./parse.ts";
import { DECIDE_INSTRUCTIONS, DECIDE_SCHEMA, DECIDE_SCHEMA_NAME, extractInstructions, EXTRACT_SCHEMA, EXTRACT_SCHEMA_NAME, renderDecideUser, renderExtractUser, stripBounds } from "./prompt.ts";
import { RulesDecider } from "./rules.ts";

/** A local model reads a whole closed conversation; a cold load and a 27B model at a few tokens a second want minutes, not the Responses extractor's 20 s. */
export const CHAT_EXTRACT_TIMEOUT_MS = 90_000;
/** The band decision sits inside a merge; past this the rules decider answers so a run never waits on a slow model. */
export const CHAT_DECIDE_TIMEOUT_MS = 8_000;
/** Chars of transcript per slice: a 32k+ window reads twice what a small one does. */
export const CHAT_MAX_CHARS_LARGE = 24_000;
export const CHAT_MAX_CHARS_SMALL = 12_000;
/** Room for the JSON alone: a model that does not think spends nothing before it. */
export const CHAT_MAX_TOKENS = 900;
/** A thinking model reasons before the JSON even when asked not to (gpt-oss ignores "none"): `max_tokens` maps to `num_predict` on /v1, so this is what keeps the reasoning from starving the answer. */
export const CHAT_MAX_TOKENS_THINKING = 4_096;

export interface ChatExtractorOptions {
  /** The server root ("http://127.0.0.1:11434"); /v1 is added here. */
  readonly baseUrl: string;
  /** The brain's model id, verbatim: memory uses the brain model. */
  readonly model: string;
  /** The model's trained window, when discovery knows it; sizes `maxChars`. */
  readonly contextLength?: number;
  /**
   * The target model carries Ollama's `thinking` capability: the request sends
   * `reasoning_effort: "none"` (Ollama maps it to think:false; the gpt-oss family
   * ignores booleans, so send "low" when the model id starts with `gpt-oss`) and
   * `max_tokens` is raised to 4096 so reasoning cannot starve the JSON. Without
   * it the body is the plain one: max_tokens 900, no reasoning_effort.
   */
  readonly thinking?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly extractTimeoutMs?: number;
  readonly decideTimeoutMs?: number;
  /** LM Studio's optional bearer (JARHEAD_BRAIN_API_KEY); Ollama wants none. */
  readonly apiKey?: string;
  /** What the transcript and the minted sentences call the user (release F1); default "Kevin". */
  readonly userName?: string;
}

interface ChatCompletion {
  readonly choices?: readonly { readonly message?: { readonly content?: string | null; readonly refusal?: string | null } }[];
  readonly error?: { readonly message?: string } | string;
}

const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
/** A block the model opened and never closed at the very start: everything after it is reasoning, nothing is content. */
const THINK_UNTERMINATED = /^\s*<think(?:ing)?>[\s\S]*$/i;
/** gpt-oss's harmony rendering leaking through a plain server: the analysis channel up to its end or the next channel. */
const HARMONY_ANALYSIS = /<\|channel\|>analysis<\|message\|>[\s\S]*?(?:<\|end\|>|(?=<\|start\|>)|$)/g;
const HARMONY_TOKENS = /<\|(?:start|end|channel|message|return|call)\|>(?:assistant|final)?/g;
const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

/**
 * The words a local thinking model puts around its JSON: `<think>…</think>`,
 * `<thinking>…</thinking>`, an unterminated leading `<think>`, and the harmony
 * analysis channel. The same shapes the brain strips from a spoken turn,
 * written here so this package does not depend on @jarhead/brain.
 */
export function stripThinking(content: string): string {
  if (THINK_UNTERMINATED.test(content) && !/<\/think(?:ing)?>/i.test(content)) return "";
  return content.replace(THINK_BLOCK, "").replace(HARMONY_ANALYSIS, "").replace(HARMONY_TOKENS, "").trim();
}

/** The JSON text inside optional ``` fences. */
function unfence(content: string): string {
  const m = FENCE.exec(content);
  return m?.[1] ?? content;
}

/**
 * Extraction and band decisions over a local model's Chat Completions
 * endpoint (Ollama, LM Studio, llama.cpp all serve /v1): the same prompts and
 * schemas as the Responses extractor, temperature 0, ≤ 900 tokens (4096 with
 * thinking turned off for a model that has it, since Ollama thinks by default
 * and would spend the budget before the JSON), strict json_schema. Item text
 * and the closed conversation go to the server root and nowhere else. A
 * server that 400s the json_schema shape is asked once more
 * in json_object mode with the schema written into the user text, and stays
 * there for the life of the process. Every failure is an
 * ExtractUnavailableError the service answers with the rules extractor; a
 * decision that fails or outlives `decideTimeoutMs` is the rules decision.
 */
export class ChatExtractor implements Extractor, Decider {
  readonly kind = "local" as const;
  readonly model: string;
  readonly baseUrl: string;
  private readonly contextLength: number | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly extractTimeoutMs: number;
  private readonly decideTimeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly thinking: boolean;
  private readonly userName: string | undefined;
  private readonly rules = new RulesDecider();
  /** True after a 400 on response_format json_schema: the schema rides in the user text from then on. */
  private jsonObjectOnly = false;

  constructor(opts: ChatExtractorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.model = opts.model;
    this.contextLength = opts.contextLength;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.extractTimeoutMs = opts.extractTimeoutMs ?? CHAT_EXTRACT_TIMEOUT_MS;
    this.decideTimeoutMs = opts.decideTimeoutMs ?? CHAT_DECIDE_TIMEOUT_MS;
    this.apiKey = opts.apiKey;
    this.thinking = opts.thinking ?? false;
    this.userName = opts.userName;
  }

  /** Ollama reads `reasoning_effort` on /v1 as `think`: "none" turns it off; gpt-oss knows only low/medium/high, so "low" is its floor. */
  private get reasoningEffort(): "none" | "low" {
    return /^gpt-oss/i.test(this.model) ? "low" : "none";
  }

  /** The service's per-slice transcript cap: 24 000 chars when the window is 32k or more, else 12 000. */
  get maxChars(): number {
    return this.contextLength !== undefined && this.contextLength >= 32_768 ? CHAT_MAX_CHARS_LARGE : CHAT_MAX_CHARS_SMALL;
  }

  async extract(input: ExtractInput, signal?: AbortSignal): Promise<Candidate[]> {
    const json = await this.call(extractInstructions(this.userName), renderExtractUser(input, this.userName), EXTRACT_SCHEMA_NAME, EXTRACT_SCHEMA, this.extractTimeoutMs, signal);
    return parseCandidates(json);
  }

  /** The band decision; a failure or a slow model means the rules decision, so a merge never waits on the network. */
  async decide(candidate: Candidate, neighbours: readonly Neighbour[], ctx: DecideContext): Promise<Decision> {
    try {
      const json = await this.call(DECIDE_INSTRUCTIONS, renderDecideUser(candidate, neighbours, ctx.now), DECIDE_SCHEMA_NAME, DECIDE_SCHEMA, this.decideTimeoutMs, ctx.signal);
      return parseDecision(json, neighbours);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      return this.rules.decide(candidate, neighbours, ctx);
    }
  }

  private body(instructions: string, user: string, name: string, schema: unknown): string {
    const messages = this.jsonObjectOnly
      ? [
          { role: "system", content: instructions },
          { role: "user", content: `${user}\n\nAnswer with one JSON object and nothing else, matching this schema exactly:\n${JSON.stringify(stripBounds(schema))}` },
        ]
      : [
          { role: "system", content: instructions },
          { role: "user", content: user },
        ];
    return JSON.stringify({
      model: this.model,
      messages,
      temperature: 0,
      max_tokens: this.thinking ? CHAT_MAX_TOKENS_THINKING : CHAT_MAX_TOKENS,
      ...(this.thinking ? { reasoning_effort: this.reasoningEffort } : {}),
      stream: false,
      response_format: this.jsonObjectOnly ? { type: "json_object" } : { type: "json_schema", json_schema: { name, schema, strict: true } },
    });
  }

  private async call(instructions: string, user: string, name: string, schema: unknown, timeoutMs: number, signal: AbortSignal | undefined, retried = false): Promise<unknown> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: this.body(instructions, user, name, schema),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ExtractUnavailableError("timeout", `chat: ${this.model} on ${this.baseUrl}: ${(e as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (!retried) return this.call(instructions, user, name, schema, timeoutMs, signal, true);
      throw new ExtractUnavailableError("http", `chat: ${this.model}: HTTP ${res.status}`, res.status);
    }
    if (res.status === 400 && !this.jsonObjectOnly) {
      // The server does not take response_format json_schema: ask once more in json_object mode with the schema in the words, and stay there.
      this.jsonObjectOnly = true;
      return this.call(instructions, user, name, schema, timeoutMs, signal, retried);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ExtractUnavailableError("http", `chat: ${this.model}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`, res.status);
    }
    let json: ChatCompletion;
    try {
      json = (await res.json()) as ChatCompletion;
    } catch {
      throw new ExtractUnavailableError("bad-json", `chat: ${this.model}: not JSON`);
    }
    const message = json.choices?.[0]?.message;
    if (message?.refusal) throw new ExtractUnavailableError("refused", `chat: ${this.model} refused: ${message.refusal.slice(0, 120)}`);
    if (typeof message?.content !== "string") throw new ExtractUnavailableError("bad-json", `chat: ${this.model}: no message content`);
    const text = unfence(stripThinking(message.content));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ExtractUnavailableError("bad-json", `chat: ${this.model}: content is not JSON`);
    }
  }
}
