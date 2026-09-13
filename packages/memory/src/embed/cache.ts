import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeText } from "../redact.ts";
import { fromBase64, l2normalize, toBase64 } from "../vec.ts";

interface CacheRow {
  readonly sha: string;
  readonly model: string;
  readonly dims: number;
  readonly vec: string;
}

/**
 * <stateDir>/memory/embeddings.jsonl: sha256(normalised text) → unit vector,
 * append-only. Keyed by model and dims as well, so a switch of embedder never
 * compares vectors from two spaces; identical texts share one row, and an
 * UPDATE row in memory.jsonl never repeats 2.7 KB of floats.
 */
export class EmbeddingCache {
  readonly path: string;
  private readonly rows = new Map<string, Float32Array>();
  private loaded = false;

  constructor(dir: string) {
    this.path = join(dir, "embeddings.jsonl");
  }

  static sha(text: string): string {
    return createHash("sha256").update(normalizeText(text)).digest("hex");
  }

  private static key(model: string, dims: number, sha: string): string {
    return `${model}/${dims}/${sha}`;
  }

  load(): void {
    this.loaded = true;
    this.rows.clear();
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const r = JSON.parse(line) as CacheRow;
        if (typeof r.sha !== "string" || typeof r.vec !== "string" || typeof r.model !== "string" || typeof r.dims !== "number") continue;
        this.rows.set(EmbeddingCache.key(r.model, r.dims, r.sha), fromBase64(r.vec));
      } catch {
        // one bad line never costs the rest
      }
    }
  }

  get(model: string, dims: number, sha: string): Float32Array | undefined {
    if (!this.loaded) this.load();
    return this.rows.get(EmbeddingCache.key(model, dims, sha));
  }

  has(model: string, dims: number, sha: string): boolean {
    return this.get(model, dims, sha) !== undefined;
  }

  /** Store a vector; a zero-dim embedder (keyword) stores nothing, and a present key is not rewritten. */
  put(model: string, dims: number, sha: string, vec: Float32Array): void {
    if (!this.loaded) this.load();
    if (dims === 0 || vec.length === 0) return;
    const key = EmbeddingCache.key(model, dims, sha);
    if (this.rows.has(key)) return;
    const unit = l2normalize(vec);
    const dir = join(this.path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const row: CacheRow = { sha, model, dims, vec: toBase64(unit) };
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    this.rows.set(key, unit);
  }

  get size(): number {
    if (!this.loaded) this.load();
    return this.rows.size;
  }

  bytes(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }
}
