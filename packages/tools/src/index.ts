export { TOOL_DEFINITIONS, TOOL_NAMES, DRAW_SHAPES } from "./definitions.ts";
export type { ToolDefinition, ToolName, ToolProperty, DrawShape } from "./definitions.ts";

export { executeTool, EXECUTABLE_TOOL_NAMES } from "./executor.ts";
export type {
  Annotator,
  ClickJudgement,
  ClickPolicy,
  Cursor,
  ElementFinder,
  FindOutcome,
  FoundElement,
  OpenWindow,
  ScreenEyes,
  ToolDeps,
  ToolOutcome,
  WindowLister,
} from "./executor.ts";

export {
  beatsFromNarration,
  planFromToolCalls,
  runChoreography,
  visualCue,
  VISUAL_TOOL_NAMES,
} from "./choreograph.ts";
export type {
  Beat,
  ChoreographyIO,
  ChoreographyResult,
  Command,
  Cue,
  ModelBlock,
} from "./choreograph.ts";

export { teach, DEFAULT_BUDGET_MS, DEFAULT_MAX_STEPS } from "./teach.ts";
export type {
  ModelStep,
  RunModel,
  TeachExchange,
  TeachOptions,
  TeachOutcome,
  TeachStop,
  ToolCallRequest,
  ToolResultRecord,
} from "./teach.ts";
