"use client";

import { useEffect, useRef } from "react";
import { readTheme, subscribeTheme } from "@/lib/theme";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";
const PHONE = "(max-width: 719px)"; // the desk's phone stage (desk.css): the Console box is display: none there
const NO_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; // a 1 × 1 transparent GIF, no request

/**
 * A light/dark pair as one <picture> keyed on prefers-color-scheme, so only the matching file downloads.
 * On a stored override that disagrees with the system, the client rewrites the source's media to
 * `all` / `not all` after hydration, and only then does a second file download.
 * `phone="none"` when CSS hides the pair under 720 px: a phone-only empty candidate goes first, so the
 * preload scanner fetches neither file there (an eager, high-priority pair in a display: none box still loads).
 * That pair also keeps the light file in a <source> and the empty GIF as the <img>'s own src: Chrome loads an
 * <img src> synchronously, before the element is inside its <picture>, whenever that URL is already in its
 * memory cache (a lazy pair lower on the page reserves it), so a real src is fetched on a reload even when the
 * phone candidate wins.
 */
export function ThemeImage({
  dark,
  light,
  width,
  height,
  priority,
  phone,
  className,
}: {
  readonly dark: { readonly src: string; readonly alt: string };
  readonly light: { readonly src: string; readonly alt: string };
  readonly width: number;
  readonly height: number;
  readonly priority?: boolean;
  readonly phone?: "none";
  readonly className?: string;
}) {
  const sourceRef = useRef<HTMLSourceElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const source = sourceRef.current;
    const img = imgRef.current;
    if (!source || !img) return;
    const apply = () => {
      const theme = readTheme();
      const stored = document.documentElement.dataset["themeSource"] === "stored";
      const system = window.matchMedia(SYSTEM_DARK).matches ? "dark" : "light";
      const media = stored && theme !== system ? (theme === "dark" ? "all" : "not all") : SYSTEM_DARK;
      if (source.media !== media) source.media = media;
      img.alt = theme === "dark" ? dark.alt : light.alt;
    };
    apply();
    const off = subscribeTheme(apply);
    const mq = window.matchMedia(SYSTEM_DARK);
    mq.addEventListener("change", apply);
    return () => {
      off();
      mq.removeEventListener("change", apply);
    };
  }, [dark.alt, light.alt]);
  const hidden = phone === "none";
  return (
    <picture className={className}>
      {hidden ? <source media={PHONE} srcSet={NO_IMAGE} /> : null}
      <source ref={sourceRef} media={SYSTEM_DARK} srcSet={dark.src} />
      {hidden ? <source srcSet={light.src} /> : null}
      <img
        ref={imgRef}
        src={hidden ? NO_IMAGE : light.src}
        alt={light.alt}
        width={width}
        height={height}
        decoding="async"
        loading={priority ? undefined : "lazy"}
        fetchPriority={priority ? "high" : undefined}
      />
    </picture>
  );
}
