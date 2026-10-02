"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { mountBlob, type BlobHandle } from "@/lib/blob";
import type { Phase } from "@/lib/phase";
import type { Theme } from "@/lib/theme";

interface BlobProps {
  readonly phase: Phase;
  readonly theme: Theme;
  readonly still: boolean;
  readonly label: string;
  readonly onAdvance: () => void;
}

/**
 * The live blob's host: a button named with the phase (a press or Enter steps the island to the next kind), the still PNG
 * as its background so no-JS and pre-paint show the resting orb, and `mountBlob` in an effect that returns `destroy`. The
 * pointer is watched over the whole page, so the eyes follow it from anywhere.
 */
export function Blob({ phase, theme, still, label, onAdvance }: BlobProps): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<BlobHandle | null>(null);
  const latest = useRef({ phase, theme, onAdvance });
  latest.current = { phase, theme, onAdvance };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stage = el.closest<HTMLElement>("[data-desk-stage]");
    let h: BlobHandle | null = null;
    const mount = () => {
      h = mountBlob(el, {
        size: el.clientWidth || 300,
        phase: latest.current.phase,
        theme: latest.current.theme,
        still,
        pointerRoot: stage,
        onPhaseAdvance: () => latest.current.onAdvance(),
      });
      handle.current = h;
    };
    mount();
    let lastW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (!w || Math.abs(w - lastW) < 2) return;
      lastW = w;
      h?.destroy();
      mount();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
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

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onAdvance();
  };
  return <div ref={host} className="desk-blob" role="button" tabIndex={0} aria-label={label} onKeyDown={onKey} />;
}
