import type { MemoryKind } from "@jarhead/protocol";
import type { Candidate, Decision, ExtractInput, Neighbour } from "../types.ts";
import { tokens } from "../embed/keyword.ts";
import type { DecideContext, Decider, Extractor } from "./extractor.ts";

/**
 * The extractor that costs nothing: regexes over Kevin's own lines. It runs
 * when there is no OpenAI key, when the Responses call fails for a run, and at
 * utterance time for an explicit "remember that …" whichever extractor is
 * configured. It never reads Jarhead's lines and never marks contradictions
 * (a documented limit of rules mode: a reversal lands as newest-wins UPDATE).
 *
 * Shapes are deliberately narrow: this runs over ordinary voice chatter, and a
 * false memory steers the spoken prompt until Kevin notices — "never mind",
 * "call me back", "I like that" must produce nothing (see the deny lists).
 */

const MAX_CANDIDATES = 8;

/** Wake words and politeness at the head and tail, punctuation at the tail; case kept so names survive. */
function clean(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:hey|ok|okay|hi|yo)[,.!]?\s+)?(?:jarhead|jar head|jarred|jared)[,.!]?\s*/i, "")
    .replace(/^(?:please|could you|can you|would you)[,]?\s+/i, "")
    .replace(/[.!?,;:\s]+$/g, "")
    .replace(/,?\s+please$/i, "")
    .replace(/[.!?,;:\s]+$/g, "")
    .trim();
}

const capitalize = (s: string): string => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

const CONTACT_NOUNS = new Set(["dentist", "doctor", "wife", "husband", "partner", "girlfriend", "boyfriend", "boss", "manager", "mom", "mum", "mother", "dad", "father", "brother", "sister", "friend", "roommate", "dog", "cat", "cofounder", "co-founder", "assistant", "landlord", "barber", "therapist", "accountant", "lawyer"]);
const PLACE_NOUNS = new Set(["office", "home", "apartment", "house", "gym", "school", "studio", "workplace", "desk", "coworking space", "campus", "hometown"]);

const PREFER_VERBS: Record<string, string> = {
  prefer: "prefers", like: "likes", love: "loves", hate: "dislikes", "don't like": "dislikes", "dont like": "dislikes", "can't stand": "cannot stand", "cant stand": "cannot stand",
  always: "always", never: "never", usually: "usually",
};

/** "call me back", "call me later", "call me when it's done" are not names: no word of a name may be one of these. */
const NAME_DENY = new Set([
  "back", "later", "when", "whenever", "tomorrow", "today", "tonight", "after", "before", "if", "at", "in", "on", "now", "soon", "again", "once", "please", "maybe", "asap",
  "about", "around", "then", "anytime", "sometime", "sometimes", "first", "last", "immediately", "directly", "up", "out", "by", "to", "for", "with", "and", "or", "a", "an", "the",
  "it", "that", "this", "me", "you", "him", "her", "them", "anything", "whatever", "something", "what", "how", "what's", "instead", "already", "right", "straight",
]);
/** "I like that", "I don't like it", "I prefer this one": an object that only points at the conversation is nothing to remember. */
const OBJECT_PRONOUNS = new Set(["that", "it", "this", "them", "those", "these", "so", "you", "him", "her", "one", "everything", "nothing"]);
/** "I never said that", "I always forget", "I think so": speech and memory verbs describe the moment, not Kevin. */
const SPEECH_VERBS = new Set(["said", "say", "says", "saying", "forget", "forgot", "forgetting", "mean", "meant", "think", "thought", "know", "knew", "guess", "guessed", "remember", "remembered", "suppose", "supposed", "wonder", "wondered", "told", "tell", "asked", "ask", "figured", "assumed", "assume", "believe", "believed"]);

