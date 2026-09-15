/**
 * @jarhead/protocol — the shared vocabulary.
 *
 * Every process in Jarhead (the Swift app, the daemon, the CLI, the brain)
 * speaks these types. Nothing here has behaviour; it is the contract that lets the
 * surface be rebuilt without touching the engine and vice versa.
 *
 * Coordinates everywhere are GLOBAL SCREEN POINTS with the origin at the top-left
 * of the main display (the CoreGraphics convention). Kevin's second display sits
 * above the primary one, so negative coordinates are ordinary, never an error.
 */

// ----------------------------------------------------------------- phases ---

/**
 * What the Orb shows. Derived by the engine, mirrored by the surface.
 *
 * "listening" is the resting state of an open session: the mic is hot and the
 * model is attending. "speaking"/"thinking"/"acting" are what Jarhead is doing
 * right now; "asleep" means no Live session is open (and nothing is billed).
 */
export const PHASES = ["asleep", "connecting", "listening", "speaking", "thinking", "acting", "muted", "error", "paused"] as const;
export type Phase = (typeof PHASES)[number];

// ------------------------------------------------------------- transcript ---

export type Speaker = "kevin" | "jarhead";

export interface TranscriptItem {
  readonly id: string;
  readonly speaker: Speaker;
  readonly text: string;
  /** Live session timeline, ms from session start. */
  readonly startMs: number;
  readonly endMs: number;
  /** Wall clock when the first fragment arrived. */
  readonly at: number;
  /** False while fragments are still arriving for this utterance. */
  readonly final: boolean;
  /** "typed": Kevin typed it in the Console (on the record like a spoken line). */
  readonly source?: "typed";
}

// ------------------------------------------------------------ delegations ---

export type DelegationStatus = "running" | "done" | "failed" | "cancelled" | "awaiting-confirmation";

export type StepKind = "thinking" | "commentary" | "tool" | "screenshot" | "confirm" | "note" | "error";

export interface ToolStep {
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly ok: boolean;
  readonly ms: number;
}

export interface DelegationStep {
  readonly id: string;
  readonly at: number;
  readonly kind: StepKind;
  readonly text?: string;
  readonly tool?: ToolStep;
  /** Path under the state dir; the Console loads it as an image. */
  readonly screenshotPath?: string;
  /** The spawned thread's name when it ran this step on its parent's timeline; absent: main's. */
  readonly thread?: string;
}

// ---- threads: independent lines of work, each as capable as the main conversation ----
//
// Kevin (2026-09-13) asked to see independent threads and conversations: "multiple blobs
// doing their own work … just as feature rich as if it were the main thread … keep track of
// those using extremely performant data structure representations".
// A Thread has its own brain (a warm codex app-server process), its own conversation
// (Delegation records tagged with `threadId`, streamed to the Console per viewer), its
// own lane, budget and blob. `main` is the voice's own thread. The engine keeps one
// table (Maps by id, name and app; an event ring) that answers "what is Spotify doing"
// and "stop the Slack one" without a model call. A thread may spawn threads of its own
// (depth THREAD_SPAWN_DEPTH); every spawned thread is a Thread like main.
export const MAIN_THREAD_ID = "main";
export type ThreadLane = "voice" | "screen" | "background";
export const THREAD_STATUSES = ["idle", "queued", "starting", "thinking", "acting", "waiting-screen", "waiting-kevin", "paused", "done", "failed", "stopped"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export const THREAD_TERMINAL: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(["done", "failed", "stopped"]);
/** Live threads at once, main included. */
export const THREAD_MAX_LIVE = 4;
/** A spawned thread never spawns. */
export const THREAD_SPAWN_DEPTH = 1;
export const THREAD_NAME_CHARS = 16;
/** A finished thread stays in the snapshot this long (the Console keeps it longer from events). */
export const THREAD_LINGER_MS = 30_000;
/** Summaries in one snapshot; live threads are never evicted. */
export const THREADS_MAX = 16;
export const THREAD_PAGE = 60;
export const THREAD_STEPS_DEFAULT = 25;
export const THREAD_STEPS_MAX = 40;
export const THREAD_SECONDS_DEFAULT = 180;
export const THREAD_SECONDS_MAX = 300;
export interface Thread {
  /** "main" or "t_…" — also the `thread` field a tool.run frame carries. */
  readonly id: string;
  /** ≤ 16 chars, unique among live threads (case-insensitive), spoken as-is. */
  readonly name: string;
  readonly lane: ThreadLane;
  readonly status: ThreadStatus;
  readonly parentId?: string;
  readonly parentDelegationId?: string;
  /** Live's delegation id to append this thread's lines to when its parent turn is gone. */
  readonly liveId?: string;
  /** The brief, redacted, ≤ 200 ("" for main). */
  readonly task: string;
  /** Last tool + outcome, or the reason it ended; ≤ 200. */
  readonly detail?: string;
  /** Apps claimed (open_app / focus_app / `tell application "X"` / a browser host), ≤ 4. */
  readonly apps: readonly string[];
  /** The newest of `apps`, where the blob parks. */
  readonly app?: string;
  /** Last acting point in global points, from a tagged orb.fly. */
  readonly at?: Point;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly doneAt?: number;
  readonly turns: number;
  readonly steps: number;
  readonly waits: number;
  readonly budget: { readonly steps: number; readonly seconds: number };
  /** ≤ 160 while waiting-kevin. */
  readonly question?: string;
  readonly currentDelegationId?: string;
  readonly lastScreenshotPath?: string;
  /** Accepts a follow-up turn ("spotify, skip this song"). */
  readonly canSay: boolean;
  readonly canStop: boolean;
}
/** One change on one thread; ≤ 200 B on the wire, coalesced 50 ms per thread. */
export type ThreadEvent = { readonly seq: number; readonly at: number; readonly threadId: string } & (
  | { readonly kind: "started"; readonly thread: Thread }
  | { readonly kind: "status"; readonly status: ThreadStatus; readonly detail?: string }
  | { readonly kind: "step"; readonly steps: number; readonly tool?: string; readonly ok?: boolean }
  | { readonly kind: "turn"; readonly delegationId: string; readonly request: string }
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "said"; readonly text: string }
  | { readonly kind: "at"; readonly x: number; readonly y: number; readonly app?: string }
  | { readonly kind: "ended"; readonly status: "done" | "failed" | "stopped"; readonly summary?: string }
);
/** One row of a thread's conversation, numbered by `seq` so a pane patches a card in O(1) and pages by number. */
export type ThreadEntry =
  | { readonly kind: "utterance"; readonly seq: number; readonly item: TranscriptItem }
  | { readonly kind: "delegation"; readonly seq: number; readonly delegation: Delegation }
  | { readonly kind: "step"; readonly seq: number; readonly delegationId: string; readonly step: DelegationStep }
  | { readonly kind: "status"; readonly seq: number; readonly delegationId: string; readonly status: DelegationStatus; readonly summary?: string; readonly timings: DelegationTimings }
  | { readonly kind: "system"; readonly seq: number; readonly at: number; readonly symbol: string; readonly text: string; readonly mono?: string; readonly trailing?: string };
export interface ThreadTranscript {
  readonly threadId: string;
  readonly entries: readonly ThreadEntry[];
  readonly total: number;
  readonly complete: boolean;
  readonly live: boolean;
  readonly cursor?: { readonly startSeq: number; readonly endSeq: number };
  readonly readMs?: number;
}

// ---- memory: what Jarhead knows about Kevin across sessions ------------------
//
// A dedicated module (@jarhead/memory) keeps an append-only record of one-sentence
// items ("Kevin prefers …"), extracted from closed conversations, deduplicated by
// embedding similarity, scored by recency, importance and use, and injected into
// prompts under a hard token budget. Forget is a state; nothing is ever deleted.
export type MemoryKind = "preference" | "fact" | "episode" | "procedure" | "contact" | "place";
export type MemoryState = "live" | "forgotten" | "merged" | "archived";
export type MemoryOrigin = "extracted" | "kevin" | "tool";
export interface MemorySource {
  readonly sessionId?: string;
  readonly at: number;
  readonly type: "heard" | "said" | "request" | "summary" | "kevin" | "tool";
}
export interface MemoryItem {
  readonly id: string;
  readonly kind: MemoryKind;
  /** One sentence, third person, redacted. */
  readonly text: string;
  readonly subjects: readonly string[];
  readonly confidence: number;
  readonly importance: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly seenCount: number;
  readonly sources: readonly MemorySource[];
  readonly state: MemoryState;
  /** When merged: the item that carries it now. */
  readonly mergedInto?: string;
  /** Items this one replaced (a contradiction resolved the newer way). */
  readonly supersedes?: readonly string[];
  readonly origin: MemoryOrigin;
}
export interface MemorySummary {
  readonly enabled: boolean;
  readonly count: number;
  readonly forgotten: number;
  readonly archived: number;
  /** How items are matched: OpenAI embeddings, a local embedding model, or keywords. */
  readonly embeddings: "openai" | "local" | "keyword";
  /** "text-embedding-3-small" or the local model's id; absent for keyword matching. */
  readonly embeddingModel?: string;
  readonly embeddingDims?: number;
  /** Conversations waiting for a quiet moment to be read. */
  readonly pending: number;
  readonly lastRunAt?: number;
  readonly lastRun?: { readonly extractor: "responses" | "local" | "rules"; readonly added: number; readonly updated: number; readonly noop: number; readonly refused: number; readonly ms: number };
  /** Tokens the last prompts spent on memory. */
  readonly budgetUsed?: { readonly brain: number; readonly voice: number };
  /** Items the last delegation was given (the Now rail's "used this turn"). */
  readonly lastUsedIds?: readonly string[];
}
/** Hard caps on what memory may cost a prompt. */
export const BRAIN_MEMORY_TOKENS = 250;
export const VOICE_MEMORY_TOKENS = 120;

