"use client";
import Apple from "@thesvg/react/apple";
import type { ReactElement } from "react";
import { ISLAND } from "@/components/desk/Island";
import { Notch } from "@/components/desk/Notch";
import { Icon } from "@/components/ui/Icons";
import { NAV } from "@/content/deck";

/** The Mac's menus, as macOS draws them after the app name (CENTER.md §1). */
const MENUS: readonly string[] = ["File", "Edit", "View", "Window", "Help"];
/** The menu bar's clock: the app's own string (the island strip's `Wed 24 Sep 12:37`; the island's foot shows the same 12:37). */
const DAY = "Wed 24 Sep";

/** The Control Center glyph (two toggles) in the kit's style: two filled pills on the 20 box with their knobs knocked out, the top one on, the lower one off. */
function ControlCenter(): ReactElement {
  return (
    <svg className="jh-icon desk-bar-cc" width={16} height={16} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.25 3.5h9.5a2.75 2.75 0 0 1 0 5.5h-9.5a2.75 2.75 0 0 1 0-5.5Zm9.5 .95a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6ZM5.25 11h9.5a2.75 2.75 0 0 1 0 5.5h-9.5a2.75 2.75 0 0 1 0-5.5Zm0 .95a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z"
      />
    </svg>
  );
}

/**
 * The menu bar (CENTER.md §1-2): 37 px edge to edge over the desktop ground, one hairline under it. Left: the Apple mark at
 * 16 from the edge, `Jarhead` in the one bold weight macOS gives the app name, the menus 16 apart (so the five fit the
 * 880 px stream at 1440 and `Help` shows; narrower streams drop them last first, styles/desk.css). Right: Control Center,
 * Wi‑Fi, the battery with its fill, the clock. The notch is cut out of it at the centre with its two fillets (desk/Notch).
 * Drawn twice: at the head of the stream over the live island (Top.tsx) and over an island render in a section's frame
 * (stream/Strip.tsx). A drawing of the Mac's own chrome, so aria-hidden. A client component: Island.tsx is a client
 * module, so its clock string is a value here and a reference in a server component.
 */
export function MenuBar(): ReactElement {
  return (
    <div className="desk-bar" aria-hidden="true">
      <Apple variant="mono" className="desk-bar-apple" aria-hidden="true" focusable="false" />
      <span className="desk-bar-app">{NAV.brand}</span>
      <span className="desk-bar-menus">
        {MENUS.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </span>
      <span className="desk-bar-r">
        <ControlCenter />
        <Icon.wifi size={16} className="desk-bar-wifi" />
        <Icon.battery size={16} />
        <span className="desk-bar-clock">
          <span className="desk-bar-day">{DAY}&ensp;</span>
          {ISLAND.footClock}
        </span>
      </span>
      <Notch />
    </div>
  );
}
