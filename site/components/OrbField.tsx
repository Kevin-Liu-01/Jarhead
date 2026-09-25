"use client";
import { useEffect, useRef, type ReactElement } from "react";
import { INK_STOPS, PAPER_STOPS } from "@/lib/dither";
import { paintField, paintOrb } from "@/lib/orb";
import { useTheme } from "@/lib/theme";

/**
 * The footer band (design.md §2.12): the banner's recipe as a still. INK_STOPS dark / PAPER_STOPS
 * light on the diagonal, 4 px cells, 5 bands, and the orb (radius 120, centre x 230, `^ ^`, the
 * three-level glow onto the field) written into the same image. Threshold per cell, geometry per
 * pixel (the disc edge stays crisp). Re-rendered on a theme flip and on a resize across a 64 px
 * step; pinned bottom-right so the accent pooling stays in the corner.
 */
export function OrbField({ height = 360, className }: { height?: number; className?: string }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  useEffect(() => {
    const el = box.current;
    const canvas = cv.current;
    if (!el || !canvas) return;
    let lastW = 0;
    const paint = () => {
      const W = Math.ceil(el.clientWidth / 64) * 64;
      const H = el.clientHeight;
      if (!W || !H) return;
      lastW = W;
      const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
      const w = Math.round(W * dpr);
      const h = Math.round(H * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      const g = canvas.getContext("2d");
      if (!g) return;
      const img = g.createImageData(w, h);
      const cell = 4 * dpr;
      paintField(img, { cell, stops: theme === "dark" ? INK_STOPS : PAPER_STOPS, bands: 5 });
      const phone = el.clientWidth < 720;
      const R = (phone ? 72 : 120) * dpr;
      const cx = (phone ? 110 : 230) * dpr;
      paintOrb(img, { cx, cy: h / 2, R, cell, face: "^^", ground: "keep" });
      g.putImageData(img, 0, 0);
    };
    paint();
    const ro = new ResizeObserver(() => {
      if (Math.ceil(el.clientWidth / 64) * 64 !== lastW) paint();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [theme, height]);
  return (
    <div ref={box} className={`desk-orbfield${className ? ` ${className}` : ""}`} style={{ height }}>
      <canvas ref={cv} aria-hidden="true" />
    </div>
  );
}
