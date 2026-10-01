import type { CSSProperties, ReactElement, ReactNode } from "react";
import { Glyph, JarheadMark, Tip, type GlyphName, type TipCard } from "@/components/kit";
import type { Figure } from "@/content/deck";

/**
 * The Now stream's pieces (StreamView.swift; console-threads.jpg, console-jarhead.jpg; CENTER.md "Sections"): a conversation's
 * title row with its orb, name and number, the two columns under it (the words beside the one framed picture, the picture
 * side alternating), the two-line head at the Console's scale, the 4:3 frame every picture fills, a render covering it or a
 * capture cropped to the region the section is about, the one-line caption, the ledger row whose left column holds the
 * figure the way the app's holds the clock, and the ledger banner strip.
 */

export type Side = "left" | "right";

/**
 * A section: the title row (orb · name · number, or the conversation's label where it has no number) over two columns: the
 * words (the h2, its second line in the quiet step only where COPY.md marks it *grey*; the lead; the rows) and the one picture
 * on the side the section names; `rail` is the conversation's right-rail group, which a phone folds in here.
 */
export function Sec({ id, name, n, h2, grey = true, lead, label, side, pic, rail, children }: { readonly id: string; readonly name: string; readonly n?: string; readonly h2: readonly [string, string]; readonly grey?: boolean; readonly lead?: ReactNode; readonly label?: string; readonly side: Side; readonly pic: ReactNode; readonly rail?: ReactNode; readonly children: ReactNode }): ReactElement {
  return (
    <section id={id} className="sec" data-sec="" data-side={side} aria-labelledby={`${id}-h`}>
      <div className="sec-title">
        <JarheadMark size={14} />
        <span className="sec-name">{name}</span>
        {n ? <span className="sec-n">{n}</span> : null}
        {label ? <span className="sec-label">{label}</span> : null}
      </div>
      <div className="sec-grid">
        <div className="sec-words">
          <h2 id={`${id}-h`} className="sec-h2">
            {h2[0]}
            <br />
            {grey ? <span className="sec-grey">{h2[1]}</span> : h2[1]}
          </h2>
          {lead ? <p className="sec-lead">{lead}</p> : null}
          {children}
        </div>
        <div className="sec-pic">{pic}</div>
      </div>
      {rail ? <div className="sec-rail">{rail}</div> : null}
    </section>
  );
}

/** A status glyph on the icon column in its tone (ConsoleTheme.swift:149-229): acting for done, speaking for waiting, error for refused. */
export function Tone({ name, tone }: { readonly name: GlyphName; readonly tone?: "acting" | "speaking" | "error" | "listening" }): ReactElement {
  return (
    <span className={`tone${tone ? ` tone--${tone}` : ""}`}>
      <Glyph name={name} size={16} />
    </span>
  );
}

/** The provenance card for a figure: the value as the title, the label as its status word, the tooltip as one line, verbatim (COPY.md's tooltip column). */
export function figureCard(f: Figure): TipCard {
  return { title: f.value, status: f.label, lines: [f.tip] };
}

export interface Shot {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The section's one picture (CENTER.md): a 4:3 frame with the same chrome everywhere (1 px --jh-hair-frame, radius 8, the
 * raised ground inside) that its picture fills, and the one-line caption under it from the deck's alt list. `strip` marks an
 * island strip (stream/Strip.tsx), whose ground inside the chrome is the render's own. `win` widens the design width a Cut
 * is composed for (console.css --pic-win, 397 at 1440) so the frame scales that one window down as one instead of cutting it.
 */
export function Pic({ caption, strip, win, children }: { readonly caption: string; readonly strip?: boolean; readonly win?: number; readonly children: ReactNode }): ReactElement {
  return (
    <figure className={`pic${strip ? " pic--strip" : ""}`}>
      <div className="frame pic-frame" style={win ? ({ "--pic-win": `${win}px` } as CSSProperties) : undefined}>
        {children}
      </div>
      <figcaption className="pic-cap">{caption}</figcaption>
    </figure>
  );
}

/** The frame's inside at 1440 (console.css .pic-frame --pic-win): the box every window and render is composed for; a narrower frame scales the composition as one. */
const WIN = { w: 397, h: 297 } as const;

/**
 * A harness render at one CSS px per file px (the @2× PNGs land on whole device pixels, so their dither stays crisp; the
 * 1× icon sheet at 1×), composed on the 1440 frame: `x` and `y` place the frame on the render as fractions, 0 its left or
 * top edge flush with the frame's, 1 its right or bottom. A narrower frame scales the composition down as one about the
 * frame's top-left (console.css .pic-crop), so what is composed in stays whole on a phone.
 */
