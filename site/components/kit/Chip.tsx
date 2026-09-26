import type { MouseEventHandler } from "react";

/**
 * ConsoleChip's twin (ConsoleBadge.swift:130-158): a filter chip, 22 tall, radius 6, one hairline; the word sans
 * 11 medium --jh-fg-2, a count mono 11 --jh-fg-3; on = inverted (the segments idiom). With `onToggle` it is a
 * <button aria-pressed>; a chip that is a fact and never a filter renders as a <span>.
 */
export function Chip({ word, count, on, onToggle, className }: { readonly word: string; readonly count?: string | number; readonly on?: boolean; readonly onToggle?: MouseEventHandler<HTMLButtonElement>; readonly className?: string }) {
  const cls = `kit-chip${className ? ` ${className}` : ""}`;
  const inner = (
    <>
      {word}
      {count !== undefined ? <span className="kit-chip-count">{count}</span> : null}
    </>
  );
  if (onToggle) {
    return (
      <button type="button" className={cls} aria-pressed={Boolean(on)} onClick={onToggle}>
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} aria-pressed={on ? true : undefined}>
      {inner}
    </span>
  );
}
