import { useCallback, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type Ref, type RefObject } from "react";
import { Icon } from "@/components/icons/Icon";
import { UI } from "@/content/deck";

/**
 * Focus that outlives the control it was on. In a press handler, `keep(to)` names where focus goes once React commits the
 * press: a control that stays, or the one that took the pressed one's place. It acts only while focus is inside the demo
 * (`root`), so a keyboard or screen-reader visitor never drops to <body> when a pressed control unmounts.
 */
export function useKeepFocus(root: RefObject<HTMLElement | null>): (to: () => HTMLElement | null | undefined) => void {
  const next = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const [n, setN] = useState(0);
  useLayoutEffect(() => {
    const to = next.current;
    next.current = null;
    to?.()?.focus({ preventScroll: true });
  }, [n]);
  return useCallback(
    (to: () => HTMLElement | null | undefined) => {
      if (!root.current?.contains(document.activeElement)) return;
      next.current = to;
      setN((k) => k + 1);
    },
    [root],
  );
}

/**
 * A line the visitor says: a button that speaks a deck line. The words are set in the voice (Newsreader Italic) inside a
 * <q>, after a small level trace that moves while the line is being said. `lead` is an unquoted deck word before it (Say).
 * Disabled, it stays focusable (aria-disabled) and ignores the press, so a chip that goes quiet under the keyboard keeps focus.
 */
export function Utter({ words, lead, onSay, saying, disabled, pressed, buttonRef, className }: { readonly words: string; readonly lead?: string; readonly onSay: () => void; readonly saying?: boolean; readonly disabled?: boolean; readonly pressed?: boolean; readonly buttonRef?: Ref<HTMLButtonElement>; readonly className?: string }): ReactElement {
  return (
    <button ref={buttonRef} type="button" className={`utter${saying ? " is-saying" : ""}${className ? ` ${className}` : ""}`} onClick={disabled ? undefined : onSay} aria-disabled={disabled || undefined} aria-pressed={pressed}>
      <span className="utter-wave" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      {lead ? <span className="utter-lead">{lead}</span> : null}
      <q className="utter-q">{words}</q>
    </button>
  );
}

/** Back to a demo's first frame. */
export function Replay({ onClick, className }: { readonly onClick: () => void; readonly className?: string }): ReactElement {
  return (
    <button type="button" className={`replay${className ? ` ${className}` : ""}`} onClick={onClick}>
      <Icon name="arrowCounterClockwise" size={16} />
      {UI.replay}
    </button>
  );
}

/** A state word under a character: what the blob is doing, in the quiet ink, crossfaded by its key. */
export function StateWord({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <span className="state-word" aria-live="polite">
      {children}
    </span>
  );
}
