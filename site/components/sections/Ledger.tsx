import type { JSX } from "react";
import type { LedgerRow } from "@/content/copy";

/**
 * A ledger: rows of [mono index] · title · line · [mono value]. The row owns its rule (.jh-row).
 * article: the title over its line (the rails). table: title · line · value side by side (brains, costs).
 * figure: title · mono value (numbers).
 */
export function Ledger({ rows, variant = "article", className }: {
  readonly rows: readonly LedgerRow[];
  readonly variant?: "article" | "table" | "figure";
  readonly className?: string;
}): JSX.Element {
  const cls = ["sec-ledger", `sec-ledger--${variant}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {rows.map((r) => {
        const rowCls = ["jh-row", "sec-row", r.n ? "sec-row--n" : "", r.value ? "sec-row--v" : "", r.p ? "sec-row--p" : ""].filter(Boolean).join(" ");
        return (
          <div className={rowCls} key={`${r.n ?? ""}${r.title}`}>
            {r.n ? <span className="sec-row-n">{r.n}</span> : null}
            <h3 className={r.mono ? "sec-row-h3 sec-row-h3--mono" : "sec-row-h3"}>{r.title}</h3>
            {r.p ? <p className="sec-row-p">{r.p}</p> : null}
            {r.value ? <span className="sec-row-v">{r.value}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
