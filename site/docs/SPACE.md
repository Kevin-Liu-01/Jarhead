# SPACE · Kevin (2026-09-25), on the live site: "make this site a lot, a lot cleaner, use our custom icons and ui style here, and add a lot more space in the actual website. and make the hero a lot better and better organized and make the install and presentation of info a lot better"

> **ADDENDUM (Kevin, 2026-09-25, later): "make jarhead website a shit ton better now, and make this inspired off of https://mailroom.kevinliu.studio/" and "in terms of reducing wording, only saying important ideas, no weird metaphors or sentences that have interrupted thoughts."**
> Two files in this folder carry that: `MAILROOM.md` (the reference: what Mailroom does and what to take from it) and `COPY.md` (the NEW copy deck; it replaces `design.md` §2 as the only source of strings; every string traced). Designers, judges, the finisher and the reviewers read both before anything else in this brief. If either file is missing when you start, wait for it (poll every minute, up to 20 minutes) before designing.


The site is `/Users/kevinliu/jarvis/site` at main d139114 (read-only for every agent; copies under
`S/space/`). Its renders: `S/int2/*.png` (1440 dark: top, story, hands, numbers, install; phone-top) and
`S/polish/final/*.png` (every section, both themes, 390). The desk's live blob and island engines
(`components/desk/*`, `lib/*`) are good and stay; everything about how the page is composed is open.

## What Kevin means, item by item

1. **A lot, a lot cleaner.** Fewer things per viewport. Every element earns its place. No decorative
   lines beyond the line law; no caption clutter; no mono footnotes except a single proof line where it is
   the point; no per-section hatch band unless it is the one boundary that needs it. Calm.
2. **Our custom icons and UI style.** The site's controls, rows, badges, tooltips, fields and glyphs must be
   the Console's kit, ported: `ConsoleButton` (ghost · plain · primary · danger · spent), `ConsoleFill`
   (Surface ground/raised, `lift`, `rest(on:)`, `line(spent:enabled:)`), `ConsoleGlyph` (the FILLED glyph
   set: send, reload, undo, search, dismiss, externalLink, folder, live, quit, ask, stop, play, pause, mic,
   muted, and the line glyphs cross, magnifier, ellipsis, chevron, picker, checkmark, scope, plus, minus,
   circle, reloadLine, earlierLine, newestLine, undoLine), `ConsoleBadge` (Word/Tone), `ConsoleTip` (the
   in-window tooltip: dithered? hairline, 11 px, delay rules), `ConsoleSegments` (`On | Off`, the accent
   flags), `ConsoleRow` / `GroupHead` / `Disclosure` (icon column · title · trailing value/badge; 20 pt glyph
   column; verbWidth), `ConsoleMenuField` (custom dropdown), `ConsoleKeyCap`, `ConsoleChip`, `JarheadMark`
   (the faceless dithered orb at 20/14 pt; quiet tone), `VoiceChip`. The web twins live in
   `site/components/kit/*` with `site/styles/kit.css`, the glyphs as inline SVG paths drawn in the app's
   style (filled, 20-unit box, optical weight of SF Symbols' `.fill` variants; SF Symbols themselves are
   Apple-licensed and must not be shipped: draw our own). Brand marks stay thesvg.org (`ICONS.md`); the
   app's own agent marks in `BrandMarks.swift` (`BrandLogos` paths for claude/codex/cursor/gemini/…) may be
   ported for the agents strip since they ARE our custom icons.
3. **A lot more space.** A spacing scale, applied everywhere: section padding ≥ 160 px at 1440 (≥ 96 at 390),
   head → plate ≥ 56 px, plate padding ≥ 48 px, line height and measure generous (leads ≤ 56ch), the rail
   gutter ≥ 48 px, hero rows breathing. Roughly 1.6× today's rhythm. Page height may grow; cleanliness wins.
4. **The hero, a lot better and better organized.** Today the stage crams a phase column with six
   buttons, the island, an install plate, the Console at 0.6 and the blob into one 1170×690 box under a
   two-column headline row. Reorganize into clear rows with one job each:
   - Row 1 · words: the h1 alone at display size, the lead under it at a readable measure, two kit
     buttons (`Install` primary · `GitHub` plain) and the figures line as a kit row of badges, not a mono
     sentence.
   - Row 2 · the stage: the drawn Mac with ONLY the menu bar, the notch, the island and the live blob (and
     the target ring). The Console leaves the stage (it gets its own section at full size). The stage is
     wide and calm; the island's kind cycles on the timeline as today.
   - Row 3 · the phase control: one `ConsoleSegments`-style control (six segments with the face glyph and
     the word) under the stage, the active one pressed; the PhaseMeta hint beside it as one line.
   - Row 4 · install: the one-liner plate full width with a kit primary `Copy` and the requirement badges
     in a kit row underneath. (Or place install as its own section right after the hero; either way it is
     no longer inside the stage.)
   The desk keeps its engines; `Desk.tsx` gains a `layout` prop or the hero composes the pieces itself.
