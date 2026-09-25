/**
 * The live blob: the icon's dithered material (ORB_STOPS, five bands, rim, gleam) on the desktop
 * blob's live harmonic outline, with its ASCII face and its dithered halo in the phase colour.
 * Sim from UI/Orb/BlobField.swift through facts-orb.md §1.6, §2, §3, §5, §6; design.md §5.
 *
 * Two canvases in the host: the field (one buffer pixel per 1.5 CSS px cell, image-rendering:
 * pixelated) and the face (full DPR, type stays crisp). The sim steps every rAF tick; the raster
 * runs at the phase's fps (60 through a blink, 24 while anything is live). Per-cell caches carry
 * the geometry whenever the body is not stretched. The loop is paused offscreen, on a hidden tab,
 * while hidden in the notch (0.5 s after) and after 20 s of static sleep; `destroy()` releases all.
 *
 * The body is blue in every awake phase (ORB_STOPS) and titanium asleep / paused / muted
 * (QUIET_STOPS); the phase colour lives on the halo, read from `--jh-<phase>` once per change.
 */
import { BAYER8, ORB_STOPS, QUIET_STOPS, cellCss, clamp01, lut, mix3, parseColor, smoothstep, type RGB, type Stops } from "@/lib/dither";
import { cssVar, type Theme } from "@/lib/theme";
import type { Phase } from "@/lib/phase";

export interface BlobFrame {
  /** The pair on screen this frame, e.g. "OO", "--", ">>". */
  readonly pair: string;
  readonly blinking: boolean;
  readonly look: readonly [number, number];
  readonly phase: Phase;
  readonly hidden: boolean;
}

export interface BlobHandle {
  setPhase(p: Phase): void;
  setTheme(t: Theme): void;
  hide(): void;
  show(): void;
  start(): void;
  stop(): void;
  still(): void;
  destroy(): void;
  // b2 extras (optional for consumers):
  resize(size: number): void;
  onFrame(cb: (f: BlobFrame) => void): () => void;
  frameStats(): { median: number; p90: number; n: number };
  readonly phase: Phase;
}

export interface BlobOptions {
  size: number;
  phase: Phase;
  theme: Theme;
  onPhaseAdvance?: () => void;
  /** The flight into the notch: the translate (host px) from the resting place to the lip. */
  flight?: { x: number; y: number };
  /** Render one frame, no loop (`#still`, reduced motion). */
  still?: boolean;
  /** Where the pointer is watched (the whole desk); default the host. */
  pointerRoot?: HTMLElement | null;
}

