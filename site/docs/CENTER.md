# CENTER · Kevin (2026-09-30), on the live Console site (main 84474ee): "the center section looks so ugly though. we need to clean it up so much and mimic an actual mac dock at the top too"

Scope: the Now stream only (`site/components/console/stream/*`, `Top.tsx`, `PhaseControl.tsx`, the stream rules
in `styles/console.css` and `styles/desk.css`). The title bar, the left rail, the right rail and the composer stay
as they are. Kevin's "dock" is the notch home (memory `kevin-vocabulary-dock-means-notch`): "mimic an actual mac
dock at the top" = the top of the stream is an actual Mac's top edge: the real menu bar with the notch cut out of
it, the island docked under the notch, the blob in it, on the desktop's ground.

## What is ugly today (name it, then remove it)

- The menu bar is a floating dark strip with rounded ends, not a Mac's menu bar: it does not span the stream, it
  has no Apple mark on the left with the bold app name and the menus, and its status area is three glyphs and a
  clock in a second rounded strip. The notch is a black box between two strips.
- The hero stacks eight things in 500 px: strip, notch, island, the phase control, the h1, the lead, two buttons,
  a note, a badge row. Three of them say the same thing (the badge row repeats the glass button's second line and
  the right rail's Session card).
- Every section head carries a phase eyebrow at its right (`● 0 0 Listening`) that repeats the title bar's word
  and the island's face: clutter, and a §8.12 eyebrow.
- Pictures sit small inside big frames (the Wake gate: a 260 px render in a 396 × 290 black frame with bare
  ground around it; the blob poses the same); the Say picture is a crop that cuts the Console's text at its left
  edge; captions are mono grey and read as debug output; the frame chrome differs from picture to picture.
- Rows and heads are crowded: 12 px between the lead and the rows, the h2 at 26 px with a 15 px lead directly
  under it, the three rows at 28 px pitch, no air between the picture and the words.

## The top of the stream: an actual Mac (build exactly this)

1. **The menu bar** spans the stream column edge to edge, 37 px tall (a notch Mac's), translucent over the
   desktop ground (`rgba(0,0,0,.28)` in dark on the dithered ground; light: `rgba(255,255,255,.55)`), one
   hairline under it. Left: the Apple mark (thesvg `apple`, mono, 16 px) at 16 px from the edge, then `Jarhead`
   at 13 px/600 (the app name is the one bold word macOS draws), then `File  Edit  View  Window  Help` at 13 px/400,
   20 px apart. Right: the status area at 13 px: a Control Center glyph (two sliders; draw it in the kit's style),
   the Wi‑Fi glyph, the battery glyph (with its fill), then `Wed 24 Sep  12:37` (the app's own clock string). The
   text colour is the menu bar's ink (paper on dark, ink on light) at 1.0 for the app name, .85 for the rest.
2. **The notch** is cut out of the menu bar at the centre: 185 × 37, pure black (`#000`, the one place the page
   uses it: it is the bezel), with the two 14 px fillets where it meets the bar, exactly as `notch-island-working.png`
   shows.
3. **The island** hangs under the notch as today (420 × 184, its four bands, the blob in the anchor band, the
   kinds cycling), its top edge continuous with the notch's shoulders. The tucked lip and the asleep pill as today.
4. **The desktop ground** under the bar is the dithered Console ground (already), reading as the wallpaper.
5. **The phase control** moves out of the hero's stack: it becomes a compact six-cell kit Segments row inside the
   island's foot band when the island is open (the app's foot has the meter and the two tiles; the site's foot may
   carry the six faces instead), or, if that fights the app's bands, a 28 px row directly under the island with
   no margin, left-aligned to the island. Either way it reads as part of the dock, not as a page control.

## The hero words: three things

Under the dock, with 32 px of air: the h1 on one line, the lead (two sentences max: cut COPY.md's lead to
"Say jarhead, pass Touch ID, then tell it what to do on your Mac."), then the two calls (the glass Install with
its two lines, `Read the source · ★ n`). Nothing else: no note line, no badge row (the facts live in the glass
button's second line and the right rail).

## Sections: one frame, one picture, one caption, calm rows

- The section head is the orb + name + number only (`● Wake 01`); the phase eyebrow at the right goes.
- The h2 at 24 px/1.15, 500, at most two lines; 16 px to the lead (15 px/1.55 `--jh-fg-2`, ≤ 48ch); 20 px to
  the rows; rows at 36 px pitch with the glyph column at 20; 24 px under the rows before the section rule.
- The picture column: one frame per section, the same chrome everywhere (1 px `--jh-hair-frame`, radius 8,
  the raised ground inside), and the picture FILLS it: render the Wake gate, the blob poses and the island strips
  at the frame's width (object-fit: cover on a 4:3 box, the render scaled up to 1.5× at most so its dither stays
  crisp: the harness PNGs are @2×), the Console captures at 0.5× cropped to the frame with `object-position` on
  the region the section is about (Say: the Brain card whole; Hands: the stream with the Allow/Deny row; Threads:
  the Threads rail). The caption is Inter 12 px `--jh-fg-3`, one line, 8 px under the frame, no mono.
- Words and picture: 48 px gutter; the picture column 46 % of the stream; the words column's rows top-aligned
  with the frame's top.
- 64 px between sections; the section rule stays.

## Non-negotiables

IMMERSE.md's rules (Jarhead's surfaces, dithered grounds, the kit's glyphs, the app's density where the app is
dense; COPY.md strings or the app's own rendered text; both themes; a11y; no claim outside the deck). The glass
button stays the one glass surface. Never `pnpm install` in a copy; dev servers with `./node_modules/.bin/next
dev --webpack --port <port>`.

## Judging bar

Kevin's eye: put `notch-island-working.png` and a description of a real macOS 14 menu bar (Apple mark, bold app
name, menus, status area, the notch) beside the top of each build: does it read as an actual Mac's top edge with
the island docked under the notch? Then count the elements in the first 900 px (target: dock + three hero
things + the first section head) and check every section: one frame filled by its picture, one caption, calm rows,
no eyebrow, consistent chrome. A build that keeps the floating strip, the badge row or the eyebrows scores under 5.
