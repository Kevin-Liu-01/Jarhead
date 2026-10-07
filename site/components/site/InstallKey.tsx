"use client";
import { useEffect, useRef, type ReactElement } from "react";
import { BAYER8, ORB_STOPS, cellCss, clamp01, lut, mix3, parseColor, smoothstep, watchDpr, type RGB } from "@/lib/dither";
import { useCalm } from "@/lib/motion";
import { cssVar, useTheme } from "@/lib/theme";
import { GLANCE_EVENT, tellGlass } from "./glass";

/** The Apple mark (the same mono path the bar uses), split at its leaf so the leaf can flick on its stem. */
const APPLE_BODY =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09z";
const APPLE_LEAF = "M15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z";

/**
 * The key's travel in CSS px and degrees: the cap's rise when lit, the lean toward the pointer, the tilt (only while the
 * pointer nears from outside: inside the key the cap stays level, so its words keep a crisp raster), the magnet's reach,
 * the press squash.
 */
const KEY = { lift: 1.5, leanX: 3, leanY: 1.5, tilt: 0.16, reach: 64, squashX: 0.014, squashY: 0.045 };
/**
 * The key is lit from inside, in 1.5 px Bayer cells of the blob's own ramp. Its light shows twice: through the frosted
 * glass as a band rising from the cap's foot (`i` strength, `h` reach, at rest, lit by hover or focus, held down, and the
 * flare a press sends up; the bloom gathers it under the finger, `w` its half-width), and on the paper round the key's
 * foot as a halo like the blob's (`s` its reach, longer below the key by `down`, thinning to nothing over its top by `up`:
 * the light pools at the foot, it never outlines the key; `rise` is the height up the sides, as fractions of the cap,
 * over which it fades in, so both sides end at the same height whatever their colour; `clear` the paper it always leaves
 * above a call stacked under the key, as on the phone, so the two never touch). Its density is evened out for each
 * colour's contrast with the ground (`even`), so the pale cyan end and the deep blue end read alike. While the keyboard's
 * ring shows (styles/site.css `.glass:focus-visible`: `w` px wide, `at` px out from the key), the halo cuts a moat of
 * paper round it, `clear` px each side, so the ring never runs between two blues (the wall above its foot, the halo below).
 */
const LIGHT = { rest: { i: 0.56, h: 9 }, lit: { i: 0.72, h: 12 }, held: { i: 0.95, h: 15 }, flare: { i: 0.45, h: 10 }, bloom: { i: 0.35, h: 12, w: 40 } };
const HALO = { rest: { i: 0.36, s: 8 }, lit: { i: 0.56, s: 10 }, held: { i: 0.34, s: 7 }, flare: { i: 0.6, s: 8 }, down: 0.7, up: 0.94, rise: { from: 0.3, to: 0.75 }, clear: 4, bleed: 40, even: { lo: 0.7, hi: 1.5 }, ring: { at: 3, w: 2, clear: 1.5 } };
/**
 * The surge a press releases: the bloom under the finger runs out both ways along the cap's foot as a crest (the band
 * swelling as the bloom does, `width` its half-width growing by `grow`), and the flare follows it, so the light fills the
 * foot outward from the press point instead of all at once. Born at the flash's edge so the first frame already shows it
 * (a click's jump to #install hides everything after the release); `life` in seconds; the flash at the press point, shown
 * only where it lands whole on bare glass; and how far past the glass the crest runs onto the paper, at the foot only:
 * `past` at the ends, `below` under the key (so it dies before the terms line), none over the top.
 */
const RIPPLE = { life: 0.8, flash: 0.22, flashR: 14, width: 12, grow: 10, past: 10, below: 6 };
/**
 * The label is kept out of the light: the mark and both lines are drawn once into a mask with a soft moat round each
 * glyph (`moats`: width in px, alpha), and the light, its crest and the flash pass behind the words at `behind` of their
 * strength, so the words stay crisp whatever crosses the glass.
 */
const LABEL = { behind: 0, moats: [[17, 0.5], [10, 0.85], [3, 1]] as const };
/** A touch has no hover: the key stays lit this long after the finger lifts. A glance from the blob lights it this long. */
const TOUCH_MS = 420;
const GLANCE_MS = 1300;

interface Spring { x: number; v: number; to: number; readonly k: number; readonly z: number }
const spring = (k: number, z: number, x = 0): Spring => ({ x, v: 0, to: x, k, z });
/**
 * A label's rendered lines, each with its text and the box its glyphs sit in. One line for a label that does not wrap; under
 * 347 px the second line wraps in two (styles/site.css), and the mask must follow each line, or the light runs into the
 * words. A label that is not one text node is read as one line.
 */
function labelLines(el: HTMLElement): { text: string; left: number; top: number; height: number }[] {
  const text = el.textContent ?? "";
  const node = el.firstChild;
  const whole = (): { text: string; left: number; top: number; height: number }[] => {
    const r = el.getBoundingClientRect();
    return [{ text, left: r.left, top: r.top, height: r.height }];
  };
  if (el.childNodes.length !== 1 || !node || node.nodeType !== Node.TEXT_NODE) return whole();
  const range = document.createRange();
  const lines: { start: number; text: string; left: number; top: number; height: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const end = m.index + m[0].length;
    range.setStart(node, m.index);
    range.setEnd(node, end);
    const r = range.getBoundingClientRect();
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(r.top - cur.top) < 1) cur.text = text.slice(cur.start, end);
    else lines.push({ start: m.index, text: m[0], left: r.left, top: r.top, height: r.height });
  }
  // one line: the element's own box, as the mask was always drawn
  return lines.length > 1 ? lines : whole();
}

