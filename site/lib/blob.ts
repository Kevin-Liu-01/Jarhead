/**
 * The live blob: the icon's dithered material (ORB_STOPS, five bands, rim, gleam) on the desktop
 * blob's live harmonic outline, with its face dithered on the same cells (lib/eyes.ts faceCells: ink
 * ovals with a star and a dot for catchlights, the star's glow scattered through the Bayer tile on the
 * pupil, and the lines that close them, the tile at their edges) and its dithered halo in the phase
 * colour. Its eyes
 * sparkle (lib/eyes.ts TWINKLE): the catchlights breathe, and a star flares now and then (the hero
 * every 2 to 4.6 s, every other blob every 3 to 6 s, the page's faces taking turns), as the eyes open,
 * as what it loves lights up and out of a squint of joy; the happy sparkle pops in and pulses. When
 * joy starts, two stars of field cells pop round its head and dissolve through the Bayer thresholds,
 * and while it is lit one more now and then (SPARK). Calm: whole catchlights, one star when lit.
 * Sim from UI/Orb/BlobField.swift through facts-orb.md §1.6, §2, §3, §5, §6; design.md §5.
 *
 * Two canvases in the host, one buffer pixel per 1.5 CSS px cell each (image-rendering: pixelated),
 * cell for cell: the field and the face over it, the eyes in the ink, the glow and the paper on the
 * field's own grid (each eye snapped to a cell corner and dithered in its own space, the cell held
 * through the body's wobble, so the eyes move whole and never crawl or flicker). The sim steps every rAF tick; the raster runs at the phase's fps (60 through a blink
 * and its reopening, 24 while anything is live); a flare or a pop alone redraws only the face, at 60.
 * Per-cell caches carry the geometry whenever the body is not stretched. The loop is paused
 * offscreen, on a hidden tab and after 20 s of static sleep; `destroy()` releases all.
 *
 * The body is blue in every awake phase (ORB_STOPS) and titanium asleep / paused / muted
 * (QUIET_STOPS); the phase colour lives on the halo, read from `--jh-<phase>` once per change
 * (thinking wears the accent blue: no violet anywhere on the orb).
 */
import { BAYER8, ORB_STOPS, QUIET_STOPS, cellCss, clamp01, lut, mix3, parseColor, smoothstep, watchDpr, type RGB } from "@/lib/dither";
import { EYES, FaceHold, HOLD, TONE, TWINKLE, asleepPair, faceCells, flareSize, popSize, type FaceCells, type FacePose } from "@/lib/eyes";
import { glintTurn } from "@/lib/live";
import { cssVar, type Theme } from "@/lib/theme";
import type { Phase } from "@/lib/phase";

export interface BlobHandle {
  setPhase(p: Phase): void;
  setTheme(t: Theme): void;
  /** A face the demo asks for (`> <` denied, `^ ^` granted) over the phase's own; null gives the phase back its face. */
  setFace(pair: string | null): void;
  /** A shiver and a hop: the blob reacts (a press, a word heard). */
  nudge(): void;
  /**
   * Something the blob loves, at a point on the screen (client px), or null: its eyes turn to it whatever the pointer does,
   * its halo brightens and its eyes light up. The hero's blob attends to the Install button while it is hovered or focused.
   */
  attend(at: readonly [number, number] | null): void;
  /** A happy squint (`^^`) for `seconds` (0.75 by default) and a hop. */
  cheer(seconds?: number): void;
  destroy(): void;
}

interface BlobOptions {
  size: number;
  phase: Phase;
  theme: Theme;
  onPhaseAdvance?: () => void;
  /** Render one frame, no loop (`#still`, reduced motion). */
  still?: boolean;
  /** Where the pointer is watched (the whole desk); default the host. */
  pointerRoot?: HTMLElement | null;
  /** Keep 1.5 px cells as laid out, ignoring a transform on the host at mount (the hero's blob mounts while it is a dot). */
  ignoreScale?: boolean;
  /** The page's lead (the hero's blob): its eyes glint on the quicker clock (TWINKLE.rest, not TWINKLE.demo). */
  lead?: boolean;
}

interface Personality { amp: number; speed: number; churn: number; squash: number; spin: number; glow: number; fps: number; face: string; quiet: boolean; rest: readonly [number, number]; blinks: boolean }
const PERSONALITY: Record<Phase, Personality> = {
  asleep: { amp: 0.3, speed: 0.45, churn: 0.5, squash: 0.9, spin: 0.05, glow: 0.3, fps: 10, face: "--", quiet: true, rest: [0, 0], blinks: false },
  connecting: { amp: 0.36, speed: 1, churn: 1, squash: 1.05, spin: 0.1, glow: 0.4, fps: 20, face: "oo", quiet: false, rest: [0, -0.2], blinks: true },
  listening: { amp: 0.42, speed: 1.5, churn: 1.5, squash: 1.15, spin: 0.15, glow: 0.6, fps: 24, face: "OO", quiet: false, rest: [0, -0.25], blinks: true },
  speaking: { amp: 0.52, speed: 3, churn: 3, squash: 0.85, spin: 0.1, glow: 0.65, fps: 24, face: "^^", quiet: false, rest: [0, -0.1], blinks: false },
  thinking: { amp: 0.36, speed: 2.4, churn: 2.8, squash: 1, spin: 0.55, glow: 0.55, fps: 24, face: "--", quiet: false, rest: [-0.7, -0.75], blinks: false },
  acting: { amp: 0.42, speed: 2.2, churn: 2, squash: 1.2, spin: 0.3, glow: 0.6, fps: 24, face: "oo", quiet: false, rest: [0.9, 0.2], blinks: true },
  muted: { amp: 0.22, speed: 0.3, churn: 0.3, squash: 0.88, spin: 0.02, glow: 0.18, fps: 6, face: "__", quiet: true, rest: [0, 0.1], blinks: false },
  paused: { amp: 0.26, speed: 0.35, churn: 0.4, squash: 0.9, spin: 0.02, glow: 0.22, fps: 8, face: "uu", quiet: true, rest: [0, 0], blinks: false },
  error: { amp: 0.4, speed: 2.6, churn: 3.2, squash: 1, spin: 0, glow: 0.6, fps: 24, face: "xx", quiet: false, rest: [0, 0], blinks: false },
};

const LOW = new Set(["-", "~", "_", "."]);
/**
 * The app caps a harmonic at 1.15 × its weight and scales the sum by amp × 2.6 (BlobField.swift:1148,
 * :1388); its ASCII field thins toward the edge, so a lobe reads soft. A solid dithered disc shows
 * every lobe, and at those numbers the body read as a splat, so the site caps at 0.75 × w and scales
 * by 1.8: the same wandering harmonics, about a third of the excursion (NOTES.md, deviations).
 */
