# ART · Kevin (2026-10-01), on the centre pass's renders: "we need to redesign this all honestly this needs to be so much better and the graphics suck, they should be replaced by new images/static svgs or something in there" and "the thing on top should be sticky and always visible"

Scope: the Now stream (`site/components/console/stream/*`, `Top.tsx`, `Hero.tsx`, the stream rules in `styles/console.css`)
and a new folder `site/components/art/`. The title bar, the left rail, the right rail and the composer stay. The copy law
(COPY.md) stands. Kevin's "the thing on top" is the dock the centre pass built: the Mac menu bar with the notch cut out
and the island hanging under it (memory `kevin-vocabulary-dock-means-notch`).

## What sucks (name it, then remove it)

Every section picture today is a capture or a harness render pressed into a frame:
- Wake and Hands show the blob as an ASCII-ish pixel render (`-=+*#%@` cells): it reads as debug output, not a picture.
- Threads, Rails and Numbers show Console captures at 0.5×: 9 px text nobody can read, cropped at random edges.
- Say, Sleep, Costs and Install redraw the app's own cards and rows (the Brain card, the Automations list, the Ledger day,
  the Requirements list): a screenshot in HTML, grey on grey, the same shape as the words beside it.
- Made is a collage of blob poses at odd sizes.
- Captions describe the render ("The blob beside its target ring, acting"), not the idea.
None of them explains the section. None is something a visitor would remember. All of them go.

## The three asks

1. **The dock is sticky and always visible.** The menu bar, the notch and the open island (with the blob, its bands and
   the six faces in its foot) stay at the top of the stream while the stream scrolls under them. The island never folds
   to the lip on scroll; its kinds keep cycling; the phase control stays reachable. The dock block paints its own
   dithered desktop ground so the stream passing under it is hidden cleanly (an opaque block, the bar translucent over
   that ground only). Heights: 37 px bar + 184 px island at 1440 (the whole block ≤ 232 px); under 760 px of viewport
   height the block scales to 0.8; on the phone the island scales as today and the block stays sticky. The stream's first
   section (the hero words) starts 32 px under the dock. Implementation: the dock leaves `.hero` and becomes the stream's
   first child, `position: sticky; top: var(--jh-tb); z-index: 15`, with `scroll-margin-top` on the sections raised by
   its height so anchors land under it.
2. **Every section picture is a new static SVG illustration**, drawn for the idea the section explains, in one family.
3. **The stream is redesigned around them** so the page reads as a set of ten clear pictures with their facts, each
   section one picture (≥ 48 % of the stream) beside one h2, one lead and three rows, at CENTER.md's spacing.

## The illustration system (the law for every picture)

