"use client";

import { useEffect, useRef, type ReactElement } from "react";
import { mix3, parseColor, renderMeter, type RGB } from "@/lib/dither";
import { cssVar, subscribeTheme } from "@/lib/theme";

/** An rgba() token composited over the ground, so the meter's flat fills carry the token's alpha (fg2 = .72, active = .07 / .08). */
function over(token: string, ground: RGB): RGB {
  const raw = cssVar(token);
  const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/i.exec(raw);
  const a = m ? Number(m[1]) : 1;
  return mix3(ground, parseColor(raw), Number.isFinite(a) ? a : 1);
}

/**
 * The row meter's twin (ConsoleRow.swift:316-319; UI/Dither.swift:942-982): a 24 × 6 DitheredBar, the fill --jh-fg-2,
 * the track --jh-active, an 8-cell Bayer edge, four rows of 1.5 pt cells (here whole device pixels, lib/dither.ts).
 * The one shade the kit carries. Re-inks on a theme flip.
 */
export function Meter({ fraction, width = 24, height = 6, label, className }: { readonly fraction: number; readonly width?: number; readonly height?: number; readonly label?: string; readonly className?: string }): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const ground = parseColor(cssVar("--jh-ground"));
      renderMeter(c, { width, height, fraction, fill: over("--jh-fg-2", ground), track: over("--jh-active", ground) });
    };
    draw();
    return subscribeTheme(draw);
  }, [fraction, width, height]);
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return <canvas ref={ref} className={`kit-meter${className ? ` ${className}` : ""}`} width={1} height={1} style={{ width, height }} {...a11y} />;
}
