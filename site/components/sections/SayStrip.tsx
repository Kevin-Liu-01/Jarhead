import type { JSX } from "react";
import type { SayPair } from "@/content/copy";

/** What you say, and what comes back: said in sans 15 px 500, read back in mono 12 px, a row rule between pairs. */
export function SayStrip({ head, pairs }: { readonly head: string; readonly pairs: readonly SayPair[] }): JSX.Element {
  return (
    <div className="sec-say-strip">
      <div className="sec-say-head">{head}</div>
      <ol className="sec-say-list">
        {pairs.map((p) => (
          <li className="jh-row sec-say-pair" key={p.said}>
            <span className="sec-said">{p.said}</span>
            <span className="sec-back">{p.back}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
