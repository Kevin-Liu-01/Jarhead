/**
 * The hero's blob as a body in the hand (components/site/heroPlay.ts): where it is, how fast it goes and what it is pressed
 * against. A line-for-line port of the app's BlobBody (apps/mac/Sources/Jarhead/UI/Orb/BlobPhysics.swift, cited by line),
 * scaled to the page by `s` = R / 59 (the app's 0.36 × 164 pt radius): every length and speed marked ·s scales, the
 * springs, frictions, restitutions and times do not. Pure: no imports, no DOM, no window. Everything is in CSS px relative
 * to the blob's home (its place on the h1's baseline), y down; the walls are the hero as the visitor sees it and the
 * island is a solid box whose top runs off to -Infinity.
 *
 * Held, the body is a mass on an under-damped spring toward the hand (the drag spring), so it lags, overshoots when the
 * hand stops and rings. Let go, it keeps its momentum, slows with friction, bounces off the walls (0.55) and the island
 * (0.42), and comes to rest. The walls are sticky: pressed in past `adhereDepth` by hand, let go touching one, or
 * arriving slower than `stickSpeed`, it sticks and sags into a dome; pulled away it clings until `clingLength` of pull,
 * then snaps. The island never sticks: by hand it is solid at a quarter of the radius, and a slow arrival on its
 * underside puts the blob to bed (`onTuck`). The way home is the character's spring, capped, eased in and braked, with
 * the walls off.
 */

export interface Vec {
  readonly x: number;
  readonly y: number;
}
/** A rect in home-relative CSS px, y down. */
export interface Box {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}
/** The walls (the hero as seen) and the island (the `.top-scale` rect, its top at -Infinity), or none. */
export interface World {
  readonly box: Box;
  readonly island: Box | null;
}
/** What the body is pressed against: n points from the surface toward the body; d is the centre's distance to it (px). */
export interface Contact {
  readonly nx: number;
  readonly ny: number;
  readonly press: number;
  readonly d: number;
  readonly stuck: boolean;
  readonly neck: number;
}
/** A spring as stiffness and damping (lib/motion.ts springKC). */
export interface KC {
  readonly k: number;
  readonly c: number;
}
export type BodyMode = "rest" | "held" | "free" | "homing";

export interface BodyOptions {
  /** The body's radius, CSS px (the host's side / 2.8, the disc's radius). */
  readonly R: number;
  /** The page's scale against the app: R / 59. */
  readonly s: number;
  /** The hand's spring (SPRING_DRAG). */
  readonly drag: KC;
  /** The way home (SPRING_CHAR). */
  readonly home: KC;
  /** Every wall or island impact with its normal speed (px/s): a bounce, or a slow arrival that sticks. */
  onImpact?(speed: number, bounced: boolean): void;
  /** A patch let go of a wall whose normal is (nx, ny). */
  onSnap?(nx: number, ny: number): void;
  /** A bounce hard enough to splat first. */
  onSplat?(speed: number): void;
  /** A slow arrival on the island's underside: put it to bed. */
  onTuck?(): void;
}

export interface Body {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly mode: BodyMode;
  /** The drag's lag: the hand's target minus the centre (px); zero when not held. */
  readonly lag: Vec;
  /** Where the hand holds it, relative to the centre; null when not held. */
  readonly grab: Vec | null;
  /** How far the most-pulled patch has stretched: 0 … 1 at the snap. */
  readonly neck: number;
  readonly stuckCount: number;
  readonly atRest: boolean;
  readonly atHome: boolean;
  beginDrag(px: number, py: number, tMs: number): void;
  moveDrag(px: number, py: number, tMs: number): void;
  endDrag(tMs: number): void;
  /** A release with the hand's velocity zeroed (a cancelled touch, a lost capture). */
  cancelDrag(): void;
  fling(vx: number, vy: number): void;
  /** Fly home: capped (the way home) or not (the tap's hop). */
  home(capped: boolean): void;
  /** A hop at home: the uncapped home spring with a kick. */
  hopHome(vx: number, vy: number): void;
  /** Put the still body at a point, holding nothing. */
  place(x: number, y: number): void;
  /** Home at once: still, holding nothing, stuck to nothing. */
  cut(): void;
  /** The home moved under the hand (a scroll mid-drag): shift the body and the hand so both stay put on the screen. */
  shift(dx: number, dy: number): void;
  step(dt: number, w: World): Contact[];
  contacts(w: World): Contact[];
}

