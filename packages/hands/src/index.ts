export { NativeHandsProcess, NativeRequestError, HELPER_PERMISSION_KINDS, TYPE_CANCEL_SIGNAL, parseHelperPermissions, completeHelperPermissions } from "./native.ts";
export type { NativeHands, NativeError, Permissions, HelloPermissions, HelperPermissionKind, DisplayInfo, ScreenshotResult, FrontmostInfo, WindowInfo, FocusedText, ElementInfo, NativeHandsProcessOptions, AxNodeInfo, FoundElement, FindElementResult, AxTreeResult, BrowserTab, TypeResult } from "./native.ts";
export { Screen, fitScale, DEFAULT_SHOT_BUDGET, QUICK_SHOT_BUDGET } from "./screen.ts";
export type { ScreenMapping, ShotBudget } from "./screen.ts";
export { ComputerToolset, ConfirmationState, COMPUTER_MEMBERS, DESKTOP_TOOLS, ACTING_MEMBERS, READ_ONLY_TOOLS, YES_PATTERN, GRANT_TTL_MS, HOLD_ID, STALE_FRAME } from "./toolset.ts";
export type { ToolResult, ActionEvent, PendingConfirmation, Grantable, ConfirmationGrant, ArmedConfirmation, ToolsetOptions, ComputerMember, DesktopTool } from "./toolset.ts";
export { screencaptureFallback, screencaptureIndex } from "./fallback.ts";
export { fakeHandsSpawn } from "./fake.ts";
