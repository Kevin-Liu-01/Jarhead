import type { CSSProperties, ReactNode } from "react";
import { PHASE_META, type DeskKind } from "@/lib/phase";

/** The phase column: dot · word · hint · face. `live` adds the 1.6 s ring; `size="desk"` stacks it for the drawn Mac. */
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
  /** A face other than the kind's own (Hands shows `> >` while acting). */
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

/** The head of a section: the eyebrow (a static PhaseColumn, else the mono label), the h2, the lead. */
export function SectionHead({
  label,
  phase,
  face,
  h2,
  lead,
}: {
  readonly label?: string;
  readonly phase?: DeskKind;
  readonly face?: string;
  readonly h2: string;
  readonly lead?: string;
}) {
  return (
    <div className="jh-sec-head">
      {phase ? <PhaseColumn kind={phase} face={face} /> : label ? <p className="jh-label">{label}</p> : null}
      <h2 className="jh-h2">{h2}</h2>
      {lead ? <p className="jh-lead">{lead}</p> : null}
    </div>
  );
}

/** One section: `<section id class="jh-sec">` with its head; the section draws its one bottom rule. */
export function Section({
  id,
  label,
  phase,
  face,
  h2,
  lead,
  className,
  children,
}: {
  readonly id: string;
  readonly label?: string;
  readonly phase?: DeskKind;
  readonly face?: string;
  readonly h2: string;
  readonly lead?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <section id={id} className={`jh-sec${className ? ` ${className}` : ""}`}>
      <SectionHead label={label} phase={phase} face={face} h2={h2} lead={lead} />
      {children}
    </section>
  );
}
