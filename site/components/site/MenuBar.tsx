"use client";
import Apple from "@thesvg/react/apple";
import Github from "@thesvg/react/github";
import type { ReactElement } from "react";
import { Notch } from "@/components/desk/Notch";
import { NAV, PHASES, REPO_URL } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { useLive } from "@/lib/live";
import { SECTIONS } from "./sections";
import { Stars } from "./Stars";
import { ThemeToggle } from "./ThemeToggle";

/** The menus: the sections by their deck names; Install has its own call at the right. */
const MENUS = SECTIONS.filter((s) => s.id !== "install");

/**
 * The Mac's menu bar as the page's own bar: edge to edge, opaque, one hairline under it, the notch cut out at the centre.
 * Left, as macOS draws an app's menus: the Apple mark, `Jarhead` in the one bold weight the canon allows, then the sections
 * as its menus (the one in view marked). Right, where the status items sit: the phase dot and word (the docked island's own
 * words are small, so the bar names its state), GitHub with the live star count, the theme, Install, and the clock the
 * island's foot also shows. Narrow bars drop the menus last first; a phone keeps the mark, the name, GitHub and the theme.
 */
export function MenuBar({ stars }: { readonly stars: number | null }): ReactElement {
  const live = useLive();
  return (
    <div className="bar">
      <div className="bar-l">
        <Apple variant="mono" className="bar-apple" aria-hidden="true" focusable="false" />
        <a className="bar-app" href="#hero">
          {NAV.brand}
        </a>
        <nav className="bar-menus" aria-label={NAV.brand}>
          {MENUS.map((s) => (
            <a key={s.id} href={`#${s.id}`} aria-current={live.section === s.id ? "location" : undefined}>
              {s.name}
            </a>
          ))}
        </nav>
      </div>
      <Notch />
      <div className="bar-r">
        <span className="bar-phase">
          <i className="bar-dot" aria-hidden="true" />
          {PHASES[live.kind].word}
        </span>
        <a className="bar-item bar-gh" href={REPO_URL} rel="noopener">
          <Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />
          <span className="bar-gh-word">{NAV.github}</span>
          <Stars initial={stars} />
        </a>
        <ThemeToggle />
        <a className="bar-install" href="#install">
          {NAV.install}
        </a>
        <span className="bar-clock" aria-hidden="true">
          {ISLAND.footClock}
        </span>
      </div>
    </div>
  );
}