/**
 * Why Jarhead went to sleep. `said`: a spoken cue ("go to sleep", "goodnight", "that's
 * all"); `idle`: the idle timer; `pause-decayed`: an unresumed pause; `brain-changed`: the
 * brain was swapped; `dock`: the blob was dropped into the notch; `command`: the app's
 * sleep command; `stop`: the transport's Stop (the `stop` row is the record, the `sleep`
 * row names the cause); `shutdown`: the engine is exiting.
 */
export type SleepCause = "said" | "idle" | "pause-decayed" | "brain-changed" | "dock" | "command" | "stop" | "shutdown";

export interface DelegationTimings {
  readonly delegatedAt: number;
  readonly firstThinkingAt?: number;
  readonly firstCommentaryAt?: number;
  readonly doneAt?: number;
  /**
   * Wall clock when Kevin's triggering utterance ended: the last of his transcript
   * items that ended before Live's delegation event, its session-timeline `endMs`
   * placed on the clock of `session.started`. Absent when no utterance preceded the
   * delegation or the session's start is not known. `delegatedAt − speechEndAt` is
   * Live's own transcription and decision time; `firstActionAt − speechEndAt` is what
   * Kevin waits for (docs/LATENCY.md).
   */
  readonly speechEndAt?: number;
  /**
   * Wall clock of the first acting tool that returned ok — a click, a type, a key, a
   * scroll, an app opened or focused, an AppleScript, a shell command, a file write,
   * a browser action. A look-only tool, a failed action and a confirmation question
   * do not stamp it.
   */
  readonly firstActionAt?: number;
}

export interface Delegation {
  readonly id: string;
  /** Live's delegation id, used for every append on this task. */
  readonly liveId: string;
  readonly createdAt: number;
  readonly offsetMs: number;
  /** What the brain was asked to do: the transcript window that led here. */
  readonly request: string;
  readonly status: DelegationStatus;
  readonly steps: readonly DelegationStep[];
  readonly summary?: string;
  readonly timings: DelegationTimings;
  /** The thread that ran it; absent = "main". */
  readonly threadId?: string;
  /** Step total of a thread's delegation (threads/turns.ts writes it); a thread page shows it before its steps are paged in. Absent on main's delegations, whose `steps` are complete. */
  readonly stepCount?: number;
  /** The automation whose `wake-brain` action ran this turn: `liveId` is "" and nothing is appended to Live. */
  readonly origin?: { readonly automationId: string };
}

// ----------------------------------------------------------------- agents ---

/** "sessions" is the read-only discovery of agent sessions on disk and in processes (Claude Code, Codex, …). */
export type AgentKind = "claude-code" | "sessions";

/**
 * `working` needs a live owner AND a turn-bearing write inside its lease; `ended` is a
 * session whose process is gone (any age); `unknown` is degraded evidence only (ps/lsof
 * failed); `offline` is a run-driven session whose runner has gone.
 */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "ended" | "unknown" | "offline";
/** One word on why the status is what it is; the rail shows it instead of a relative time. */
export type AgentHint = "archived" | "blocked" | "running" | "quiet" | "ended" | "unseen" | "resumed";

/** The CLI or app behind a session — drives the icon and brand colour in the UI. */
export type AgentTool = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "amp" | "droid" | "hermes" | "pi" | "other";

export interface AgentInfo {
  /** Stable, connector-scoped: "sessions:claude:<uuid>", "sessions:codex:<id>", "claude-code:<sessionId>". */
  readonly id: string;
  readonly kind: AgentKind;
  /** Which agent this is (Codex, Claude Code, Cursor…); absent = the connector's default. */
  readonly tool?: AgentTool;
  readonly name: string;
  readonly status: AgentStatus;
  readonly detail?: string;
  readonly cwd?: string;
  readonly updatedAt: number;
  /** Total messages in the conversation, when known. */
  readonly messageCount?: number;
  readonly hint?: AgentHint;
  /** Whether a message can be sent into this session now, and how (typed, not cue-parsed). */
  readonly send?: { readonly ok: boolean; readonly reason?: string; readonly mode?: "queue" | "resume" | "answer" };
}

// ------------------------------------------------------- conversations ---

export type AgentRole = "user" | "assistant" | "tool" | "system";

export interface AgentToolCall {
  readonly name: string;
  /** Pretty-printed input, truncated by the connector. */
  readonly input?: string;
  readonly output?: string;
  /** `interrupted`: the session ended while this call was still running. */
  readonly status: "running" | "done" | "error" | "interrupted";
}

/** One turn of an agent's conversation, normalised across Codex / Claude Code / others. */
export interface AgentMessage {
  /** Stable within the session (the tool's own message/item id when it has one). */
  readonly id: string;
  readonly role: AgentRole;
  readonly text: string;
  readonly at: number;
  readonly tool?: AgentToolCall;
  /** Reasoning / thinking text rather than a reply. */
  readonly thinking?: boolean;
  /** A message Kevin just sent, echoed before the session confirms it. */
  readonly pending?: boolean;
}

/**
 * A window of an agent's conversation. The engine sends `replace` with the newest
 * page when a session is opened (and on `agent.history`, prepending older
 * messages), then `append` deltas while it is open and the file grows.
 */
export interface AgentTranscript {
  readonly agentId: string;
  readonly messages: readonly AgentMessage[];
  /** Total messages known in the session (for "showing 40 of 1 200"). */
  readonly total: number;
  /** True when `messages` starts at the very first message. */
  readonly complete: boolean;
  /** True while the engine is tailing the session file for new turns. */
  readonly live: boolean;
  /** Byte range of the session file these messages came from; `agent.history` pages before `startOffset`. */
  readonly cursor?: { readonly startOffset: number; readonly endOffset: number };
  /** How long the page took to read, for the Console's line. */
  readonly readMs?: number;
}

// ------------------------------------------------------------- marks ---

/** Something Kevin circled on screen for Jarhead: a region, its stroke, and its screenshot. */
export interface ScreenMark {
  readonly id: string;
  readonly rect: Rect;
  readonly path?: readonly Point[];
  readonly at: number;
  /** Relative to the state dir, like screenshot steps. */
  readonly screenshotPath?: string;
  /** Handed to a brain already (kept a while for the Console, then dropped). */
  readonly consumed: boolean;
  /** What the stroke surrounded, when the accessibility tree or window list could say. `rect` is snapped to it. */
  readonly element?: { readonly role?: string; readonly title?: string; readonly app?: string };
  /** How it was made. Absent or "circle": Kevin's stroke. "window": the front window captured whole (`mark.window`); its rect is the window's frame, no snap. */
  readonly source?: "circle" | "window";
}

export interface ConnectorHealth {
  readonly kind: AgentKind;
  readonly ok: boolean;
  readonly detail: string;
}

// ------------------------------------------------------------ automations ---
//
// Set while awake, carried out by the daemon while asleep.
//
// Kevin (2026-09-14): "alarms, automations and more that don't require the agent to be fully
// awake but can just be on system". An Automation is `when <trigger> then <actions>`, armed by a
// brain tool in a conversation (confirmed once at set-up when an action needs a yes) and fired
// by the engine from tick() or a system signal with NO Live session and NO brain turn — except
// `wake-brain`, opted into per row with the cost said out loud. Nothing fires that would need a
// question at fire time: the set-up gate refuses it. Rows are never deleted: `trashed` is a state.

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
/** "HH:mm", 24 h, local. DST follows the Mac's clock: 07:10 is 07:10 on both sides of the change. */
export type ClockTime = `${number}:${number}`;

/** Local wall-clock recurrence, normalised from Kevin's phrase. `monthly`/`monthday` are pass 2 (typed now so the wire holds). */
export type Recurrence =
  /** "weekdays 09:00" · "daily 18:00" · "mon,wed 07:10" */
  | { readonly kind: "weekly"; readonly days: readonly Weekday[]; readonly at: ClockTime }
  /** "every 2 h" (≥ 60 000) */
  | { readonly kind: "interval"; readonly everyMs: number; readonly anchorAt: number }
  | { readonly kind: "monthly"; readonly nth: 1 | 2 | 3 | 4 | -1; readonly weekday: Weekday; readonly at: ClockTime }
  | { readonly kind: "monthday"; readonly day: number; readonly at: ClockTime };

