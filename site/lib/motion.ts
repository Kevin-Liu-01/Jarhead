/**
 * The motion language, one set of tokens (app/globals.css mirrors the durations and eases as --jh-*): durations 80 to 600
 * ms, one ease out for arrivals, one ease in-out for state changes, three springs (the interface's, the character's and the
 * hand's), staggers of at most three elements 60 ms apart (the sections' rise, styles/site.css). `useCalm` is the one
 * switch to calm cuts: reduced motion or `#still` turns every transition into an instant change (`cut`). A namespace
 * import of React, so the server layout can read ARRIVE_BOOT from here without pulling a hook into a server module.
 */
import * as React from "react";
import { isStill } from "@/lib/theme";

const DUR = { instant: 0.08, quick: 0.16, base: 0.24, slow: 0.4, drift: 0.6 } as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;
/** The interface's spring: a chip settling into a bin, a card arriving. */
export const SPRING = { type: "spring", visualDuration: 0.36, bounce: 0.14 } as const;
/** The character's spring: the blob's own moves, with a little more give. */
export const SPRING_CHAR = { type: "spring", visualDuration: 0.52, bounce: 0.34 } as const;
/**
 * The hand's spring: the hero's blob held trails the hand by about 56 ms of its speed and rings at about 2.4 Hz when it
 * stops (the damped ring of the app's drag spring, 300 / 17, BlobPhysics.swift). The one exception to "direct
 * manipulation never springs".
 */
export const SPRING_DRAG = { type: "spring", visualDuration: 0.3, bounce: 0.51 } as const;

/**
 * A spring token as stiffness and damping (unit mass), for a body stepped by hand (lib/body.ts): motion-dom 14's own
 * conversion (getSpringOptions, bounce at or over 0), so the body rings as Motion would animate it.
 */
export function springKC(sp: { readonly visualDuration: number; readonly bounce: number }): { k: number; c: number } {
  const root = (2 * Math.PI) / (1.2 * sp.visualDuration);
  const k = root * root;
  const zeta = Math.max(0.05, 1 - sp.bounce);
  return { k, c: 2 * zeta * Math.sqrt(k) };
}

/** An instant change: what every transition becomes when the visitor asked for calm. */
export const CUT = { duration: 0 } as const;

/** A tween on the tokens: `ease("slow")`, `ease("base", "inout")`. */
export function ease(d: keyof typeof DUR, curve: "out" | "inout" = "out") {
  return { duration: DUR[d], ease: curve === "out" ? EASE_OUT : EASE_IN_OUT } as const;
}

/**
 * Before paint: `#still` stamps `html[data-still]`, so every CSS loop and transition is a calm cut, as under reduced motion
 * (app/globals.css), kept in step with the hash afterwards. The hero's blob arrives (a dot that grows) only when motion is
 * allowed; that attribute hides the resting blob until the hero takes over, and a CSS failsafe shows it after 3 s if the
 * script never runs (styles/site.css).
 */
export const ARRIVE_BOOT = `(function(){try{var d=document.documentElement;function s(){if(location.hash==="#still")d.dataset.still="";else delete d.dataset.still}s();addEventListener("hashchange",s);if(location.hash!=="#still"&&!matchMedia("(prefers-reduced-motion: reduce)").matches&&scrollY<200)d.dataset.arrive=""}catch(e){}})();`;

function subscribeCalm(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  window.addEventListener("hashchange", cb);
  return () => {
    mq.removeEventListener("change", cb);
    window.removeEventListener("hashchange", cb);
  };
}

/** True under reduced motion or `#still`: every transition a cut, every loop one pose. False on the server. */
export function useCalm(): boolean {
  return React.useSyncExternalStore(subscribeCalm, isStill, () => false);
}

/**
 * A demo's clock: `at(ms, fn)` schedules a step, `clear()` drops every pending one (a replay, an unmount). Steps keep
 * their spacing under calm, so a sequence still reads in order; only the motion between steps becomes a cut.
 */
export function useSteps(): { readonly at: (ms: number, fn: () => void) => void; readonly clear: () => void } {
  const timers = React.useRef<number[]>([]);
  const clear = React.useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);
  const at = React.useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  React.useEffect(() => clear, [clear]);
  return React.useMemo(() => ({ at, clear }), [at, clear]);
}

/**
 * Whether an element is on screen (`amount` of it), live. Loops and races start and pause on it, and a demo that is not in
 * view when the page loads swaps its explanatory still for its first frame.
 */
export function useInView<T extends Element>(ref: React.RefObject<T | null>, amount = 0.35): boolean {
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([en]) => setInView(!!en?.isIntersecting), { threshold: amount });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, amount]);
  return inView;
}

/** On mount, whether the element is already on screen (a deep link, a reload mid-page): the still stays, else the demo resets. */
export function onScreenNow(el: Element | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

/**
 * Once, when the element first comes into view (a third of it on screen), `play` runs: a demo plays its own route and
 * rests on the frame it resolves to, which is also its still. Calm never plays it: the still stays.
 */
export function useFirstView<T extends Element>(ref: React.RefObject<T | null>, play: () => void, calm: boolean, amount = 0.35): void {
  const fired = React.useRef(false);
  const latest = React.useRef(play);
  latest.current = play;
  React.useEffect(() => {
    const el = ref.current;
    if (calm || fired.current || !el) return;
    const io = new IntersectionObserver(
      ([en]) => {
        if (!en?.isIntersecting || fired.current || isStill()) return;
        fired.current = true;
        io.disconnect();
        latest.current();
      },
      { threshold: amount },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, calm, amount]);
}
