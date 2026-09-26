import { Fragment } from "react";
import { Mark } from "@/components/Mark";
import { FOOTER, REPO_URL } from "@/content/deck";

/** The mono line's facts, ` · `-joined in the deck (README:10, README:554, facts:15-16, README:362); the first is the repo link. */
const FACTS = FOOTER.mono.split(" · ");
const [GITHUB, ...REST] = FACTS;
if (!GITHUB || REST.length !== 5) throw new Error("the footer's mono line drifted");

/** Mailroom's footer (layout.tsx:71-74): one 12 px muted line, the mark at 16 and the facts at the left, the credits at the right. */
export function Footer() {
  return (
    <footer id="footer" className="jh-rail jh-footer">
      <div className="jh-footer-l">
        <Mark size={16} />
        <span className="jh-footer-mono">
          <a href={REPO_URL} rel="noopener">
            {GITHUB}
          </a>
          {REST.map((f) => (
            <Fragment key={f}>
              {" "}
              <span className="jh-footer-fact">· {f}</span>
            </Fragment>
          ))}
        </span>
      </div>
      <p className="jh-footer-r">
        {FOOTER.disclosures[3]} {FOOTER.disclosures[4]}
      </p>
    </footer>
  );
}
