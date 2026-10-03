import type { CSSProperties, MouseEventHandler, ReactElement, ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons/Icon";

/** primary = the accent · ghost = a tile plus a hairline · spent = grey, its deed done (ConsoleButton.swift:4-10). */
export type ButtonKind = "ghost" | "primary" | "spent";
/** The heights in use: 40 is the one-liner's Copy and the phone's tap floor, 32 a command row's. */
export type ButtonSize = 40 | 32;

/**
 * ConsoleButton's twin (ConsoleButton.swift:28-63, 113-144), cut to the kinds the page uses: the tile from --kit-lift, hover
 * and press as a wash over it; words 12 medium (13 at 40), padding 10 (14), radius 6, a Phosphor Fill icon at 16 before the
 * word. `hold` keeps one width while the word changes (Copy → Copied); the visible word sits in a polite live region.
 */
export function Button({ kind, size = 32, icon, hold, onClick, ariaLabel, children }: { readonly kind: ButtonKind; readonly size?: ButtonSize; readonly icon?: IconName; readonly hold?: string; readonly onClick?: MouseEventHandler<HTMLButtonElement>; readonly ariaLabel?: string; readonly children?: ReactNode }): ReactElement {
  const cls = ["kit-btn", `kit-btn--${kind}`, size === 40 ? "kit-btn--lg" : ""].filter(Boolean).join(" ");
  const label = hold ? (
    <span className="kit-btn-hold">
      <span aria-live="polite">{children}</span>
      <span aria-hidden="true">{hold}</span>
    </span>
  ) : (
    children
  );
  return (
    <button type="button" className={cls} style={{ "--kit-h": `${size}px` } as CSSProperties} aria-label={ariaLabel} onClick={onClick}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {label}
    </button>
  );
}
