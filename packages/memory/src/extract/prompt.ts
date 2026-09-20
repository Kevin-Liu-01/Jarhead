import type { MemoryItem } from "@jarhead/protocol";
import type { Candidate, ExtractInput, Neighbour } from "../types.ts";

/** The Responses `instructions` for extraction — durable things about the user, one sentence each, with evidence; `userName` is what the transcript calls him. */
export function extractInstructions(userName = "Kevin"): string {
  return EXTRACT_TEMPLATE.replaceAll("Kevin", userName);
}
/** The instructions as written, with the author's name; `extractInstructions` substitutes it. */
export const EXTRACT_INSTRUCTIONS: string = `You maintain Jarhead's durable memory of Kevin, the one person it works for. You read a transcript of one voice conversation between Kevin and Jarhead (his Mac assistant) and return only what is worth knowing about Kevin NEXT WEEK: standing preferences, stable facts about him and his world, how he wants recurring tasks done, people and places he refers to by name, and notable episodes worth recalling later.

Rules.
1. One sentence per item, third person, present tense, at most 200 characters, starting with "Kevin", the named person, or the named place: "Kevin prefers …", "Kevin's dentist is …", "How Kevin likes it done: …".
2. Only durable things. Skip the task at hand, what is on the screen, transient states ("Kevin is in a meeting now"), Jarhead's own actions and guesses, greetings, and anything Kevin said only as an answer to a confirmation question.
3. Evidence: every item cites the line numbers it comes from, and at least one cited line must be Kevin's ("Kevin:"). Jarhead's lines are context, never a source on their own.
4. Never record secrets or credentials (keys, passwords, codes, card or account numbers, one-time codes), health details, or anything Kevin asked not to remember. Contact details (phone, email, address) only when Kevin explicitly asked Jarhead to remember them.
5. kind: preference (how he likes things), fact (about him or his world), procedure (how a recurring task is done, as steps in one sentence), contact (a person: who they are to Kevin), place (a location and what it is to him), episode (a dated thing that happened, worth recalling; say when).
6. importance 1 to 5: 5 shapes most interactions (his name, his language, how brief he wants answers); 3 is useful sometimes; 1 is trivia. confidence 0 to 1: how sure the transcript makes you (a hedge or a likely mishearing lowers it).
7. Return an empty list when nothing qualifies. Do not invent, generalise or embellish.`;
const EXTRACT_TEMPLATE = EXTRACT_INSTRUCTIONS;

/** Used only when a candidate sits in the similarity band, or above it with different words. */
export const DECIDE_INSTRUCTIONS = `Jarhead's memory already holds items close to a new candidate. Decide one of: UPDATE when the candidate is the same thing said again or said more precisely (give the single best merged sentence, third person, at most 200 characters); NOOP when the candidate adds nothing; ADD when it is a different thing. Set contradicts to true when the candidate reverses or replaces an existing item; then op is ADD and target is the item it replaces.`;

export const EXTRACT_SCHEMA_NAME = "memory_candidates";
/** Candidates per run; the schema says so and `extract` cuts there too (the schema's bounds may be stripped, see stripBounds). */
export const EXTRACT_MAX_ITEMS = 24;
export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: EXTRACT_MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text", "subjects", "importance", "confidence", "evidence"],
        properties: {
          kind: { type: "string", enum: ["preference", "fact", "episode", "procedure", "contact", "place"] },
          text: { type: "string" },
          subjects: { type: "array", maxItems: 5, items: { type: "string" } },
          importance: { type: "integer", minimum: 1, maximum: 5 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", minItems: 1, maxItems: 6, items: { type: "integer" } },
        },
      },
    },
  },
} as const;

export const DECIDE_SCHEMA_NAME = "memory_decision";
export const DECIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["op", "target", "text", "contradicts"],
  properties: {
    op: { type: "string", enum: ["ADD", "UPDATE", "NOOP"] },
    target: { type: "string" },
    text: { type: "string" },
    contradicts: { type: "boolean" },
  },
} as const;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The user content: the numbered conversation (the user's lines labelled with his name), then what Jarhead worked on. */
export function renderExtractUser(input: ExtractInput, userName = "Kevin"): string {
  const parts = [`Conversation on ${input.day} (${userName}'s local day), lines numbered:`, ...input.lines.map((l) => `${l.n} ${l.speaker === "Kevin" ? userName : l.speaker}: ${l.text}`)];
  if (input.requests.length > 0) {
    parts.push("Requests Jarhead worked on and how they ended:");
    for (const r of input.requests) parts.push(`- "${clip(r.request, 160)}" — ${r.status}${r.summary ? `: ${clip(r.summary, 200)}` : ""}`);
  }
  return parts.join("\n");
}

const LETTERS = "ABCDEFGHIJ";

export function renderDecideUser(c: Candidate, neighbours: readonly Neighbour[], now: number): string {
  const lines = [`Candidate: ${c.text} (kind ${c.kind}, importance ${Math.round(c.importance * 5)})`, "Existing:"];
  neighbours.forEach((n, i) => {
    const it: MemoryItem = n.item;
    const days = Math.max(0, Math.round((now - it.lastSeenAt) / 86_400_000));
    lines.push(`${LETTERS[i] ?? String(i)} [${it.id}] ${it.text} (${it.kind}, last seen ${days} days ago, seen ${it.seenCount} times)`);
  });
  return lines.join("\n");
}

const BOUND_KEYWORDS = new Set(["minItems", "maxItems", "minimum", "maximum"]);

/**
 * The same schema without array/number bounds. OpenAI's strict validator grew
 * support for these keywords piecemeal; if the API of the day rejects them the
 * extractor asks once more with this shape — every bound is enforced again by
 * the post-filter (importance clamped, evidence must cite a Kevin line, ≤ 24
 * items), so nothing is lost but a hint to the model.
 */
export function stripBounds(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripBounds);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (BOUND_KEYWORDS.has(k)) continue;
    out[k] = stripBounds(v);
  }
  return out;
}
