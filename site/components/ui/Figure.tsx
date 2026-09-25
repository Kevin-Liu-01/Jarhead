import { Fragment, type JSX } from "react";

/**
 * A figure as display type: the value at 500 tabular (lg on a plate of its own, md beside a picture,
 * sm as a secondary figure), a short sans label under it, and at most one mono proof line where the
 * proof is required (a latency carries its n and date). No accent on figures.
 */
export function Figure({
  value,
  label,
  proof,
  size = "md",
  className,
}: {
  readonly value: string;
  readonly label: string;
  readonly proof?: string;
  readonly size?: "lg" | "md" | "sm";
  readonly className?: string;
}) {
  return (
    <div className={`sec-figure is-${size}${className ? ` ${className}` : ""}`}>
      <div className="sec-figure-v">{value}</div>
      <div className="sec-figure-l">
        <Segments text={label} />
      </div>
      {proof ? (
        <div className="sec-fig">
          <Segments text={proof} />
        </div>
      ) : null}
    </div>
  );
}

/** Each ` · `-joined segment held on one line, so a label or proof breaks only at the deck's joiners, never inside a date or a figure. The text stays byte-identical. */
function Segments({ text }: { readonly text: string }): JSX.Element {
  return (
    <>
      {text.split(" · ").map((seg, i) => (
        <Fragment key={i}>
          {i > 0 ? " · " : null}
          <span className="sec-seg">{seg}</span>
        </Fragment>
      ))}
    </>
  );
}
