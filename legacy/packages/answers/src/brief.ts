import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Daily briefing, read out of the wiki's briefd projection.
 *
 * Honesty note carried from the research: today's brief is a governance and
 * review-queue projection, not news or calendar. The narration must not dress
 * it up as more than it is — the news half of "what's my briefing" comes from
 * the Hacker News arm instead.
 *
 * We read the projection file directly rather than importing BriefService,
 * because `compile()` is slow and belongs on jarvisd's morning timer, not on
 * a live voice turn. Reading is a filesystem hit; compiling is not.
 */

export interface BriefSnapshot {
  readonly found: boolean;
  readonly path: string | undefined;
  readonly generatedAt: string | undefined;
  readonly ageDays: number | undefined;
  readonly context: string;
}

/**
 * `generated/runtime/brief` is where BriefService actually writes — verified in
 * `apps/briefd/src/service.ts:54`. The rest are fallbacks in case the layout
 * moves under the ongoing v2 rebuild.
 */
const CANDIDATE_DIRS = [
  "generated/runtime/brief",
  "generated/brief",
  "generated/projections",
  "outputs/brief",
  ".kw/brief",
] as const;

function newestJson(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return entries[0];
}

export function readBrief(wikiRoot: string): BriefSnapshot {
  let path: string | undefined;
  for (const dir of CANDIDATE_DIRS) {
    path = newestJson(join(wikiRoot, dir));
    if (path) break;
  }

  if (!path) {
    return {
      found: false,
      path: undefined,
      generatedAt: undefined,
      ageDays: undefined,
      context: "No brief projection has been compiled yet.",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return {
      found: false,
      path,
      generatedAt: undefined,
      ageDays: undefined,
      context: `The brief projection at ${path} could not be parsed: ${(e as Error).message}`,
    };
  }

  const generatedAt =
    (parsed["generatedAt"] as string | undefined) ??
    (parsed["requestedAt"] as string | undefined) ??
    new Date(statSync(path).mtimeMs).toISOString();

  const ageDays = Math.floor((Date.now() - new Date(generatedAt).getTime()) / 86_400_000);

  return {
    found: true,
    path,
    generatedAt,
    ageDays: Number.isFinite(ageDays) ? ageDays : undefined,
    context: summarize(parsed, ageDays),
  };
}

function summarize(brief: Record<string, unknown>, ageDays: number): string {
  const lines: string[] = [];

  if (Number.isFinite(ageDays) && ageDays > 1) {
    lines.push(`NOTE: this brief is ${ageDays} days old. Say so before summarizing it.`);
  }

  const counts = brief["counts"];
  if (counts && typeof counts === "object") {
    const pairs = Object.entries(counts as Record<string, unknown>)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `${k}: ${String(v)}`);
    if (pairs.length > 0) lines.push(`Counts — ${pairs.join(", ")}`);
  }

  const cards = brief["cards"];
  if (Array.isArray(cards)) {
    lines.push(`${cards.length} items:`);
    for (const c of cards.slice(0, 8)) {
      if (!c || typeof c !== "object") continue;
      const card = c as Record<string, unknown>;
      const title = String(card["title"] ?? card["slug"] ?? "untitled");
      const why = card["explanation"] ?? card["reason"] ?? card["summary"];
      lines.push(why ? `- ${title}: ${String(why).slice(0, 200)}` : `- ${title}`);
    }
  }

  if (lines.length === 0) {
    // Better to hand the model raw truth than to silently narrate nothing.
    lines.push(`Raw projection keys: ${Object.keys(brief).join(", ")}`);
  }

  lines.push(
    "This projection covers wiki governance and the review queue. It does not include calendar or email.",
  );

  return lines.join("\n");
}
