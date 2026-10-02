"use client";
import { useEffect } from "react";
import { setLive } from "@/lib/live";
import { isStill } from "@/lib/theme";

/**
 * Which section is in view: the last one whose top has crossed the middle of the viewport writes its id to the page's live state
 * (lib/live.ts), so the island wears its kind and the menu bar marks it; the hero writes none, so the timeline cycles.
 * The rise fails open: sections already on screen are marked seen before `html[data-rise]` is stamped, so only a section
 * still below the fold waits for its one rise, and without JS, under reduced motion or `#still` every section simply shows.
 */
export function SectionSpy(): null {
  useEffect(() => {
    const secs = Array.from(document.querySelectorAll<HTMLElement>("main > section[id]"));
    const fold = window.innerHeight * 0.88;
    for (const s of secs) if (s.getBoundingClientRect().top < fold) s.dataset["seen"] = "";
    if (!isStill()) document.documentElement.dataset["rise"] = "";
    // On any crossing of the middle line, the section in view is the last one whose top is above it (the foot keeps Install).
    const pick = () => {
      const mid = window.innerHeight / 2;
      let cur = "";
      for (const s of secs) if (s.getBoundingClientRect().top <= mid) cur = s.id === "hero" ? "" : s.id;
      setLive({ section: cur });
    };
    const spy = new IntersectionObserver(pick, { rootMargin: "-50% 0px -50% 0px" });
    const seen = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          (en.target as HTMLElement).dataset["seen"] = "";
          seen.unobserve(en.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const s of secs) {
      spy.observe(s);
      if (s.dataset["seen"] === undefined) seen.observe(s);
    }
    return () => {
      spy.disconnect();
      seen.disconnect();
      delete document.documentElement.dataset["rise"];
    };
  }, []);
  return null;
}
