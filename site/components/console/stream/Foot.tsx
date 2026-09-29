import { Fragment, type ReactElement } from "react";
import { Glyph, JarheadMark, Row, type GlyphName } from "@/components/kit";
import { FOOTER, REPO_URL } from "@/content/deck";
import { Banner, Tone } from "./parts";

const FACTS = FOOTER.mono.split(" · ");
const [GITHUB, ...REST] = FACTS;
if (!GITHUB || REST.length !== 5) throw new Error("the footer's mono line drifted");

/** A glyph per disclosure: the harness's terminal, the struck photo, the alarm's mark-tone dot, the voice, the marks' link. */
const GLYPHS: readonly GlyphName[] = ["terminal", "slashCircle", "dot", "voice", "externalLink"];
if (GLYPHS.length !== FOOTER.disclosures.length) throw new Error("a disclosure has no glyph");

/** The stream's last rows (inside main, so a generic, unlabelled: a footer in main is no contentinfo): the line beside the mark, the five disclosures and the second line as rows with their glyphs, the credit with the licence as its value, the mono facts as the banner. */
export function Foot(): ReactElement {
  return (
    <footer id="foot" className="foot">
      <div className="foot-head">
        <JarheadMark size={14} />
        <span className="foot-name">{FOOTER.brand}</span>
        <span className="foot-line">{FOOTER.line1}</span>
      </div>
      <ul role="list" className="kit-rows foot-rows">
        {FOOTER.disclosures.map((d, i) => (
          <Row key={d} icon={i === 2 ? <span className="tone tone--mark"><Glyph name="dot" size={16} /></span> : <Tone name={GLYPHS[i] ?? "dot"} />} title={d} />
        ))}
        <Row icon={<Tone name="terminal" />} title={FOOTER.line2} />
        <Row icon={<Tone name="checkCircle" tone="acting" />} title={FOOTER.credit} value={FOOTER.licence} />
      </ul>
      <Banner className="foot-banner">
        <a href={REPO_URL} rel="noopener">
          {GITHUB}
        </a>
        {REST.map((f) => (
          <Fragment key={f}>
            {" "}
            <span className="banner-sep">·</span> {f}
          </Fragment>
        ))}
      </Banner>
    </footer>
  );
}
