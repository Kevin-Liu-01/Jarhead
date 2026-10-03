import type { ReactElement } from "react";
import { ICON_BOX, ICONS, type IconName } from "./paths";

export type { IconName } from "./paths";

/**
 * One Phosphor Fill icon (components/icons/paths.ts) as an inline svg in currentColor. Decorative by default: the words
 * beside it carry the meaning; pass `label` when the icon stands alone. Sizes: 12 and 14 in the island (drawn at 1:1 and
 * scaled with it), 16 in a control, 20 on a section line, 24 and 32 in a figure.
 */
export function Icon({ name, size = 20, label, className }: { readonly name: IconName; readonly size?: 12 | 14 | 16 | 20 | 24 | 32; readonly label?: string; readonly className?: string }): ReactElement {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const, focusable: "false" as const };
  return (
    <svg className={`jh-ico${className ? ` ${className}` : ""}`} width={size} height={size} viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`} fill="currentColor" {...a11y}>
      <path d={ICONS[name]} />
    </svg>
  );
}
