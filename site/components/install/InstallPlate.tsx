"use client";

import { useEffect, useRef, type RefObject } from "react";
import { INK_STOPS, renderField } from "@/lib/dither";
import {
  INSTALL_HOST_PATH,
  INSTALL_URL,
  ONE_LINER,
  PLATE_COPY_LABEL,
  PLATE_EYEBROW,
  PLATE_LINE_RAIL,
  PLATE_NOTE_DESK,
} from "@/content/install";
import { CopyButton } from "./CopyButton";

export { ONE_LINER };

/** The banner's recipe (facts-canon.md §7): INK_STOPS, 5 bands, 4 CSS px cells. */
const CELL = 4;
const BANDS = 5;
/** The render size rounds up to this step and the canvas pins bottom-right, so a resize re-renders only across a boundary and the accent stays in the corner. */
const STEP = 64;
const DEBOUNCE_MS = 120;

/** Paints the ink field once per rounded size of the host. The plate is the one dark surface in both themes, so no theme re-render. */
function useInkField(host: RefObject<HTMLDivElement | null>, canvas: RefObject<HTMLCanvasElement | null>): void {
  useEffect(() => {
    const el = host.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let w = 0;
    let h = 0;
    let timer: number | null = null;
    const paint = () => {
      const width = Math.max(STEP, Math.ceil(el.clientWidth / STEP) * STEP);
      const height = Math.max(STEP, Math.ceil(el.clientHeight / STEP) * STEP);
      if (width === w && height === h) return;
      w = width;
      h = height;
      renderField(cv, { width, height, cell: CELL, stops: INK_STOPS, bands: BANDS });
    };
    paint();
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(paint, DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [host, canvas]);
}

export interface InstallPlateProps {
  /** desk: 315 px wide, ≤ 160 tall, the one-line note; rail: full width, the "what it does" line with the raw URL. */
  readonly variant: "desk" | "rail";
  readonly className?: string;
}

/** Strips a trailing `tail` from `text` so the tail can render as the link while the deck string stays whole. */
function beforeTail(text: string, tail: string): string {
  return text.endsWith(tail) ? text.slice(0, -tail.length) : text;
}

export function InstallPlate({ variant, className }: InstallPlateProps) {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  useInkField(host, field);
  const note =
    variant === "desk" ? (
      <>
        {beforeTail(PLATE_NOTE_DESK, INSTALL_HOST_PATH)}
        <a href={INSTALL_URL}>{INSTALL_HOST_PATH}</a>
      </>
    ) : (
      <>
        {beforeTail(PLATE_LINE_RAIL, INSTALL_URL)}
        <a href={INSTALL_URL}>{INSTALL_URL}</a>
      </>
    );
  return (
    <div ref={host} className={`ins-plate ins-plate--${variant}${className ? ` ${className}` : ""}`}>
      <canvas ref={field} className="ins-plate-field" aria-hidden="true" />
      <span className="ins-plate-eyebrow">{PLATE_EYEBROW}</span>
      <div className="ins-plate-copy">
        <CopyButton text={ONE_LINER} label={PLATE_COPY_LABEL} />
      </div>
      <code className="ins-plate-code">{ONE_LINER}</code>
      <p className="ins-plate-note">{note}</p>
    </div>
  );
}
