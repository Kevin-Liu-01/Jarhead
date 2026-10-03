"use client";
import { useEffect } from "react";
import { setLive } from "@/lib/live";
import { isStill } from "@/lib/theme";

/**
 * The page's watcher. Which section is in view: the last one whose top has crossed the middle of the viewport writes its id
 * to the live state, so the island wears its demo and the menu bar marks it; the hero writes none. Whether a section is
 * on screen at all (`data-inview`): its CSS loops run only then. And the one rise per section, which fails open: sections
 * already on screen are marked seen before `html[data-rise]` is stamped, so only a section still below the fold waits for
 * its rise, and without JS, under reduced motion or `#still` every section simply shows.
 */
export function SectionSpy(): null {
  useEffect(() => {
    const secs = Array.from(document.querySelectorAll<HTMLElement>("main > section[id]"));
    const fold = window.innerHeight * 0.9;
    for (const s of secs) if (s.getBoundingClientRect().top < fold) s.dataset["seen"] = "";
    if (!isStill()) document.documentElement.dataset["rise"] = "";
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
      { rootMargin: "0px 0px -14% 0px" },
    );
    const onScreen = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const el = en.target as HTMLElement;
        if (en.isIntersecting) el.dataset["inview"] = "";
        else delete el.dataset["inview"];
      }
    });
    for (const s of secs) {
      spy.observe(s);
      onScreen.observe(s);
      if (s.dataset["seen"] === undefined) seen.observe(s);
    }
    pick();
    return () => {
      spy.disconnect();
      seen.disconnect();
      onScreen.disconnect();
      delete document.documentElement.dataset["rise"];
    };
  }, []);
  return null;
}
