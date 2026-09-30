"use client";
import Github from "@thesvg/react/github";
import type { CSSProperties, ReactElement } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button, JarheadMark } from "@/components/kit";
import { NAV, PHASES, REPO_URL } from "@/content/deck";
import { shownKind, useLive } from "@/lib/live";
import { PHASE_META } from "@/lib/phase";
import { Crossfade } from "./Crossfade";
import { Stars } from "./Stars";

const LIVE = new Set(["listening", "thinking", "acting", "speaking"]);

/**
 * The Console's header (ConsoleRootView.swift ConsoleHeader): 44 px, the traffic lights, the 14 px mark and the name,
 * the phase dot and the phase word (crossfading), the connected dot at the right. The page's own controls sit in it too:
 * the theme toggle, GitHub with its star count (ITERATE.md §2) and the small kit Install. Sticky: the window's title bar
 * stays while the stream scrolls.
 */
export function TitleBar({ stars }: { readonly stars: number | null }): ReactElement {
  const live = useLive();
  const k = shownKind(live);
  const word = PHASES[k].word;
  const dot = { "--kit-phase": `var(${PHASE_META[k].token})` } as CSSProperties;
  return (
    <header className="tb" id="top">
      <span className="tb-lights" aria-hidden="true">
        <i className="tb-light tb-light-r" />
        <i className="tb-light tb-light-y" />
        <i className="tb-light tb-light-g" />
      </span>
      <a className="tb-brand" href="#top">
        <JarheadMark size={14} />
        <span className="tb-name">{NAV.brand}</span>
      </a>
      <span className="tb-phase">
        <span className={`kit-dot${LIVE.has(k) ? " is-live" : ""}`} style={dot} aria-hidden="true" />
        <Crossfade text={word} className="tb-word" />
      </span>
      <span className="tb-right">
        <span className="tb-conn" aria-hidden="true" />
        <ThemeToggle />
        <Button kind="ghost" size={28} href={REPO_URL} className="tb-gh" icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
          <span className="tb-gh-word">{NAV.github}</span>
          <Stars initial={stars} />
        </Button>
        <Button kind="primary" size={28} href="#install" className="tb-install">
          {NAV.install}
        </Button>
      </span>
    </header>
  );
}
