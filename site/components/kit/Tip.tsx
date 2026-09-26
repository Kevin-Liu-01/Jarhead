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
  /**
   * A touch tap on the trigger opens the tip and holds it until the next tap anywhere, a scroll or Esc. Only for a trigger
   * whose one job is the tip (a row's cover, a display figure); never a control that acts, whose tap must stay its own.
   */
  readonly tap?: boolean;
  readonly children: ReactNode;
}

const DELAY = 350; // ConsoleTip.swift:49: the pointer rests
const WARM = 400; // ConsoleTip.swift:51: within this long of the last hide a tip shows at once
const SETTLE = 150; // the scroll a keyboard focus causes has come to rest when no scroll event follows for this long
const GAP = 4; // ConsoleFloatPlacement.swift:9-17
const MARGIN = 8;
const CORNER = 10; // radius + 4: the arrow never nearer a corner

let lastHide = 0;

// Where the pointer last was on the page. A hover needs real motion: when the page scrolls under a resting pointer the
// browser re-dispatches pointer events to whatever landed beneath it, and those carry the same place.
let pointerX = Number.NaN;
let pointerY = Number.NaN;
let pointerMoved = false;
let watchers = 0;
const track = (e: globalThis.PointerEvent) => {
  pointerMoved = e.clientX !== pointerX || e.clientY !== pointerY;
  pointerX = e.clientX;
  pointerY = e.clientY;
};

interface Pos {
  readonly left: number;
  readonly top: number;
  readonly side: "below" | "above";
  readonly arrow: number;
}

/**
 * ConsoleTip's twin (ConsoleTip.swift:3-9, 49-64, 202-213, 294-351; ConsoleFloatPlacement.swift:9-71): an in-page tooltip
 * on hover and keyboard focus, never a system one. Shows after 350 ms of real pointer motion over the trigger (at once
 * within 400 ms of the last hide; at once on a keyboard focus); hides on leave, blur, any pointer-down, wheel, scroll or
 * key; `?` on the focused trigger pins it and Esc lets go. The scroll a keyboard focus itself causes, bringing its
 * trigger into view, is not a hand on the page: the tip waits for it to settle and is measured again where the trigger
 * came to rest. Raised, one hairline, a 2 px seam of ground, no shadow; hangs under the anchor with leading edges aligned
 * and flips above when the space under it is short; clamped 8 px inside the viewport; the arrow points at the anchor's
 * centre and never nearer than 10 to a corner. The bubble is not hit-testable. A touch never hovers: with `tap` a
 * completed tap on the trigger (the pointer up, not the pointer down a scroll begins with) opens the tip and holds it
 * until the next tap anywhere, a scroll or Esc, so a row's story is reachable on a phone; without `tap` a touch opens
 * nothing (R7: the facts must also live on the page). role="tooltip", wired to the trigger through aria-describedby.
 */