/** The eyes' recipe, shared with the island's anchor: bold ui-monospace, lifted 0.85 toward white, over a ground under-copy. */
export const EYE = {
  font: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  weight: 700,
  underScale: 1.12,
  underAdd: 1.6,
  lift: 0.85,
  /** The `o`'s box centre sits 0.27 em above the baseline (BlobField.swift:2017). */
  baseline: 0.27,
};
export function eyeInk(phase: RGB): RGB {
  return mix3(phase, [255, 255, 255], EYE.lift);
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

function phaseColor(p: Phase): RGB {
  const v = cssVar(`--jh-${p}`);
  return v ? parseColor(v) : [90, 215, 255];
}

export function mountBlob(host: HTMLElement, o: BlobOptions): BlobHandle {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  let stillMode = !!o.still || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  let size = o.size;
  let cell = cellCss(1.5);
  let n = 0;
  let c = 0;
  let R = size / 2.8;
  const field = document.createElement("canvas");
  const faceCv = document.createElement("canvas");
  field.className = "desk-blob-field";
  faceCv.className = "desk-blob-face";
  host.append(field, faceCv);
  const g = field.getContext("2d");
  const fg = faceCv.getContext("2d");
  if (!g || !fg) throw new Error("blob: no 2d context");
  let img: ImageData = g.createImageData(1, 1);
  let px: Uint32Array = new Uint32Array(1);
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
    const rect = host.getBoundingClientRect();
    const scale = rect.width > 0 && host.clientWidth > 0 ? rect.width / host.clientWidth : 1;
    cell = cellCss(1.5) / (scale > 0 ? scale : 1);
    n = Math.max(4, Math.ceil(size / cell));
    c = n / 2;
    R = size / 2.8;
    field.width = n;
    field.height = n;
    field.style.width = `${n * cell}px`;
    field.style.height = `${n * cell}px`;
    faceCv.width = Math.round(size * dpr);
    faceCv.height = Math.round(size * dpr);
    faceCv.style.width = `${size}px`;
    faceCv.style.height = `${size}px`;
    img = g!.createImageData(n, n);
    px = new Uint32Array(img.data.buffer);
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
  let blinkUntil = -1;
  let nextBlink = 3 + Math.random() * 3;
  let lastPair = P.face;
  let hidden = false;
  let flight: "none" | "in" | "out" = "none";
  let flightStart = 0;
  let quietSince = -1;
  let activeAt = 0;
  let wanted = !stillMode;
  let visible = true;
  let raf = 0;
  let last = 0;
  let lastDraw = 0;
  let destroyed = false;
  const listeners = new Set<(f: BlobFrame) => void>();
  const stats: number[] = [];
  const flightVec = o.flight ?? { x: 0, y: -400 };

  function resolveTheme(): void {
    const ground = cssVar("--jh-blob-ground");
    under = ground ? parseColor(ground) : [11, 12, 16];
    backing = theme === "dark" ? under : null;
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
    // Stretch: the flight's elongation, else the hover law within 1.6 R.
    let want = 0;
    let dx = sx;
    let dy = sy;
    if (flight !== "none") {
      const prog = clamp01((t - flightStart) / 0.4);
      const len = Math.hypot(flightVec.x, flightVec.y) || 1;
      const dirx = flightVec.x / len;
      const diry = flightVec.y / len;
      want = 0.42 * Math.sin(Math.PI * prog);
      dx = flight === "in" ? dirx : -dirx;
      dy = flight === "in" ? diry : -diry;
      if (prog >= 1) {
        if (flight === "in") {
          hidden = true;
          quietSince = t;
        }
        flight = "none";
        m2.v += 0.18 * TAU * m2.hz;
        m3.v += 0.08 * TAU * m3.hz;
        shiver += 0.8;
      }
    } else if (pointer && !stillMode) {
      const l = Math.hypot(pointer[0], pointer[1]);
      if (l > 3 && l < R * 1.6) {
        want = Math.min(0.35, (l / 90) * 0.35) * (1 - smoothstep(R * 1.3, R * 1.6, l));
        dx = pointer[0] / l;
        dy = pointer[1] / l;
      }
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
    if (pointer && !stillMode) {
      const pl = Math.hypot(pointer[0], pointer[1]);
      if (pl < 300 && pl > 1) {
        const m = Math.min(1, pl / 120);
        wx = (pointer[0] / pl) * m;
        wy = (pointer[1] / pl) * m;
      }
    }
    const lk = Math.min(1, dt * 9);
    look[0] += (wx - look[0]) * lk;
    look[1] += (wy - look[1]) * lk;
    // Blinks: 120 ms every 3–6 s on the round eyes, one in ten doubled; never on ^ ^; lids ease τ 38 ms.
    if (P.blinks && !stillMode && t >= nextBlink && t >= blinkUntil) {
      blinkUntil = t + 0.12;
      nextBlink = Math.random() < 0.1 ? t + 0.22 : t + 3 + Math.random() * 3;
    }
    const target = t < blinkUntil ? 0 : 1;
    open += (target - open) * (1 - Math.exp(-dt / 0.038));
    if (phase === "error" && !stillMode && t - activeAt > 1.1) {
      shiver += 1.2;
      activeAt = t;
    }
  }

  function pairNow(): string {
    let base = P.face;
    if (phase === "asleep" && !stillMode) {
      const b = t % 8;
      if (b > 3.2 && b < 4.8) base = "~~";
    } else if (phase === "thinking" && !stillMode) {
      if (t % 1.7 < 0.567) base = "~~";
    } else if (P.face === "oo" && Math.abs(look[0]) > 0.45) {
      base = look[0] > 0 ? ">>" : "<<";
    }
    if (open < 0.3 && !LOW.has(base[0] ?? "")) return "--";
    return base;
  }

  function draw(): void {
    const t0 = performance.now();
    const breath = stillMode ? 1 : 1 + Math.sin(t * (1.1 + cur.speed * 1.6)) * (0.03 + cur.speed * 0.016);
    const ear = phase === "asleep" && !stillMode ? 1 + 0.18 * Math.sin((TAU * t) / 4) : 1;
    const sq = cur.squash;
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
    for (let i = 0; i < 512; i++) {
      const a = (i / 512) * TAU - ma;
      C2[i] = Math.cos(2 * a);
      C3[i] = Math.cos(3 * a);
    }
    const hr = halo[0];
    const hg = halo[1];
    const hb = halo[2];
    const ga = 0.16 + 0.34 * cur.glow;
    const ba = backing ? 0.14 + 0.18 * cur.glow : 0;
    const bkr = backing ? backing[0] : 0;
    const bkg = backing ? backing[1] : 0;
    const bkb = backing ? backing[2] : 0;
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
          const gl = eu >= 256 ? 0 : 0.85 * EXP[eu | 0]!;
          const glq = Math.min(8, (gl * 8 + th) | 0) / 8;
          const r = (col[0] + (rimR - col[0]) * rim) * (1 - glq) + 255 * glq;
          const gg = (col[1] + (rimG - col[1]) * rim) * (1 - glq) + 255 * glq;
          const b = (col[2] + (rimB - col[2]) * rim) * (1 - glq) + 255 * glq;
          px[i] = (255 << 24) | ((b & 255) << 16) | ((gg & 255) << 8) | (r & 255);
        } else {
          let gq = (1.28 * mul - d) / (0.85 * mul);
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
    // The face.
    fg!.setTransform(dpr, 0, 0, dpr, 0, 0);
    fg!.clearRect(0, 0, size, size);
    const pair = pairNow();
    const fs = R * 0.5 * (phase === "muted" ? 0.8 : 1);
    const cx = size / 2 + look[0] * 0.147 * R + sx * str * 0.39 * R;
    const cy = size / 2 - 0.307 * Rb * sq + look[1] * 0.123 * R + sy * str * 0.39 * R;
    const ink = eyeInk(halo);
    fg!.textAlign = "center";
    fg!.textBaseline = "alphabetic";
    const underCss = `rgb(${under[0] | 0} ${under[1] | 0} ${under[2] | 0})`;
    const inkCss = `rgb(${ink[0] | 0} ${ink[1] | 0} ${ink[2] | 0})`;
    for (let e = 0; e < 2; e++) {
      const ch = pair[e] ?? "-";
      const ex = cx + (e ? 1 : -1) * 0.461 * Rb;
      const ey = cy + EYE.baseline * fs;
      fg!.font = `${EYE.weight} ${fs * EYE.underScale + EYE.underAdd}px ${EYE.font}`;
      fg!.fillStyle = underCss;
      fg!.fillText(ch, ex, ey);
      fg!.font = `${EYE.weight} ${fs}px ${EYE.font}`;
      fg!.fillStyle = inkCss;
      fg!.fillText(ch, ex, ey);
    }
    const cost = performance.now() - t0;
    stats.push(cost);
    if (stats.length > 240) stats.shift();
    if (!host.dataset["live"]) host.dataset["live"] = "1";
    if (listeners.size) {
      const f: BlobFrame = { pair, blinking: open < 0.3, look: [look[0], look[1]], phase, hidden };
      for (const cb of listeners) cb(f);
    }
  }

  function shouldRun(): boolean {
    if (destroyed || stillMode || !wanted || !visible || document.hidden) return false;
    if (hidden && quietSince >= 0 && t - quietSince > 0.5) return false;
    if (P.quiet && flight === "none" && !pointer && t - activeAt > 20 && shiver < 0.02 && str < 0.005) return false;
    return true;
  }
  function frame(now: number): void {
    raf = 0;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    step(dt);
    const live = t < blinkUntil + 0.1 ? 60 : shiver > 0.03 || str > 0.01 || t - fadeAt < 0.6 || pointer || flight !== "none" ? 24 : P.fps;
    if (now - lastDraw >= 1000 / live - 2) {
      draw();
      lastDraw = now;
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
    look[0] = P.rest[0];
    look[1] = P.rest[1];
    open = 1;
    step(0.016);
    draw();
  }

  // Pointer over the desk reaches the blob; a press advances the phase.
  const root = o.pointerRoot ?? host;
  const onMove = (e: PointerEvent): void => {
    if (stillMode || hidden) return;
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
    if (hidden) return;
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

  alloc(size);
  if (stillMode) stillFrame();
  else wake();

  const handle: BlobHandle = {
    setPhase,
    setTheme(th) {
      theme = th;
      resolveTheme();
      haloTo = phaseColor(phase);
      if (stillMode || !raf) stillFrame();
    },
    hide() {
      if (hidden || flight === "in") return;
      flight = "in";
      flightStart = t;
      activeAt = t;
      host.style.transition = stillMode ? "none" : "transform var(--jh-slow) var(--jh-ease-in), opacity var(--jh-quick) linear var(--jh-base)";
      host.style.transform = `translate(${flightVec.x}px, ${flightVec.y}px) scale(0.1)`;
      host.style.opacity = "0";
      host.dataset["hidden"] = "1";
      if (stillMode) {
        hidden = true;
        flight = "none";
      }
      wake();
    },
    show() {
      if (!hidden && flight !== "in") return;
      hidden = false;
      quietSince = -1;
      flight = "out";
      flightStart = t;
      activeAt = t;
      host.style.transition = stillMode ? "none" : "transform var(--jh-slow) var(--jh-ease-out), opacity var(--jh-quick) linear";
      host.style.transform = "";
      host.style.opacity = "";
      delete host.dataset["hidden"];
      if (stillMode) {
        flight = "none";
        stillFrame();
      }
      wake();
    },
    start() {
      wanted = true;
      wake();
    },
    stop() {
      wanted = false;
      halt();
    },
    still() {
      stillMode = true;
      halt();
      stillFrame();
    },
    destroy() {
      destroyed = true;
      halt();
      io.disconnect();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVis);
      listeners.clear();
      field.remove();
      faceCv.remove();
      delete host.dataset["live"];
    },
    resize(sz) {
      alloc(sz);
      if (stillMode || !raf) stillFrame();
    },
    onFrame(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    frameStats() {
      const s = stats.slice().sort((a, b) => a - b);
      const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
      return { median: at(0.5), p90: at(0.9), n: s.length };
    },
    get phase() {
      return phase;
    },
  };
  return handle;
}
