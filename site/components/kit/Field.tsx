import type { InputHTMLAttributes, ReactNode } from "react";
import { Glyph, type GlyphName } from "./Glyph";

export type FieldSize = "edit" | "filter" | "row" | "composer";

/**
 * ConsoleField's twin (ConsoleField.swift:4-7, 100-111, 177-231): a lift tile, radius 6, one hairline that turns accent
 * while focused and red (with a shake) on a rejection, never a second stroke. Heights edit 22 · filter 24 · row 26 ·
 * composer 32; sans 13 at row, 12 at edit and filter, mono 12 when `mono`. A lead glyph (the magnifier, a key) at 14;
 * trailing: a count in mono 11 titanium, or a control. The input has no border and no outline: the box wears the ring.
 */
export function Field({ size = "row", lead, mono, count, trailing, error, hint, label, className, ...input }: { readonly size?: FieldSize; readonly lead?: GlyphName; readonly mono?: boolean; readonly count?: string; readonly trailing?: ReactNode; readonly error?: boolean; readonly hint?: string; readonly label: string; readonly className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "className">) {
  const cls = ["kit-field", `kit-field--${size}`, mono ? "is-mono" : "", error ? "is-error" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <>
      <label className={cls}>
        {lead ? (
          <span className="kit-field-lead">
            <Glyph name={lead} size={14} />
          </span>
        ) : null}
        <input className="kit-field-input" aria-label={label} aria-invalid={error ? true : undefined} {...input} />
        {count ? <span className="kit-field-count">{count}</span> : null}
        {trailing}
      </label>
      {hint ? <span className={`kit-hint${error ? " is-error" : ""}`}>{hint}</span> : null}
    </>
  );
}
