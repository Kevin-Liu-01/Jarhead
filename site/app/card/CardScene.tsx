"use client";
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { GLANCE_EVENT, GLASS_EVENT, type GlassDetail } from "@/components/site/glass";
import { InstallKey } from "@/components/site/InstallKey";
import { HERO, INSTALL } from "@/content/deck";
import { mountBlob, type BlobHandle } from "@/lib/blob";
import { after, parts, row, upTo } from "@/lib/cut";
import { cellCss, parseColor } from "@/lib/dither";
import { renderToneField } from "@/lib/field";
import { cssVar, readTheme } from "@/lib/theme";
import { advance, clockNow, inClock, installClock, seedClock } from "./clock";
import type { Frame } from "./frames";

// The card's clock takes requestAnimationFrame before any engine on the page asks for a frame.
installClock();

/** The h1 on one line, its full stop held apart for the blob (as components/site/Hero.tsx sets it). */
const H1 = HERO.h1.join(" ");
const H1_WORDS = H1.slice(0, -1);
/** The glass Install's second line, as the hero sets it: two parts of the figures line and Install's label. */
const FACTS = parts(HERO.figures);
const REQUIREMENTS = [row(FACTS, 2), row(FACTS, 3), INSTALL.label].join(" · ");
/** The site's host, cut from the one-liner's: jarhead.kevinliu.studio. */
const HOST = upTo(after(INSTALL.runs.host, "://"), "/");
/** As the hero's blob (components/site/HeroCharacter.tsx): the key lit again within this long goes straight to the lit gaze. */
const CHEER_REST_MS = 2000;

declare global {
  interface Window {
    /** The scene's driver (the GIF's frames, a search for a still's moment): play `ms` more; the next frame is then ready. */
    __cardStep?: (ms: number) => void;
    /** The GIF's beats: the pointer comes onto the key, leaves it, presses it, lets it go. */
    __cardDo?: (what: "hover" | "leave" | "press" | "release") => void;
  }
}

/**
 * One frame (./frames.ts): the h1 with the blob as its full stop (or, with `line` off, the blob alone), the glass Install
 * under it if the frame has one, the host at the foot, on the dithered pool. Everything is the page's own: the blob engine (lib/blob.ts) with its sparkly
 * eyes, the key (components/site/InstallKey.tsx), the tone field (lib/field.ts), Newsreader, Inter and JetBrains Mono.
 * The scene plays on the card's clock (./clock.ts): the blob mounts listening, at `lit` what it loves lights up (the key
 * answers a glance, or it looks toward a point) and its eyes light, two stars pop round its head and the nearer eye
 * flares; at `t` the frame is marked ready (`html[data-card="ready"]`) and waits: __cardStep plays it on, __cardDo moves
 * the pointer on the key. With `gif` the pointer, not a glance, lights the key, and the blob answers it as the hero's
 * does: a squint of joy when it lights, a squint and a hop when it is pressed.
 */