- **Form.** One React component per section in `components/art/<Name>.tsx` (server-renderable, no hooks, no canvas),
  exporting `<ArtWake />` etc., each a single `<svg viewBox="0 0 420 315" width="100%" role="img" aria-label="…">`
  (4:3, the frame's width at 1440 is ~420 px so 1 unit ≈ 1 px there). Shared parts in `components/art/parts.tsx`
  (the dither pattern defs, the vector orb, a frame, a label, a glyph wrapper). The frame around every picture is the
  same: 1 px `--jh-hair-frame`, radius 8, `--jh-raised` ground; the SVG fills it; one caption under it (Inter 12 px
  `--jh-fg-3-word`, one line, a cut of the section's h2 or lead or an ALT line: no new words).
- **Colour only through tokens.** `fill="var(--jh-fg)"`, `stroke="var(--jh-hair)"` and so on; never a hex. Both
  themes come for free. Palette per picture: the greys (`--jh-fg`, `--jh-fg-2`, `--jh-fg-3`, `--jh-hair`, `--jh-raised`,
  `--jh-ink`, `--jh-paper`) plus ONE accent, the section's phase colour (`--jh-listening`, `--jh-thinking`,
  `--jh-acting`, `--jh-speaking`, `--jh-asleep`; `--jh-error` for refuse/denied; `--jh-accent` for the orb's blue).
- **Shading is dither.** Every shaded area is an SVG `<pattern>` of the 8×8 Bayer ranks at 2 px cells in 4 or 5 bands
  (`lib/dither.ts` BAYER8_RANKS; build the patterns once in parts.tsx as `url(#dither-1)` … `url(#dither-4)` over a flat
  fill). No gradients, no filters, no blur, no drop shadow, no opacity ramps. Flat fills, 1.5 px strokes, radii 4 to 8,
  square or round caps consistently.
- **The orb.** The blob in a picture is the real orb: `renderOrb` (`lib/orb.ts`) at 2× into `pngDataUri`, placed with
  `<image>` and `image-rendering: pixelated` at an integer scale, face `^^` or `OO` or none; sizes 32, 64, 96. Never
  an ASCII render, never a face under 32 px. Or a vector orb from parts.tsx (a disc with the five dithered bands and
  the mono face) if the eye judge prefers it: one of the two, for all ten pictures.
- **Glyphs are the kit's.** Reuse `components/kit/Glyph.tsx`'s paths (export `GLYPHS` and draw them with `<g>` at
  20-unit boxes scaled to 16 to 24) and `AgentMark`'s marks; brand marks from `@thesvg/react` `mono`. No outline icon,
  no emoji, no robot, no sparkle, no cursor-arrow clichés unless the section IS about the cursor (Hands).
- **Words inside a picture: at most six**, Inter via `font-family: var(--font-sans)` or the mono via
  `var(--font-mono)`, 12 or 13 units, `fill="var(--jh-fg-2)"`; only strings from COPY.md or the app's own text
  (the deck's figures, the island's words, `Allow`, `Deny`, `Stop`, app names from the Threads lead). Numbers may be
  ticks and values. No callout lines, no arrows pointing at things, no legend.
- **Composition.** One subject, big: it fills at least 60 % of the frame. Flat, frontal or a 2.5D stack at most. The
  same visual weight across the ten (a contact sheet of them must read as one set). Nothing in a picture may be a
  reproduction of an app screen; a window, a menu bar or the island may appear as a simplified glyph-level drawing.
- **The page.** Each picture sits in its frame on the picture side of the section grid (alternating sides as today);
  the words column holds h2 / lead / rows; CENTER.md spacing. `public/media` captures leave the stream (the OG route
  keeps its own field). FOOTER's first disclosure ("Every picture is rendered by the app's own preview harnesses …")
  becomes false and is dropped from the deck and the footer; "None is a photo of a desktop" stays.

## The ten subjects (from the deck; the designer composes, the subject is fixed)

| # | Section | Accent | The picture shows |
|---|---------|--------|-------------------|
| 01 | Wake | listening | The notch with the island tucked to its lip wearing `O O`, a sound wave entering from the left, the Touch ID ring (a fingerprint glyph in a ring) lit; along the foot the five gate states as small orbs: gate · heard · granted · denied · locked (denied and locked in `--jh-error`). |
| 02 | Say | thinking | A spoken line forking: the short lane straight to a hand glyph (`3 ms`, `"Click Save"`), the long lane into four brain tiles with their marks: Codex, Claude Code, a key, a Mac (local). |
| 03 | Threads | acting | Three lanes, each with its own small orb and brain mark: Slack · screen, Spotify · background, Notes · background; the Slack lane paused at an `asks` badge with `Allow` / `Deny` tiles; the others running to a check. |
| 04 | Hands | acting | A window with controls; `Save` found by its label (1), the pointer travelling to it (2), a small screenshot tile with a check (3); the circle ring (⌃⌥C) around one control. |
| 05 | Rails | speaking | The policy table: three rows run / confirm / refuse with checkCircle, handRaised, xOctagon, columns of tool-family glyphs; below, the NEVER column as seven red dots with its items in mono. |
| 06 | Sleep | asleep | The island tucked with `- -`, the moon pill `☾ asleep`, a clock face at 07:10, the automations as a timeline bar with ticks at 07:10, 4:11 and 17:31; the meter flat at `$0`. |
| 07 | Numbers | listening | The pipeline as a timeline: ear → hands at `3 ms`, prefire `126 ms`, careful `457 ms`, the voice reply `1.11 s`, first action `4.4 s`, verified `8.9 s`, as proportional dithered bars with the values; the scale honest (a broken axis drawn as a gap if needed). |
| 08 | Costs | listening | A session meter filling at `$0.05` per minute with second ticks and `$3` at the hour mark; beside it the asleep bar empty with the moon and `$0`. |
| 09 | Made | accent | The architecture: Jarhead.app (Swift mark) over jarheadd (TypeScript mark) with the two helper blocks (hands), joined by lines; the Dock icon orb at 64 with `^^` above them. |
| 10 | Install | accent | A terminal card with the one-liner on the prompt line and the four commands as checked rows, flowing into the Setup rail drawn as a wizard sidebar: Welcome · Voice · Brain · Permissions · Wake · Agents · Done. |

## Non-negotiables

CENTER.md and IMMERSE.md stand (the dock, the hero's three things, no eyebrows, the kit, dithered grounds, both
themes, a11y: every SVG `role="img"` with a label from the deck). COPY.md law. §8 antipatterns (the glass Install
button is the one glass). Never `pnpm install` in a copy; dev servers with `./node_modules/.bin/next dev --webpack
--port <port>`. No library for the drawings: hand-written SVG. No raster except the orb's own PNG.

## Judging bar

Kevin's eye: a contact sheet of the illustrations in both themes. Do they read as one family (stroke, dither, scale,
palette)? Is each one legible as its section's idea in two seconds, big and crisp, with nothing resembling a
screenshot or an ASCII render? Is the dock sticky and always visible with the stream readable under it, in both
themes and on the phone? Then the stream: one picture per section filling its frame, calm rows, CENTER.md spacing.
A build with any capture or harness PNG left in the stream, an ASCII blob, a non-sticky dock or a picture that is an
HTML redraw of an app card scores under 5.
