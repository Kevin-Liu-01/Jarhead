import type { ReactNode } from "react";

/**
 * Mailroom's figure frame (SearchDiagram / TrashDiagram; MAILROOM.md §1.3-1.4, §6 take 8): the raised card at p-0,
 * a head row (a pill left, a fact right), a body of inner panels on the ground (the picture beside the rows, or stacked),
 * an optional foot strip. The product shown as the product, framed and labelled.
 */
export function Figure({ head, foot, stack, className, children }: { readonly head?: ReactNode; readonly foot?: ReactNode; readonly stack?: boolean; readonly className?: string; readonly children: ReactNode }) {
  return (
    <figure className={`mr-figure${className ? ` ${className}` : ""}`}>
      {head ? <div className="mr-figure-head">{head}</div> : null}
      <div className={`mr-figure-body${stack ? " mr-figure-body--stack" : ""}`}>{children}</div>
      {foot ? <figcaption className="mr-figure-foot">{foot}</figcaption> : null}
    </figure>
  );
}

/** A fact at the right of a figure's head: the figure in the ink, the words in the lead's grey (TrashDiagram's "Reclaimable 382 messages"). */
export function Fact({ value, label }: { readonly value: string; readonly label: string }) {
  return (
    <span className="mr-fact">
      <b>{value}</b> {label}
    </span>
  );
}
