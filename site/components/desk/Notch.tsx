import type { ReactElement } from "react";

/**
 * The notch column (185 × 32 at the top centre, NotchPanel.swift header) drawn through the bar so
 * it joins the island or the lip without a seam, plus the two 14 px concave fillets that belong to
 * the island's top edge (NotchInk.swift:45-51); the lip carries the notch's 12 px bottom radius.
 */
export function Notch(): ReactElement {
  return (
    <>
      <div className="desk-notch" aria-hidden="true" />
      <div className="desk-fillet desk-fillet-l" aria-hidden="true" />
      <div className="desk-fillet desk-fillet-r" aria-hidden="true" />
    </>
  );
}
