/**
 * The buddy's state machine — pure, so the transition rules live in one place
 * and are testable without a window. The main process owns the single source
 * of truth and the renderer only ever mirrors what it is told.
 */

export const OVERLAY_STATES = ["idle", "listening", "thinking", "speaking", "pointing"] as const;
export type OverlayState = (typeof OVERLAY_STATES)[number];

/**
 * "hidden" is deliberately not an OverlayState. It is window visibility, not a
 * pose, and only the explicit hide/show commands may cross that line — see the
 * "set" rule below for why.
 */
export type BuddyState = OverlayState | "hidden";

export type BuddyEvent =
  | { readonly type: "set"; readonly state: OverlayState }
  | { readonly type: "hide" }
  | { readonly type: "show" }
  | { readonly type: "land" };

export function isOverlayState(value: unknown): value is OverlayState {
  return typeof value === "string" && (OVERLAY_STATES as readonly string[]).includes(value);
}

export function reduce(current: BuddyState, event: BuddyEvent): BuddyState {
  switch (event.type) {
    case "hide":
      return "hidden";
    case "show":
      return current === "hidden" ? "idle" : current;
    case "set":
      // A hidden buddy stays hidden. Kevin hid it on purpose; a background
      // task flipping to "thinking" and popping the window back up would be
      // exactly the interruption an overlay must never cause. Showing is a
      // separate, explicit intent.
      return current === "hidden" ? "hidden" : event.state;
    case "land":
      // Only a flight in progress may land. If a newer command changed state
      // mid-flight (barge-in sets "speaking" while the window is still
      // moving), the stale flight timer's land must not stomp it.
      return current === "pointing" ? "idle" : current;
  }
}
