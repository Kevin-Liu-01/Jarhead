import { BRAIN_MEMORY_TOKENS, VOICE_MEMORY_TOKENS, type MemoryItem } from "@jarhead/protocol";
import { localDay } from "./extract/input.ts";
import { estimateTokens } from "./tokens.ts";

/** The brain part's label; promptParts renders it above the block (the block itself is the bullet lines, under BRAIN_MEMORY_TOKENS). */
export const BRAIN_MEMORY_LABEL = "What you know about Kevin (durable memory; use it, do not repeat it back, do not say you remembered):";
export const VOICE_HEADER = "# Kevin, in brief";
export const VOICE_FOOTER = "Use this quietly; never announce that you remember it.";
const PROCEDURE_PREFIX = "How Kevin likes it done:";

export interface Rendered {
  /** Absent when nothing fit. */
  readonly text?: string;
  readonly tokens: number;
  readonly ids: string[];
}

/** No markdown emphasis, no code, no headers inside an item — the spoken prompt reads it aloud. */
function sanitize(text: string): string {
  return text.replace(/[*`]/g, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
}

/** An episode is dated by its first mention — the earliest source, which the cap keeps; createdAt is when memory learned it, hours later. */
function dateOf(item: MemoryItem): string {
  let first = Number.POSITIVE_INFINITY;
  for (const s of item.sources) if (s.at < first) first = s.at;
  return localDay(Number.isFinite(first) ? first : item.createdAt);
}

function sentence(item: MemoryItem): string {
  let t = sanitize(item.text);
  if (item.kind === "procedure" && !/^how kevin likes it done/i.test(t)) t = `${PROCEDURE_PREFIX} ${t}`;
  if (item.kind === "episode" && !/\b20\d\d-\d\d-\d\d\b/.test(t)) t = `${t} (${dateOf(item)})`;
  return t;
}

export function brainLine(item: MemoryItem): string {
  return `- ${sentence(item)}`;
}

/**
 * The per-delegation block: one bullet per item, procedures prefixed, episodes
 * dated. Lines are added in the order given while the whole stays under the
 * budget (chars / 3.2, newlines counted); the label is the caller's.
 */
export function renderBrainBlock(items: readonly MemoryItem[], budgetTokens: number = BRAIN_MEMORY_TOKENS): Rendered {
  let text = "";
  const ids: string[] = [];
  for (const it of items) {
    const line = brainLine(it);
    const next = text ? `${text}\n${line}` : line;
    if (estimateTokens(next) > budgetTokens) continue;
    text = next;
    ids.push(it.id);
  }
  return text ? { text, tokens: estimateTokens(text), ids } : { tokens: 0, ids };
}

function spoken(item: MemoryItem): string {
  const t = sentence(item);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The once-per-session voice block: `# Kevin, in brief`, the items as one
 * paragraph of sentences, and the closing instruction. One `#` level, no `*`
 * or backticks. Header and footer count against the budget.
 */
export function renderVoiceBlock(items: readonly MemoryItem[], budgetTokens: number = VOICE_MEMORY_TOKENS): Rendered {
  let body = "";
  const ids: string[] = [];
  for (const it of items) {
    const s = spoken(it);
    const nextBody = body ? `${body} ${s}` : s;
    if (estimateTokens(`${VOICE_HEADER}\n${nextBody}\n${VOICE_FOOTER}`) > budgetTokens) continue;
    body = nextBody;
    ids.push(it.id);
  }
  if (!body) return { tokens: 0, ids };
  const text = `${VOICE_HEADER}\n${body}\n${VOICE_FOOTER}`;
  return { text, tokens: estimateTokens(text), ids };
}
