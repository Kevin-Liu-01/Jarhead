"use client";
import { animate } from "motion/react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { HERO, PHASES } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { claim, getLive, useLive, type Show } from "@/lib/live";
import { SPRING_CHAR, ease, useCalm } from "@/lib/motion";
import { DESK_PHASE, type DeskKind, type Phase } from "@/lib/phase";
import { GLANCE_EVENT, GLASS_EVENT, type GlassDetail } from "./glass";
import { startHeroPlay, type HeroPlay } from "./heroPlay";

/**
 * What a press on the hero's blob steps through, and what the island wears with each: listening with nothing heard yet,
 * then the app's own thinking and acting (its line and its two thread tiles), then asleep. The island's question is not
 * among them: it belongs to the Threads demo, where it is asked.
 */
const CYCLE: readonly DeskKind[] = ["listening", "thinking", "acting", "asleep"];
const HERO_SHOW: Record<DeskKind, Show> = {
  listening: { kind: "listening" },
  thinking: { kind: "thinking", line: ISLAND.hero.thinking },
  acting: { kind: "acting", line: ISLAND.hero.acting, tiles: ISLAND.tiles.map((name) => ({ name, state: "working" as const })) },
  speaking: { kind: "listening" },
  asleep: { kind: "asleep" },
  alarm: { kind: "asleep" },
};
const heroKind = (): DeskKind => getLive().claims["hero"]?.kind ?? "asleep";
const setHero = (k: DeskKind): void => claim("hero", HERO_SHOW[k]);
function stepHero(): void {
  const i = CYCLE.indexOf(heroKind());
  setHero(CYCLE[(i + 1) % CYCLE.length] ?? "listening");
}

/** The blob in the hand (components/site/heroPlay.ts), while the hero is mounted and its arrival has ended. */
let heroPlay: HeroPlay | null = null;
/** A tap on the blob, or its keyboard twin: the step, the poke's face and a hop; before play starts, the step alone. */
export const pokeHero = (): void => (heroPlay ? heroPlay.poke() : stepHero());

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
/** The glass Install lit again within this long goes straight to the lit gaze: the squint of joy never strobes. */
const CHEER_REST_MS = 2000;

/**
 * The hero's character, standing where the h1's full stop is. Its arrival (only when the boot script allowed motion and
 * stamped `html[data-arrive]`): the stop is a dot of ink; the blob, asleep and the size of the dot, takes its place; it
 * wakes (the island wakes with it), turns blue and springs up to its size on the baseline, glances about for a moment,
 * then looks once at the glass Install (which lights in reply), settles listening and looks at the pointer. It loves that
 * button: while the button is hovered, focused or touched it turns its eyes to it, squints with joy and gazes with lit
 * eyes, and goes back to the pointer when it is let go; a press on it makes it squint again and hop. Once it stands it
 * can be picked up by its disc and played with (heroPlay: carried, flung, stuck to an edge, put to bed in the island,
 * home again after a few seconds), and a tap steps it through its kinds with a poke and a hop; the island follows. Inside
 * the h1 it is decoration with a pointer press; its keyboard twin is HeroPoke beside the h1.
 */
