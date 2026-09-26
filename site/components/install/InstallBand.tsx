import type { ReactElement, ReactNode } from "react";
import Apple from "@thesvg/react/apple";
import Pnpm from "@thesvg/react/pnpm";
import Xcode from "@thesvg/react/xcode";
import { Disclosure, Glyph, Group, GroupHead, Row, type TipProps } from "@/components/kit";
import { Mark } from "@/components/Mark";
import { Pill } from "@/components/ui/Pill";
import { Heading, Lead } from "@/components/ui/Section";
import { INSTALL } from "@/content/deck";
import { after, from, upTo } from "@/components/sections/cut";
import { CopyButton } from "./CopyButton";
import { InstallStrip } from "./InstallStrip";

/** The fold's closed summary: each command's verb in mono (ConsoleDisclosure.swift:102-110); a prefix of its command, checked at build. */
const VERBS = ["git clone", "pnpm install", "pnpm build:mac", "open -a Jarhead"] as const;
if (!INSTALL.commands.every((c, i) => c.cmd.startsWith(VERBS[i] ?? "\0"))) throw new Error("a fold summary is not a cut of its command");

/**
 * The plate note's last two sentences, whole (MAILROOM.md §5 "the note under the buttons"): it never writes keys, read it first
 * at the script's URL. The URL closes the note and renders as the link, checked at build.
 */
const NOTE = from(INSTALL.note, 3); // "It never writes your keys. Read it first at https://jarhead.kevinliu.studio/install.sh"
const NOTE_HEAD = upTo(NOTE, INSTALL.url); // "It never writes your keys. Read it first at "
if (!NOTE.endsWith(INSTALL.url)) throw new Error("the plate note no longer ends with the script's URL");

/** The fold's title, cut from the plate note's second sentence (facts-kit.md §8: the head is title sans 12, count mono 11, then the summary). */
const FOLD_TITLE = upTo(after(INSTALL.note, "runs "), "."); // "the four commands"

type Tip = Pick<TipProps, "line" | "card">;
/** The six requirements with the kind's mark: the three the script checks wear their product marks (ICONS.md), the three the visitor brings the kit's glyphs. */
const REQ: ReadonlyArray<{ readonly icon: ReactNode; readonly title: string; readonly tip?: Tip }> = [
  { icon: <Apple variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, title: INSTALL.requirements.items[0] },
  { icon: <Xcode variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, title: INSTALL.requirements.items[1] },
  { icon: <Pnpm variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, title: INSTALL.requirements.items[2] },
  { icon: <Glyph name="key" size={16} />, title: INSTALL.requirements.items[3] },
  { icon: <Glyph name="ask" size={16} />, title: INSTALL.requirements.items[4] },
  { icon: <Glyph name="lock" size={16} />, title: INSTALL.requirements.items[5], tip: { card: { title: INSTALL.requirements.items[5], lines: [INSTALL.requirements.certNote] } } },
];

/**
 * The closing band (ClosingBand.tsx; MAILROOM.md §6 take 12): the page inverted by a token swap, the mark at 56, the
 * two-line h2, a 17 px lead, and Jarhead's Install inside it (SPACE.md §5) as Mailroom's figure frame (take 8): a head
 * row (the deck's eyebrow at the left, the `source only` pill at the right), the one-liner strip with Copy and the note
 * that says it never writes keys and links the script, the fold whose head is its title, the count and the four verbs holding the
 * command rows, the Requirements group, then the one spoken line.
 */
export function InstallBand(): ReactElement {
  return (
    <section id={INSTALL.id} className="mr-band">
      <div className="mr-band-in">
        <Mark size={56} />
        <Heading h2={INSTALL.h2} />
        <Lead>{from(INSTALL.lead, 1)}</Lead>
        <figure className="mr-card ins-plate">
          <div className="ins-head">
            <span className="ins-eyebrow">{INSTALL.eyebrow}</span>
            <Pill word={INSTALL.label} />
          </div>
          <div className="ins-body">
            <InstallStrip />
            <p className="ins-note">
              {NOTE_HEAD}
              <a href={INSTALL.url} rel="noopener">
                {INSTALL.url}
              </a>
            </p>
            <Disclosure id="commands" kind="section" title={FOLD_TITLE} count={INSTALL.commands.length} summary={VERBS.map((v) => ({ figure: v }))} className="ins-fold">
              <Group className="mr-rows ins-rows">
                {INSTALL.commands.map((c, i) => (
                  <Row
                    key={c.cmd}
                    size={13}
                    mono
                    icon={<span className="ins-n">{String(i + 1).padStart(2, "0")}</span>}
                    title={c.cmd}
                    tip={"note" in c ? { line: c.note } : undefined}
                    trailing={
                      <span className="kit-row-verb">
                        <CopyButton text={c.cmd} kind="ghost" size={24} />
                      </span>
                    }
                  />
                ))}
              </Group>
            </Disclosure>
            <Group className="mr-rows ins-rows ins-group" head={<GroupHead title={INSTALL.requirements.word} count={INSTALL.requirements.count} />}>
              {REQ.map((r) => (
                <Row key={r.title} size={13} icon={r.icon} title={r.title} tip={r.tip} />
              ))}
            </Group>
            <p className="ins-then">{INSTALL.then}</p>
          </div>
        </figure>
      </div>
    </section>
  );
}
