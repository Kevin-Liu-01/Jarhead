import Github from "@thesvg/react/github";
import { OrbField } from "@/components/OrbField";
import { Icon } from "@/components/ui/Icons";

const GITHUB = "https://github.com/Kevin-Liu-01/Jarhead";

/** The mark, the links, the disclosure: the orb field as a full-rail band with the words at the right. */
export function Footer() {
  return (
    <footer className="jh-rail jh-footer">
      <div className="jh-footer-band">
        <OrbField height={360} className="jh-footer-field" />
        <div className="jh-footer-words">
          <p className="jh-footer-name">Jarhead</p>
          <p className="jh-footer-line">A voice-first Mac assistant that uses the computer for you. Built with Swift and TypeScript.</p>
          <p className="jh-fig jh-footer-meta">
            <a href={GITHUB} rel="noopener">
              <Github variant="mono" width={14} height={14} aria-hidden="true" focusable="false" />
              GitHub
              <Icon.arrowUpRight size={11} />
            </a>
            <span aria-hidden="true">·</span>
            <span>MIT</span>
            <span aria-hidden="true">·</span>
            <span>Kevin Liu</span>
            <span aria-hidden="true">·</span>
            <span>v2.0.0</span>
            <span aria-hidden="true">·</span>
            <span>macOS 14+</span>
            <span aria-hidden="true">·</span>
            <span>Apple silicon</span>
          </p>
        </div>
      </div>
      <p className="jh-footer-note">
        Every picture on this page is rendered by the app&apos;s own preview harnesses over fixed fake data; none is a photo of a desktop. The alarm text says the author&apos;s name because the harness does. The voice speaks English only. Apple silicon, macOS 14 or newer. Brand marks from thesvg.org.
      </p>
    </footer>
  );
}
