// The orb's canvas renderer. One 96×96 canvas, DPR-aware, cheap.
//
// Every phase is a set of numeric visual parameters (colour, core radius, glow,
// how visible each motif is). Phase changes set a new target and the current
// parameters ease toward it every frame, so phases morph instead of snapping.
// The loop stops itself when nothing is animating (muted, error after its pulse,
// hidden window) and runs at a reduced rate while asleep.

import { PHASE_META } from "../shared/phase.js";
import { prefersReducedMotion } from "../shared/dom.js";

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Visual targets per phase. All in CSS px on a 96 px canvas (centre 48,48).
//   core: sphere radius   glow: outer halo strength   bright: colour intensity
//   ring/dash/wave/part/ret/slash: opacity of each motif (0..1)
//   breathe: amplitude px   bspeed: cycles per second
const TARGETS = {
  asleep: { core: 18, glow: 0.16, bright: 0.6, ring: 0, dash: 0, wave: 0, part: 0, ret: 0, slash: 0, breathe: 1.4, bspeed: 0.22 },
  connecting: { core: 19, glow: 0.26, bright: 0.85, ring: 0, dash: 1, wave: 0, part: 0, ret: 0, slash: 0, breathe: 0.5, bspeed: 0.5 },
  listening: { core: 21, glow: 0.5, bright: 1, ring: 1, dash: 0, wave: 0, part: 0, ret: 0, slash: 0, breathe: 1.1, bspeed: 0.4 },
  speaking: { core: 22, glow: 0.62, bright: 1, ring: 0, dash: 0, wave: 1, part: 0, ret: 0, slash: 0, breathe: 0.4, bspeed: 0.8 },
  thinking: { core: 20, glow: 0.42, bright: 0.95, ring: 0.3, dash: 0, wave: 0, part: 1, ret: 0, slash: 0, breathe: 0.8, bspeed: 0.3 },
  acting: { core: 20, glow: 0.5, bright: 1, ring: 0, dash: 0, wave: 0, part: 0, ret: 1, slash: 0, breathe: 0.35, bspeed: 0.6 },
  muted: { core: 20, glow: 0.14, bright: 0.75, ring: 0, dash: 0, wave: 0, part: 0, ret: 0, slash: 1, breathe: 0, bspeed: 0 },
  error: { core: 21, glow: 0.42, bright: 1, ring: 0.55, dash: 0, wave: 0, part: 0, ret: 0, slash: 0, breathe: 0, bspeed: 0 },
};

// Phases whose motif keeps moving forever (so the loop must keep running).
const CONTINUOUS = new Set(["connecting", "listening", "speaking", "thinking", "acting"]);

const PARTICLES = Array.from({ length: 6 }, (_, i) => ({
  angle: (i / 6) * TAU + 0.4 * i,
  radius: 29 + (i % 3) * 3.4,
  speed: (0.32 + (i % 2) * 0.22) * (i % 3 === 1 ? -1 : 1),
  size: 1.4 + (i % 2) * 0.5,
}));

export class OrbRenderer {
  constructor(canvas, { size = 96 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.size = size;
    this.dpr = 1;
    this.phase = "asleep";
    this.params = { ...TARGETS.asleep, rgb: hexToRgb(PHASE_META.asleep.color) };
    this.target = TARGETS.asleep;
    this.targetRgb = hexToRgb(PHASE_META.asleep.color);
    this.levels = { input: 0, output: 0 };
    this.shownLevels = { input: 0, output: 0 };
    this.time = 0;
    this.lastFrame = 0;
    this.running = false;
    this.visible = true;
    this.errorPulseStart = -1;
    this.wavePhase = 0;
    this.reduced = prefersReducedMotion();
    this.resize();
    this.start();
  }

  resize() {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.dpr = dpr;
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.start();
  }

  setPhase(phase) {
    if (phase === this.phase) return;
    this.phase = phase;
    const t = TARGETS[phase] ?? TARGETS.error;
    this.target = t;
    this.targetRgb = hexToRgb((PHASE_META[phase] ?? PHASE_META.error).color);
    if (phase === "error") this.errorPulseStart = performance.now();
    this.start();
  }

  setLevels(levels) {
    this.levels = levels;
    if (this.phase === "listening" || this.phase === "speaking") this.start();
  }

  setVisible(visible) {
    this.visible = visible;
    if (visible) this.start();
    else this.running = false;
  }

  start() {
    if (this.running || !this.visible) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
  }

  destroy() {
    this.running = false;
  }

  /** True while any parameter is still easing toward its target. */
  converged() {
    const p = this.params;
    const t = this.target;
    for (const k of Object.keys(t)) if (Math.abs(p[k] - t[k]) > 0.01) return false;
    for (let i = 0; i < 3; i += 1) if (Math.abs(p.rgb[i] - this.targetRgb[i]) > 0.6) return false;
    return true;
  }

  frame = (now) => {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);

    // Frame gating: asleep animates slowly, so 20 fps is plenty.
    const fpsCap = this.phase === "asleep" ? 20 : 60;
    if (now - this.lastFrame < 1000 / fpsCap - 1) {
      requestAnimationFrame(this.frame);
      return;
    }
    this.lastFrame = now;
    this.time += dt;

    // Ease params toward target (~250 ms to settle).
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / 0.08);
    const p = this.params;
    const next = { rgb: [0, 0, 0] };
    for (const key of Object.keys(this.target)) next[key] = lerp(p[key], this.target[key], k);
    for (let i = 0; i < 3; i += 1) next.rgb[i] = lerp(p.rgb[i], this.targetRgb[i], k);
    this.params = next;

