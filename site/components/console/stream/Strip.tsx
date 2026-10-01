import type { ReactElement } from "react";
import { MenuBar } from "../MenuBar";
import type { Shot } from "./parts";

/**
 * An island render under the drawn Mac top edge, filling a section's frame (CENTER.md "Sections": the island strips at
 * the frame's width). The harness PNGs are 920 × 500 at 2× with a bare 33 px bar and the notch cut out of it; the menu bar
 * the dock draws sits over the render's own, edge to edge like the dock in the stream, and the two scale as one to the
 * frame's width (--bar-s, 1.5× at most) so the island stays whole; the render's own ground fills the rest of the frame and
 * reads as the desktop, not as margin. Inside a Pic, so the alt is the caption's.
 */
export function Strip({ shot }: { readonly shot: Shot }): ReactElement {
  return (
    <div className="strip">
      <div className="strip-bar">
        <MenuBar />
      </div>
      <img className="strip-img" src={shot.src} alt="" width={shot.width} height={shot.height} decoding="async" loading="lazy" />
    </div>
  );
}
