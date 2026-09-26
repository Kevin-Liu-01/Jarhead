"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Badge, type BadgeTone } from "./Badge";
import { KeyCap } from "./KeyCap";

export interface TipCard {
  readonly title: string;
  /** A status word beside the title (sans 11 --jh-fg-3), or a badge. */
  readonly status?: string;
  readonly badge?: { readonly word?: string; readonly figure?: string; readonly tone?: BadgeTone };
  /** Up to two lines of sans 12 --jh-fg-2. */
  readonly lines?: readonly string[];
  /** Foot rows: key (sans 11 titanium, a 64 column) · value (mono 11 --jh-fg-2). */
  readonly foot?: ReadonlyArray<readonly [string, string]>;
  /** The last line, sans 11 --jh-fg-3, with a keycap after it. */
  readonly last?: string;
  readonly key?: string;
}

export interface TipProps {
  /** Tier 1: one line, verb first, no full stop, ≤ 60 characters (HelpCopy.swift:9-11), and the shortcut last as a keycap. */
  readonly line?: string;
  readonly keyCap?: string;
  /** Tier 2: a row's whole story (ConsoleTip.swift:429-471). */
  readonly card?: TipCard;
  readonly side?: "below" | "above";
  /** Open on mount and stay: the gallery and the harness. */
  readonly pinned?: boolean;
  readonly children: ReactNode;
}

const DELAY = 350; // ConsoleTip.swift:49: the pointer rests
const WARM = 400; // ConsoleTip.swift:51: within this long of the last hide a tip shows at once
const GAP = 4; // ConsoleFloatPlacement.swift:9-17
const MARGIN = 8;
const CORNER = 10; // radius + 4: the arrow never nearer a corner

let lastHide = 0;
// The hide of the one tip that stands (ConsoleFloat.swift:228-232: only the innermost tip draws). A tip that opens
// calls it first, so a pointer-rest tip and a keyboard-focus tip never stand together.
let current: (() => void) | null = null;

interface Pos {
  readonly left: number;
  readonly top: number;
  readonly side: "below" | "above";
  readonly arrow: number;
}

/**
 * ConsoleTip's twin (ConsoleTip.swift:3-9, 49-64, 202-213, 294-351; ConsoleFloatPlacement.swift:9-71): an in-page tooltip
 * on hover and keyboard focus, never a system one. Shows after 350 ms (at once within 400 ms of the last hide; two frames
 * after a keyboard focus, once the scroll that focus causes has landed and its event has passed); hides on leave, blur,
 * any pointer-down, wheel, scroll or key, and when another tip opens (one stands at a time); `?` on the focused trigger
 * pins it and Esc lets go. Raised, one hairline, a 2 px seam of ground, no shadow; hangs under the anchor with leading edges aligned
 * and flips above when the space under it is short; clamped 8 px inside the viewport; the arrow points at the anchor's
 * centre and never nearer than 10 to a corner. The bubble is not hit-testable and a touch never opens it (R7: the facts
 * must also live on the page). role="tooltip", wired to the trigger through aria-describedby.
 */
