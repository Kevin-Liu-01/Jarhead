import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Field } from "@/components/site/Field";

/**
 * A plate: the stage a demo is played on, and the page's colour. A white sheet with one hairline, its section's phase
 * tone ordered-dithered across it in fine cells (lib/field.ts), densest at (ax, ay) and thinning to a scatter, so the
 * dots are the imagery and the demo's pieces sit on the pale part. Without JS (or before the paint) the sheet shows flat.
 */
export function Plate({ tone, ax = 0.86, ay = 0.92, className, children }: { readonly tone: `--jh-${string}`; readonly ax?: number; readonly ay?: number; readonly className?: string; readonly children: ReactNode }): ReactElement {
  const style = { "--plate-tone": `var(${tone})` } as CSSProperties;
  return (
    <div className={`plate${className ? ` ${className}` : ""}`} style={style}>
      <Field tone={tone} ax={ax} ay={ay} ground="--jh-sheet" />
      <div className="plate-in">{children}</div>
    </div>
  );
}
