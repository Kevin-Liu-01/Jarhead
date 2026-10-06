# DIAGRAM-STYLE · the law for every diagram and every icon on the page

> **History from §3 on (2026-10-02).** §1 (the fonts) and §2 (the icons) are still the law. The rest describes the
> schematic drawings (`components/art/*`, `parts.tsx`, `/diagrams`), which the playable plates in `components/play/*`
> replaced (LANDING.md); `DESIGN.md` describes the page as built.

Kevin (2026-10-02): "our diagrams need to be completely redesigned, use a far better font, lay out stuff better, make far
better visuals and use better icons". `DIAGRAMS.md` is that brief. This file is the system that answers it, the
schematic: every picture is an exact technical drawing on a 4-unit grid, one wire weight, one card radius, the path taken
solid and lit, the paths not taken dashed, one accent per diagram, dither only where it means something, the real orb
where the character belongs, Phosphor Fill for every icon, JetBrains Mono for every value. The parts live in
`components/art/parts.tsx`; the icons in `components/icons/`; the panel and the section layouts in
`components/site/Section.tsx` and `styles/site.css`. Where this file and the code disagree, fix one of them.

`/diagrams` (`app/diagrams/page.dev.tsx`, served by `next dev` only) shows every drawing at its home width, every phone
drawing, both faces at the page's sizes and every vendored icon. Look at it before and after a change.

## 1. Font

| face | file | where | weights |
|---|---|---|---|
| Inter 4.1 (rsms, OFL) | `app/fonts/InterVariable.woff2`, `LICENSE-Inter.txt` | every word: headings, leads, lines, the bar, card names, row words, captions, feet | 400, 500 (600 on the bar's app name alone) |
| JetBrains Mono 2.304 (OFL) | `app/fonts/JetBrainsMono-wght.woff2` (23.7 KB), `OFL-JetBrainsMono.txt` | every value, command, call, source, date, n and tag in a drawing; the island's alarm clock (the app's SF Mono); the terminal; the bar's star count; the foot's figures | 400, 500 |

- The mono is subset with fontTools to Latin, the punctuation, the arrows and the Mac key symbols the page sets (`⌥ ⇧ ⌘ ≥
  · → − × …`), its ligatures and cv/ss features dropped (GSUB keeps `ccmp`, `locl`), so Inter's `cv11 ss01 ss03` on the
  body never reach it. Loaded by `next/font/local` in `app/layout.tsx` as `--font-jbm`; `--font-mono` in
  `app/globals.css` points at it, then `ui-monospace, "SF Mono", Menlo`.
- Chosen over Geist Mono (two of three judges): the tallest x-height (550/1000) of the candidates, the full key-symbol
  set (Geist lacks `⌥` and `⌘`), a third of Geist's weight, no stylistic sets for Inter to leak into. Departure Mono was
  ruled out: its native 11 px sits under the 12 px floor and its numerals read as a game.
- Its advance is 0.6 em, so a mono run's width is known at build time: `monoWidth(text, size)` in `parts.tsx`.

### Type roles in a drawing (`T` in `parts.tsx`)

| kind | face, size / weight, ink | for |
|---|---|---|
| `label` | Inter 14 / 500, ink 1.0 | a card's or a group's name, a verdict, a step, the lit row's words |
| `body` | Inter 14 / 400, ink .72 | a row's words (a brain, a way in, a verb, a latency's label) |
| `lane` | Inter 13 / 400, ink .72 | a caption on a wire or under a part; the deck line a card ends on |
| `mono` | JetBrains Mono 13 / 400, ink 1.0 | a value (`457 ms`, `$0.05`), a command (`mkfs`), a call |
| `meta` | JetBrains Mono 13 / 400, ink .72 | a source, a date, an n, a tag (`ask every time`, `NEVER 7`, `weekdays`) |
| `figure` | Inter 64 to 80 / 500, tracking −0.045 em, tabular | the one big number (`3 ms`) |

The floor: `T` throws on a word under 13 units. A wide drawing shows only where it is drawn at 12/13 of its home width or
more, so nothing in a diagram renders under 12 px at any width (§9). Mono values in a chart may go to 17 or 20 (Costs).
Words in quotes are spoken (`"Click Save"`, `"night."`): Inter, never mono.

## 2. Icons