export function Render({ shot, x, y }: { readonly shot: Shot; readonly x: number; readonly y: number }): ReactElement {
  const left = Math.round((WIN.w - shot.width) * x);
  const top = Math.round((WIN.h - shot.height) * y);
  return <img className="pic-crop pic-render" src={shot.src} alt="" width={shot.width} height={shot.height} style={{ width: shot.width, height: shot.height, left, top, transformOrigin: `${-left}px ${-top}px` }} decoding="async" loading="lazy" />;
}

/** A harness render covering the frame (object-fit: cover; the frame's width keeps a @2× PNG near 1.5× at most), `position` the region it keeps. */
export function Cover({ shot, position }: { readonly shot: Shot; readonly position: string }): ReactElement {
  return <img className="pic-cover" src={shot.src} alt="" width={shot.width} height={shot.height} style={{ objectPosition: position }} decoding="async" loading="lazy" />;
}

/**
 * A capture cut to the frame: a @2× file at 0.5× (one device pixel per capture pixel) or a 1× file at 1×, so nothing
 * scales; the frame shows the capture from `x` (its left edge) or up to `right` (its right edge), from `y` down, in the
 * capture's CSS px at that scale. The window is cut for the 1440 frame; a narrower frame scales it down as one about the
 * anchored corner (console.css .pic-crop), so what the section is about stays whole on a phone.
 */
export function Cut({ shot, scale, x, right, y }: { readonly shot: Shot; readonly scale: 0.5 | 1; readonly x?: number; readonly right?: number; readonly y: number }): ReactElement {
  const w = Math.round(shot.width * scale);
  const h = Math.round(shot.height * scale);
  const style: CSSProperties = { width: w, height: h, top: -y };
  if (right !== undefined) {
    style.right = right - w;
    style.transformOrigin = `${right}px ${y}px`;
  } else {
    style.left = -(x ?? 0);
    style.transformOrigin = `${x ?? 0}px ${y}px`;
  }
  return <img className="pic-crop" src={shot.src} alt="" width={shot.width} height={shot.height} style={style} decoding="async" loading="lazy" />;
}

/**
 * A capture at 0.5× (a 2× file) or 1× (a 1× file), cropped in its own box (the right rail's groups): the box shows `width` ×
 * `height` CSS px of the image from (`x`, `y`) in the image's CSS px at that scale; the box narrows with its column and
 * shows less, never scales. The alt is the deck's line when the crop stands alone.
 */
export function Crop({ shot, scale, x, y, width, height, alt, className }: { readonly shot: Shot; readonly scale: 0.5 | 1; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly alt?: ""; readonly className?: string }): ReactElement {
  const w = Math.round(shot.width * scale);
  const h = Math.round(shot.height * scale);
  return (
    <div className={`crop${className ? ` ${className}` : ""}`} style={{ maxWidth: width, height }}>
      <img src={shot.src} alt={alt ?? shot.alt} width={shot.width} height={shot.height} decoding="async" loading="lazy" style={{ width: w, height: h, left: -x, top: -y }} />
    </div>
  );
}

/** A ledger row: the figure in the left column (the app's clock column), the row's own glyph on the icon column, the label; the card tip carries n and date. */
export function LRow({ figure, glyph, meta }: { readonly figure: Figure; readonly glyph: GlyphName; readonly meta?: ReactNode }): ReactElement {
  return (
    <li className="kit-row kit-row--13 ld-row is-acting">
      <Tip card={figureCard(figure)}>
        <button type="button" className="kit-row-act" aria-label={`${figure.value} · ${figure.label}`} />
      </Tip>
      <span className="ld-v">{figure.value}</span>
      <span className="kit-row-icon">
        <Glyph name={glyph} size={16} />
      </span>
      <span className="kit-row-main">
        <span className="kit-row-line">
          <span className="kit-row-title">{figure.label}</span>
        </span>
        {meta ? <span className="kit-row-meta">{meta}</span> : null}
      </span>
    </li>
  );
}

/** The ledger's lead figure (Numbers): the value at mono 28 with its label under it, ahead of the rows; the same card tip. */
export function LeadFigure({ figure }: { readonly figure: Figure }): ReactElement {
  return (
    <Tip card={figureCard(figure)}>
      <button type="button" className="ld-lead" aria-label={`${figure.value} · ${figure.label}`}>
        <span className="ld-lead-v">{figure.value}</span>
        <span className="ld-lead-l">{figure.label}</span>
      </button>
    </Tip>
  );
}

/** The ledger banner (StreamView.swift: "ledger banner"; console-jarhead.jpg's `started 14:16:01 · ran 34:00 · …` strip): mono 11 on the raised strip. */
export function Banner({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactElement {
  return <div className={`banner${className ? ` ${className}` : ""}`}>{children}</div>;
}
