import { Fragment, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons/Icon";
import type { SectionMeta } from "./sections";

/**
 * How a section sets its words beside its plate. `split`: the words in a narrow column beside the plate (`side` says
 * where the plate stands). `stack`: the words as one row over a plate that takes the full width. `center`: the words
 * centred over the plate. Under 1000 px every layout stacks, words first, so the visitor reads the idea, then plays it.
 */
type Layout = "split" | "stack" | "center";

/** A deck heading line held in chunks, so a short phrase never breaks inside itself; the bytes are the deck's. */
function Keep({ line }: { readonly line: string }): ReactElement {
  const chunks = line.split(/(?<=[,.]) /);
  if (chunks.length < 2) return <>{line}</>;
  return (
    <>
      {chunks.map((c, i) => (
        <Fragment key={i}>
          {i > 0 ? " " : null}
          <span className="keep">{c}</span>
        </Fragment>
      ))}
    </>
  );
}

/** The section's quiet lines: a deck line each, on a Phosphor icon in the quiet ink. */
export function Notes({ items }: { readonly items: ReadonlyArray<{ readonly icon: IconName; readonly text: string }> }): ReactElement {
  return (
    <ul className="notes" role="list">
      {items.map((it) => (
        <li key={it.text}>
          <Icon name={it.icon} size={20} className="notes-icon" />
          {it.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * One idea per screen: a section's h2 in Newsreader (one sentence on two lines, the second quieter), one short lead, at
 * most two quiet lines, and the plate where the idea is played. `h2` may be given already set (Hands steps its three
 * clauses).
 */
export function Section({
  meta,
  h2,
  lead,
  notes,
  layout = "split",
  side = "right",
  children,
}: {
  readonly meta: SectionMeta;
  readonly h2: readonly [string, string] | ReactNode;
  readonly lead?: string;
  readonly notes?: ReactNode;
  readonly layout?: Layout;
  readonly side?: "left" | "right";
  readonly children: ReactNode;
}): ReactElement {
  const style = { "--tone": `var(${meta.tone})`, "--tone-line": `var(${meta.tone}-line, var(${meta.tone}))` } as CSSProperties;
  const pair = Array.isArray(h2) && h2.length === 2 && h2.every((x) => typeof x === "string") ? (h2 as unknown as readonly [string, string]) : null;
  return (
    <section id={meta.id} className="sec" data-layout={layout} data-side={side} aria-labelledby={`${meta.id}-h`} style={style}>
      <div className="sec-in">
        <header className="sec-words">
          <h2 id={`${meta.id}-h`} className="sec-h2 rise">
            {pair ? (
              <>
                <span id={`${meta.id}-h-1`} className="sec-h2-1">
                  <Keep line={pair[0]} />
                </span>{" "}
                <span className="sec-h2-2">
                  <Keep line={pair[1]} />
                </span>
              </>
            ) : (
              (h2 as ReactNode)
            )}
          </h2>
          {lead || notes ? (
            <div className="sec-more rise">
              {lead ? <p className="sec-lead">{lead}</p> : null}
              {notes}
            </div>
          ) : null}
        </header>
        <div className="sec-stage rise">{children}</div>
      </div>
    </section>
  );
}