function step(s: Spring, dt: number): void {
  const c = 2 * s.z * Math.sqrt(s.k);
  s.v += (s.k * (s.to - s.x) - c * s.v) * dt;
  s.x += s.v * dt;
}
const settled = (s: Spring, eps: number) => Math.abs(s.v) < eps * 4 && Math.abs(s.to - s.x) < eps;

/**
 * A press: where on the glass, when, how far its crest runs (to the glass's far end and on over the paper), and whether
 * its flash lands on bare glass.
 */
interface Ripple { readonly x: number; readonly y: number; readonly at: number; readonly far: number; readonly flash: boolean }
/** A press's crest at one moment: its centre, how far it has run each way, its half-width and strength. */
interface Crest { readonly x: number; readonly rad: number; readonly w: number; readonly k: number }

/** Signed distance to a rounded rectangle of half-size (hw, hh) and corner r, centred on the origin. */
function rrect(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** The press's crest `age` seconds after it. */
function crest(r: Ripple, age: number): Crest {
  const q = clamp01(age / RIPPLE.life);
  return {
    x: r.x,
    rad: RIPPLE.flashR + (r.far - RIPPLE.flashR) * (1 - (1 - q) ** 2.4),
    w: RIPPLE.width + RIPPLE.grow * q,
    k: q >= 1 ? 0 : (1 - q) ** 1.25,
  };
}

/** The crests at column `x`, into `out`: how high they lift the band there (`g`), and how far the flare has reached it. */
function along(runs: readonly Crest[], x: number, out: { g: number; reached: number }): void {
  out.g = 0;
  out.reached = runs.length ? 0 : 1;
  for (const c of runs) {
    const e = Math.abs(x - c.x) - c.rad;
    out.g = Math.max(out.g, c.k * Math.exp(-((e / c.w) ** 2)));
    out.reached = Math.max(out.reached, 1 - smoothstep(-c.w, c.w, e));
  }
}

/** CIE L* of a colour (0 to 100): how light it reads, for the halo's contrast with the ground. */
function lightness(c: RGB): number {
  const lin = (v: number) => {
    const u = v / 255;
    return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  };
  const Y = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
}

/**
 * The hero's Install as a physical key. The glass is the cap; under it the key's body, the blob's own dithered ramp (pale
 * cyan to the deep blue, 1.5 px Bayer cells), shows as a lit side wall, and its light comes through the frosted glass as a
 * band along the cap's foot and spills onto the paper round the key as a dithered halo, as the blob's does. Near the
 * pointer the key leans toward it a few px (springs, a magnet with a 64 px reach); on it the cap rises level, the halo
 * opens and the light gathers under the finger. A press sinks the cap onto its body with a squash, the light gathered
 * under the finger runs out both ways along the cap's foot as a crest with the flare behind it, slipping a little way onto
 * the paper at the ends, and the Apple mark ducks under the press, then hops back with a stretch while its leaf flicks
 * and wobbles on its stem. The words are masked out of the light (LABEL), so nothing crosses them. Keyboard focus lifts
 * and lights the key (the ring is the page's), Enter presses it from the mark; touch carries it on the press. The hero's
 * blob loves it (./glass): lit, the key tells the blob where it is, and the blob turns to it; pressed, the blob squints
 * with joy.
 * Cost: one rAF loop that runs only while a spring moves or a ripple lives and stops when everything settles; a pointer
 * move that changes nothing never wakes it; off screen it rests. Two canvases: the body (the halo, about 30k cells,
 * recomputed only when the light changes, and the wall's path ops) and the glass light (about 11k cells); transforms on
 * five elements; layout is read only on mount, resize, a font swap, a new pixel ratio and once per scroll. Calm (reduced
 * motion, `#still`): the rest is the still, hover, focus and press are cuts, no lean, no ripple.
 */
export function InstallKey({ href, l1, l2 }: { readonly href: string; readonly l1: string; readonly l2: string }): ReactElement {
  const root = useRef<HTMLAnchorElement>(null);
  const calm = useCalm();
  const theme = useTheme();
  const repaint = useRef<() => void>(() => undefined);

  useEffect(() => {
    repaint.current();
  }, [theme]);

  useEffect(() => {
    const a = root.current;
    const key = a?.querySelector<HTMLElement>(".glass-key");
    const cap = a?.querySelector<HTMLElement>(".glass-cap");
    const base = a?.querySelector<HTMLCanvasElement>(".glass-base");
    const ink = a?.querySelector<HTMLCanvasElement>(".glass-ink");
    const mark = a?.querySelector<SVGSVGElement>(".glass-mark");
    const leaf = a?.querySelector<SVGPathElement>(".glass-leaf");
    if (!a || !key || !cap || !base || !ink || !mark || !leaf) return;
    const bg = base.getContext("2d");
    const ig = ink.getContext("2d");
    const haloCv = document.createElement("canvas");
    const hg = haloCv.getContext("2d");
    if (!bg || !ig || !hg) return;

    // Springs: the key's lean, the cap's tilt, lift and press, the flare, the bloom's strength and place, the mark's squash,
    // hop and leaf.
    const lx = spring(260, 0.66);
    const ly = spring(260, 0.66);
    const tilt = spring(260, 0.6);
    const lift = spring(420, 0.72);
    const press = spring(1700, 0.8);
    const flare = spring(90, 1);
    const bloom = spring(220, 1);
    const bx = spring(600, 0.92);
    const by = spring(600, 0.92);
    const squash = spring(900, 0.32, 1);
    const hop = spring(520, 0.42);
    const leafA = spring(240, 0.16);
    const all = [lx, ly, tilt, lift, press, flare, bloom, bx, by, squash, hop, leafA];

    let W = 0;
    let H = 0;
    let depth = 6;
    let radius = 18;
    // The paper between the key's foot and a call stacked under it (the phone), or none.
    let room = Infinity;
    let dpr = 1;
    let rect: DOMRect | null = null;
    let dirty = true;
    let visible = false;
    let raf = 0;
    let last = 0;
    let pointer: { x: number; y: number; touch: boolean } | null = null;
    let inside = false;
    let focused = false;
    let pressed = false;
    let touchLit = false;
    let glancing = false;
    let litNow = false;
    let touchTimer = 0;
    let glanceTimer = 0;
    // The mark's centre in the key's own box at rest (cached, so no read ever follows a transform write).
    let markAt: readonly [number, number] = [38, 38];
    const ripples: Ripple[] = [];
    let clock = 0;
    const B = HALO.bleed;

    // The side wall's ramp, at 1.5 px cells, made once per size (the orb's stops: the same in both themes).
    let ramp: HTMLCanvasElement | null = null;
    let cell = cellCss(1.5);
    // The glass light's buffer and the halo's, at 1.5 px cells, and their colours per column (the ramp across the key).
    let nx = 1;
    let ny = 1;
    let img: ImageData | null = null;
    let buf: Uint32Array | null = null;
    let cols = new Uint32Array(1);
    // Per glass cell, how much light passes: none on the words and the mark, thinning softly across their moat.
    let pass = new Float32Array(1);
    let hx = 1;
    let hy = 1;
    let himg: ImageData | null = null;
    let hbuf: Uint32Array | null = null;
    let hcols = new Uint32Array(1);
    // Per halo column, its density scale: each colour's contrast with the ground evened out; and a press's crest there.
    let heven = new Float32Array(1);
    let hrun = new Float32Array(1);
    const at = { g: 0, reached: 1 };
    // Each halo cell's distance from the key's whole extent (the cap at rest over its body), measured from the cell's near
    // side so no cell straddles the edge; made once per size.
    let hsd = new Float32Array(1);
    let haloKey = "";
    const L = lut(ORB_STOPS, 5);
    const pack = (c: RGB) => ((255 << 24) | ((c[2] & 255) << 16) | ((c[1] & 255) << 8) | (c[0] & 255)) >>> 0;
    // The light's colour per column: the ramp's bright half (cyan to the middle blue), left to right, so it reads as light.
    const colourAt = (i: number, r: number, x: number): RGB => L[Math.min(5, Math.floor((0.18 + 0.45 * x) * 5 + BAYER8[((r + 4) & 7) * 8 + ((i + 4) & 7)]!))]!;
    function columns(n: number, from: number, to: number): Uint32Array<ArrayBuffer> {
      const out = new Uint32Array(n * 8);
      for (let i = 0; i < n; i++) {
        const x = clamp01((i / n - from) / (to - from));
        for (let r = 0; r < 8; r++) out[i * 8 + r] = pack(colourAt(i, r, x));
      }
      return out;
    }

    /** The label's mask: the two lines and the mark, at rest, each glyph with its moat (LABEL), in glass cells. */
    function measureLabel(capBox: DOMRect): void {
      pass = new Float32Array(nx * ny).fill(1);
      const mk = document.createElement("canvas");
      mk.width = nx;
      mk.height = ny;
      const c = mk.getContext("2d", { willReadFrequently: true });
      if (!c) return;
      // The glass light's canvas starts inside the cap's hairline.
      const ox = capBox.left + cap!.clientLeft;
      const oy = capBox.top + cap!.clientTop;
      c.scale(1 / cell, 1 / cell);
      c.lineJoin = "round";
      c.lineCap = "round";
      for (const el of cap!.querySelectorAll<HTMLElement>(".glass-l1, .glass-l2")) {
        const cs = getComputedStyle(el);
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        if ("letterSpacing" in c) c.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
        c.textBaseline = "alphabetic";
        for (const line of labelLines(el)) {
          const mt = c.measureText(line.text);
          // The baseline where CSS sets it: the font's ascent and descent centred in the line's box.
          const x = line.left - ox;
          const y = line.top - oy + (line.height - (mt.fontBoundingBoxAscent + mt.fontBoundingBoxDescent)) / 2 + mt.fontBoundingBoxAscent;
          for (const [w, al] of LABEL.moats) {
            c.globalAlpha = al;
            c.lineWidth = w;
            c.strokeText(line.text, x, y);
          }
          c.globalAlpha = 1;
          c.fillText(line.text, x, y);
        }
      }
      const vb = mark!.viewBox.baseVal;
      if (vb && vb.width > 0) {
        const r = mark!.getBoundingClientRect();
        const s = r.width / vb.width;
        c.save();
        c.translate(r.left - ox - vb.x * s, r.top - oy - vb.y * s);
        c.scale(s, s);
        for (const d of [APPLE_BODY, APPLE_LEAF]) {
          const p = new Path2D(d);
          for (const [w, al] of LABEL.moats) {
            c.globalAlpha = al;
            c.lineWidth = w / s;
            c.stroke(p);
          }
          c.globalAlpha = 1;
          c.fill(p);
        }
        c.restore();
      }
      const al = c.getImageData(0, 0, nx, ny).data;
      for (let i = 0; i < nx * ny; i++) pass[i] = 1 - (1 - LABEL.behind) * (al[i * 4 + 3]! / 255);
    }

    /** Whether a flash at (x, y) on the glass lands whole on bare glass, clear of the label and its moat. */
    function bare(x: number, y: number): boolean {
      const R = RIPPLE.flashR;
      for (let j = Math.max(0, Math.floor((y - R) / cell)); j <= Math.min(ny - 1, Math.floor((y + R) / cell)); j++) {
        for (let i = Math.max(0, Math.floor((x - R) / cell)); i <= Math.min(nx - 1, Math.floor((x + R) / cell)); i++) {
          if (Math.hypot((i + 0.5) * cell - x, (j + 0.5) * cell - y) < R && pass[j * nx + i]! < 0.99) return false;
        }
      }
      return true;
    }

    function measure(): void {
      // Read the key at rest: the transforms come off for the reads and go back on (only on mount, resize and a font swap).
      const moved = [key!, cap!, mark!, leaf!, base!] as const;
      const held = moved.map((el) => el.style.transform);
      for (const el of moved) el.style.transform = "";
      dpr = window.devicePixelRatio || 1;
      depth = Number.parseFloat(getComputedStyle(a!).getPropertyValue("--key-depth")) || 6;
      radius = Number.parseFloat(getComputedStyle(cap!).borderTopLeftRadius) || 18;
      W = cap!.offsetWidth;
      H = cap!.offsetHeight;
      cell = cellCss(1.5);
      const ar = a!.getBoundingClientRect();
      const nb = a!.nextElementSibling?.getBoundingClientRect();
      room = nb && nb.top >= ar.bottom && nb.left < ar.right && nb.right > ar.left ? nb.top - ar.bottom : Infinity;
      const capBox = cap!.getBoundingClientRect();
      const mr = mark!.getBoundingClientRect();
      markAt = [mr.left + mr.width / 2 - ar.left, mr.top + mr.height / 2 - ar.top];
      // The body's canvas: the key's box and the halo's bleed round it.
      base!.width = Math.ceil((W + B * 2) * dpr);
      base!.height = Math.ceil((H + depth + B * 2) * dpr);
      base!.style.width = `${W + B * 2}px`;
      base!.style.height = `${H + depth + B * 2}px`;
      base!.style.left = `${-B}px`;
      base!.style.top = `${-B}px`;
      // The ramp: across the key as the orb is lit (pale on the left, deep on the right), shading down the wall to the
      // floor, whose last cell row leans toward ink (the orb's rim); five bands, Bayer per 1.5 px cell.
      const rx = Math.ceil(W / cell);
      const ry = Math.ceil((H + depth) / cell);
      ramp = document.createElement("canvas");
      ramp.width = rx;
      ramp.height = ry;
      const rg = ramp.getContext("2d");
      const inkVar = cssVar("--jh-ink");
      const inkTone: RGB = inkVar ? parseColor(inkVar) : [7, 7, 7];
      if (rg) {
        const id = rg.createImageData(rx, ry);
        const p = new Uint32Array(id.data.buffer);
        const top = (H - radius * 0.5) / cell;
        for (let y = 0; y < ry; y++) {
          const down = clamp01((y - top) / Math.max(1, (radius * 0.5 + depth) / cell));
          for (let x = 0; x < rx; x++) {
            const t = BAYER8[(y & 7) * 8 + (x & 7)]!;
            const u = clamp01(0.14 + 0.6 * (x / rx) + 0.3 * down);
            let col = L[Math.min(5, Math.floor(u * 5 + t))]!;
            if (y >= ry - 1) col = mix3(col, inkTone, 0.3);
            p[y * rx + x] = pack(col);
          }
        }
        rg.putImageData(id, 0, 0);
      }
      nx = Math.max(1, Math.ceil(cap!.clientWidth / cell));
      ny = Math.max(1, Math.ceil(cap!.clientHeight / cell));
      ink!.width = nx;
      ink!.height = ny;
      ink!.style.width = `${nx * cell}px`;
      ink!.style.height = `${ny * cell}px`;
      img = ig!.createImageData(nx, ny);
      buf = new Uint32Array(img.data.buffer);
      cols = columns(nx, 0, 1);
      measureLabel(capBox);
      hx = Math.max(1, Math.ceil((W + B * 2) / cell));
      hy = Math.max(1, Math.ceil((H + depth + B * 2) / cell));
      haloCv.width = hx;
      haloCv.height = hy;
      himg = hg!.createImageData(hx, hy);
      hbuf = new Uint32Array(himg.data.buffer);
      const from = B / (W + B * 2);
      const to = (B + W) / (W + B * 2);
      hcols = columns(hx, from, to);
      // Even the halo's density for contrast: a pale cyan cell on paper reads far less than a deep blue one (and the other
      // way round on the dark ground), so each column's density is scaled toward the mean contrast.
      const groundVar = cssVar("--jh-ground");
      const gl = lightness(groundVar ? parseColor(groundVar) : [251, 250, 247]);
      const contrast = new Float32Array(hx);
      let sum = 0;
      for (let i = 0; i < hx; i++) {
        const x = clamp01((i / hx - from) / (to - from));
        let cs = 0;
        for (let r = 0; r < 8; r++) cs += Math.abs(lightness(colourAt(i, r, x)) - gl);
        contrast[i] = Math.max(1, cs / 8);
        sum += contrast[i]!;
      }
      const mean = sum / hx;
      heven = new Float32Array(hx);
      hrun = new Float32Array(hx);
      for (let i = 0; i < hx; i++) heven[i] = Math.min(HALO.even.hi, Math.max(HALO.even.lo, mean / contrast[i]!));
      hsd = new Float32Array(hx * hy);
      for (let j = 0; j < hy; j++) {
        for (let i = 0; i < hx; i++) {
          hsd[j * hx + i] = rrect((i + 0.5) * cell - B - W / 2, (j + 0.5) * cell - B - (H + depth) / 2, W / 2, (H + depth) / 2, radius) - cell * 0.5;
        }
      }
      haloKey = "";
      dirty = true;
      moved.forEach((el, i) => {
        el.style.transform = held[i] ?? "";
      });
    }

    // The cap's transform about its foot's centre: lift and press move it, tilt turns it, the press squashes it.
    function capMatrix(): { ty: number; rot: number; sx: number; sy: number } {
      const p = Math.max(0, press.x);
      return {
        ty: -lift.x * KEY.lift + press.x * depth,
        rot: (tilt.x * Math.PI) / 180,
        sx: 1 + KEY.squashX * p,
        sy: 1 - KEY.squashY * p,
      };
    }

    // The halo on the paper and the crest's run past the glass, in key coordinates offset by the bleed.
    function drawHalo(capTop: number): void {
      if (!himg || !hbuf) return;
      const lit = clamp01(lift.x);
      const held = clamp01(press.x);
      const fl = Math.max(0, flare.x);
      const I = HALO.rest.i + (HALO.lit.i - HALO.rest.i) * lit + (HALO.held.i - HALO.lit.i) * held + HALO.flare.i * fl;
      const S = HALO.rest.s + (HALO.lit.s - HALO.rest.s) * lit + (HALO.held.s - HALO.lit.s) * held + HALO.flare.s * fl;
      // While the cap is sunk the halo stops at its top: nothing of it stands over the sunken glass.
      const clipTop = capTop > 0.5 ? capTop : -Infinity;
      const k = `${I.toFixed(3)}|${S.toFixed(2)}|${clipTop === -Infinity ? "" : clipTop.toFixed(1)}|${focused ? "ring" : ""}`;
      if (k === haloKey && ripples.length === 0) return;
      haloKey = ripples.length ? "" : k;
      const p = hbuf;
      p.fill(0);
      // About the key's whole extent, so a sunken cap leaves paper above it, not light.
      const cy = (H + depth) / 2;
      const hh = (H + depth) / 2;
      // Below the key it reaches `down` further, but its last cell ends `clear` short of a call stacked there.
      const down = Math.min(HALO.down, (room - HALO.clear - cell) / S - 1);
      const reach = S * (1 + Math.max(0, down)) + 2;
      const foot = H + depth;
      // The crest's strength per column; on the paper it shows at the foot only, thinning up the ends as the band does.
      const runs = ripples.map((r) => crest(r, clock - r.at));
      for (let i = 0; runs.length && i < hx; i++) {
        along(runs, (i + 0.5) * cell - B, at);
        hrun[i] = at.g;
      }
      const capFoot = H + capTop;
      const crestH = LIGHT.held.h + LIGHT.bloom.h;
      // While the ring shows, its moat: from and to, out from the key's edge.
      const mFrom = focused ? HALO.ring.at - HALO.ring.clear : Infinity;
      const mTo = focused ? HALO.ring.at + HALO.ring.w + HALO.ring.clear : -Infinity;
      for (let j = 0; j < hy; j++) {
        const y = (j + 0.5) * cell - B;
        const below = clamp01((y - cy) / hh);
        const above = clamp01((cy - y) / hh);
        const s = Math.max(0.5, S * (1 + down * below - HALO.up * above));
        const row = j & 7;
        // Up the sides the halo fades in over `rise`, the same height on both sides; a sunken cap clips it at its top.
        const rise = y >= clipTop ? smoothstep(H * HALO.rise.from, H * HALO.rise.to, y) : 0;
        // The crest spills `past` the glass at the ends, `below` under it, and nothing over its top.
        const past = y < foot - radius ? RIPPLE.past * smoothstep(0, radius, y) : RIPPLE.past + (RIPPLE.below - RIPPLE.past) * smoothstep(foot - radius, foot, y);
        const low = runs.length ? (1 - smoothstep(0, crestH, capFoot - y)) ** 1.35 : 0;
        for (let i = 0; i < hx; i++) {
          const sd = hsd[j * hx + i]!;
          // A cell spans [sd, sd + cell] out from the key: none on the key, none touching the ring's moat.
          if (sd <= 0 || (sd + cell > mFrom && sd < mTo)) continue;
          let u = rise > 0 && sd < reach ? I * rise * heven[i]! * (1 - smoothstep(0, s, sd)) ** 1.7 : 0;
          if (low > 0.01 && sd < past) {
            const v = hrun[i]! * low * (1 - smoothstep(2, past, sd)) * 1.05;
            if (v > u) u = v;
          }
          if (u > 0.01 && u > BAYER8[row * 8 + (i & 7)]!) p[j * hx + i] = hcols[i * 8 + row]!;
        }
      }
      hg!.putImageData(himg, 0, 0);
    }

    function drawBody(): void {
      if (!ramp) return;
      const m = capMatrix();
      drawHalo(m.ty);
      bg!.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg!.clearRect(0, 0, W + B * 2, H + depth + B * 2);
      bg!.imageSmoothingEnabled = false;
      bg!.drawImage(haloCv, 0, 0, hx * cell, hy * cell);
      bg!.save();
      bg!.translate(B, B);
      // The body's footprint (the cap's shape, a key's depth down), only below the cap's foot: never a sliver above it.
      bg!.beginPath();
      bg!.rect(-B, H + m.ty - radius, W + B * 2, depth + radius + B);
      bg!.clip();
      bg!.beginPath();
      bg!.roundRect(0, depth, W, H, radius);
      bg!.clip();
      bg!.drawImage(ramp, 0, 0, ramp.width * cell, ramp.height * cell);
      bg!.restore();
      // Cut away what the cap covers, where the cap is now (the glass shows what is under it).
      bg!.save();
      bg!.translate(B + W / 2, B + H + m.ty);
      bg!.rotate(m.rot);
      bg!.scale(m.sx, m.sy);
      bg!.globalCompositeOperation = "destination-out";
      bg!.beginPath();
      bg!.roundRect(-W / 2, -H, W, H, radius);
      bg!.fill();
      bg!.restore();
    }

    function drawLight(): void {
      if (!img || !buf) return;
      const p = buf;
      p.fill(0);
      const lit = clamp01(lift.x);
      const held = clamp01(press.x);
      const fl = Math.max(0, flare.x);
      const bl = Math.max(0, bloom.x);
      const baseI = LIGHT.rest.i + (LIGHT.lit.i - LIGHT.rest.i) * lit + (LIGHT.held.i - LIGHT.lit.i) * held;
      const baseH = LIGHT.rest.h + (LIGHT.lit.h - LIGHT.rest.h) * lit + (LIGHT.held.h - LIGHT.lit.h) * held;
      const runs = ripples.map((r) => crest(r, clock - r.at));
      const ch = ny * cell;
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * cell;
        // The bloom under the finger, or a press's crest running out from it, whichever stands higher here; the flare
        // only where the crest has passed.
        along(runs, x, at);
        const g = Math.max(bl > 0.004 ? bl * Math.exp(-(((x - bx.x) / LIGHT.bloom.w) ** 2)) : 0, at.g);
        const fr = fl * at.reached;
        const I = Math.min(1, baseI + LIGHT.flare.i * fr + LIGHT.bloom.i * g);
        const Hc = baseH + LIGHT.flare.h * fr + LIGHT.bloom.h * g;
        for (let j = 0; j < ny; j++) {
          const y = (j + 0.5) * cell;
          const up = ch - y;
          // The resting band is the glass's own and stands as it is; whatever rises over it passes behind the words.
          const rest = up < LIGHT.rest.h ? LIGHT.rest.i * (1 - smoothstep(0, LIGHT.rest.h, up)) ** 1.35 : 0;
          let u = up < Hc ? I * (1 - smoothstep(0, Hc, up)) ** 1.35 : 0;
          for (const r of ripples) {
            const age = clock - r.at;
            if (!r.flash || age >= RIPPLE.flash) continue;
            const f = (1 - age / RIPPLE.flash) * (1 - smoothstep(RIPPLE.flashR * 0.4, RIPPLE.flashR, Math.hypot(x - r.x, y - r.y)));
            if (f > u) u = f;
          }
          u = Math.max(Math.min(u, rest), u * pass[j * nx + i]!);
          if (u <= 0.01) continue;
          const row = j & 7;
          if (u > BAYER8[row * 8 + (i & 7)]!) p[j * nx + i] = cols[i * 8 + row]!;
        }
      }
      ig!.putImageData(img, 0, 0);
    }

    const round = (v: number) => Math.round(v * dpr) / dpr;
    function render(): void {
      const lean = Math.abs(lx.x) > 0.01 || Math.abs(ly.x) > 0.01 ? `translate(${round(lx.x)}px, ${round(ly.x)}px)` : "";
      // The key and its body's canvas lean together; the canvas is not inside the key, so a transform on the key never
      // lifts the halo over the words round it (it stays under the hero's text, styles/site.css .glass-base).
      key!.style.transform = lean;
      base!.style.transform = lean;
      const m = capMatrix();
      const moved = Math.abs(m.ty) > 0.01 || Math.abs(m.rot) > 0.00005 || Math.abs(m.sx - 1) > 0.0002;
      const turn = Math.abs(m.rot) > 0.00005 ? ` rotate(${m.rot.toFixed(4)}rad)` : "";
      const sq = Math.abs(m.sx - 1) > 0.0002 ? ` scale(${m.sx.toFixed(4)}, ${m.sy.toFixed(4)})` : "";
      cap!.style.transform = moved ? `translateY(${round(m.ty)}px)${turn}${sq}` : "";
      // The mark: squashed under the press (wider, shorter, from its foot), stretched as it springs back, hopping up.
      const s = squash.x;
      const markMoved = Math.abs(s - 1) > 0.002 || Math.abs(hop.x) > 0.05;
      mark!.style.transform = markMoved ? `translateY(${hop.x.toFixed(2)}px) scale(${(1 - 0.7 * (s - 1)).toFixed(4)}, ${s.toFixed(4)})` : "";
      leaf!.style.transform = Math.abs(leafA.x) > 0.05 ? `rotate(${leafA.x.toFixed(2)}deg)` : "";
      drawBody();
      drawLight();
      if (a!.dataset["live"] === undefined) a!.dataset["live"] = "";
    }

    // Where the pointer is against the key: the targets.
    function aim(): void {
      if (dirty || !rect) {
        rect = a!.getBoundingClientRect();
        dirty = false;
      }
      const r = rect;
      let near = 0;
      let dx = 0;
      let dy = 0;
      inside = false;
      if (pointer && !pointer.touch && !calm) {
        const cx = r.left + r.width / 2;
        const cy = r.top + H / 2;
        dx = Math.max(-1, Math.min(1, (pointer.x - cx) / (r.width / 2)));
        dy = Math.max(-1, Math.min(1, (pointer.y - cy) / (H / 2)));
        const ox = Math.max(0, Math.abs(pointer.x - cx) - r.width / 2);
        const oy = Math.max(0, Math.abs(pointer.y - (r.top + r.height / 2)) - r.height / 2);
        near = 1 - smoothstep(0, KEY.reach, Math.hypot(ox, oy));
        inside = ox === 0 && oy === 0;
        if (inside) {
          bx.to = pointer.x - r.left - 1;
          by.to = pointer.y - r.top - 1;
        }
      } else if (pointer && !pointer.touch && calm) {
        inside = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
      }
      // Focused, the key holds still inside the page's ring, so the halo's moat stays true to it.
      const pull = focused ? 0 : near;
      lx.to = dx * KEY.leanX * pull;
      ly.to = dy * KEY.leanY * pull;
      // The magnet tips the near side down only as the pointer comes; on the key the cap is level.
      tilt.to = calm || inside ? 0 : dx * KEY.tilt * pull;
      const shown = focused || touchLit || glancing;
      const lit = inside || shown;
      lift.to = pressed ? 0 : lit ? 1 : 0.3 * near;
      press.to = pressed ? 1 : 0;
      bloom.to = calm ? 0 : inside ? 1 : shown ? 0.8 : 0;
      squash.to = pressed && !calm ? 0.84 : 1;
      leafA.to = pressed && !calm ? 14 : 0;
      if (shown && !inside && !touchLit) {
        // Keyboard and the blob's glance: the light gathers under the mark.
        bx.to = markAt[0] - 1;
        by.to = markAt[1] - 1;
      }
      if (lit !== litNow) {
        litNow = lit;
        tellGlass({ kind: "lit", on: lit, at: [r.left + r.width / 2, r.top + H / 2] });
      }
    }

    function moving(): boolean {
      if (ripples.length) return true;
      return !(
        settled(lx, 0.01) && settled(ly, 0.01) && settled(tilt, 0.002) && settled(lift, 0.002) && settled(press, 0.002) && settled(flare, 0.002) &&
        settled(bloom, 0.002) && settled(bx, 0.2) && settled(by, 0.2) && settled(squash, 0.001) && settled(hop, 0.03) && settled(leafA, 0.05)
      );
    }

    function frame(now: number): void {
      raf = 0;
      const dt = Math.max(0, Math.min(0.05, (now - (last || now)) / 1000));
      last = now;
      clock += dt;
      for (let left = dt; left > 0; left -= 1 / 240) {
        const h = Math.min(left, 1 / 240);
        for (const s of all) step(s, h);
      }
      while (ripples.length && clock - ripples[0]!.at > RIPPLE.life) ripples.shift();
      const go = moving();
      if (!go) for (const s of all) {
        s.x = s.to;
        s.v = 0;
      }
      render();
      if (go && visible) raf = requestAnimationFrame(frame);
    }
    // Under calm a change is a cut: drawn once, and only when what is lit or pressed changes.
    let cut = "";
    function wake(): void {
      if (calm) {
        aim();
        const now = `${lift.to}|${press.to}|${focused}`;
        if (now === cut) return;
        cut = now;
        for (const s of all) {
          s.x = s.to;
          s.v = 0;
        }
        ripples.length = 0;
        render();
        return;
      }
      if (raf || !visible || !moving()) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    }
    function rest(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pointer = null;
      pressed = false;
      ripples.length = 0;
      aim();
      for (const s of all) {
        s.x = s.to;
        s.v = 0;
      }
      render();
      // The key is drawn at rest now, whatever the last cut was: the next calm wake draws again.
      cut = "";
    }

    const onMove = (e: PointerEvent): void => {
      if (!visible) return;
      pointer = { x: e.clientX, y: e.clientY, touch: e.pointerType === "touch" };
      const was = inside;
      aim();
      // Arriving on the key the leaf sways once; a move that changes nothing wakes nothing.
      if (inside && !was && !calm) leafA.v -= 140;
      wake();
    };
    const onLeaveDoc = (): void => {
      pointer = null;
      aim();
      wake();
    };
    const pressAt = (x: number, y: number): void => {
      pressed = true;
      if (!calm) {
        ripples.length = 0;
        ripples.push({ x, y, at: clock, far: Math.max(x, W - x) + RIPPLE.past, flash: bare(x, y) });
        flare.v += 26;
        leafA.v += 220;
        // The light jumps to the press point.
        bx.x = bx.to = x;
        by.x = by.to = y;
      }
      aim();
      tellGlass({ kind: "press" });
      if (calm) {
        wake();
        return;
      }
      // Draw the press now, in this task: the crest and the sink are on screen before a click's jump to #install.
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = performance.now();
      for (let left = 1 / 60; left > 0; left -= 1 / 240) for (const s of all) step(s, Math.min(left, 1 / 240));
      clock += 1 / 60;
      render();
      if (visible) raf = requestAnimationFrame(frame);
    };
    const release = (): void => {
      if (!pressed) return;
      pressed = false;
      if (!calm) {
        // The mark springs back with a hop and a stretch, its leaf swinging past rest and wobbling home.
        hop.v -= 120;
        squash.v += 2.2;
        leafA.v -= 340;
      }
      aim();
      wake();
    };
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      rect = a.getBoundingClientRect();
      dirty = false;
      const touch = e.pointerType === "touch";
      pointer = { x: e.clientX, y: e.clientY, touch };
      if (touch) {
        // A touch has no hover: the press carries it all, and the key stays lit a moment after the finger lifts.
        window.clearTimeout(touchTimer);
        touchLit = true;
      }
      pressAt(e.clientX - rect.left - 1, e.clientY - rect.top - 1);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerType === "touch" && touchLit) {
        window.clearTimeout(touchTimer);
        touchTimer = window.setTimeout(() => {
          touchLit = false;
          aim();
          wake();
        }, TOUCH_MS);
      }
      release();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Enter" || e.repeat) return;
      pressAt(markAt[0] - 1, markAt[1] - 1);
    };
    // The moat comes and goes with the ring, even when nothing else on the key moves (lit already by the pointer).
    const ringChanged = (): void => {
      if (!calm && !raf) render();
    };
    const onFocus = (): void => {
      focused = a.matches(":focus-visible");
      if (focused && !calm) leafA.v -= 140;
      aim();
      wake();
      ringChanged();
    };
    const onBlur = (): void => {
      focused = false;
      pressed = false;
      aim();
      wake();
      ringChanged();
    };
    const onScroll = (): void => {
      dirty = true;
    };
    // The blob's first look, once it has arrived: the key lights for a moment in reply (the blob sees it lit and turns).
    const onGlance = (): void => {
      if (calm) return;
      window.clearTimeout(glanceTimer);
      glancing = true;
      aim();
      wake();
      glanceTimer = window.setTimeout(() => {
        glancing = false;
        aim();
        wake();
      }, GLANCE_MS);
    };

    measure();
    repaint.current = () => {
      measure();
      render();
    };
    render();
    let gone = false;
    void document.fonts?.ready.then(() => {
      if (gone) return;
      measure();
      render();
    });

    const io = new IntersectionObserver(([en]) => {
      visible = !!en?.isIntersecting;
      dirty = true;
      if (!visible) rest();
    });
    io.observe(a);
    const ro = new ResizeObserver(() => {
      measure();
      render();
    });
    ro.observe(cap);
    // The cap keeps its CSS size through a zoom or a move to another display: a new pixel ratio re-measures it here.
    const unwatchDpr = watchDpr(() => {
      measure();
      render();
    });
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeaveDoc);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    window.addEventListener(GLANCE_EVENT, onGlance);
    a.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    a.addEventListener("keydown", onKeyDown);
    a.addEventListener("keyup", release);
    a.addEventListener("focus", onFocus);
    a.addEventListener("blur", onBlur);
    return () => {
      gone = true;
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(touchTimer);
      window.clearTimeout(glanceTimer);
      io.disconnect();
      ro.disconnect();
      unwatchDpr();
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeaveDoc);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener(GLANCE_EVENT, onGlance);
      a.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      a.removeEventListener("keydown", onKeyDown);
      a.removeEventListener("keyup", release);
      a.removeEventListener("focus", onFocus);
      a.removeEventListener("blur", onBlur);
      if (litNow) tellGlass({ kind: "lit", on: false, at: [0, 0] });
      repaint.current = () => undefined;
      key.style.transform = "";
      base.style.transform = "";
      cap.style.transform = "";
      mark.style.transform = "";
      leaf.style.transform = "";
      delete a.dataset["live"];
    };
  }, [calm]);

  return (
    <a ref={root} className="glass" href={href}>
      <canvas className="glass-base" width={1} height={1} aria-hidden="true" />
      <span className="glass-key">
        <span className="glass-cap">
          <canvas className="glass-ink" width={1} height={1} aria-hidden="true" />
          <svg className="glass-mark" viewBox="0 0 24 24" width={28} height={28} fill="currentColor" aria-hidden="true" focusable="false">
            <path d={APPLE_BODY} />
            <path className="glass-leaf" d={APPLE_LEAF} />
          </svg>
          <span className="glass-lines">
            <span className="glass-l1">{l1}</span>
            <span className="glass-l2">{l2}</span>
          </span>
        </span>
      </span>
    </a>
  );
}
