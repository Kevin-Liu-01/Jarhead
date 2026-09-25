"use client";
import { useEffect, useRef, type ReactElement } from "react";
import { mountBlob, type BlobFrame, type BlobHandle } from "@/lib/blob";
import type { Phase } from "@/lib/phase";
import type { Theme } from "@/lib/theme";

export interface BlobProps {
  phase: Phase;
  theme: Theme;
  hidden: boolean;
  still: boolean;
  label: string;
  onAdvance?: () => void;
  onFrame?: (f: BlobFrame) => void;
}

/**
 * The live blob's host: `role="img"` with the phase in its label, the still PNG as its background so
 * no-JS and pre-paint show the resting orb, and `mountBlob` in an effect that returns `destroy`.
 * The flight into the notch is measured from the DOM (the host's rest to the notch's lip).
 */
export function Blob({ phase, theme, hidden, still, label, onAdvance, onFrame }: BlobProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<BlobHandle | null>(null);
  const latest = useRef({ phase, theme, hidden, onAdvance, onFrame });
  latest.current = { phase, theme, hidden, onAdvance, onFrame };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = el.closest<HTMLElement>("[data-desk-stage]");
    const notch = stage?.querySelector<HTMLElement>(".desk-notch") ?? null;
    let h: BlobHandle | null = null;
    let ro: ResizeObserver | null = null;
    const mount = () => {
      el.style.transform = "";
      el.style.opacity = "";
      el.style.transition = "none";
      const size = el.clientWidth || 300;
      const r1 = el.getBoundingClientRect();
      const scale = r1.width / size || 1;
      let flight = { x: 0, y: -Math.round(size * 1.4) };
      if (notch) {
        const r2 = notch.getBoundingClientRect();
        flight = { x: (r2.left + r2.width / 2 - (r1.left + r1.width / 2)) / scale, y: (r2.bottom + 6 - (r1.top + r1.height / 2)) / scale };
      }
      h = mountBlob(el, {
        size,
        phase: latest.current.phase,
        theme: latest.current.theme,
        still,
        flight,
        pointerRoot: stage,
        onPhaseAdvance: () => latest.current.onAdvance?.(),
      });
      h.onFrame((f) => latest.current.onFrame?.(f));
      if (latest.current.hidden) h.hide();
      handle.current = h;
      if (process.env.NODE_ENV !== "production") (window as unknown as { __jhBlob?: BlobHandle }).__jhBlob = h; // frameStats() for the notes
    };
    mount();
    let lastW = el.clientWidth;
    ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (!w || Math.abs(w - lastW) < 2) return;
      lastW = w;
      h?.destroy();
      mount();
    });
    ro.observe(el);
    return () => {
      ro?.disconnect();
      h?.destroy();
      handle.current = null;
    };
  }, [still]);

  useEffect(() => {
    handle.current?.setPhase(phase);
  }, [phase]);
  useEffect(() => {
    handle.current?.setTheme(theme);
  }, [theme]);
  useEffect(() => {
    if (hidden) handle.current?.hide();
    else handle.current?.show();
  }, [hidden]);

  return <div ref={host} className="desk-blob" role="img" aria-label={label} />;
}
