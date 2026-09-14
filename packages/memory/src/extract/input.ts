import type { LedgerRow } from "@jarhead/protocol";
import type { Redact } from "../redact.ts";
import type { Exclusion, ExtractInput, ExtractLine, ExtractRequest } from "../types.ts";

export const EXTRACT_INPUT_CHARS = 24_000;
/** Jarhead's line inside this window after a confirm step is the question; the short heard line after it is the answer. */
const CONFIRM_WINDOW_MS = 15_000;
const CONFIRM_ANSWER_WORDS = 4;
const REQUEST_CHARS = 160;
const SUMMARY_CHARS = 200;

export interface BuildExtractInputOptions {
  /** Kevin's local day (YYYY-MM-DD); derived from the first row when absent. */
  readonly day?: string;
  /** The watermark: rows at or before it were read already. */
  readonly sinceAt?: number;
  /** Forget-reflex windows: rows inside never feed an extractor. */
  readonly exclusions?: readonly Exclusion[];
  /** The runner's redactor; a line it changes is dropped. */
  readonly redact: Redact;
  /** Memory's own shapes (`refuseReason`, or a stricter caller's); a reason drops the line. */
  readonly refuse: (text: string) => string | undefined;
  readonly maxChars?: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** YYYY-MM-DD in local time, the ledger's day convention. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * One session's ledger rows → the extractor's numbered input, with everything
 * memory must never read taken out first: grant rows, tool payloads
 * (delegation.step), the confirmation question and its short answer, rows Kevin
 * cleared from view (now.cleared without a later now.restored), rows inside a
 * forget window, rows the watermark already covered, and every line the
 * redactor or a refusal shape touched (dropped, never masked). The char cap
 * takes the OLDEST lines first: a longer delta is read in slices, each one
 * advancing the watermark.
 */
export function buildExtractInput(rows: readonly LedgerRow[], opts: BuildExtractInputOptions): ExtractInput {
  const maxChars = opts.maxChars ?? EXTRACT_INPUT_CHARS;
  const sinceAt = opts.sinceAt ?? 0;
  const sorted = [...rows].sort((a, b) => a.at - b.at);

  // The latest clear not undone by a later restore hides everything at or before it.
  let clearedUpTo = 0;
  for (const r of sorted) {
    if (r.type === "now.cleared") clearedUpTo = Math.max(clearedUpTo, r.at);
    else if (r.type === "now.restored") clearedUpTo = 0;
  }

  const confirmAts = sorted.filter((r) => r.type === "delegation.step" && r.step.kind === "confirm").map((r) => r.at);
  const excluded = new Set<number>(); // indexes into `sorted`
  for (const c of confirmAts) {
    let saidIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]!;
      if (r.type === "said" && r.at >= c && r.at <= c + CONFIRM_WINDOW_MS) {
        excluded.add(i);
        if (saidIdx < 0) saidIdx = i;
      }
    }
    const from = saidIdx >= 0 ? saidIdx : sorted.findIndex((r) => r.at > c);
    if (from < 0) continue;
    for (let i = from; i < sorted.length; i++) {
      const r = sorted[i]!;
      if (r.type !== "heard") continue;
      if (words(r.item.text) <= CONFIRM_ANSWER_WORDS) excluded.add(i);
      break;
    }
  }

  // Redact-then-drop with the injected shapes: a line the redactor changed is dropped whole (never masked), then the caller's refusal shapes drop the rest.
  const drop = (text: string): { readonly text: string } | { readonly dropped: string } => {
    const r = opts.redact(text);
    if (r !== text) return { dropped: "redactor changed the line" };
    const why = opts.refuse(r);
    return why ? { dropped: why } : { text: r };
  };
  const inWindow = (at: number): boolean => (opts.exclusions ?? []).some((e) => at >= e.from && at <= e.to);
  const eligible = (at: number): boolean => at > sinceAt && at > clearedUpTo && !inWindow(at);

  let day = opts.day;
  let upToAtAll = sinceAt;
  let dropped = 0;
  const lines: ExtractLine[] = [];
  const created = new Map<string, { request: string; at: number }>();
  const requests: ExtractRequest[] = [];

  sorted.forEach((r, i) => {
    if (r.at > upToAtAll && r.at > sinceAt) upToAtAll = r.at;
    day ??= localDay(r.at);
    if (!eligible(r.at) || excluded.has(i)) return;
    switch (r.type) {
      case "heard":
      case "said": {
        if (r.item.final === false) return;
        const text = r.item.text.trim().replace(/\s+/g, " ");
        if (!text) return;
        const out = drop(text);
        if ("dropped" in out) {
          dropped++;
          return;
        }
        lines.push({ n: 0, speaker: r.type === "heard" ? "Kevin" : "Jarhead", text: out.text, at: r.at });
        return;
      }
      case "delegation.created": {
        const out = drop(r.delegation.request.trim().replace(/\s+/g, " "));
        if ("dropped" in out) {
          dropped++;
          return;
        }
        created.set(r.delegation.id, { request: out.text.slice(0, REQUEST_CHARS), at: r.at });
        return;
      }
      case "delegation.finished": {
        const c = created.get(r.delegationId);
        if (!c) return;
        let summary: string | undefined;
        if (r.summary) {
          const out = drop(r.summary.trim().replace(/\s+/g, " "));
          if ("dropped" in out) dropped++;
          else summary = out.text.slice(0, SUMMARY_CHARS);
        }
        requests.push({ request: c.request, status: r.status, ...(summary ? { summary } : {}), at: r.at });
        return;
      }
      default:
        // grant, delegation.step, problem, agent, … are never a source — nor is any row type this
        // switch does not name: the `worker` rows in day files from before 2026-09-13 are skipped here.
        return;
    }
  });

  // Oldest first up to the cap; what does not fit waits for the next slice.
  let chars = 0;
  let truncated = false;
  const kept: ExtractLine[] = [];
  for (const l of lines) {
    const cost = l.text.length + 12;
    if (chars + cost > maxChars && kept.length > 0) {
      truncated = true;
      break;
    }
    chars += cost;
    kept.push(l);
  }
  const upToAt = truncated ? kept[kept.length - 1]!.at : upToAtAll;
  const keptRequests = requests.filter((r) => r.at <= upToAt);
  const numbered = kept.map((l, i) => ({ ...l, n: i + 1 }));

  return {
    day: day ?? localDay(sinceAt || Date.now()),
    lines: numbered,
    requests: keptRequests,
    kevinLines: numbered.filter((l) => l.speaker === "Kevin").length,
    pendingKevinLines: lines.filter((l) => l.speaker === "Kevin").length,
    upToAt,
    truncated,
    dropped,
  };
}
