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
}

export interface DelegationTimings {
  readonly delegatedAt: number;
  readonly firstThinkingAt?: number;
  readonly firstCommentaryAt?: number;
  readonly doneAt?: number;
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

export interface Permissions {
  readonly microphone: Grant;
  readonly screenRecording: Grant;
  readonly accessibility: Grant;
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
}

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
  | { readonly type: "sleep" }
  | { readonly type: "mute" }
  | { readonly type: "unmute" }
  | { readonly type: "stop" }
  | { readonly type: "say-text"; readonly text: string }
  | { readonly type: "set-settings"; readonly patch: SettingsPatch }
  | { readonly type: "clear-problems" }
  | { readonly type: "agent.send"; readonly agentId: string; readonly text: string }
  | { readonly type: "agent.refresh" }
  | { readonly type: "open-console" }
  | { readonly type: "open-ledger" }
  | { readonly type: "request-permission"; readonly which: keyof Permissions }
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
  | { readonly at: number; readonly type: "session.started"; readonly sessionId: string; readonly voice: string }
  | { readonly at: number; readonly type: "session.closed"; readonly sessionId: string; readonly reason: string; readonly usageSeconds: number }
  | { readonly at: number; readonly type: "heard"; readonly item: TranscriptItem }
  | { readonly at: number; readonly type: "said"; readonly item: TranscriptItem }
  | { readonly at: number; readonly type: "delegation.created"; readonly delegation: Delegation }
  | { readonly at: number; readonly type: "delegation.step"; readonly delegationId: string; readonly step: DelegationStep }
  | { readonly at: number; readonly type: "delegation.finished"; readonly delegationId: string; readonly status: DelegationStatus; readonly timings: DelegationTimings; readonly summary?: string }
  | { readonly at: number; readonly type: "problem"; readonly text: string }
  | { readonly at: number; readonly type: "agent"; readonly agent: AgentInfo };

// ------------------------------------------------------------ type guards ---

export function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

const ENGINE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "wake", "sleep", "mute", "unmute", "stop", "say-text", "set-settings", "clear-problems",
  "agent.send", "agent.refresh", "open-console", "open-ledger", "request-permission", "config.set-secrets", "config.probe", "agent.open", "agent.close", "agent.history", "mark.add", "mark.clear", "daemon.restart", "pause", "resume",
]);

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && ENGINE_COMMAND_TYPES.has(t);
}
