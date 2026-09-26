/**
 * Mailroom's hatch band (globals.css:78-87; Section.tsx:5-14 ReticleSpacer): 22 px, a hairline above and below, a 45°
 * veil. `crosses` seats the four 11 × 11 registration crosses on the band's corners, centred on the rail × hairline
 * intersections: the seams between sections carry them, the header's and the footer's hatches do not. `rail` makes the
 * band its own bordered box (outside main).
 */
export function Hatch({ rail, crosses }: { readonly rail?: boolean; readonly crosses?: boolean }) {
  return (
    <div className={`jh-hatch${rail ? " jh-rail" : ""}`} aria-hidden="true">
      {crosses ? (
        <>
          <i className="jh-cross jh-cross--tl" />
          <i className="jh-cross jh-cross--tr" />
          <i className="jh-cross jh-cross--bl" />
          <i className="jh-cross jh-cross--br" />
        </>
      ) : null}
    </div>
  );
}
