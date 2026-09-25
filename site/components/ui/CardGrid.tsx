import type { ReactNode } from "react";

/** The seam grid: gap 1px on a hairline ground; cells draw no border. Add `jh-flush` to run edge to edge at the rail. */
export function CardGrid({ cols, className, children }: { readonly cols: 2 | 3 | 4; readonly className?: string; readonly children?: ReactNode }) {
  return <div className={`jh-grid jh-cols-${cols}${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** A cell: ground on the seam, padding 22, an optional h3 and a mono figure line at the foot. Draws no border. */
export function Card({
  span,
  rows,
  h3,
  fig,
  className,
  children,
}: {
  readonly span?: 1 | 2 | 3;
  readonly rows?: 1 | 2;
  readonly h3?: string;
  readonly fig?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const cls = ["jh-card", span && span > 1 ? `jh-span-${span}` : "", rows === 2 ? "jh-rows-2" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {h3 ? <h3 className="jh-h3">{h3}</h3> : null}
      {children}
      {fig ? <p className="jh-fig">{fig}</p> : null}
    </div>
  );
}
