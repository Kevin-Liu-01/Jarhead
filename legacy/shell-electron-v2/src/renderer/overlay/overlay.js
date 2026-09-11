// Overlay window: draws OverlayCommands on one full-window canvas.
//
// Commands arrive in GLOBAL points (origin top-left of the main display, y down;
// the second display sits above, so negative y is normal). We convert to local
// with `local = global - bounds`. The loop only runs while something is on screen.

import { connect } from "../shared/bridge.js";
import { prefersReducedMotion } from "../shared/dom.js";

const TAU = Math.PI * 2;
const CYAN = [90, 215, 255];
const GREEN = [110, 231, 160];
const INK = [11, 12, 16];
const PAPER = [232, 234, 240];
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const easeOut = (t) => 1 - (1 - t) ** 3;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const FADE_MS = 280;
const FONT = '500 12px -apple-system, system-ui, "Helvetica Neue", sans-serif';

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const reduced = prefersReducedMotion();

let bounds = { x: 0, y: 0, w: innerWidth, h: innerHeight, scaleFactor: 1 };
let dpr = 1;
let items = [];
let running = false;

const bridge = await connect("overlay");

async function refreshBounds() {
  try {
    bounds = await bridge.overlayBounds();
  } catch (err) {
    console.warn("[overlay] overlayBounds failed; using window origin", err);
  }
}

function resize() {
  dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  kick();
}

const toLocal = (x, y) => [x - bounds.x, y - bounds.y];

function handle(cmd) {
  const t0 = performance.now();
  switch (cmd.cmd) {
    case "clear":
      items = [];
      break;
    case "point": {
      const [x, y] = toLocal(cmd.x, cmd.y);
      items.push({ kind: "point", t0, ttl: cmd.ttlMs ?? 4000, x, y, label: cmd.label });
      break;
    }
    case "highlight": {
      const [x, y] = toLocal(cmd.rect.x, cmd.rect.y);
      items.push({ kind: "highlight", t0, ttl: cmd.ttlMs ?? 4000, x, y, w: cmd.rect.w, h: cmd.rect.h, label: cmd.label });
      break;
    }
    case "path": {
      const [x1, y1] = toLocal(cmd.from.x, cmd.from.y);
      const [x2, y2] = toLocal(cmd.to.x, cmd.to.y);
      items.push({ kind: "path", t0, ttl: cmd.ttlMs ?? 4000, x1, y1, x2, y2 });
      break;
    }
    case "click-pulse": {
      const [x, y] = toLocal(cmd.x, cmd.y);
      items.push({ kind: "pulse", t0, ttl: 600, x, y });
      break;
    }
    default:
      console.warn("[overlay] unknown command", cmd);
  }
  kick();
}

function kick() {
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}

function frame() {
  const now = performance.now();
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  items = items.filter((it) => now - it.t0 < it.ttl);
  for (const it of items) {
    const age = now - it.t0;
    const remaining = it.ttl - age;
    const fade = it.kind === "pulse" ? 1 : clamp01(remaining / FADE_MS);
    ctx.save();
    ctx.globalAlpha = fade;
    DRAW[it.kind](it, age, now);
    ctx.restore();
  }
  if (items.length && document.visibilityState === "visible") requestAnimationFrame(frame);
  else running = false;
}

// ----------------------------------------------------------------- drawing ---

const crisp = (v) => Math.round(v) + 0.5;

function pill(x, y, text, { tone = CYAN, align = "left" } = {}) {
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  const padX = 9;
  const hgt = 22;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  const top = y - hgt / 2;
  roundRect(left, top, w, hgt, 11);
  ctx.fillStyle = rgba(INK, 0.92);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(tone, 0.55);
  ctx.stroke();
  ctx.fillStyle = rgba(PAPER, 0.96);
  ctx.textAlign = "left";
  ctx.fillText(text, left + padX, y + 0.5);
  return { left, top, w, h: hgt };
}

