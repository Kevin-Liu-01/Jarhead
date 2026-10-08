"use client";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { claim } from "@/lib/live";
import { COPIED_EVENT } from "./CopyButton";

/**
 * The blob at the end of Install's h2, where `then you say jarhead.` has its full stop: asleep (the quiet titanium orb) until
 * a Copy on the page lands, then it wakes and listens for the word, and the island at the top wakes with it. The page
 * closes on the character the hero opened with, standing in the same place, a full stop. Decorative: the h2 keeps its stop.
 */
export function InstallBlob(): ReactElement {
  const [awake, setAwake] = useState(false);
  const ch = useRef<CharacterHandle>(null);
  useEffect(() => {
    const wake = () => {
      setAwake(true);
      ch.current?.nudge();
    };
    window.addEventListener(COPIED_EVENT, wake);
    return () => window.removeEventListener(COPIED_EVENT, wake);
  }, []);
  useEffect(() => {
    claim("install", { kind: awake ? "listening" : "asleep" });
  }, [awake]);
  return <Character ref={ch} phase={awake ? "listening" : "asleep"} className="ins-char" inline />;
}