// BlobBody's tuning (BlobPhysics.swift), ·s marks a length or speed scaled to the page.
const RESTITUTION = 0.55; // :303
const ISLAND_RESTITUTION = 0.42; // :304 windowRestitution
const FRICTION = 1.4; // :305, 1/s, exponential
const DECEL = 90; // ·s :306, px/s², so it actually stops
const MAX_SPEED = 4500; // ·s :307
const STOP_FRACTION = 0.9; // :314, × R, in flight
const DRAG_FRACTION = 0.25; // :317, × R, pushed by hand
const REST_SPEED = 8; // ·s :318
const STICK_SPEED = 420; // ·s :324
const SPLAT_SPEED = 1300; // ·s :326
const STUCK_DEPTH = 0.62; // :328, × R, the parked dome
const STICK_RELAX_TAU = 0.35; // :330
const CLING_LENGTH = 40; // ·s :335
const CLING_STIFFNESS = 230; // :338
const DOME_SETTLE = 0.6; // px, :913, a released stick this near its dome (and its neck's pull this short) is at rest
const ADHERE_DEPTH = 0.72; // :341, × R
const STICK_FRICTION = 0.55; // :343
const UNSTICK_SPEED = 300; // ·s :346
const MAX_ADHESIONS = 2; // :264
const LEAVE = 1.05; // :1139, × R: an island touched at release is solid again past this
const IMPACT_TAU = 0.22; // :883
const POINTER_EMA = 18; // :461
const STALE_MS = 120; // :478
// The way home: GoalSpring.drift's cap shape (:170-175) on the character's spring, under the 1215·s startle.
const HOME_CAP = 880; // ·s
const HOME_RAMP = 0.24; // Motion.base, drift's launchRamp
const HOME_DECEL = 2600; // ·s, drift's decel
const HOME_SETTLE = 1.5; // px, :154 settleDistance
const HOME_SETTLE_SPEED = 12; // ·s
const SUBSTEP = 1 / 120;

interface Adhesion {
  readonly nx: number;
  readonly ny: number;
  restDepth: number;
  neck: number;
}
interface Impact {
  readonly nx: number;
  readonly ny: number;
  press: number;
}
interface Wall {
  readonly nx: number;
  readonly ny: number;
  readonly d: number;
}

const smooth = (u: number): number => {
  const v = u < 0 ? 0 : u > 1 ? 1 : u;
  return v * v * (3 - 2 * v);
};

/**
 * The distance from (x, y) to a box's surface (negative inside) and the outward normal there, from the box toward the
 * point; inside, the nearest side's (BlobBody.distance(to:), :1119).
 */
export function distToBox(x: number, y: number, box: Box): { d: number; nx: number; ny: number } {
  const inside = x >= box.l && x <= box.r && y >= box.t && y <= box.b;
  if (inside) {
    const dl = x - box.l;
    const dr = box.r - x;
    const dt = y - box.t;
    const db = box.b - y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { d: -m, nx: -1, ny: 0 };
    if (m === dr) return { d: -m, nx: 1, ny: 0 };
    if (m === dt) return { d: -m, nx: 0, ny: -1 };
    return { d: -m, nx: 0, ny: 1 };
  }
  const px = x < box.l ? box.l : x > box.r ? box.r : x;
  const py = y < box.t ? box.t : y > box.b ? box.b : y;
  const dx = x - px;
  const dy = y - py;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { d: 0, nx: 0, ny: -1 };
  return { d: dist, nx: dx / dist, ny: dy / dist };
}

