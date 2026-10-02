# DESIGN · the page as built (2026-10-01)

The landing page in one page. `SCRATCH.md` is the brief this answers; `ART-STYLE.md` is the law for the drawings;
`content/deck.ts` (`COPY.md`) is the only source of words. Where this page and the code disagree, fix one of them.

## The composition

A poster, dark first, one dominant thing per viewport. The Mac's top edge is fixed over the page: the menu bar edge to
edge, the notch cut out of it, and the real island hanging from the notch. Under it the hero sets `Your Mac, by voice.` on
one line beside the live blob, then one section per question, each a full viewport on its own tone, the words beside one
big picture, the picture side alternating. Install closes with the terminal; the foot is centred and quiet.

## The sticky top (`components/site/Top.tsx`, `MenuBar.tsx`, `components/desk/*`, `styles/desk.css`)

- **The bar** (37 px; 44 on the phone): the Apple mark, `Jarhead` (the one weight above 500), the sections as its menus with
  the one in view marked (`aria-current="location"`), then at the right the phase dot and word, GitHub with the live star
  count, the theme glyph, the accent `Install` and the island's clock. Menus drop last first as the bar narrows (1250,
  1160, 1020, 900 px) so they never reach the notch; the phase word goes under 940; the phone keeps the mark, the name,
  GitHub and the theme, each a 40 px target; under 380 the notch narrows to 100 px and the bar's star count goes to the
  screen reader alone.
- **The island** is the app's open island at 1:1 (420 × 184) scaled from the notch: over the hero at `--hero-s` (1:1 at
  900 px of height, 0.8 to 1.15), and as the page scrolls its foot travels up at scroll speed (`scale = max(s1, s0 − y/184)`)
  until it docks at `--compact-s` (0.66: 37 + 121 = 158 px at 1440 × 900; 0.62 and 158 px on the phone). Nothing in the hero
  passes under it. It never folds: all six kinds are open. Asleep is the app's quiet island (the titanium ink, `- -`, the
  crescent and `asleep`, the clock, the asleep line), the alarm rings over it.
- **Legibility**: every word in the island takes `max(its size, 11px / --top-s)`, so it never renders under 11 px; docked,
  a thread tile keeps its name and its Stop. The bar names the state at 13 px.
- **What it wears**: over the hero the timeline cycles listening 6 s, thinking 3, acting 6, speaking 5, asleep 4, alarm 5;
  the Say box holds its placeholder and caret (the line above carries the utterance), Working counts, the meters tick, the
  ink breathes, the face blinks and follows the pointer, a press or Enter on the blob steps it. Docked, it wears the kind of
  the section whose top last crossed the middle of the viewport (`SectionSpy.tsx`); on Sleep it plays asleep, then the
  alarm. Thinking wears the orb's blue on the hairline and the blob's halo: no violet in anything orb-like.
- **The dissolve**: once docked, a band under the bar in the page's ground, solid past the island's foot, then an 8 × 8
  Bayer dissolve in 3 px cells (about 170 px in all), so content thins out in the family's dots before it reaches the
  island and never shows as slivers beside it.

## The sections (ids, in order)

| id | kind · tone | h2 | the picture |
|---|---|---|---|
| `hero` | the timeline · accent | `Your Mac, by voice.` (h1) | the live blob (`lib/blob.ts`), 320 to 480 px, on the h1's horizon; under 1000 px above the h1, centred |
| `wake` | listening · listening | Wakes on a word. / Touch ID opens it. | `art/Wake`: the word's wave, the blob `O O`, the Touch ID key, the five gate faces |
| `say` | thinking · thinking | Codex, Claude Code, a key, / or a model on this Mac. | `art/Say`: the blob, the reflex to `"Click Save"`, the brain picker with the four names |
| `threads` | acting · acting | Several things at once. / Each with its own brain. | `site/ConsoleWindow`: the app's Threads and Agents rows, drawn with the kit |
| `hands` | acting · accent | Label first. Click second. / Screenshot last. | `art/Hands`: the window, `Save` found and circled, the blob `^ ^`, the screenshot's check |
| `rails` | speaking · speaking | One policy table. / Run, confirm or refuse. | `site/RailsPicture`: the run, confirm, refuse rails; NEVER and its seven items in text |
| `sleep` | asleep, then alarm · asleep | Say good night. / Alarms still ring. | `art/Sleep`: the quiet blob, the clock at 07:10, the alarm and the timer still armed |
| `numbers` | listening · connecting | Measured on one Mac. / Written down. | `3 ms` set huge in the words; `art/Numbers`: five latencies, labelled, on an honest broken axis |
| `costs` | listening · listening | Five cents a minute. / Asleep costs nothing. | `art/Costs`: the awake meter `$0.05` to `$3`, asleep `$0` |
| `install` | listening · titanium | Four commands. / Then say jarhead. | the terminal: the one-liner with the script's note and the primary Copy, the four commands each with its Copy |

