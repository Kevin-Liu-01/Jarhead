"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { mountBlob, type BlobHandle } from "@/lib/blob";
import type { Phase } from "@/lib/phase";
import { useTheme } from "@/lib/theme";
import { useCalm } from "@/lib/motion";

/**
 * The resting stills (app/stills/*): the awake blob (`O O`), the happy one (`^ ^`), the quiet titanium one asleep (`- -`).
 * The query names the face's drawing: when the eyes change, it changes, so a returning visitor never sees a still cached
 * under the old face (the stills keep an hour's max-age).
 */
const FACE_V = "eyes-2";
const STILL: Record<"awake" | "happy" | "quiet", string> = {
  awake: `/stills/awake.png?v=${FACE_V}`,
  happy: `/stills/happy.png?v=${FACE_V}`,
  quiet: `/stills/quiet.png?v=${FACE_V}`,
};
/** How long a character may be away from the viewport before its engine is released (the still stands in). */
const RELEASE_MS = 4000;
function stillFor(phase: Phase): string {
  if (phase === "asleep" || phase === "muted" || phase === "paused") return STILL.quiet;
  if (phase === "speaking") return STILL.happy;
  return STILL.awake;
}

export interface CharacterHandle {
  nudge(): void;
  /** Turn to something it loves at a point on the screen (client px) and light up; null lets go (lib/blob.ts). */
  attend(at: readonly [number, number] | null): void;
  /** A happy squint (0.75 s unless told) and a hop. */
  cheer(seconds?: number): void;
  readonly el: HTMLElement | null;
}

interface CharacterProps {
  readonly phase: Phase;
  /** A face over the phase's own (`> <`), or null. */
  readonly face?: string | null;
  /** The host's side in CSS px (the disc is size / 1.4 across, the halo fills the rest); omit it to size the host in CSS. */
  readonly size?: number;
  /** Named for a screen reader; without it the blob is decoration and the words beside it carry the state. */
  readonly label?: string;
  /** A press (click, Enter, Space) on the blob. */
  readonly onPress?: () => void;
  /** `pointer`: a click alone, for a blob inside a heading whose keyboard twin is a button beside it. */
  readonly pressMode?: "button" | "pointer";
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Mount at 1.5 px cells regardless of a transform on the host (the hero mounts while it is a dot). */
  readonly ignoreScale?: boolean;
  /** A span host where only phrasing content may stand (inside the h1). */
  readonly inline?: boolean;
}

/**
 * The character: the real blob (lib/blob.ts), live, in any demo. Its still PNG (its phase's face) is the host's background,
 * so without JS and before the first frame the resting blob is there; the engine mounts within a viewport of the screen,
 * draws over the still, pauses off screen, on a hidden tab and after a quiet spell asleep, and is released after a while
 * away. Its eyes follow the pointer anywhere on the page. Under calm it draws one pose per change.
 */
export const Character = forwardRef<CharacterHandle, CharacterProps>(function Character({ phase, face = null, size, label, onPress, pressMode = "button", className, style, ignoreScale, inline }, ref): ReactElement {
  const host = useRef<HTMLElement>(null);
  const handle = useRef<BlobHandle | null>(null);
  const theme = useTheme();
  const calm = useCalm();
  const latest = useRef({ phase, face, theme });
  // What it attends to survives a remount (a resize, a return to the viewport).
  const attending = useRef<readonly [number, number] | null>(null);
  latest.current = { phase, face, theme };

  useImperativeHandle(ref, () => ({
    nudge: () => handle.current?.nudge(),
    attend: (at) => {
      attending.current = at;
      handle.current?.attend(at);
    },
    cheer: (seconds) => handle.current?.cheer(seconds),
    get el() {
      return host.current;
    },
  }));

  // The engine lives only near the viewport: it mounts when the host comes within a viewport of the screen and is
  // released after it has been away for a while, so the page's ten characters never all run at once and a fresh load
  // starts only the ones in view. Until it mounts (and without JS) the host shows its phase's still.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let h: BlobHandle | null = null;
    let away = 0;
    let lastW = el.clientWidth;
    const mount = () => {
      if (h) return;
      lastW = el.clientWidth;
      h = mountBlob(el, {
        size: el.clientWidth || size || 160,
        phase: latest.current.phase,
        theme: latest.current.theme,
        still: calm,
        pointerRoot: document.body,
        ignoreScale,
      });
      if (latest.current.face) h.setFace(latest.current.face);
      if (attending.current) h.attend(attending.current);
      handle.current = h;
    };
    const unmount = () => {
      h?.destroy();
      h = null;
      handle.current = null;
    };
    const io = new IntersectionObserver(
      ([en]) => {
        if (en?.isIntersecting) {
          window.clearTimeout(away);
          away = 0;
          mount();
        } else if (h && !away) {
          away = window.setTimeout(() => {
            away = 0;
            unmount();
          }, RELEASE_MS);
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    // The host is sized by CSS (it shrinks on the phone): a new width remounts the engine at the new size.
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (!h || !w || Math.abs(w - lastW) < 2) return;
      unmount();
      mount();
    });
    ro.observe(el);
    return () => {
      io.disconnect();
      ro.disconnect();
      window.clearTimeout(away);
      unmount();
    };
  }, [calm, size, ignoreScale]);

  useEffect(() => {
    handle.current?.setPhase(phase);
  }, [phase]);
  useEffect(() => {
    handle.current?.setFace(face);
  }, [face]);
  useEffect(() => {
    handle.current?.setTheme(theme);
  }, [theme]);

  const press = onPress && pressMode === "pointer"
    ? { onClick: onPress }
    : onPress
    ? {
        role: "button",
        tabIndex: 0,
        onClick: onPress,
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onPress();
        },
      }
    : {};
  const a11y = label ? { "aria-label": label, ...(onPress && pressMode === "button" ? {} : { role: "img" }) } : { "aria-hidden": true as const };
  const Tag = inline ? "span" : "div";
  return (
    <Tag
      ref={host as never}
      className={`char${onPress ? " char--press" : ""}${className ? ` ${className}` : ""}`}
      style={{ ...(size ? { width: size, height: size } : {}), "--still": `url(${stillFor(phase)})`, ...style } as CSSProperties}
      data-phase={phase}
      {...a11y}
      {...press}
    />
  );
});
