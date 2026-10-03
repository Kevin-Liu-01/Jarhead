/** The app's phases (Protocol.swift) and the six kinds the desk steps through; the kinds' words and faces are the deck's PHASES. */
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

/** The app phase each kind wears; alarm is a site kind (README:281) that rings while the app sleeps, so it wears asleep. */
export const DESK_PHASE: Record<DeskKind, Phase> = {
  listening: "listening",
  thinking: "thinking",
  acting: "acting",
  speaking: "speaking",
  asleep: "asleep",
  alarm: "asleep",
};
