import type { ReactElement } from "react";
import Apple from "@thesvg/react/apple";
import { Icon } from "@/components/ui/Icons";

/**
 * The menu bar (design.md §4.2): 33 px, the harness's flat bar, the Apple mark from thesvg.org
 * (ICONS.md: `mono`, currentColor; never the PUA glyph), the app's own menus (App/Menus.swift: Jarhead · Edit · View · Window), the status
 * orb glyph (App/StatusItem.swift), Wi-Fi, battery and a fixed clock. Drawn, so aria-hidden.
 */
export function MenuBar(): ReactElement {
  return (
    <div className="desk-bar" aria-hidden="true">
      <Apple variant="mono" width={14} height={14} className="desk-bar-apple" aria-hidden="true" focusable="false" />
      <span className="desk-bar-app">Jarhead</span>
      <span className="desk-bar-m">Edit</span>
      <span className="desk-bar-m">View</span>
      <span className="desk-bar-m">Window</span>
      <span className="desk-bar-r">
        <span className="desk-status" />
        <Icon.wifi size={16} />
        <Icon.battery size={18} />
        <span className="desk-bar-clock">Wed 24 Sep&ensp;12:37</span>
      </span>
    </div>
  );
}