export function createBody(o: BodyOptions): Body {
  const { R, s } = o;
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let mode: BodyMode = "rest";
  let px = 0;
  let py = 0;
  let pvx = 0;
  let pvy = 0;
  let pointerAt = 0;
  let gox = 0;
  let goy = 0;
  let lag: Vec = { x: 0, y: 0 };
  let adhesions: Adhesion[] = [];
  const impacts: Impact[] = [];
  let ignoreIsland = false;
  let homeAge = 0;
  let homeCapped = true;
  let tucked = false;
  let world: World | null = null;

  const speed = (): number => Math.hypot(vx, vy);

  /** The four walls of the box: d is the centre's distance, positive inside (:1015). */
  function walls(w: World | null): Wall[] {
    if (!w) return [];
    const b = w.box;
    return [
      { nx: 1, ny: 0, d: x - b.l },
      { nx: -1, ny: 0, d: b.r - x },
      { nx: 0, ny: 1, d: y - b.t },
      { nx: 0, ny: -1, d: b.b - y },
    ];
  }
  const adhesionOf = (nx: number, ny: number): Adhesion | undefined => adhesions.find((a) => a.nx === nx && a.ny === ny);

  /** Glue it to a wall, its centre `depth` from it, never shallower than the hand's stop (:947). */
  function stick(nx: number, ny: number, depth: number): void {
    const a: Adhesion = { nx, ny, restDepth: Math.max(depth, R * DRAG_FRACTION), neck: 0 };
    const i = adhesions.findIndex((b) => b.nx === nx && b.ny === ny);
    if (i >= 0) {
      adhesions[i] = a;
      return;
    }
    if (adhesions.length >= MAX_ADHESIONS) return;
    adhesions.push(a);
  }

  /** The speed ceiling: the body's own, or on the way home ramped up from the launch and braked into home (:748). */
  function capSpeed(): void {
    let cap = MAX_SPEED * s;
    if (mode === "homing" && homeCapped) {
      cap = HOME_CAP * s * (0.12 + 0.88 * smooth(homeAge / HOME_RAMP));
      cap = Math.min(cap, Math.max(90 * s, Math.sqrt(2 * HOME_DECEL * s * Math.hypot(x, y))));
    }
    const sp = speed();
    if (sp > cap) {
      vx = (vx / sp) * cap;
      vy = (vy / sp) * cap;
    }
  }

  /** An island it is already touching is not solid until it leaves it (:765). */
  function ignoreTouchingIsland(): void {
    ignoreIsland = !!world?.island && distToBox(x, y, world.island).d < R * STOP_FRACTION;
  }

  /** Kill or reflect the velocity into a surface and record the impact; the hardest hits splat first (:1097). */
  function bounce(nx: number, ny: number, restitution: number): void {
    const vn = vx * nx + vy * ny;
    if (vn >= 0) return;
    if (mode === "held") {
      vx -= nx * vn;
      vy -= ny * vn;
      return;
    }
    const tx = vx - nx * vn;
    const ty = vy - ny * vn;
    vx = -nx * vn * restitution + tx * 0.92;
    vy = -ny * vn * restitution + ty * 0.92;
    impacts.push({ nx, ny, press: Math.min(1.3, 0.35 + -vn / (900 * s)) });
    if (-vn > SPLAT_SPEED * s) o.onSplat?.(-vn);
    o.onImpact?.(-vn, true);
  }

  /** The adhesion springs, before the move (:961). */
  function cling(dt: number): void {
    if (!adhesions.length) return;
    const ws = walls(world);
    const kept: Adhesion[] = [];
    for (const a of adhesions) {
      const w = ws.find((v) => v.nx === a.nx && v.ny === a.ny);
      if (!w) continue;
      if (mode === "held") {
        const pull = w.d - a.restDepth;
        if (pull > 0) {
          a.neck = pull / (CLING_LENGTH * s);
          if (a.neck >= 1) {
            o.onSnap?.(a.nx, a.ny);
            continue;
          }
          vx -= a.nx * CLING_STIFFNESS * pull * dt;
          vy -= a.ny * CLING_STIFFNESS * pull * dt;
        } else {
          a.neck = 0;
          a.restDepth = Math.max(w.d, R * DRAG_FRACTION);
        }
      } else {
        const want = R * STUCK_DEPTH;
        a.restDepth += (want - a.restDepth) * (1 - Math.exp(-dt / STICK_RELAX_TAU));
        // The sag only approaches the dome, so the pull left only approaches 0 (it stalls near 1e-15): within the dome's
        // settle of it, the neck is none.
        const pull = w.d - want;
        a.neck = pull < DOME_SETTLE ? 0 : Math.min(a.neck, pull / (CLING_LENGTH * s));
      }
      kept.push(a);
    }
    adhesions = kept;
  }

  /** The walls: held, a hard stop at a quarter radius (sticking past adhereDepth); free, stick or bounce (:1038). */
  function resolveWalls(): void {
    const held = mode === "held";
    const stop = R * (held ? DRAG_FRACTION : STOP_FRACTION);
    for (const w of walls(world)) {
      const a = adhesionOf(w.nx, w.ny);
      if (a) {
        if (held) {
          if (w.d >= stop) continue;
          const push = stop - w.d;
          x += w.nx * push;
          y += w.ny * push;
          bounce(w.nx, w.ny, RESTITUTION);
        } else {
          // Parked on its patch: held exactly restDepth from the wall, no motion along the normal.
          const push = a.restDepth - w.d;
          x += w.nx * push;
          y += w.ny * push;
          const vn = vx * w.nx + vy * w.ny;
          vx -= w.nx * vn;
          vy -= w.ny * vn;
        }
        continue;
      }
      if (held && w.d < R * ADHERE_DEPTH) stick(w.nx, w.ny, Math.max(w.d, stop));
      if (w.d >= stop) continue;
      const push = stop - w.d;
      x += w.nx * push;
      y += w.ny * push;
      if (held) {
        bounce(w.nx, w.ny, RESTITUTION);
        continue;
      }
      const vn = vx * w.nx + vy * w.ny;
      if (vn < 0 && -vn < STICK_SPEED * s) {
        // Slow enough that the wall takes it: no bounce, the tangential motion mostly scrubbed.
        const tx = vx - w.nx * vn;
        const ty = vy - w.ny * vn;
        vx = tx * STICK_FRICTION;
        vy = ty * STICK_FRICTION;
        stick(w.nx, w.ny, stop);
        impacts.push({ nx: w.nx, ny: w.ny, press: Math.min(0.6, 0.2 + -vn / (1200 * s)) });
        o.onImpact?.(-vn, false);
        continue;
      }
      bounce(w.nx, w.ny, RESTITUTION);
    }
  }

  /**
   * The island: solid by hand at a quarter radius (the velocity into it removed, never stuck to), and in flight a window
   * (:1137) at 0.42, except a slow arrival on its underside, which puts the blob to bed.
   */
  function resolveIsland(): void {
    const isl = world?.island;
    if (!isl) return;
    const { d, nx, ny } = distToBox(x, y, isl);
    if (mode === "held") {
      const stop = R * DRAG_FRACTION;
      if (d >= stop) return;
      const push = stop - d;
      x += nx * push;
      y += ny * push;
      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        vx -= nx * vn;
        vy -= ny * vn;
      }
      return;
    }
    if (ignoreIsland) {
      if (d > R * LEAVE) ignoreIsland = false;
      return;
    }
    const stop = R * STOP_FRACTION;
    if (d >= stop) return;
    const push = stop - d;
    x += nx * push;
    y += ny * push;
    const vn = vx * nx + vy * ny;
    if (ny > 0.7 && vn < 0 && -vn < STICK_SPEED * s) {
      if (!tucked) {
        tucked = true;
        vx = 0;
        vy = 0;
        mode = "rest";
        o.onTuck?.();
      }
      return;
    }
    bounce(nx, ny, ISLAND_RESTITUTION);
  }

  function substep(dt: number): void {
    if (mode === "held") {
      const tx = px + gox;
      const ty = py + goy;
      lag = { x: tx - x, y: ty - y };
      vx += (o.drag.k * lag.x - o.drag.c * vx) * dt;
      vy += (o.drag.k * lag.y - o.drag.c * vy) * dt;
    } else if (mode === "homing") {
      homeAge += dt;
      vx += (o.home.k * -x - o.home.c * vx) * dt;
      vy += (o.home.k * -y - o.home.c * vy) * dt;
    } else {
      const k = Math.exp(-FRICTION * dt);
      vx *= k;
      vy *= k;
      const sp = speed();
      if (sp > 0) {
        const ns = Math.max(0, sp - DECEL * s * dt);
        vx *= ns / sp;
        vy *= ns / sp;
      }
    }
    cling(dt);
    capSpeed();
    x += vx * dt;
    y += vy * dt;
    if (mode === "homing") return;
    resolveWalls();
    resolveIsland();
  }

  /** A released stick still sagging toward its dome, or still necked, is not at rest yet (:913). */
  const domeSettled = (): boolean =>
    adhesions.every((a) => Math.abs(a.restDepth - R * STUCK_DEPTH) < DOME_SETTLE && a.neck * CLING_LENGTH * s < DOME_SETTLE);

  /** Let go (:474), the hand's velocity blended in unless it is stale or zeroed. */
  function release(tMs: number, zeroHand: boolean): void {
    if (mode !== "held") return;
    mode = "free";
    lag = { x: 0, y: 0 };
    const stale = zeroHand || tMs - pointerAt > STALE_MS;
    const hx = stale ? 0 : pvx;
    const hy = stale ? 0 : pvy;
    vx = vx * 0.6 + hx * 0.4;
    vy = vy * 0.6 + hy * 0.4;
    capSpeed();
    const ws = walls(world);
    const kept: Adhesion[] = [];
    for (const a of adhesions) {
      const w = ws.find((v) => v.nx === a.nx && v.ny === a.ny);
      if (!w) continue;
      const vn = vx * w.nx + vy * w.ny;
      if (a.neck > 0 && vn > UNSTICK_SPEED * s) {
        o.onSnap?.(w.nx, w.ny);
        continue;
      }
      a.restDepth = Math.max(w.d, R * DRAG_FRACTION);
      kept.push(a);
    }
    adhesions = kept;
    for (const w of ws) {
      if (adhesions.length >= MAX_ADHESIONS || w.d >= R * STOP_FRACTION || adhesionOf(w.nx, w.ny)) continue;
      const vn = vx * w.nx + vy * w.ny;
      if (vn >= UNSTICK_SPEED * s) continue;
      stick(w.nx, w.ny, w.d);
    }
    ignoreTouchingIsland();
  }

  function contacts(w: World): Contact[] {
    const found: { nx: number; ny: number; press: number; d: number; stuck: boolean; neck: number }[] = [];
    for (const wall of walls(w)) {
      const a = adhesionOf(wall.nx, wall.ny);
      if (!(wall.d < R || a)) continue;
      let press = Math.min(1.4, Math.max(0, (R - wall.d) / (R * 0.6)));
      if (a && a.neck > 0) press = Math.max(press, Math.min(1.4, (R - a.restDepth) / (R * 0.6)));
      found.push({ nx: wall.nx, ny: wall.ny, press, d: wall.d, stuck: !!a, neck: a ? a.neck : 0 });
    }
    if (mode === "held" && w.island) {
      const { d, nx, ny } = distToBox(x, y, w.island);
      if (d < R) found.push({ nx, ny, press: Math.min(1.4, Math.max(0, (R - d) / (R * 0.6))), d, stuck: false, neck: 0 });
    }
    for (const i of impacts) found.push({ nx: i.nx, ny: i.ny, press: i.press, d: Infinity, stuck: false, neck: 0 });
    found.sort((a, b) => b.press - a.press);
    // Near-parallel contacts are one surface: the stronger stays, on the surface's real distance (:1256).
    const kept: typeof found = [];
    for (const c of found) {
      const same = kept.find((k) => k.nx * c.nx + k.ny * c.ny > 0.85);
      if (same) {
        same.d = Math.min(same.d, c.d);
        same.stuck ||= c.stuck;
        same.neck = Math.max(same.neck, c.neck);
        continue;
      }
      if (kept.length === 2) continue;
      kept.push(c);
    }
    return kept;
  }

  return {
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get vx() {
      return vx;
    },
    get vy() {
      return vy;
    },
    get mode() {
      return mode;
    },
    get lag() {
      return lag;
    },
    get grab() {
      return mode === "held" ? { x: -gox, y: -goy } : null;
    },
    get neck() {
      return adhesions.reduce((m, a) => Math.max(m, a.neck), 0);
    },
    get stuckCount() {
      return adhesions.length;
    },
    get atRest() {
      return mode === "rest";
    },
    get atHome() {
      return mode === "rest" && x === 0 && y === 0;
    },
    beginDrag(hx, hy, tMs) {
      mode = "held";
      px = hx;
      py = hy;
      pvx = 0;
      pvy = 0;
      pointerAt = tMs;
      gox = x - hx;
      goy = y - hy;
      ignoreIsland = false;
      tucked = false;
    },
    moveDrag(hx, hy, tMs) {
      const dt = (tMs - pointerAt) / 1000;
      if (dt > 0.001) {
        const a = Math.min(1, dt * POINTER_EMA);
        pvx += ((hx - px) / dt - pvx) * a;
        pvy += ((hy - py) / dt - pvy) * a;
      }
      px = hx;
      py = hy;
      pointerAt = tMs;
    },
    endDrag(tMs) {
      release(tMs, false);
    },
    cancelDrag() {
      release(0, true);
    },
    fling(fx, fy) {
      mode = "free";
      lag = { x: 0, y: 0 };
      tucked = false;
      vx = fx;
      vy = fy;
      if (Math.hypot(fx, fy) > UNSTICK_SPEED * s) adhesions = [];
      capSpeed();
      ignoreTouchingIsland();
    },
    home(capped) {
      mode = "homing";
      homeCapped = capped;
      homeAge = 0;
      lag = { x: 0, y: 0 };
      tucked = false;
      adhesions = [];
      impacts.length = 0;
    },
    hopHome(hx, hy) {
      this.home(false);
      vx += hx;
      vy += hy;
    },
    place(nx, ny) {
      x = nx;
      y = ny;
      vx = 0;
      vy = 0;
      lag = { x: 0, y: 0 };
      adhesions = [];
      impacts.length = 0;
      mode = "rest";
      tucked = false;
    },
    cut() {
      this.place(0, 0);
      ignoreIsland = false;
    },
    shift(dx, dy) {
      x += dx;
      y += dy;
      px += dx;
      py += dy;
    },
    step(dtRaw, w) {
      world = w;
      const dt = Math.min(Math.max(Number.isFinite(dtRaw) ? dtRaw : 0, 0), 1 / 30);
      if (mode === "rest") return contacts(w);
      for (let left = dt; left > 1e-9 && (mode as BodyMode) !== "rest"; left -= SUBSTEP) substep(Math.min(left, SUBSTEP));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vx) || !Number.isFinite(vy)) {
        // One bad number and the body is home, still, holding nothing (the app's resetToLastGood).
        this.cut();
        return contacts(w);
      }
      for (const i of impacts) i.press *= Math.exp(-dt / IMPACT_TAU);
      for (let i = impacts.length - 1; i >= 0; i--) if (impacts[i]!.press < 0.02) impacts.splice(i, 1);
      if (mode === "homing") {
        if (Math.abs(x) < HOME_SETTLE && Math.abs(y) < HOME_SETTLE && speed() < HOME_SETTLE_SPEED * s) {
          x = 0;
          y = 0;
          vx = 0;
          vy = 0;
          mode = "rest";
        }
      } else if (mode === "free" && speed() < REST_SPEED * s && domeSettled()) {
        vx = 0;
        vy = 0;
        mode = "rest";
      }
      return contacts(w);
    },
    contacts,
  };
}
