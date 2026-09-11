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
export const PHASES = ["asleep", "connecting", "listening", "speaking", "thinking", "acting", "muted", "error"] as const;
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

export interface AgentInfo {
  /** Stable, connector-scoped: "sessions:claude:<uuid>", "sessions:codex:<id>", "claude-code:<sessionId>". */
  readonly id: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly status: AgentStatus;
  readonly detail?: string;
  readonly cwd?: string;
  readonly updatedAt: number;
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
}

// --------------------------------------------------------- shell messages ---

/** Engine → surface. Snapshots are full and cheap; levels are high-frequency and separate. */
export type EngineEvent =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "levels"; readonly levels: AudioLevels }
  | { readonly type: "toast"; readonly text: string; readonly tone: "info" | "warn" | "error" }
  /** Drop whatever is queued for the speaker (stop, cancel, sleep). */
  | { readonly type: "speaker-flush" };

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
  | { readonly type: "config.probe" };

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
export type OverlayCommand =
  | { readonly cmd: "point"; readonly x: number; readonly y: number; readonly label?: string; readonly ttlMs?: number }
  | { readonly cmd: "highlight"; readonly rect: Rect; readonly label?: string; readonly ttlMs?: number }
  | { readonly cmd: "path"; readonly from: Point; readonly to: Point; readonly ttlMs?: number }
  | { readonly cmd: "click-pulse"; readonly x: number; readonly y: number }
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
  "agent.send", "agent.refresh", "open-console", "open-ledger", "request-permission", "config.set-secrets", "config.probe",
]);

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && ENGINE_COMMAND_TYPES.has(t);
}