5. **Install and the presentation of info, a lot better.** Install = one plate with the one-liner and Copy,
   then a kit `Disclosure` "By hand" holding the four commands as kit rows (number · command · a `Copy`
   ghost button), then the requirements as a kit row group (checkmark glyph · text · a `Tip` for the
   detail), then "Then say jarhead, pass Touch ID, talk." as a single line. Info everywhere else: figures
   as kit rows (glyph · label · value badge) with `ConsoleTip` for provenance (n, date) instead of mono
   footnotes; the Numbers band as one row group; Costs as one figure + three rows; the never-list as rows
   with the `danger` tone; the tool families as a single kit row of badges (or dropped). Prose stays at a
   head + one lead + rows; no paragraphs.

## Non-negotiables (carried over)

- Every fact from `facts-product.md`; copy from `design.md` §2, cut freely, never added or reworded into
  a claim; zero em dashes; no "not X but Y"; weight ≤ 500; Inter only; tokens only (`--jh-*`);
  `html[data-theme]` the only switch; the line law; dither as material; reduced motion; a11y (landmarks,
  focus rings, labels, contrast AA in both themes); no antipattern from `facts-canon.md` §8 (stacked rows
  are a data dump; kit ROWS are fine when they are the Console's rows: icon column · title · trailing
  value, hairline-separated, inside one plate, few per group).
- Keep: `scripts/install.sh` and its copy step, `/og.png`, icons, manifest, `lib/*`, `content/*` (strings
  may go unused), the desk engines, `ICONS.md` (thesvg for brands).
- Height: no budget this time; whitespace is the point. Phone: readable, no sideways scroll, tap targets
  ≥ 40 px.

## The kit port (one builder, before the designers)

`site/components/kit/`: `Glyph.tsx` (every ConsoleGlyph name → an inline SVG, filled, 20-unit box, size
prop 14/16/20; `aria-hidden` default), `Button.tsx` (kind ghost|plain|primary|danger|spent; sizes; a glyph
slot; the fill/hairline/hover/active from ConsoleFill and ConsoleButtonStyle), `Badge.tsx` (word + tone),
`Tip.tsx` (an in-page tooltip on hover/focus, 11 px, hairline, delay 350 ms, `role="tooltip"`, positioned
above/below inside the viewport), `Row.tsx` + `GroupHead.tsx` + `Disclosure.tsx` (icon column 20, title,
trailing; hairlines between rows drawn once; the fold with a chevron glyph, keyboard-operable), `Segments.tsx`
(a `role="radiogroup"` of pressed tiles), `KeyCap.tsx`, `Chip.tsx`, `Mark.tsx` (reuse components/Mark.tsx),
`Field.tsx` (a text field look, if needed). `site/styles/kit.css` with every class `.kit-*` on `--jh-*`
tokens. A `/kit` page is NOT shipped; instead `site/components/kit/README.md` lists the twins and the app
source lines each mirrors, and the builder renders a private `kit-gallery` route in its copy only
(`app/kit/page.tsx`, deleted before delivery) to screenshot every piece in both themes for the judges.

## Three designers (each starts from the kit builder's copy)

- **A · Air.** The four hero rows above, everything at 1.6× spacing, each section a head + lead + one
  plate holding kit rows or a picture, generous plates, no hatch bands (one hairline per boundary), the
  Console in its own full-width section.
- **B · Console.** The page borrows the Console's own regions: a slim left rail of section marks
  (JarheadMark orbs, quiet tone for passed sections) that becomes a top strip on the phone; each section
  is a Console pane: group head · rows · one picture; tooltips on every figure; the hero as the Now pane
  with the stage.
- **C · Keynote.** One idea per viewport: the h1 alone, then the stage full-bleed, then a single kit row of
  three figures, then install as one line; sections at 200 px padding with the picture first and a kit
  row group after; the never-list as danger rows; maximal whitespace.
