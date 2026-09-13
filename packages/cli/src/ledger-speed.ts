import type { Ledger } from "@jarhead/core";
import { READ_ONLY_TOOLS, YES_PATTERN } from "@jarhead/hands";
import type { Delegation, DelegationStep, LedgerRow } from "@jarhead/protocol";
import { ACTING_TOOLS, percentile, stat, type Stat } from "./bench-brain.ts";

/**
 * `pnpm jarhead ledger --speed [--days N]` — where a day's time went, from the ledger.
 *
 * The speed levers of the threads pass (docs/LATENCY.md §10) each promise a number this
 * report reads back after a day of use: the observation line should cut the screenshots
 * the brain takes to verify an action (45 % of acting steps were followed by one on
 * 09-12), SplitHands should hold read-only round trips under 80 ms, and the generation
 * after a screenshot should stop being the slowest kind. Everything here is counted
 * from `delegation.*` rows only — never from the words Kevin said (the requests are
 * classified, not printed). Pure analysis over rows; `ledgerSpeed` is the reader.
 */

/** A model generation is the gap between two consecutive tool steps longer than this; smaller gaps are batched calls. */
export const GENERATION_GAP_MS = 1500;

export interface SpeedReport {
  readonly days: readonly string[];
  readonly delegations: number;
  readonly finished: number;
  /** Acting steps (ACTING_TOOLS, ok) and how many were followed by a screenshot or zoom as the very next tool step. */
  readonly acting: { readonly steps: number; readonly thenShot: number; readonly shotShare: number };
  /** Acting steps whose recorded output carries an observation line (`now: …`). */
  readonly observed: { readonly steps: number; readonly withLine: number; readonly share: number };
  /** Requests that are a bare yes: each costs a generation today (the confirmation re-call). */
  readonly yesDelegations: number;
  /** The first model tool per delegation, most common first. */
  readonly firstTool: readonly { readonly tool: string; readonly n: number }[];
  /** Generation gaps by what the model had just seen. */
  readonly gaps: { readonly afterShot: Stat; readonly afterAction: Stat; readonly other: Stat };
  /** Per-step tool round trips by tool class. */
  readonly roundTrip: { readonly readOnly: Stat; readonly acting: Stat; readonly other: Stat };
  /** delegatedAt → firstActionAt, and speechEndAt → firstActionAt, ms. */
  readonly firstActionMs: Stat;
  readonly speechToActionMs: Stat;
  /** Spawned threads: how many started, ended, and their steps/seconds. */
  readonly threads: { readonly started: number; readonly ended: number; readonly seconds: Stat; readonly steps: Stat };
}

interface Turn {
  readonly delegation: Delegation;
  readonly steps: DelegationStep[];
  finished?: { readonly status: string; readonly timings: Record<string, unknown> };
}

const isShot = (s: DelegationStep): boolean => s.kind === "screenshot" || s.tool?.name === "screenshot" || s.tool?.name === "zoom";
const isActing = (s: DelegationStep): boolean => s.kind === "tool" && s.tool !== undefined && ACTING_TOOLS.has(s.tool.name) && s.tool.ok;
/** Steps the model issued: tools and shots, not its thinking, commentary or the runner's notes. */
const isToolStep = (s: DelegationStep): boolean => (s.kind === "tool" || s.kind === "screenshot") && s.tool !== undefined;
const hasObservation = (s: DelegationStep): boolean => typeof s.tool?.output === "string" && /(^|\n)now: /.test(s.tool.output);

/** The per-step tool class: read-only, acting, or the rest (shell, web, files, agents). */
export function toolClass(name: string): "readOnly" | "acting" | "other" {
  if (READ_ONLY_TOOLS.has(name)) return "readOnly";
  if (ACTING_TOOLS.has(name)) return "acting";
  return "other";
}

