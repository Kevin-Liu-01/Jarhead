import type { ReactNode } from "react";

/**
 * One section of the rail (SPACE.md, AIR): the h2 alone, the lead under it at a readable measure, then the
 * children: one plate holding a picture and kit rows. s9 above, s8 below, one rule. No eyebrow, no dot, no
 * head lines, no hatch.
 */
export function Section({ id, h2, lead, className, children }: { readonly id: string; readonly h2: string; readonly lead?: string; readonly className?: string; readonly children?: ReactNode }) {
  return (
    <section id={id} className={`sec${className ? ` ${className}` : ""}`}>
      <div className="sec-head">
        <h2 className="sec-h2">{h2}</h2>
        {lead ? <p className="sec-lead">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}
