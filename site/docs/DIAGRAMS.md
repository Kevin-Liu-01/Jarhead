# DIAGRAMS · Kevin (2026-10-02), on the live redesign (main 1aacc19): "our diagrams need to be completely redesigned, use a far better font, lay out stuff better, make far better visuals and use better icons"

> **History (2026-10-02).** The schematic drawings this brief asked for (`components/art/*`) were replaced by the
> playable plates in `components/play/*` (LANDING.md); `DESIGN.md` describes the page as built. The font and icon choices
> made under this brief still hold (DIAGRAM-STYLE.md §1 and §2).

Scope: every picture in the sections, meaning `components/art/*` (Wake, Say, Hands, Rails, Sleep, Numbers, Costs),
`components/site/ConsoleWindow.tsx` (Threads), `components/site/RailsPicture.tsx`, the Install terminal, and how each
section lays its words and its diagram out. The page's frame stays: the hero, the sticky Mac top edge with the island,
the menu bar, the section order, the copy, both themes. Two things change site-wide because the diagrams need them: the
monospace font and the icon family. They change everywhere they appear (the island, the bar, the terminal, the section
lines) so the page stays one system.

Kevin asked for Inter (rsms) for the site on day one. It stays as the sans. "A far better font" is about the diagrams'
type, which today is Menlo: `--font-mono` is `ui-monospace, "SF Mono", Menlo`, Chrome does not support
`ui-monospace`, so most visitors see Menlo. Fix that with a self-hosted mono chosen by eye, and use Inter properly in
the diagrams (real sizes, weights 400 and 500, tabular numbers, Inter's display optical size for big figures).

## What is wrong today (name it, then remove it)

- **Type.** Menlo everywhere in the diagrams, the island and the terminal: wide, heavy, dated. Labels at mixed sizes
  and weights with no scale.
- **Visual language.** The "2.5D stack": every plate has a checkerboard dithered side face, every tether is a
  checkered rope. At diagram size the checker reads as noise and makes the drawings look like toys. Flat saturated cyan,
  amber and violet fills fight each other. The grey "quiet" orbs read as 3D balls. The fingerprint and the clock are
  clip art.
- **Icons.** The kit glyphs are hand approximations of SF Symbols and several are crude (folder, upload, terminal,
  external-link). In Rails, rows of terminal, folder, upload and arrow glyphs repeat and mean nothing.
- **Layout.** Uneven spacing inside the drawings, elements floating, labels closer to their neighbour than to their own
  bar (Numbers), the meter's fill with no meaning (Costs), rows with no words (Rails). Every section uses the same
  template (two-line h2, lead, two glyph lines, one framed plate, sides alternating), so the page repeats itself.

## What a diagram must be

- **Explains one idea at a glance.** Cover the h2: a stranger should still say what the section is about. Every
  diagram has a clear subject, a reading order (left to right or top to bottom) and labels where a shape alone is
  ambiguous. Connectors, groupings, sequence and scale are drawn deliberately.
- **Beautiful at the level of the best product sites.** Calibrate on linear.app, vercel.com, raycast.com,
  apple.com/macos, stripe.com (their diagrams and product vignettes): precise alignment on a grid, one stroke weight,
  one corner radius family, generous inner padding, restrained colour, crisp type at 12 to 14 px, nothing cramped,
  nothing floating. Borrow their craft, never their layouts.
- **Jarhead's own.** The orb (the real `renderOrb` blob with its mono face) appears where a character belongs. The
  notch and the island appear where the place matters. Dither stays part of the identity, used where it reads as
  intended texture (large fields, the orb, a meter's dissolving edge), never as a checker border on every shape.
- **Real words.** Labels come from `content/deck.ts` verbatim or cut at word groups, or from the app's own text
  (`content/island.ts`, `content/rail.ts`). A diagram may label its parts with deck words (for example Rails: Run,
  Confirm, Refuse cut from its h2). No invented claims, numbers or UI.
- **Built well.** Inline SVG or HTML/CSS server components, no hooks, tokens only (`var(--jh-*)`, no raw hex outside
  `app/globals.css` and `styles/kit.css`), `role="img"` with a deck-text label (or a figure with a caption) and the
  data readable to a screen reader where the diagram carries data (Numbers, Costs), both themes from
  `html[data-theme]`, legible on a 390 px phone (redraw or simplify for the phone where needed), each diagram under
  40 KB of markup.

## Font

Choose one monospace by putting candidates side by side in the diagrams, the island and the terminal: Geist Mono,
JetBrains Mono, IBM Plex Mono, Commit Mono, Martian Mono, Departure Mono (a pixel face that matches the dither), or
another face under the SIL Open Font License. Download the woff2 with curl (jsDelivr's `@fontsource` packages or the
foundry's release), self-host it in `app/fonts/` with its licence file beside it, load it with `next/font/local`, and
point `--font-mono` at it with a sane fallback stack. Never a commercial face without a licence in the repo (no
Berkeley Mono, no SF Mono files). Inter stays the sans.

## Icons

Replace the kit's hand-drawn generic glyphs with one high-quality open icon family in a filled or duotone style
(Kevin's canon: filled icons, never outline-only): Phosphor (fill or duotone, MIT), Remix Icon (fill, Apache 2.0),
Tabler (filled, MIT), pixelarticons (MIT, if the direction is pixel), or another with a permissive licence. Vendor only
the icons used as SVG paths in `components/icons/` (fetch the SVG files with curl from jsDelivr or the project's
release; never install packages), with the licence file beside them. Brand marks stay on `@thesvg/react` (`mono`).
The agent marks stay `components/kit/AgentMark.tsx`. Every icon in a diagram must mean something in that place.

## Section layout

Each section's words and diagram are laid out for that diagram: some sections can give the diagram the full width
with the words above, some a split, one can centre a single large figure. Keep the rhythm calm and the reading order
obvious; vary the composition so the page stops repeating one template. The two-line h2 and the deck copy stay.

## Never

`pnpm install` or `npm install` in a copy (node_modules is a symlink into the real repo). A visible window. Raster
images from `docs/media`. Drop shadows, blur, glass (the Install button is the one glass), undithered gradients,
outline-only icons, emoji, robot or sparkle icons, em dashes, text-heavy diagrams, weight above 500 (the menu bar's
app name excepted), violet in the orb.

## Judging bar

Put each diagram beside the current one (`site/docs` has none; use the review renders) and beside the diagrams on
linear.app and vercel.com. Kevin's question: is it far better? Then: does the font read as a deliberate, modern choice
in the diagrams, the island and the terminal? Are the icons clearly better and meaningful? Is every diagram laid out on
a grid with even spacing and an obvious reading order? Would a stranger understand it with the h2 covered? Does the
page still look like Jarhead? A system that keeps checker side faces on every shape, keeps Menlo, keeps the old kit
glyphs, or leaves a diagram that needs its h2 to be understood scores under 5.
