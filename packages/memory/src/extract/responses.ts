import type { MemoryKind } from "@jarhead/protocol";
import type { Candidate, Decision, ExtractInput, Neighbour } from "../types.ts";
import { ExtractUnavailableError, type DecideContext, type Decider, type Extractor } from "./extractor.ts";
import { DECIDE_INSTRUCTIONS, DECIDE_SCHEMA, DECIDE_SCHEMA_NAME, EXTRACT_INSTRUCTIONS, EXTRACT_MAX_ITEMS, EXTRACT_SCHEMA, EXTRACT_SCHEMA_NAME, renderDecideUser, renderExtractUser, stripBounds } from "./prompt.ts";
import { RulesDecider } from "./rules.ts";

/**
 * A mini-class Responses id as the placeholder default. The doctor's one free
 * GET /v1/models picks the real one through `pickMemoryModel` and records it
 * (JARHEAD_MEMORY_MODEL); a wrong id fails soft to the rules extractor with one
 * warning, never blocks extraction.
 */
export const DEFAULT_MEMORY_MODEL = "gpt-5-mini";

const NOT_TEXT = /(audio|realtime|live|tts|transcri|whisper|search|image|embedding|moderation|dall|sora|vision|nano|codex|preview|chat-latest|deep-research|instruct|-pro\b)/i;
const DATED = /-\d{4}-\d{2}-\d{2}$/;

function familyScore(id: string): number {
  const m = /^gpt-(\d+)(?:\.(\d+))?-mini$/i.exec(id);
  if (m) return 300 + Number(m[1]) * 10 + Number(m[2] ?? 0);
  if (/^o(\d+)-mini$/i.test(id)) return 150 + Number(/^o(\d+)/i.exec(id)![1]);
  if (/^gpt-\d+o-mini$/i.test(id)) return 100;
  return 50;
}

/**
 * From a models list, the cheapest sensible extractor: a `*-mini` text model
 * that answers the Responses API with json_schema, newest family first, undated
 * ids before dated snapshots. Undefined when none qualifies (keep the default).
 */
export function pickMemoryModel(models: readonly string[]): string | undefined {
  const ok = models.filter((m) => /-mini\b/i.test(m) && !NOT_TEXT.test(m));
  if (ok.length === 0) return undefined;
  const undated = ok.filter((m) => !DATED.test(m));
  const pool = undated.length > 0 ? undated : ok;
  return [...pool].sort((a, b) => familyScore(b) - familyScore(a) || a.length - b.length || (a < b ? -1 : 1))[0];
}

export interface ResponsesExtractorOptions {
  /** Read at call time, never from process.env here: the engine passes `() => config.openaiApiKey`. */
  readonly apiKey: () => string | undefined;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  /** Wait before the one retry on 429/5xx (tests set 0). */
  readonly backoffMs?: number;
  readonly baseUrl?: string;
  /** Sent as `reasoning.effort` for reasoning models (gpt-5*, o*); undefined = decide by the id. */
  readonly reasoningEffort?: "minimal" | "low" | "none";
}

const KINDS: ReadonlySet<string> = new Set<MemoryKind>(["preference", "fact", "episode", "procedure", "contact", "place"]);
/** A 400 that names one of these is the strict validator refusing a schema bound; the bounds are the post-filter's job anyway. */
const SCHEMA_BOUND_400 = /minItems|maxItems|minimum|maximum|schema/i;

interface ResponsesJson {
  readonly status?: string;
  readonly output?: readonly { readonly type?: string; readonly content?: readonly { readonly type?: string; readonly text?: string; readonly refusal?: string }[] }[];
  readonly error?: { readonly message?: string };
}

/**
 * Extraction and band decisions over OpenAI's Responses API: strict
 * json_schema output, `store: false`, ≤ 900 output tokens, 20 s, one retry on
 * 429/5xx. Kevin's OpenAI key — dollars per token, bounded by the input cap;
 * never the ChatGPT plan, never the resident Codex thread. Every failure is an
 * ExtractUnavailableError the service answers with the rules extractor. Two
 * 400s heal themselves for the life of the process: a model that takes no
 * `reasoning` parameter loses it, and a validator that rejects the schema's
 * array/number bounds gets the schema without them (`stripBounds`).
 */
export class ResponsesExtractor implements Extractor, Decider {
  readonly kind = "responses" as const;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly backoffMs: number;
  private readonly baseUrl: string;
  private readonly rules = new RulesDecider();
  private reasoning: "minimal" | "low" | undefined;
  /** True after a 400 named a schema bound: schemas go out without minItems/maxItems/minimum/maximum from then on. */
  private plainSchema = false;

  constructor(private readonly opts: ResponsesExtractorOptions) {
    this.model = opts.model || DEFAULT_MEMORY_MODEL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxOutputTokens = opts.maxOutputTokens ?? 900;
    this.backoffMs = opts.backoffMs ?? 2000;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    const effort = opts.reasoningEffort ?? (/^(gpt-5|o\d)/i.test(this.model) ? "minimal" : "none");
    this.reasoning = effort === "none" ? undefined : effort;
  }

