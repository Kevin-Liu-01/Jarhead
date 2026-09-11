/**
 * Public API — everything exported here loads without an Electron runtime.
 *
 * The window itself belongs to the app (packages/app/main.js creates it and
 * implements AnnotateHandler with it); this package owns the pure halves:
 * shapes in cell space, placement in global pixels, and the socket protocol
 * between them. The renderer under src/renderer/ ships as-is, plain JS,
 * loaded by the app's BrowserWindow.
 */

export {
  DIRECTIONS,
  arrow,
  box,
  bracket,
  circle,
  compose,
  crosshair,
  directionOf,
  isDirection,
  label,
  renderShape,
  trail,
  trailOrigin,
  underline,
} from "./shapes.ts";
export type { BracketSide, Direction, Grid, PlacedGrid, ShapeSpec } from "./shapes.ts";

export {
  arrowToward,
  cellsToPixels,
  pixelsToCells,
  placeNear,
  planTrail,
} from "./layout.ts";
export type {
  ArrowPlan,
  CellSize,
  Placement,
  PlacementSide,
  Point,
  Rect,
  Size,
  TrailPlan,
} from "./layout.ts";

export {
  AnnotateClient,
  AnnotateServer,
  MAX_CELLS,
  MAX_ID_CHARS,
  MAX_LABEL_CHARS,
  annotateSocketPath,
  parseCommand,
  parseReply,
  serializeCommand,
  serializeReply,
  splitLines,
} from "./protocol.ts";
export type {
  AnnotateCommand,
  AnnotateHandler,
  AnnotateReply,
  DrawCommand,
  ParsedCommand,
} from "./protocol.ts";
