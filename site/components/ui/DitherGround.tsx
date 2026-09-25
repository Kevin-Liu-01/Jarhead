"use client";

import { useEffect, useRef } from "react";
import { BANDS, GROUND_BANDS, GROUND_STOPS, INK_STOPS, PAPER_STOPS, renderField, renderGround } from "@/lib/dither";
import { readTheme, subscribeTheme } from "@/lib/theme";

/**
 * The dithered ground behind a positioned parent. `ground`: GROUND_STOPS dark / PAPER_STOPS light,
 * 4 bands, 2 CSS px cells (or `cell`), theme-aware. `ink`: INK_STOPS, 5 bands, the banner's field,
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
      if (variant === "ink") renderField(canvas, { width: W, height: H, cell, stops: INK_STOPS, bands: BANDS });
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