  async extract(input: ExtractInput, signal?: AbortSignal): Promise<Candidate[]> {
    const json = await this.call(EXTRACT_INSTRUCTIONS, renderExtractUser(input), EXTRACT_SCHEMA_NAME, EXTRACT_SCHEMA, signal);
    const items = (json as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new ExtractUnavailableError("bad-json", "extractor: no items array");
    const out: Candidate[] = [];
    for (const raw of items.slice(0, EXTRACT_MAX_ITEMS)) {
      const r = raw as Record<string, unknown>;
      if (typeof r["kind"] !== "string" || !KINDS.has(r["kind"]) || typeof r["text"] !== "string") continue;
      out.push({
        kind: r["kind"] as MemoryKind,
        text: r["text"],
        subjects: Array.isArray(r["subjects"]) ? (r["subjects"] as unknown[]).filter((s): s is string => typeof s === "string") : [],
        importance: typeof r["importance"] === "number" ? r["importance"] : 3,
        confidence: typeof r["confidence"] === "number" ? r["confidence"] : 0.5,
        evidence: Array.isArray(r["evidence"]) ? (r["evidence"] as unknown[]).filter((n): n is number => typeof n === "number") : [],
        origin: "extracted",
      });
    }
    return out;
  }

  /** The band decision; any failure falls back to rules mode so a merge never stalls on the network. */
  async decide(candidate: Candidate, neighbours: readonly Neighbour[], ctx: DecideContext): Promise<Decision> {
    try {
      const json = (await this.call(DECIDE_INSTRUCTIONS, renderDecideUser(candidate, neighbours, ctx.now), DECIDE_SCHEMA_NAME, DECIDE_SCHEMA, ctx.signal)) as Record<string, unknown>;
      const op = json["op"];
      if (op !== "ADD" && op !== "UPDATE" && op !== "NOOP") throw new ExtractUnavailableError("bad-json", "decider: bad op");
      const rawTarget = typeof json["target"] === "string" ? json["target"].trim() : "";
      let target: string | undefined;
      if (/^[A-J]$/.test(rawTarget)) target = neighbours[rawTarget.charCodeAt(0) - 65]?.item.id;
      else if (neighbours.some((n) => n.item.id === rawTarget)) target = rawTarget;
      const text = typeof json["text"] === "string" && json["text"].trim() ? json["text"].trim() : undefined;
      const contradicts = json["contradicts"] === true;
      return { op, ...(target ? { target } : {}), ...(text ? { text } : {}), contradicts };
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      return this.rules.decide(candidate, neighbours, ctx);
    }
  }

  private body(instructions: string, input: string, name: string, schema: unknown, withReasoning: boolean): string {
    return JSON.stringify({
      model: this.model,
      instructions,
      input,
      text: { format: { type: "json_schema", name, strict: true, schema: this.plainSchema ? stripBounds(schema) : schema } },
      max_output_tokens: this.maxOutputTokens,
      store: false,
      ...(withReasoning && this.reasoning ? { reasoning: { effort: this.reasoning } } : {}),
    });
  }

  private async call(instructions: string, input: string, name: string, schema: unknown, signal: AbortSignal | undefined, retried = false, withReasoning = true): Promise<unknown> {
    const key = this.opts.apiKey();
    if (!key) throw new ExtractUnavailableError("no-key", "no OpenAI key for the memory extractor");
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: this.body(instructions, input, name, schema, withReasoning),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ExtractUnavailableError("timeout", `responses: ${(e as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (!retried) {
        if (this.backoffMs > 0) await new Promise((r) => setTimeout(r, this.backoffMs));
        return this.call(instructions, input, name, schema, signal, true, withReasoning);
      }
      throw new ExtractUnavailableError("http", `responses: HTTP ${res.status}`, res.status);
    }
    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      // A model that takes no `reasoning` parameter: drop it for good and try once more (not the retry).
      if (withReasoning && this.reasoning && /reasoning/i.test(text)) {
        this.reasoning = undefined;
        return this.call(instructions, input, name, schema, signal, retried, false);
      }
      // The strict validator refusing a bound keyword: send the schema without bounds from now on, once more now.
      if (!this.plainSchema && SCHEMA_BOUND_400.test(text)) {
        this.plainSchema = true;
        return this.call(instructions, input, name, schema, signal, retried, withReasoning);
      }
      throw new ExtractUnavailableError("http", `responses: HTTP 400 ${text.slice(0, 200)}`, 400);
    }
    if (!res.ok) throw new ExtractUnavailableError("http", `responses: HTTP ${res.status}`, res.status);
    let json: ResponsesJson;
    try {
      json = (await res.json()) as ResponsesJson;
    } catch {
      throw new ExtractUnavailableError("bad-json", "responses: not JSON");
    }
    let text: string | undefined;
    for (const o of json.output ?? []) {
      if (o.type !== "message") continue;
      for (const c of o.content ?? []) {
        if (c.type === "refusal") throw new ExtractUnavailableError("refused", `responses: refused${c.refusal ? `: ${c.refusal.slice(0, 120)}` : ""}`);
        if (c.type === "output_text" && typeof c.text === "string") text = c.text;
      }
    }
    if (text === undefined) throw new ExtractUnavailableError("bad-json", `responses: no output_text (status ${json.status ?? "unknown"})`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ExtractUnavailableError("bad-json", "responses: output_text is not JSON");
    }
  }
}
