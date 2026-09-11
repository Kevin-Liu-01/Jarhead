import { COMPUTER_MEMBERS, DESKTOP_TOOLS } from "@jarhead/hands";

/**
 * Every tool the brain can call, described once as JSON Schema.
 *
 * The same table feeds three shapes: OpenAI Responses function tools (for Live's
 * managed delegation), MCP tool definitions (for Claude Code through the Agent
 * SDK), and Anthropic function tools. The computer members mirror Claude's
 * native `computer_toolset_20260801` so a brain that has the native toolset can
 * drop these and keep identical semantics.
 */

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: { readonly type: "object"; readonly properties: Record<string, unknown>; readonly required?: readonly string[]; readonly additionalProperties?: false };
}

const coordinate = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, y] in pixels of the most recent screenshot" };
const modifiers = { type: "string", description: "Optional modifier keys held during the action, e.g. 'shift' or 'cmd+shift'" };

const COMPUTER_SPECS: Record<(typeof COMPUTER_MEMBERS)[number], ToolSpec> = {
  screenshot: {
    name: "screenshot",
    description: "Capture the display under the cursor (or a given display id) and return it as an image. Always take a fresh screenshot before clicking on something you have not seen since the screen changed. Coordinates for every other tool are pixels of the LAST screenshot.",
    parameters: { type: "object", properties: { display: { type: ["number", "string"], description: "display id, 'main', or 'cursor' (default)" } } },
  },
  zoom: {
    name: "zoom",
    description: "Return a full-resolution crop of a region of the last screenshot, for reading small text. Region is [x0, y0, x1, y1] in screenshot pixels. Click coordinates still refer to the full screenshot.",
    parameters: { type: "object", properties: { region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } }, required: ["region"] },
  },
  left_click: { name: "left_click", description: "Left-click at a screenshot coordinate. Irreversible-looking controls (Send, Pay, Delete, Publish…) return needs_confirmation instead of clicking; then ask Kevin and stop.", parameters: { type: "object", properties: { coordinate, text: modifiers }, required: ["coordinate"] } },
  right_click: { name: "right_click", description: "Right-click at a screenshot coordinate.", parameters: { type: "object", properties: { coordinate, text: modifiers }, required: ["coordinate"] } },
  middle_click: { name: "middle_click", description: "Middle-click at a screenshot coordinate.", parameters: { type: "object", properties: { coordinate, text: modifiers }, required: ["coordinate"] } },
  double_click: { name: "double_click", description: "Double-click at a screenshot coordinate.", parameters: { type: "object", properties: { coordinate, text: modifiers }, required: ["coordinate"] } },
  triple_click: { name: "triple_click", description: "Triple-click at a screenshot coordinate (selects a line/paragraph).", parameters: { type: "object", properties: { coordinate, text: modifiers }, required: ["coordinate"] } },
  left_click_drag: { name: "left_click_drag", description: "Press at start_coordinate, drag to coordinate, release.", parameters: { type: "object", properties: { start_coordinate: coordinate, coordinate, text: modifiers }, required: ["start_coordinate", "coordinate"] } },
  mouse_move: { name: "mouse_move", description: "Move the pointer to a screenshot coordinate without clicking. Use this to point at things for Kevin.", parameters: { type: "object", properties: { coordinate }, required: ["coordinate"] } },
  left_mouse_down: { name: "left_mouse_down", description: "Press and hold the left button at the current pointer position.", parameters: { type: "object", properties: {} } },
  left_mouse_up: { name: "left_mouse_up", description: "Release the left button.", parameters: { type: "object", properties: {} } },
  cursor_position: { name: "cursor_position", description: "Where the pointer is, in pixels of the last screenshot.", parameters: { type: "object", properties: {} } },
  scroll: {
    name: "scroll",
    description: "Scroll at a coordinate. scroll_amount is in wheel clicks (about 60 px each).",
    parameters: { type: "object", properties: { coordinate, scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] }, scroll_amount: { type: "number" }, text: modifiers }, required: ["scroll_direction", "scroll_amount"] },
  },
  type: { name: "type", description: "Type text into the focused element. Refused in password fields.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  key: { name: "key", description: "Press a key or chord: 'Return', 'Tab', 'Escape', 'cmd+s', 'cmd+shift+p', 'ctrl+c', 'Down'.", parameters: { type: "object", properties: { text: { type: "string" }, repeat: { type: "integer", minimum: 1, maximum: 100 } }, required: ["text"] } },
  hold_key: { name: "hold_key", description: "Hold a key for a duration in seconds.", parameters: { type: "object", properties: { text: { type: "string" }, duration: { type: "number" } }, required: ["text", "duration"] } },
  wait: { name: "wait", description: "Wait for a number of seconds (for a page or app to settle).", parameters: { type: "object", properties: { duration: { type: "number" } }, required: ["duration"] } },
};

