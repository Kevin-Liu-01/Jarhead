/** The app's phases (Protocol.swift) and the six kinds the desk steps through, with COPY.md's phase words and hints. */
export type Phase =
  | "asleep"
  | "connecting"
  | "listening"
  | "thinking"
  | "acting"
  | "speaking"
  | "muted"
  | "paused"
  | "error";

export type DeskKind = "listening" | "thinking" | "acting" | "speaking" | "asleep" | "alarm";

/** In cycle order (design.md §4.5). */
export const DESK_KINDS: readonly DeskKind[] = ["listening", "thinking", "acting", "speaking", "asleep", "alarm"];

export interface PhaseMeta {
  label: string;
  hint: string;
  face: string;
  token: `--jh-${string}`;
  phase: Phase;
}

/** The words and hints are COPY.md's "Phase words and hints"; the faces BlobField.swift via facts-orb.md §3; alarm is a site kind (README:281). */
export const PHASE_META: Record<DeskKind, PhaseMeta> = {
  listening: { label: "Listening", hint: "The mic is open. The meter runs.", face: "O O", token: "--jh-listening", phase: "listening" },
  thinking: { label: "Thinking", hint: "The brain has the task.", face: "- -", token: "--jh-thinking", phase: "thinking" },
  acting: { label: "Acting", hint: "The hands are using the Mac.", face: "o o", token: "--jh-acting", phase: "acting" },
  speaking: { label: "Speaking", hint: "It is talking. Say stop to interrupt.", face: "^ ^", token: "--jh-speaking", phase: "speaking" },
  asleep: { label: "Asleep", hint: "No session. Nothing billed.", face: "- -", token: "--jh-asleep", phase: "asleep" },
  alarm: { label: "Alarm", hint: "Rings asleep. Nothing billed.", face: "o o", token: "--jh-mark", phase: "asleep" },
};
