"use client";

import { useEffect, useRef, useState } from "react";
import { Button, type ButtonKind, type ButtonSize } from "@/components/kit";
import { PLATE_COPIED, PLATE_COPY } from "@/content/install";

/** The confirmed word holds for one pulse (--jh-pulse, 1.6 s). */
const HOLD_MS = 1600;

export interface CopyButtonProps {
  readonly text: string;
  /** primary on the one-liner strip, ghost in a command row. */
  readonly kind?: ButtonKind;
  readonly size?: ButtonSize;
  /** The accessible name. Defaults to `Copy: <text>` (the command rows); the strip passes its own. */
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
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";
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
 * The kit's natural spent (facts-kit.md §1.3): Copy (primary or ghost) → Copied (spent, its deed done) for 1.6 s,
 * one width through the change, the polite live region announcing it. The glyph swaps copy → checkmark.
 */
export function CopyButton({ text, kind = "primary", size = 32, label }: CopyButtonProps) {
  const [done, arm] = useHeld(HOLD_MS);
  const onClick = () => {
    void copyText(text).then((ok) => {
      if (ok) arm();
    });
  };
  return (
    <Button kind={done ? "spent" : kind} size={size} glyph={done ? "checkmark" : "copy"} hold={done ? PLATE_COPY : PLATE_COPIED} ariaLabel={label ?? `Copy: ${text}`} onClick={onClick}>
      {done ? PLATE_COPIED : PLATE_COPY}
    </Button>
  );
}
