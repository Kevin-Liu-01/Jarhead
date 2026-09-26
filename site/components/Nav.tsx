import Github from "@thesvg/react/github";
import { Mark } from "@/components/Mark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/kit";
import { REPO_URL } from "@/content/install";

/** 58 px, sticky, opaque, one hairline below. The mark, four links, GitHub as a kit ghost, Install as the kit primary, the toggle. */
export function Nav() {
  return (
    <nav className="jh-nav" aria-label="Site">
      <div className="jh-nav-in">
        <a className="jh-brand" href="#top">
          <Mark size={20} />
          Jarhead
        </a>
        <ul className="jh-nav-links">
          <li><a href="#story">Wake</a></li>
          <li><a href="#hands">Hands</a></li>
          <li><a href="#rails">Rails</a></li>
          <li><a href="#numbers">Numbers</a></li>
        </ul>
        <div className="jh-nav-right">
          <Button kind="ghost" size={32} href={REPO_URL} className="jh-nav-gh" icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
            GitHub
          </Button>
          <Button kind="primary" size={32} href="#install">Install</Button>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
