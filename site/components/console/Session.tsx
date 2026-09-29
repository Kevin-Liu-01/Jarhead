"use client";
import { useEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { Glyph, Meter, Tip } from "@/components/kit";
import { over } from "@/components/kit/Meter";
import { HERO, PHASES } from "@/content/deck";
import { parseColor, renderMeter, type RGB } from "@/lib/dither";
import { shownKind, useLive } from "@/lib/live";
import { PHASE_META, type DeskKind } from "@/lib/phase";
import { cssVar, subscribeTheme } from "@/lib/theme";
import { part, parts } from "@/lib/cut";
import { Crossfade } from "./Crossfade";

const LIVE = new Set(["listening", "thinking", "acting", "speaking"]);
/** How far the session meter sits per kind: the cycle's progress, nothing while asleep. */
const FILL: Record<DeskKind, number> = { listening: 0.22, thinking: 0.4, acting: 0.62, speaking: 0.84, asleep: 0, alarm: 0 };
const RATE = part(HERO.figures, "$0.05 / min, per second");
const TOOLS = parts(HERO.figures).slice(5).join(" · "); // 71 tools · 6 brains + auto

/**
 * The right rail's phase card (RightRailView.swift; console-jarhead.jpg): the live dot, the phase word at 15 medium with
 * the phase hint as its tip (COPY.md: a hint is for a dot, a badge or a tooltip at most, never a line), then the session's
 * figures: the meter with the rate, the tools line. Reads the page's live phase.
 */
export function Session(): ReactElement {
  const live = useLive();
  const k = shownKind(live);
  const dot = { "--kit-phase": `var(${PHASE_META[k].token})` } as CSSProperties;
  return (
    <section className="rr-session">
      <div className="rr-phase">
        <span className={`kit-dot${LIVE.has(k) ? " is-live" : ""}`} style={dot} aria-hidden="true" />
        <Tip line={PHASES[k].hint}>
          <button type="button" className="rr-word-act">
            <Crossfade text={PHASES[k].word} className="rr-word" />
          </button>
        </Tip>
        <span className="rr-face kit-seg-face" aria-hidden="true">
          {PHASES[k].face}
        </span>
      </div>
      <div className="rr-kv">
        <Meter fraction={FILL[k]} width={96} height={6} />
        <span className="rr-mono">{RATE}</span>
      </div>
      <div className="rr-kv">
        <span className="kit-icon rr-kv-icon">
          <Glyph name="ask" size={14} />
        </span>
        <span className="rr-mono">{TOOLS}</span>
      </div>
    </section>
  );
}

/**
 * The Audio rows (RightRailView.swift; the two dithered meters in every Console shot): the mic's level while listening,
 * the speaker's while speaking, ticking at 8 fps with a mono readout. Drawn straight onto the canvases so nothing
 * re-renders. Still under reduced motion.
 */
export function AudioRows(): ReactElement {
  const mic = useRef<HTMLCanvasElement>(null);
  const spk = useRef<HTMLCanvasElement>(null);
  const micV = useRef<HTMLSpanElement>(null);
  const spkV = useRef<HTMLSpanElement>(null);
  const live = useLive();
  const kind = useRef<DeskKind>("listening");
  kind.current = shownKind(live);
  useEffect(() => {
    let raf = 0;
    let at = 0;
    const inkOf = (): { fill: RGB; track: RGB } => {
      const ground = parseColor(cssVar("--jh-ground"));
      return { fill: over("--jh-fg-2", ground), track: over("--jh-active", ground) };
    };
    let ink = inkOf();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - at < 125) return;
      at = now;
      const t = now / 1000;
      const k = kind.current;
      const m = Math.max(0, k === "listening" ? 0.18 + 0.14 * Math.sin(t * 5.3) + 0.08 * Math.sin(t * 11.1) : k === "asleep" || k === "alarm" ? 0 : 0.04);
      const s = Math.max(0, k === "speaking" ? 0.26 + 0.18 * Math.sin(t * 6.7) + 0.1 * Math.sin(t * 13.3) : 0);
      if (mic.current) renderMeter(mic.current, { width: 160, height: 6, fraction: m, fill: ink.fill, track: ink.track });
      if (spk.current) renderMeter(spk.current, { width: 160, height: 6, fraction: s, fill: ink.fill, track: ink.track });
      if (micV.current) micV.current.textContent = m.toFixed(2);
      if (spkV.current) spkV.current.textContent = s.toFixed(2);
    };
    if (live.still) {
      draw(1000);
      cancelAnimationFrame(raf);
      raf = 0;
    } else raf = requestAnimationFrame(draw);
    const off = subscribeTheme(() => {
      ink = inkOf();
      at = 0;
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      off();
    };
  }, [live.still]);
  return (
    <ul role="list" className="rr-audio">
      <li className="rr-meter-row">
        <span className="kit-icon">
          <Glyph name="mic" size={16} />
        </span>
        <canvas ref={mic} className="kit-meter" width={1} height={1} style={{ width: 160, height: 6 }} aria-hidden="true" />
        <span ref={micV} className="rr-mono rr-level">
          0.00
        </span>
      </li>
      <li className="rr-meter-row">
        <span className="kit-icon">
          <Glyph name="voice" size={16} />
        </span>
        <canvas ref={spk} className="kit-meter" width={1} height={1} style={{ width: 160, height: 6 }} aria-hidden="true" />
        <span ref={spkV} className="rr-mono rr-level">
          0.00
        </span>
      </li>
    </ul>
  );
}
