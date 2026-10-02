# SCRATCH · Kevin (2026-10-01): "make it look a lot better, start from scratch"

The landing page at https://jarhead.kevinliu.studio (`~/jarvis/site`, main d4034e4) has been iterated nine times. Kevin
now wants it redesigned from a clean slate and made to look a lot better. This brief replaces IMMERSE.md, ITERATE.md,
CENTER.md and ART.md as the design law. Those files stay as history: read them to learn what was tried, never to copy a
layout from them.

## Everything Kevin has said about this page, in order (the requirements live here)

1. "make it awesome and epic and in our super cool style with all special jarhead features represented and a jarhead like
   view in mac. and the website should use rsms inter and support dark/light mode and have the mac installation super
   easily there"
2. "use thesvg.org for all icons" (brand marks; generic glyphs stay our own filled set)
3. "make this look a lot better and avoid our anti patterns bro"
4. "make this site a lot, a lot cleaner, use our custom icons and ui style here, and add a lot more space in the actual
   website. and make the hero a lot better and better organized and make the install and presentation of info a lot better"
5. "in terms of reducing wording, only saying important ideas, no weird metaphors or sentences that have interrupted thoughts"
6. "redesign the website to feel much more like working and looking through jarhead instead of looking so generic and
   having weird spacing and whatever. also i liked our dither aesthetic and our custom icons and stuff !!!"
7. "make the install button be bigger and have the icon system requirements and stuff in that button, like it is on other
   sites that ask u to install, and make it glassmorphic like actual apple. make the github have stars and show star count.
   make your mac, by voice one line. finally make the jarhead attached to an actual dock representation, and make the
   states a lot better, and make each section far more understandable and have side by side layouts with good space"
8. "make the threads thing in left show actual threads and show a bunch of agent conversations in the agents section"
9. "the center section looks so ugly though. we need to clean it up so much and mimic an actual mac dock at the top too"
10. "we need to redesign this all honestly this needs to be so much better and the graphics suck, they should be replaced
    by new images/static svgs or something in there" and "the thing on top should be sticky and always visible"
11. "make it look a lot better, start from scratch"

Kevin's "dock" means the notch home: the Mac menu bar with the notch, the island that hangs from it, and the blob in it
(memory `kevin-vocabulary-dock-means-notch`). It does not mean the macOS Dock of app icons.

## What the page must have (from the list above)

- **Looks a lot better.** The bar is the best Mac software sites: apple.com/macos, raycast.com, linear.app, arc.net,
  teenage.engineering. A visitor should think "this is a beautiful, serious product" in two seconds. Use these sites to
  calibrate craft and restraint only. Do not borrow their layouts: a borrowed frame read as generic last time.
- **Unmistakably Jarhead.** Its own surfaces carry the page: the Mac top edge with the notch, the island in its states,
  the blob (the dithered orb with its mono face), the dither as the only texture, the kit's filled glyphs, the agent
  marks. Nothing on the page could belong to another AI product.
- **A lot of space and a calm hierarchy.** One dominant thing per viewport. Big type, few words, generous margins, an
  obvious reading order. Density belongs inside a drawing of the app, never in the page's own layout.
- **The top is sticky and always visible.** The Mac menu bar with the notch and the island hanging under it, with the
  blob, stays on screen at every scroll position. When the page is scrolled it may shrink (scale ≥ 0.6, total height
  ≤ 160 px at 1440 × 900), but the island and the blob's face never disappear or fold to a bare lip. It shows the state
  that fits the section in view, and the states read clearly (listening, thinking, acting, speaking, asleep, alarm).
- **The hero.** "Your Mac, by voice." on one line. One short lead at most. The install button: large, Apple glass
  (frosted fill, hairline, inner top highlight, the one glass surface on the page), the Apple mark, two lines
  (`Install` and `macOS 14+ · Apple silicon · source only`). Beside it `Read the source` with the GitHub mark and the
  live star count (`lib/stars.ts`, `components/console/Stars.tsx`).
- **Install is easy.** The one-liner `curl -fsSL https://jarhead.kevinliu.studio/install.sh | sh` with a Copy button
  that works, the four commands, the requirements. `/install.sh` is served already (`next.config.ts`); keep it.
- **Every section is understandable** on its own: one question answered, words and one picture side by side with good
  space, the picture big. Sections may be merged or dropped. Fewer, stronger sections beat ten weak ones.
