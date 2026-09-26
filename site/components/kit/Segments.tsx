"use client";

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

export interface SegmentOption {
  readonly id: string;
  readonly title: string;
  /** A leading emoji flag at sans 11: the Accent's, never a voice's (ConsoleSegments.swift:8-9; AGENTS.md:866). */
  readonly flag?: string;
  /** A face pair in mono 11 before the word (the hero's phase control, SPACE.md §4 row 3). */
  readonly face?: string;
  readonly glyph?: ReactNode;
}

export type SegmentsSize = "rail" | "row" | "toggle";

/**
 * ConsoleSegments' twin (ConsoleSegments.swift:4-9, 42-97, 116-181): a role="radiogroup" of pressed tiles, two to six
 * cells; rail 28 · row 26 · toggle 22; the box is the lift tile with one hairline (accent while a key holds focus), 1 px
 * dividers drawn once by the cell on the right; on = inverted (--jh-fg fill, ground letters) as a thumb that glides
 * between cells over --jh-quick (transform and width only); hover --jh-hover. Keys: ← → pick the neighbour (clamped),
 * Space the next (wrapping), Home / End the ends, Esc drops focus. Roving tabindex: the on cell is the one tab stop.
 * `fit` sizes each cell to its title (padding 10) instead of sharing the width.
 */
export function Segments({ value, options, onPick, size = "rail", ariaLabel, fit, className }: { readonly value: string; readonly options: readonly SegmentOption[]; readonly onPick: (id: string) => void; readonly size?: SegmentsSize; readonly ariaLabel: string; readonly fit?: boolean; readonly className?: string }): ReactElement {
  const group = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const [thumb, setThumb] = useState<CSSProperties | null>(null);

  const place = useCallback(() => {
    const cell = cells.current.get(value);
    const g = group.current;
    if (!cell || !g) return;
    // Measured as rects relative to the group and divided by the group's own scale, so the thumb lands under
    // CSS zoom or a transformed ancestor too (offsetLeft and a translate disagree there).
    const gr = g.getBoundingClientRect();
    const cr = cell.getBoundingClientRect();
    const scale = g.offsetWidth ? gr.width / g.offsetWidth : 1;
    const left = (cr.left - gr.left) / scale - g.clientLeft;
    const top = (cr.top - gr.top) / scale - g.clientTop;
    // The thumb takes the cell's own box, so a group that wraps to two rows (the phone's 2 × 3 grid) is served too.
    setThumb({ transform: `translate(${left}px, ${top}px)`, width: `${cr.width / scale}px`, height: `${cr.height / scale}px` });
  }, [value]);

  useLayoutEffect(() => {
    place();
    const g = group.current;
    if (!g || typeof ResizeObserver === "undefined") return;
    // The cells are observed too: a font swap, a late stylesheet or a zoom changes a cell before the group.
    const ro = new ResizeObserver(place);
    ro.observe(g);
    for (const c of cells.current.values()) ro.observe(c);
    if (typeof document !== "undefined" && document.fonts?.ready) document.fonts.ready.then(place, () => undefined);
    // Once more when the page has loaded: a stylesheet or a zoom that lands after hydration can size the cells
    // between the observer's reports (a cold dev load under zoom placed a shared-width thumb a few px narrow).
    const settled = document.readyState === "complete";
    if (!settled) window.addEventListener("load", place, { once: true });
    return () => {
      ro.disconnect();
      if (!settled) window.removeEventListener("load", place);
    };
  }, [place]);

  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    onPick(o.id);
    cells.current.get(o.id)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.id === value);
    const n = options.length;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        pick(Math.min(n - 1, i + 1));
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        pick(Math.max(0, i - 1));
        break;
      case " ":
        e.preventDefault();
        pick((i + 1) % n);
        break;
      case "Home":
        e.preventDefault();
        pick(0);
        break;
      case "End":
        e.preventDefault();
        pick(n - 1);
        break;
      case "Escape":
        (e.target as HTMLElement).blur();
        break;
      default:
    }
  };

  const cls = ["kit-segments", `kit-segments--${size}`, fit ? "kit-segments--fit" : "", thumb ? "has-thumb" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div ref={group} role="radiogroup" aria-label={ariaLabel} className={cls} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => {
              if (el) cells.current.set(o.id, el);
              else cells.current.delete(o.id);
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="kit-seg"
            onClick={() => onPick(o.id)}
          >
            {o.flag ? (
              <span className="kit-seg-flag" aria-hidden="true">
                {o.flag}
              </span>
            ) : null}
            {o.face ? (
              <span className="kit-seg-face" aria-hidden="true">
                {o.face}
              </span>
            ) : null}
            {o.glyph}
            <span>{o.title}</span>
          </button>
        );
      })}
      <span className="kit-seg-thumb" aria-hidden="true" style={thumb ?? undefined} />
    </div>
  );
}
