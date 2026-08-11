export {
  captureScreen,
  captureRegion,
  captureWindow,
  downscale,
  downscaleArgs,
  downscaledPathFor,
  buildRegionArg,
  ScreenPermissionError,
} from "./screen.ts";
export type { Capture, CaptureOptions, Region } from "./screen.ts";

export {
  frontmostApp,
  listWindows,
  findElements,
  findElementsDetailed,
  elementAt,
  axAvailable,
  pressByPath,
  pathToReference,
  escapeAppleScriptString,
  runAppleScript,
  buildListWindowsScript,
  buildWalkScript,
  buildShallowCountScript,
  AxPermissionError,
  DEFAULT_OSA_TIMEOUT_MS,
} from "./ax.ts";
export type {
  AxElement,
  AxAvailability,
  AxPoint,
  AxSize,
  ElementFilter,
  FrontmostApp,
  WalkOptions,
  WalkOutcome,
  WindowInfo,
} from "./ax.ts";

export {
  moveTo,
  click,
  doubleClick,
  rightClick,
  scroll,
  type,
  key,
  pressElement,
  cursorPosition,
  easedSteps,
  cliclickCanExpress,
  pointerBackend,
  buildKeyScript,
  buildTypeScript,
  InputUnavailableError,
} from "./input.ts";
export type { Point, TimedPoint, MoveOptions, PointerBackend, PressOutcome } from "./input.ts";

export { classify, isAllowed, CONFIRM_LEVELS } from "./policy.ts";
export type { ComputerAction, Classification, ConfirmLevel } from "./policy.ts";

export { captureSelection } from "./select.ts";
export type { SelectionBundle, SelectOptions } from "./select.ts";

export { run, RunTimeoutError } from "./exec.ts";
export type { RunOptions, RunResult } from "./exec.ts";
