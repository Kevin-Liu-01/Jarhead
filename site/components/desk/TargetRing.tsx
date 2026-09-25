import type { ReactElement } from "react";

/** The acting target: a 2 px ring 32 px across in --jh-acting with a 4 px centre dot (blob-fly.png, notch-stay.png). */
export function TargetRing(): ReactElement {
  return <div className="desk-ring" aria-hidden="true" />;
}