function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const DRAW = {
  point(it, age, now) {
    const land = reduced ? 1 : easeOut(clamp01(age / 380));
    const ox = (1 - land) * 46;
    const oy = (1 - land) * -58;
    const x = it.x + ox;
    const y = it.y + oy;

    // arrow from top-right into the point
    const L = 30;
    const ax = x + L * 0.78;
    const ay = y - L * 0.78;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha *= 0.35 + 0.65 * land;
    ctx.strokeStyle = rgba(INK, 0.7);
    ctx.lineWidth = 5;
    arrow(ax, ay, x, y);
    ctx.strokeStyle = rgba(CYAN, 0.95);
    ctx.lineWidth = 2.2;
    arrow(ax, ay, x, y);

    // marker at the landing point
    if (land >= 1) {
      const pulse = reduced ? 0 : (Math.sin(now / 320) + 1) / 2;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(CYAN, 0.35 + 0.35 * (1 - pulse));
      ctx.beginPath();
      ctx.arc(it.x, it.y, 9 + pulse * 4, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(INK, 0.9);
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(CYAN, 1);
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, TAU);
    ctx.fill();

    if (it.label) {
      const lx = ax + 8;
      const ly = ay - 4;
      const fitsRight = lx + 160 < innerWidth;
      pill(fitsRight ? lx : ax - 8, ly, it.label, { align: fitsRight ? "left" : "right" });
    }
  },

  highlight(it, age) {
    const p = reduced ? 1 : easeOut(clamp01(age / 480));
    const r = 8;
    const x = crisp(it.x) - 0.5;
    const y = crisp(it.y) - 0.5;
    const perim = 2 * (it.w + it.h);
    ctx.lineJoin = "round";

    // soft outer glow once drawn
    if (p >= 1) {
      roundRect(x - 2, y - 2, it.w + 4, it.h + 4, r + 2);
      ctx.lineWidth = 6;
      ctx.strokeStyle = rgba(CYAN, 0.16);
      ctx.stroke();
    }
    // dark underline for contrast on light screens
    roundRect(x, y, it.w, it.h, r);
    ctx.setLineDash([perim * p, perim]);
    ctx.lineDashOffset = 0;
    ctx.lineWidth = 4;
    ctx.strokeStyle = rgba(INK, 0.55);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(CYAN, 0.95);
    ctx.stroke();
    ctx.setLineDash([]);
    // corner ticks
    if (p >= 1) {
      ctx.fillStyle = rgba(CYAN, 0.95);
      for (const [cx, cy] of [[x, y], [x + it.w, y], [x, y + it.h], [x + it.w, y + it.h]]) {
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, TAU);
        ctx.fill();
      }
    }
    if (it.label && p > 0.6) {
      ctx.globalAlpha *= clamp01((p - 0.6) / 0.4);
      const above = y - 16 > 12;
      pill(x + 2, above ? y - 16 : y + it.h + 16, it.label);
    }
  },

  path(it, age, now) {
    const p = reduced ? 1 : easeOut(clamp01(age / 640));
    const dx = it.x2 - it.x1;
    const dy = it.y2 - it.y1;
    const ex = it.x1 + dx * p;
    const ey = it.y1 + dy * p;
    ctx.lineCap = "round";
    ctx.setLineDash([3, 8]);
    ctx.lineDashOffset = reduced ? 0 : -(now / 40) % 11;
    ctx.lineWidth = 5;
    ctx.strokeStyle = rgba(INK, 0.55);
    ctx.beginPath();
    ctx.moveTo(it.x1, it.y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = rgba(CYAN, 0.9);
    ctx.stroke();
    ctx.setLineDash([]);

    // origin dot
    ctx.fillStyle = rgba(CYAN, 0.8);
    ctx.beginPath();
    ctx.arc(it.x1, it.y1, 3, 0, TAU);
    ctx.fill();

    // arrowhead at the moving end
    const ang = Math.atan2(dy, dx);
    ctx.strokeStyle = rgba(INK, 0.7);
    ctx.lineWidth = 4.5;
    head(ex, ey, ang);
    ctx.strokeStyle = rgba(CYAN, 1);
    ctx.lineWidth = 2.2;
    head(ex, ey, ang);
  },

  pulse(it, age) {
    const p = clamp01(age / 600);
    const e = easeOut(p);
    ctx.lineWidth = 3 - 2 * p;
    ctx.strokeStyle = rgba(GREEN, 1 - p);
    ctx.beginPath();
    ctx.arc(it.x, it.y, 5 + 26 * e, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(GREEN, 0.5 * (1 - p));
    ctx.beginPath();
    ctx.arc(it.x, it.y, 2 + 14 * e, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(GREEN, 1 - p);
    ctx.beginPath();
    ctx.arc(it.x, it.y, 3.5 * (1 - p * 0.5), 0, TAU);
    ctx.fill();
  },
};

function arrow(fx, fy, tx, ty) {
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  head(tx, ty, Math.atan2(ty - fy, tx - fx));
}

function head(x, y, ang, size = 9) {
  const a1 = ang + Math.PI * 0.8;
  const a2 = ang - Math.PI * 0.8;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(a1) * size, y + Math.sin(a1) * size);
  ctx.lineTo(x, y);
  ctx.lineTo(x + Math.cos(a2) * size, y + Math.sin(a2) * size);
  ctx.stroke();
}

// -------------------------------------------------------------------- boot ---

await refreshBounds();
resize();
bridge.onOverlay(handle);
window.addEventListener("resize", async () => {
  await refreshBounds();
  resize();
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && kick());
