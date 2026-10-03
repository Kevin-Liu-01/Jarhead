"use client";
import { animate } from "motion/react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { HERO, PHASES } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { claim, getLive, useLive, type Show } from "@/lib/live";
import { SPRING_CHAR, ease } from "@/lib/motion";
import { DESK_PHASE, type DeskKind, type Phase } from "@/lib/phase";
import { GLANCE_EVENT, GLASS_EVENT, type GlassDetail } from "./glass";

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

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
/** The glass Install lit again within this long goes straight to the lit gaze: the squint of joy never strobes. */
const CHEER_REST_MS = 2000;

/**
 * The hero's character, standing where the h1's full stop is. Its arrival (only when the boot script allowed motion and
 * stamped `html[data-arrive]`): the stop is a dot of ink; the blob, asleep and the size of the dot, takes its place; it
 * wakes (the island wakes with it), turns blue and springs up to its size on the baseline, glances about for a moment,
 * then looks once at the glass Install (which lights in reply), settles listening and looks at the pointer. It loves that
 * button: while the button is hovered, focused or touched it turns its eyes to it, squints with joy and gazes with lit
 * eyes, and goes back to the pointer when it is let go; a press on it makes it squint again and hop. A press on the blob
 * steps it through its kinds and the island follows. Inside the h1 it is decoration with a pointer press; its keyboard
 * twin is HeroPoke beside the h1.
 */
export function HeroCharacter(): ReactElement {
  const hero = useLive().claims["hero"]?.kind ?? "listening";
  const ch = useRef<CharacterHandle>(null);
  const [stage, setStage] = useState<"rest" | "dot" | "grow">("rest");
  const phase: Phase = stage === "dot" ? "asleep" : stage === "grow" ? "connecting" : DESK_PHASE[hero];

  useEffect(() => {
    const root = document.documentElement;
    const host = ch.current?.el ?? null;
    const stop = document.querySelector<HTMLElement>(".h1-stop");
    const mark = host?.parentElement ?? null;
    if (root.dataset["arrive"] === undefined || !host || !stop || !mark) {
      delete root.dataset["arrive"];
      setHero("listening");
      return;
    }
    let dead = false;
    setHero("asleep");
    setStage("dot");
    const run = async () => {
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
      if (dead) return;
      setStage("rest");
    };
    void run();
    return () => {
      dead = true;
    };
  }, []);

  // The glass Install: lit, the blob turns to it and lights up (a quick squint of joy as it starts, then the sparkling
  // look); pressed, a longer squint and a hop. Calm: one pose, turned to the button with lit eyes (lib/blob.ts).
  useEffect(() => {
    let cheered = -Infinity;
    const on = (e: Event) => {
      const d = (e as CustomEvent<GlassDetail>).detail;
      const now = performance.now();
      if (d.kind === "press") {
        cheered = now;
        ch.current?.cheer();
        return;
      }
      ch.current?.attend(d.on ? d.at : null);
      if (d.on && now - cheered > CHEER_REST_MS) {
        cheered = now;
        ch.current?.cheer(0.42);
      }
    };
    window.addEventListener(GLASS_EVENT, on);
    return () => window.removeEventListener(GLASS_EVENT, on);
  }, []);

  // A step from a press (or from the twin button) gives the blob a little hop.
  const prev = useRef(hero);
  useEffect(() => {
    if (prev.current === hero) return;
    prev.current = hero;
    ch.current?.nudge();
  }, [hero]);

  return <Character ref={ch} phase={phase} className="hero-char" ignoreScale inline onPress={stepHero} pressMode="pointer" />;
}

/** The blob's keyboard twin: a button beside the h1, unseen until focused, when the blob itself wears the ring. */
export function HeroPoke(): ReactElement {
  const hero = useLive().claims["hero"]?.kind ?? "listening";
  return (
    <button type="button" className="sr hero-poke" onClick={stepHero}>
      {HERO.blobLabel.replace("{phase}", PHASES[hero].word)}
    </button>
  );
}
