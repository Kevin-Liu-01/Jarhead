/**
 * Flight choreography — pure math, no Electron.
 *
 * This is the one piece of Clicky worth copying carefully (DECISION.md §6): a
 * cubic bezier arc with duration scaled by distance and a scale pulse at the
 * apex reads as a deliberate gesture, where a linear glide reads as a mouse
 * macro. Everything here is a pure function of (from, to, elapsed) so the
 * geometry can be pinned down by unit tests without an Electron runtime — the
 * main process just replays frames onto `win.setPosition`.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const MIN_FLIGHT_MS = 600;
export const MAX_FLIGHT_MS = 1400;
export const APEX_SCALE = 1.3;

// Below SHORT_PX every flight takes the minimum — a 40px hop stretched over a
// proportional 20ms would be an invisible teleport, and the gesture only means
// something if Kevin can see it. Past LONG_PX the cap holds, because a
// cross-display flight that takes 3 seconds is a delay, not a flourish.
const SHORT_PX = 120;
const LONG_PX = 1600;

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function flightDuration(distancePx: number): number {
  if (distancePx <= SHORT_PX) return MIN_FLIGHT_MS;
  if (distancePx >= LONG_PX) return MAX_FLIGHT_MS;
  const fraction = (distancePx - SHORT_PX) / (LONG_PX - SHORT_PX);
  return Math.round(MIN_FLIGHT_MS + fraction * (MAX_FLIGHT_MS - MIN_FLIGHT_MS));
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function easeInOutCubic(t: number): number {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

/**
 * Control points at 25% and 75% of the chord, lifted along the normal.
 *
 * The lift is proportional to distance but capped, because an uncapped arc on
 * a cross-display flight would swing the buddy far off screen mid-flight.
 * "Up" (negative y in screen coordinates) is preferred when the chord is
 * horizontal: a bulge below the chord reads as falling, not flying.
 */
export function arcControls(from: Point, to: Point): readonly [Point, Point] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return [from, to];

  const lift = Math.min(dist * 0.35, 240);
  let nx = dy / dist;
  let ny = -dx / dist;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }

  return [
    { x: from.x + dx * 0.25 + nx * lift, y: from.y + dy * 0.25 + ny * lift },
    { x: from.x + dx * 0.75 + nx * lift, y: from.y + dy * 0.75 + ny * lift },
  ];
}

export function cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const c = clamp01(t);

  // Return the endpoints exactly. Summing the four weighted terms accumulates
  // float error, so t=1 landed on 100.00000000000003 instead of 100 — the buddy
  // would sit forever a hair off the thing it is supposed to be pointing at.
  if (c <= 0) return { x: p0.x, y: p0.y };
  if (c >= 1) return { x: p3.x, y: p3.y };

  const u = 1 - c;
  const w0 = u * u * u;
  const w1 = 3 * u * u * c;
  const w2 = 3 * u * c * c;
  const w3 = c * c * c;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

/**
 * 1.0 at both ends, APEX_SCALE at the top of the arc. A sine hump rather than
 * a triangle so the pulse has no visible corner where growth flips to shrink.
 */
export function apexScale(t: number, peak: number = APEX_SCALE): number {
  return 1 + (peak - 1) * Math.sin(Math.PI * clamp01(t));
}

export interface FlightFrame {
  readonly position: Point;
  readonly scale: number;
  readonly done: boolean;
}

export function flightFrame(from: Point, to: Point, elapsedMs: number, durationMs: number): FlightFrame {
  // The final frame IS the target, by identity rather than by float math —
  // the landing pixel is what the buddy is pointing at, so "off by 1e-13,
  // rounded elsewhere" is not a property worth having to reason about.
  if (durationMs <= 0 || elapsedMs >= durationMs) {
    return { position: to, scale: 1, done: true };
  }
  const eased = easeInOutCubic(elapsedMs / durationMs);
  // Degenerate flight to where the buddy already is: the pulse still plays,
  // but bezier weight rounding must not make the window creep off its pixel.
  if (from.x === to.x && from.y === to.y) {
    return { position: to, scale: apexScale(eased), done: false };
  }
  const [c1, c2] = arcControls(from, to);
  return {
    position: cubicBezierPoint(from, c1, c2, to, eased),
    scale: apexScale(eased),
    done: false,
  };
}