/** When it fires. `at` and `in` are one-shots; `every` and `on` repeat. */
export type AutomationWhen =
  /** alarm, reminder: wall-clock ms */
  | { readonly kind: "at"; readonly at: number }
  /** timer: ms after createdAt; nextAt fixed once */
  | { readonly kind: "in"; readonly ms: number }
  /** alarm (repeating), routine; `phrase` for read-back */
  | { readonly kind: "every"; readonly every: Recurrence; readonly phrase: string }
  /** watcher */
  | { readonly kind: "on"; readonly on: SystemEvent };

/** A signal the daemon can see without a brain. Pass 1 set. */
export type SystemEvent =
  /** A file appears in a folder and settles (`settleMs` after its last write, default 3000); `glob` narrows ("*.pdf"). Browser partials never count. */
  | { readonly kind: "folder.file"; readonly path: string; readonly glob?: string; readonly settleMs?: number }
  | { readonly kind: "download.done"; readonly glob?: string }
  | { readonly kind: "app.launch" | "app.quit"; readonly app: string }
  | { readonly kind: "mac.wake" | "screen.unlock" }
  | { readonly kind: "display.connected" | "display.disconnected" }
  /** A named recipe polled every `everySeconds` (≥ 30); fires when its exit flips non-zero and once when it flips back. */
  | { readonly kind: "recipe.red"; readonly recipe: string; readonly everySeconds: number }
  /** One of Kevin's coding-agent sessions changed status (the agents registry). `agent` absent = any. */
  | { readonly kind: "agent.status"; readonly agent?: string; readonly status: AgentStatus };
// Reserved for pass 2 (never armed in pass 1; classifyAutomation refuses the kind by name):
//   { kind: "clipboard.match"; pattern } · { kind: "network.changed"; network? } · { kind: "automation.fired"; id }

/** What happens. Each kind is a chip in Settings.automations.unattended; off there = refused at set-up. */
export type AutomationAction =
  /** sound + island line with Snooze · Done (+ banner) */
  | { readonly kind: "chime"; readonly line: string; readonly sound?: "Pop" | "Glass" | "Ping" | "Hero" }
  /** LocalSpeaker reads a FIXED line ≤ 160, written at set-up, redacted */
  | { readonly kind: "say"; readonly line: string }
  /** banner with Snooze · Done (Open · Done when `open`) */
  | { readonly kind: "notify"; readonly title: string; readonly body?: string; readonly open?: string }
  /** app · https URL · file/folder; classifyUrl/Path must say run */
  | { readonly kind: "open"; readonly app?: string; readonly url?: string; readonly path?: string }
  /** move the triggering file (folder.file/download.done only); never overwrite, never unlink, inside ~ */
  | { readonly kind: "file"; readonly into: string }
  /** a Settings recipe; shell gate with confirmed=false must say run */
  | { readonly kind: "run-recipe"; readonly recipe: string }
  /** one key/chord in a named app, only while it is in front and no secure field has focus */
  | { readonly kind: "press"; readonly app: string; readonly key: string }
  | { readonly kind: "wake-brain"; readonly prompt: string; readonly budget: { readonly steps: number; readonly seconds: number }; readonly speak: boolean };

export const AUTOMATION_ACTION_KINDS = ["chime", "say", "notify", "open", "file", "run-recipe", "press", "wake-brain"] as const;
export type AutomationActionKind = (typeof AUTOMATION_ACTION_KINDS)[number];
/** The kinds that act on the Mac (a row carries at most one); the rest only show, say or sound. */
export const AUTOMATION_ACTING_KINDS: ReadonlySet<AutomationActionKind> = new Set<AutomationActionKind>(["open", "file", "run-recipe", "press", "wake-brain"]);

export interface AutomationClauses {
  /** fires only inside (local, wraps midnight) */
  readonly window?: { readonly from: ClockTime; readonly to: ClockTime };
  /** watchers only; `every` carries its own days */
  readonly days?: readonly Weekday[];
  /** one-shot watcher · at most once per local day */
  readonly once?: boolean | "day";
  /** seconds between fires (storm guard); default 30 for watchers, 0 for clocks */
  readonly cooldown?: number;
  /** repeaters stop after this instant */
  readonly until?: number;
  /** alarms default override; everything else respect */
  readonly quiet: "respect" | "override";
}

export type AutomationState =
  /** waiting for nextAt or the signal */
  | "armed"
  /** snoozedUntil is the new nextAt */
  | "snoozed"
  /** an action runs now (recipe, brain turn, file move) */
  | "firing"
  /** rang; waiting for Done (chime/notify/say) until Done or AUTOMATION_LINGER_MS */
  | "fired"
  /** due inside quiet hours with quiet=respect; fires at quiet end */
  | "deferred"
  /** Kevin paused it */
  | "paused"
  /** a one-shot that fired and was dismissed/skipped, or a repeater past `until` */
  | "done"
  /** the last fire could not run (lastDetail says why); repeaters re-arm, one-shots stay */
  | "failed"
  /** Moved to Trash: hidden from the rails, restorable, never deleted */
  | "trashed";
export const AUTOMATION_TERMINAL: ReadonlySet<AutomationState> = new Set<AutomationState>(["done", "trashed"]);

/** The Console's word for a row, derived — nothing stores it. */
export type AutomationKind = "alarm" | "timer" | "reminder" | "routine" | "watcher";
export function automationKind(a: Pick<Automation, "when" | "then">): AutomationKind {
  const w = a.when.kind, first = a.then[0]?.kind;
  if (w === "in") return "timer";
  if (w === "on") return "watcher";
  if (w === "every") return first === "chime" ? "alarm" : "routine";
  return first === "chime" ? "alarm" : "reminder";
}

export interface Automation {
  /** "auto_…" (newId) */
  readonly id: string;
  /** ≤ 24 chars, spoken as-is; unique among non-trashed rows, case-insensitive */
  readonly name: string;
  readonly when: AutomationWhen;
  /** 1–3, in order; at most one acting kind; a failure stops the chain */
  readonly then: readonly AutomationAction[];
  readonly clauses: AutomationClauses;
  /** the one line Jarhead read back at set-up, ≤ 120, redacted */
  readonly echo: string;
  readonly state: AutomationState;
  /** absent for watchers and terminal states */
  readonly nextAt?: number;
  readonly lastFiredAt?: number;
  /** ≤ 200, redacted: "filed invoice.pdf → Papers" · "recipe exit 1" · "quiet hours: shown, not said" · "12 min late" */
  readonly lastDetail?: string;
  readonly fires: number;
  /** skipped or late because the daemon was down or the Mac slept */
  readonly missed: number;
  readonly snoozedUntil?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy: { readonly by: "brain" | "console" | "cli"; readonly chainId?: string; readonly delegationId?: string; readonly request: string };
  /** The set-up yes for run-recipe / press / wake-brain: when Kevin confirmed and the words he heard (the cost line). Absent for free kinds. */
  readonly confirmed?: { readonly at: number; readonly heard: string };
}

/** Live (non-trashed) rows in one snapshot: armed / snoozed / deferred by nextAt, then the rest by updatedAt. */
export const AUTOMATIONS_MAX = 32;
/** Trashed rows after them, newest first, for the Console's Trash fold (Restore); the journal keeps every one. */
export const AUTOMATIONS_TRASHED_MAX = 8;
export const AUTOMATION_ACTIONS_MAX = 3;
/** a ring stays up this long; alarms then self-snooze ONCE, others count as Done ("unanswered") */
export const AUTOMATION_LINGER_MS = 10 * 60_000;
/** alarms re-chime while `fired` */
export const AUTOMATION_REPEAT_CHIME_MS = 30_000;
/** minutes; the box's word is Settings.snoozeMinutes; the minis show the other two */
export const AUTOMATION_SNOOZES = [5, 10, 30] as const;
/** say/chime/notify lines: a sentence, not a briefing */
export const AUTOMATION_LINE_CHARS = 160;
export const AUTOMATION_WATCH_COOLDOWN_S = 30;
/** recipe.red floor */
export const AUTOMATION_POLL_MIN_S = 30;
export const AUTOMATION_FOLDER_WATCHERS_MAX = 8;
/** a watcher that wakes the brain needs ten minutes between fires */
export const AUTOMATION_WAKE_COOLDOWN_MIN_S = 600;
/** a tick gap this long means the Mac slept: resync */
export const AUTOMATION_SLEEP_GAP_MS = 5_000;
/** How late a one-shot may still fire after the daemon comes back; later = missed. Routines and watchers never fire late. */
export const AUTOMATION_GRACE_MS: Readonly<Record<AutomationKind, number>> = { alarm: 15 * 60_000, timer: 10 * 60_000, reminder: 60 * 60_000, routine: 0, watcher: 0 };

/** The presses a ring offers; the island, the banner and the Console show the same set. */
export type AutomationPress = { readonly kind: "snooze"; readonly minutes: number } | { readonly kind: "done" } | { readonly kind: "open"; readonly target: string };

/** The one line the island shows while a row is `fired` (the newest; `more` counts the others). */
export interface RingLine {
  readonly id: string;
  readonly kind: AutomationKind;
  readonly name: string;
  /** "07:10 · Wake up, Kevin" */
  readonly line: string;
  /** one quieter second line: the echo's tail or the next fire ("Monday · standup notes at 9") */
  readonly calm?: string;
  readonly at: number;
  readonly lateMs?: number;
  readonly presses: readonly AutomationPress[];
  readonly more: number;
}

