import type { ReactElement } from "react";
import { Mark } from "@/components/Mark";

/**
 * JarheadMark's twin (BrandMarks.swift:438-465): the faceless orb on the diagonal ramp, five bands, 1 px cells,
 * the paper highlight; 14 in the icon column, 20 in the nav, 24 in a head. `quiet` wears the titanium ramp for a
 * conversation that is over (Dither.swift:67-78). Reuses components/Mark.tsx (an inline PNG, right at SSR).
 * Decorative by default; `label` names it ("Jarhead" · "Jarhead, over").
 */
export function JarheadMark({ size = 14, quiet, label, className }: { readonly size?: 14 | 20 | 24; readonly quiet?: boolean; readonly label?: boolean; readonly className?: string }): ReactElement {
  const img = <Mark size={size} quiet={quiet} className={`kit-mark${className ? ` ${className}` : ""}`} />;
  if (!label) return img;
  return (
    <span role="img" aria-label={quiet ? "Jarhead, over" : "Jarhead"} style={{ display: "contents" }}>
      {img}
    </span>
  );
}
