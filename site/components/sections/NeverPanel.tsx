import type { JSX } from "react";

/** The never-list set like the standing orders: the plate's own label, seven short lines, the one line under them. */
export function NeverPanel({ label, list, line }: { readonly label: string; readonly list: readonly string[]; readonly line: string }): JSX.Element {
  return (
    <div className="sec-never">
      <div className="sec-never-k">{label}</div>
      <ol className="sec-never-list">
        {list.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <p className="sec-never-p">{line}</p>
    </div>
  );
}
