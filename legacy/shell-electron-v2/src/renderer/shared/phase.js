// Phase / status metadata shared by every window. Colors mirror tokens.css and
// are duplicated here as literals only because the orb draws them on a canvas.

export const PHASE_META = Object.freeze({
  asleep: { label: "Asleep", color: "#7a6a5a", token: "var(--phase-asleep)", hint: "No live session. Nothing is billed." },
  connecting: { label: "Connecting", color: "#9fb4c8", token: "var(--phase-connecting)", hint: "Opening the live session…" },
  listening: { label: "Listening", color: "#5ad7ff", token: "var(--phase-listening)", hint: "Mic is hot. Jarhead is attending." },
  speaking: { label: "Speaking", color: "#ffb454", token: "var(--phase-speaking)", hint: "Jarhead is talking." },
  thinking: { label: "Thinking", color: "#b48cff", token: "var(--phase-thinking)", hint: "The brain is working on it." },
  acting: { label: "Acting", color: "#6ee7a0", token: "var(--phase-acting)", hint: "Jarhead is using the computer." },
  muted: { label: "Muted", color: "#6b7280", token: "var(--phase-muted)", hint: "Mic is muted. Session stays open." },
  error: { label: "Error", color: "#ff5d6c", token: "var(--phase-error)", hint: "Something broke. Check problems." },
});

export const phaseMeta = (phase) => PHASE_META[phase] ?? PHASE_META.error;

/** Phases where Jarhead is doing something the user might want to stop. */
export const BUSY_PHASES = new Set(["speaking", "thinking", "acting"]);

/** Phases with an open live session. */
export const SESSION_PHASES = new Set(["connecting", "listening", "speaking", "thinking", "acting", "muted"]);

export const STATUS_META = Object.freeze({
  idle: { label: "idle", token: "var(--status-idle)" },
  working: { label: "working", token: "var(--status-working)" },
  blocked: { label: "blocked", token: "var(--status-blocked)" },
  done: { label: "done", token: "var(--status-done)" },
  unknown: { label: "unknown", token: "var(--status-unknown)" },
  offline: { label: "offline", token: "var(--status-offline)" },
});

export const statusMeta = (status) => STATUS_META[status] ?? STATUS_META.unknown;

export const AGENT_KIND_META = Object.freeze({
  "claude-code": { label: "Claude Code" },
  herdr: { label: "herdr" },
  t3: { label: "T3 Code" },
});

export const agentKindLabel = (kind) => AGENT_KIND_META[kind]?.label ?? kind;

export const DELEGATION_META = Object.freeze({
  running: { label: "running", token: "var(--phase-thinking)", live: true },
  "awaiting-confirmation": { label: "waiting for Kevin", token: "var(--phase-speaking)", live: true },
  done: { label: "done", token: "var(--phase-acting)", live: false },
  failed: { label: "failed", token: "var(--phase-error)", live: false },
  cancelled: { label: "cancelled", token: "var(--phase-muted)", live: false },
});

export const delegationMeta = (status) => DELEGATION_META[status] ?? DELEGATION_META.running;

export const GRANT_META = Object.freeze({
  granted: { label: "granted", token: "var(--phase-acting)" },
  denied: { label: "denied", token: "var(--phase-error)" },
  unknown: { label: "unknown", token: "var(--status-unknown)" },
});

export const VOICES = [
  "cedar", "marin", "alloy", "ash", "ballad", "beacon", "bossa", "cinder", "coral", "delta", "echo",
  "gleam", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
];

export const BRAINS = ["claude-code", "anthropic-api", "openai-responses"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