/** One change on one row; broadcast like thread.event, coalesced 50 ms per id. `state`, `missed` and `tick` fit 200 B (detail ≤ 70); `fired` carries its presses and a line capped at 80, ≈ 270 B (protocol.test.ts measures them). */
export type AutomationEvent = { readonly seq: number; readonly at: number; readonly id: string } & (
  | { readonly kind: "set"; readonly automation: Automation }
  | { readonly kind: "fired"; readonly actions: readonly AutomationActionKind[]; readonly line: string; readonly ok: boolean; readonly detail?: string; readonly lateMs?: number; readonly presses: readonly AutomationPress[] }
  | { readonly kind: "state"; readonly state: AutomationState; readonly nextAt?: number; readonly detail?: string }
  | { readonly kind: "missed"; readonly dueAt: number; readonly lateMs?: number; readonly skipped?: boolean; readonly why: MissedWhy }
  /** a running timer, ≤ 1/s, only while a client views the island/Console; never a snapshot */
  | { readonly kind: "tick"; readonly remainingMs: number }
);
export type MissedWhy = "daemon-down" | "mac-slept" | "quiet-hours" | "budget";

/**
 * A signal the app observes on Kevin's behalf and forwards; the daemon has no NSWorkspace. Data,
 * never a command. On the wire it is the app → daemon ClientMessage
 * `{ type: "system.signal", signal: SystemSignal, at: number }` (daemon/src/wire.ts): the engine
 * matches it against the armed watchers and resyncs on `mac.wake` / `clock.changed`; nothing wakes.
 */
export type SystemSignal =
  | { readonly kind: "app.launch" | "app.quit"; readonly app: string; readonly bundleId?: string }
  | { readonly kind: "mac.wake" | "mac.sleep" | "screen.unlock" | "screen.lock" | "display.connected" | "display.disconnected" | "clock.changed" };

export interface ShellRecipe {
  /** ≤ 24 chars; what a row names in run-recipe / recipe.red */
  readonly name: string;
  readonly command: string;
  readonly cwd?: string;
  /** ≤ 600 */
  readonly timeoutSeconds: number;
  /** Kevin's yes (voice set-up or the Console's Add); the shell gate re-judges the text at every fire anyway */
  readonly approvedAt: number;
}

export interface AutomationSettings {
  /** master; off = nothing fires, every row stays */
  readonly enabled: boolean;
  /** kinds allowed to fire while ASLEEP; default chime say notify open file */
  readonly unattended: readonly AutomationActionKind[];
  readonly quietHours?: { readonly from: ClockTime; readonly to: ClockTime };
  /** the island's one Snooze press (default 10; timers use 5) */
  readonly snoozeMinutes: number;
  /** 0 = wake-brain refused at set-up */
  readonly wakeBudgetMinutesPerDay: number;
  readonly recipes: readonly ShellRecipe[];
  /** the app registers itself to open at login on Kevin's press */
  readonly openAtLogin: boolean;
}

export const DEFAULT_AUTOMATIONS: AutomationSettings = {
  enabled: true,
  unattended: ["chime", "say", "notify", "open", "file"],
  snoozeMinutes: 10,
  wakeBudgetMinutesPerDay: 5,
  recipes: [],
  openAtLogin: false,
};

/** A row as the Console form or the CLI sends it; the engine fills id, state, fires, missed, the stamps and createdBy. */
export type AutomationDraft = Omit<Automation, "id" | "state" | "fires" | "missed" | "createdAt" | "updatedAt" | "createdBy" | "confirmed"> & { readonly id?: string };

// --------------------------------------------------------------- settings ---

/**
 * Which brain does the work behind the voice. Vendor-neutral: `auto` picks the
 * first backend that is signed in or configured on this Mac, in the order
 * codex → claude-code → anthropic-api → openai-compatible → openai-responses.
 * `codex` = the Codex CLI (bundled in ChatGPT.app or on PATH) with Kevin's ChatGPT
 * login and Jarhead's tools over MCP; `claude-code` = the Agent SDK with his Claude
 * login; `anthropic-api` = the Messages API with ANTHROPIC_API_KEY;
 * `openai-responses` = the Live session's Responses delegation; `openai-compatible`
 * = any Chat Completions server (OpenAI, OpenRouter, Ollama, LM Studio, vLLM…) at
 * `Settings.brainBaseUrl` with JARHEAD_BRAIN_API_KEY.
 */
/**
 * `local` = a model on this Mac served by Ollama (127.0.0.1:11434), LM Studio (:1234) or
 * llama.cpp (:8080), discovered by the engine or pinned by `Settings.brainBaseUrl`; explicit
 * only — `auto` never picks it. `Settings.brainModel` is the server's own id (`qwen3.5:27b`),
 * or empty for the best fit on this Mac (`setup.local.picked`).
 */
export type BrainKind = "auto" | "codex" | "claude-code" | "anthropic-api" | "openai-responses" | "openai-compatible" | "local";
export const BRAIN_KINDS: readonly BrainKind[] = ["auto", "codex", "claude-code", "anthropic-api", "openai-responses", "openai-compatible", "local"];
/** The order `auto` tries backends in. `local` is not here: a running server is not a choice Kevin made. */
export const AUTO_BRAIN_ORDER: readonly Exclude<BrainKind, "auto" | "local">[] = ["codex", "claude-code", "anthropic-api", "openai-compatible", "openai-responses"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * How the wake word gate authenticates before it opens the (paid) voice session.
 * "touch-id" is LocalAuthentication's device-owner policy (Touch ID, Apple Watch,
 * or the Mac password); "passphrase" is a spoken or typed phrase enrolled in the
 * app and kept hashed in the keychain; "either" accepts whichever comes first.
 */
export type WakeAuth = "touch-id" | "passphrase" | "either" | "none";

/**
 * The local wake word. While the engine is asleep the native app listens with the
 * system's on-device speech recogniser — nothing leaves the Mac and no API is
 * billed — and only after authentication does it send `go`.
 */
export interface WakeSettings {
  readonly enabled: boolean;
  /** Normalised lowercase phrases; any of them wakes it. */
  readonly phrases: readonly string[];
  readonly auth: WakeAuth;
}

export interface Settings {
  readonly voice: string;
  readonly brain: BrainKind;
  /** Model override for the chosen backend; empty = that backend's default. Under `local`: the server's listed id, verbatim; empty = the best fit on this Mac (see `LocalServerStatus.picked`). */
  readonly brainModel: string;
  /** openai-compatible: base URL of the Chat Completions server. local: pin the server root instead of discovering it (a second Ollama on another port, a LAN box). No trailing /v1 needed. */
  readonly brainBaseUrl?: string;
  readonly effort: Effort;
  /** First-run onboarding finished (keys, brain, permissions, wake word). */
  readonly onboarded: boolean;
  /** getUserMedia deviceId; undefined = system default. */
  readonly micDeviceId?: string;
  readonly idleSleepMinutes: number;
  /** Start listening on launch (ignored while the wake word gate is enabled). */
  readonly autoWake: boolean;
  /** Where the Orb sits, saved across launches. */
  readonly orbPosition?: { readonly x: number; readonly y: number };
  readonly wake: WakeSettings;
  /** Act on unambiguous spoken commands without the model (the 250 ms path). */
  readonly reflexes: boolean;
  /** Where the blob lives: floating where it last worked, or tucked in the MacBook notch. */
  readonly orbHome: "free" | "notch";
  /** Days a ledger day file stays live before the sweep MOVES it to <stateDir>/trash (0 = never). Pinned chains keep their days. */
  readonly ledgerRetentionDays: number;
  /** Days a day's screenshots stay live before the sweep moves them to the trash (0 = never). */
  readonly shotsRetentionDays: number;
  /** Let the brain split independent work across threads. */
  readonly threads: boolean;
  /** The language the voice speaks, whatever it hears (BCP-47; "en"). */
  readonly language: string;
  /** How the English is spoken; rendered as one line of the session's instructions. */
  readonly accent: Accent;
  /** Durable memory of Kevin across sessions (extraction, retrieval, the Memory rail). */
  readonly memory: boolean;
  /** Every acting tool answers with what is now in front (the observation line); off for the A/B. */
  readonly observe: boolean;
  /** A typed line while asleep wakes Jarhead (opens a paid session). Off: refuse with a toast, keep the text. */
  readonly typedWakes: boolean;
  /** A new request naming an unclaimed app while main has acted: supersede (today) or spawn a thread. */
  readonly threadOverflow: "supersede" | "spawn";
  /** Warm codex app-server processes kept ready for threads (0..3). */
  readonly warmThreads: number;
  /** Alarms, timers, reminders, routines and watchers the daemon carries out while asleep: the master switch, the unattended kinds, quiet hours, the recipes. */
  readonly automations: AutomationSettings;
}

export const DEFAULT_WAKE: WakeSettings = {
  enabled: true,
  phrases: ["jarhead", "jar head", "hey jarhead"],
  auth: "either",
};

