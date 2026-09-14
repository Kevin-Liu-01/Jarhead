import type { MemoryKind } from "@jarhead/protocol";
import type { Candidate, Decision, Neighbour } from "../types.ts";
import { ExtractUnavailableError } from "./extractor.ts";
import { EXTRACT_MAX_ITEMS } from "./prompt.ts";

/**
 * The model's JSON, read the same way whichever wire carried it: OpenAI's
 * Responses API and a local model's Chat Completions both answer the schemas
 * in prompt.ts, and these two functions are the only place their shapes are
 * trusted. Anything malformed is an ExtractUnavailableError("bad-json") the
 * service answers with the rules extractor; a row of the wrong shape inside an
 * otherwise good list is skipped, not fatal.
 */

const KINDS: ReadonlySet<string> = new Set<MemoryKind>(["preference", "fact", "episode", "procedure", "contact", "place"]);

/** `{ items: [...] }` → candidates (≤ EXTRACT_MAX_ITEMS), origin `extracted`; throws bad-json when there is no items array. */
export function parseCandidates(json: unknown): Candidate[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new ExtractUnavailableError("bad-json", "extractor: no items array");
  const out: Candidate[] = [];
  for (const raw of items.slice(0, EXTRACT_MAX_ITEMS)) {
    if (raw === null || typeof raw !== "object") continue;
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

/**
 * `{ op, target, text, contradicts }` → a Decision. `target` is the letter the
 * prompt labelled the neighbour with (A–J) or the item id itself; anything else
 * is no target. Throws bad-json on an op outside ADD | UPDATE | NOOP.
 */
export function parseDecision(json: unknown, neighbours: readonly Neighbour[]): Decision {
  const r = (json !== null && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const op = r["op"];
  if (op !== "ADD" && op !== "UPDATE" && op !== "NOOP") throw new ExtractUnavailableError("bad-json", "decider: bad op");
  const rawTarget = typeof r["target"] === "string" ? r["target"].trim() : "";
  let target: string | undefined;
  if (/^[A-J]$/.test(rawTarget)) target = neighbours[rawTarget.charCodeAt(0) - 65]?.item.id;
  else if (neighbours.some((n) => n.item.id === rawTarget)) target = rawTarget;
  const text = typeof r["text"] === "string" && r["text"].trim() ? r["text"].trim() : undefined;
  const contradicts = r["contradicts"] === true;
  return { op, ...(target ? { target } : {}), ...(text ? { text } : {}), contradicts };
}