const AMP_CAP = 0.75;
const AMP_SCALE = 1.8;
/**
 * The lids are a spring: a blink shuts in about 45 ms and reopens past round (the eye stretches a touch taller, then
 * settles), and the whole body dips with it by `dip` (squash and stretch, so the whole character blinks).
 */
const LID = { k: 1500, zeta: 0.55, dip: 0.04 };
/**
 * The stars round its head, rationed: each a four-point star of field cells, its arms `arm` R up and down (seven tenths
 * across) scaled by a random `size`, its middle solid and its tips a Bayer scatter. It pops up in `rise` s, holds to
 * `hold` and dissolves through the thresholds, tips first, by `life`. They stand on `slots` above the shoulders (degrees
 * from the right, upward negative) at least `at` R from the centre and `gap` R off the body's edge as it is when they
 * pop, on a slot whose whole star fits a cell inside the host, so none hides behind the body, covers the face or breaks
 * at the edge. A `burst` of two, `stagger` s apart, when joy starts (a squint of joy, what it loves lighting up), then
 * while it is lit one more every `every` s, `most` at once; never for a happy face it only keeps. Calm keeps one whole
 * star while lit (`still`: slot, distance, size).
 */
const SPARK = {
  arm: 0.19,
  size: [0.85, 0.3],
  rise: 0.14,
  hold: 0.42,
  life: 0.95,
  slots: [-22, -50, -82, -114, -146],
  at: [1.1, 0.08],
  gap: 0.07,
  burst: 2,
  stagger: 0.12,
  every: [1.2, 0.8],
  most: 2,
  still: [1, 1.14, 1],
} as const;
interface Spark { readonly slot: number; readonly x: number; readonly y: number; readonly born: number; readonly size: number; readonly still: boolean }
/** A flare: when it starts (s, the blob's clock), the eye it starts in, and whether the other eye follows (TWINKLE.lag). */
interface Flare { readonly at: number; readonly lead: -1 | 1; readonly both: boolean }
/** A face that can glint: catchlights (`O`, `o`) or the happy sparkle (`^`, which pulses). */
const GLINTS = /[Oo^]/;
const isOpen = (pair: string): boolean => /[Oo]/.test(pair);
const INK: RGB = [7, 7, 7];
const TAU = Math.PI * 2;