const DESKTOP_SPECS: Record<(typeof DESKTOP_TOOLS)[number], ToolSpec> = {
  open_app: { name: "open_app", description: "Launch or bring an application to the front by name (e.g. 'Safari', 'Slack', 'Cursor').", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  focus_app: { name: "focus_app", description: "Bring a running app to the front by name.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  list_windows: { name: "list_windows", description: "List on-screen windows: app, title, position and size in global points. Cheap; use it to know what is open before taking screenshots.", parameters: { type: "object", properties: {} } },
  read_focused_text: { name: "read_focused_text", description: "Read the value and selected text of the focused element via accessibility (exact text, no OCR). Password fields are never read.", parameters: { type: "object", properties: {} } },
  element_at: { name: "element_at", description: "Describe the UI element at a screenshot coordinate via accessibility (role, title, value).", parameters: { type: "object", properties: { coordinate }, required: ["coordinate"] } },
  frontmost_app: { name: "frontmost_app", description: "Which app and window is in front.", parameters: { type: "object", properties: {} } },
};

export const AGENT_SPECS: readonly ToolSpec[] = [
  { name: "agents_list", description: "List the agent sessions on this Mac — Codex threads, Claude Code sessions and other agent CLIs found on disk or running, whichever vendor — with id, status (idle/working/blocked/done), a one-line detail and working directory. Also reports each tool's health (installed, signed in, desktop app running).", parameters: { type: "object", properties: {} } },
  { name: "agent_send", description: "Send a prompt or reply to an agent session by id or by a loose name ('the reviewer', 'gt-cloud', 'the codex in jarvis'). Works the same for every tool: a Codex thread open in the Codex app receives it there (queued), a saved Codex thread or Claude Code session is continued headlessly; a blocked Claude Code session takes 'yes'/'no' as the answer to its permission question. Returns immediately; use agent_wait to wait for it to settle.", parameters: { type: "object", properties: { agent: { type: "string" }, text: { type: "string" } }, required: ["agent", "text"] } },
  { name: "agent_read", description: "Read an agent session's latest output: its last assistant message (any tool), or the last lines of its terminal.", parameters: { type: "object", properties: { agent: { type: "string" }, lines: { type: "integer", minimum: 5, maximum: 400 } }, required: ["agent"] } },
  { name: "agent_wait", description: "Wait until an agent session is idle, blocked or done (or the timeout, seconds, passes). Returns its status and last output.", parameters: { type: "object", properties: { agent: { type: "string" }, timeout: { type: "number", minimum: 1, maximum: 600 } }, required: ["agent"] } },
  { name: "agent_start", description: "Start a new agent session in a folder: tool 'codex' (a new Codex thread, Kevin's ChatGPT login, appears in the Codex app) or 'claude-code' (a headless Claude Code session), with a working directory and the first prompt. Existing sessions found on this Mac are continued with agent_send, not started here.", parameters: { type: "object", properties: { tool: { type: "string", enum: ["codex", "claude-code"], description: "which agent CLI runs the session" }, cwd: { type: "string", description: "absolute path of the folder to work in" }, name: { type: "string" }, prompt: { type: "string" }, kind: { type: "string", description: "deprecated alias of tool" } }, required: ["tool", "cwd", "prompt"] } },
];

export const MISC_SPECS: readonly ToolSpec[] = [
  { name: "run_shell", description: "Run a shell command on Kevin's Mac and return stdout/stderr (30 s cap). Read-only commands run immediately; anything that changes state returns needs_confirmation — ask Kevin and stop.", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } },
  { name: "speak_progress", description: "Say a short interim update out loud while a long task continues (one sentence). Use sparingly: after each meaningful step, not after each click.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "remember", description: "Save a short note for later in this session (a fact Kevin told you, a thing you found).", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { name: "recall", description: "List the notes saved with remember, newest last.", parameters: { type: "object", properties: {} } },
];

export const COMPUTER_TOOL_SPECS: readonly ToolSpec[] = COMPUTER_MEMBERS.map((m) => COMPUTER_SPECS[m]);
export const DESKTOP_TOOL_SPECS: readonly ToolSpec[] = DESKTOP_TOOLS.map((t) => DESKTOP_SPECS[t]);
export const ALL_TOOL_SPECS: readonly ToolSpec[] = [...COMPUTER_TOOL_SPECS, ...DESKTOP_TOOL_SPECS, ...AGENT_SPECS, ...MISC_SPECS];

export function specByName(name: string): ToolSpec | undefined {
  return ALL_TOOL_SPECS.find((t) => t.name === name);
}
