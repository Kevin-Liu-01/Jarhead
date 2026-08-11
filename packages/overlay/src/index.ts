/**
 * Public API — everything exported here loads without an Electron runtime.
 *
 * main.ts is deliberately NOT exported: importing "electron" from a plain
 * node/tsx process throws, and the agent process only ever needs the socket
 * client plus the pure math. The overlay itself starts via
 * `pnpm --filter @jarvis/overlay start`.
 */

export {
  OverlayClient,
  OverlayServer,
  overlaySocketPath,
  parseCommand,
  parseReply,
  serializeCommand,
  serializeReply,
  splitLines,
} from "./ipc.ts";
export type { OverlayCommand, OverlayHandler, OverlayReply, ParsedCommand } from "./ipc.ts";

export { OVERLAY_STATES, isOverlayState, reduce } from "./state.ts";
export type { BuddyEvent, BuddyState, OverlayState } from "./state.ts";

export {
  APEX_SCALE,
  MAX_FLIGHT_MS,
  MIN_FLIGHT_MS,
  apexScale,
  arcControls,
  cubicBezierPoint,
  distance,
  easeInOutCubic,
  flightDuration,
  flightFrame,
} from "./pointer.ts";
export type { FlightFrame, Point } from "./pointer.ts";

export {
  clampToWorkArea,
  containsPoint,
  displayContaining,
  nearestDisplay,
  windowTopLeftFor,
} from "./display.ts";
export type { DisplayInfo, Rect, Size } from "./display.ts";
