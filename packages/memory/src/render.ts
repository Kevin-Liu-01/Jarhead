import { BRAIN_MEMORY_TOKENS, VOICE_MEMORY_TOKENS, type MemoryItem } from "@jarhead/protocol";
import { localDay } from "./extract/input.ts";
import { estimateTokens } from "./tokens.ts";

/** The brain part's label; promptParts renders it above the block (the block itself is the bullet lines, under BRAIN_MEMORY_TOKENS). */
export function brainMemoryLabel(userName = "Kevin"): string {
  return `What you know about ${userName} (durable memory; use it, do not repeat it back, do not say you remembered):`;
}
export const BRAIN_MEMORY_LABEL = brainMemoryLabel();
/** The voice block's header with the user's name (release F1): `# Sam, in brief`. */
export function voiceHeader(userName = "Kevin"): string {
  return `# ${userName}, in brief`;
}
export const VOICE_HEADER = voiceHeader();
export const VOICE_FOOTER = "Use this quietly; never announce that you remember it.";
const procedurePrefix = (userName: string): string => `How ${userName} likes it done:`;
/** A procedure already phrased as one, whoever the rules named when it was minted. */
const PROCEDURE_PHRASED = /^how .{1,60}? likes it done/i;

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

function sentence(item: MemoryItem, userName: string): string {
  let t = sanitize(item.text);
  if (item.kind === "procedure" && !PROCEDURE_PHRASED.test(t)) t = `${procedurePrefix(userName)} ${t}`;
  if (item.kind === "episode" && !/\b20\d\d-\d\d-\d\d\b/.test(t)) t = `${t} (${dateOf(item)})`;
  return t;
}

export function brainLine(item: MemoryItem, userName = "Kevin"): string {
  return `- ${sentence(item, userName)}`;
}

/**
 * The per-delegation block: one bullet per item, procedures prefixed, episodes
 * dated. Lines are added in the order given while the whole stays under the
 * budget (chars / 3.2, newlines counted); the label is the caller's.
 */
export function renderBrainBlock(items: readonly MemoryItem[], budgetTokens: number = BRAIN_MEMORY_TOKENS, userName = "Kevin"): Rendered {
  let text = "";
  const ids: string[] = [];
  for (const it of items) {
    const line = brainLine(it, userName);
    const next = text ? `${text}\n${line}` : line;
    if (estimateTokens(next) > budgetTokens) continue;
    text = next;
    ids.push(it.id);
  }
  return text ? { text, tokens: estimateTokens(text), ids } : { tokens: 0, ids };
}

function spoken(item: MemoryItem, userName: string): string {
  const t = sentence(item, userName);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The once-per-session voice block: `# Kevin, in brief`, the items as one
 * paragraph of sentences, and the closing instruction. One `#` level, no `*`
 * or backticks. Header and footer count against the budget.
 */
export function renderVoiceBlock(items: readonly MemoryItem[], budgetTokens: number = VOICE_MEMORY_TOKENS, userName = "Kevin"): Rendered {
  let body = "";
  const ids: string[] = [];
  const header = voiceHeader(userName);
  for (const it of items) {
    const s = spoken(it, userName);
    const nextBody = body ? `${body} ${s}` : s;
    if (estimateTokens(`${header}\n${nextBody}\n${VOICE_FOOTER}`) > budgetTokens) continue;
    body = nextBody;
    ids.push(it.id);
  }
  if (!body) return { tokens: 0, ids };
  const text = `${header}\n${body}\n${VOICE_FOOTER}`;
  return { text, tokens: estimateTokens(text), ids };
}
