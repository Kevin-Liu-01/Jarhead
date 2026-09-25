"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { readTheme, subscribeTheme } from "@/lib/theme";

/**
 * One capture on its own baked ground: a figure holding the <img> on a box painted --jh-screen
 * (`ink` / `raised` for the captures baked on #070707 / #101010), a frame hairline, radius 6.
 * A crop is an aspect-ratio box with object-fit: cover and object-position; never a re-encoded file.
 */
export function Screen({
  src,
  alt,
  width,
  height,
  ground,
  aspect,
  position,
  maxWidth,
  sizes,
  priority,
  caption,
  className,
}: {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly ground?: "screen" | "ink" | "raised";
  readonly aspect?: string;
  readonly position?: string;
  readonly maxWidth?: number;
  readonly sizes?: string;
  readonly priority?: boolean;
  readonly caption?: ReactNode;
  readonly className?: string;
}) {
  const figStyle: CSSProperties | undefined = maxWidth ? { maxWidth } : undefined;
  const boxStyle: CSSProperties | undefined = aspect ? { aspectRatio: aspect } : undefined;
  const imgStyle: CSSProperties | undefined = position ? { objectPosition: position } : undefined;
  const cls = ["jh-screen", ground === "ink" ? "is-ink" : ground === "raised" ? "is-raised" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <figure className={cls} style={figStyle}>
      <div className={`jh-shot jh-screen-box${aspect ? " has-aspect" : ""}`} style={boxStyle}>
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          sizes={sizes}
          decoding="async"
          loading={priority ? undefined : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          style={imgStyle}
        />
      </div>
      {caption ? <figcaption className="jh-foot">{caption}</figcaption> : null}
    </figure>
  );
}

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

/**
 * A light/dark pair as one <picture> keyed on prefers-color-scheme, so only the matching file downloads.
 * On a stored override that disagrees with the system, the client rewrites the source's media to
 * `all` / `not all` after hydration, and only then does a second file download.
 */
export function ThemeImage({
  dark,
  light,
  width,
  height,
  sizes,
  priority,
  className,
}: {
  readonly dark: { readonly src: string; readonly alt: string };
  readonly light: { readonly src: string; readonly alt: string };
  readonly width: number;
  readonly height: number;
  readonly sizes?: string;
  readonly priority?: boolean;
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
  return (
    <picture className={className}>
      <source ref={sourceRef} media={SYSTEM_DARK} srcSet={dark.src} />
      <img
        ref={imgRef}
        src={light.src}
        alt={light.alt}
        width={width}
        height={height}
        sizes={sizes}
        decoding="async"
        loading={priority ? undefined : "lazy"}
        fetchPriority={priority ? "high" : undefined}
      />
    </picture>
  );
}
