import type { ReactNode } from "react";
import { DitherGround } from "./DitherGround";

/**
 * The plate: one dithered band per section, flush at the rail, a hairline above and below drawn
 * by the plate alone. `ground` (default) is the Console's ground ramp, theme-aware, 3 px cells;
 * `ink` is the banner's field (ink pooling toward the accent), the same in both themes, 4 px cells.
 * Text on it stays flat; the picture inside carries its own frame hairline.
 */
export function Plate({ ink, className, children }: { readonly ink?: boolean; readonly className?: string; readonly children?: ReactNode }) {
  return (
    <div className={`sec-plate jh-flush${ink ? " is-ink" : ""}${className ? ` ${className}` : ""}`}>
      <DitherGround variant={ink ? "ink" : "ground"} cell={3} />
      <div className="sec-plate-in">{children}</div>
    </div>
  );
}
