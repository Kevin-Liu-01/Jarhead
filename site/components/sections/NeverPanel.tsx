import { Fragment, type JSX } from "react";

/** The never-list on the plate: the same ink in both themes. */
export function NeverPanel({ label, list, line }: { readonly label: string; readonly list: readonly string[]; readonly line: string }): JSX.Element {
  return (
    <div className="sec-never">
      <div className="sec-never-k">{label}</div>
      <p className="sec-never-list">
        {list.map((item, i) => (
          <Fragment key={item}>
            {i > 0 ? <span className="sec-never-dot" aria-hidden="true"> · </span> : null}
            <span className="sec-never-item">{item}</span>
          </Fragment>
        ))}
      </p>
      <p className="sec-never-p">{line}</p>
    </div>
  );
}
