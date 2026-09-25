import type { CSSProperties, ReactNode } from "react";
import { Lines, type Line } from "@/components/sections/Lines";
import { PHASE_META, type DeskKind } from "@/lib/phase";

/** The phase column: dot · word · hint · face. `live` adds the 1.6 s ring; `size="desk"` stacks it for the drawn Mac. The desk is its only home. */
export function PhaseColumn({
  kind,
  live,
  size = "eyebrow",
  face,
  className,
}: {
  readonly kind: DeskKind;
  readonly live?: boolean;
  readonly size?: "eyebrow" | "desk";
  /** A face other than the kind's own. */
  readonly face?: string;
  readonly className?: string;
}) {
  const meta = PHASE_META[kind];
  const style = { "--jh-phase": `var(${meta.token})` } as CSSProperties;
  return (
    <div className={`jh-phase${size === "desk" ? " is-desk" : ""}${className ? ` ${className}` : ""}`} style={style} data-kind={kind}>
      <span className={`jh-phase-dot${live ? " is-live" : ""}`} aria-hidden="true" />
      <span className="jh-phase-word">{meta.label}</span>
      <span className="jh-phase-sep" aria-hidden="true">·</span>
      <span className="jh-phase-hint">{meta.hint}</span>
      <span className="jh-phase-sep" aria-hidden="true">·</span>
      <span className="jh-phase-face" role="img" aria-label={`face ${face ?? meta.face}`}>{face ?? meta.face}</span>
    </div>
  );
}

/**
 * One section of the ruled rail: the head row (the h2 at the left with, for a story section, the
 * phase as one 9 px dot in the margin, decoration the reader never hears; the lead and at most three
 * short lines on a filled-glyph column at the right), then the children: the plate, which closes the
 * section. No eyebrow, no label.
 */
export function Section({
  id,
  h2,
  lead,
  lines,
  phase,
  className,
  children,
}: {
  readonly id: string;
  readonly h2: string;
  readonly lead?: string;
  readonly lines?: readonly Line[];
  readonly phase?: DeskKind;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const dotStyle = phase ? ({ "--jh-phase": `var(${PHASE_META[phase].token})` } as CSSProperties) : undefined;
  return (
    <section id={id} className={`jh-sec${className ? ` ${className}` : ""}`}>
      <div className="sec-head">
        <h2 className="sec-h2">
          {phase ? <span className="sec-dot" style={dotStyle} aria-hidden="true" /> : null}
          {h2}
        </h2>
        <div className="sec-copy">
          {lead ? <p className="sec-lead">{lead}</p> : null}
          {lines && lines.length > 0 ? <Lines items={lines} /> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
