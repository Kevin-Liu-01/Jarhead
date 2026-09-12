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
  /** The worker's name when one of the delegation's workers ran this step (absent: the main brain). */
  readonly worker?: string;
}

// ---- workers: a second pair of hands inside one delegation -----------------
//
// A Worker is not an Agent (agents are Kevin's coding sessions). The main brain spawns a
// worker with `worker_start` when Kevin asks for two independent things at once ("tell
// Ben on Slack I'm late and play Focus on Spotify"). A worker is its own brain over the
// same tools and policy, in one of two lanes: `background` never touches the pointer,
// keyboard or frontmost app (Apple events, browser, files, shell, web only); `screen`
// waits its turn for the one screen lease. Workers never narrate: the voice speaks one
// short line when the split happens and one when each worker finishes. Every stop verb
// (interrupt, Stop, Pause, sleep) cancels every worker. At most WORKER_MAX at once.
export type WorkerLane = "background" | "screen";
export type WorkerStatus = "starting" | "working" | "waiting-screen" | "awaiting-confirmation" | "done" | "failed" | "cancelled";
export interface Worker {
  /** Unguessable ("w_…"); also the lane id a worker's tool calls carry on the wire. */
  readonly id: string;
  /** Spoken as-is ("Spotify"); ≤ 16 chars, unique within its delegation. */
  readonly name: string;
  /** The parent delegation. */
  readonly delegationId: string;
  /** The main brain's brief, redacted. */
  readonly task: string;
  readonly lane: WorkerLane;
  readonly status: WorkerStatus;
  /** Last line or failure reason, ≤ 200 chars. */
  readonly detail?: string;
  readonly startedAt: number;
  readonly doneAt?: number;
  readonly steps: number;
}
/** Workers alive at once, per delegation and in total. */
export const WORKER_MAX = 2;
/** How long a finished worker stays in the snapshot for the Console before it is dropped. */
export const WORKER_LINGER_MS = 30_000;

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
}

// ----------------------------------------------------------------- agents ---

/** "sessions" is the read-only discovery of agent sessions on disk and in processes (Claude Code, Codex, …). */
export type AgentKind = "claude-code" | "sessions";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "offline";

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
}

// ------------------------------------------------------- conversations ---

export type AgentRole = "user" | "assistant" | "tool" | "system";

export interface AgentToolCall {
  readonly name: string;
  /** Pretty-printed input, truncated by the connector. */
  readonly input?: string;
  readonly output?: string;
  readonly status: "running" | "done" | "error";
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
}

export interface ConnectorHealth {
  readonly kind: AgentKind;
  readonly ok: boolean;
  readonly detail: string;
}

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
export type BrainKind = "auto" | "codex" | "claude-code" | "anthropic-api" | "openai-responses" | "openai-compatible";
export const BRAIN_KINDS: readonly BrainKind[] = ["auto", "codex", "claude-code", "anthropic-api", "openai-responses", "openai-compatible"];
/** The order `auto` tries backends in. */
export const AUTO_BRAIN_ORDER: readonly Exclude<BrainKind, "auto">[] = ["codex", "claude-code", "anthropic-api", "openai-compatible", "openai-responses"];

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
 * billed — and only after authentication does it send `wake`.
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
  /** Model override for the chosen backend; empty = that backend's default. */
  readonly brainModel: string;
  /** openai-compatible only: base URL of the Chat Completions server (no trailing /v1 needed). */
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
  /** Let the brain split independent work across workers (a second pair of hands). */
  readonly workers: boolean;
}

export const DEFAULT_WAKE: WakeSettings = {
  enabled: true,
  phrases: ["jarhead", "jar head", "hey jarhead"],
  auth: "either",
};

export const DEFAULT_SETTINGS: Settings = {
  voice: "cedar",
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
  workers: true,
};

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

export interface Permissions {
  readonly microphone: Grant;
  readonly screenRecording: Grant;
  readonly accessibility: Grant;
  /** The whole list, as the app last read it (the process TCC keys on); absent from older apps. */
  readonly all?: readonly PermissionInfo[];
}

// --------------------------------------------------------------- snapshot ---

export interface AudioLevels {
  /** 0..1 RMS of the last mic frame. */
  readonly input: number;
  /** 0..1 RMS of the last output frame. */
  readonly output: number;
}

export interface SessionInfo {
  readonly id: string;
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
  /** Most recent problems, newest last. Cleared by the user. */
  readonly problems: readonly string[];
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
  /**
   * The problems, typed: what kind, one line, and the one action that fixes it. `problems`
   * (plain text) stays for older surfaces; this list is the same problems with their remedy.
   */
  readonly problemsTyped?: readonly Problem[];
  /** What the trash holds, for the Console ("3 days · 129 MB"; Reveal in Finder). */
  readonly trash?: TrashInfo;
  /** Agents Kevin hid from the rail (agent.hidden rows). */
  readonly hiddenAgents?: readonly string[];
  /** The delegation's workers: running ones and those finished within WORKER_LINGER_MS. */
  readonly workers?: readonly Worker[];
}