export function CardScene({ frame, gif }: { readonly frame: Frame; readonly gif: boolean }): ReactElement {
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLSpanElement>(null);

  // The frame's theme on <html> before anything reads a token (the field, the blob and the key read their colours there).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["theme"] = frame.theme;
    delete root.dataset["arrive"];
  }, [frame.theme]);

  useEffect(() => {
    const el = host.current;
    const cv = field.current;
    const root = card.current;
    if (!el || !cv || !root) return;
    let dead = false;
    let blob: BlobHandle | null = null;
    let cheered = -Infinity;
    const onGlass = (e: Event): void => {
      const d = (e as CustomEvent<GlassDetail>).detail;
      const now = performance.now();
      if (d.kind === "press") {
        cheered = now;
        blob?.cheer();
        return;
      }
      blob?.attend(d.on ? d.at : null);
      if (gif && d.on && now - cheered > CHEER_REST_MS) {
        cheered = now;
        blob?.cheer(0.42);
      }
    };
    window.addEventListener(GLASS_EVENT, onGlass);

    const paintField = (): void => {
      const p = frame.pool;
      const rr = root.getBoundingClientRect();
      const kr = root.querySelector<HTMLElement>(".glass-cap")?.getBoundingClientRect();
      const band =
        p.band && "key" in p.band && kr
          ? { x: kr.left - rr.left + kr.width / 2, y: kr.top - rr.top + kr.height / 2, rx: kr.width * 0.85, ry: kr.height * 1.9, strength: p.band.key }
          : p.band && "low" in p.band
            ? { x: frame.w / 2, y: frame.h, rx: p.band.low[0], ry: p.band.low[1], strength: p.band.low[2] }
            : undefined;
      renderToneField(cv, {
        width: frame.w,
        height: frame.h,
        cell: cellCss(p.cell),
        ground: parseColor(cssVar("--jh-ground")),
        tone: parseColor(cssVar("--jh-accent")),
        peak: p.peak,
        floor: 0,
        ax: p.ax,
        ay: p.ay,
        r: p.r,
        bands: p.bands,
        band,
        foot: p.foot,
      });
    };

    /** The pointer's beats on the key (dispatched on the card's clock): its cap, a little right of the middle. */
    const pointer = (what: "hover" | "leave" | "press" | "release"): void => {
      const a = root.querySelector<HTMLAnchorElement>(".glass");
      const cap = root.querySelector(".glass-cap")?.getBoundingClientRect();
      if (!a || !cap) return;
      const at = { clientX: cap.left + cap.width * 0.62, clientY: cap.top + cap.height / 2, button: 0, pointerType: "mouse", bubbles: true };
      inClock(() => {
        if (what === "hover") window.dispatchEvent(new PointerEvent("pointermove", at));
        else if (what === "leave") window.dispatchEvent(new PointerEvent("pointermove", { ...at, clientX: 1, clientY: 1 }));
        else if (what === "press") a.dispatchEvent(new PointerEvent("pointerdown", at));
        else window.dispatchEvent(new PointerEvent("pointerup", at));
      });
    };

    void (async () => {
      try {
        await document.fonts.ready;
      } catch {
        // the fallback faces measure the same way
      }
      // the observers (the key's and the blob's visibility) report before the scene plays
      await new Promise((r) => window.setTimeout(r, 400));
      if (dead) return;
      paintField();
      seedClock(frame.seed);
      blob = inClock(() =>
        mountBlob(el, { size: el.clientWidth, phase: "listening", theme: readTheme(), pointerRoot: document.createElement("div"), ignoreScale: true, lead: true }),
      );
      const start = clockNow();
      let lit = false;
      const light = (): void => {
        lit = true;
        if (frame.look !== "key") {
          const r = el.getBoundingClientRect();
          blob?.attend([r.left + r.width / 2 + frame.look[0] * frame.disc, r.top + r.height / 2 + frame.look[1] * frame.disc]);
        } else if (gif) pointer("hover");
        else window.dispatchEvent(new Event(GLANCE_EVENT));
      };
      // A glance lights the key for 1.3 s of the page's own time: asked again each frame, it stays lit while the scene plays.
      const tick = (now: number): void => {
        if (!lit && now - start >= frame.lit) light();
        else if (lit && !gif && frame.look === "key") window.dispatchEvent(new Event(GLANCE_EVENT));
      };
      advance(frame.t, tick);
      window.__cardStep = (ms) => advance(ms, tick);
      window.__cardDo = pointer;
      document.documentElement.dataset["card"] = "ready";
    })();
    return () => {
      dead = true;
      window.removeEventListener(GLASS_EVENT, onGlass);
      blob?.destroy();
      delete window.__cardStep;
      delete window.__cardDo;
      delete document.documentElement.dataset["card"];
    };
  }, [frame, gif]);

  const k = frame.key;
  const style = {
    width: frame.w,
    height: frame.h,
    "--fs": `${frame.fs}px`,
    "--weight": frame.weight,
    "--disc": `${frame.disc}px`,
    "--gap": `${frame.gap}em`,
    "--drop": `${frame.drop}px`,
    "--card-key-h": `${k?.h ?? 0}px`,
    "--card-key-w": `${k?.w ?? 0}px`,
    "--card-key-size": `${k?.size ?? 0}px`,
    "--card-key-depth": `${k?.depth ?? 0}px`,
    "--card-key-gap": `${k?.gap ?? 0}px`,
    "--card-key-dx": `${k?.dx ?? 0}px`,
  } as CSSProperties;

  return (
    <div ref={card} id="card" className="card" data-frame={frame.id} data-nomark={k && !k.mark ? "" : undefined} style={style}>
      <div className="card-field" aria-hidden="true">
        <canvas ref={field} width={1} height={1} />
      </div>
      <div className="card-in">
        <div className="card-group" data-center={k && k.dx === null ? "" : undefined}>
          {frame.line ? (
            <h1 className="card-h">
              {H1_WORDS}
              <span className="card-stop">.</span>
              <span className="card-mark">
                <span ref={host} className="char card-char" />
              </span>
            </h1>
          ) : (
            <div className="card-solo">
              <span ref={host} className="char card-char" />
            </div>
          )}
          {k ? (
            <div className={`card-key card-key--${k.kind}`}>
              <InstallKey href="#install" l1={HERO.install} l2={k.kind === "two" ? REQUIREMENTS : ""} />
            </div>
          ) : null}
        </div>
      </div>
      {frame.url ? <p className="card-url">{HOST}</p> : null}
    </div>
  );
}