Each section says its idea once: the cost lives in Costs (Wake drops "Nothing billed."), the spoken step in the Install h2.

## The drawings

The art family (`components/art/parts.tsx`, `docs/ART-STYLE.md`): a 420 × 315 frame (Rails 420 × 200), plates offset along
the 1:2 diagonal with dithered side faces (Bayer ranks as `<pattern>`, never a shadow), 1.5-unit strokes, the section's
phase colour as the one lit face, the real orb (`renderOrb`, inlined PNG), the kit's filled glyphs and the agent marks, at
most five elements (`Art` counts them). Words in a drawing are deck strings or the island's; on a narrow plate they set at
15.5 units so they render at 12 px or more. The Console window and the NEVER list are real text in HTML.

## Type, space, colour

- **Type**: Inter (self-hosted InterVariable), weights 400 and 500 only, 600 on the bar's app name, 700 on the faces. h1
  `clamp(52px, 7.2vw, 112px)` at line-height .98, tracking −.04 em, one line (on the phone `(100vw − 2·pad) / 7.9`); h2
  `clamp(28px, 2.9vw, 52px)` in two block lines (the second in `--jh-fg-3`), each line held whole so the longest
  (`Codex, Claude Code, a key,`) fits the words column at every width from 961 to 1920; lead 17 to 20 px at .72; lines
  16 px; commands mono. No page text under 12 px outside the island and the Console window.
- **Space**: `--pad` 20 to 128 px, `--wrap` up to 1560; sections are at least a viewport tall, padded past the docked
  island (`--top-dock + 48px`), the grid 5 : 7 with a 40 to 104 px gap; under 960 px they stack picture first.
- **Colour**: tokens only (`--jh-*` in `app/globals.css`, `styles/kit.css`); one accent for the primary action and the
  selection. Each section's ground is its tone ordered-dithered over the page ground at low intensity (`lib/field.ts`,
  `components/site/Field.tsx`: 3 px cells, 4 bands at peak .22 in dark, 3 bands at .30 in light, rising behind the
  picture); a phase tone tints a ground or lights a drawing, never text or a control. The one glass is the hero's
  Install: a frosted fill over a second light the hero's field pools behind both calls, the hairline, the inner top
  highlight, the Apple mark, `Install` and `macOS 14+ · Apple silicon · source only`, 80 px tall and 368 wide. Beside it
  `Read the source` is the raised tile and a hairline, opaque in both themes, so the field never shows through it and the
  glass leads.

## Both themes

`html[data-theme]` is the only switch (stamped before paint by `lib/theme.ts`; the bar's glyph toggles it). Dark is the
first design: the bar the render's grey, the fields a whisper. Light is its own poster: the bar raised paper, denser
fields in wider steps, the frames paper cards, the glass denser with a dark hairline, the island and the terminal ink
screens on paper. Every canvas (fields, island ink, meters, blob, dissolve) re-inks on a flip.

## Motion

The island's kinds and crossfades, the blob, the meters, the scale's travel, and one rise per section: a section still
below the fold when the spy runs waits for it (fails open without JS). `prefers-reduced-motion` and `#still` give one pose
per section, step the scale and drop the rise. Every rAF pauses on a hidden tab; the blob also pauses offscreen.

## Adding a section

1. Add strings to `content/deck.ts` only if the deck has them (COPY.md); cut with `lib/cut.ts`, never reword.
2. Add a row to `components/site/sections.ts` (id, the deck name, the island's kind, the tone, the picture side). The menu,
   the spy and the island read it.
3. Draw the picture in the art family (`components/art/<Name>.tsx`, ART-STYLE §9) or as a drawing of the app with the kit.
4. Place it in `app/page.tsx`: `<Section meta={section("<id>")} h2 lead pic={<Pic><Art… /></Pic>}>` with at most two
   `Lines`. Check the h2's longest line holds at 1440 and the menus still clear the notch at 1280.
5. Typecheck, build with `--webpack`, and look at it at 1440, 1280, 1920 and 390 in both themes.
