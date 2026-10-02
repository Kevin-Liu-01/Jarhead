"use client";
import { useEffect, useRef, type ReactElement } from "react";
import { parseColor } from "@/lib/dither";
import { renderToneField } from "@/lib/field";
import { cssVar, useTheme } from "@/lib/theme";

/**
 * A section's full-bleed ground (lib/field.ts): its tone dithered over the page ground, rising behind the picture. The tone
 * is a token; the peak, floor, radius, cell and bands are the section's CSS custom properties (styles/site.css sets them per
 * theme, so light is drawn as its own poster and dark keeps a whisper), read once per paint. `band` names an element inside
 * the section (the hero's calls) that a second, wide light pools behind, measured at paint. Painted lazily when the
 * section nears the viewport, again on a theme flip and across a 64 px resize boundary. Before the paint, and without JS,
 * the section shows the flat ground. Decorative.
 */
export function Field({ tone, ax, ay, band }: { readonly tone: `--jh-${string}`; readonly ax: number; readonly ay: number; readonly band?: string }): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  useEffect(() => {
    const cv = ref.current;
    const host = cv?.parentElement?.parentElement;
    if (!cv || !host) return;
    let painted = "";
    let near = false;
    const paint = () => {
      if (!near) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      const by = band ? host.querySelector<HTMLElement>(band) : null;
      const hr = host.getBoundingClientRect();
      const br = by?.getBoundingClientRect();
      const bandAt = br ? { x: br.left - hr.left + br.width / 2, y: br.top - hr.top + br.height / 2, rx: br.width * 0.85, ry: br.height * 1.9 } : null;
      const key = `${Math.ceil(w / 64)}x${Math.ceil(h / 64)}:${bandAt ? Math.round(bandAt.y / 8) : ""}:${document.documentElement.dataset["theme"] ?? ""}`;
      if (key === painted) return;
      painted = key;
      const cs = getComputedStyle(host);
      const num = (name: string, fallback: number) => {
        const v = Number.parseFloat(cs.getPropertyValue(name));
        return Number.isFinite(v) ? v : fallback;
      };
      renderToneField(cv, {
        width: w,
        height: h,
        cell: num("--field-cell", 3),
        ground: parseColor(cssVar("--jh-ground")),
        tone: parseColor(cssVar(tone)),
        peak: num("--field-peak", 0.2),
        floor: num("--field-floor", 0.12),
        ax,
        ay,
        r: num("--field-r", 0.7),
        bands: num("--field-bands", 4),
        band: bandAt ? { ...bandAt, strength: num("--field-band", 0.8) } : undefined,
      });
    };
    const io = new IntersectionObserver(
      ([en]) => {
        if (en?.isIntersecting && !near) {
          near = true;
          paint();
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(host);
    const ro = new ResizeObserver(() => paint());
    ro.observe(host);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [tone, ax, ay, band, theme]);
  return (
    <div className="field" aria-hidden="true">
      <canvas ref={ref} width={1} height={1} />
    </div>
  );
}
