import type { ReactElement } from "react";

/**
 * The MIT licence as MIT's own mark, the one Glyphfield sets (glyphfield/src/components/MitLogo.tsx): the bars, in the
 * line's colour. The word is laid over it as text, transparent and selectable, so a selection across the mark highlights
 * it and a copy gives "MIT"; a screen reader reads the word, a pointer resting on it shows it. The bars are aria-hidden.
 */
export function MitMark({ word = "MIT", className }: { readonly word?: string; readonly className?: string }): ReactElement {
  return (
    <span className={className ? `mit ${className}` : "mit"} title={word}>
      <svg className="mit-bars" aria-hidden="true" focusable="false" viewBox="160 159 1360 720">
        <path
          d="M880 879.252h160v-480H880v480Zm240-560h400v-160h-400v160Zm-240-160h160v160H880v-160Zm-240 720h160v-720H640v720Zm-240-160h160v-560H400v560Zm-240 160h160v-720H160v720Zm960 0h160v-480h-160v480Z"
          fill="currentColor"
        />
      </svg>
      <span className="mit-word">{word}</span>
    </span>
  );
}
