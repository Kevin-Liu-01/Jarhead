export type BadgeTone = "rest" | "speaking" | "error";

/**
 * ConsoleBadge's twin (ConsoleBadge.swift:3-7, 52-57, 86-126): a word in a box, 16 tall, radius 6, one hairline,
 * no fill; sans 10 medium for a word, mono 10 for a figure. Tone is a second voice and only for the exceptional
 * word: amber (`speaking`) for asks · missing · off · billed, red (`error`) for failed · too big. Every resting
 * word is lowercase; `Ready` is the one capital. `width` pins a column: fit 62 · $ 46 · count 30.
 */
export function Badge({ word, figure, tone = "rest", width, className }: { readonly word?: string; readonly figure?: string; readonly tone?: BadgeTone; readonly width?: 62 | 46 | 30; readonly className?: string }) {
  const cls = ["kit-badge", figure ? "kit-badge--figure" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} data-tone={tone === "rest" ? undefined : tone} data-width={width}>
      {figure ?? word}
    </span>
  );
}
