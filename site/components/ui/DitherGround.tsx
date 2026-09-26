"use client";

import { useEffect, useRef } from "react";
import { GROUND_BANDS, GROUND_STOPS, PAPER_STOPS, renderField, renderGround, type Stops } from "@/lib/dither";
import { readTheme, subscribeTheme } from "@/lib/theme";

/**
 * The ink plate's field: raised ink pooling to the app's ground whisper, 18 % into the accent, in the
 * lower-right corner only (Dither.swift:87-93; facts-canon.md §1 "an accent is a controlled edge, never a
 * wash"). The same in both themes: the plate is the one dark artifact surface.
 */
const PLATE_STOPS: Stops = [
  [0, [16, 16, 16]],
  [0.55, [16, 16, 16]],
  [1, [22, 30, 53]],
];

/**
 * The dithered ground behind a positioned parent. `ground`: GROUND_STOPS dark / PAPER_STOPS light,
 * 4 bands, 2 CSS px cells (or `cell`), theme-aware. `ink`: PLATE_STOPS, 4 bands, the ink plate's field,
 * the same in both themes. Rendered once per (size rounded up to 64, theme, cell), pinned
 * bottom-right so the accent whisper stays in the corner; re-renders on a theme flip and on a
 * resize across a 64 px boundary only (debounced 120 ms).
 */
export function DitherGround({ cell = 2, variant = "ground", className }: { readonly cell?: number; readonly variant?: "ground" | "ink"; readonly className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    let key = "";
    const paint = () => {
      const theme = readTheme();
      const W = Math.max(64, Math.ceil(host.clientWidth / 64) * 64);
      const H = Math.max(64, Math.ceil(host.clientHeight / 64) * 64);
      const next = `${W}x${H}:${variant === "ink" ? "ink" : theme}:${cell}`;
      if (next === key) return;
      key = next;
      if (variant === "ink") renderField(canvas, { width: W, height: H, cell, stops: PLATE_STOPS, bands: GROUND_BANDS });
      else if (cell === 2) renderGround(canvas, { width: W, height: H, theme });
      else renderField(canvas, { width: W, height: H, cell, stops: theme === "dark" ? GROUND_STOPS : PAPER_STOPS, bands: GROUND_BANDS });
    };
    paint();
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, 120);
    });
    ro.observe(host);
    const off = subscribeTheme(paint);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
      off();
    };
  }, [cell, variant]);
  return <canvas ref={ref} className={`jh-ground${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}
