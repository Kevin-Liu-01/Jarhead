# LANDING · Kevin (2026-10-02): "make the landing much better inspired off of lovefrom and openai brand and make the landing much more interactive and showing off features featuring the best of graphic and motion design"

This brief replaces SCRATCH.md as the page's design law. DIAGRAMS.md and DIAGRAM-STYLE.md stay the law for the
diagrams themselves (the schematic grammar, JetBrains Mono, Phosphor Fill), adapted to this page's look where needed.
Everything Kevin said in SCRATCH.md's list still holds unless this brief overrides it.

## The two inspirations (borrow the spirit, never the marks)

- **LoveFrom** (lovefrom.com, captured in the scratchpad `ref/lovefrom-*.png`): a near-white paper ground, one classic
  serif set large and quiet, almost nothing else on the screen, and one delightful piece of character animation (a dot
  grows into a bear that walks across the page). Restraint, warmth, craft, wit. Every element earns its place.
- **OpenAI's brand**: a clean sans set large and confident, black and white with colour arriving through big abstract
  imagery (soft fields of colour with grain), pill buttons, generous whitespace, product pages built around demos you
  can play with, motion that is smooth, purposeful and quick.
- Never copy their logos, wordmarks, typefaces (LoveFrom Serif and OpenAI Sans are proprietary), illustrations or
  layouts. Nothing on the page may look like it belongs to either company. Use open fonts and Jarhead's own material.

## Jarhead's version

- **The blob is the character.** As LoveFrom's bear, the real orb (`lib/orb.ts`, `lib/blob.ts`, its mono face) is the
  one character on the page: it arrives, looks at the cursor, listens, thinks, acts, speaks, falls asleep, wakes. It
  carries the page's personality. Faces never under 32 px.
- **Dither is the brand imagery.** Where OpenAI uses soft painterly colour fields, Jarhead uses its dithered fields
  (`lib/dither.ts`, `lib/field.ts`): large, calm, in the phase tones, with fine cells. They are the colour on an
  otherwise paper or ink page.
- **Paper first.** Light is the primary theme: a warm near-white ground, ink type. Dark stays fully designed (warm
  ink, the same restraint). `html[data-theme]` stays the only switch and the visitor's system choice wins until they
  toggle.
- **Type.** Inter (rsms) stays the text and interface face, as Kevin asked on day one. For display (the h1 and the
  section heads) a designer may add one open serif with real character (for example Instrument Serif, Newsreader,
  Fraunces, Libre Caslon, Source Serif 4, EB Garamond, all SIL OFL), self-hosted with its licence in `app/fonts/`, or
  keep Inter Display large and tight. The judges decide by eye. JetBrains Mono stays the mono.
- **The Mac top edge stays sticky and always visible** (Kevin asked for it): the menu bar, the notch and the island
  with the blob. Make it lighter and more elegant to fit the restraint; it may compact on scroll but never disappears
  and the island keeps its states.
- **Install stays easy:** the glass Install button with the Apple mark and `macOS 14+ · Apple silicon · source only`,
  Read the source with the live star count, the one-liner with a working Copy, the four commands, the requirements.

## Much more interactive: show the features by letting the visitor play them

Every feature section becomes something the visitor can do, not only read. Use the deck's own utterances and the
app's own text as the inputs and outputs. Examples to choose from and improve on:
- **Wake:** press and hold (or click) the key to pass the gate; the blob wakes `O O`, the island opens, a wrong press
  shows `> <` and the gate's lock.
- **Say:** pick one of the deck's lines (`"Click Save"`, `"Tell Ben on Slack I'm late and put on Focus on Spotify"`,
  `"Stop the Slack one"`) and watch it route: the reflex lane lights in milliseconds, or the line goes to the brain you
  pick (Codex, Claude Code, a key, a model on this Mac) and on to the hands.
- **Threads:** the Slack and Spotify line splits into two lanes with their own blobs; Slack stops at `asks` until the
  visitor presses Allow or Deny; Spotify finishes on its own.
- **Hands:** watch label, click, screenshot happen on a drawn window; the target ring follows.
- **Rails:** choose an action (send, pay, delete, post, purchase, a "Click Save", mkfs) and see it fall into Run,
  Confirm or Refuse with its reason.
- **Sleep:** say "night." and the island tucks, the meter stops at `$0`; the 07:10 alarm still rings.
- **Numbers:** the latencies race on an honest scale when the section enters.
- **Costs:** a control for minutes of talking moves the meter from `$0.05` a minute to `$3` an hour; asleep stays `$0`.
Every demo works with mouse, touch and keyboard, starts in a meaningful still frame without JavaScript, and replays.
The island at the top reacts to what the visitor does.

## The best of graphic and motion design

- One motion language: springs and short eases from one set of tokens, durations 160 to 600 ms, staggered reveals of
  at most three elements, paths that draw along their length, morphs between the island's states, the blob's character
  animation, numbers that count. Scroll-linked choreography where it explains a sequence (a pinned stage whose diagram
  steps as the words step), never scroll hijacking, never smooth-scroll libraries.
- `motion` (Motion for React, installed in `site/package.json`) is available; CSS and the Web Animations API are fine.
  Canvases and rAF loops pause off-screen. `prefers-reduced-motion` turns every animation into a calm cut.
- Graphic design: a strict grid, a real type scale, optical alignment, generous margins, one accent per view, the
  dithered fields as the only colour imagery, the schematic diagrams as the explanation graphics.

## Copy

`content/deck.ts` remains the only source of words. Drop and cut freely; never reword. Interactive controls use icons
and deck words. If a demo truly needs a control word the deck does not have (at most six such words, verbs only, for
example "Replay"), add it to `deck.ts` under a `UI` export with a comment, and list it in your notes.

## Never

`pnpm install` or `npm install` in a copy; a visible window; screenshots of the app; drop shadows except the soft
depth an object needs to sit on paper (one shadow token, used sparingly); outline-only icons; emoji; robot or sparkle
icons; em dashes; exclamation marks; violet in the orb; text under 12 px outside a drawing of the app; a page that
looks like LoveFrom's or OpenAI's own.

## Judging bar

Put the page beside lovefrom.com, the OpenAI brand as described above, and today's live page. Is it much better? Does
it feel as restrained and crafted as LoveFrom and as confident and alive as OpenAI's product pages, while being
unmistakably Jarhead? Can a visitor play every feature and understand it by playing? Is the motion purposeful, smooth
and consistent? Is install still obvious? Does it work on the phone, by keyboard, with reduced motion, in both themes?
