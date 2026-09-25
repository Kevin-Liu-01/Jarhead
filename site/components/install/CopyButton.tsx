"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icons";
import { PLATE_COPIED, PLATE_COPY } from "@/content/install";

/** The confirmed tile holds for one pulse (--jh-pulse, 1.6 s). */
const HOLD_MS = 1600;

export interface CopyButtonProps {
  readonly text: string;
  readonly size?: "md" | "sm";
  /** The accessible name. Defaults to `Copy: <text>` (the command rows); the plates pass their own. */
  readonly label?: string;
}

/** Clipboard API first; when it is absent or rejects, a hidden textarea and execCommand. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied, an insecure context, or a browser without the API: the textarea path below.
  }
  return copyThroughTextarea(text);
}

function copyThroughTextarea(text: string): boolean {
  const active = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.tabIndex = -1;
  ta.className = "ins-copy-ta";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (active instanceof HTMLElement) active.focus();
  return ok;
}

/** `done` is true for `ms` after each `arm()`; a repeat press restarts the hold. */
function useHeld(ms: number): readonly [boolean, () => void] {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const arm = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setDone(true);
    timer.current = window.setTimeout(() => {
      setDone(false);
      timer.current = null;
    }, ms);
  };
  return [done, arm] as const;
}

/**
 * A real button tile: --jh-lift plus a hairline, radius 6 (on a plate, --jh-plate-lift and the plate
 * hairline through CSS). Clipboard glyph + Copy; on success, check + Copied on the accent for 1.6 s,
 * and the polite live region announces it. Enter and Space work because it is a <button>.
 */
export function CopyButton({ text, size = "md", label }: CopyButtonProps) {
  const [done, arm] = useHeld(HOLD_MS);
  const Glyph = done ? Icon.check : Icon.clipboard;
  const onClick = () => {
    void copyText(text).then((ok) => {
      if (ok) arm();
    });
  };
  return (
    <button
      type="button"
      className={`ins-copy ins-copy--${size}${done ? " is-done" : ""}`}
      aria-label={label ?? `Copy: ${text}`}
      onClick={onClick}
    >
      <Glyph size={size === "sm" ? 13 : 14} />
      <span className="ins-copy-label">{done ? PLATE_COPIED : PLATE_COPY}</span>
      <span className="jh-sr" aria-live="polite">
        {done ? PLATE_COPIED : ""}
      </span>
    </button>
  );
}