export type ProblemKind =
  | "permission.accessibility" | "permission.screenRecording" | "permission.microphone" | "permission.fullDiskAccess" | "permission.other"
  | "brain.unavailable" | "brain.probe" | "voice.limit" | "voice.connection" | "voice.key" | "hands.helper" | "disk.low" | "daemon" | "crash" | "other";

export interface ProblemRemedy {
  /** Button text: "Open pane", "Request", "Retry", "Reveal", "Restart daemon". */
  readonly label: string;
  /** What the button does: an EngineCommand the surface sends, or a URL/path the surface opens. */
  readonly command?: EngineCommand;
  readonly open?: string;
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

/** GPT-Live-1 list price (docs/REDESIGN.md §1), for the meter. Billed per second. */
export const LIVE_PRICE_PER_MINUTE_USD = 0.05;

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
  | { readonly type: "agent.transcript"; readonly transcript: AgentTranscript; readonly mode: "replace" | "append" };

/**
 * A settings change. `null` clears an optional field (JSON has no way to send
 * "undefined"), so "system default microphone" is `{ micDeviceId: null }`.
 */
export type SettingsPatch = { readonly [K in keyof Settings]?: Settings[K] | null };

/** Surface → engine. */
export type EngineCommand =
  | { readonly type: "wake" }
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
   * spoken "stop" / "cancel" / "never mind" means. The pre-transport `stop`.
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
  /** Stop one worker (the Console's Stop on its row); the others and the session carry on. */
  | { readonly type: "worker.stop"; readonly workerId: string }
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
  | { readonly type: "agent.open"; readonly agentId: string }
  | { readonly type: "agent.close"; readonly agentId: string }
  /** Older turns before message `before`. */
  | { readonly type: "agent.history"; readonly agentId: string; readonly before: string }
  /** Kevin circled a region of the screen for Jarhead (global points; `path` is his stroke). */
  | { readonly type: "mark.add"; readonly rect: Rect; readonly path?: readonly Point[] }
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
  | { readonly cmd: "orb.fly"; readonly x: number; readonly y: number; readonly dwellMs?: number; readonly reason?: string }
  /**
   * The blob draws: it flies to the first point, becomes a cursor, and drags the
   * stroke along the points (closing it when `closed`), then goes home. The stroke
   * stays on the layer for ttlMs. This is how Jarhead points at things and how it
   * outlines what Kevin circled — a hand-drawn line, not a stamped shape.
   */
  | { readonly cmd: "orb.trace"; readonly points: readonly Point[]; readonly closed?: boolean; readonly label?: string; readonly ttlMs?: number; readonly tone?: OverlayTone; readonly reason?: string }
  | { readonly cmd: "orb.home" }
  | { readonly cmd: "clear" };

// ----------------------------------------------------------------- ledger ---

/**
 * One line of ~/.jarhead/ledger/<date>.jsonl. Append-only; the Console is a view
 * over this. `at` is wall-clock ms.
 */
export type LedgerRow =
  | { readonly at: number; readonly type: "session.started"; readonly sessionId: string; readonly voice: string; readonly resumedFrom?: string }
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
  /** A worker started or changed status (one row per change; `worker` is the whole record at that moment). */
  | { readonly at: number; readonly type: "worker"; readonly worker: Worker }
  /** Jarhead went to sleep: why, the cue if spoken, the session it closed, whether the voice said its one-word farewell. Written before the close. */
  | { readonly at: number; readonly type: "sleep"; readonly cause: SleepCause; readonly phrase?: string; readonly sessionId?: string; readonly farewell?: boolean }
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
  | { readonly at: number; readonly type: "grant"; readonly chainId: string; readonly app: string; readonly actionClass: string; readonly until: number };

// ------------------------------------------------------------ type guards ---

export function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

const ENGINE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "wake", "sleep", "mute", "unmute", "stop", "go", "interrupt", "say-text", "set-settings", "clear-problems",
  "agent.send", "agent.refresh", "open-console", "open-ledger", "request-permission", "config.set-secrets", "config.probe", "agent.open", "agent.close", "agent.history", "mark.add", "mark.clear", "daemon.restart", "pause", "resume",
  "conversation.trash", "conversation.restore", "conversation.archive", "conversation.rename", "conversation.pin", "conversation.new", "now.clear", "now.restore", "ledger.trash-day", "ledger.restore-day", "ledger.sweep", "agent.hide", "problem.retry",
  "worker.stop",
]);

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && ENGINE_COMMAND_TYPES.has(t);
}