const RE_REMEMBER = /^(?:remember|note|keep in mind)(?: that)?\s+(.{8,200})$/i;
const RE_PREFER = /^i (prefer|like|love|hate|don'?t like|can'?t stand|always|never|usually)\s+(.+)$/i;
/** One to three words, each starting with a letter. */
const RE_NAME = /^(?:call me|my name is|i go by)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})$/i;
const RE_MY_X_IS = /^my ([a-z][a-z -]{0,30}?) is (?:called |named )?(.{2,80})$/i;
const RE_FROM_NOW = /^(?:from now on|going forward|in (?:the )?future),?\s+(.+)$/i;
/** At least three words after always/never with two content words among them, and never "never mind …": chatter is not a procedure. */
const RE_ALWAYS = /^(always|never)\s+(\S+(?:\s+\S+){2,})$/i;
const RE_SPEAK = /^(?:speak|answer|reply|talk)(?: to me)?(?: only)? in ([a-z]+)$/i;
const RE_I_AM_FULL = /^(?:i'?m|i am)\s+(.+)$/i;
const RE_MY = /^my (.+)$/i;

/** ≤ 5 lowercase content tokens, the item's tags. */
export function subjectsOf(text: string): string[] {
  return [...tokens(text)].slice(0, 5);
}

interface Shape {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly importance: number;
  readonly confidence: number;
}

const firstWord = (s: string): string => (s.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z']/g, "");
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** An object worth a preference: not a bare pronoun, not a verb of speech or memory. */
function preferenceObjectOk(object: string): boolean {
  const first = firstWord(object);
  if (!first) return false;
  if (SPEECH_VERBS.has(first)) return false;
  if (OBJECT_PRONOUNS.has(first) && wordCount(object) <= 3) return false;
  return tokens(object).size >= 1;
}

/** The first-person patterns as third-person sentences about `who`; undefined when none fits. */
function shapeOf(t: string, who: string): Shape | undefined {
  let m = RE_PREFER.exec(t);
  if (m && preferenceObjectOk(m[2]!)) {
    const verb = PREFER_VERBS[m[1]!.toLowerCase().replace(/'/g, "")] ?? PREFER_VERBS[m[1]!.toLowerCase()] ?? m[1]!;
    return { kind: "preference", text: `${who} ${verb} ${m[2]!}`, importance: 0.6, confidence: 0.7 };
  }
  m = RE_NAME.exec(t);
  if (m && !m[1]!.split(/\s+/).some((w) => NAME_DENY.has(w.toLowerCase()))) return { kind: "fact", text: `${who} goes by ${capitalize(m[1]!.trim())}`, importance: 1.0, confidence: 0.9 };
  m = RE_MY_X_IS.exec(t);
  if (m) {
    const noun = m[1]!.toLowerCase().trim();
    const kind: MemoryKind = CONTACT_NOUNS.has(noun) ? "contact" : PLACE_NOUNS.has(noun) ? "place" : "fact";
    return { kind, text: `${who}'s ${noun} is ${m[2]!}`, importance: 0.6, confidence: 0.7 };
  }
  m = RE_FROM_NOW.exec(t);
  if (m) return { kind: "procedure", text: `How ${who} likes it done: ${m[1]!}`, importance: 0.8, confidence: 0.8 };
  m = RE_ALWAYS.exec(t);
  if (m && !/^mind\b/i.test(m[2]!) && tokens(m[2]!).size >= 2) return { kind: "procedure", text: `How ${who} likes it done: ${m[1]!.toLowerCase()} ${m[2]!}`, importance: 0.8, confidence: 0.8 };
  m = RE_SPEAK.exec(t);
  if (m) return { kind: "preference", text: `${who} wants answers in ${capitalize(m[1]!.toLowerCase())}`, importance: 1.0, confidence: 0.9 };
  return undefined;
}

/** The "remember" capture, rewritten to the third person when a pattern fits, else recorded as asked. */
function rememberShape(sub: string, who: string): Shape {
  const s = shapeOf(sub, who);
  if (s) return { ...s, importance: 0.9, confidence: 0.9 };
  let m = RE_I_AM_FULL.exec(sub);
  if (m) return { kind: "fact", text: `${who} is ${m[1]!}`, importance: 0.9, confidence: 0.9 };
  m = RE_MY.exec(sub);
  if (m) return { kind: "fact", text: `${who}'s ${m[1]!}`, importance: 0.9, confidence: 0.9 };
  return { kind: "fact", text: `${who} asked Jarhead to remember: ${sub}`, importance: 0.9, confidence: 0.9 };
}

export class RulesExtractor implements Extractor {
  readonly kind = "rules" as const;

  /** `userName`: what the third-person sentences call him ("<Name> prefers …"); default "Kevin". */
  constructor(private readonly userName = "Kevin") {}

  /**
   * One of Kevin's lines → a candidate, or undefined when no rule fits. Kevin's
   * words only: a line of Jarhead's must never be passed here. `userName` is the
   * subject of the sentence minted.
   */
  static classify(kevinLine: string, userName = "Kevin"): Candidate | undefined {
    const t = clean(kevinLine);
    if (t.length < 4) return undefined;
    const rem = RE_REMEMBER.exec(t);
    if (rem) {
      const s = rememberShape(rem[1]!.trim(), userName);
      return { kind: s.kind, text: s.text, subjects: subjectsOf(s.text), importance: s.importance, confidence: s.confidence, evidence: [], origin: "kevin" };
    }
    const s = shapeOf(t, userName);
    if (!s) return undefined;
    return { kind: s.kind, text: s.text, subjects: subjectsOf(s.text), importance: s.importance, confidence: s.confidence, evidence: [], origin: "extracted" };
  }

  async extract(input: ExtractInput): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const line of input.lines) {
      if (line.speaker !== "Kevin") continue;
      const c = RulesExtractor.classify(line.text, this.userName);
      if (!c) continue;
      out.push({ ...c, evidence: [line.n] });
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }
}

/** Word pairs whose swap turns a sentence into its reversal. */
const ANTONYMS: readonly (readonly [string, string])[] = [
  ["dark", "light"], ["short", "long"], ["on", "off"], ["always", "never"], ["more", "less"], ["early", "late"], ["morning", "evening"],
  ["yes", "no"], ["loud", "quiet"], ["fast", "slow"], ["big", "small"], ["high", "low"], ["open", "closed"], ["enable", "disable"],
  ["like", "dislike"], ["before", "after"], ["first", "last"], ["left", "right"], ["up", "down"], ["in", "out"], ["hot", "cold"],
  ["formal", "casual"], ["brief", "detailed"], ["metric", "imperial"], ["tab", "space"],
];

/** The table as the tokenizer would see it ("always" stems to "alway"); a pair whose word is a stop word never fires. */
const ANTONYM_KEYS: ReadonlySet<string> = new Set(
  ANTONYMS.flatMap(([p, q]) => {
    const a = [...tokens(p)][0];
    const b = [...tokens(q)][0];
    return a && b ? [`${a}|${b}`, `${b}|${a}`] : [];
  }),
);

/** The two texts share every content token but one, and the odd pair is an antonym pair: "prefers dark mode" ↔ "prefers light mode". */
export function isReversal(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (onlyA.length !== 1 || onlyB.length !== 1 || ta.size < 2) return false;
  return ANTONYM_KEYS.has(`${onlyA[0]!}|${onlyB[0]!}`);
}

/**
 * Rules-mode decisions: above the embedder's update threshold the newest words
 * win (an UPDATE that keeps `prev.text` in the log — a reversal is never a
 * silent touch); in the band, a one-word antonym swap is a reversal and updates
 * the same way. Either way an antonym swap is marked `replaces`, so the item's
 * evidence restarts with the new words instead of folding the old count onto
 * them. Anything else in the band is a different thing (ADD). Other
 * contradictions are not detected here; the Responses decider does that.
 */
export class RulesDecider implements Decider {
  readonly kind = "rules" as const;

  async decide(candidate: Candidate, neighbours: readonly Neighbour[], ctx: DecideContext): Promise<Decision> {
    const top = neighbours[0];
    if (!top) return { op: "ADD", contradicts: false };
    const reversal = top.item.kind === candidate.kind && isReversal(top.item.text, candidate.text);
    if (top.sim >= ctx.thresholds.update) return { op: "UPDATE", target: top.item.id, text: candidate.text, contradicts: false, replaces: reversal };
    if (top.sim >= ctx.thresholds.band && reversal) return { op: "UPDATE", target: top.item.id, text: candidate.text, contradicts: false, replaces: true };
    return { op: "ADD", contradicts: false };
  }
}
