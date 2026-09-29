import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Glyph, JarheadMark, Tip, type GlyphName, type TipCard } from "@/components/kit";
import { PHASES, type Figure } from "@/content/deck";
import { PHASE_META, type DeskKind } from "@/lib/phase";

/**
 * The Now stream's pieces (StreamView.swift; console-threads.jpg, console-jarhead.jpg): a conversation's title row
 * with its orb and the phase at the right, the two-line head at the Console's scale, the delegation card (one hairline
 * box aligned to the icon column, row-weight rules inside), the capture frame, the ledger row whose left column holds
 * the figure the way the app's holds the clock, and the ledger banner strip.
 */

/**
 * A section: the conversation's title row (orb · name · n · the phase as a dot, its face and its word), the h2 (its second
 * line in the quiet step only where COPY.md marks it *grey*), the lead, the rows; `rail` is the conversation's right-rail
 * group, which a phone folds in here (the desktop's rail shows it beside the stream: RightRail.tsx).
 */
export function Sec({ id, name, n, phase, face, h2, grey = true, lead, label, rail, children }: { readonly id: string; readonly name: string; readonly n?: string; readonly phase?: DeskKind; readonly face?: string; readonly h2: readonly [string, string]; readonly grey?: boolean; readonly lead?: ReactNode; readonly label?: string; readonly rail?: ReactNode; readonly children: ReactNode }): ReactElement {
  const dot = phase ? ({ "--kit-phase": `var(${PHASE_META[phase].token})` } as CSSProperties) : undefined;
  return (
    <section id={id} className="sec" data-sec="" aria-labelledby={`${id}-h`}>
      <div className="sec-title">
        <JarheadMark size={14} />
        <span className="sec-name">{name}</span>
        {n ? <span className="sec-n">{n}</span> : null}
        {label ? <span className="sec-label">{label}</span> : null}
        {phase ? (
          <span className="sec-phase">
            <span className="kit-dot" style={dot} aria-hidden="true" />
            {face ? (
              <span className="kit-seg-face sec-face" aria-hidden="true">
                {face}
              </span>
            ) : null}
            <span>{PHASES[phase].word}</span>
          </span>
        ) : null}
      </div>
      <h2 id={`${id}-h`} className="sec-h2">
        {h2[0]}
        <br />
        {grey ? <span className="sec-grey">{h2[1]}</span> : h2[1]}
      </h2>
      {lead ? <p className="sec-lead">{lead}</p> : null}
      {children}
      {rail ? <div className="sec-rail">{rail}</div> : null}
    </section>
  );
}

/** A status glyph on the icon column in its tone (ConsoleTheme.swift:149-229): acting for done, speaking for waiting, error for refused. */
export function Tone({ name, tone }: { readonly name: GlyphName; readonly tone?: "acting" | "speaking" | "error" | "listening" }): ReactElement {
  return (
    <span className={`tone${tone ? ` tone--${tone}` : ""}`}>
      <Glyph name={name} size={16} />
    </span>
  );
}

/** The provenance card for a figure: the value as the title, the label as its status word, the tooltip as one line, verbatim (COPY.md's tooltip column). */
export function figureCard(f: Figure): TipCard {
  return { title: f.value, status: f.label, lines: [f.tip] };
}

/** The delegation card: a head row, an optional chip line, rows, a foot row. */
export function Card({ icon, title, value, chips, foot, className, children }: { readonly icon?: ReactNode; readonly title?: ReactNode; readonly value?: string; readonly chips?: ReactNode; readonly foot?: ReactNode; readonly className?: string; readonly children?: ReactNode }): ReactElement {
  return (
    <div className={`card${className ? ` ${className}` : ""}`}>
      {title ? (
        <div className="card-head">
          {icon ? <span className="kit-icon">{icon}</span> : null}
          <span className="card-title">{title}</span>
          {value ? <span className="card-mono">{value}</span> : null}
        </div>
      ) : null}
      {chips ? <div className="card-chips">{chips}</div> : null}
      {children ? (
        <ul role="list" className="kit-rows card-rows">
          {children}
        </ul>
      ) : null}
      {foot ? <div className="card-foot">{foot}</div> : null}
    </div>
  );
}

/** A capture in a drawn frame: the frame weight around pictures only, the screen's own baked ground behind. */
export function Frame({ className, width, children }: { readonly className?: string; readonly width?: number; readonly children: ReactNode }): ReactElement {
  return (
    <figure className={`frame${className ? ` ${className}` : ""}`} style={width ? { width } : undefined}>
      {children}
    </figure>
  );
}

/** A ledger row: the figure in the left column (the app's clock column), the row's own glyph on the icon column, the label; the card tip carries n and date. */
export function LRow({ figure, glyph, meta }: { readonly figure: Figure; readonly glyph: GlyphName; readonly meta?: ReactNode }): ReactElement {
  return (
    <li className="kit-row kit-row--13 ld-row is-acting">
      <Tip card={figureCard(figure)}>
        <button type="button" className="kit-row-act" aria-label={`${figure.value} · ${figure.label}`} />
      </Tip>
      <span className="ld-v">{figure.value}</span>
      <span className="kit-row-icon">
        <Glyph name={glyph} size={16} />
      </span>
      <span className="kit-row-main">
        <span className="kit-row-line">
          <span className="kit-row-title">{figure.label}</span>
        </span>
        {meta ? <span className="kit-row-meta">{meta}</span> : null}
      </span>
    </li>
  );
}

/** The ledger's lead figure (Numbers): the value at mono 28 with its label under it, ahead of the rows; the same card tip. */
export function LeadFigure({ figure }: { readonly figure: Figure }): ReactElement {
  return (
    <Tip card={figureCard(figure)}>
      <button type="button" className="ld-lead" aria-label={`${figure.value} · ${figure.label}`}>
        <span className="ld-lead-v">{figure.value}</span>
        <span className="ld-lead-l">{figure.label}</span>
      </button>
    </Tip>
  );
}

/** The ledger banner (StreamView.swift: "ledger banner"; console-jarhead.jpg's `started 14:16:01 · ran 34:00 · …` strip): mono 11 on the raised strip. */
export function Banner({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactElement {
  return <div className={`banner${className ? ` ${className}` : ""}`}>{children}</div>;
}
