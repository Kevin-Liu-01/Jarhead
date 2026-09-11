export {
  AgentBrowser,
  DEFAULT_AGENT_BROWSER,
  buildArgs,
  commandToArgv,
  normalizeRef,
  parseBatchEnvelope,
  parseSingleEnvelope,
  parseSnapshotData,
  toBatchString,
} from "./agentBrowser.ts";
export type {
  AgentBrowserOptions,
  BatchOutcome,
  BatchStep,
  BrowserCommand,
  BrowserResult,
  CallOptions,
  Extraction,
  OpenedPage,
  PageSnapshot,
  SnapshotRef,
} from "./agentBrowser.ts";

export { describeCapabilities, detectBrowserTools, hasBinary } from "./detect.ts";
export type { BrowserCapabilities } from "./detect.ts";

export {
  decodeEntities,
  extractTitle,
  fetchReadable,
  htmlToText,
  looksJsGated,
  parseDuckDuckGoHtml,
  research,
  searchUrlFor,
} from "./research.ts";
export type {
  FetchOutcome,
  FetchReadableOptions,
  PageRead,
  ResearchOptions,
  ResearchResult,
  SearchHit,
} from "./research.ts";

export { routeBrowserTask } from "./routing.ts";
export type { BrowserTool, RouteKind, RoutingDecision } from "./routing.ts";