export function Tip({ line, keyCap, card, side = "below", pinned, children }: TipProps): ReactElement {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(Boolean(pinned));
  const [held, setHeld] = useState(Boolean(pinned));
  const [pos, setPos] = useState<Pos | null>(null);
  const [inClass, setInClass] = useState(false);

  useEffect(() => setMounted(true), []);

  // The trigger is described by the bubble. Wired after mount: the trigger may arrive through the server boundary as a
  // lazy element, which cloneElement cannot annotate on the server, and the SSR markup must match the client's.
  useEffect(() => {
    const trigger = anchorRef.current?.firstElementChild;
    if (!trigger) return;
    trigger.setAttribute("aria-describedby", id);
    return () => trigger.removeAttribute("aria-describedby");
  }, [id]);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const hide = useCallback(() => {
    clear();
    if (current === hide) current = null;
    setOpen((was) => {
      if (was) lastHide = Date.now();
      return false;
    });
    setHeld(false);
    setInClass(false);
    setPos(null);
  }, []);
  // Opens this tip and takes the standing one down with it.
  const reveal = useCallback(() => {
    if (current !== null && current !== hide) current();
    current = hide;
    setOpen(true);
  }, [hide]);
  const show = useCallback((delay: number) => {
    clear();
    if (delay <= 0) {
      reveal();
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      reveal();
    }, delay);
  }, [reveal]);

  useEffect(() => () => {
    clear();
    if (current === hide) current = null;
  }, [hide]);

  // Placement: measured once when it opens (ConsoleFloatPlacement.swift:29-59), then the arrival on the next frame.
  useLayoutEffect(() => {
    if (!open) return;
    if (pinned) {
      const raf = requestAnimationFrame(() => setInClass(true));
      return () => cancelAnimationFrame(raf);
    }
    const anchor = anchorRef.current?.firstElementChild ?? anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let s = side;
    if (s === "below" && a.bottom + GAP + h > vh - MARGIN && a.top - GAP - h >= MARGIN) s = "above";
    if (s === "above" && a.top - GAP - h < MARGIN && a.bottom + GAP + h <= vh - MARGIN) s = "below";
    const top = s === "below" ? a.bottom + GAP : a.top - GAP - h;
    const left = Math.max(MARGIN, Math.min(a.left, vw - MARGIN - w));
    const arrow = Math.max(CORNER, Math.min(w - CORNER - 6, a.left + a.width / 2 - left - 3));
    setPos({ left, top, side: s, arrow });
    const raf = requestAnimationFrame(() => setInClass(true));
    return () => cancelAnimationFrame(raf);
  }, [open, side, mounted, pinned]);

  // While open: any mouse-down, wheel, scroll or key hides it; `?` pins; Esc unpins (ConsoleTip.swift:211-213, 294-323).
  useEffect(() => {
    if (!open) return;
    const down = () => {
      if (!pinned) hide();
    };
    const key = (e: KeyboardEvent) => {
      if (pinned) return;
      // a modifier alone is not a key-down to the app (flagsChanged): the Shift before a ? must not hide the tip
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta" || e.key === "CapsLock") return;
      if (e.key === "Escape") {
        hide();
        return;
      }
      if (e.key === "?" && anchorRef.current?.contains(document.activeElement)) {
        setHeld(true);
        return;
      }
      if (!held) hide();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("wheel", down, { capture: true, passive: true });
    document.addEventListener("scroll", down, { capture: true, passive: true });
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("wheel", down, true);
      document.removeEventListener("scroll", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, held, pinned, hide]);

  const onPointerEnter = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.pointerType === "touch" || pinned) return;
    show(Date.now() - lastHide < WARM ? 0 : DELAY);
  };
  const onPointerLeave = () => {
    if (pinned || held) return;
    hide();
  };
  const onFocus = (e: FocusEvent<HTMLSpanElement>) => {
    if (pinned) return;
    const t = e.target as HTMLElement;
    if (typeof t.matches !== "function" || !t.matches(":focus-visible")) return;
    // A keyboard focus scrolls its trigger into view. The scroll event lands on the next frame, after an open here would
    // have attached the listener above, and hid the tip for every row that was off-screen. So open two frames on: the
    // scroll has landed and its event has passed, and the anchor is measured where it now sits. A blur before then
    // cancels the frame through clear().
    clear();
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        reveal();
      });
    });
  };
  const onBlur = () => {
    if (pinned) return;
    hide();
  };

  const style: CSSProperties | undefined = pos ? ({ left: pos.left, top: pos.top, "--kit-arrow-x": `${pos.arrow}px` } as CSSProperties) : undefined;
  const body = card ? (
    <>
      <div className="kit-tip-title">
        <span>{card.title}</span>
        {card.badge ? <Badge word={card.badge.word} figure={card.badge.figure} tone={card.badge.tone} /> : card.status ? <span className="kit-tip-status">{card.status}</span> : null}
      </div>
      {card.lines && card.lines.length > 0 ? (
        <div className="kit-tip-lines">
          {card.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      ) : null}
      {card.foot && card.foot.length > 0 ? (
        <dl className="kit-tip-foot">
          {card.foot.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt className="kit-tip-k">{k}</dt>
              <dd className="kit-tip-v">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {card.last || card.key ? (
        <div className="kit-tip-last">
          {card.last ? <span>{card.last}</span> : null}
          {card.key ? <KeyCap>{card.key}</KeyCap> : null}
        </div>
      ) : null}
    </>
  ) : (
    <>
      <span>{line}</span>
      {keyCap ? <KeyCap>{keyCap}</KeyCap> : null}
    </>
  );

  const bubble = (
    <div ref={tipRef} id={id} role="tooltip" className={`kit-tip ${card ? "kit-tip--card" : "kit-tip--line"}${pinned ? " is-pinned" : ""}${inClass ? " is-in" : ""}`} data-side={pos?.side ?? side} style={style} hidden={!open}>
      {body}
    </div>
  );
  return (
    <>
      <span ref={anchorRef} className={`kit-tip-anchor${pinned ? " is-pinned" : ""}`} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onFocus={onFocus} onBlur={onBlur}>
        {children}
        {pinned ? bubble : null}
      </span>
      {!pinned && mounted ? createPortal(bubble, document.body) : null}
    </>
  );
}