**Phosphor Icons 2.1.1, the Fill weight (MIT), the page's one family.** Filled, never outline (Kevin's canon), one
256-unit grid, one optical weight. Brand marks stay `@thesvg/react` (`mono`: Apple, GitHub, Xcode, pnpm); agent marks stay
`components/kit/AgentMark.tsx` (Codex, Claude Code, Cursor). Nothing else draws an icon: the kit's hand-drawn glyphs
(`components/kit/Glyph.tsx`, `components/desk/Icons.tsx`) are gone.

- **Files.** `components/icons/paths.ts` (generated; each icon one unmodified `d` with what it means where it stands),
  `components/icons/Icon.tsx`, `components/icons/LICENSE-Phosphor.txt`.
- **In HTML.** `<Icon name size? label? className? />`: an inline svg in `currentColor`, `aria-hidden` unless `label`
  names it. Sizes: 12 and 14 in the island (drawn at 1:1 and scaled with it), 16 in a control (`Button icon`, Install's
  requirements and command rows), 20 on a section line (`Lines`), 24 and 32 in a figure.
- **In a drawing.** `<Ico name x y size? color? />` with its top-left on the grid, 16, 20 or 24 units. A card's icon sits
  on the 20 column at `x + 16`, its words at `x + 48` (`x + 46` beside a verdict).
- **Colour.** The words' ink step by default (`C.ink2`, `C.ink3` in a quiet row); the accent only on the subject (the lit
  row's icon, the verbs of the lit verdict, a group head that is lit). Never a second hue.
- **One more icon.** Add a row to `USED` in `scripts/vendor-icons.mjs` (the site's camelCase name, Phosphor's file name,
  its meaning on the page), run `node scripts/vendor-icons.mjs` from `site/` (it fetches
  `@phosphor-icons/core@2.1.1/assets/fill/<file>-fill.svg` from jsDelivr byte for byte), then use it. A row nothing uses
  is dead weight: remove it and run the script again. Never hand-edit `paths.ts`; never install the package.
- **Meaning.** Every icon names its place: `lightning` the reflex, `gearSix` Settings, `fingerprint` Touch ID,
  `handPalm` asks, `prohibit` refuse, `paperPlaneTilt` send, `tag` a label, `camera` the screenshot, `moon` asleep. An
  icon that would only decorate is left out.

## 3. Grid, spacing, strokes, radii

- **Grid.** U = 4. Every viewBox and card sits on it (`Diagram` and `Card` throw otherwise). Cards pad 16; a card's head
  is 48 tall with a hairline under it; list rows are 40 (64 when a value sits under its word); chart rows pitch 28 to 32;
  lanes sit 12 above their wire; captions 48 under an orb's centre. Margins inside a drawing 24, 32 or 40.
- **Home widths.** A wide drawing is drawn for 1:1 at 1280: Say, Hands and Numbers 1088 (the full wrap); Rails 656 (the
  7/11 column); Wake, Sleep and Costs 600 (the 7/12 column); the Console window 560. A tall drawing is 348.
- **Strokes.** One wire weight, `WIRE` 1.5, round caps and joins, turns rounded at 12 (`route`). Card edges, rules and axes
  are 1-unit hairlines. Nothing else.
- **Radii.** `R` 8 on every card and on the panel; `RC` 6 on a control drawn inside a card (a selected row, a button, a
  tag). The island keeps its own 18 / 12.

## 4. The parts (`components/art/parts.tsx`)

