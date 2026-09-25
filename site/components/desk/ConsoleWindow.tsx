"use client";
import { useEffect, useRef, type ReactElement } from "react";
import { ThemeImage } from "@/components/ui/Screen";
import { parseColor, renderShadow } from "@/lib/dither";
import { cssVar, useTheme } from "@/lib/theme";

export const CONSOLE = { x: 40, y: 226, w: 708, h: 456, radius: 11, spread: 7, offset: 4 };

/**
 * The Console window (design.md §4.6): the capture's own chrome kept (the coloured traffic lights
 * are real), scale 0.6 of 1180 × 760, radius 11, a frame hairline, and under it a DitheredShadow
 * (Dither.swift:1048-1103): coverage grown 7 px, offset 4, 4 levels, 1.5 px cells, ink .55 dark / .25 light.
 * The fold rule of design.md §2.1: when the headline row grows past 152 px the Console shrinks first
 * (floor 0.56 of 1180 × 760), never the island: Desk sets --desk-console-k from the fold.
 */
export function ConsoleWindow(): ReactElement {
  const shadow = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  useEffect(() => {
    const cv = shadow.current;
    if (!cv) return;
    renderShadow(cv, {
      width: CONSOLE.w,
      height: CONSOLE.h,
      radius: CONSOLE.radius,
      spread: CONSOLE.spread,
      offset: CONSOLE.offset,
      levels: 4,
      cell: 1.5,
      color: parseColor(cssVar("--jh-ink")), // an empty var parses to ink
      alpha: theme === "dark" ? 0.55 : 0.25,
    });
  }, [theme]);
  return (
    <div className="desk-console-box">
      <canvas ref={shadow} className="desk-console-shadow" aria-hidden="true" />
      <div className="desk-console">
        <ThemeImage
          dark={{ src: "/media/console-threads.jpg", alt: "The Console: three threads, Slack asks before it sends" }}
          light={{ src: "/media/console-light.jpg", alt: "The Console in the light appearance" }}
          width={1600}
          height={1030}
          sizes="708px"
          priority
          phone="none" // .desk-console-box is display: none under 720 px (desk.css): fetch nothing there
        />
      </div>
    </div>
  );
}
