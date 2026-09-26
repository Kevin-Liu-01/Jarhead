import Github from "@thesvg/react/github";
import { Mark } from "@/components/Mark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/kit";
import { NAV, REPO_URL } from "@/content/deck";

/**
 * Mailroom's header (layout.tsx:45-67) at Jarhead's height: 58 px, sticky, opaque, one hairline below; the mark and
 * the name, five title-case links, then the two tiles at the right: the theme toggle and GitHub as a kit ghost button;
 * under 720 the links fold away and the kit primary Install stands in for them (COPY.md Nav: button, solid).
 */
export function Nav() {
  return (
    <header className="jh-rail jh-nav">
      <a className="jh-brand" href="#top">
        <Mark size={20} />
        {NAV.brand}
      </a>
      <nav aria-label="Site">
        <ul className="jh-nav-links">
          {NAV.links.map((l) => (
            <li key={l.href}>
              <a href={l.href}>{l.word}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="jh-nav-right">
        <ThemeToggle />
        <Button kind="ghost" size={32} href={REPO_URL} className="jh-nav-gh" icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />} ariaLabel={NAV.github}>
          {NAV.github}
        </Button>
        <Button kind="primary" size={32} href="#install" className="jh-nav-install">
          {NAV.install}
        </Button>
      </div>
    </header>
  );
}
