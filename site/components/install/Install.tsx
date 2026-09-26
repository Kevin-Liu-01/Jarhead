import { Disclosure, Glyph, Group, GroupHead, Row, type GlyphName, type RowBadge, type TipProps } from "@/components/kit";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { after, row, sentence, upTo } from "@/components/sections/cut";
import { NUMBERS } from "@/content/copy";
import { COMMANDS, PERMISSIONS_NOTE, REQUIREMENTS, REQUIREMENTS_HEAD, SECTION_H2, SECTION_ID, SECTION_LEAD, type Rich } from "@/content/install";
import { CopyButton } from "./CopyButton";
import { InstallStrip } from "./InstallStrip";

/** A Rich run as plain text (the tips carry no markup). */
const plain = (parts: Rich): string => parts.map((p) => (typeof p === "string" ? p : p.code)).join("");

/** The four commands (README:23-29) and the spoken fifth. */
const CMDS = COMMANDS.filter((c) => c.kind === "command");
const SPOKEN = COMMANDS.find((c) => c.kind === "spoken");
if (CMDS.length !== 4 || !SPOKEN || SPOKEN.kind !== "spoken") throw new Error("the install deck drifted");
const THEN = plain(SPOKEN.text);

/** The fold's closed summary: each command's verb in mono (ConsoleDisclosure.swift:102-110); a prefix of its command, checked at build. */
const VERBS = ["git clone", "pnpm install", "pnpm build:mac", "open -a Jarhead"] as const;
if (!CMDS.every((c, i) => c.kind === "command" && c.cmd.startsWith(VERBS[i] ?? "\0"))) throw new Error("a fold summary is not a cut of its command");

/** A tip for a note: one line when it is short and has no full stop, else a card carrying the whole note. */
const noteTip = (text: string): Tip => (text.length <= 44 && !text.endsWith(".") ? { line: text } : { card: { title: text } });

type Tip = Pick<TipProps, "line" | "card">;
const REQ = REQUIREMENTS.map(plain);
/** `16 permissions, 7 required` (NUMBERS.tiles[9].proof, README:332) and the seven names (README:437-452), four and three to a line. */
const PERMS = upTo(row(NUMBERS.tiles, 9).proof, " · ");
const SEVEN = upTo(after(PERMISSIONS_NOTE, "seven required: "), ".").split(", ");
const SEVEN_LINES = [SEVEN.slice(0, 4).join(", "), SEVEN.slice(4).join(", ")];

/**
 * The seven requirements (README:352-355, 372-379, 437-452), each cut to its short title with the rest as its value, badge
 * or tip. The glyph is the row's kind: a checkCircle for what the script checks, then the key, the terminal, the lock and
 * the raised hand for what the visitor brings (facts-canon.md §6: the glyph that is the row's kind goes filled).
 */
const REQ_ROWS: ReadonlyArray<{ readonly glyph: GlyphName; readonly title: string; readonly value?: string; readonly badge?: RowBadge; readonly tip?: Tip }> = [
  { glyph: "checkCircle", title: row(REQ, 0) },
  { glyph: "checkCircle", title: upTo(row(REQ, 1), ", for"), value: after(row(REQ, 1), "for ") },
  { glyph: "checkCircle", title: upTo(row(REQ, 2), " · corepack"), value: upTo(after(row(REQ, 2), "pnpm 10 · "), " picks"), tip: noteTip(after(row(REQ, 2), "pnpm 10 · ")) },
  { glyph: "key", title: upTo(row(REQ, 3), " with access"), value: upTo(after(row(REQ, 3), "access to "), ","), tip: { card: { title: upTo(row(REQ, 3), " with access"), lines: [after(row(REQ, 3), "key ")] } } },
  { glyph: "terminal", title: upTo(row(REQ, 4), ":"), tip: { card: { title: upTo(row(REQ, 4), ":"), lines: [after(row(REQ, 4), ": ")] } } },
  {
    glyph: "lock",
    title: upTo(row(REQ, 5), ", self-signed"),
    badge: { word: upTo(after(row(REQ, 5), "keychain, "), " is") },
    tip: { card: { title: upTo(row(REQ, 5), " in your"), lines: [after(row(REQ, 5), "keychain, ")] } },
  },
  { glyph: "handRaised", title: upTo(PERMS, ","), value: after(PERMS, ", "), tip: { card: { title: PERMS, lines: SEVEN_LINES } } },
];

/**
 * Install as its own section (SPACE.md §4 row 4, §5): the head and one lead, then one plate holding the one-liner strip
 * with its primary Copy and the ghost that opens the script, a kit Disclosure "By hand" whose closed head names the
 * four verbs and whose rows are number · command · a ghost Copy (the note as each row's tip), the requirements as a
 * kit row group (the kind's glyph · title · value or badge · a tip for the detail), then the spoken line.
 */
export function Install() {
  return (
    <Section id={SECTION_ID} h2={SECTION_H2} lead={sentence(SECTION_LEAD, "; Setup")} /* README:13, README:23-29 */>
      <Plate>
        <InstallStrip />
        <Disclosure id="by-hand" kind="section" title="By hand" count={CMDS.length} summary={VERBS.map((v) => ({ figure: v }))} className="ins-fold">
          <Group className="sec-rows ins-rows">
            {CMDS.map((c) =>
              c.kind === "command" ? (
                <Row
                  key={c.n}
                  size={13}
                  mono
                  icon={<span className="ins-n">{c.n}</span>}
                  title={c.cmd}
                  tip={noteTip(plain(c.note))}
                  trailing={
                    <span className="kit-row-verb">
                      <CopyButton text={c.cmd} kind="ghost" size={24} />
                    </span>
                  }
                />
              ) : null,
            )}
          </Group>
        </Disclosure>
        <Group className="sec-rows ins-group" head={<GroupHead title={REQUIREMENTS_HEAD.word} count={REQ_ROWS.length} />}>
          {REQ_ROWS.map((r) => (
            <Row key={r.title} size={13} icon={<Glyph name={r.glyph} size={16} />} title={r.title} value={r.value} badge={r.badge} tip={r.tip} />
          ))}
        </Group>
        <p className="ins-then">{THEN}</p>
      </Plate>
    </Section>
  );
}
