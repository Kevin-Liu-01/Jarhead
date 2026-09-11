import type { DelegationStep, Delegation } from "@jarhead/protocol";

/**
 * A brain does the work Live delegates. It never speaks to the socket directly:
 * it reports through a sink, and the orchestrator decides what reaches Live and
 * in what shape. That keeps the three brains interchangeable.
 */

export interface BrainTask {
  /** Live's delegation id, for correlation. */
  readonly delegationId: string;
  /** Kevin's request(s) that led to this delegation, most recent last. */
  readonly request: string;
  /** Recent dialogue for context, oldest first. */
  readonly dialogue: string;
  /** True when Kevin's latest utterance is a yes to a pending confirmation. */
  readonly confirmation: boolean;
  /** Session-timeline ms at delegation. */
  readonly offsetMs: number;
  readonly signal: AbortSignal;
  /** Images that go in with the task: the regions Kevin circled on screen since the last delegation. */
  readonly attachments?: readonly BrainAttachment[];
}

/** An image handed to a brain with its task — a PNG on this Mac and what it shows. */
export interface BrainAttachment {
  /** Absolute path. */
  readonly path: string;
  readonly mediaType: "image/png";
  /** For the model: "Kevin circled this region of his screen: x,y w×h (global points)". */
  readonly note: string;
}

export interface BrainSink {
  /** Silent progress, becomes session.thinking.append. */
  thinking(text: string): void;
  /** Something to say now, becomes session.commentary.append. */
  commentary(text: string): void;
  /** A tool ran. Recorded for the Console. */
  step(step: Omit<DelegationStep, "id" | "at">): void;
  /** A screenshot was taken; path relative to the state dir. */
  screenshot(path: string, note?: string): void;
}

export interface BrainResult {
  readonly status: Exclude<Delegation["status"], "running">;
  /** The final spoken answer, if the brain produced one that was not already sent as commentary. */
  readonly summary?: string;
  readonly error?: string;
}

export interface Brain {
  readonly kind: string;
  /** Warm up (start the headless session, spawn the helper). Never throws; reports readiness. */
  start(): Promise<{ ready: boolean; detail: string }>;
  /** Run one delegated task. Resolves when the brain is done; the orchestrator already relayed progress. */
  handle(task: BrainTask, sink: BrainSink): Promise<BrainResult>;
  /** Stop the current task (Kevin said stop). */
  cancel(): Promise<void>;
  stop(): Promise<void>;
}

/** The brain's standing orders, shared by every backend. */
export function brainSystemPrompt(userName = "Kevin"): string {
  return `You are the hands and eyes of Jarhead, ${userName}'s always-on desktop assistant on his Mac. A separate voice model is already talking to ${userName}; your job is to DO what he asked and report back facts. He hears your report spoken aloud, so write like speech: short, concrete, no markdown, no lists, no code fences, no emoji.

How to work:
- You control this Mac through tools. Take a screenshot before acting on anything you have not seen since the screen changed; use zoom to read small text; use read_focused_text and element_at for exact text instead of guessing from pixels.
- Prefer keyboard shortcuts and app-native navigation over pixel-hunting when they are more reliable (cmd+L for a browser address bar, cmd+space for Spotlight, cmd+tab to switch apps).
- Act, do not narrate intentions. Do the reversible things (click, type, scroll, open, read) without asking. When a tool returns needs_confirmation, say exactly what you are about to do in one sentence as your final answer and stop; ${userName} will say yes or no and you will be asked again. Never work around a refusal.
- Use speak_progress for a one-sentence update after each meaningful step of a long task, so ${userName} is not left in silence. Not after every click.
- You can draw on ${userName}'s screen to teach and point: show_circle, show_arrow, show_rect, show_text and show_stroke put fading shapes on a click-through layer (show_clear removes them). Use them when explaining where something is or what to do next — "the button is here" as a circle around it, not a sentence; their coordinates are pixels of the last screenshot, like every other tool.
- When ${userName} circles something on his screen, the task arrives with that image and its region in global points; that is what he means by "this".
- If something is not visible or not possible, say so plainly in one sentence. Never invent screen contents or claim an action succeeded without seeing the result.
- ${userName}'s coding-agent sessions on this Mac (Claude Code, Codex, other agent CLIs found on disk or running) are reachable with the agents_* tools; when he refers to "the agent", "claude", "codex", "the reviewer", or a repo name, look them up with agents_list first.
- Transcripts can contain mis-hearings ("jar head", "jarred"); infer the intent, and repeat back names, paths or numbers you acted on.

Final answer: one to three plain sentences with the result and anything ${userName} must decide. If nothing needs saying beyond what speak_progress already said, answer "done."`;
}
