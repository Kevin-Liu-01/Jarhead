/**
 * The app's own rail, as the Console renders it (docs/media/console-jarhead.jpg, console-threads.jpg,
 * console-settings.jpg; ITERATE.md §7): the Threads group, the conversations' folds, the Agents group.
 * These are the app's rendered strings over the harness's fixed data, kept byte for byte; nothing here is a claim.
 */
import type { AgentTool } from "@/components/kit/AgentMark";

interface ThreadRow {
  readonly name: string;
  /** `asks` wears the speaking tone as a badge; `done` sits as the row's value. */
  readonly status: "asks" | "done";
  readonly meta: string;
}

interface FoldHead {
  readonly word: string;
  readonly count: number;
  readonly summary: string;
  readonly tool?: AgentTool;
}

export const RAIL_APP = {
  threads: {
    word: "Threads",
    figure: "3 · 1 asks",
    rows: [
      { name: "Slack", status: "asks", meta: "00:06 · screen · 4 steps" },
      { name: "Spotify", status: "done", meta: "00:06 · background · 2 steps" },
      { name: "Notes", status: "done", meta: "00:03 · background · 3 steps" },
    ] as readonly ThreadRow[],
  },
  pinned: { word: "Pinned", count: 1, row: { name: "Auth branch triage", value: "11:20" } },
  today: { word: "Today", count: 1, row: { name: "Pull up my sessions and tell me who's stuck.", badge: "×1", value: "14:15" } },
  folds: [
    { word: "Yesterday", count: 2, summary: "4.2 min" },
    { word: "Older", count: 3, summary: "since Sep 9" },
  ] as readonly FoldHead[],
  agents: {
    word: "Agents",
    count: 7,
    claude: {
      word: "Claude Code",
      count: 5,
      rows: [
        { name: "gt · api auth", badge: "asks", meta: "gt · 6m" },
        { name: "brain", live: "working", meta: "~ · 5s" },
        { name: "jarhead · console", live: "working", meta: "mac · 2m" },
        { name: "kevin-wiki", value: "idle · 31m" },
      ] as ReadonlyArray<{ readonly name: string; readonly badge?: string; readonly live?: string; readonly value?: string; readonly meta?: string }>,
    },
    folds: [
      { word: "Ended", count: 1, summary: "7m" },
      { word: "Codex", count: 4, summary: "ended · 40m", tool: "codex" },
      { word: "Cursor", count: 1, summary: "1 idle", tool: "cursor" },
    ] as readonly FoldHead[],
  },
} as const;