export const DEFAULT_SETTINGS: Settings = {
  voice: "ballad",
  brain: "auto",
  brainModel: "",
  effort: "medium",
  idleSleepMinutes: 10,
  autoWake: true,
  wake: DEFAULT_WAKE,
  onboarded: false,
  reflexes: true,
  orbHome: "notch",
  ledgerRetentionDays: 0,
  shotsRetentionDays: 14,
  threads: true,
  language: "en",
  accent: "british",
  memory: true,
  observe: true,
  typedWakes: false,
  threadOverflow: "supersede",
  warmThreads: 2,
  automations: DEFAULT_AUTOMATIONS,
};

/**
 * Every key of Settings, in one place: what the engine reads from settings.json (any
 * other key in the file is dropped and the file rewritten once) and what a patch may
 * carry. The `satisfies` and the pin below keep it exhaustive: add a field to Settings
 * and both fail to compile until the key is listed.
 */
export const SETTINGS_KEYS = [
  "voice", "brain", "brainModel", "brainBaseUrl", "effort", "onboarded", "micDeviceId", "idleSleepMinutes", "autoWake", "orbPosition", "wake", "reflexes", "orbHome",
  "ledgerRetentionDays", "shotsRetentionDays", "threads", "language", "accent", "memory", "observe", "typedWakes", "threadOverflow", "warmThreads",
  "automations", // design11: the automations block joins SETTINGS_KEYS so settings.json keeps it
] as const satisfies readonly (keyof Settings)[];
type SettingsKeysCover = Record<(typeof SETTINGS_KEYS)[number], 0>;
const settingsKeysCoverEverything: Record<keyof Settings, 0> = {} as SettingsKeysCover;
void settingsKeysCoverEverything;

/**
 * What onboarding and the doctor need to know about the configuration, without
 * ever carrying a secret: presence of keys, and the last probe results.
 */
export interface SetupStatus {
  /** Result of the last `config.probe` for the OpenAI key that runs the voice. */
  readonly openaiKey: "ok" | "missing" | "invalid" | "unchecked";
  readonly brain: "ok" | "unavailable" | "unchecked";
  readonly brainDetail: string;
  /** The backend actually running (what `auto` resolved to), if any. */
  readonly brainResolved?: Exclude<BrainKind, "auto">;
  readonly liveModel: string;
  /** Which secrets are present in ~/.jarhead/env or the environment (never the values). */
  readonly secrets: { readonly openai: boolean; readonly anthropic: boolean; readonly brainApiKey: boolean };
  /** The local model server, whatever `brain` is: refreshed by config.probe, restartBrain and the local heal timer. */
  readonly local: LocalServerStatus;
  /** Where words go right now, computed by @jarhead/core `dataPaths()`; the doctor computes the same rows. */
  readonly dataPaths: readonly DataPath[];
}

// ---- local model servers: discovery data the engine puts on the snapshot -------------------

/** Which local server answered. `ollama`: GET /api/version; `lmstudio`: GET /api/v0/models; `llamacpp`: GET /health. */
export type LocalFlavor = "ollama" | "lmstudio" | "llamacpp";
export const LOCAL_FLAVORS: readonly LocalFlavor[] = ["ollama", "lmstudio", "llamacpp"];
/** Ollama's /api/show capabilities the brain reads; other flavours infer `completion`+`tools` (assumed) and `vision`/`embedding` from the model type. */
export type LocalCapability = "completion" | "tools" | "vision" | "thinking" | "embedding";
/**
 * Weights against this Mac's memory — display data the engine computes, a rule of thumb, not a
 * measurement: usable = 0.75 × RAM; `good` ≤ 50 % of usable, `tight` ≤ 85 %, else `no`;
 * `unknown` when the server reports no size (LM Studio, llama.cpp).
 */
export type LocalFit = "good" | "tight" | "no" | "unknown";
export interface LocalModel {
  /** Verbatim as the server lists it ("qwen3.5:27b", "qwen3.5:27b-mlx"); always sent as-is. */
  readonly id: string;
  readonly capabilities: readonly LocalCapability[];
  /** Bytes on disk (Ollama /api/tags `size`); absent when the server does not say. */
  readonly sizeBytes?: number;
  /** Trained maximum (Ollama model_info "<arch>.context_length"; LM Studio max_context_length; llama.cpp n_ctx). */
  readonly contextLength?: number;
  readonly family?: string;
  readonly parameterSize?: string;
  /** Ollama `modified_at`, wall-clock ms; the newest pull is the best intent signal for `bestFit`. */
  readonly modifiedAt?: number;
  readonly fit: LocalFit;
  /** Loaded in memory right now (Ollama /api/ps; LM Studio state === "loaded"; llama.cpp always). */
  readonly loaded: boolean;
  /** Ollama `remote_host` set: runs on ollama.com, not this Mac. Never offered as a brain or an embedder. */
  readonly cloud: boolean;
}
/** Tool-capable models the picker may show, per server; more are cut newest-first. */
export const LOCAL_MODELS_MAX = 32;
export interface LocalServerStatus {
  readonly reachable: boolean;
  readonly flavor?: LocalFlavor;
  /** Ollama /api/version; others when they say. */
  readonly version?: string;
  /** The root in use (discovered or pinned), "" when none answered. */
  readonly baseUrl: string;
  /** Every non-cloud model with `completion` (tools-less ones included, so the picker can grey them), best fit first, ≤ LOCAL_MODELS_MAX. */
  readonly models: readonly LocalModel[];
  /** The id the engine chose when `Settings.brainModel` is empty under `local`; absent when a model is picked or nothing fits. */
  readonly picked?: string;
  /** The embedding model memory uses (first of EMBED_PREFERENCE present on the server); absent = keyword matching. */
  readonly embedModel?: string;
  /** What to suggest pulling for this Mac when nothing tool-capable is listed, e.g. { id: "qwen3.5:27b", sizeBytes: 17e9, command: "ollama pull qwen3.5:27b" }. Never run by Jarhead. */
  readonly suggested?: { readonly id: string; readonly sizeBytes: number; readonly command: string };
  /** Total memory of this Mac, so a surface can say "17 GB of 128 GB". */
  readonly ramBytes: number;
  /** Wall-clock ms of the last look; 0 = never. */
  readonly checkedAt: number;
}
/** The value before any look, and the empty value when nothing answers. */
export const LOCAL_NONE: LocalServerStatus = { reachable: false, baseUrl: "", models: [], ramBytes: 0, checkedAt: 0 };

/** One row of "where words go". The voice is always `cloud`; the brain and memory move with the settings; the web is the sites Kevin asks for. */
export type DataPathWhat = "voice" | "brain" | "memory" | "web";
export type DataPathWhere = "cloud" | "mac" | "lan" | "off";
export interface DataPath {
  readonly what: DataPathWhat;
  readonly where: DataPathWhere;
  /** One mono line: "OpenAI gpt-live-1 — every word heard and said; billed per second", "qwen3.5:27b on Ollama 0.34.0 — nothing leaves". */
  readonly detail: string;
}

/** Secret keys the surface may write through `config.set-secrets`. Nothing else goes in the env file. */
export const SECRET_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JARHEAD_BRAIN_API_KEY"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

// ------------------------------------------------------------ permissions ---

export type Grant = "granted" | "denied" | "unknown";

/**
 * Every macOS permission Jarhead asks for. The first four are what the voice and the
 * hands need to work at all; the rest let the brain reach what Kevin asks about
 * (his files, his apps, his contacts and calendar, the network) without a wall.
 * TCC keys every grant on the app bundle (the daemon and the hands helper are its
 * children), so the app is the one that asks and the one that reads.
 */
export const PERMISSION_KINDS = [
  "microphone", "speechRecognition", "screenRecording", "accessibility",
  "inputMonitoring", "automation", "fullDiskAccess", "notifications", "camera",
  "contacts", "calendars", "reminders", "localNetwork",
  "filesDesktop", "filesDocuments", "filesDownloads",
] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

/**
 * How a permission is obtained: `prompt` — an API shows the system dialog once;
 * `settings` — only System Settings grants it (Jarhead deep-links to the pane and
 * watches for the change); `perApp` — Automation: one prompt per target app, shown
 * when that app is running and first asked.
 */
export type PermissionAsk = "prompt" | "settings" | "perApp";

export interface PermissionInfo {
  readonly kind: PermissionKind;
  readonly grant: Grant;
  readonly ask: PermissionAsk;
  /** Without it the voice or the hands do not work (vs. a capability the brain can do without). */
  readonly required: boolean;
  /** Short name for a row. */
  readonly label: string;
  /** One line: what stops working without it. */
  readonly why: string;
  /** Automation: the target apps granted / denied; files: the folder; anything a row should show. */
  readonly detail?: string;
  /** Wall-clock ms of the last read. */
  readonly checkedAt?: number;
}

/** Every permission as the app last read it (the process TCC keys on); one row per kind. */
export interface Permissions {
  readonly all: readonly PermissionInfo[];
}

/** The grant a row records for `kind`; "unknown" when no row has been read yet. */
export function grantOf(p: Permissions, kind: PermissionKind): Grant {
  return p.all.find((row) => row.kind === kind)?.grant ?? "unknown";
}

// --------------------------------------------------------------- snapshot ---

