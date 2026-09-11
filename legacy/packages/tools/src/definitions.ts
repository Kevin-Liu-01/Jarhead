/**
 * Anthropic tool definitions for the voice path's eyes and hands.
 *
 * The model chooses tools by reading these strings and nothing else, so two
 * rules shape every description:
 *
 * 1. Cost goes in the description. A model that does not know vision takes
 *    ~1.5s will happily call look_at_screen three times per turn, and Kevin
 *    hears each of those as dead air. Saying the price is how the model learns
 *    to ask one complete question instead.
 * 2. Failure modes go in too. The accessibility tree is usually empty on
 *    Chromium apps — most of this desktop — so find_on_screen's description
 *    says so, or the model treats every vision fallback as an error worth
 *    retrying.
 *
 * The shape matches the `tools` array of `client.messages.create` structurally
 * rather than importing the SDK type, so this package carries zero dependencies
 * and its tests need no SDK install. definitions.test.ts holds the two files in
 * lockstep: every name here must dispatch in executor.ts, and vice versa.
 */

export const CURSOR_TOOL = "cursor_position" as const;

export const TOOL_NAMES = [
  "cursor_position",
  "look_at_screen",
  "find_on_screen",
  "point_at",
  "draw",
  "highlight_region",
  "show_path",
  "clear_annotations",
  "click_at",
  "list_windows",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const DRAW_SHAPES = ["arrow", "circle", "underline"] as const;
export type DrawShape = (typeof DRAW_SHAPES)[number];

export interface ToolProperty {
  readonly type: "string" | "number";
  readonly description: string;
  readonly enum?: readonly string[];
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly input_schema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, ToolProperty>>;
    readonly required: readonly string[];
  };
}

// Kevin's second display sits ABOVE the primary (menu bar at y=-2160), so
// negative coordinates are the normal case here, not garbage. Every coordinate
// property says so, or the model "corrects" valid positions to positive ones.
const COORD_NOTE = "May be negative: a display sits above the primary one.";

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "cursor_position",
    description:
      "Where the mouse pointer is right now, in global screen coordinates. " +
      "Instant (~30ms) and exact — it reads the system pointer rather than looking at a picture. " +
      "Always use this instead of look_at_screen or find_on_screen when the question is about the " +
      "cursor itself: a screenshot may not even contain the pointer, and estimating its position " +
      "from an image is both slower and wrong.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "look_at_screen",
    description:
      "Capture the screen and answer a question about what is visible. Use when Kevin asks about " +
      "something on his screen, or when you need to see the current state before pointing or " +
      "clicking. Costs ~1.5s of capture plus vision, so ask one complete question rather than " +
      "several small ones — and never call it again for a screen nothing has changed on.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What to look for or determine, phrased as a complete question.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "find_on_screen",
    description:
      "Locate one specific UI element and get its screen coordinates. Tries the accessibility " +
      "tree first, but on Chromium apps (Chrome, Cursor, Slack, Discord — most of this desktop) " +
      "that tree is effectively empty, so expect the vision fallback and its ~1.5-2s cost; a " +
      "vision result is ordinary, not a degraded retry-worthy one. Describe the element the way " +
      "it looks ('the green Compose button near the top left'), not by internal names. Required " +
      "before point_at or click_at unless you already have coordinates from this turn.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Visual description of the element, including rough position if known.",
        },
      },
      required: ["description"],
    },
  },
  {
    name: "point_at",
    description:
      "Glide the real cursor to (x, y) and draw an arrow with a label there. This is the right " +
      "answer to 'where is …' — pointing at the thing beats describing it. The glide takes ~0.7s " +
      "and is deliberately visible so Kevin's eye can follow it. Coordinates come from " +
      "find_on_screen; never guess them.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: `Horizontal screen coordinate. ${COORD_NOTE}` },
        y: { type: "number", description: `Vertical screen coordinate. ${COORD_NOTE}` },
        label: { type: "string", description: "Short label drawn next to the arrow, e.g. 'Export'." },
      },
      required: ["x", "y", "label"],
    },
  },
  {
    name: "draw",
    description:
      "Draw an annotation at (x, y) WITHOUT moving the cursor. Use for a second or third callout " +
      "while the cursor stays where it matters, or when moving the cursor would be distracting. " +
      "Near-instant.",
    input_schema: {
      type: "object",
      properties: {
        shape: {
          type: "string",
          description: "What to draw at the point.",
          enum: DRAW_SHAPES,
        },
        x: { type: "number", description: `Horizontal screen coordinate. ${COORD_NOTE}` },
        y: { type: "number", description: `Vertical screen coordinate. ${COORD_NOTE}` },
        label: { type: "string", description: "Optional short label drawn next to the shape." },
      },
      required: ["shape", "x", "y"],
    },
  },
  {
    name: "highlight_region",
    description:
      "Draw a labelled box around the rectangle at (x, y) with width w and height h. Use for " +
      "regions rather than points: a sidebar, a toolbar, a whole form. Near-instant.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: `Left edge of the region. ${COORD_NOTE}` },
        y: { type: "number", description: `Top edge of the region. ${COORD_NOTE}` },
        w: { type: "number", description: "Width in pixels; must be positive." },
        h: { type: "number", description: "Height in pixels; must be positive." },
        label: { type: "string", description: "Optional short label drawn on the box." },
      },
      required: ["x", "y", "w", "h"],
    },
  },
  {
    name: "show_path",
    description:
      "Draw a dotted trail from (fromX, fromY) to (toX, toY). Use to demonstrate a drag or a " +
      "'from here to there' motion without performing it. Near-instant.",
    input_schema: {
      type: "object",
      properties: {
        fromX: { type: "number", description: `Start of the trail, horizontal. ${COORD_NOTE}` },
        fromY: { type: "number", description: `Start of the trail, vertical. ${COORD_NOTE}` },
        toX: { type: "number", description: `End of the trail, horizontal. ${COORD_NOTE}` },
        toY: { type: "number", description: `End of the trail, vertical. ${COORD_NOTE}` },
      },
      required: ["fromX", "fromY", "toX", "toY"],
    },
  },
  {
    name: "clear_annotations",
    description:
      "Remove every arrow, box, and trail currently on screen. Use before annotating a new topic, " +
      "or when the screen has changed underneath stale annotations. Near-instant.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "click_at",
    description:
      "Physically click the real mouse at (x, y). A safety policy gates every click: anything in " +
      "a browser, anything money/message/delete-shaped, and anything on a system surface comes " +
      "back refused with the reason. A refusal means ask Kevin to confirm out loud and wait — do " +
      "not retry the call. Only click coordinates that find_on_screen identified this turn; the " +
      "screen may have changed since older calls.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: `Horizontal screen coordinate. ${COORD_NOTE}` },
        y: { type: "number", description: `Vertical screen coordinate. ${COORD_NOTE}` },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "list_windows",
    description:
      "List the open apps and their windows, with which one is frontmost. Use to learn what is " +
      "running before deciding where to look or act. Costs ~0.5s (one AppleScript round-trip).",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