| part | signature | what it is |
|---|---|---|
| `Diagram` | `{ id, w, h, label, tone, className, children }` | the svg root; `label` a deck sentence (`role="img"`) or `null` when the data follows as text; `tone` its one accent; defines the accent's Bayer tiers |
| `Card` | `{ dg, x, y, w, h, hi?, tiers?, along?, quiet?, r? }` | a node: the card fill, the hairline, radius R. `hi`: the one lit card or row (accent hairline at 1.5, the dither dissolving where it is empty) |
| `Rule` | `{ x, y, w }` | a row hairline inside a card |
| `Win` | `{ dg, x, y, w, h }` | a window the hands see: a card with the title strip's three quiet dots and a rule |
| `Button` | `{ x, y, w, h?, children }` | the one control pressed: the accent fill, its word in `--dg-on-accent` |
| `Tag` | `{ x, y, lit?, anchor?, children }` | a mono word in a 24-tall box, the kit's badge in a drawing |
| `Wire` | `{ pts, tone?, taken?, arrow? }` | a connector: orthogonal, rounded; `taken` solid, otherwise dashed 4 · 4; `arrow` an open chevron into its target |
| `Joint` | `{ x, y, tone? }` | a dot where wires fork or join |
| `T` | `{ x, y, kind?, anchor?, fill?, size?, transform? }` | words, by role (§1) |
| `Ico`, `Mark` | `{ name or tool, x, y, size?, color? or quiet? }` | a Phosphor icon; an agent mark |
| `Wave` | `{ x, y, n? }` | a heard line: 1.5 bars at a 4 pitch |
| `Bar` | `{ x, y, w, h?, lit? }` | a data bar whose last 12 units dissolve in the app's meter edge (`renderMeter`) |
| `Axis` | `{ x0, w, y, ticks, down? }` | a scale's hairline and ticks (fractions); its end carries its own deck value |
| `Orb`, `OrbSprite` | `{ cx, cy, size, face?, quiet?, sprite?, native? }` | the real orb (`renderOrb`, inlined PNG); a diagram's orbs are inlined once in an `OrbSprite` and placed in both drawings with `<use>` |
| `Dither`, `dissolve` | `{ dg, x, y, w, h, tiers, along? }`, `(clean, ramp?, n?)` | the accent's Bayer tiers in slabs; a ramp that stays clean under the words |
| `wrap`, `monoWidth` | `(text, n, sep?)`, `(text, size?)` | a deck string broken at its spaces; a mono run's width |

Words come from `content/deck.ts`, `content/island.ts` or `content/rail.ts` through `lib/cut.ts` (`part`, `nth`, `upTo`,
`row`, `parts`), each of which throws if the deck drifts. A diagram's own guards throw too: Rails' verb list, Costs' rate
times sixty against the hour, Numbers' scales ending on their longest row.

## 5. Colour

- **Ink.** Words at 1.0 / .72 (`C.ink`, `C.ink2`) and the quiet step `--dg-ink-3`; hairlines `--dg-line` (cards),
  `--dg-row` (rows, tracks), `--dg-wire` (structure, axes, paths not taken), `--dg-bar` (a quiet bar); the panel
  `--dg-panel`, the card `--dg-node`, the frame `--dg-frame`. All in `app/globals.css`, light and dark.
- **One accent per diagram,** set by `tone` and drawn through `--jh-<tone>-line`: listening (Wake, Numbers, Costs),
  thinking (Say), speaking (Rails), mark (Sleep's alarm), accent (Hands). On paper each line token is its own deeper step
  chosen by eye so a 1.5 wire and the dither cells hold against white and the tone stays itself (amber, not bronze); in
  dark it is the tone. The accent marks the subject alone: the path taken, the lit card or row, its icons, the pressed
  button. Everything else is ink.
- No phase tone tints a word or a control; the island's own colours stay the island's.

## 6. Dither

The 8 × 8 Bayer tiers (2 to 16 of 64, nested) in 2-unit cells, in the diagram's accent, only where it carries meaning:

- **The lit card's dissolve:** clean under the words, gathering where the card is empty (the Codex row, Touch ID, the
  Confirm row, the alarm row, the 3 ms readout).
- **A meter's edge:** the last 12 units of a bar (`Bar`), the area filling under Costs' slope.
- **A lens:** Numbers' zoom from the millisecond scale into its slice of the seconds scale, gathering as it narrows.
- **The orb's own grain** and the section grounds (`components/site/Field.tsx`).

Never a border, a side face, a checker rope or a shadow.

## 7. The orb and the island in a diagram

- The orb stands where the character is the subject's actor: listening (`O O`) where it hears, speaking (`^ ^`) where it
  says, acting (`^ ^`) where the hands act, `quiet` (titanium, faceless) asleep. 48 to 96 units; never a face under 32.
  No violet in it, ever.
- A diagram never draws the island: the page's own island hangs from the notch above every section and already wears the
  section's state. A diagram quotes the island's words instead (`7.2 min · $0.36`, `07:10 · Wake up, Kevin`, `send "I'm
  running late" to Ben`).

## 8. Section layouts (`Section layout`, `styles/site.css`)

