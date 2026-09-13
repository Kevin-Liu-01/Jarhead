import type { Ledger } from "@jarhead/core";
import { normalizeUtterance, parseReflex } from "@jarhead/brain";
import type { LedgerRow } from "@jarhead/protocol";
import { recentDays } from "./ledger-speed.ts";

/**
 * `pnpm jarhead reflex-miss [--days N]` — the commands Kevin said that the grammar did
 * not catch, grouped so the grammar can grow from his real misses instead of guesses.
 *
 * The speed reader found 0 of 119 production requests parsing as a reflex: Kevin's
 * utterances open with fillers ("um", "yeah,", "[chuckle]") and end in long clauses.
 * So this miner strips the fillers the ear strips, takes the LAST clause, keeps the
 * short ones (≤ 8 words: a reflex is a one-step command), drops what the grammar
 * already parses, and groups the rest by their head verb with counts and a few
 * examples. It prints Kevin's own words back to Kevin, in his terminal, from his ledger
 * — nothing leaves the machine. Every row later added to the grammar must be
 * idempotent or reversible and never a destructive verb (packages/brain/src/reflex.ts).
 */

/** Words the recogniser hears at the start of a command that are not part of it (the ear's set plus the speed reader's finds), and bracketed tags. Not "right": "right click save" is a command. */
const FILLER_HEAD = /^(?:(?:um+|uh+|erm|hmm+|so|like|okay|ok|alright|all right|hey|yeah|yes|yep|oh|awesome|great|nice|cool|well|basically|actually|and|then|now)[,.!\s]+)+/i;
const TAGS = /\[[^\]]{1,24}\]/g;

/** The utterance without its fillers and tags, whitespace collapsed. */
export function stripFillers(text: string): string {
  let t = text.replace(TAGS, " ").replace(/\s+/g, " ").trim();
  // Fillers can stack ("um, okay, so, scroll down"): strip until nothing changes.
  for (let i = 0; i < 6; i++) {
    const next = t.replace(FILLER_HEAD, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** The last clause: after the last sentence end, or after a trailing ", and then" / "then". */
export function lastClause(text: string): string {
  const t = text.trim();
  const sentences = t.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
  let last = sentences[sentences.length - 1] ?? t;
  const parts = last.split(/,?\s+(?:and then|then|and)\s+/i);
  last = parts[parts.length - 1] ?? last;
  return last.replace(/[.!?…]+$/, "").trim();
}

export interface Miss {
  readonly clause: string;
  readonly words: number;
  readonly source: "heard" | "request";
}

export interface MissGroup {
  /** The clause's first word after normalisation (its head verb, usually). */
  readonly head: string;
  readonly n: number;
  /** Distinct clauses, most frequent first, at most `examples`. */
  readonly examples: readonly { readonly clause: string; readonly n: number }[];
}

export interface MineOptions {
  /** Longest clause kept, in words (default 8). */
  readonly maxWords?: number;
  /** The grammar; a clause it parses is a hit, not a miss. Tests pass a stand-in. */
  readonly parse?: (utterance: string) => unknown;
  /** Examples per group (default 3). */
  readonly examples?: number;
}

/** Candidate clauses from the rows: Kevin's heard finals and the delegations' requests. */
export function candidates(rows: readonly LedgerRow[]): { text: string; source: Miss["source"] }[] {
  const out: { text: string; source: Miss["source"] }[] = [];
  for (const row of rows) {
    if (row.type === "heard" && row.item.speaker === "kevin" && row.item.final) out.push({ text: row.item.text, source: "heard" });
    else if (row.type === "delegation.created" && row.delegation.request) out.push({ text: row.delegation.request, source: "request" });
  }
  return out;
}

/** The misses, grouped by head word, largest group first. */
export function mineMisses(rows: readonly LedgerRow[], opts: MineOptions = {}): MissGroup[] {
  const maxWords = opts.maxWords ?? 8;
  const parse = opts.parse ?? parseReflex;
  const exampleCap = opts.examples ?? 3;
  const groups = new Map<string, Map<string, number>>();
  for (const c of candidates(rows)) {
    const whole = stripFillers(c.text);
    if (!whole) continue;
    // A hit is a hit whether the whole utterance or its tail parses.
    if (parse(whole) !== undefined) continue;
    // The grammar's own normaliser (wake word, politeness, punctuation, case) so the groups are by command, not by wrapping.
    const clause = normalizeUtterance(stripFillers(lastClause(whole)));
    if (!clause || parse(clause) !== undefined) continue;
    const words = clause.split(/\s+/);
    if (words.length > maxWords) continue;
    const head = words[0] ?? "";
    if (!head) continue;
    const byClause = groups.get(head) ?? new Map<string, number>();
    byClause.set(clause, (byClause.get(clause) ?? 0) + 1);
    groups.set(head, byClause);
  }
  return [...groups]
    .map(([head, byClause]) => {
      const n = [...byClause.values()].reduce((a, b) => a + b, 0);
      const examples = [...byClause].map(([clause, k]) => ({ clause, n: k })).sort((a, b) => b.n - a.n || a.clause.localeCompare(b.clause)).slice(0, exampleCap);
      return { head, n, examples };
    })
    .sort((a, b) => b.n - a.n || a.head.localeCompare(b.head));
}

/** Mine the last N day files. */
export function reflexMisses(ledger: Ledger, days: number, opts: MineOptions = {}): { days: string[]; groups: MissGroup[] } {
  const picked = recentDays(ledger, days);
  const rows = picked.flatMap((d) => ledger.read(Date.parse(`${d}T12:00:00`)));
  return { days: picked, groups: mineMisses(rows, opts) };
}

/** One line per group, the examples indented — what a grammar author reads on Monday. */
export function renderMisses(days: readonly string[], groups: readonly MissGroup[]): string[] {
  const out: string[] = [];
  const total = groups.reduce((a, g) => a + g.n, 0);
  out.push(`  reflex misses over ${days.join(", ") || "the given rows"}: ${total} short clause${total === 1 ? "" : "s"} the grammar did not catch, in ${groups.length} group${groups.length === 1 ? "" : "s"}`);
  if (!groups.length) out.push("  nothing to add: every short clause parsed (or there were none)");
  for (const g of groups) {
    out.push(`  ${g.head.padEnd(12)} ×${String(g.n).padStart(3)}`);
    for (const e of g.examples) out.push(`      ${e.n > 1 ? `×${e.n} ` : ""}"${e.clause}"`);
  }
  out.push("  rule for a new row: the whole clause after stripping, no pronoun or description, idempotent or a key with an obvious inverse, never a destructive verb");
  return out;
}
