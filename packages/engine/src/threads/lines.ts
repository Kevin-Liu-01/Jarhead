import { progressLine } from "@jarhead/brain";
import { MAIN_THREAD_ID, type Thread, type ThreadLane } from "@jarhead/protocol";

/**
 * The words a thread gets and the words Kevin hears about one. Deterministic
 * English from the table, never a model: "what is Spotify doing" costs microseconds
 * and never touches the running turn. Every line Kevin hears is cut to
 * THREAD_LINE_CHARS; the brief a thread's brain reads rides in the task's dialogue
 * slot, never in `request` (the gates read that as Kevin's words).
 */

/** The lines Kevin hears are short: a summary or a reason is cut here. */
export const THREAD_LINE_CHARS = 80;

/** A phrase the status line quotes ("playing Focus") is cut here. */
export const PHRASE_CHARS = 40;

export function cutLine(text: string | undefined, max = THREAD_LINE_CHARS): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * What a thread's brain is told, in the dialogue slot. The lane rules, the one
 * job, the spoken-progress budget, depth one, and Kevin's own words for the gates.
 * Byte-identical developer instructions across every process keep the prompt
 * cache warm (REDESIGN.md §18): nothing per thread goes anywhere but this text.
 */
export function threadBrief(name: string, task: string, lane: ThreadLane, parentRequest: string, userName = "Kevin"): string {
  const laneText =
    lane === "background"
      ? "Lane: background — you have no pointer, keyboard or front app. Act through applescript (Apple events: Spotify, Music, Finder, Notes, Calendar…), the browser_* tools, the file tools, run_shell (never `open` an app or `osascript`) and the web. A tool that needs the screen is refused: do the rest and report that the screen is needed."
      : 'Lane: screen — you may click and type once the screen is yours; a tool that answers "waiting for the screen" means do the rest first, or call it again.';
  return `Jarhead (to its thread ${name}): You are one of Jarhead's threads, named ${name}. Your one job: ${task.trim()} ${laneText} speak_progress speaks once per turn, as "${name}: …" — use it for one thing worth hearing, otherwise work in silence and end with one sentence of what you did; Jarhead speaks it for you. Never call thread_* or self_*. ${userName}'s own words, for names and gates: "${parentRequest.replace(/\s+/g, " ").trim().slice(0, 400)}".`;
}

/** "<Name> said yes": the resume text a confirmation turn appends to the brief. */
export function confirmationResume(userName = "Kevin"): string {
  return `\n\nJarhead (to its thread): ${userName} said yes. Call the same tool again with exactly the same arguments, then finish your job.`;
}

/** The default's text, for the pins. */
export const CONFIRMATION_RESUME: string = confirmationResume("Kevin");

/** The continuation text after a pause. */
export function resumeText(steps: number, userName = "Kevin"): string {
  return `\n\nJarhead (to its thread): ${userName} paused you at step ${steps}; carry on from where you were.`;
}

/**
 * The phrase a tool step gives the status line ("opening Slack", "typing …"):
 * the spoken progress line without its full stop, lower-cased at the head. A
 * tool the voice has no words for gives nothing (the line then says "working").
 */
export function phraseForTool(name: string, input: unknown): string | undefined {
  const line = progressLine(name, input).replace(/\.\s*$/, "");
  // The voice's fallback for a tool it has no words for is "Checking <tool name>": not a phrase Kevin should hear.
  if (!line || line === `Checking ${name.replace(/_/g, " ")}`) return undefined;
  return lowerFirst(cutLine(line, PHRASE_CHARS));
}

/** A fragment that opens like this continues a sentence ("and now the volume"): not a phrase. */
const CONTINUATION = /^(?:and|or|but|then|also|so|because|which|that|as|if|when|while|until|after|before)\b/i;
/** Words that end in -ing without saying what is being done. */
const NOT_A_DOING_WORD: ReadonlySet<string> = new Set(["nothing", "something", "anything", "everything", "thing", "string", "during", "bring", "sing", "ring", "king", "wing", "morning", "evening", "spring", "ceiling", "building", "meeting", "setting", "warning"]);

/**
 * A spoken/commentary line as a status phrase, only when it reads after "<Name> is":
 * "Playing Focus." → "playing Focus"; "I am pressing play now" → "pressing play now".
 * A fragment ("and now the volume"), a single word ("done") or a line that opens with
 * no doing-word gives nothing — the status line keeps its last phrase or says "working"
 * rather than speak nonsense.
 */
