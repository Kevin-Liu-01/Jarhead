import type { JSX } from "react";
import { Icon, type IconName } from "@/components/ui/Icons";

export interface Line {
  /** A filled glyph on the 20 px column, in place of a word that would be redundant. */
  readonly glyph: IconName;
  readonly text: string;
}

/** At most three short lines beside the head: a fixed filled-glyph column, the words at 500, no rules between them. */
export function Lines({ items, className }: { readonly items: readonly Line[]; readonly className?: string }): JSX.Element {
  return (
    <ul className={`sec-lines${className ? ` ${className}` : ""}`}>
      {items.slice(0, 3).map((l) => {
        const G = Icon[l.glyph];
        return (
          <li key={l.text} className="sec-line">
            <span className="sec-line-g">
              <G size={16} />
            </span>
            <span className="sec-line-t">{l.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
