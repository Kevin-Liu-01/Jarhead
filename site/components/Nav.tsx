import Github from "@thesvg/react/github";
import { Mark } from "@/components/Mark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/Button";

const GITHUB = "https://github.com/Kevin-Liu-01/Jarhead";

/** 58 px, sticky, opaque, one hairline below. Dominant: the solid Install. The links fold away under 720. */
export function Nav() {
  return (
    <nav className="jh-nav" aria-label="Site">
      <div className="jh-nav-in">
        {/* Two crosses where the nav rule meets the rail lines; hidden under 720. */}
        <span className="jh-cross" style={{ left: -5, bottom: -6 }} aria-hidden="true" />
        <span className="jh-cross" style={{ right: -5, bottom: -6 }} aria-hidden="true" />
        <a className="jh-brand" href="#top">
          <Mark size={20} />
          Jarhead
        </a>
        <ul className="jh-nav-links">
          <li><a href="#story">Story</a></li>
          <li><a href="#numbers">Numbers</a></li>
          <li><a href="#rails">Rails</a></li>
          <li><a href="#costs">Costs</a></li>
          <li><a href="#install">Install</a></li>
        </ul>
        <div className="jh-nav-right">
          <Button variant="tile" href={GITHUB} className="jh-nav-gh" icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
            GitHub
          </Button>
          <Button variant="solid" href="#install">Install</Button>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
