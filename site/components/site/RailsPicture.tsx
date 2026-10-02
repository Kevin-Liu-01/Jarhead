import type { ReactElement } from "react";
import { ArtRails } from "@/components/art/Rails";
import { Glyph } from "@/components/kit/Glyph";
import { RAILS } from "@/content/deck";

/**
 * The Rails picture: the three verdict rails drawn in the art family, then, in the same frame under a hairline, what the
 * policy refuses outright as the Console lists it: `NEVER` and its count, the seven items in mono on the error octagon.
 * Real text, so it stays legible at every width (sized by the frame's own width) and a screen reader reads the list.
 */
export function RailsPicture(): ReactElement {
  const n = RAILS.never;
  return (
    <div className="pic pic--rails">
      <ArtRails />
      <div className="never">
        <p className="never-head">
          <span>{n.label}</span>
          <span className="never-count">{n.items.length}</span>
        </p>
        <ul className="never-list" role="list" aria-label={n.label}>
          {n.items.map((item) => (
            <li key={item}>
              <span className="never-icon">
                <Glyph name="xOctagon" size={16} />
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