export interface AudioLevels {
  /** 0..1 RMS of the last mic frame. */
  readonly input: number;
  /** 0..1 RMS of the last output frame. */
  readonly output: number;
}

export type Accent = "american" | "british" | "none";
export const ACCENTS: readonly Accent[] = ["american", "british", "none"];
/** GPT-Live-1's built-in voices (mirror of `BuiltInVoice` in @jarhead/live; a type-level test keeps them equal). All speak English. */
export const VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
  "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;
export type Voice = (typeof VOICES)[number];

export interface SessionInfo {
  readonly id: string;
  /** The voice and accent this session was opened with (a change is heard at the next wake). */
  readonly voice?: string;
  readonly accent?: Accent;
  readonly startedAt: number;
  readonly expiresAt: number;
  /** Cumulative billed seconds, from session.usage.updated. */
  readonly usageSeconds: number;
  readonly contextRatio?: number;
}

export interface Snapshot {
  readonly phase: Phase;
  readonly session?: SessionInfo;
  readonly transcript: readonly TranscriptItem[];
  readonly delegations: readonly Delegation[];
  readonly agents: readonly AgentInfo[];
  readonly connectors: readonly ConnectorHealth[];
  readonly settings: Settings;
  readonly permissions: Permissions;
  /** Most recent problems, newest last: what kind, one line, and the one action that fixes it. Cleared by the user. */
  readonly problems: readonly Problem[];
  readonly brainReady: boolean;
  readonly handsReady: boolean;
  readonly setup: SetupStatus;
  /** Regions Kevin circled, newest last; the next delegation sees the unconsumed ones. */
  readonly marks: readonly ScreenMark[];
  /**
   * Present while paused: a pause closes the Live session (the meter stops) and holds
   * the conversation; `sleepsAt` is when an unresumed pause decays to sleep.
   */
  readonly pause?: PauseInfo;
  /** Live seconds billed today — closed sessions from the ledger plus the open one — for the meter. */
  readonly usageToday?: UsageToday;
  /** What the trash holds, for the Console ("3 days · 129 MB"; Reveal in Finder). */
  readonly trash?: TrashInfo;
  /** Agents Kevin hid from the rail (agent.hidden rows). */
  readonly hiddenAgents?: readonly string[];
  /** What Jarhead remembers about Kevin: counts, mode, the last run, what the last turn used. */
  readonly memory?: MemorySummary;
  /** Every live thread (main first) and those finished within THREAD_LINGER_MS; ≤ THREADS_MAX. */
  readonly threads: readonly Thread[];
  /**
   * The live rows, ≤ AUTOMATIONS_MAX (armed/snoozed/deferred by nextAt, then the rest by updatedAt), then
   * the trashed rows, ≤ AUTOMATIONS_TRASHED_MAX newest first, `state: "trashed"` — the Console's Trash fold
   * reads those and every rail filters by state; nothing else lists a trashed row.
   */
  readonly automations: readonly Automation[];
  /** The newest `fired` row with a line, while one is up (`calm`, `lateMs` and `more` filled by the projection). */
  readonly ringing?: RingLine;
  /** The foot's "next Timer 12:00 · pasta". */
  readonly nextFire?: { readonly id: string; readonly kind: AutomationKind; readonly name: string; readonly at: number };
  /** The recipes the shell gate now rates `confirm` (by name): the Console's `asks` badge, never pickable for a row. Re-judged at every snapshot. */
  readonly recipesAsking: readonly string[];
}

/** `dock`: Jarhead twice in the Dock (a recent tile next to the pin, or two pins); the engine's read-only audit raises it, Fix the Dock repairs it. */
/** `brain.local`: the local server or model needs Kevin — not running, nothing pulled that can call tools, the picked id is gone, a cloud tag, a window too small. Amber, with the command to run in `remedy.copy`. */
/** `automation.*`: a row fired late or was skipped (`missed`, remedy Run now), an action kind is off in Settings (`blocked`), the wake-brain minutes are spent (`budget`), banners are denied (`notifications`), a watched folder cannot be read (`watch`, remedy Ask). */
export type ProblemKind =
  | "permission.accessibility" | "permission.screenRecording" | "permission.microphone" | "permission.fullDiskAccess" | "permission.other"
  | "brain.unavailable" | "brain.probe" | "brain.local" | "voice.limit" | "voice.connection" | "voice.key" | "hands.helper" | "disk.low" | "dock" | "daemon" | "crash" | "other"
  | "automation.missed" | "automation.blocked" | "automation.budget" | "automation.notifications" | "automation.watch";

export interface ProblemRemedy {
  /** Button text: "Open pane", "Request", "Retry", "Reveal", "Restart daemon", "Fix the Dock"; the automation problems say "Run now" (missed), "Open Console" (blocked), "Ask" (watch). */
  readonly label: string;
  /** What the button does: an EngineCommand the surface sends, or a URL/path the surface opens. */
  readonly command?: EngineCommand;
  readonly open?: string;
  /** Text the surface offers to copy (a shell command Kevin runs himself: `ollama pull qwen3.5:27b`). Never executed by any surface. */
  readonly copy?: string;
}

export interface Problem {
  readonly kind: ProblemKind;
  readonly text: string;
  readonly remedy?: ProblemRemedy;
  /** Wall-clock ms first seen. */
  readonly since: number;
}

export interface TrashInfo {
  readonly path: string;
  readonly days: number;
  readonly bytes: number;
}

export interface PauseInfo {
  readonly at: number;
  /** The session that was closed by the pause; a resume's new session says `resumedFrom` it. */
  readonly sessionId: string;
  readonly usageSeconds: number;
  readonly sleepsAt: number;
}

export interface UsageToday {
  readonly seconds: number;
  readonly sessions: number;
}

/**
 * One of Jarhead's own Live sessions as the ledger recorded it — the Console's
 * "Jarhead" section. A resume opens a new session continuing the paused one;
 * `resumedFrom` links the chain into one conversation.
 */
export interface JarheadSessionSummary {
  readonly id: string;
  /** Ledger day (file), YYYY-MM-DD local. */
  readonly day: string;
  readonly startedAt: number;
  /** Absent while the session is still open. */
  readonly closedAt?: number;
  readonly reason?: string;
  readonly usageSeconds: number;
  readonly heard: number;
  readonly said: number;
  readonly delegations: number;
  /** The first thing Kevin said in it, trimmed; "" when nothing was heard. */
  readonly title: string;
  readonly resumedFrom?: string;
  /** Conversation (chain) state from the tombstone rows; absent = active. */
  readonly state?: ConversationState;
  /** Kevin's own name for the conversation ("" or absent = the auto title). */
  readonly name?: string;
  readonly pinned?: boolean;
  readonly trashedAt?: number;
}

export type ConversationState = "active" | "archived" | "trashed";

// --------------------------------------------------------- shell messages ---

/** Engine → surface. Snapshots are full and cheap; levels are high-frequency and separate. */
export type EngineEvent =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "levels"; readonly levels: AudioLevels }
  | { readonly type: "toast"; readonly text: string; readonly tone: "info" | "warn" | "error" }
  /** Drop whatever is queued for the speaker (stop, cancel, sleep). */
  | { readonly type: "speaker-flush" }
  /** A page of an opened agent's conversation (`replace`), or new turns while it is open (`append`). */
  | { readonly type: "agent.transcript"; readonly transcript: AgentTranscript; readonly mode: "replace" | "append" | "prepend" }
  /** One change on one thread (broadcast, ≤ 200 B); a spawned thread's steps never rebuild the snapshot. */
  | { readonly type: "thread.event"; readonly event: ThreadEvent }
  /** A page of a thread's conversation (`replace`), new rows (`append`) or older ones (`prepend`); viewers only. */
  | { readonly type: "thread.transcript"; readonly transcript: ThreadTranscript; readonly mode: "replace" | "append" | "prepend" }
  /** One change on one automation row (broadcast, coalesced 50 ms per id; ≤ 200 B except `fired`, ≈ 270 B with its presses). */
  | { readonly type: "automation.event"; readonly event: AutomationEvent }
  /** The app plays the earcon and the local speaker reads `text`; never model text except a redacted wake-brain line ≤ AUTOMATION_LINE_CHARS. */
  | { readonly type: "local.say"; readonly text?: string; readonly sound?: "Pop" | "Glass" | "Ping" | "Hero"; readonly automationId: string }
  /** A banner with the ring's presses; a press lands on the same row as the island's. */
  | { readonly type: "notify"; readonly id: string; readonly title: string; readonly body?: string; readonly presses: readonly AutomationPress[]; readonly automationId: string };

/**
 * A settings change. `null` clears an optional field (JSON has no way to send
 * "undefined"), so "system default microphone" is `{ micDeviceId: null }`.
 */
export type SettingsPatch = { readonly [K in keyof Settings]?: Settings[K] | null };

