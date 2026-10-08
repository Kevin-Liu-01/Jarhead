import { animate } from "motion/react";
import type { CharacterHandle } from "@/components/desk/Character";
import { createBody, distToBox, type Body, type Contact, type World } from "@/lib/body";
import { CUT, SPRING_CHAR, SPRING_DRAG, ease, springKC } from "@/lib/motion";
import type { DeskKind } from "@/lib/phase";

/**
 * The hero's blob in the hand: a DOM controller, no React (HeroCharacter starts it once the arrival has ended). Press its
 * disc and carry it, fling it round the hero, stick it to an edge, or drop it (or toss it gently) into the island to put
 * it to bed; it watches you from wherever it lands and flies home to its stop after HOME_AFTER. The body is lib/body.ts
 * (the app's BlobBody), the jelly lib/blob.ts in play (`setMotion`), every number scaled by s = R / 59.
 *
 * States, on `.hero-body[data-play]` (written only when it changes): home (at the stop, no loop), held (a hand past the
 * slop), free (flying, or a stuck dome still settling), perched (at rest away from home), homing (on its way home, or the
 * tap's hop), tucked (the island's sequence); absent, not grabbable. The rAF loop runs only while held, free or homing;
 * at home nothing new runs: no loop, no window listeners, the wrapper untransformed.
 *
 * Calm (reduced motion or `#still`): plain direct manipulation, carried 1:1 and cut home on release; the island's catch
 * zone still claims asleep; a tap only steps the kind.
 */
export interface HeroPlayDeps {
  /** `.hero-body`: the wrapper play translates (the arrival owns the host inside it). */
  readonly wrap: HTMLElement;
  /** `.hero-grab`: the disc, the only target. */
  readonly grab: HTMLElement;
  readonly host: () => HTMLElement | null;
  readonly ch: () => CharacterHandle | null;
  readonly calm: boolean;
  stepHero(): void;
  setHero(k: DeskKind): void;
  kind(): DeskKind;
  /** Whether the blob may turn to the glass Install: true entering home or perched, false leaving them. */
  onAttend(allowed: boolean): void;
}

export interface HeroPlay {
  /** A tap, or HeroPoke: the step, the poke's face and a hop. */
  poke(): void;
  /** At home or perched (or calm), the blob may turn to the glass Install. */
  canAttend(): boolean;
  destroy(): void;
}

type PlayState = "home" | "held" | "free" | "perched" | "homing" | "tucked";