export function phraseForLine(text: string): string | undefined {
  const bare = cutLine(text.replace(/^[^:]{1,16}:\s+/, ""), PHRASE_CHARS)
    .replace(/[.!]\s*$/, "")
    .replace(/^(?:i am|i'm|i’m|now)\s+/i, "");
  return readsAsDoing(bare) ? lowerFirst(bare) : undefined;
}

/** Two words at least, a doing-word (-ing) first, not a continuation. */
function readsAsDoing(s: string): boolean {
  if (!s || CONTINUATION.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const head = words[0]!.toLowerCase().replace(/[^a-z']/g, "");
  return head.length > 4 && head.endsWith("ing") && !NOT_A_DOING_WORD.has(head);
}

function lowerFirst(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}

function secondsIn(t: Thread, now: number): number {
  return Math.max(0, Math.round((now - t.startedAt) / 1000));
}

function secondsAgo(t: Thread, now: number): number {
  return Math.max(0, Math.round((now - (t.doneAt ?? t.updatedAt)) / 1000));
}

/**
 * One deterministic line for one thread. `phrase` is what the thread last said it
 * was doing (the table keeps it beside the record). Examples the voice speaks:
 * "Spotify is playing Focus — 12 seconds in", "Slack is waiting on you: send it to
 * Ben?", "Spotify finished 12 seconds ago — playing Focus".
 */
export function threadLine(t: Thread, now: number, phrase?: string): string {
  const name = t.id === MAIN_THREAD_ID ? "the main thread" : t.name;
  const s = secondsIn(t, now);
  switch (t.status) {
    case "idle":
      return `${name} is idle`;
    case "queued":
    case "starting":
      return `${name} is starting`;
    case "thinking":
      return cutLine(`${name} is ${phrase ?? "thinking"} — ${s} seconds in`);
    case "acting":
      return cutLine(`${name} is ${phrase ?? "working"} — ${s} seconds in`);
    case "waiting-screen":
      return `${name} is waiting for the screen — ${s} seconds in`;
    case "waiting-kevin":
      return cutLine(t.question ? `${name} is waiting on you: ${lowerFirst(t.question)}` : `${name} is waiting on your yes`);
    case "paused":
      return `${name} is paused at step ${t.steps}`;
    case "done":
      return cutLine(`${name} finished ${secondsAgo(t, now)} seconds ago${t.detail ? ` — ${phraseForLine(t.detail) ?? t.detail}` : ""}`);
    case "failed":
      return cutLine(`${name} failed${t.detail ? `: ${t.detail}` : ""}`);
    case "stopped":
      return `${name} was stopped`;
  }
}

/** The short word for the overview line: "Slack waiting on you, Spotify done". */
export function shortStatus(t: Thread): string {
  switch (t.status) {
    case "idle":
      return "idle";
    case "queued":
    case "starting":
      return "starting";
    case "thinking":
      return "thinking";
    case "acting":
      return "working";
    case "waiting-screen":
      return "waiting for the screen";
    case "waiting-kevin":
      return "waiting on you";
    case "paused":
      return "paused";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

/** Main alone and busy, in the first person: "I am working on it — 24 seconds in", "I am waiting on your yes: send it?". */
export function mainLine(main: Thread, now: number): string {
  const s = secondsIn(main, now);
  switch (main.status) {
    case "thinking":
    case "acting":
      return `I am working on it — ${s} seconds in`;
    case "waiting-kevin":
      return cutLine(main.question ? `I am waiting on your yes: ${lowerFirst(main.question)}` : "I am waiting on your yes");
    case "waiting-screen":
      return `I am waiting for the screen — ${s} seconds in`;
    case "paused":
      return "I am paused";
    case "queued":
    case "starting":
      return "I am starting";
    default:
      return "nothing is running";
  }
}

/**
 * The overview when no name was asked: nothing live → "nothing is running"; one
 * spawned thread → its own line; several → "Two threads: Slack waiting on you,
 * Spotify working". The main thread speaks for itself only when it is busy and alone.
 */
export function overviewLine(live: readonly Thread[], now: number, phrases: (id: string) => string | undefined): string {
  const spawned = live.filter((t) => t.id !== MAIN_THREAD_ID);
  const main = live.find((t) => t.id === MAIN_THREAD_ID);
  if (spawned.length === 0) return main ? mainLine(main, now) : "nothing is running";
  if (spawned.length === 1) return threadLine(spawned[0]!, now, phrases(spawned[0]!.id));
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  const count = words[spawned.length] ?? String(spawned.length);
  return cutLine(`${count[0]!.toUpperCase()}${count.slice(1)} threads: ${spawned.map((t) => `${t.name} ${shortStatus(t)}`).join(", ")}`);
}

/** Nothing by that name: say who IS running, so the next question lands. */
export function unknownNameLine(name: string, live: readonly Thread[]): string {
  const others = live.filter((t) => t.id !== MAIN_THREAD_ID).map((t) => t.name);
  if (others.length === 0) return `nothing called ${name} is running`;
  return cutLine(`nothing called ${name} is running; ${joinNames(others)} ${others.length === 1 ? "is" : "are"}`);
}

/** "Slack", "Slack and Spotify", "Slack, Spotify and Mail". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