| layout | words | picture | use it for | sections |
|---|---|---|---|---|
| `split` | h2, lead, lines in the 5fr column | the panel in the 7fr column, side from `sections.ts` | a compact scene (600 home) or the Console window | Wake, Threads, Sleep, Costs, Install; Rails at 4 : 7 (656) |
| `stack` | one header row: the h2 left, the lead and lines right | the panel full width under it | a flow read left to right (1088 home) | Say, Hands |
| `center` | h2 and lead centred | one large figure centred, up to 1232 | a chart that is the section | Numbers |

The page alternates them so it never repeats one template: split, stack, split, stack, split, split, center, split,
split. A section says each idea once: what the drawing shows leaves the lead (Say's lead is now `You pick the brain in
Settings.`; Wake's lead drops the four ways in; Rails' lines drop the feet the table carries).

- **Short desks** (≥ 1170 wide, ≤ 820 tall): sections pad 24 at the foot, stack and center close the gap over the
  drawing to 24, a centred section sets its h2 and lead side by side, and the terminal tightens, so at 1280 × 720 every
  section holds its words and its whole drawing, at 1:1 or more, under the docked top (measured: the lowest picture ends
  at 698 of 720).
- **961 to 1169:** every drawing shows its tall version on a panel up to 456 wide; a stack section becomes a split with
  the tall drawing beside its words.
- **Under 961:** everything stacks, picture first.

## 9. The phone and the floor

- Every diagram ships two drawings: the wide one and the tall one (348 wide), the phone's own redraw of the same graph
  read top to bottom, a rail down the left, cards from about x = 56 to 332, every word 13 units or more. Never the wide
  drawing shrunk.
- `styles/site.css` swaps them by width: the wide drawing from 1170 px (where each home width is drawn at 12/13 or more),
  the tall one below, shown up to 420 wide (13 units is 12.5 px at 390).
- The Console window is HTML at 560: scaled as one to its column at 1:1 or more, reflowed at 1:1 below 560.
- No sideways scroll anywhere; the shared orbs (`OrbSprite`) keep each diagram's markup under 40 KB (Wake 34, Say 38).

## 10. The checks

1. `tsc --noEmit` and `next build --webpack` pass (the grid, the type floor and every deck cut are build errors).
2. Every visible word is a deck, island or rail string or a `lib/cut.ts` cut. No em dash, no exclamation mark, no colour
   outside a token, no `prefers-color-scheme`, no `use client` in `components/art`.
3. Render `/diagrams` and the sections at 1440 × 900, 1280 × 720, 1920 × 1080, 1100 and 390 in both themes (headless).
   Measure: each visible drawing's scale (`getBoundingClientRect().width / viewBox.width`) is ≥ 12/13 and 1:1 or more at
   1280; `scrollWidth === clientWidth`; each `.sec-pic` under 40 KB.
4. Cover the h2: a stranger says what the section is about from the drawing alone. Every wire has a direction; every
   shape that could be ambiguous has a label.

## 11. Worked examples (finished)

### Say (`components/art/Say.tsx`, stack, thinking, 1088 × 336 / 348 × 592)

The idea: the spoken line forks. Read left to right: the orb (`O O`, `Listening`) hears a line (`Wave`); at a `Joint`
the reflex lane (`Unambiguous commands`, ink, arrow) runs to the `"Click Save"` card (`lightning`, `in milliseconds`),
and `The rest` (accent) runs straight into the Settings card (`gearSix`), lighting Codex (the `hi` row, its mark, the
`checkCircle`), with dashed spurs to Claude Code, a key and a model on this Mac. Both lanes join one bus and one arrow into
the hands: a `Win` with `Save` the one accent fill and `cursorClick` on it. The section's lead keeps only `You pick the
brain in Settings.`

### Rails (`components/art/Rails.tsx`, split 4 : 7, speaking, 656 × 460 / 348 × 704)

The idea: one policy table. Read top to bottom: `Every call`, the island's own call (`paperPlaneTilt`, mono), a rail down
the left, solid and lit as far as Confirm, dashed spurs to Run and Refuse. Each verdict is a row as tall as what it
holds: Run (`playCircle`) ends on `"Click Save" runs.`; Confirm (`handPalm`, the `hi` row, its tag `ask every time`)
lists Send, pay, delete, post and purchase in Inter 14 with their icons and ends on `A spoken yes covers one action
once.`; Refuse (`prohibit`, tag `NEVER 7`) lists the seven commands in mono, two columns, and ends on `The reason is
spoken.` Run holds only its deck line: the deck has no list of what runs, so none is inferred.

### Numbers (`components/art/Numbers.tsx`, center, listening, 1088 × 376 / 348 × 844)

The idea: measured, with its n and date. The `3 ms` readout (the `hi` card, its label and its tip, the cells under it)
points at its row. Three groups, each headed by its icon, subject and where and when it ran (`Reflex rows` · `pnpm
jarhead bench · 2026-09-11`; `The voice reply` · `Agora's measurement · 2026-07-09`; `Model rows` · `real Codex,
canned hands · 2026-09-12`). Rows set label, value, bar (meter edge) and n on one line. Two honest linear scales end on
their own values (`457 ms`, `9.0 s`), and the dithered lens shows the first is the first 457 ms of the second, to size.

## 12. Briefs: the six after the first three

Wake, Hands, Sleep and Costs were redrawn in this system in the same pass, and the Console window restyled; refine them
against these briefs. Install is the one left in its earlier form.

- **Wake** (`Wake.tsx`, split, listening, 600 × 264). Subject: `Wakes on a word. Touch ID opens it.` Reading order left to
  right: asleep (quiet orb, `Asleep`), `one word` (the wave), `heard` (`O O`), into the `gate` card (lock) at a fork:
  Touch ID lit (`fingerprint`), Apple Watch, the Mac password, a passphrase dashed; out to `granted` (`^ ^`). Parts: three
  orbs from one sprite, `Wave`, `Card` with four rows, `Wire`s. The lead keeps the first sentence only.
- **Threads** (`components/site/ConsoleWindow.tsx`, split, HTML at 560). Subject: several threads at once, each with its
  own brain. Reading order: the Threads group (Slack asks, Spotify and Notes done) then the Agents group (the Claude Code
  sessions, the Codex and Cursor folds), the app's own rows byte for byte (`content/rail.ts`). Parts: the panel ground,
  the frame, radius 8, quiet title dots, Phosphor `handPalm`, `checkCircle`, `caretRight`, agent marks; asks in the
  speaking tone (the app's own), working dots in listening; nothing under 12 px.
- **Hands** (`Hands.tsx`, stack, accent, 1088 × 256). Subject: `Label first. Click second. Screenshot last.` Reading order
  left to right: the orb (`^ ^`, `Acting`) on one lit path through three frames of one window, each headed by its step and
  order from the h2 (`tag` Label first, `cursorClick` Click second, `camera` Screenshot last): Save found (its frame
  dashed in the accent, `find a control by label`), Save pressed (`click it`), the window captured with a check (`only
  verifies`).
- **Sleep** (`Sleep.tsx`, split, mark, 600 × 384). Subject: `Say good night. Alarms still ring.` Reading order top to
  bottom: the orb says `"night."` and goes quiet (`Asleep`, `closes the session`); the card lists
  the lead's four kinds with the island's own examples: Alarms lit (`07:10 · Wake up, Kevin`, tag `weekdays`), timers
  (`11:56 · pasta`), watchers, routines.
- **Costs** (`Costs.tsx`, split, listening, 600 × 312). Subject: `Five cents a minute. Asleep costs nothing.` Reading order
  along time: while `Listening` the cost climbs at `$0.05` `per minute of open session` (the slope, its area filling in the
  meter's dither) to `$3` `an hour of talking`; `Asleep` the line goes flat, `$0`. The island's own reading `7.2 min ·
  $0.36` is marked on the slope and dropped to the time axis. A guard checks $0.05 × 60 = $3.
- **Install** (`components/site/Install.tsx`, split, not yet redrawn). Subject: `Four commands. Then say jarhead.` Reading
  order top to bottom: the one-liner (mono 20, primary Copy) and the script's note, then the four commands it runs, then
  Setup opening. Brief: keep the terminal an ink plate in both themes (a screen); give the four command rows the
  schematic's rail (a 1.5 wire down the left with a `Joint` per command and an arrow into the last row's note, `Setup
  opens: your OpenAI key, a brain, permissions`), so it reads as a sequence without numbers; requirements as rows with
  their brand marks and Phosphor icons (`key`, `brain`, `certificate`); JetBrains Mono 14 for commands, 13 for notes,
  nothing under 12.
