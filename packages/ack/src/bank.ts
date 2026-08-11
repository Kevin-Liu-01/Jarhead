import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pre-synthesized acknowledgement bank.
 *
 * Why it exists: measured first audio is p50 1239ms and Claude's TTFT (p50
 * 572ms) sits on the critical path. A cached mp3 needs no network at all, so
 * playing one costs roughly ffplay startup — Kevin hears something in
 * ~150-250ms while the real answer is still generating.
 *
 * Why disk-cached, keyed by text+voice+model: the ElevenLabs free tier is
 * 10,000 characters a month and some are already spent. Each phrase is paid
 * for exactly once per voice+model combination. Changing the voice or model
 * re-synthesizes because the audio genuinely differs; changing nothing reuses
 * the bytes forever.
 */

export type AckCategory = "greeting" | "thinking" | "working";

export interface BankPhrases {
  readonly greeting: readonly string[];
  readonly thinking: readonly string[];
  readonly working: readonly string[];
}

/**
 * At least two phrases per category so rotation has somewhere to go, and all
 * of them short: the whole default bank is 52 characters of quota, once.
 */
export const DEFAULT_PHRASES: BankPhrases = {
  greeting: ["hey", "hey Kevin", "what's up"],
  thinking: ["let me look", "checking"],
  working: ["on it", "one sec"],
};

const CATEGORIES: readonly AckCategory[] = ["greeting", "thinking", "working"];

/** The \n separator keeps ("ab","c") and ("a","bc") from producing the same key. */
export function cacheKey(text: string, voiceId: string, modelId: string): string {
  return createHash("sha256").update(`${text}\n${voiceId}\n${modelId}`).digest("hex");
}

export function ackDir(stateDir: string): string {
  return join(stateDir, "ack");
}

export function phrasePath(stateDir: string, text: string, voiceId: string, modelId: string): string {
  return join(ackDir(stateDir), `${cacheKey(text, voiceId, modelId)}.mp3`);
}

export interface PlanOptions {
  readonly stateDir: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly phrases?: BankPhrases;
}

export interface SpendPlan {
  readonly toSynthesize: readonly string[];
  /** Exactly what ensureBank will bill against the ElevenLabs quota. */
  readonly characters: number;
  readonly alreadyCached: number;
}

/**
 * What building the bank would cost, without spending anything. Separate from
 * ensureBank so the spend can be shown (or asserted in tests) with no API key
 * and no network.
 */
export function planBank(opts: PlanOptions): SpendPlan {
  const phrases = uniquePhrases(opts.phrases ?? DEFAULT_PHRASES);
  const toSynthesize = phrases.filter(
    (text) => !existsSync(phrasePath(opts.stateDir, text, opts.voiceId, opts.modelId)),
  );
  return {
    toSynthesize,
    characters: toSynthesize.reduce((n, text) => n + text.length, 0),
    alreadyCached: phrases.length - toSynthesize.length,
  };
}

/** A phrase listed under two categories shares one file, so it is billed once. */
function uniquePhrases(phrases: BankPhrases): readonly string[] {
  return [...new Set([...phrases.greeting, ...phrases.thinking, ...phrases.working])];
}

export interface EnsureBankOptions extends PlanOptions {
  readonly apiKey: string;
  /** Called with the exact character spend before the first network request. */
  readonly onPlan?: (plan: SpendPlan) => void;
  readonly timeoutMs?: number;
}

export interface EnsureBankResult {
  readonly plan: SpendPlan;
  readonly synthesized: number;
}

/**
 * Build the bank. Never called at import time, only explicitly — a bug that
 * re-synthesized on every boot would quietly eat the month's quota. Phrases
 * already on disk are skipped, and onPlan fires before any character is spent.
 */
export async function ensureBank(opts: EnsureBankOptions): Promise<EnsureBankResult> {
  const plan = planBank(opts);
  opts.onPlan?.(plan);
  if (plan.toSynthesize.length === 0) return { plan, synthesized: 0 };

  mkdirSync(ackDir(opts.stateDir), { recursive: true });
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Sequential on purpose: this runs at setup time, not on the voice path,
  // and a failure part-way stops the spend instead of racing more requests.
  let synthesized = 0;
  for (const text of plan.toSynthesize) {
    const bytes = await synthesize(text, opts, timeoutMs);
    const path = phrasePath(opts.stateDir, text, opts.voiceId, opts.modelId);
    // Write-then-rename so a crash mid-write cannot leave a truncated mp3
    // that existsSync would treat as cached forever.
    writeFileSync(`${path}.part`, bytes);
    renameSync(`${path}.part`, path);
    synthesized++;
  }
  return { plan, synthesized };
}

async function synthesize(text: string, opts: EnsureBankOptions, timeoutMs: number): Promise<Buffer> {
  // Same output format the streaming Speaker uses, so acks and answers come
  // out of the same voice at the same fidelity and nothing sounds spliced.
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${opts.voiceId}?output_format=mp3_22050_32`,
    {
      method: "POST",
      headers: { "xi-api-key": opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: opts.modelId }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    throw new Error(`elevenlabs ${res.status} for "${text}": ${(await res.text()).slice(0, 160)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface AckBankOptions {
  readonly stateDir: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly phrases?: BankPhrases;
  /**
   * Returns an integer in [0, n). Injected rather than calling Math.random
   * here so rotation is deterministic under test (same pattern as TurnDeps).
   */
  readonly pickIndex?: (n: number) => number;
}

export class AckBank {
  private readonly phrases: BankPhrases;
  private readonly pickIndex: (n: number) => number;
  private readonly lastPicked = new Map<AckCategory, number>();
  private available: Map<AckCategory, readonly string[]> | undefined;

  constructor(private readonly opts: AckBankOptions) {
    this.phrases = opts.phrases ?? DEFAULT_PHRASES;
    this.pickIndex = opts.pickIndex ?? ((n) => Math.floor(Math.random() * n));
  }

  /**
   * Path of a cached ack, rotated so consecutive picks in a category always
   * differ — repetition is what makes canned audio sound canned. Disk is
   * scanned once and memoized because this runs on the live voice path, where
   * a stat per pick would be spend we don't need to make.
   */
  pickAck(category: AckCategory): string | undefined {
    const paths = this.availablePaths(category);
    const n = paths.length;
    if (n === 0) return undefined;

    const last = this.lastPicked.get(category);
    let index: number;
    if (n === 1 || last === undefined) {
      // With one phrase cached, repeating beats staying silent.
      index = n === 1 ? 0 : this.pickIndex(n);
    } else {
      // Draw from the n-1 slots that are not last time's, then skip past it.
      index = this.pickIndex(n - 1);
      if (index >= last) index++;
    }
    this.lastPicked.set(category, index);
    return paths[index];
  }

  /** Re-scan disk, e.g. after ensureBank ran in the same process. */
  refresh(): void {
    this.available = undefined;
  }

  private availablePaths(category: AckCategory): readonly string[] {
    this.available ??= this.scan();
    return this.available.get(category) ?? [];
  }

  private scan(): Map<AckCategory, readonly string[]> {
    const map = new Map<AckCategory, readonly string[]>();
    for (const category of CATEGORIES) {
      map.set(
        category,
        this.phrases[category]
          .map((text) => phrasePath(this.opts.stateDir, text, this.opts.voiceId, this.opts.modelId))
          .filter((path) => existsSync(path)),
      );
    }
    return map;
  }
}
