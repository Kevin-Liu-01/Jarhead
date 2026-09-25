import type { JSX } from "react";
import type { FacePair } from "@/content/copy";

/** The gate's faces drawn large: mono 500 pairs over mono 11 px labels. The glyph pair is hidden from readers; the label carries the meaning. */
export function Faces({ items }: { readonly items: readonly FacePair[] }): JSX.Element {
  return (
    <ul className="sec-faces">
      {items.map((f) => (
        <li className="sec-face" key={f.label}>
          <span className="sec-face-eyes" aria-hidden="true">{f.face}</span>
          <span className="sec-face-l">{f.label}</span>
        </li>
      ))}
    </ul>
  );
}
