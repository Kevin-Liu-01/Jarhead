import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "./Badge";
import { Glyph } from "./Glyph";
import { Tip, type TipProps } from "./Tip";

export interface RowBadge {
  readonly word?: string;
  readonly figure?: string;
  readonly tone?: BadgeTone;
  readonly width?: 62 | 46 | 30;
}

export interface RowProps {
  /** What sits in the 20 column: a Glyph, an AgentMark, a JarheadMark, a dot. Titanium by default. */
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  /** An id or a path: mono (ConsoleRow.swift:243-246). */
  readonly mono?: boolean;
  /** 12 by default; 13 on the agents rail. */
  readonly size?: 12 | 13;
  readonly badge?: RowBadge;
  /** Mono 11 titanium, at the right of the line. */
  readonly value?: string;
  /** The meta line under the title: mono 11 --jh-fg-3, 14 tall; a Meter may sit in it. */
  readonly meta?: ReactNode;
  /** The controls at the top-trailing: a ghost verb (wrap it in `.kit-row-verb`), the ⋯, a status glyph. */
  readonly trailing?: ReactNode;
  /** An inline chevron after the value (a row that opens). */
  readonly chevron?: boolean;
  /** An acting row as a link: the cover under the parts. */
  readonly href?: string;
  /** An acting row as a button: pass a client `<button className="kit-row-act" aria-label=…>` and it goes under the parts. */
  readonly act?: ReactNode;
  /**
   * The row's story as a ConsoleTip (ConsoleRow.swift:207-211: the hint is the card's spoken form): the whole row is the
   * trigger, through a focusable cover under the parts, so the tip shows on hover anywhere on the row, on a keyboard
   * focus, and held on a touch tap (the cover's one job is the tip). The trailing controls keep their own pointer.
   */
  readonly tip?: Pick<TipProps, "line" | "keyCap" | "card" | "side">;
  readonly selected?: boolean;
  readonly hover?: boolean;
  readonly open?: boolean;
  readonly disabled?: boolean;
  readonly sitsBack?: boolean;
  readonly describedBy?: string;
  readonly as?: "li" | "div";
  readonly className?: string;
}

/**
 * ConsoleRow's twin (ConsoleRow.swift:4-5, 188-385): icon column 20 · title (+ badge … value, an inline chevron) ·
 * the meta line; 28 tall for one line, 40 with a meta line; padding 12 / 4. Hairlines between rows are drawn once by
 * `.kit-row + .kit-row`; the group's outer rule belongs to the plate. Selected = --jh-active plus the 2 px accent
 * bar inset 4; hover = --jh-hover; a hovered or selected row lifts its trailing controls to the raised tile.
 */
export function Row({ icon, title, mono, size = 12, badge, value, meta, trailing, chevron, href, act, tip, selected, hover, open, disabled, sitsBack, describedBy, as: Tag = "li", className }: RowProps) {
  const acting = Boolean(href || act || tip);
  const cls = [
    "kit-row",
    size === 13 ? "kit-row--13" : "",
    acting ? "is-acting" : "",
    selected ? "is-selected" : "",
    hover ? "is-hover" : "",
    open ? "is-open" : "",
    sitsBack ? "sits-back" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const name = typeof title === "string" ? title : undefined;
  const cover = href ? (
    <a className="kit-row-act" href={href} aria-label={name} rel={/^https?:/.test(href) ? "noopener" : undefined} />
  ) : act ? (
    act
  ) : tip ? (
    <Tip {...tip} tap>
      <button type="button" className="kit-row-act" aria-label={name} />
    </Tip>
  ) : null;
  return (
    <Tag className={cls} aria-disabled={disabled ? true : undefined} aria-selected={selected ? true : undefined} aria-describedby={describedBy}>
      {cover}
      <span className="kit-row-icon">{icon}</span>
      <span className="kit-row-main">
        <span className="kit-row-line">
          <span className={`kit-row-title${mono ? " is-mono" : ""}`}>{title}</span>
          {badge ? <Badge className="kit-row-badge" word={badge.word} figure={badge.figure} tone={badge.tone} width={badge.width} /> : null}
          {value ? <span className="kit-row-value">{value}</span> : null}
        </span>
        {meta ? <span className="kit-row-meta">{meta}</span> : null}
      </span>
      {trailing || chevron ? (
        <span className="kit-row-trailing">
          {trailing}
          {chevron ? (
            <span className="kit-row-chevron">
              <Glyph name="chevron" size={14} />
            </span>
          ) : null}
        </span>
      ) : null}
    </Tag>
  );
}

/** A group: an optional head, then the rows as a list. `raised` flags the surface for the controls inside (ConsoleFill.swift:12-13). */
export function Group({ head, raised, className, children }: { readonly head?: ReactNode; readonly raised?: boolean; readonly className?: string; readonly children: ReactNode }) {
  return (
    <section className={`kit-group${raised ? " kit-raised" : ""}${className ? ` ${className}` : ""}`}>
      {head}
      <ul role="list" className="kit-rows">
        {children}
      </ul>
    </section>
  );
}
