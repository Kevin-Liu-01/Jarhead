"use client";
import { useEffect, useState, type ReactElement } from "react";
import { Glyph } from "@/components/kit";
import { STARS_KEY, formatStars, refreshStars } from "@/lib/stars";

/**
 * The star glyph and the live count (ITERATE.md §2): the server's figure first, then one refresh from the same endpoint
 * on mount, cached per tab in sessionStorage; a failure leaves what was there, or the glyph alone.
 */
export function Stars({ initial }: { readonly initial: number | null }): ReactElement {
  const [n, setN] = useState<number | null>(initial);
  useEffect(() => {
    let live = true;
    try {
      const c = sessionStorage.getItem(STARS_KEY);
      if (c !== null) {
        const v = Number(c);
        if (Number.isFinite(v)) {
          setN(v);
          return;
        }
      }
    } catch {
      // Private mode: no cache, one fetch.
    }
    void refreshStars().then((v) => {
      if (!live || v === null) return;
      setN(v);
      try {
        sessionStorage.setItem(STARS_KEY, String(v));
      } catch {
        // as above
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <span className="stars">
      <Glyph name="star" size={14} label="stars" />
      {n !== null ? <span className="stars-n">{formatStars(n)}</span> : null}
    </span>
  );
}