/** Speed facts over the rows of one or more day files (order within a day is the file's). */
export function analyzeSpeed(rows: readonly LedgerRow[], days: readonly string[] = []): SpeedReport {
  const turns = new Map<string, Turn>();
  const threadStarted = new Set<string>();
  const threadEnded: { steps: number; seconds: number }[] = [];
  for (const row of rows) {
    if (row.type === "delegation.created") turns.set(row.delegation.id, { delegation: row.delegation, steps: [...row.delegation.steps] });
    else if (row.type === "delegation.step") turns.get(row.delegationId)?.steps.push(row.step);
    else if (row.type === "delegation.finished") {
      const t = turns.get(row.delegationId);
      if (t) t.finished = { status: row.status, timings: row.timings as unknown as Record<string, unknown> };
    } else if (row.type === "thread.started") threadStarted.add(row.thread.id);
    else if (row.type === "thread.ended") threadEnded.push({ steps: row.steps, seconds: row.seconds });
  }

  let actingSteps = 0;
  let thenShot = 0;
  let withLine = 0;
  let yes = 0;
  const firstTool = new Map<string, number>();
  const gaps = { afterShot: [] as number[], afterAction: [] as number[], other: [] as number[] };
  const roundTrip = { readOnly: [] as number[], acting: [] as number[], other: [] as number[] };
  const firstAction: number[] = [];
  const speechToAction: number[] = [];
  let finished = 0;

  for (const t of turns.values()) {
    if (t.finished) finished++;
    if (YES_PATTERN.test(t.delegation.request) && t.delegation.request.trim().split(/\s+/).length <= 3) yes++;
    const tools = t.steps.filter(isToolStep).sort((a, b) => a.at - b.at);
    // The eyes' pre-warm shot lands before the brain's first step; the first MODEL tool is the first that is not it.
    const model = tools.filter((s, i) => !(i === 0 && isShot(s) && (s.text ?? "").includes("looking")));
    const first = model[0]?.tool?.name;
    if (first) firstTool.set(first, (firstTool.get(first) ?? 0) + 1);
    for (let i = 0; i < model.length; i++) {
      const s = model[i]!;
      if (s.tool) roundTrip[toolClass(s.tool.name)].push(s.tool.ms);
      if (isActing(s)) {
        actingSteps++;
        if (hasObservation(s)) withLine++;
        const next = model[i + 1];
        if (next && isShot(next)) thenShot++;
      }
      const next = model[i + 1];
      if (next) {
        const gap = next.at - s.at;
        if (gap > GENERATION_GAP_MS) (isShot(s) ? gaps.afterShot : isActing(s) ? gaps.afterAction : gaps.other).push(gap);
      }
    }
    const tm = (t.finished?.timings ?? t.delegation.timings) as { delegatedAt: number; firstActionAt?: number; speechEndAt?: number };
    if (tm.firstActionAt !== undefined) {
      firstAction.push(tm.firstActionAt - tm.delegatedAt);
      if (tm.speechEndAt !== undefined) speechToAction.push(tm.firstActionAt - tm.speechEndAt);
    }
  }

  return {
    days,
    delegations: turns.size,
    finished,
    acting: { steps: actingSteps, thenShot, shotShare: actingSteps ? thenShot / actingSteps : 0 },
    observed: { steps: actingSteps, withLine, share: actingSteps ? withLine / actingSteps : 0 },
    yesDelegations: yes,
    firstTool: [...firstTool].map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool)),
    gaps: { afterShot: stat(gaps.afterShot), afterAction: stat(gaps.afterAction), other: stat(gaps.other) },
    roundTrip: { readOnly: stat(roundTrip.readOnly), acting: stat(roundTrip.acting), other: stat(roundTrip.other) },
    firstActionMs: stat(firstAction),
    speechToActionMs: stat(speechToAction),
    threads: { started: threadStarted.size, ended: threadEnded.length, seconds: stat(threadEnded.map((t) => t.seconds * 1000)), steps: stat(threadEnded.map((t) => t.steps)) },
  };
}

/** The last `days` day files the ledger has (today counted), oldest first. */
export function recentDays(ledger: Ledger, days: number): string[] {
  const all = ledger.days().map((f) => f.replace(/\.jsonl$/, "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return all.slice(-Math.max(1, days));
}

/** Read the last N day files and analyse them together. */
export function ledgerSpeed(ledger: Ledger, days: number): SpeedReport {
  const picked = recentDays(ledger, days);
  const rows = picked.flatMap((d) => ledger.read(Date.parse(`${d}T12:00:00`)));
  return analyzeSpeed(rows, picked);
}

const ms = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : "-");
const sec = (v: number): string => (Number.isFinite(v) ? (v / 1000).toFixed(1) : "-");
const pct = (v: number): string => `${Math.round(v * 100)} %`;
const cell = (s: Stat): string => (s.n ? `median ${ms(s.median)} ms · p95 ${ms(s.p95)} ms (n=${s.n})` : "—");

/** The report as lines, with the targets the levers were built to. */
export function renderSpeed(r: SpeedReport): string[] {
  const out: string[] = [];
  out.push(`  speed over ${r.days.length ? r.days.join(", ") : "the given rows"}: ${r.delegations} delegation${r.delegations === 1 ? "" : "s"} (${r.finished} finished)`);
  out.push(`  acting step → screenshot next   ${r.acting.thenShot}/${r.acting.steps} (${pct(r.acting.shotShare)})   target ≤ 15 % — the observation line makes the verifying shot unnecessary`);
  out.push(`  acting results with a now: line ${r.observed.withLine}/${r.observed.steps} (${pct(r.observed.share)})   target ≥ 95 % with Settings.observe on`);
  out.push(`  bare-yes delegations            ${r.yesDelegations} (each costs a generation today)`);
  out.push(`  first action after delegation   ${cell(r.firstActionMs)}   after speech end ${cell(r.speechToActionMs)}`);
  out.push(`  generation gap after a shot     ${cell(r.gaps.afterShot)}`);
  out.push(`  generation gap after an action  ${cell(r.gaps.afterAction)}`);
  out.push(`  generation gap otherwise        ${cell(r.gaps.other)}`);
  out.push(`  tool round trip, read-only      ${cell(r.roundTrip.readOnly)}   target p95 ≤ 80 ms (SplitHands: a read never queues behind a type)`);
  out.push(`  tool round trip, acting         ${cell(r.roundTrip.acting)}   (includes the observation's settle when on)`);
  out.push(`  tool round trip, other          ${cell(r.roundTrip.other)}   (shell, web, files, agents)`);
  if (r.firstTool.length) out.push(`  first model tool                ${r.firstTool.slice(0, 8).map((f) => `${f.tool}×${f.n}`).join(" ")}`);
  if (r.threads.started || r.threads.ended) out.push(`  threads                         ${r.threads.started} started, ${r.threads.ended} ended; wall ${sec(r.threads.seconds.median)} s median, ${ms(r.threads.steps.median)} steps median`);
  else out.push(`  threads                         none spawned on these days`);
  return out;
}

/** Nearest-rank percentile, re-exported for the tests that check the report's numbers by hand. */
export { percentile };
