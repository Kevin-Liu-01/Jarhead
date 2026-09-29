"use client";
import { useEffect, useRef, useState, type ReactElement } from "react";

/** A word that changes crossfades over --jh-drift (ConsoleTheme.swift:805-821: nothing cuts): the old word fades out under the new one. */
export function Crossfade({ text, className }: { readonly text: string; readonly className?: string }): ReactElement {
  const [pair, setPair] = useState<{ cur: string; prev: string | null; n: number }>({ cur: text, prev: null, n: 0 });
  const prevText = useRef(text);
  useEffect(() => {
    if (prevText.current === text) return;
    const old = prevText.current;
    prevText.current = text;
    setPair((p) => ({ cur: text, prev: old, n: p.n + 1 }));
  }, [text]);
  const settle = () => setPair((p) => (p.prev ? { ...p, prev: null } : p));
  return (
    <span className={`xf${className ? ` ${className}` : ""}`}>
      {pair.prev ? (
        <span key={`p${pair.n}`} className="xf-out" onAnimationEnd={settle} aria-hidden="true">
          {pair.prev}
        </span>
      ) : null}
      <span key={`c${pair.n}`} className={pair.prev ? "xf-in" : undefined}>
        {pair.cur}
      </span>
    </span>
  );
}
