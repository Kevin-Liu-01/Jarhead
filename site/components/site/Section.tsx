import { Fragment, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Glyph, type GlyphName } from "@/components/kit/Glyph";
import { Field } from "./Field";
import type { SectionMeta } from "./sections";

/**
 * A heading line typeset so a short chunk never breaks inside itself (`Claude Code,` and `Click second.` stay whole): the
 * deck string is split after each comma or full stop and rejoined with the same space, so the words are byte for byte the
 * deck's.
 */
function Keep({ line }: { readonly line: string }): ReactElement {
  const chunks = line.split(/(?<=[,.]) /);
  if (chunks.length < 2) return <>{line}</>;
  return (
    <>
      {chunks.map((c, i) => (
        <Fragment key={i}>
          {i > 0 ? " " : null}
          <span className={c.length <= 14 ? "keep" : undefined}>{c}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * A section: one question answered. On its own full-bleed ground, its phase tone dithered over the page ground and rising
 * behind the picture; the words on one side (the h2 in two lines, the second quieter; one short lead; what else the
 * section needs), the picture on the other, big. Under 960 px the picture comes first and the two stack.
 */
export function Section({ meta, h2, lead, pic, children }: { readonly meta: SectionMeta; readonly h2: readonly [string, string]; readonly lead?: string; readonly pic: ReactNode; readonly children?: ReactNode }): ReactElement {
  const style = { "--tone": `var(${meta.tone})` } as CSSProperties;
  return (
    <section id={meta.id} className="sec" data-pic={meta.pic} aria-labelledby={`${meta.id}-h`} style={style}>
      <Field tone={meta.tone} ax={meta.pic === "right" ? 0.7 : 0.3} ay={0.56} />
      <div className="sec-in">
        <div className="sec-words rise">
          <h2 id={`${meta.id}-h`} className="sec-h2">
            <span>
              <Keep line={h2[0]} />
            </span>{" "}
            <span className="sec-h2-2">
              <Keep line={h2[1]} />
            </span>
          </h2>
          {lead ? <p className="sec-lead">{lead}</p> : null}
          {children}
        </div>
        <div className="sec-pic rise">{pic}</div>
      </div>
    </section>
  );
}

/** A drawing in its frame: the raised plate the art family stands on, one frame hairline. */
export function Pic({ children }: { readonly children: ReactNode }): ReactElement {
  return <div className="pic">{children}</div>;
}

/** A section's short lines: the kit glyph in the section's tone on the 20 column, the line beside it. */
export function Lines({ items }: { readonly items: ReadonlyArray<{ readonly glyph: GlyphName; readonly text: string }> }): ReactElement {
  return (
    <ul className="lines" role="list">
      {items.map((it) => (
        <li key={it.text}>
          <span className="lines-icon">
            <Glyph name={it.glyph} size={20} />
          </span>
          {it.text}
        </li>
      ))}
    </ul>
  );
}