export function Tip({ line, keyCap, card, side = "below", pinned, tap, children }: TipProps): ReactElement {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const settling = useRef(false);
  const settleTimer = useRef<number | null>(null);
  // A touch tap (`tap`): a touch pointer went down on the trigger, and whether it landed while the tip was already open.
  const tapping = useRef(false);
  const tappedOpen = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(Boolean(pinned));
  const [held, setHeld] = useState(Boolean(pinned));
  const [pos, setPos] = useState<Pos | null>(null);
  const [inClass, setInClass] = useState(false);

  useEffect(() => setMounted(true), []);

  // One listener for every tip on the page keeps the pointer's place (see `track`).
  useEffect(() => {
    if (watchers++ === 0) document.addEventListener("pointermove", track, { capture: true, passive: true });
    return () => {
      if (--watchers === 0) document.removeEventListener("pointermove", track, true);
    };
  }, []);

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
  };
  const settled = () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
    settling.current = false;
  };
  const hide = useCallback(() => {
    clear();
    settled();
    setOpen((was) => {
      if (was) lastHide = Date.now();
      return false;
    });
    setHeld(false);
    setInClass(false);
    setPos(null);
  }, []);
  const show = useCallback((delay: number) => {
    clear();
    if (delay <= 0) {
      setOpen(true);
      return;
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, delay);
  }, []);

  useEffect(
    () => () => {
      clear();
      settled();
    },
    [],
  );

  // Placement (ConsoleFloatPlacement.swift:29-59): under the anchor, flipped above when short of room, clamped inside.
  const place = useCallback(() => {
    const anchor = anchorRef.current?.firstElementChild ?? anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip || tip.hidden) return;
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
  }, [side]);

  // The focus's own scroll settles when no scroll event follows for SETTLE; then the tip is measured where it rests.
  const rest = useCallback(() => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      settling.current = false;
      place();
    }, SETTLE);
  }, [place]);

  // Measured once when it opens, then the arrival on the next frame.
  useLayoutEffect(() => {
    if (!open) return;
    if (!pinned) place();
    const raf = requestAnimationFrame(() => setInClass(true));
    return () => cancelAnimationFrame(raf);
  }, [open, mounted, pinned, place]);

  // While open: any mouse-down, wheel, scroll or key hides it; `?` pins; Esc unpins (ConsoleTip.swift:211-213, 294-323).
  // A scroll while the focus's own scroll settles only re-arms the wait. A touch that lands on the tip's own trigger is
  // remembered here, before any of the trigger's handlers run, so the tap that follows lets go instead of reopening.
  useEffect(() => {
    if (!open) return;
    const down = (e?: Event) => {
      if (pinned) return;
      if (tap && e instanceof PointerEvent && e.pointerType === "touch" && anchorRef.current?.contains(e.target as Node)) tappedOpen.current = true;
      hide();
    };
    const scrolled = () => {
      if (settling.current) rest();
      else down();
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
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("wheel", down, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, held, pinned, tap, hide, rest]);

  // A hover is the pointer moving over the trigger: a boundary event alone (the page scrolled under a resting pointer)
  // is none, and neither is a move that did not move it.
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (e.pointerType === "touch" || pinned || open || timer.current !== null || !pointerMoved) return;
    show(Date.now() - lastHide < WARM ? 0 : DELAY);
  };
  // The leave a touch ends with is not a hover leaving: a held touch tip is let go by the next pointer down, a scroll or Esc.
  const onPointerLeave = (e: PointerEvent<HTMLSpanElement>) => {
    if (pinned || held || e.pointerType === "touch") return;
    hide();
  };
  const onFocus = (e: FocusEvent<HTMLSpanElement>) => {
    if (pinned) return;
    const t = e.target as HTMLElement;
    if (typeof t.matches !== "function" || !t.matches(":focus-visible")) return;
    // The browser may scroll the trigger into view for this focus: that scroll arrives after the first frame and, when it
    // is smooth, keeps coming; wait it out, then measure again.
    settling.current = true;
    show(0);
    requestAnimationFrame(() => {
      if (settling.current) rest();
    });
  };
  const onBlur = () => {
    if (pinned) return;
    hide();
  };
  // A touch tap (`tap`) opens on the pointer up: a scroll begins with a pointer down too and ends in a pointer cancel,
  // never a pointer up, so a finger that scrolls over a row opens nothing. Held, so the pointer leave a touch ends with
  // and the keys leave it; the next pointer down anywhere, a scroll or Esc lets go (the document listeners above).
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (!tap || pinned || e.pointerType !== "touch") return;
    tapping.current = true;
  };
  const onPointerUp = (e: PointerEvent<HTMLSpanElement>) => {
    const began = tapping.current;
    const wasOpen = tappedOpen.current;
    tapping.current = false;
    tappedOpen.current = false;
    if (!began || wasOpen || e.pointerType !== "touch") return;
    show(0);
    setHeld(true);
  };
  const onPointerCancel = () => {
    tapping.current = false;
    tappedOpen.current = false;
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
      <span
        ref={anchorRef}
        className={`kit-tip-anchor${pinned ? " is-pinned" : ""}`}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
        {pinned ? bubble : null}
      </span>
      {!pinned && mounted ? createPortal(bubble, document.body) : null}
    </>
  );
}
