import type { BrowserCapabilities } from "./detect.ts";
import { detectBrowserTools } from "./detect.ts";

/**
 * The routing contract from the wiki's browser skills
 * (skills/engineering/agent-browser/SKILL.md "Routing Contract" and the
 * Browser/UI row of wiki/meta/capability-routing-map.md), reduced to a pure
 * function over what THIS machine can execute:
 *
 * - Raw HTTP is the wiki's last resort for *automation* but the first choice
 *   for *reading*: an article fetch needs no browser and skips a Chrome
 *   launch entirely, which is most of what voice research actually does.
 * - agent-browser is the default surface for anything interactive — clicks,
 *   forms, logged-in Chrome state, screenshots, localhost UI, React/vitals —
 *   and for reads that genuinely need JavaScript or a session.
 * - Playwright is reserved for committed regression tests / existing suites.
 *   It is not installed here, so those tasks come back as "unavailable" with
 *   the missing tool named, instead of failing mid-call.
 *
 * Pure on purpose: decisions are computed from the task text and a
 * capabilities value, so tests never touch the network or the PATH.
 */

export type BrowserTool = "fetch" | "agent-browser" | "playwright";

export type RouteKind = "plain-fetch" | "agent-browser" | "playwright" | "unavailable";

export interface RoutingDecision {
  /** What the caller should actually do. */
  readonly route: RouteKind;
  /** The surface the contract picks, even when it is not installed. */
  readonly tool: BrowserTool;
  readonly reason: string;
}

const REGRESSION =
  /\b(playwright|regression tests?|e2e tests?|end[- ]to[- ]end tests?|test suite|committed tests?)\b/i;

const INTERACTIVE =
  /\b(click|fill|form|log ?in|sign ?(?:in|up)|logged[- ]?in|screenshot|type int?o|submit|upload|download|drag|hover|scroll|localhost|127\.0\.0\.1|devtools|web vitals|react (?:tree|renders|devtools)|test the ui|automate|automation)\b/i;

const JS_GATED =
  /\b(javascript|js[- ]?rendered|spa|single[- ]page app|client[- ]side render\w*|infinite scroll|dynamic(?:ally)? (?:load|render)\w*|behind (?:a )?login|paywall|needs? a (?:real )?browser)\b/i;

export function routeBrowserTask(
  task: string,
  caps: BrowserCapabilities = detectBrowserTools(),
): RoutingDecision {
  // Order matters: "write a playwright regression test for the login form"
  // mentions clicking and logging in, but the test-suite ask owns the route.
  if (REGRESSION.test(task)) {
    return caps.playwright
      ? {
          route: "playwright",
          tool: "playwright",
          reason: "the wiki contract reserves committed regression tests for Playwright",
        }
      : {
          route: "unavailable",
          tool: "playwright",
          reason:
            "committed regression tests belong to Playwright per the wiki contract, and playwright is not installed (`pnpm add -D playwright`)",
        };
  }

  if (INTERACTIVE.test(task)) {
    return caps.agentBrowser
      ? {
          route: "agent-browser",
          tool: "agent-browser",
          reason:
            "interactive browser work (clicks, forms, logged-in state, screenshots, localhost UI) routes to agent-browser per the wiki contract",
        }
      : {
          route: "unavailable",
          tool: "agent-browser",
          reason:
            "this needs interactive browser automation and agent-browser is not installed (`brew install agent-browser`)",
        };
  }

  if (JS_GATED.test(task)) {
    return caps.agentBrowser
      ? {
          route: "agent-browser",
          tool: "agent-browser",
          reason: "the page needs JavaScript or session state, which a plain fetch cannot render",
        }
      : {
          route: "unavailable",
          tool: "agent-browser",
          reason:
            "the page needs a rendering browser and agent-browser is not installed (`brew install agent-browser`)",
        };
  }

  return {
    route: "plain-fetch",
    tool: "fetch",
    reason:
      "read-only page access: a plain HTTP fetch covers it and skips the Chrome launch; escalate to agent-browser only if the page proves JS-gated",
  };
}
