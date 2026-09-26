"use client";

import type { KeyboardEvent, MouseEvent, ReactElement } from "react";

/**
 * ConsoleToggle's twin (ConsoleSegments.swift:10-11, 184-211): `On | Off`, two cells in a 60 × 22 box (29 each inside the 1 px hairline), the current
 * cell inverted, a hint beside it (≤ 4 words, sans 11 titanium) that says the consequence, never the label. One element:
 * role="switch" with aria-checked; Space and Enter flip it, ← → set it. "A word, not a blue switch."
 */
export function Toggle({ on, onChange, hint, ariaLabel, className }: { readonly on: boolean; readonly onChange: (on: boolean) => void; readonly hint?: string; readonly ariaLabel: string; readonly className?: string }): ReactElement {
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    switch (e.key) {
      case " ":
      case "Enter":
        e.preventDefault();
        onChange(!on);
        break;
      case "ArrowLeft":
        e.preventDefault();
        onChange(true);
        break;
      case "ArrowRight":
        e.preventDefault();
        onChange(false);
        break;
      case "Escape":
        e.currentTarget.blur();
        break;
      default:
    }
  };
  const onClick = (e: MouseEvent<HTMLSpanElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-on]");
    if (cell) onChange(cell.dataset["on"] === "true");
    else onChange(!on);
  };
  return (
    <span className={`kit-toggle${className ? ` ${className}` : ""}`}>
      <span role="switch" aria-checked={on} aria-label={ariaLabel} tabIndex={0} className="kit-segments kit-segments--toggle has-thumb" onKeyDown={onKeyDown} onClick={onClick}>
        <span className="kit-seg" data-on="true" data-checked={on}>
          On
        </span>
        <span className="kit-seg" data-on="false" data-checked={!on}>
          Off
        </span>
        <span className="kit-seg-thumb" aria-hidden="true" style={{ width: 29, transform: `translateX(${on ? 0 : 29}px)` }} />
      </span>
      {hint ? <span className="kit-toggle-hint">{hint}</span> : null}
    </span>
  );
}