    // Level smoothing: fast attack, slower release.
    const sl = this.shownLevels;
    const attack = 0.55;
    const release = 0.14;
    sl.input += (this.levels.input - sl.input) * (this.levels.input > sl.input ? attack : release);
    sl.output += (this.levels.output - sl.output) * (this.levels.output > sl.output ? attack : release);

    this.draw(now);

    const pulseActive = this.phase === "error" && now - this.errorPulseStart < 900;
    const keepGoing =
      !this.converged() ||
      CONTINUOUS.has(this.phase) ||
      (this.phase === "asleep" && !this.reduced) ||
      pulseActive ||
      sl.input > 0.01 ||
      sl.output > 0.01;

    if (keepGoing) requestAnimationFrame(this.frame);
    else this.running = false;
  };

  draw(now) {
    const { ctx, size } = this;
    const p = this.params;
    const cx = size / 2;
    const cy = size / 2;
    const [r, g, b] = p.rgb.map((v) => Math.round(v));
    const col = (a) => `rgba(${r},${g},${b},${a})`;
    const t = this.time;
    const inL = this.shownLevels.input;
    const outL = this.shownLevels.output;

    ctx.clearRect(0, 0, size, size);

    const breathe = this.reduced ? 0 : p.breathe * Math.sin(t * p.bspeed * TAU);
    const coreR = p.core + breathe + outL * 2.4 * p.wave + inL * 1.2 * p.ring;

    // --- outer glow
    if (p.glow > 0.01) {
      const glowR = 46;
      const gr = ctx.createRadialGradient(cx, cy, coreR * 0.6, cx, cy, glowR);
      gr.addColorStop(0, col(0.55 * p.glow * p.bright));
      gr.addColorStop(0.45, col(0.16 * p.glow));
      gr.addColorStop(1, col(0));
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, TAU);
      ctx.fill();
    }

    // --- core sphere
    const sphere = ctx.createRadialGradient(cx - coreR * 0.35, cy - coreR * 0.4, coreR * 0.1, cx, cy, coreR);
    sphere.addColorStop(0, `rgba(${Math.min(255, r + 90)},${Math.min(255, g + 90)},${Math.min(255, b + 90)},${0.95 * p.bright})`);
    sphere.addColorStop(0.55, col(0.92 * p.bright));
    sphere.addColorStop(1, `rgba(${Math.round(r * 0.45)},${Math.round(g * 0.45)},${Math.round(b * 0.5)},0.98)`);
    ctx.fillStyle = sphere;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();

    // rim
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,255,255,${0.18 * p.bright})`;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR - 0.5, 0, TAU);
    ctx.stroke();

    // --- listening ring (mic level)
    if (p.ring > 0.01) {
      const rr = 29.5 + inL * 9 + breathe * 0.5;
      ctx.lineWidth = 1.5 + inL * 1.5;
      ctx.strokeStyle = col((0.32 + inL * 0.55) * p.ring);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.stroke();
      // faint outer halo ring
      ctx.lineWidth = 1;
      ctx.strokeStyle = col(0.1 * p.ring);
      ctx.beginPath();
      ctx.arc(cx, cy, 37 + inL * 4, 0, TAU);
      ctx.stroke();
    }

    // --- connecting: rotating dashed ring
    if (p.dash > 0.01) {
      ctx.save();
      ctx.setLineDash([2.5, 5.5]);
      ctx.lineDashOffset = -t * 22;
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = col(0.7 * p.dash);
      ctx.beginPath();
      ctx.arc(cx, cy, 31, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // --- speaking: waveform ring driven by output level
    if (p.wave > 0.01) {
      this.wavePhase += (0.6 + outL * 2.4) * 0.05;
      const amp = 1.2 + outL * 8.5;
      const base = 30.5;
      const N = 96;
      ctx.beginPath();
      for (let i = 0; i <= N; i += 1) {
        const a = (i / N) * TAU;
        const w =
          0.55 * Math.sin(3 * a + this.wavePhase * 3.1) +
          0.3 * Math.sin(5 * a - this.wavePhase * 4.7) +
          0.15 * Math.sin(8 * a + this.wavePhase * 6.3);
        const rad = base + amp * w;
        const x = cx + Math.cos(a) * rad;
        const y = cy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = col((0.55 + outL * 0.4) * p.wave);
      ctx.stroke();
      ctx.lineWidth = 5;
      ctx.strokeStyle = col(0.08 * p.wave);
      ctx.stroke();
    }

    // --- thinking: orbiting particles with short trails
    if (p.part > 0.01) {
      for (const particle of PARTICLES) {
        const a = particle.angle + t * particle.speed;
        for (let k = 3; k >= 0; k -= 1) {
          const ta = a - k * 0.11 * Math.sign(particle.speed);
          const x = cx + Math.cos(ta) * particle.radius;
          const y = cy + Math.sin(ta) * particle.radius;
          ctx.fillStyle = col(p.part * (k === 0 ? 0.95 : 0.28 / k));
          ctx.beginPath();
          ctx.arc(x, y, particle.size * (k === 0 ? 1 : 0.7), 0, TAU);
          ctx.fill();
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = col(0.12 * p.part);
      ctx.beginPath();
      ctx.arc(cx, cy, 33, 0, TAU);
      ctx.stroke();
    }

    // --- acting: reticle
    if (p.ret > 0.01) {
      const rot = this.reduced ? 0 : t * 0.25;
      const R = 33 + Math.sin(t * 1.8) * 0.6;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = col(0.75 * p.ret);
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i += 1) {
        ctx.rotate(TAU / 4);
        ctx.beginPath();
        ctx.moveTo(0, -R - 3);
        ctx.lineTo(0, -R - 9);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -R + 3);
        ctx.lineTo(0, -R + 7);
        ctx.stroke();
      }
      ctx.restore();
      // corner brackets — "touching the screen"
      ctx.strokeStyle = col(0.35 * p.ret);
      ctx.lineWidth = 1;
      const s = 44;
      const l = 6;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * s, cy + sy * (s - l));
        ctx.lineTo(cx + sx * s, cy + sy * s);
        ctx.lineTo(cx + sx * (s - l), cy + sy * s);
        ctx.stroke();
      }
    }

    // --- error: single pulse then steady ring
    if (this.phase === "error" && this.errorPulseStart >= 0) {
      const age = (now - this.errorPulseStart) / 800;
      if (age < 1) {
        const e = easeOutCubic(age);
        ctx.lineWidth = 2.5 * (1 - e) + 0.5;
        ctx.strokeStyle = col(0.9 * (1 - e));
        ctx.beginPath();
        ctx.arc(cx, cy, coreR + 4 + e * 20, 0, TAU);
        ctx.stroke();
      }
    }
    if (p.ring > 0.01 && this.phase === "error") {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = col(0.55 * p.ring);
      ctx.beginPath();
      ctx.arc(cx, cy, 31, 0, TAU);
      ctx.stroke();
    }

    // --- muted: slash
    if (p.slash > 0.01) {
      const d = 14;
      ctx.lineCap = "round";
      ctx.lineWidth = 5;
      ctx.strokeStyle = `rgba(11,12,16,${0.75 * p.slash})`;
      ctx.beginPath();
      ctx.moveTo(cx - d, cy - d);
      ctx.lineTo(cx + d, cy + d);
      ctx.stroke();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = `rgba(232,234,240,${0.9 * p.slash})`;
      ctx.stroke();
      ctx.lineCap = "butt";
    }
  }
}
