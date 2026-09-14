import type { LocalFlavor } from "@jarhead/protocol";
import type { Thresholds } from "../types.ts";
import { cosine, l2normalize } from "../vec.ts";
import type { Embedder } from "./embedder.ts";
import { EmbedError } from "./errors.ts";
import { keywordQuerySimilarity, keywordSimilarity, type TokenWeight } from "./keyword.ts";

/** Texts per request; Ollama takes an array, so one call covers a whole merge batch. */
export const LOCAL_EMBED_BATCH = 64;
/** A cold embedding model pays its load before the first vector; the OpenAI embedder's 15 s would time out on it. */
export const LOCAL_EMBED_TIMEOUT_MS = 30_000;
/** How long Ollama keeps the embedding model loaded after a request — the brain uses the same figure. */
export const LOCAL_EMBED_KEEP_ALIVE = "30m";

/**
 * Cosine thresholds per local embedding model. Conservative until calibrated
 * against a real store: the band is wide so doubt goes to the decider (which
 * falls to rules after its timeout), and the failure mode is "asks or keeps a
 * twin", never "silently folds two facts". Keyed by the model's name without a
 * tag (`nomic-embed-text:latest` reads the `nomic-embed-text` row).
 */
export const LOCAL_THRESHOLDS: Record<string, Thresholds> = {
  "nomic-embed-text": { update: 0.9, band: 0.72, dup: 0.94 },
  "mxbai-embed-large": { update: 0.9, band: 0.72, dup: 0.94 },
  default: { update: 0.92, band: 0.75, dup: 0.95 },
};

/** The table row for a server id: `embeddinggemma:300m` → `embeddinggemma`, `library/nomic-embed-text:latest` → `nomic-embed-text`. */
export function localThresholdsFor(model: string): Thresholds {
  const name = model.split("/").pop()?.split(":")[0] ?? model;
  return LOCAL_THRESHOLDS[name] ?? LOCAL_THRESHOLDS[model] ?? LOCAL_THRESHOLDS["default"]!;
}

export interface LocalEmbedderOptions {
  readonly flavor: LocalFlavor;
  /** The server root ("http://127.0.0.1:11434"); no /v1 needed, the embedder adds the path its flavour wants. */
  readonly baseUrl: string;
  /** The server's own id, verbatim ("embeddinggemma", "nomic-embed-text:latest"). */
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
  /** Texts per request; default LOCAL_EMBED_BATCH. */
  readonly batch?: number;
  /** Per request; default LOCAL_EMBED_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Override the table (tests, a calibrated store). */
  readonly thresholds?: Thresholds;
  /** LM Studio's optional bearer (JARHEAD_BRAIN_API_KEY); Ollama wants none. */
  readonly apiKey?: string;
}

interface OllamaEmbedResponse {
  readonly embeddings?: readonly (readonly number[])[];
  readonly error?: string;
}

interface OpenAIEmbeddingsResponse {
  readonly data?: readonly { readonly index: number; readonly embedding: readonly number[] }[];
}

/**
 * An embedding model on this Mac. Ollama answers `POST /api/embed` with a
 * matrix; LM Studio and llama.cpp speak the OpenAI shape at `/v1/embeddings`.
 * `probe()` embeds one word to learn the model's width, so the cache is keyed
 * by the real dims and a later answer of another width is a `bad-response`,
 * never a vector of the wrong space. Item text goes to 127.0.0.1 and nowhere
 * else; there is no key to be missing, so `no-key` is never raised here.
 */
export class LocalEmbedder implements Embedder {
  readonly kind = "local" as const;
  readonly model: string;
  /** Measured by `probe()` before the service is built; every later vector must match. */
  readonly dims: number;
  readonly thresholds: Thresholds;
  readonly flavor: LocalFlavor;
  readonly baseUrl: string;
  private readonly batch: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;

  private constructor(opts: LocalEmbedderOptions, dims: number) {
    this.flavor = opts.flavor;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    this.model = opts.model;
    this.dims = dims;
    this.thresholds = opts.thresholds ?? localThresholdsFor(opts.model);
    this.batch = opts.batch ?? LOCAL_EMBED_BATCH;
    this.timeoutMs = opts.timeoutMs ?? LOCAL_EMBED_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiKey = opts.apiKey;
  }

  /** One embed of ["probe"] to learn dims; throws EmbedError when the server does not answer with a vector. */
  static async probe(opts: LocalEmbedderOptions): Promise<LocalEmbedder> {
    const unsized = new LocalEmbedder(opts, 0);
    const [v] = await unsized.call(["probe"], undefined, 0);
    if (!v || v.length === 0) throw new EmbedError("bad-response", `embeddings: ${opts.model} answered the probe with no vector`);
    return new LocalEmbedder(opts, v.length);
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      const slice = texts.slice(i, i + this.batch);
      out.push(...(await this.call(slice, signal, this.dims)));
    }
    return out;
  }

  private get url(): string {
    return this.flavor === "ollama" ? `${this.baseUrl}/api/embed` : `${this.baseUrl}/v1/embeddings`;
  }

  private body(input: readonly string[]): string {
    if (this.flavor === "ollama") return JSON.stringify({ model: this.model, input, keep_alive: LOCAL_EMBED_KEEP_ALIVE });
    return JSON.stringify({ model: this.model, input });
  }

  /** One request; `expectDims` 0 accepts any width (the probe). One retry on 5xx, none on 4xx (a missing model is a configuration fault). */
  private async call(input: readonly string[], signal: AbortSignal | undefined, expectDims: number, retried = false): Promise<Float32Array[]> {
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: this.body(input),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new EmbedError("timeout", `embeddings: ${this.model} on ${this.baseUrl}: ${(e as Error).message}`);
    }
    if (res.status >= 500) {
      if (!retried) return this.call(input, signal, expectDims, true);
      throw new EmbedError("http", `embeddings: ${this.model}: HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EmbedError("http", `embeddings: ${this.model}: HTTP ${res.status}${text ? ` ${text.slice(0, 160)}` : ""}`, res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new EmbedError("bad-response", `embeddings: ${this.model}: not JSON`);
    }
    const rows = this.rows(json, input.length);
    return rows.map((row) => {
      if (!Array.isArray(row) || row.length === 0 || (expectDims > 0 && row.length !== expectDims)) {
        throw new EmbedError("bad-response", `embeddings: ${this.model} answered ${Array.isArray(row) ? row.length : "no"} dims, the space has ${expectDims}`);
      }
      return l2normalize(Float32Array.from(row));
    });
  }

  /** The matrix in request order, whichever shape the flavour speaks. */
  private rows(json: unknown, count: number): readonly (readonly number[])[] {
    if (this.flavor === "ollama") {
      const m = (json as OllamaEmbedResponse).embeddings;
      if (!Array.isArray(m) || m.length !== count) throw new EmbedError("bad-response", `embeddings: ${this.model}: wrong count`);
      return m;
    }
    const data = (json as OpenAIEmbeddingsResponse).data;
    if (!Array.isArray(data) || data.length !== count) throw new EmbedError("bad-response", `embeddings: ${this.model}: wrong count`);
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
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