/** Surface → engine. */
export type EngineCommand =
  /** Sleep: return to the notch and close the session. `cause` says why (absent = `command`); `phrase` is the cue Kevin said. */
  | { readonly type: "sleep"; readonly cause?: SleepCause; readonly phrase?: string }
  | { readonly type: "mute" }
  | { readonly type: "unmute" }
  /**
   * Stop: the transport's stop. Interrupt everything (work, speech, hands), close the
   * Live session so the meter stops, and sleep. Also from paused. Never a no-op: with
   * nothing open it still kills background jobs.
   */
  | { readonly type: "stop" }
  /**
   * Go: the transport's one button. Asleep → wake (opens the paid session); paused →
   * resume (a new session that carries the paused one's context); awake → nothing.
   */
  | { readonly type: "go" }
  /**
   * Interrupt: cancel the current work and speech but stay awake and listening — what a
   * spoken "stop" / "cancel" / "never mind" means.
   */
  | { readonly type: "interrupt"; readonly how?: "pressed" | "said" }
  // ---- conversation cleanup (the Console's; never a brain tool). Every one is undoable.
  | { readonly type: "conversation.trash"; readonly chainId: string }
  | { readonly type: "conversation.restore"; readonly chainId: string }
  | { readonly type: "conversation.archive"; readonly chainId: string }
  | { readonly type: "conversation.rename"; readonly chainId: string; readonly name: string }
  | { readonly type: "conversation.pin"; readonly chainId: string; readonly pinned: boolean }
  /** Start a fresh conversation: the open session is closed like a stop; the next Go starts a new chain. */
  | { readonly type: "conversation.new" }
  /** Hide the Now stream's items so far (undo with now.restore); the ledger keeps them. */
  | { readonly type: "now.clear" }
  | { readonly type: "now.restore" }
  /** Move a whole day (ledger file and/or shots) to the trash, or back. */
  | { readonly type: "ledger.trash-day"; readonly day: string; readonly what: "ledger" | "shots" | "both" }
  | { readonly type: "ledger.restore-day"; readonly day: string }
  /** Run the retention sweep now (what it would move is logged first). */
  | { readonly type: "ledger.sweep" }
  | { readonly type: "agent.hide"; readonly agentId: string; readonly hidden: boolean }
  /** A remedy button pressed on a typed problem; the engine re-checks and clears it when fixed. */
  | { readonly type: "problem.retry"; readonly kind: ProblemKind }
  | { readonly type: "say-text"; readonly text: string }
  | { readonly type: "set-settings"; readonly patch: SettingsPatch }
  | { readonly type: "clear-problems" }
  | { readonly type: "agent.send"; readonly agentId: string; readonly text: string }
  | { readonly type: "agent.refresh" }
  | { readonly type: "open-console" }
  | { readonly type: "open-ledger" }
  /** Ask for one permission (the app shows the prompt or opens the pane), or "all": the sweep, every prompt in turn. */
  | { readonly type: "request-permission"; readonly which: PermissionKind | "all" }
  /** Write secrets to ~/.jarhead/env (null removes), reload, restart the brain. */
  | { readonly type: "config.set-secrets"; readonly secrets: Partial<Record<SecretKey, string | null>> }
  /** Check the OpenAI key and the brain; results land in snapshot.setup. */
  | { readonly type: "config.probe" }
  /** Follow an agent's conversation: newest page now, live turns until closed. */
  /** `viewer` names the pane that opened it (the daemon prefixes its client id) so opens are per pane and a dead client's tails close. */
  | { readonly type: "agent.open"; readonly agentId: string; readonly viewer?: string }
  | { readonly type: "agent.close"; readonly agentId: string; readonly viewer?: string }
  /** Kevin pressed Switch now after picking a voice or accent: pause, then resume with the new voice (never while work runs). */
  | { readonly type: "voice.reopen" }
  // ---- memory (the Console's Memory rail and the CLI). Forget is a state, never a deletion.
  | { readonly type: "memory.forget"; readonly id: string }
  | { readonly type: "memory.restore"; readonly id: string }
  | { readonly type: "memory.edit"; readonly id: string; readonly text: string; readonly kind?: MemoryKind }
  | { readonly type: "memory.add"; readonly text: string; readonly kind?: MemoryKind }
  /** Run extraction over what is new now (the quiet-tick run, on demand). */
  | { readonly type: "memory.run" }
  // ---- threads (the Console's panes, the satellites' drops, the CLI). `viewer` names the pane.
  | { readonly type: "thread.open"; readonly threadId: string; readonly viewer?: string }
  | { readonly type: "thread.close"; readonly threadId: string; readonly viewer?: string }
  /** Older rows before `before` (a seq), THREAD_PAGE at a time. */
  | { readonly type: "thread.history"; readonly threadId: string; readonly before: number }
  /** Stop one thread; "main" parks the main turn and leaves the others alive. */
  | { readonly type: "thread.stop"; readonly threadId: string }
  | { readonly type: "thread.pause"; readonly threadId: string }
  | { readonly type: "thread.resume"; readonly threadId: string }
  /** Allow / Deny the question a thread holds the floor with; refused when the floor is another thread's. */
  | { readonly type: "thread.answer"; readonly threadId: string; readonly yes: boolean }
  /** A follow-up turn on that thread's own brain, in Kevin's words. */
  | { readonly type: "thread.say"; readonly threadId: string; readonly text: string }
  // ---- automations (the Console's rail, the island's presses, the CLI). Never a deletion: Move to Trash / Restore.
  /** Console form / CLI; the engine fills id, state, fires, createdAt and stamps createdBy.by from `by` (absent = console; the CLI sends "cli"). */
  | { readonly type: "automation.set"; readonly automation: AutomationDraft; readonly by?: "console" | "cli" }
  | { readonly type: "automation.snooze"; readonly id: string; readonly minutes: number }
  | { readonly type: "automation.done"; readonly id: string }
  /** repeater: roll the next occurrence · one-shot: done without firing */
  | { readonly type: "automation.skip"; readonly id: string }
  | { readonly type: "automation.pause"; readonly id: string }
  | { readonly type: "automation.resume"; readonly id: string }
  | { readonly type: "automation.rename"; readonly id: string; readonly name: string }
  | { readonly type: "automation.trash"; readonly id: string }
  | { readonly type: "automation.restore"; readonly id: string }
  /** fire it now — refused unless a Live session is open (Kevin hears it) or the command came from the Console/CLI with Kevin present (presence.recent) */
  | { readonly type: "automation.run"; readonly id: string }
  /** the Console's Recipes list; the engine writes settings.json */
  | { readonly type: "recipe.set"; readonly recipe: ShellRecipe }
  | { readonly type: "recipe.trash"; readonly name: string }
  /** Older turns before message `before`. */
  | { readonly type: "agent.history"; readonly agentId: string; readonly before: string }
  /** Kevin circled a region of the screen for Jarhead (global points; `path` is his stroke). */
  | { readonly type: "mark.add"; readonly rect: Rect; readonly path?: readonly Point[] }
  /** Forget one circled region — the × on a thumbnail on the notch or in the Console. An unknown or malformed id changes nothing. The PNG stays a day's shot. */
  | { readonly type: "mark.remove"; readonly id: string }
  /** Capture the frontmost window as a mark — the notch's Window box. The window's frame is the rect (no snap), `element` is {role:"window", title, app}, `source` is "window". Works asleep. No front window: a warn toast, no mark. */
  | { readonly type: "mark.window" }
  /** Forget every circled region. */
  | { readonly type: "mark.clear" }
  /** Exit the daemon with code 75 so the app respawns it on the new code (after a self-edit passed its checks). */
  | { readonly type: "daemon.restart" }
  /** Keep the session open but go silent: mic muted, output dropped, no delegations. */
  | { readonly type: "pause" }
  | { readonly type: "resume" };

// ---------------------------------------------------------------- overlay ---

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Engine → annotation layer. Global points. */
/** Colour family of an annotation: accent (Jarhead pointing), ok/warn (feedback), mark (Kevin's own circles). */
export type OverlayTone = "accent" | "ok" | "warn" | "mark";

export type OverlayCommand =
  | { readonly cmd: "point"; readonly x: number; readonly y: number; readonly label?: string; readonly ttlMs?: number }
  | { readonly cmd: "highlight"; readonly rect: Rect; readonly label?: string; readonly ttlMs?: number }
  | { readonly cmd: "path"; readonly from: Point; readonly to: Point; readonly ttlMs?: number }
  | { readonly cmd: "click-pulse"; readonly x: number; readonly y: number }
  /** Teaching shapes: drawn on the click-through layer, fading after ttlMs (default 6 s). */
  | { readonly cmd: "circle"; readonly x: number; readonly y: number; readonly radius: number; readonly label?: string; readonly ttlMs?: number; readonly tone?: OverlayTone }
  | { readonly cmd: "arrow"; readonly from: Point; readonly to: Point; readonly label?: string; readonly ttlMs?: number; readonly tone?: OverlayTone }
  | { readonly cmd: "rect"; readonly rect: Rect; readonly label?: string; readonly ttlMs?: number; readonly tone?: OverlayTone }
  | { readonly cmd: "text"; readonly x: number; readonly y: number; readonly text: string; readonly ttlMs?: number; readonly tone?: OverlayTone }
  /** A freehand stroke (Kevin's circle echoed back, or a brain drawing). */
  | { readonly cmd: "stroke"; readonly points: readonly Point[]; readonly label?: string; readonly ttlMs?: number; readonly tone?: OverlayTone }
  /** The blob flies to a point and hovers there for dwellMs (default 2 s) before drifting home. */
  | { readonly cmd: "orb.fly"; readonly x: number; readonly y: number; readonly dwellMs?: number; readonly reason?: string; readonly thread?: string }
  /**
   * The blob draws: it flies to the first point, becomes a cursor, and drags the
   * stroke along the points (closing it when `closed`), then goes home. The stroke
   * stays on the layer for ttlMs. This is how Jarhead points at things and how it
   * outlines what Kevin circled — a hand-drawn line, not a stamped shape.
   */
  | { readonly cmd: "orb.trace"; readonly points: readonly Point[]; readonly closed?: boolean; readonly label?: string; readonly ttlMs?: number; readonly tone?: OverlayTone; readonly reason?: string; readonly thread?: string }
  | { readonly cmd: "orb.home" }
  | { readonly cmd: "clear" };

