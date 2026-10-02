import type { ReactElement } from "react";

/**
 * ConsoleBadge's twin (ConsoleBadge.swift:3-7, 86-126): a word in a box, 16 tall, radius 6, one hairline, no fill, sans 10
 * medium. Tone is a second voice for the exceptional word alone: amber (`speaking`) for asks. Every resting word is lowercase.
 */
export function Badge({ word, tone = "rest" }: { readonly word: string; readonly tone?: "rest" | "speaking" }): ReactElement {
  return (
    <span className="kit-badge" data-tone={tone === "rest" ? undefined : tone}>
      {word}
    </span>
  );
}