export function HeroCharacter(): ReactElement {
  const hero = useLive().claims["hero"]?.kind ?? "listening";
  const calm = useCalm();
  const ch = useRef<CharacterHandle>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const grab = useRef<HTMLSpanElement>(null);
  const [stage, setStage] = useState<"rest" | "dot" | "grow">("rest");
  // Play starts once the arrival has ended (or there was none): the arrival owns the host's transform until then.
  const [ready, setReady] = useState(false);
  const phase: Phase = stage === "dot" ? "asleep" : stage === "grow" ? "connecting" : DESK_PHASE[hero];
  // The glass's last lit word, and the handler that applies one (re-applied when play lets the blob attend again).
  const lit = useRef<GlassDetail | null>(null);
  const applyLit = useRef<(d: GlassDetail) => void>(() => undefined);

  useEffect(() => {
    const root = document.documentElement;
    const host = ch.current?.el ?? null;
    const stop = document.querySelector<HTMLElement>(".h1-stop");
    const mark = host?.closest<HTMLElement>(".h1-mark") ?? null;
    if (root.dataset["arrive"] === undefined || !host || !stop || !mark) {
      delete root.dataset["arrive"];
      setHero("listening");
      setReady(true);
      return;
    }
    let dead = false;
    setHero("asleep");
    setStage("dot");
    const run = async () => {
      try {
        try {
          await document.fonts.ready;
        } catch {
          // the fallback face measures the same way
        }
        if (dead) return;
        const fs = Number.parseFloat(getComputedStyle(stop).fontSize) || 100;
        const sr = stop.getBoundingClientRect();
        const baseline = mark.getBoundingClientRect().top;
        const hr = host.getBoundingClientRect();
        const disc = host.offsetWidth / 1.4;
        const dot = 0.118 * fs;
        const x = sr.left + sr.width / 2 - (hr.left + hr.width / 2);
        const y = baseline - dot / 2 - (hr.top + hr.height / 2);
        await animate(host, { x, y, scale: Math.max(0.04, dot / disc), opacity: 0 }, { duration: 0 });
        // The stop stays a dot of ink until the blob has taken its place.
        stop.style.color = "var(--jh-fg)";
        delete root.dataset["arrive"];
        await wait(520);
        if (dead) return;
        void animate(host, { opacity: 1 }, ease("quick"));
        // On a phone the blob stands over the line (styles/site.css), so the stop it leaves stays a stop.
        if (!matchMedia("(max-width: 600px)").matches) await animate(stop, { opacity: 0 }, { ...ease("base"), delay: 0.1 });
        await wait(240);
        if (dead) return;
        setStage("grow");
        setHero("listening");
        ch.current?.nudge();
        await animate(host, { x: 0, y: 0, scale: 1 }, SPRING_CHAR);
        if (dead) return;
        // Its first look, once it stands: the button it loves.
        window.dispatchEvent(new Event(GLANCE_EVENT));
        await wait(1100);
      } finally {
        if (!dead) {
          setStage("rest");
          setReady(true);
        }
      }
    };
    void run();
    return () => {
      dead = true;
    };
  }, []);

  // The glass Install: lit, the blob turns to it and lights up (a quick squint of joy as it starts, then the sparkling
  // look); pressed, a longer squint and a hop. Calm: one pose, turned to the button with lit eyes (lib/blob.ts). In play
  // it turns to the key only at home or perched; the last lit word is kept and given back when it may look again.
  useEffect(() => {
    let cheered = -Infinity;
    const apply = (d: GlassDetail) => {
      if (d.kind !== "lit") return;
      const now = performance.now();
      ch.current?.attend(d.on ? d.at : null);
      if (d.on && now - cheered > CHEER_REST_MS) {
        cheered = now;
        ch.current?.cheer(0.42);
      }
    };
    applyLit.current = apply;
    const on = (e: Event) => {
      const d = (e as CustomEvent<GlassDetail>).detail;
      if (d.kind === "press") {
        cheered = performance.now();
        ch.current?.cheer();
        return;
      }
      lit.current = d;
      if (!heroPlay || heroPlay.canAttend()) apply(d);
    };
    window.addEventListener(GLASS_EVENT, on);
    return () => window.removeEventListener(GLASS_EVENT, on);
  }, []);

  // Play, once the arrival has ended; started again (cut home first) when calm switches.
  useEffect(() => {
    const w = wrap.current;
    const g = grab.current;
    if (!ready || !w || !g) return;
    const p = startHeroPlay({
      wrap: w,
      grab: g,
      host: () => ch.current?.el ?? null,
      ch: () => ch.current,
      calm,
      stepHero,
      setHero,
      kind: heroKind,
      onAttend: (allowed) => {
        if (!allowed) ch.current?.attend(null);
        else if (lit.current) applyLit.current(lit.current);
      },
    });
    heroPlay = p;
    return () => {
      p.destroy();
      if (heroPlay === p) heroPlay = null;
    };
  }, [calm, ready]);

  // A step from a press (or from the twin button) gives the blob a little hop.
  const prev = useRef(hero);
  useEffect(() => {
    if (prev.current === hero) return;
    prev.current = hero;
    ch.current?.nudge();
  }, [hero]);

  return (
    <span ref={wrap} className="hero-body" aria-hidden="true">
      <Character ref={ch} phase={phase} className="hero-char" ignoreScale lead inline overscan={1.6} />
      <span ref={grab} className="hero-grab" />
    </span>
  );
}

/** The blob's keyboard twin: a button beside the h1, unseen until focused, when the blob itself wears the ring. */
export function HeroPoke(): ReactElement {
  const hero = useLive().claims["hero"]?.kind ?? "listening";
  return (
    <button type="button" className="sr hero-poke" onClick={pokeHero}>
      {HERO.blobLabel.replace("{phase}", PHASES[hero].word)}
    </button>
  );
}