// ----------------------------------------------------------------- ledger ---

/**
 * One line of ~/.jarhead/ledger/<date>.jsonl. Append-only; the Console is a view
 * over this. `at` is wall-clock ms.
 *
 * Day files written before 2026-09-13 also hold `worker` rows and `delegation.step` rows whose step says `worker`,
 * not `thread`: readers fall through on a type or key they do not know and never check `row.type` exhaustively.
 */
export type LedgerRow =
  | { readonly at: number; readonly type: "session.started"; readonly sessionId: string; readonly voice: string; readonly resumedFrom?: string; readonly language?: string; readonly accent?: Accent }
  | { readonly at: number; readonly type: "session.closed"; readonly sessionId: string; readonly reason: string; readonly usageSeconds: number }
  /** A pause closed `sessionId` to stop the meter; the conversation is held. */
  | { readonly at: number; readonly type: "pause"; readonly sessionId: string; readonly usageSeconds: number }
  /** A resume opened `sessionId` continuing `resumedFrom` after `pausedMs`. */
  | { readonly at: number; readonly type: "resume"; readonly sessionId: string; readonly resumedFrom: string; readonly pausedMs: number }
  /** The transport's stop (pressed) or a spoken interrupt (said); `cancelled` is the delegation it cut. */
  | { readonly at: number; readonly type: "stop"; readonly how: "pressed" | "said"; readonly cancelled?: string }
  | { readonly at: number; readonly type: "heard"; readonly item: TranscriptItem }
  | { readonly at: number; readonly type: "said"; readonly item: TranscriptItem }
  | { readonly at: number; readonly type: "delegation.created"; readonly delegation: Delegation }
  | { readonly at: number; readonly type: "delegation.step"; readonly delegationId: string; readonly step: DelegationStep }
  | { readonly at: number; readonly type: "delegation.finished"; readonly delegationId: string; readonly status: DelegationStatus; readonly timings: DelegationTimings; readonly summary?: string }
  | { readonly at: number; readonly type: "problem"; readonly text: string }
  | { readonly at: number; readonly type: "agent"; readonly agent: AgentInfo }
  /** Jarhead went to sleep: why, the cue if spoken, the session it closed, whether the voice said its one-word farewell. Written before the close. */
  | { readonly at: number; readonly type: "sleep"; readonly cause: SleepCause; readonly phrase?: string; readonly sessionId?: string; readonly farewell?: boolean }
  // ---- memory audit rows: ids only (an item's text lives in the memory store, so a forgotten item's words never sit in a day file).
  | { readonly at: number; readonly type: "memory.added"; readonly id: string; readonly kind: MemoryKind; readonly origin: MemoryOrigin }
  | { readonly at: number; readonly type: "memory.updated"; readonly id: string }
  | { readonly at: number; readonly type: "memory.forgotten"; readonly id: string; readonly by: "kevin" | "reflex" | "cli" }
  | { readonly at: number; readonly type: "memory.restored"; readonly id: string }
  | { readonly at: number; readonly type: "memory.run"; readonly sessionId?: string; readonly extractor: "responses" | "local" | "rules"; readonly added: number; readonly updated: number; readonly noop: number; readonly refused: number; readonly ms: number }
  // ---- threads: the table rebuilds from these at daemon start. Status rows only for starting / waiting-* / paused, never thinking↔acting.
  | { readonly at: number; readonly type: "thread.started"; readonly thread: Thread }
  | { readonly at: number; readonly type: "thread.status"; readonly threadId: string; readonly status: ThreadStatus; readonly threadStatus?: ThreadStatus; readonly detail?: string }
  | { readonly at: number; readonly type: "thread.said"; readonly threadId: string; readonly text: string }
  /** `threadStatus` repeats `status` for the Swift mirror, whose `status` column is the delegation's. */
  | { readonly at: number; readonly type: "thread.ended"; readonly threadId: string; readonly status: "done" | "failed" | "stopped"; readonly threadStatus?: ThreadStatus; readonly summary?: string; readonly steps: number; readonly seconds: number }
  // ---- conversation cleanup: tombstone rows appended to TODAY's file; the bytes of the
  // conversation stay where they were written. `chainId` is any session id of the chain
  // (the walk resolves it to the root); the last row by `at` wins; `restored` undoes both
  // `trashed` and `archived`. Nothing is ever deleted: whole day files MOVE to
  // <stateDir>/trash by rename(2) (`ledger.moved`), and move back on restore.
  | { readonly at: number; readonly type: "conversation.trashed"; readonly chainId: string; readonly by: "kevin" | "retention" }
  | { readonly at: number; readonly type: "conversation.restored"; readonly chainId: string }
  | { readonly at: number; readonly type: "conversation.archived"; readonly chainId: string }
  | { readonly at: number; readonly type: "conversation.renamed"; readonly chainId: string; readonly name: string }
  | { readonly at: number; readonly type: "conversation.pinned"; readonly chainId: string; readonly pinned: boolean }
  /** Kevin cleared the Now stream: items at or before `at` of `sessionId` are hidden from the live view (the ledger keeps them). */
  | { readonly at: number; readonly type: "now.cleared"; readonly sessionId: string }
  | { readonly at: number; readonly type: "now.restored"; readonly sessionId: string }
  /** A whole day's ledger file or shots folder moved between the live dirs and <stateDir>/trash (never unlinked). */
  | { readonly at: number; readonly type: "ledger.moved"; readonly day: string; readonly what: "ledger" | "shots"; readonly to: "trash" | "live"; readonly path: string; readonly by: "kevin" | "retention" }
  | { readonly at: number; readonly type: "agent.hidden"; readonly agentId: string; readonly hidden: boolean }
  /** A confirmation Kevin gave that stays good for the rest of the conversation (same app, same action class); `until` is wall-clock ms. */
  | { readonly at: number; readonly type: "grant"; readonly chainId: string; readonly app: string; readonly actionClass: string; readonly until: number }
  // ---- automations: the record, never a session's rows (META_TYPES). The schedule itself lives in automations/jobs.ndjson.
  | { readonly at: number; readonly type: "automation.set"; readonly automation: Automation; readonly by: "brain" | "console" | "cli" }
  | { readonly at: number; readonly type: "automation.fired"; readonly id: string; readonly actions: readonly AutomationActionKind[]; readonly ok: boolean; readonly line: string; readonly detail?: string; readonly lateMs?: number; readonly ms: number; readonly delegationId?: string; readonly brainSeconds?: number }
  | { readonly at: number; readonly type: "automation.state"; readonly id: string; readonly state: AutomationState; readonly by: "kevin" | "brain" | "engine"; readonly until?: number; readonly detail?: string }
  | { readonly at: number; readonly type: "automation.missed"; readonly id: string; readonly dueAt: number; readonly lateMs?: number; readonly skipped?: boolean; readonly why: MissedWhy }
  | { readonly at: number; readonly type: "recipe.set"; readonly recipe: ShellRecipe; readonly by: "kevin" | "brain" }
  | { readonly at: number; readonly type: "recipe.trashed"; readonly name: string };

// ------------------------------------------------------------ type guards ---

const ENGINE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "sleep", "mute", "unmute", "stop", "go", "interrupt", "say-text", "set-settings", "clear-problems",
  "agent.send", "agent.refresh", "open-console", "open-ledger", "request-permission", "config.set-secrets", "config.probe", "agent.open", "agent.close", "agent.history", "mark.add", "mark.remove", "mark.window", "mark.clear", "daemon.restart", "pause", "resume",
  "conversation.trash", "conversation.restore", "conversation.archive", "conversation.rename", "conversation.pin", "conversation.new", "now.clear", "now.restore", "ledger.trash-day", "ledger.restore-day", "ledger.sweep", "agent.hide", "problem.retry",
  "voice.reopen", "memory.forget", "memory.restore", "memory.edit", "memory.add", "memory.run",
  "thread.open", "thread.close", "thread.history", "thread.stop", "thread.pause", "thread.resume", "thread.answer", "thread.say",
  "automation.set", "automation.snooze", "automation.done", "automation.skip", "automation.pause", "automation.resume", "automation.rename", "automation.trash", "automation.restore", "automation.run", "recipe.set", "recipe.trash",
]);

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && ENGINE_COMMAND_TYPES.has(t);
}
