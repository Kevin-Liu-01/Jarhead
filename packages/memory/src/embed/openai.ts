import type { Embedder } from "./embedder.ts";
import { OPENAI_THRESHOLDS } from "../limits.ts";
import { keywordQuerySimilarity, keywordSimilarity, type TokenWeight } from "./keyword.ts";
import { cosine, l2normalize } from "../vec.ts";

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIMS = 512;
export const EMBED_BATCH = 96;

export type EmbedErrorCode = "no-key" | "http" | "timeout" | "bad-response";

/** Why an embed() failed; the service defers the run on any of these rather than mixing vector spaces. */
export class EmbedError extends Error {
  constructor(readonly code: EmbedErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "EmbedError";
  }
}

export interface OpenAIEmbedderOptions {
  /** Read at call time, never from process.env here: the engine passes `() => config.openaiApiKey`. */
  readonly apiKey: () => string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
  readonly dims?: number;
  readonly batch?: number;
  readonly timeoutMs?: number;
  /** Wait before the one retry on 429/5xx (tests set 0). */
  readonly backoffMs?: number;
  readonly baseUrl?: string;
}

interface EmbeddingsResponse {
  readonly data?: readonly { readonly index: number; readonly embedding: readonly number[] }[];
}

/**
 * text-embedding-3-small at 512 dims (Kevin's OpenAI key — dollars, never the
 * ChatGPT plan; ≈ $0.02 per million tokens). Batches of ≤ 96 texts, one retry
 * on 429/5xx, 15 s per call. Item text goes to the same vendor that already
 * hears the whole conversation; with no key the keyword embedder runs instead.
 */
export class OpenAIEmbedder implements Embedder {
  readonly kind = "openai" as const;
  readonly model: string;
  readonly dims: number;
  readonly thresholds = OPENAI_THRESHOLDS;
  private readonly batch: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIEmbedderOptions) {
    this.model = opts.model ?? EMBED_MODEL;
    this.dims = opts.dims ?? EMBED_DIMS;
    this.batch = opts.batch ?? EMBED_BATCH;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.backoffMs = opts.backoffMs ?? 2000;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const key = this.opts.apiKey();
    if (!key) throw new EmbedError("no-key", "no OpenAI key for embeddings");
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      const slice = texts.slice(i, i + this.batch);
      out.push(...(await this.call(key, slice, signal)));
    }
    return out;
  }

  private async call(key: string, input: readonly string[], signal: AbortSignal | undefined, retried = false): Promise<Float32Array[]> {
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input, dimensions: this.dims, encoding_format: "float" }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new EmbedError("timeout", `embeddings: ${(e as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (!retried) {
        if (this.backoffMs > 0) await new Promise((r) => setTimeout(r, this.backoffMs));
        return this.call(key, input, signal, true);
      }
      throw new EmbedError("http", `embeddings: HTTP ${res.status}`, res.status);
    }
    if (!res.ok) throw new EmbedError("http", `embeddings: HTTP ${res.status}`, res.status);
    let json: EmbeddingsResponse;
    try {
      json = (await res.json()) as EmbeddingsResponse;
    } catch {
      throw new EmbedError("bad-response", "embeddings: not JSON");
    }
    const data = json.data;
    if (!Array.isArray(data) || data.length !== input.length) throw new EmbedError("bad-response", "embeddings: wrong count");
    const sorted = [...data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => {
      if (!Array.isArray(d.embedding) || d.embedding.length !== this.dims) throw new EmbedError("bad-response", "embeddings: wrong dims");
      return l2normalize(Float32Array.from(d.embedding));
    });
  }

  similarity(a: Float32Array, b: Float32Array): number {
    return cosine(a, b);
  }

  similarityText(a: string, b: string): number {
    return keywordSimilarity(a, b);
  }

  similarityQuery(query: string, item: string, weight?: TokenWeight): number {
    return keywordQuerySimilarity(query, item, weight);
  }
}
