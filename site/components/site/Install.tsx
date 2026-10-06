import Apple from "@thesvg/react/apple";
import Pnpm from "@thesvg/react/pnpm";
import Xcode from "@thesvg/react/xcode";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { Icon } from "@/components/icons/Icon";
import { INSTALL } from "@/content/deck";
import { from, nth, upTo } from "@/lib/cut";
import { CopyButton } from "./CopyButton";
import { InstallBlob } from "./InstallBlob";
import { Section } from "./Section";
import { section } from "./sections";

/** The h2's second line, its full stop held apart: the blob stands where the stop is, as in the hero. */
const THEN = INSTALL.h2[1];
if (!THEN.endsWith(".")) throw new Error("Install's h2 no longer ends on a full stop");

/**
 * The lead's second sentence alone: the hero's Install already says `source only`, and the third (`writes your key`)
 * would sit beside the terminal's `It never writes your keys`.
 */
const LEAD = nth(INSTALL.lead, 1); // One line clones the repo and runs four commands.
/** The note's last two sentences; the URL closes it and renders as the link. */
const NOTE = from(INSTALL.note, 3);
const NOTE_HEAD = upTo(NOTE, INSTALL.url);
if (!NOTE.endsWith(INSTALL.url)) throw new Error("the install note no longer ends with the script's URL");
/** The build row drops its README comment: Node, pnpm and Xcode are already in the Requirements beside it. */
const QUIET: (typeof INSTALL.commands)[number]["cmd"] = "pnpm install --filter '!./site' && pnpm build:hands";

/**
 * The rail's last turn, drawn as a stroke so it keeps the wire's 1.5 weight at any density (a CSS border floors to whole
 * pixels): from the wire (x 1, the rail) down through a 12 bend onto the note's first line (y 13) and into a 5 open chevron
 * whose tip stops 4 short of `Setup opens`. The note's ::before carries the straight run above it.
 */
const ARROW = "M1 0V1A12 12 0 0 0 13 13H19M14 8L19 13L14 18";

/** The six requirements: the three the script checks wear their product marks, the three the visitor brings a Phosphor icon (the key, the brain, the certificate). */
const REQ: ReadonlyArray<{ readonly icon: ReactNode; readonly text: string }> = [
  { icon: <Apple variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, text: INSTALL.requirements.items[0] },
  { icon: <Xcode variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, text: INSTALL.requirements.items[1] },
  { icon: <Pnpm variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, text: INSTALL.requirements.items[2] },
  { icon: <Icon name="key" size={16} />, text: INSTALL.requirements.items[3] },
  { icon: <Icon name="brain" size={16} />, text: INSTALL.requirements.items[4] },
  { icon: <Icon name="certificate" size={16} />, text: INSTALL.requirements.items[5] },
];

/**
 * One run of a command (its words up to an `&&`), each word held whole, so it wraps only at a space, never inside a flag,
 * a script or a repo's name. A URL is one box, host and path, that moves down whole before it opens at its own slashes,
 * which it does only where the column is narrower than the URL.
 */
function Words({ run }: { readonly run: string }): ReactElement {
  return (
    <>
      {run.split(" ").map((word, i) => {
        const host = word.includes("://") ? word.indexOf("/", word.indexOf("://") + 3) + 1 : 0;
        const parts = host > 0 && host < word.length ? [word.slice(0, host), ...word.slice(host).split(/(?<=\/)(?=.)/)] : [];
        return (
          <Fragment key={i}>
            {i > 0 ? " " : null}
            {parts.length > 0 ? (
              <span className="term-hold">
                {parts.map((p, j) => (
                  <Fragment key={j}>
                    {j > 0 ? <wbr /> : null}
                    <span className="keep">{p}</span>
                  </Fragment>
                ))}
              </span>
            ) : (
              <span className="keep">{word}</span>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * A command row: its first run, then each run from its `&&` on as one box that moves down whole before it wraps, so a row
 * breaks before an `&&`, never after one, and inside a run only where the column is narrower. The bytes stay the deck's.
 */
function Held({ cmd }: { readonly cmd: string }): ReactElement {
  return (
    <>
      {cmd.split(" && ").map((run, i) =>
        i === 0 ? (
          <Words key={i} run={run} />
        ) : (
          <Fragment key={i}>
            {" "}
            <span className="term-hold">
              {"&& "}
              <Words run={run} />
            </span>
          </Fragment>
        ),
      )}
    </>
  );
}

/**
 * The terminal: an ink plate in both themes (a terminal is ink), the title strip's three discs, then the one line large with
 * the script's own note under it (its "It" is the script, its link the script's URL) and the primary Copy, a hairline, and
 * the four commands as rows on the rail that leaves the Copy (the command in mono, its README comment under it, a ghost Copy
 * each), ending in an arrow at Setup. The one-liner wraps only between its held runs, never inside the host; the link wraps
 * only before `install.sh`.
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
        {INSTALL.commands.map((c, i) => (
          <li key={c.cmd}>
            <span className="term-cmd">
              <code>
                <Held cmd={c.cmd} />
              </code>
              {"note" in c && c.cmd !== QUIET ? (
                <span className="term-note">
                  {i === INSTALL.commands.length - 1 ? (
                    <svg className="term-arrow" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                      <path d={ARROW} />
                    </svg>
                  ) : null}
                  {c.note}
                </span>
              ) : null}
            </span>
            <CopyButton text={c.cmd} kind="ghost" size={32} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Install: the h2 (its full stop the blob, asleep until a Copy wakes it) and the lead, then the six requirements (each on
 * its mark) with the certificate note, beside the terminal, which is the picture and the tool at once: the one line with
 * its Copy, then the four commands it runs.
 */
export function Install(): ReactElement {
  const req = INSTALL.requirements;
  return (
    <Section
      meta={section("install")}
      h2={
        <>
          <span className="sec-h2-1">{INSTALL.h2[0]}</span>{" "}
          <span className="sec-h2-2">
            {THEN.slice(0, -1)}
            <span className="h2-stop">.</span>
            <span className="h2-mark">
              <InstallBlob />
            </span>
          </span>
        </>
      }
      lead={LEAD}
      notes={
        <>
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
        </>
      }
    >
      <Terminal />
    </Section>
  );
}
