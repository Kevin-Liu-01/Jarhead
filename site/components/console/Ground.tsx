"use client";
import { useEffect, useRef, type ReactElement } from "react";
import { renderGround } from "@/lib/dither";
import { useTheme } from "@/lib/theme";

/**
 * The Console's ground behind the whole page (ConsoleTheme.swift:969-988; lib/dither.ts renderGround): GROUND_STOPS
 * dark, PAPER_STOPS light, four bands in 2 px cells, the size rounded up to 64 and pinned bottom-right so the accent
 * whisper stays in the corner. Fixed to the viewport: the window IS the page, so its ground never scrolls.
 */
export function Ground(): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let t = 0;
    const paint = () => renderGround(cv, { width: window.innerWidth, height: window.innerHeight, theme });
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(paint, 150);
    };
    paint();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, [theme]);
  return (
    <div className="cg" aria-hidden="true">
      <canvas ref={ref} width={1} height={1} />
    </div>
  );
}