/** Slop before a press moves anything (px): mouse and pen, touch. */
const SLOP_MOUSE = 4;
const SLOP_TOUCH = 8;
/** An up within this long that never passed the slop is a tap; a longer still press does nothing. */
const TAP_MS = 600;
/** At rest away from home this long, it flies home. */
const HOME_AFTER = 3000;
/** A mouse within this many R of the body holds it, a second at a time. */
const HOVER_HOLD = 2;
const HOVER_REARM = 1000;
/** How long the island keeps it asleep before it drops out. */
const TUCK_SLEEP = 1600;
/** Within this many R of the island at release (or of home at rest), it is caught. */
const CATCH = 0.6;
/** Away from home by this many R, the h1's stop shows its ink. */
const STOP_INK = 0.6;
/** Under this many R of the hero visible, it is cut home. */
const HIDE_CUT = 3;
/** A scroll that brings a wall within this many R of the body sends it home. */
const SCROLL_FLY = 0.25;
/** A happy landing (thrown at HAPPY_SPEED·s, bounced off HAPPY_HITS surfaces): a cheer, at most every CHEER_EVERY ms. */
const HAPPY_SPEED = 1800;
const HAPPY_HITS = 2;
const CHEER_EVERY = 4000;
const DRAG = springKC(SPRING_DRAG);
const HOME = springKC(SPRING_CHAR);
const NOWHERE: World = { box: { l: -1e6, t: -1e6, r: 1e6, b: 1e6 }, island: null };

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function startHeroPlay(d: HeroPlayDeps): HeroPlay {
  const root = document.documentElement;
  const stop = document.querySelector<HTMLElement>(".h1-stop");
  const trace = (window as unknown as { __jhTrace?: unknown }).__jhTrace === true;
  let state: PlayState = "home";
  let dead = false;
  let R = 0;
  let s = 1;
  let body: Body | null = null;
  let world: World = NOWHERE;
  // The home centre (client px) and the translate written on the wrapper.
  let homeX = 0;
  let homeY = 0;
  let curX = 0;
  let curY = 0;
  let visibleH = Infinity;
  let lastW = window.innerWidth;
  // The hand: its pointer, where and when it went down, whether it passed the slop.
  let pid: number | null = null;
  let ptype = "mouse";
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let passed = false;
  // The loop, and a measure waiting for a frame.
  let raf = 0;
  let lastT = 0;
  let dirty = false;
  let measureRaf = 0;
  let tuckPending = false;
  // The way home: its timer and the mouse that may hold it.
  let homeTimer = 0;
  let hover: [number, number] | null = null;
  // The island's sequence: its animation, its wait, a tap's shortcut, a token a cut invalidates.
  let tuckAnim: ReturnType<typeof animate> | null = null;
  let tuckTimer = 0;
  let tuckSkip: (() => void) | null = null;
  let tuckToken = 0;
  // The h1's stop: shown while the body is away (desktop only).
  let inkOn = false;
  let inkReady = false;
  let inkAnim: ReturnType<typeof animate> | null = null;
  // The happy landing.
  let thrown = 0;
  let bounces = 0;
  let cheeredAt = -Infinity;
  let away = false;

  const calm = d.calm;
  const attendable = (st: PlayState): boolean => st === "home" || st === "perched";

  function setState(next: PlayState): void {
    if (next === state) return;
    const was = state;
    state = next;
    d.wrap.dataset["play"] = next;
    if (calm) return;
    if (attendable(was) && !attendable(next)) d.onAttend(false);
    else if (!attendable(was) && attendable(next)) d.onAttend(true);
  }

  /** The body at the host's size (R is the disc's radius); a new size only at home. */
  function ensureBody(): Body | null {
    const w = d.host()?.clientWidth ?? 0;
    if (!w) return body;
    const r = w / 2.8;
    if (body && (Math.abs(r - R) < 0.5 || state !== "home")) return body;
    R = r;
    s = r / 59;
    body = createBody({
      R,
      s,
      drag: DRAG,
      home: HOME,
      onImpact: (_v, bounced) => {
        if (bounced) bounces++;
      },
      onSnap: (nx, ny) => d.ch()?.snap(nx, ny),
      onSplat: (v) => d.ch()?.splat(Math.min(1, 0.5 + v / (3000 * s))),
      onTuck: () => {
        tuckPending = true;
      },
    });
    return body;
  }

  /**
   * Three rect reads: the wrapper (less its translate) gives home; the hero as seen (the visual viewport's, under the
   * bar) gives the walls; the island's box, its top at -Infinity, is the solid one.
   */
  function measure(): void {
    const r = d.wrap.getBoundingClientRect();
    homeX = r.left + r.width / 2 - curX;
    homeY = r.top + r.height / 2 - curY;
    const vv = window.visualViewport;
    const vl = vv ? vv.offsetLeft : 0;
    const vt = vv ? vv.offsetTop : 0;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const hero = (d.wrap.closest("section.hero") ?? document.querySelector("section.hero"))?.getBoundingClientRect();
    const bar = document.querySelector(".top")?.getBoundingClientRect().bottom ?? 0;
    const l = Math.max(hero ? hero.left : 0, vl);
    const rr = Math.min(hero ? hero.right : vw, vl + vw);
    const t = Math.max(hero ? hero.top : 0, vt, bar);
    const b = Math.min(hero ? hero.bottom : vh, vt + vh);
    visibleH = b - t;
    const isl = document.querySelector(".top-scale")?.getBoundingClientRect();
    world = {
      box: { l: l - homeX, t: t - homeY, r: rr - homeX, b: b - homeY },
      island: isl && isl.width > 0 ? { l: isl.left - homeX, t: -Infinity, r: isl.right - homeX, b: isl.bottom - homeY } : null,
    };
  }

  /** The translate on the wrapper, on the device's pixels (a scale and opacity only in the tuck). */
  function write(x: number, y: number, k = 1, op: number | null = null): void {
    const dpr = window.devicePixelRatio || 1;
    curX = Math.round(x * dpr) / dpr;
    curY = Math.round(y * dpr) / dpr;
    d.wrap.style.transform = `translate(${curX}px, ${curY}px)${k !== 1 ? ` scale(${k})` : ""}`;
    if (op !== null) d.wrap.style.opacity = String(op);
  }
  function clearWrap(): void {
    curX = 0;
    curY = 0;
    d.wrap.style.transform = "";
    d.wrap.style.opacity = "";
  }

  function send(cs: readonly Contact[], x: number, y: number): void {
    const b = body;
    if (!b) return;
    const g = b.grab;
    d.ch()?.setMotion({
      held: b.mode === "held",
      lag: [b.lag.x, b.lag.y],
      grab: g ? [g.x, g.y] : null,
      v: [b.vx, b.vy],
      contacts: cs,
      at: [homeX + x, homeY + y],
      homing: b.mode === "homing",
    });
  }

  // ---- the h1's stop ----

  const phone = (): boolean => window.matchMedia("(max-width: 600px)").matches;
  function setInk(on: boolean, force = false): void {
    if (!stop || phone() || (on === inkOn && !force)) return;
    inkOn = on;
    if (!inkReady) {
      inkReady = true;
      // The arrival left the stop inked and clear; without one it has no inline style yet.
      if (!stop.style.color) stop.style.color = "var(--jh-fg)";
      if (!stop.style.opacity) stop.style.opacity = "0";
    }
    inkAnim?.stop();
    if (calm || force) {
      inkAnim = animate(stop, { opacity: on ? 1 : 0 }, CUT);
      stop.style.opacity = on ? "1" : "0";
      return;
    }
    inkAnim = animate(stop, { opacity: on ? 1 : 0 }, on ? ease("base") : ease("quick"));
  }
  const ink = (): void => setInk(Math.hypot(curX, curY) >= STOP_INK * R);

  // ---- the loop ----

  function startLoop(): void {
    if (raf || dead || calm) return;
    lastT = 0;
    raf = requestAnimationFrame(loop);
  }
  function stopLoop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function loop(now: number): void {
    raf = 0;
    const b = body;
    if (dead || !b) return;
    if (trace) performance.mark("hero-play-frame");
    const dt = lastT ? Math.min(1 / 30, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    if (dirty && remeasure()) return;
    const cs = b.step(dt, world);
    if (tuckPending) {
      tuckPending = false;
      tuck();
      return;
    }
    write(b.x, b.y);
    send(cs, b.x, b.y);
    ink();
    if (state === "free" && b.atRest) {
      landed();
      if (Math.hypot(b.x, b.y) < CATCH * R) {
        b.home(true);
        setState("homing");
      } else {
        setState("perched");
        armHome(HOME_AFTER);
        return;
      }
    } else if (state === "homing" && b.atHome) {
      arrive();
      return;
    }
    if (!raf && (state === "held" || state === "free" || state === "homing")) raf = requestAnimationFrame(loop);
  }

  /** Home: the wrapper untransformed, the engine at rest, nothing running. */
  function arrive(): void {
    stopLoop();
    clearWrap();
    d.ch()?.setMotion(null);
    setInk(false);
    setState("home");
    detachAway();
  }

  /** A throw that bounced its way to rest: a squint of joy (awake kinds only, not too often). */
  function landed(): void {
    const now = performance.now();
    if (thrown >= HAPPY_SPEED * s && bounces >= HAPPY_HITS && d.kind() !== "asleep" && now - cheeredAt >= CHEER_EVERY) {
      cheeredAt = now;
      d.ch()?.cheer(0.6);
    }
    thrown = 0;
    bounces = 0;
  }

  // ---- the way home ----

  function armHome(ms: number): void {
    window.clearTimeout(homeTimer);
    homeTimer = window.setTimeout(fireHome, ms);
  }
  function clearHome(): void {
    window.clearTimeout(homeTimer);
    homeTimer = 0;
  }
  function fireHome(): void {
    homeTimer = 0;
    const b = body;
    if (state !== "perched" || !b) return;
    // A mouse near it holds it where it is, a second at a time.
    if (hover && Math.hypot(hover[0] - (homeX + b.x), hover[1] - (homeY + b.y)) < HOVER_HOLD * R) {
      armHome(HOVER_REARM);
      return;
    }
    flyHome();
  }
  /** Any stuck patch lets go first (the recoil), then home on the capped spring. */
  function flyHome(): void {
    const b = body;
    if (!b) return;
    clearHome();
    for (const c of b.contacts(world)) if (c.stuck) d.ch()?.snap(c.nx, c.ny);
    b.home(true);
    setState("homing");
    startLoop();
  }

  /** Home at once, no flight: nothing held, nothing animating, the stop's ink cut out. */
  function cutHome(): void {
    tuckToken++;
    tuckAnim?.stop();
    tuckAnim = null;
    window.clearTimeout(tuckTimer);
    tuckTimer = 0;
    tuckSkip = null;
    tuckPending = false;
    stopLoop();
    clearHome();
    if (pid !== null) {
      try {
        if (d.grab.hasPointerCapture(pid)) d.grab.releasePointerCapture(pid);
      } catch {
        // the pointer is already gone
      }
      pid = null;
      passed = false;
    }
    body?.cut();
    clearWrap();
    d.ch()?.setMotion(null);
    if (inkOn) setInk(false, true);
    delete root.dataset["grabbing"];
    setState("home");
    detachAway();
  }

  /** A fresh measure; cut home when the hero is out of sight or the width changed. True when it cut. */
  function remeasure(): boolean {
    dirty = false;
    const ox = homeX;
    const oy = homeY;
    measure();
    if (visibleH < HIDE_CUT * R || window.innerWidth !== lastW) {
      cutHome();
      return true;
    }
    // Held, the hand keeps it where it is on the screen while the page moves under it.
    if (state === "held") {
      if (calm) {
        downX += homeX - ox;
        downY += homeY - oy;
      } else body?.shift(ox - homeX, oy - homeY);
    }
    const b = body;
    if (b && (state === "free" || state === "perched")) {
      const B = world.box;
      if (Math.min(b.x - B.l, B.r - b.x, b.y - B.t, B.b - b.y) < SCROLL_FLY * R) flyHome();
    }
    return false;
  }

  // ---- the island ----

  function eyesAt(): [number, number] {
    const e = document.querySelector(".top .desk-eyes")?.getBoundingClientRect();
    return e ? [e.left + e.width / 2, e.top + e.height / 2] : [homeX, 0];
  }

  /**
   * The island puts it to bed (the app's notch dock): asleep at once (the island wears `- -`, the body turns titanium);
   * it slides under the island's eyes, shrinking and fading; sleeps TUCK_SLEEP (a tap wakes it early); drops out under the
   * island; and flies home asleep.
   */
  function tuck(): void {
    const b = body;
    d.setHero("asleep");
    if (!b || calm) {
      cutHome();
      return;
    }
    const token = ++tuckToken;
    stopLoop();
    clearHome();
    setState("tucked");
    const fx = b.x;
    const fy = b.y;
    b.place(fx, fy);
    const [ex, ey] = eyesAt();
    const tx = ex - homeX;
    const ty = ey - homeY;
    const slide = animate(0, 1, {
      ...ease("base"),
      onUpdate: (u: number) => {
        const x = fx + (tx - fx) * u;
        const y = fy + (ty - fy) * u;
        write(x, y, 1 - 0.7 * u, 1 - u);
        send([], x, y);
      },
    });
    tuckAnim = slide;
    void slide.then(() => {
      if (token !== tuckToken) return;
      tuckAnim = null;
      const out = (): void => {
        if (token !== tuckToken) return;
        window.clearTimeout(tuckTimer);
        tuckTimer = 0;
        tuckSkip = null;
        dropOut(token);
      };
      tuckSkip = out;
      tuckTimer = window.setTimeout(out, TUCK_SLEEP);
    });
  }

  function dropOut(token: number): void {
    const b = body;
    if (!b) return;
    measure();
    const [ex] = eyesAt();
    const x = ex - homeX;
    const y = (world.island ? world.island.b : -homeY) + 0.4 * R;
    b.place(x, y);
    write(x, y, 0.3, 0);
    send([], x, y);
    d.ch()?.nudge();
    const pop = animate(0, 1, {
      ...ease("quick"),
      onUpdate: (u: number) => write(x, y, 0.3 + 0.7 * u, u),
    });
    tuckAnim = pop;
    void pop.then(() => {
      if (token !== tuckToken) return;
      tuckAnim = null;
      write(x, y);
      d.wrap.style.opacity = "";
      b.home(true);
      setState("homing");
      startLoop();
    });
  }

  // ---- the hand ----

  function poke(): void {
    if (dead) return;
    if (calm) {
      d.stepHero();
      return;
    }
    if (state === "tucked") {
      tuckSkip?.();
      return;
    }
    d.stepHero();
    d.ch()?.poke();
    if (state === "held") return;
    const b = ensureBody();
    if (!b) return;
    measure();
    if (state === "home" || (state === "homing" && Math.hypot(b.x, b.y) < CATCH * R)) {
      // a hop on the home spring, back inside the stop's line before it could show
      lastW = window.innerWidth;
      b.hopHome(rand(-60, 60) * s, -480 * s);
      setState("homing");
      attachAway();
      startLoop();
      return;
    }
    // away: a little throw (a stuck body hops along its wall), and the wait for home starts again
    clearHome();
    b.fling(rand(-90, 90) * s, rand(-140, -60) * s);
    thrown = 0;
    bounces = 0;
    setState("free");
    startLoop();
  }

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary || pid !== null || dead) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (d.wrap.dataset["play"] === undefined || state === "tucked") return;
    const b = calm ? null : ensureBody();
    if (!calm && !b) return;
    if (calm) R = (d.host()?.clientWidth ?? 0) / 2.8;
    measure();
    if (visibleH < HIDE_CUT * R) return;
    pid = e.pointerId;
    ptype = e.pointerType;
    try {
      d.grab.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer: the window's moves still reach the grab
    }
    // a mouse press selects nothing and focuses nothing
    if (e.pointerType === "mouse") e.preventDefault();
    root.dataset["grabbing"] = "";
    downX = e.clientX;
    downY = e.clientY;
    downT = e.timeStamp;
    passed = false;
    if (state === "home") lastW = window.innerWidth;
  };

  /** Past the slop: the hand takes it (from where it is, mid-flight too), its grab offset kept. */
  function take(e: PointerEvent): void {
    setState("held");
    attachAway();
    if (calm) return;
    const b = body;
    if (!b) return;
    clearHome();
    thrown = 0;
    bounces = 0;
    b.beginDrag(downX - homeX, downY - homeY, downT);
    b.moveDrag(e.clientX - homeX, e.clientY - homeY, e.timeStamp);
    startLoop();
  }

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pid) return;
    if (!passed) {
      const slop = ptype === "touch" ? SLOP_TOUCH : SLOP_MOUSE;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) < slop) return;
      passed = true;
      take(e);
    }
    if (calm) {
      // calm: carried 1:1, kept 0.9 R inside the hero
      const B = world.box;
      const x = clamp(e.clientX - downX, B.l + 0.9 * R, B.r - 0.9 * R);
      const y = clamp(e.clientY - downY, B.t + 0.9 * R, B.b - 0.9 * R);
      write(x, y);
      setInk(Math.hypot(curX, curY) >= STOP_INK * R);
      return;
    }
    body?.moveDrag(e.clientX - homeX, e.clientY - homeY, e.timeStamp);
  };

  function finish(e: PointerEvent, cancelled: boolean): void {
    const was = passed;
    pid = null;
    passed = false;
    delete root.dataset["grabbing"];
    if (!was) {
      if (!cancelled && e.timeStamp - downT <= TAP_MS) poke();
      return;
    }
    if (dirty && remeasure()) return;
    if (calm) {
      if (world.island && distToBox(curX, curY, world.island).d <= CATCH * R) d.setHero("asleep");
      cutHome();
      return;
    }
    const b = body;
    if (!b) return;
    measure();
    // dropped in or just under the island: to bed
    if (!cancelled && world.island && distToBox(b.x, b.y, world.island).d <= CATCH * R) {
      tuck();
      return;
    }
    if (cancelled) b.cancelDrag();
    else b.endDrag(e.timeStamp);
    thrown = Math.hypot(b.vx, b.vy);
    bounces = 0;
    setState("free");
    startLoop();
  }
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId === pid) finish(e, false);
  };
  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId === pid) finish(e, true);
  };
  const onMenu = (e: Event): void => e.preventDefault();

  // ---- while away ----

  const onScroll = (): void => {
    dirty = true;
    if (raf || measureRaf) return;
    measureRaf = requestAnimationFrame(() => {
      measureRaf = 0;
      if (dirty && !raf && !dead) remeasure();
    });
  };
  const onHover = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") hover = [e.clientX, e.clientY];
  };
  const onOut = (e: MouseEvent): void => {
    if (!e.relatedTarget) hover = null;
  };
  const onVis = (): void => {
    if (document.hidden) cutHome();
  };
  const onBlur = (): void => {
    if (state === "held") cutHome();
  };

  function attachAway(): void {
    if (away) return;
    away = true;
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.visualViewport?.addEventListener("resize", onScroll);
    window.visualViewport?.addEventListener("scroll", onScroll);
    window.addEventListener("pointermove", onHover, { passive: true });
    window.addEventListener("mouseout", onOut);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
  }
  function detachAway(): void {
    if (!away) return;
    away = false;
    hover = null;
    dirty = false;
    if (measureRaf) cancelAnimationFrame(measureRaf);
    measureRaf = 0;
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    window.visualViewport?.removeEventListener("resize", onScroll);
    window.visualViewport?.removeEventListener("scroll", onScroll);
    window.removeEventListener("pointermove", onHover);
    window.removeEventListener("mouseout", onOut);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("blur", onBlur);
  }

  d.grab.addEventListener("pointerdown", onDown);
  d.grab.addEventListener("pointermove", onMove);
  d.grab.addEventListener("pointerup", onUp);
  d.grab.addEventListener("pointercancel", onCancel);
  d.grab.addEventListener("lostpointercapture", onCancel);
  d.grab.addEventListener("contextmenu", onMenu);
  d.wrap.dataset["play"] = "home";

  return {
    poke,
    canAttend: () => calm || attendable(state),
    destroy() {
      if (dead) return;
      cutHome();
      dead = true;
      inkAnim?.stop();
      d.grab.removeEventListener("pointerdown", onDown);
      d.grab.removeEventListener("pointermove", onMove);
      d.grab.removeEventListener("pointerup", onUp);
      d.grab.removeEventListener("pointercancel", onCancel);
      d.grab.removeEventListener("lostpointercapture", onCancel);
      d.grab.removeEventListener("contextmenu", onMenu);
      delete d.wrap.dataset["play"];
      delete root.dataset["grabbing"];
    },
  };
}
