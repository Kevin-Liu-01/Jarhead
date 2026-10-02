import Apple from "@thesvg/react/apple";
import Pnpm from "@thesvg/react/pnpm";
import Xcode from "@thesvg/react/xcode";
import type { ReactElement, ReactNode } from "react";
import { Glyph } from "@/components/kit/Glyph";
import { INSTALL } from "@/content/deck";
import { first, from, upTo } from "@/lib/cut";
import { CopyButton } from "./CopyButton";
import { Section } from "./Section";
import { section } from "./sections";

/** The lead's first two sentences. */
const LEAD = first(INSTALL.lead, 2); // Source only. One line clones the repo and runs four commands.
/** The note's last two sentences; the URL closes it and renders as the link. */
const NOTE = from(INSTALL.note, 3);
const NOTE_HEAD = upTo(NOTE, INSTALL.url);
if (!NOTE.endsWith(INSTALL.url)) throw new Error("the install note no longer ends with the script's URL");
/** The build row drops its README comment: Node, pnpm and Xcode are already in the Requirements beside it. */
const QUIET: (typeof INSTALL.commands)[number]["cmd"] = "pnpm install && pnpm build:hands";

/** The six requirements: the three the script checks wear their product marks, the three the visitor brings the kit's glyphs. */
const REQ: ReadonlyArray<{ readonly icon: ReactNode; readonly text: string }> = [
  { icon: <Apple variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, text: INSTALL.requirements.items[0] },
  { icon: <Xcode variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, text: INSTALL.requirements.items[1] },
  { icon: <Pnpm variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, text: INSTALL.requirements.items[2] },
  { icon: <Glyph name="key" size={16} />, text: INSTALL.requirements.items[3] },
  { icon: <Glyph name="ask" size={16} />, text: INSTALL.requirements.items[4] },
  { icon: <Glyph name="lock" size={16} />, text: INSTALL.requirements.items[5] },
];

/**
 * The terminal: an ink plate in both themes (a terminal is ink), the title strip's three discs, then the one line large with
 * the script's own note under it (its "It" is the script, its link the script's URL) and the primary Copy, a hairline, and
 * the four commands as rows (the command in mono, its README comment under it, a ghost Copy each). The one-liner wraps only
 * between its held runs, never inside the host; the link wraps only before `install.sh`.
 */
function Terminal(): ReactElement {
  return (
    <div className="term">
      <div className="term-bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="term-one">
        <div className="term-said">
          <code className="term-line">
            <span>{INSTALL.runs.cmd}</span> <span>{INSTALL.runs.host}</span>
            <wbr />
            <span>{INSTALL.runs.script}</span> <span>{INSTALL.runs.tail}</span>
          </code>
          <p className="ins-note">
            {NOTE_HEAD}
            <a href={INSTALL.url} rel="noopener">
              {INSTALL.runs.host}
              <wbr />
              {INSTALL.runs.script}
            </a>
          </p>
        </div>
        <CopyButton text={INSTALL.code} kind="primary" size={40} />
      </div>
      <ul className="term-cmds" role="list">
        {INSTALL.commands.map((c) => (
          <li key={c.cmd}>
            <span className="term-glyph">
              <Glyph name="terminal" size={16} />
            </span>
            <span className="term-cmd">
              <code>{c.cmd}</code>
              {"note" in c && c.cmd !== QUIET ? <span className="term-note">{c.note}</span> : null}
            </span>
            <CopyButton text={c.cmd} kind="ghost" size={32} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Install: the h2, the lead, then the six requirements (each on its mark) with their certificate note; the terminal beside
 * them is the picture and the tool at once, and carries the script's note.
 */
export function Install(): ReactElement {
  const req = INSTALL.requirements;
  return (
    <Section meta={section("install")} h2={INSTALL.h2} lead={LEAD} pic={<Terminal />}>
      <h3 className="req-h">{req.word}</h3>
      <ul className="req" role="list">
        {REQ.map((it) => (
          <li key={it.text}>
            <span className="req-icon">{it.icon}</span>
            {it.text}
          </li>
        ))}
      </ul>
      <p className="req-note">{req.certNote}</p>
    </Section>
  );
}