function gauss(): number {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

interface Mode { x: number; v: number; hz: number; z: number; cap: number }
const mode = (hz: number, z: number, cap: number): Mode => ({ x: 0, v: 0, hz, z, cap });
function advance(m: Mode, dt: number): void {
  const w = TAU * m.hz;
  const zw = m.z * w;
  const wd = w * Math.sqrt(1 - m.z * m.z);
  const e = Math.exp(-zw * dt);
  const c = Math.cos(wd * dt);
  const s = Math.sin(wd * dt);
  const b = (m.v + zw * m.x) / wd;
  m.v = e * ((b * wd - zw * m.x) * c - (m.x * wd + zw * b) * s);
  const x = e * (m.x * c + b * s);
  m.x = x < -m.cap ? -m.cap : x > m.cap ? m.cap : x;
}

/** An opaque colour as an ImageData pixel (little-endian ABGR). */
function pixel(c: RGB): number {
  return (255 << 24) | ((Math.round(c[2]) & 255) << 16) | ((Math.round(c[1]) & 255) << 8) | (Math.round(c[0]) & 255);
}

/** How far the halo's tone is lifted toward the paper before it lights the eyes' glow (so it reads as light on the ink). */
const GLOW_LIFT = 0.3;

/** The halo's colour: the phase's own token, but the orb's blue while thinking (no violet in anything orb-like). */
function phaseColor(p: Phase): RGB {
  const v = cssVar(p === "thinking" ? "--jh-accent" : `--jh-${p}`);
  return v ? parseColor(v) : [90, 215, 255];
}

export function mountBlob(host: HTMLElement, o: BlobOptions): BlobHandle {
  const stillMode = !!o.still || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  let size = o.size;
  let cell = cellCss(1.5);
  let n = 0;
  let c = 0;
  let R = size / 2.8;
  const field = document.createElement("canvas");
  const faceCv = document.createElement("canvas");
  field.className = "desk-blob-field";
  faceCv.className = "desk-blob-face";
  // the face is on the field's cells: upscaled the same way, never smoothed
  faceCv.style.imageRendering = "pixelated";
  // no size until alloc() gives them one: at a canvas's default 300×150 the install heading's blob reached past a phone's
  // right edge for a frame, and WebKit kept the page that wide (537 px at 393), so it panned sideways
  for (const cv of [field, faceCv]) {
    cv.width = 0;
    cv.height = 0;
  }
  host.append(field, faceCv);
  const g = field.getContext("2d");
  const fg = faceCv.getContext("2d");
  if (!g || !fg) throw new Error("blob: no 2d context");
  let img: ImageData = g.createImageData(1, 1);
  let px: Uint32Array = new Uint32Array(1);
  let faceImg: ImageData = fg.createImageData(1, 1);
  let facePx: Uint32Array = new Uint32Array(1);
  /** The cells the last face covered (cleared before the next is drawn), as [col, row, w, h]. */
  let faceBox: readonly [number, number, number, number] = [0, 0, 0, 0];
  // Per-cell caches (rebuilt on resize; the polar pair when the squash moves).
  let PX = new Float32Array(0);
  let PY = new Float32Array(0);
  let TH = new Float32Array(0);
  let R0 = new Float32Array(0);
  let TI = new Uint16Array(0);
  let cacheSq = -1;
  const OUT = new Float32Array(512);
  const C2 = new Float32Array(512);
  const C3 = new Float32Array(512);
  const EXP = new Float32Array(257); // exp(-u) for u in [0, 16]
  for (let i = 0; i <= 256; i++) EXP[i] = Math.exp(-(i / 16));

  function alloc(sz: number): void {
    size = sz;
    // The cell is read here, not once: a new display or a browser zoom re-allocs at the new ratio (watchDpr below).
    const rect = host.getBoundingClientRect();
    const scale = !o.ignoreScale && rect.width > 0 && host.clientWidth > 0 ? rect.width / host.clientWidth : 1;
    cell = cellCss(1.5) / (scale > 0 ? scale : 1);
    n = Math.max(4, Math.ceil(size / cell));
    c = n / 2;
    R = size / 2.8;
    field.width = n;
    field.height = n;
    field.style.width = `${n * cell}px`;
    field.style.height = `${n * cell}px`;
    faceCv.width = n;
    faceCv.height = n;
    faceCv.style.width = `${n * cell}px`;
    faceCv.style.height = `${n * cell}px`;
    img = g!.createImageData(n, n);
    px = new Uint32Array(img.data.buffer);
    faceImg = fg!.createImageData(n, n);
    facePx = new Uint32Array(faceImg.data.buffer);
    faceBox = [0, 0, 0, 0];
    faceHold.reset();
    PX = new Float32Array(n * n);
    PY = new Float32Array(n * n);
    TH = new Float32Array(n * n);
    R0 = new Float32Array(n * n);
    TI = new Uint16Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        PX[i] = (x + 0.5 - c) * cell;
        PY[i] = (y + 0.5 - c) * cell;
        TH[i] = BAYER8[(y & 7) * 8 + (x & 7)]!;
      }
    }
    cacheSq = -1;
  }
  function polar(sq: number): void {
    if (Math.abs(sq - cacheSq) < 0.003) return;
    cacheSq = sq;
    for (let i = 0; i < n * n; i++) {
      const x = PX[i]!;
      const y = PY[i]! / sq;
      R0[i] = Math.hypot(x, y);
      TI[i] = (((Math.atan2(y, x) / TAU) * 512) | 0) + 512 & 511;
    }
  }

  // Sim state.
  const H = [1, 2, 3, 4, 5, 7].map((k) => ({ k, w: 1 / (k * 0.85), a: 0, ph: Math.random() * TAU, d: (0.17 + k * 0.113) * (k % 2 ? 1 : -1) }));
  const wsum = H.reduce((s, h) => s + h.w, 0);
  const m2 = mode(4.6, 0.13, 0.32);
  const m3 = mode(6.4, 0.16, 0.22);
  let phase: Phase = o.phase;
  let P = PERSONALITY[phase];
  const cur = { amp: P.amp, speed: P.speed, churn: P.churn, squash: P.squash, spin: P.spin, glow: P.glow };
  let theme: Theme = o.theme;
  let backing: RGB | null = null;
  let under: RGB = [11, 12, 16];
  /** The face's tones as pixels (ABGR): the blob's ink, the paper of its catchlights, and the glow between (drawEyes). */
  let eyeInk = 0;
  let eyeLight = 0;
  let eyeGlow = 0;
  let eyePaper: RGB = [255, 255, 255];
  let Lfrom: RGB[] = lut(P.quiet ? QUIET_STOPS : ORB_STOPS, 5);
  let Lto: RGB[] = Lfrom;
  let L: RGB[] = Lfrom;
  let haloFrom: RGB = [90, 215, 255];
  let haloTo: RGB = haloFrom;
  let halo: RGB = haloFrom;
  let fadeAt = -9;
  let t = 0;
  let spin = 0;
  let shiver = 0;
  let pointer: [number, number] | null = null;
  let str = 0;
  let sx = 1;
  let sy = 0;
  const look: [number, number] = [P.rest[0], P.rest[1]];
  let glance: [number, number] = [0, -0.2];
  let nextGlance = 0.8;
  let open = 1;
  let openV = 0;
  let blinkUntil = -1;
  let nextBlink = 3 + Math.random() * 3;
  let lastPair = P.face;
  let faceOverride: string | null = null;
  // The happy squint: now and then while listening, and on a cheer.
  let squintUntil = -1;
  let nextSquint = 8 + Math.random() * 6;
  // What the blob attends to (a vector from its centre, in its own px), and how lit it is by it (eased 0 to 1).
  let attention: [number, number] | null = null;
  let lit = 0;
  // The sparkle (TWINKLE, SPARK): the flare playing and the one asked for next, when the clock's own is due (the hero's
  // clock is the quicker), when the happy sparkle last popped; the stars round the head, the burst still to come, the
  // slot used last.
  const clock = o.lead ? TWINKLE.rest : TWINKLE.demo;
  let flare: Flare = { at: -9, lead: -1, both: true };
  let queued: { at: number; lead: -1 | 1 | 0; both: boolean } | null = null;
  let nextFlare = 1 + Math.random() * clock[1];
  let joyAt = -9;
  let wasHappy = false;
  const sparks: Spark[] = [];
  let nextSpark = 0;
  let burstAt = -9;
  let burstLeft = 0;
  let lastSlot = -1;
  // The face as the last full frame drew it, so a flare or a pop alone redraws only the face canvas.
  let facePair = P.face;
  /** Where the last full frame put the face, in the field's px (its grid's corner at 0, 0). */
  let faceCx = 0;
  let faceCy = 0;
  let faceR = 0;
  /**
   * The face's turn as drawn: the look's sideways part in tenths, held until the look is HOLD of a tenth past it (as the
   * island's), so an easing look re-draws the narrowing eye only as it steps, never every frame.
   */
  let faceTurn = 0;
  /** The cell the face keeps through the body's wobble and the look (lib/eyes.ts FaceHold). */
  const faceHold = new FaceHold();
  // This frame's stars on the field's cells: the centre cell, the arms' reach in cells (plus a half), what is left of it.
  const SX = new Int32Array(SPARK.most + 2);
  const SY = new Int32Array(SPARK.most + 2);
  const SA = new Float32Array(SPARK.most + 2);
  const SB = new Float32Array(SPARK.most + 2);
  const SE = new Float32Array(SPARK.most + 2);
  let ns = 0;
  let sparkCore = 0;
  let sparkArm = 0;
  let sparkBody = 0;
  // The last frame's outline terms (draw), so a new star can stand just off the body's edge.
  let edgeRb = 0;
  let edgeSq = 1;
  let edgeM2 = 0;
  let edgeM3 = 0;
  let activeAt = 0;
  let visible = true;
  let raf = 0;
  let last = 0;
  let lastDraw = 0;
  let lastFace = 0;
  let destroyed = false;

  function resolveTheme(): void {
    const ground = cssVar("--jh-blob-ground");
    under = ground ? parseColor(ground) : [11, 12, 16];
    backing = theme === "dark" ? under : null;
    // The eyes: the blob's own ink with a paper catchlight, the same in both themes (they sit on the body, not the page).
    const paperCss = cssVar("--jh-paper");
    const paper: RGB = paperCss ? parseColor(paperCss) : [255, 255, 255];
    eyeInk = pixel(under);
    eyeLight = pixel(paper);
    eyePaper = paper;
  }
  resolveTheme();
  haloTo = phaseColor(phase);
  haloFrom = haloTo;
  halo = haloTo;

  function kick(): void {
    shiver = stillMode ? 0.8 : 2.6;
    for (const h of H) h.a += gauss() * (stillMode ? 0.1 : 0.3) * h.w;
    m2.v += 0.1 * TAU * m2.hz;
  }

  function setPhase(p: Phase): void {
    if (p === phase || !PERSONALITY[p]) return;
    Lfrom = L.slice();
    haloFrom = halo;
    phase = p;
    P = PERSONALITY[p];
    Lto = lut(P.quiet ? QUIET_STOPS : ORB_STOPS, 5);
    haloTo = phaseColor(p);
    fadeAt = t;
    kick();
    if (!(LOW.has(lastPair[0] ?? "") && LOW.has(P.face[0] ?? ""))) blinkUntil = t + 0.09;
    // eyes opening on a wake catch the light once the lids have lifted
    if (!faceOverride && !isOpen(lastPair) && isOpen(P.face)) glint(TWINKLE.wake);
    lastPair = P.face;
    activeAt = t;
    if (stillMode) {
      // No loop to carry the fade: snap to the new phase and draw its one pose.
      Lfrom = Lto;
      L = Lto;
      haloFrom = haloTo;
      halo = haloTo;
      fadeAt = -9;
      blinkUntil = -1;
      stillFrame();
      return;
    }
    wake();
  }

  /** The face it shows now, before a blink: the squint's `^^`, the demo's face or the phase's. */
  function showing(): string {
    return !faceOverride && t < squintUntil ? "^^" : (faceOverride ?? P.face);
  }

  /** The eye nearer what it loves (or where it looks), else the other eye from last time. */
  function nearEye(): -1 | 1 {
    const lx = attention ? attention[0] / (Math.hypot(attention[0], attention[1]) || 1) : look[0];
    return Math.abs(lx) > 0.3 ? (lx > 0 ? 1 : -1) : flare.lead === 1 ? -1 : 1;
  }

  /** When the flare playing ends (its second eye included). */
  function flareEnd(): number {
    return flare.at + TWINKLE.flare + (flare.both ? TWINKLE.lag : 0);
  }

  /**
   * An event's flare `delay` s from now: in the eye `lead` (0: the nearer one when it starts), the other eye following
   * unless `alone`. One playing is never cut off: the request waits for it to end and TWINKLE.gap after (the newest
   * request wins the wait). It insists on its page turn.
   */
  function glint(delay: number, lead: -1 | 1 | 0 = 0, alone = false): void {
    if (stillMode) return;
    queued = { at: Math.max(t + delay, flareEnd() + TWINKLE.gap), lead, both: !alone };
    wake();
  }

  /** A flare starts now, if the page's turn is free (or it insists); the clock's next waits a full spell after it. */
  function startFlare(lead: -1 | 1 | 0, both: boolean, insist: boolean): boolean {
    if (!glintTurn(performance.now(), TWINKLE.page * 1000, insist)) return false;
    flare = { at: t, lead: lead || nearEye(), both };
    const w = lit > 0.5 ? TWINKLE.lit : clock;
    nextFlare = t + w[0] + Math.random() * w[1];
    return true;
  }

  /** Joy starts (a squint of joy, what it loves lighting up): a burst of stars round the head, never twice in a moment. */
  function burst(): void {
    if (stillMode || phase === "asleep" || t - burstAt < 0.6) return;
    burstAt = t;
    burstLeft = SPARK.burst;
    nextSpark = t;
  }

  /** The body's edge along angle `a` from its centre, in R units, from the last frame's outline (a stretch only adds). */
  function edgeAt(a: number): number {
    if (!edgeRb) return 1;
    const ca = Math.cos(a);
    const sa = Math.sin(a) / edgeSq;
    const idx = ((((Math.atan2(sa, ca) / TAU) * 512) | 0) + 512) & 511;
    const mul = Math.max(0.35, OUT[idx]! + edgeM2 * C2[idx]! + edgeM3 * C3[idx]!);
    return ((mul * edgeRb) / (Math.hypot(ca, sa) * R)) * (1 + 0.35 * str);
  }

  /**
   * Where a star of `size` may stand along angle `a` (R units from the centre): `most`, the furthest its whole star stays a
   * cell inside the field, and `want`, its distance off the body's edge.
   */
  function sparkRoom(a: number, size: number, at: number): { most: number; want: number } {
    const A = Math.max(1, Math.round((SPARK.arm * size * R) / cell));
    const B = Math.max(1, Math.round(A * 0.7));
    const up = Math.max(1e-3, Math.abs(Math.sin(a)));
    const side = Math.max(1e-3, Math.abs(Math.cos(a)));
    const most = Math.min(((c - 2 - A) * cell) / R / up, ((c - 2 - B) * cell) / R / side);
    return { most, want: Math.max(at, edgeAt(a) + SPARK.gap + (0.3 * A * cell) / R) };
  }

  /**
   * A star round the head: on a slot no living one stands on (and not the last one used) where it fits off the body's edge
   * inside the field, else on the roomiest of them, as far out as the field allows.
   */
  function spawnSpark(): void {
    const size = SPARK.size[0] + Math.random() * SPARK.size[1];
    let best: { slot: number; a: number; r: number; room: number } | null = null;
    const fits: { slot: number; a: number; r: number; room: number }[] = [];
    for (let i = 0; i < SPARK.slots.length; i++) {
      if (i === lastSlot || sparks.some((sp) => sp.slot === i)) continue;
      const a = ((SPARK.slots[i]! + (Math.random() - 0.5) * 14) * Math.PI) / 180;
      const { most, want } = sparkRoom(a, size, SPARK.at[0] + Math.random() * SPARK.at[1]);
      const cand = { slot: i, a, r: Math.min(want, most), room: most - want };
      if (cand.room >= 0) fits.push(cand);
      if (!best || cand.room > best.room) best = cand;
    }
    const pick = fits[(Math.random() * fits.length) | 0] ?? best;
    if (!pick) return;
    lastSlot = pick.slot;
    sparks.push({ slot: pick.slot, x: Math.cos(pick.a) * pick.r, y: Math.sin(pick.a) * pick.r, born: t, size, still: false });
  }

  /** Calm: one whole star while it is lit, none otherwise; nothing pops or fades. */
  function stillSparks(): void {
    sparks.length = 0;
    if (phase === "asleep" || !attention) return;
    const [slot, at, size] = SPARK.still;
    const a = (SPARK.slots[slot]! * Math.PI) / 180;
    const { most, want } = sparkRoom(a, size, at);
    const r = Math.min(most, want);
    sparks.push({ slot, x: Math.cos(a) * r, y: Math.sin(a) * r, born: 0, size, still: true });
  }

  function step(dt: number): void {
    t += dt;
    const k = 1 - Math.exp(-dt / 0.28);
    cur.amp += (P.amp - cur.amp) * k;
    cur.speed += (P.speed - cur.speed) * k;
    cur.churn += (P.churn - cur.churn) * k;
    cur.squash += (P.squash - cur.squash) * k;
    cur.spin += (P.spin - cur.spin) * k;
    cur.glow += (P.glow - cur.glow) * k;
    const fu = clamp01((t - fadeAt) / (stillMode ? 0.3 : 0.6));
    const fe = fu < 0.5 ? 4 * fu * fu * fu : 1 - Math.pow(-2 * fu + 2, 3) / 2;
    if (fu < 1) {
      L = Lfrom.map((col, i) => mix3(col, Lto[i]!, fe));
      halo = mix3(haloFrom, haloTo, fe);
    } else {
      L = Lto;
      halo = haloTo;
    }
    const st = Math.min(dt, 1 / 15);
    const root = Math.sqrt(st);
    const churn = cur.churn + shiver;
    shiver *= Math.exp(-dt / 0.45);
    spin += cur.spin * dt;
    for (const h of H) {
      h.a += -1.7 * h.a * st + 1.3 * churn * h.w * root * gauss();
      const cap = h.w * AMP_CAP;
      if (h.a > cap) h.a = cap;
      else if (h.a < -cap) h.a = -cap;
      h.ph += (h.d * cur.speed + gauss() * 0.12) * st;
    }
    // Stretch: the hover law within 1.6 R.
    let want = 0;
    let dx = sx;
    let dy = sy;
    if (pointer && !stillMode) {
      const l = Math.hypot(pointer[0], pointer[1]);
      if (l > 3 && l < R * 1.6) {
        want = Math.min(0.35, (l / 90) * 0.35) * (1 - smoothstep(R * 1.3, R * 1.6, l));
        dx = pointer[0] / l;
        dy = pointer[1] / l;
      }
    }
    if (attention && want < 0.13 && !stillMode) {
      // it leans toward what it loves
      const l = Math.hypot(attention[0], attention[1]) || 1;
      want = 0.13;
      dx = attention[0] / l;
      dy = attention[1] / l;
    }
    const ks = 1 - Math.exp(-dt / 0.07);
    sx += (dx - sx) * ks;
    sy += (dy - sy) * ks;
    const ln = Math.hypot(sx, sy) || 1;
    sx /= ln;
    sy /= ln;
    str += (want - str) * ks;
    if (stillMode) str = 0;
    advance(m2, dt);
    advance(m3, dt);
    // The look: the pointer within 300 px, else the phase's rest (connecting glances about).
    let wx = P.rest[0];
    let wy = P.rest[1];
    if (phase === "connecting") {
      if (t >= nextGlance) {
        glance = [(Math.random() - 0.5) * 1.4, -0.2 + (Math.random() - 0.5) * 0.8];
        nextGlance = t + 0.6 + Math.random() * 0.8;
      }
      wx = glance[0];
      wy = glance[1];
    }
    if (attention) {
      // What it loves wins over the pointer: a full turn toward it.
      const al = Math.hypot(attention[0], attention[1]) || 1;
      wx = attention[0] / al;
      wy = Math.max(-1, Math.min(1, (attention[1] / al) * 1.6));
    } else if (pointer && !stillMode) {
      const pl = Math.hypot(pointer[0], pointer[1]);
      // The look follows the pointer across the page: within 300 px, or two and a half bodies of a big blob.
      if (pl < Math.max(300, size * 2.5) && pl > 1) {
        const m = Math.min(1, pl / 120);
        wx = (pointer[0] / pl) * m;
        wy = (pointer[1] / pl) * m;
      }
    }
    lit += ((attention ? 1 : 0) - lit) * (1 - Math.exp(-dt / 0.22));
    const lk = Math.min(1, dt * 9);
    look[0] += (wx - look[0]) * lk;
    look[1] += (wy - look[1]) * lk;
    // Blinks: 120 ms every 3 to 6 s on the round eyes, one in ten doubled; never on ^ ^. The lids are a spring (LID).
    if (P.blinks && !stillMode && t >= nextBlink && t >= blinkUntil) {
      blinkUntil = t + 0.12;
      nextBlink = Math.random() < 0.1 ? t + 0.22 : t + 3 + Math.random() * 3;
    }
    // Now and then, while listening, a happy squint; its start and its end each close the lids for a moment.
    if (P.face === "OO" && !faceOverride && !stillMode && t >= nextSquint) {
      squintUntil = t + 0.8;
      nextSquint = t + 8 + Math.random() * 7;
      blinkUntil = Math.max(blinkUntil, t + 0.06);
    }
    if (squintUntil > 0 && t >= squintUntil) {
      squintUntil = -1;
      blinkUntil = Math.max(blinkUntil, t + 0.06);
      // out of a squint of joy at what it loves, the lit eyes catch the light, the nearer one first
      if (attention) glint(0.16);
    }
    // The sparkle (not under calm). An event's flare starts when its time comes and the lids are up (or on `^ ^`, whose
    // sparkle pulses); the clock's own come every few seconds (more often while lit) on a face that can show one, each
    // waiting for the lids, for the flare before it and for the page's turn; on any other face the clock just moves on.
    if (!stillMode) {
      const face = showing();
      const can = GLINTS.test(face);
      const ready = can && (face[0] === "^" || open > 0.9);
      if (queued && t >= queued.at) {
        if (!can || t > queued.at + 1) queued = null;
        else if (ready) {
          startFlare(queued.lead, queued.both, true);
          queued = null;
        }
      }
      if (t >= nextFlare) {
        const w = lit > 0.5 ? TWINKLE.lit : clock;
        if (!can) nextFlare = t + w[0] + Math.random() * w[1];
        else if (!ready || queued || t < flareEnd() + TWINKLE.gap || !startFlare(0, true, false)) nextFlare = t + 0.3 + Math.random() * 0.5;
      }
      // The stars round the head: the burst's, then while lit one more now and then.
      for (let i = sparks.length - 1; i >= 0; i--) if (t - sparks[i]!.born > SPARK.life) sparks.splice(i, 1);
      if (phase === "asleep") burstLeft = 0;
      else if (t >= nextSpark && sparks.length < SPARK.most && (burstLeft > 0 || lit > 0.5)) {
        spawnSpark();
        if (burstLeft > 0) burstLeft--;
        nextSpark = t + (burstLeft > 0 ? SPARK.stagger : SPARK.every[0] + Math.random() * SPARK.every[1]);
      }
    }
    const target = t < blinkUntil ? 0 : 1;
    if (stillMode) {
      open = target;
      openV = 0;
    } else {
      const damp = 2 * LID.zeta * Math.sqrt(LID.k);
      for (let left = dt; left > 0; left -= 1 / 240) {
        const h = Math.min(left, 1 / 240);
        openV += (LID.k * (target - open) - damp * openV) * h;
        open += openV * h;
      }
    }
    if (phase === "error" && !stillMode && t - activeAt > 1.1) {
      shiver += 1.2;
      activeAt = t;
    }
  }

  function pairNow(): string {
    let base = faceOverride ?? P.face;
    if (faceOverride) {
      // the demo's face holds; it still blinks shut on a round pair
    } else if (phase === "asleep" && !stillMode) {
      base = asleepPair(t);
    } else if (phase === "thinking" && !stillMode) {
      if (t % 1.7 < 0.567) base = "~~";
    }
    if (!faceOverride && t < squintUntil) base = "^^";
    if (open < 0.3 && !LOW.has(base[0] ?? "")) return "--";
    return base;
  }

  function draw(): void {
    const breath = stillMode ? 1 : 1 + Math.sin(t * (1.1 + cur.speed * 1.6)) * (0.03 + cur.speed * 0.016);
    const ear = phase === "asleep" && !stillMode ? 1 + 0.18 * Math.sin((TAU * t) / 4) : 1;
    // A blink dips the body a little (and the reopening's overshoot lifts it as much).
    const sq = cur.squash * (1 - LID.dip * (1 - Math.max(0, Math.min(1.15, open))));
    const Rb = (R * breath) / (1 + (0.3 + 0.4 * sy * sy) * str);
    const ampScale = cur.amp * AMP_SCALE * (1 - 0.4 * str) * ear;
    polar(sq);
    for (let i = 0; i < 512; i++) {
      const a = (i / 512) * TAU + spin;
      let s = 0;
      for (const h of H) s += h.a * Math.sin(h.k * a + h.ph);
      OUT[i] = 1 + (s / wsum) * ampScale;
    }
    const ma = Math.atan2(sy, sx);
    const m2x = m2.x;
    const m3x = m3.x;
    edgeRb = Rb;
    edgeSq = sq;
    edgeM2 = m2x;
    edgeM3 = m3x;
    for (let i = 0; i < 512; i++) {
      const a = (i / 512) * TAU - ma;
      C2[i] = Math.cos(2 * a);
      C3[i] = Math.cos(3 * a);
    }
    const hr = halo[0];
    const hg = halo[1];
    const hb = halo[2];
    const ga = 0.16 + 0.34 * Math.min(1.25, cur.glow + 0.45 * lit);
    const ba = backing ? 0.14 + 0.18 * cur.glow : 0;
    const bkr = backing ? backing[0] : 0;
    const bkg = backing ? backing[1] : 0;
    const bkb = backing ? backing[2] : 0;
    // The sparkles on the field's own cells. On ink a star's middle is paper and its arms the ramp's light end; on paper
    // the middle is the light end and the arms the ramp's blue, so it reads on either ground.
    ns = 0;
    for (const sp of sparks) {
      const age = sp.still ? SPARK.hold : t - sp.born;
      if (age < 0 || age > SPARK.life || ns >= SX.length) continue;
      const grow = Math.min(1, age / SPARK.rise);
      const fade = age <= SPARK.hold ? 1 : 1 - (age - SPARK.hold) / (SPARK.life - SPARK.hold);
      const full = Math.max(1, Math.round((SPARK.arm * sp.size * R) / cell));
      let A = Math.max(1, Math.round(full * (0.4 + 0.6 * (1 - (1 - grow) * (1 - grow)))));
      if (fade < 0.3 && A > 1) A -= 1;
      const B = Math.max(1, Math.round(A * 0.7));
      SX[ns] = Math.round((sp.x * R) / cell + c - 0.5);
      SY[ns] = Math.round((sp.y * R) / cell + c - 0.5);
      SA[ns] = A + 0.5;
      SB[ns] = B + 0.5;
      SE[ns] = fade;
      ns++;
    }
    if (ns) {
      const lo2 = backing ? eyePaper : L[1]!;
      const hi2 = backing ? L[1]! : L[3]!;
      sparkCore = (255 << 24) | ((lo2[2] & 255) << 16) | ((lo2[1] & 255) << 8) | (lo2[0] & 255);
      sparkArm = (255 << 24) | ((hi2[2] & 255) << 16) | ((hi2[1] & 255) << 8) | (hi2[0] & 255);
      sparkBody = (255 << 24) | ((eyePaper[2] & 255) << 16) | ((eyePaper[1] & 255) << 8) | (eyePaper[0] & 255);
    }
    const L5 = L[5]!;
    const rimR = (L5[0] + INK[0]) / 2;
    const rimG = (L5[1] + INK[1]) / 2;
    const rimB = (L5[2] + INK[2]) / 2;
    const stretched = str > 0.004;
    const reach = Math.ceil((1.28 * 1.7 * Rb * Math.max(1, sq)) / cell);
    const lo = Math.max(0, Math.floor(c - reach));
    const hi = Math.min(n, Math.ceil(c + reach));
    px.fill(0);
    const invRb = 1 / Rb;
    for (let y = lo; y < hi; y++) {
      for (let x = lo; x < hi; x++) {
        const i = y * n + x;
        const th = TH[i]!;
        let d: number;
        let idx: number;
        let ox = 0;
        let oy = 0;
        if (stretched) {
          ox = PX[i]! * invRb;
          oy = (PY[i]! * invRb) / sq;
          let u = ox * sx + oy * sy;
          let w = -ox * sy + oy * sx;
          const tl = smoothstep(0, 1, u * 0.9 + 0.5);
          const al = (1 + 0.95 * str) * (1 - tl) + (1 - 0.22 * str) * tl;
          const tail = u < 0 ? Math.min(1, -u) : 0;
          u /= al;
          w *= (1 + str * (0.5 * tail + 1.4 * tail * tail)) / (1 + 0.22 * str * tl);
          ox = u * sx - w * sy;
          oy = u * sy + w * sx;
          d = Math.hypot(ox, oy);
          idx = ((((Math.atan2(oy, ox) / TAU) * 512) | 0) + 512) & 511;
        } else {
          d = R0[i]! * invRb;
          idx = TI[i]!;
        }
        let mul = OUT[idx]! + m2x * C2[idx]! + m3x * C3[idx]!;
        if (mul < 0.35) mul = 0.35;
        if (d <= mul) {
          const nx = stretched ? ox / mul : PX[i]! * invRb / mul;
          const ny = stretched ? oy / mul : (PY[i]! * invRb) / sq / mul;
          const diag = clamp01(0.5 + (nx + ny) / 2.6);
          const col = L[Math.min(5, (diag * 5 + th) | 0)]!;
          const rr = smoothstep(0.55, 1, d / mul) * clamp01(0.5 + (nx + ny) / 2) * 0.42;
          const rim = Math.min(6, (rr * 6 + th) | 0) / 6;
          const ex = nx + 0.36;
          const ey = ny + 0.76;
          const eu = ((ex * ex + ey * ey) / (2 * 0.17 * 0.17)) * 16;
          const gl = eu >= 256 ? 0 : (0.85 + 0.12 * lit) * EXP[eu | 0]!;
          const glq = Math.min(8, (gl * 8 + th) | 0) / 8;
          const r = (col[0] + (rimR - col[0]) * rim) * (1 - glq) + 255 * glq;
          const gg = (col[1] + (rimG - col[1]) * rim) * (1 - glq) + 255 * glq;
          const b = (col[2] + (rimB - col[2]) * rim) * (1 - glq) + 255 * glq;
          px[i] = (255 << 24) | ((b & 255) << 16) | ((gg & 255) << 8) | (r & 255);
          // a star the body has swelled or hopped into stays whole: over the body it is paper (only near its edge, far
          // from the face)
          if (ns && d > 0.72 * mul && sparkAt(x, y, th)) px[i] = sparkBody;
        } else {
          if (ns) {
            const sc = sparkAt(x, y, th);
            if (sc) {
              px[i] = sc === 1 ? sparkCore : sparkArm;
              continue;
            }
          }
          let gq = ((1.28 + 0.08 * lit) * mul - d) / (0.85 * mul);
          if (gq <= 0) continue;
          if (gq > 1) gq = 1;
          gq = gq * gq * (3 - 2 * gq);
          const f = Math.min(5, (gq * 5 + th) | 0) / 5;
          if (f <= 0) continue;
          const ag = f * ga;
          const ab = f * ba * (1 - ag);
          const A = ag + ab;
          const r = (hr * ag + bkr * ab) / A;
          const gg = (hg * ag + bkg * ab) / A;
          const b = (hb * ag + bkb * ab) / A;
          px[i] = (((A * 255) & 255) << 24) | ((b & 255) << 16) | ((gg & 255) << 8) | (r & 255);
        }
      }
    }
    g!.putImageData(img, 0, 0);
    // The face (lib/eyes.ts): it turns with the look and leans into a stretch, on the field's cells (the body's centre is
    // the field's middle, c cells in). Its size is the resting body's, never the breath's or the stretch's, so its edges
    // hold still while it moves. The happy sparkle pops as `^ ^` appears (a pop playing is never started over).
    facePair = pairNow();
    faceCx = c * cell + look[0] * EYES.look[0] * R + sx * str * 0.39 * R;
    faceCy = c * cell + EYES.row * Rb * sq + look[1] * EYES.look[1] * R + sy * str * 0.39 * R;
    faceR = R * (phase === "muted" ? 0.9 : 1);
    if (Math.abs(look[0] * 10 - faceTurn * 10) > HOLD) faceTurn = Math.round(look[0] * 10) / 10;
    const happy = facePair[0] === "^";
    if (happy && !wasHappy && t >= joyAt + TWINKLE.pop) joyAt = t;
    wasHappy = happy;
    drawEyes();
    if (!host.dataset["live"]) host.dataset["live"] = "1";
  }

  /**
   * The face canvas alone, where the last full frame put the face: the catchlights breathe, a flare stretches and twists a
   * star (the second eye TWINKLE.lag after the first), the happy sparkle pops and pulses with each flare. Calm: at rest.
   */
  function drawEyes(): void {
    let pose: FacePose = { open, sparkle: lit, turn: faceTurn };
    if (!stillMode) {
      const u = (t - flare.at) / TWINKLE.flare;
      const v = flare.both ? u - TWINKLE.lag / TWINKLE.flare : -1;
      pose = {
        ...pose,
        twinkle: 0.5 + 0.5 * Math.sin((TAU * t) / TWINKLE.period),
        flare: flare.lead < 0 ? [u, v] : [v, u],
        spark: popSize((t - joyAt) / TWINKLE.pop) * (1 + 0.4 * flareSize(u)),
      };
    }
    const f = faceCells(facePair, faceCx, faceCy, faceR, pose, { cell, x: 0, y: 0 }, { hold: faceHold });
    // the glow: the ink lit by the halo's tone (toward the paper, as the body's light is), half way
    eyeGlow = pixel(mix3(under, mix3(halo, eyePaper, GLOW_LIFT), 0.5));
    // clear the last face's cells, write this one's, and put back only the cells either covered
    const [ox, oy, ow, oh] = faceBox;
    for (let y = Math.max(0, oy); y < Math.min(n, oy + oh); y++) facePx.fill(0, y * n + Math.max(0, ox), y * n + Math.min(n, ox + ow));
    paintFace(f);
    const x0 = Math.max(0, Math.min(ox, f.col));
    const y0 = Math.max(0, Math.min(oy, f.row));
    const x1 = Math.min(n, Math.max(ox + ow, f.col + f.w));
    const y1 = Math.min(n, Math.max(oy + oh, f.row + f.h));
    faceBox = [f.col, f.row, f.w, f.h];
    if (x1 > x0 && y1 > y0) fg!.putImageData(faceImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  /** The face's cells into the face buffer: the ink, the glow and the paper (the blob's eyes wear no rim). */
  function paintFace(f: FaceCells): void {
    for (let j = 0; j < f.h; j++) {
      const y = f.row + j;
      if (y < 0 || y >= n) continue;
      for (let i = 0; i < f.w; i++) {
        const x = f.col + i;
        const tone = f.tone[j * f.w + i];
        if (x < 0 || x >= n || !tone) continue;
        facePx[y * n + x] = tone === TONE.light ? eyeLight : tone === TONE.glow ? eyeGlow : eyeInk;
      }
    }
  }

  /** A star at field cell (x, y): 1 its middle, 2 an arm, 0 none; solid in its middle, a Bayer scatter toward its tips and as it fades. */
  function sparkAt(x: number, y: number, th: number): number {
    for (let k = 0; k < ns; k++) {
      const du = Math.abs(x - SX[k]!);
      const dv = Math.abs(y - SY[k]!);
      const a = SA[k]!;
      const b = SB[k]!;
      if (du >= b || dv >= a) continue;
      const q = Math.sqrt(du / b) + Math.sqrt(dv / a);
      if (q >= 1) continue;
      // the middle cross always, and a big one's diagonal neighbours while it is at its peak (a fuller middle)
      const near = du + dv <= 1 || (du === 1 && dv === 1 && a > 4 && SE[k]! > 0.7);
      if (SE[k]! * (near ? 1 : 0.3 + 0.7 * Math.min(1, (1 - q) * 2.6)) <= th) continue;
      return du + dv === 0 || (du + dv === 1 && a > 3) ? 1 : 2;
    }
    return 0;
  }

  function shouldRun(): boolean {
    if (destroyed || stillMode || !visible || document.hidden) return false;
    if (P.quiet && !pointer && !attention && t - activeAt > 20 && shiver < 0.02 && str < 0.005 && lit < 0.01) return false;
    return true;
  }
  function frame(now: number): void {
    raf = 0;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    step(dt);
    // The whole frame at the phase's rate (24 while stars stand round the head); a flare or a pop alone redraws only the
    // face, at 60, over the field as it was last drawn.
    const live = t < blinkUntil + 0.28 ? 60 : shiver > 0.03 || str > 0.01 || t - fadeAt < 0.6 || pointer || sparks.length > 0 ? 24 : P.fps;
    if (now - lastDraw >= 1000 / live - 2) {
      draw();
      lastDraw = now;
      lastFace = now;
    } else if ((t < flareEnd() || t < joyAt + TWINKLE.pop) && now - lastFace >= 1000 / 60 - 2) {
      drawEyes();
      lastFace = now;
    }
    if (shouldRun()) raf = requestAnimationFrame(frame);
  }
  function wake(): void {
    if (raf || !shouldRun()) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function halt(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function stillFrame(): void {
    // The deterministic pose: fixed harmonic amplitudes and phases, no wobble, so `#still` captures agree.
    H.forEach((h, i) => {
      h.a = 0.3 * h.w * (i % 2 ? -1 : 1);
      h.ph = 0.9 + i * 1.7;
    });
    m2.x = 0;
    m2.v = 0;
    m3.x = 0;
    m3.v = 0;
    shiver = 0;
    // The pose is the phase's rest, not a frame of the eased approach to it.
    cur.amp = P.amp;
    cur.speed = P.speed;
    cur.churn = P.churn;
    cur.squash = P.squash;
    cur.spin = P.spin;
    cur.glow = P.glow;
    open = 1;
    openV = 0;
    step(0.016);
    // The pose: the phase's rest, or turned full toward what it attends to, lit.
    const al = attention ? Math.hypot(attention[0], attention[1]) || 1 : 1;
    look[0] = attention ? attention[0] / al : P.rest[0];
    look[1] = attention ? attention[1] / al : P.rest[1];
    lit = attention ? 1 : 0;
    open = 1;
    stillSparks();
    draw();
  }

  // Pointer over the desk reaches the blob; a press advances the phase.
  const root = o.pointerRoot ?? host;
  const onMove = (e: PointerEvent): void => {
    // Off screen the eyes have nothing to follow: no layout read for a blob nobody sees.
    if (stillMode || !visible) return;
    const rect = host.getBoundingClientRect();
    const scale = rect.width / (size || 1) || 1;
    pointer = [(e.clientX - (rect.left + rect.width / 2)) / scale, (e.clientY - (rect.top + rect.height / 2)) / scale];
    activeAt = t;
    wake();
  };
  const onLeave = (): void => {
    pointer = null;
  };
  const onClick = (): void => {
    o.onPhaseAdvance?.();
  };
  const onVis = (): void => {
    if (document.hidden) halt();
    else wake();
  };
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", onLeave);
  host.addEventListener("click", onClick);
  document.addEventListener("visibilitychange", onVis);
  const io = new IntersectionObserver(([en]) => {
    visible = !!en?.isIntersecting;
    if (visible) wake();
    else halt();
  });
  io.observe(host);
  // A new pixel ratio: the face and the cells re-alloc at it and the pose is drawn again at once (alloc clears both).
  const unwatchDpr = watchDpr(() => {
    if (destroyed) return;
    alloc(size);
    draw();
  });

  alloc(size);
  if (stillMode) stillFrame();
  else wake();

  const handle: BlobHandle = {
    setPhase,
    setFace(pair) {
      if (pair === faceOverride) return;
      // eyes opening from a closed face (a thread blob set to work, a demo's `^ ^` let go) catch the light
      if (!isOpen(faceOverride ?? P.face) && isOpen(pair ?? P.face)) glint(TWINKLE.wake);
      faceOverride = pair;
      blinkUntil = t + 0.09;
      activeAt = t;
      if (stillMode) stillFrame();
      else wake();
    },
    nudge() {
      kick();
      activeAt = t;
      wake();
    },
    attend(at) {
      if (!at) {
        attention = null;
      } else {
        const onset = !attention;
        // One layout read per change: the vector from the blob's centre, in its own px.
        const rect = host.getBoundingClientRect();
        const scale = rect.width / (size || 1) || 1;
        attention = [(at[0] - (rect.left + rect.width / 2)) / scale, (at[1] - (rect.top + rect.height / 2)) / scale];
        // what it loves lights up: stars pop round its head and the nearer eye catches the light (on a squint of joy,
        // the happy sparkle pulses instead)
        if (onset) {
          burst();
          glint(0.06, 0, true);
        }
      }
      activeAt = t;
      if (stillMode) stillFrame();
      else wake();
    },
    cheer(seconds = 0.75) {
      if (stillMode) return;
      squintUntil = t + seconds;
      blinkUntil = Math.max(blinkUntil, t + 0.06);
      burst();
      kick();
      activeAt = t;
      wake();
    },
    setTheme(th) {
      theme = th;
      resolveTheme();
      haloTo = phaseColor(phase);
      if (stillMode || !raf) stillFrame();
    },
    destroy() {
      destroyed = true;
      halt();
      io.disconnect();
      unwatchDpr();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVis);
      field.remove();
      faceCv.remove();
      delete host.dataset["live"];
    },
  };
  return handle;
}
