import type { AriaAttributes, MouseEventHandler, ReactNode } from "react";
import { Glyph, type GlyphName } from "./Glyph";

export type ButtonKind = "ghost" | "plain" | "primary" | "danger" | "spent";
export type ButtonSize = 40 | 32 | 28 | 26 | 24 | 22 | 20 | 18;

export interface ButtonProps extends AriaAttributes {
  /**
   * ghost = a tile plus a hairline · plain = nothing but its glyph · primary = the accent · danger = the red · spent = grey, its deed
   * done (ConsoleButton.swift:4-10). On the site `danger` carries no word: white on the red reads 2.99:1, so a danger button is
   * icon-only at 24 or more, and a refusal shows as the error tone on a glyph plus a badge (README, Contrast).
   */
  readonly kind: ButtonKind;
  /** The height (ConsoleButton.swift:17; the sizes in use). ≤ 26 is `small`: an 11 px label, 8 px of padding; 40 is the site's hero call (a 13 px label, 14 px of padding), the phone's tap floor. */
  readonly size?: ButtonSize;
  readonly glyph?: GlyphName;
  /** A mark in the glyph's place that is not a kit glyph: a brand from @thesvg/react (ICONS.md), 16 px, currentColor. */
  readonly icon?: ReactNode;
  /** A word that will replace the label (Copy → Copied): the button keeps one width through the change. */
  readonly hold?: string;
  readonly href?: string;
  readonly onClick?: MouseEventHandler<HTMLElement>;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly title?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * ConsoleButton's twin (ConsoleButton.swift:28-63, 113-144): five kinds, one rule; the tile from ConsoleFill's
 * rest(on:) through --kit-lift; hover and press as a wash over it. Words 12 medium (11 small), padding 10 (8),
 * radius 6; an icon-only button is a square and carries its name in ariaLabel. An href renders <a>.
 */
export function Button({ kind, size = 28, glyph, icon, hold, href, onClick, disabled, pressed, ariaLabel, id, title, className, children, ...aria }: ButtonProps) {
  const small = size <= 26;
  const large = size >= 40;
  const iconOnly = Boolean(glyph || icon) && !children;
  const cls = ["kit-btn", `kit-btn--${kind}`, small ? "kit-btn--sm" : "", large ? "kit-btn--lg" : "", iconOnly ? "kit-btn--icon" : "", className ?? ""].filter(Boolean).join(" ");
  const style = size === 28 ? undefined : ({ "--kit-h": `${size}px` } as React.CSSProperties);
  const label = hold ? (
    <span className="kit-btn-hold">
      <span aria-live="polite">{children}</span>
      <span aria-hidden="true">{hold}</span>
    </span>
  ) : children ? (
    <span className="kit-btn-label">{children}</span>
  ) : null;
  const inner = (
    <>
      {glyph ? <Glyph name={glyph} size={small ? 14 : 16} /> : icon}
      {label}
    </>
  );
  if (href && !disabled) {
    const external = /^https?:/.test(href);
    return (
      <a className={cls} style={style} href={href} id={id} title={title} aria-label={ariaLabel} onClick={onClick} rel={external ? "noopener" : undefined} {...aria}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={cls} style={style} id={id} title={title} aria-label={ariaLabel} aria-pressed={pressed} disabled={disabled} onClick={onClick} {...aria}>
      {inner}
    </button>
  );
}