- **New pictures, drawn.** No screenshots or harness captures from `docs/media` on the page. Pictures are drawings:
  inline SVG in the family of `components/art/` (see `docs/ART-STYLE.md`: tokens only, dithered `<pattern>` shading,
  the real orb via `renderOrb`, kit glyph paths), or the app's surfaces drawn in HTML/CSS at 1:1 (the island via
  `components/desk/Island.tsx` in any kind, a Console window drawn with the kit). Wake, Threads and Numbers already
  exist in `components/art/` and may be used, changed or replaced. Every picture must be big and legible.
- **Real threads and agent conversations** appear wherever threads or agents are shown: the app's own rows (Slack ·
  asks · screen, Spotify · done · background, Notes · done; Claude Code sessions like `gt · api auth · asks`, `brain ·
  working`, `jarhead · console`, `kevin-wiki · idle`, Codex ended, Cursor idle) with their marks and badges.
- **Inter** (self-hosted InterVariable), **dark and light** through `html[data-theme]` only (the boot script in
  `lib/theme.ts`), a theme toggle, both themes designed, not inverted.
- **Icons:** brand marks from `@thesvg/react` (`mono`); every other glyph from `components/kit/Glyph.tsx` (filled).

## Copy

`content/deck.ts` (COPY.md) is the only source of strings. Drop strings freely and cut at sentence or list-item
boundaries. Never add or reword. The island and menu bar may show the app's own rendered text (`ISLAND` in
`components/desk/Island.tsx`). Short declarative sentences, one idea each. No metaphors. No em dashes. No "not X but Y".
No exclamation marks. Say less than the deck says.

## Throw away (start from scratch)

The current page's layout is gone: the Console window frame around the whole page (title bar, left rail, right rail,
composer), the stream of conversations, the section heads with numbers, the framed captures, the mono labels at 11 px
everywhere, the grey-on-grey density. Write a new `app/page.tsx` and new components in `components/site/` with new
styles in `styles/site.css`. You may reuse engines and parts: `lib/*` (dither, orb, blob, island, live, theme, stars,
cut, phase), `components/kit/*`, `components/desk/*` (Island, Blob, Notch), `components/art/*`, the menu bar
(`components/console/MenuBar.tsx`), the dock's timeline (`components/console/Top.tsx`, `stream/Dock.tsx`,
`DockGround.tsx`), `components/console/Stars.tsx`, `components/install/CopyButton.tsx`, `app/og.png`, icons, manifest.
Move what you reuse out of `components/console/` into `components/site/` or `components/desk/`. When the page is done,
delete every component, style and doc-free file the page no longer imports, so `components/console/`, `components/ui/`
and `styles/console.css` are gone unless something live still needs them.

## The canon (non-negotiable)

Kevin's design system Prototemplate (`~/repos/Prototemplate/DESIGN.md`, `BRAND.md`): ink / raised / titanium / paper,
text at 1.0 / 0.72 / 0.48, exactly one accent for the primary action and selection, hairlines drawn once, filled icons,
one-word titles, warm terse copy. The `--jh-*` tokens in `app/globals.css` and `styles/kit.css` carry it; use tokens,
never raw hex outside those files. The antipatterns: stacked rows as a data dump, transparent or ghost-only buttons,
outline icons, spinners, undithered gradients, blur or glass (the install button is the one exception), drop shadows,
the word "Delete", text-heavy UI, font weight above 500 (the menu bar's bold app name is the exception), eyebrows (small
labels above headings), em dashes, emoji, robot or sparkle icons, smooth-scroll hijacking, violet in the orb, a blob face
under 32 px, captions that read as debug output. Motion: the island's kinds, the blob, the meters and one fade or rise
per section on first view; `prefers-reduced-motion` stills all of it. Accessibility: landmarks, one h1, ordered headings,
focus rings, labels, alt or aria-label on every picture, contrast AA in both themes, tap targets ≥ 40 px.

## Widths

1440 × 900 is the main desktop. Also right at 1280 × 720, 1920 × 1080 and a 390 × 844 phone. No sideways scroll anywhere.
On the phone the sticky top shrinks to fit and stays visible; sections stack picture first.

## Judging bar

Kevin's eye: put the design's hero, three sections and install beside the current site's renders and beside
apple.com/macos and raycast.com. Is it a lot better? Does it look like Jarhead and nothing else? Is there a lot of space
with one dominant thing per viewport? Is the top sticky and alive? Are the pictures drawings, big and legible? Is the
install obvious and Apple-glass? Is the copy short? A design that keeps the three-pane Console frame around the page,
puts a screenshot on the page, shows text below 12 px outside a drawing of the app, or hides the island when scrolled,
scores under 5.
