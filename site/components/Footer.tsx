import Github from "@thesvg/react/github";
import { OrbField } from "@/components/OrbField";
import { Button, Chip } from "@/components/kit";
import { REPO_URL } from "@/content/install";

/** The mark, the words, one ghost and two chips on the orb field band; the disclosure line under it, at most 60ch. */
export function Footer() {
  return (
    <footer className="jh-rail jh-footer">
      <div className="jh-footer-band">
        <OrbField height={320} className="jh-footer-field" />
        <div className="jh-footer-words">
          <p className="jh-footer-name">Jarhead</p>
          <p className="jh-footer-line">A voice-first Mac assistant that uses the computer for you.</p>
          <div className="jh-footer-row">
            <Button kind="ghost" size={28} href={REPO_URL} icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
              GitHub
            </Button>
            <Chip word="MIT" />
            <Chip word="v2.0.0" />
          </div>
        </div>
      </div>
      <p className="jh-footer-note">
        Every picture on this page is rendered by the app&apos;s own preview harnesses over fixed fake data; none is a photo of a desktop. The alarm text says the author&apos;s name because the harness does. Brand marks from thesvg.org.
      </p>
    </footer>
  );
}
