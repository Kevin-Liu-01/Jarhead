# DESIGN · the page as built (2026-10-02)

The landing page in one page. `LANDING.md` is the brief this answers (LoveFrom's restraint and character, OpenAI's
confident playable product pages, Jarhead's own material); `SCRATCH.md` holds everything Kevin has said and still applies
where LANDING.md does not override it. `content/deck.ts` (`COPY.md`) is the only source of words. Where this page and the
code disagree, fix one of them.

## The look

Paper first, one character, one idea per screen. A warm near-white ground (`--jh-ground`), ink type, white sheets on it.
The hero holds almost nothing: `Your Mac, by voice.` on one line in a light serif, two short sentences, the glass Install
(a physical key, `components/site/InstallKey.tsx`: a glass cap on a body of the blob's dithered ramp that lights the glass
and the paper round it, leans to the pointer, sinks under a press and sends its light running out along its foot from
the press point, under the words) and Read the source, and one quiet mono line (`MIT · $0.05 / min, per second`). Its full
stop is the blob. Every section
after it is a large serif h2 in two lines (the second quieter), one short line of Inter, at most two quiet notes on icons,
and a **plate**: a white sheet with one hairline, its section's phase tone ordered-dithered across it in 2 px Bayer cells
(`components/play/Plate.tsx`, `lib/field.ts`), densest in one corner and thinning to a scatter. The plates are the page's
colour and its pictures; the demo is played on the pale part. Nothing on the page is a capture.

## The type

| face | file | where |
|---|---|---|
| Newsreader (Production Type, OFL), instanced to opsz 36 to 72, wght 300 to 420, Latin, 48 KB | `app/fonts/Newsreader-Display.woff2` | the h1 (330, opsz 72), the h2s (340, opsz 60), the Costs figure, the foot's name |
| Newsreader Italic, one static instance (opsz 22, wght 400), 14 KB | `app/fonts/Newsreader-Italic.woff2` | the voice: every line someone says (the chips, the blob's spoken reasons, `"night."`), always inside a `<q>` or set as speech |
| Inter 4.1 (rsms, OFL), cut with fontTools to wght 400 to 600 with the opsz axis, Latin and the page's punctuation and Mac keys, 48 KB | `app/fonts/InterVariable.woff2` | every other word, 400 and 500; 600 on the bar's app name alone |
| JetBrains Mono 2.304 (OFL), subset, 24 KB | `app/fonts/JetBrainsMono-wght.woff2` | values, commands, the island's head and foot, the terminal, the race, the Sleep clock |

Licences sit beside each file. Weight never goes above 500 outside the bar's app name. No text under 12 px outside the
drawn island (checked at 1440, 1280 and 390).

## The character

The real blob (`lib/blob.ts` on `lib/orb.ts`'s material, `components/desk/Character.tsx`) is the one character. It is blue
in every awake phase, quiet titanium asleep, its halo the phase tone (never violet; thinking wears the accent blue), and
its face never under 32 px.

- **The face** (`lib/eyes.ts`): drawn as shapes, never type. Open eyes are ink ovals (the blob's own ink) that catch the
  light as a paper four-point star toward its gleam and a small paper dot across from it, set low, close and round (just
  above the body's middle, 0.31 R from it each side); the other faces are round-capped lines in the same ink: `- -` a
  soft lid, `^ ^` an arc drawn a touch bolder, `u u` a deep cup, `_ _` flat, `x x`, `> <` squeezed shut, `~ ~` a soft
  ripple. The lids are a spring: a blink squashes the oval shut, the
  body dips with it, and the eye reopens a touch taller before it settles; a happy squint (`^ ^`) comes now and then while
  it listens; the face travels with the look (0.19 R sideways, 0.13 R up and down) and the far eye narrows. Small blobs
  grow their eyes (40 % at a 32 px body) and no line goes under 1.75 px.
- **The sparkle** (`lib/eyes.ts` `TWINKLE`, `lib/blob.ts` `SPARK`): the star's sides are four quadratics, so it reads as a
  star from a 32 px body up; star and dot are solid paper and sit inside the pupil (fitted to 0.96 of its radii, the far
  eye's star narrowed with it). They breathe in size only (a 3.2 s cycle: the star swells as the dot ebbs). A star
  flares for 0.38 s: it twists out and back upright as it rises, stretches into a long thin glint whose top arm reaches
  past the pupil, and shrinks back upright (out-cubic up to its peak at 35 %, in-quad down), the second eye 90 ms after
  the first, and the dot gives way while it does. The hero flares every 2 to 4.6 s, every other blob every 3 to 6 s, and
  1.1 to 1.9 s while lit; also 0.32 s after the eyes open from a closed face (the arrival, a demo blob waking), in the
  eye nearer the key as the Install key lights, and as a squint of joy ends while lit. Never two on one face within
  0.5 s, a flare playing is never cut off, and the page's faces (every blob and the island) take turns, 0.6 s apart. Lit
  (starstruck), the dot sharpens through a diamond into a small star of its own. The happy arcs (`^ ^`) wear their own
  small star and dot off the right eye's outer top: they pop in past their size as the face appears (0.32 s) and pulse
  40 % larger with each flare. When joy starts (a squint of joy, the key lighting up) two stars of field cells pop
  round the head 0.12 s apart, then while lit one more every 1.2 to 2 s; never for a happy face it only keeps. Each is
  a four-point star in the blob's own ramp (on ink a paper middle and light arms, on paper a light middle and blue arms,
  paper where the body swells into it), solid in its middle and a Bayer scatter toward its tips, that pops up in
  0.14 s, holds and dissolves through the thresholds by 0.95 s, on the slots above the shoulders, a cell inside the host.
  The face canvas alone redraws at 60 fps through a flare or a pop; the clock runs only on a face that can show it.
  No mark draws under 0.7 screen px at its resting size, so none drops out a frame early in a blink. Calm: the
  catchlights rest whole, nothing flares or pops, and a lit blob keeps one whole star by its head.
  The stills (`lib/orb.ts` `faceField`) rasterise the same geometry: `O O` with its stars and dots, `^ ^` with its
  sparkle, and the quiet still's `- -`, the stars a touch larger so a small still keeps them. The stills' URLs carry the
  face's version (`Character.tsx`, `eyes-3`). The island draws the same face as SVG paths (`faceMarks`, `components/desk/Island.tsx` `islandFace`, crisp
  at every island scale, the floor judged at its docked 0.6): the ink pupils with their paper star and dot and the ink
  lines, the ink rimmed in the phase-tinted paper so it reads on the island's dark, every light mark on a thin ink halo
  shown only over the rims (grown with a flare), so a glint crossing a pupil's rim keeps its points; it blinks shut for
  one tick, the far eye narrows as it turns to the pointer, its sparkle breathes with the 8 fps loop and flares and pops
  on frames of its own (whole under calm).

- **The hero** (`components/site/HeroCharacter.tsx`): the h1's full stop is a dot of ink on arrival; the blob, asleep and
  the size of the dot, takes its place, wakes, turns blue and springs up to stand on the baseline (`SPRING_CHAR`), glances
  about, then follows the pointer. A press steps it through listening, thinking, acting and asleep, and the island follows.
  Under 600 px it springs up to stand over the line at 108 px (a 77 px body) and leaves the stop a stop. Calm: it is simply
  there. Its keyboard twin is a hidden button beside the h1 (`HeroPoke`). The stop's advance and the mark's margin keep a
  0.26 em breath between the e and a round body (never under a sixth of an em through the wobble; the line is 8.88 em, so
  `--h1` caps at 145.5 px). It loves the glass Install (`components/site/glass.ts`): its first look once it stands is at
  the key (which lights in reply), and while the key is hovered, focused or touched it turns its eyes to it, squints with
  joy (not again within 2 s), then gazes with lit eyes (starstruck, quicker flares, stars popping round its head) and a
  brighter halo, and goes back to the
  pointer when it is let go; a press makes it squint again and hop. Calm: one pose, turned to the key with lit eyes.
- **The glass Install** (`components/site/InstallKey.tsx`): the one glass surface, as a key. The cap is the frosted glass;
  its body, 6 px of the blob's ramp in 1.5 px cells, shows as a lit wall and as a halo on the paper that pools under the
  key and fades in up its sides to the same height on both (its density evened for each colour's contrast). Near the
  pointer the key leans a few px; on it the cap rises level and the light gathers under the finger; focus lights it under
  the mark. A press sinks the cap its full depth with a squash, the Apple mark ducks then hops while its leaf wobbles, and
  the light gathered under the finger runs out both ways along the cap's foot as a crest with the flare behind it,
  spilling a few px at the ends and none toward the terms line; the press point flashes only on bare glass.
  The mark and both lines are masked out of the light with a soft moat, so nothing crosses the words. Springs only while
  something moves; calm cuts between rest, lit and pressed.
- **Install** (`components/site/InstallBlob.tsx`): `Then say jarhead.` ends the same way, its stop the blob, asleep until
  any Copy lands (`COPIED_EVENT`), when it wakes and listens and the island wakes with it.
- **Every demo** has its blob: it hears, thinks, acts, flies to the control the hands press, splits into thread blobs,
  frowns `> <` at a refusal, speaks a reason, falls asleep, looks up at the alarm.
- **Cost**: an engine mounts only when its host comes within a viewport of the screen and is released 4 s after it leaves
  (`Character.tsx`); off screen a blob reads no layout. Until it mounts, and without JS, the host shows its phase's still
  (`app/stills/{awake,happy,quiet}.png`, rendered at build by `lib/still.ts` from the orb engine, the halo read from the
  token sheet).

## The sticky top (`components/site/Top.tsx`, `MenuBar.tsx`, `components/desk/*`, `styles/desk.css`)

- **The bar** (37 px; 44 on the phone) is the paper itself with one hairline: the Apple mark, `Jarhead`, the sections as its
  menus (the one in view marked), the phase dot and word, GitHub with the live star count, the theme, Install, the clock.
  Menus drop last first as the bar narrows; the phone keeps the mark, the name, GitHub and the theme, each a 40 px target.
- **The island** is the app's open island at 1:1 (420 × 184) hung from the notch, scaled as one from its top edge: over the
  hero at `--hero-s`, then its foot rises with the scroll until it docks at `--compact-s` (0.62: 37 + 114 = 151 px). It
  never folds. Every word in it takes `max(its size, 11px / --top-s)`. Once docked a band of the page's ground dissolves in
  one-device-pixel Bayer cells under it, a grain that reads as a fade, so words and ink plates thin out before they reach
  the island and never break into a checkerboard; every section's words start below that band.
- **What it wears** (`lib/live.ts`): each demo **claims** the island for its own section with a `Show` (its kind, the line
  it heard or says, its question, its thread tiles, the foot's figure and meter, the clock), and the hero claims it for the
  hero. A claim shows only while its section is in view (`resolveShow`), so the island never wears another demo's state; a
  section that has claimed nothing wears its own kind with nothing heard. The island's own question (`Slack asks: send "I'm
  running late" to Ben?` with Allow and Deny) appears only when a demo asks for it: Threads at `asks`, Rails when Send is
  sorted into Confirm. Any other spoken line (a reason, `night.`, a reading) is said without buttons.
- **Its motion**: a new kind fades the content out over `--jh-quick`, lands, and the island settles from 0.965 on `SPRING`
  from its top edge (`transform-origin: 50% 0`), so it never leaves the notch. The ink breathes, the head's level trace
  moves, Working counts, the face blinks and turns to the pointer, at 8 fps while the tab is visible. Calm: one pose per
  change and a stepped scale.

## The demos (`components/play/*`, `styles/play.css`)

Every demo works by mouse, touch and keyboard, server-renders a still that explains its idea before anything is pressed
(checked with the bundles blocked), claims the island, and replays (its line again, or the labelled `Replay` pill at the
plate's top right). Threads, Hands, Rails and Sleep play their own route once when the plate first comes into view
(`useFirstView`, a third of it on screen) and rest on the frame the route resolves to, which is also their still. Calm
(reduced motion or `#still`) never autoplays, cuts every move (`CUT`) and keeps each blob to one pose.

| id | what it plays | how a visitor plays it | the still | the island |
|---|---|---|---|---|
| `wake` | asleep; say the word and it hears `O O`; the gate rises with its four ways; hold the round Touch ID pad while its ring draws: granted `^ ^`, the lock opens; let go early: `> <`, denied, one of the three small prints on the Hold line is spent; three misses lock the gate for the deck's minute, counted down on the pad | the `Say "jarhead"` chip (Enter moves focus to the pad), then press and hold the pad (pointer with capture, touch, or a held Space or Enter) | the gate waiting for the press | asleep, `jarhead` heard, awake |
| `say` | two deck lines; `"Click Save"` takes the reflex lane in milliseconds and Save is pressed; the Slack and Spotify line goes to the brain picked in Settings, thinks, and ends with Slack and Spotify working in the hands; the wire taken draws along its length | a chip; the brain rows are a radio group (arrows move and pick) | the router at rest, Codex picked, its wires drawn | the heard line, thinking, acting, the two tiles |
| `threads` | the blob splits: two thread blobs spring out of it (a FLIP from its centre, 60 ms apart) along two wires into their cards, each the app's rail row (mark, `00:06 · screen`, a bar per step, its badge); Spotify finishes in the background; Slack stops at `asks` with its question inside the card, Allow focused, Deny | the line chip; Allow or Deny; `"Stop the Slack one"` | Slack asks, Spotify done | thinking, acting with tiles, then the question |
| `hands` | the h2 lights each sentence as its step plays: a ring draws round the control labelled Save and its tag is read; the blob flies on `SPRING_CHAR` to Save and presses it; the window flashes, its corners close in, and a check says the screenshot only verifies; the blob flies home | the `"Click Save"` chip; on a desk the section also pins its plate (plain CSS sticky, 230 svh) and the scroll steps the three sentences | the three steps at once | acting with `Click Save` |
| `rails` | the table always shows what it holds: Run ends on `"Click Save" runs.`; Confirm lists send, pay, delete, post and purchase and asks every time; Refuse lists NEVER's seven commands. A call in the tray springs into its slot (shared layout), a wire draws down the rail into its row, the row lights, the blob says a second deck line (or frowns at a refusal, its command lit in NEVER) | press a tray chip; press a sorted chip to send it back | Send sorted into Confirm | acting for a run, the question for Send, the reason for the other verbs, listening after a refusal |
| `sleep` | asleep at `$0` with the alarm armed, the plate gone to ink; the night runs on the island's own clock from 12:37 to 07:10 and the alarm rings while it sleeps (the row lights, Snooze 10 or Done; Done leaves it asleep, nothing billed); `"night."` says it back, closes the session and runs the night again | the `"night."` chip; Snooze 10, Done (focused when it rings) | asleep, 12:37, the alarm armed | asleep with the running clock, then the alarm |
| `numbers` | the six latencies race in real time on one honest linear scale; each bar is a `scaleX` of a CSS property written by one rAF that runs only while the plate is on screen; the figure and its n land with the bar | the scale (`8.9 s` shows all six to size, `457 ms` makes the reflex rows race and runs the rest off the edge; a radio group with arrows); `Replay` | the finished race | listening |
| `costs` | the serif figure follows the minutes at five cents a minute to three dollars at the hour; the blob talks while you drag; Asleep makes it `$0` | the native range (drag, tap, arrows); Listening or Asleep (a radio group with arrows) | 7.2 min and $0.36, the island's own reading | the reading on its foot and meter, said while dragging; asleep |
| `install` | the blob at the h2's stop wakes on any Copy | `Copy` on the one-liner or a command | asleep | asleep, then listening |

The wires (`components/play/Wires.tsx`) are measured from the laid-out pieces; Say's and Threads' resting wires are also
kept as a measured set (`AT_REST`, taken at 1440) that the server renders stretched to the stage with a stroke that never
scales, so their stills have wires without JS.

## The motion

One set of tokens, in `app/globals.css` and mirrored in `lib/motion.ts`:

- **Durations**: `--jh-instant` 80, `--jh-quick` 160, `--jh-base` 240, `--jh-slow` 400, `--jh-drift` 600 ms.
- **Eases**: out `(0.16, 1, 0.3, 1)` for what arrives, in-out `(0.65, 0, 0.35, 1)` for what changes in place.
- **Springs**: `SPRING` (visualDuration 0.36, bounce 0.14) for the interface (chips, cards, the island's settle);
  `SPRING_CHAR` (0.52, 0.34) for the blob's own moves (the arrival, the flight to Save, the thread split).
- **Rules**: paths draw along their length (Motion `pathLength`, `slow` in-out); the island crossfades its kinds; chips
  move by shared layout; numbers count (the race, the clock, the cost); each section's h2, words and plate rise once on
  first view, 60 ms apart (three at most); direct manipulation never springs (the Costs range writes its value straight).
  Every loop pauses off screen and on a hidden tab; a section's CSS loops pause while it is off screen (`data-inview`).
- **Calm**: `useCalm()` (reduced motion or `#still`, live through `hashchange`) turns every transition into `CUT`; the boot
  script stamps `html[data-still]` for `#still`, so the CSS loops (a spoken chip's level trace, the working dots, the alarm's
  ring) stop exactly as under reduced motion. Scroll-linked choreography only as plain sticky (Hands), never a hijack.

## The sections, with ids

`hero` · `wake` (split) · `say` (stack) · `threads` (split, plate left) · `hands` (stack, pinned on a desk) · `rails`
(split) · `sleep` (split, plate left) · `numbers` (center) · `costs` (split) · `install` (split, the terminal) · the foot.
`components/site/sections.ts` holds each one's id, deck name, resting island kind and plate tone; the menu bar, the spy
(`SectionSpy.tsx`) and the top read it. A split sets its words in 5.3 : 6.7 beside the plate; a stack sets the words as one
row over a full-width plate; center does the same for the race. Sections are a viewport tall on a desk; at 1280 × 720 every
plate ends inside the viewport under the docked top (short desks tighten the plates and start the words below the dissolve).

## Both themes

`html[data-theme]` is the only switch, stamped before paint by the boot script (`lib/theme.ts` `themeBoot`, its
theme-color read from the token sheet by `lib/tokens.ts`); the visitor's system choice wins until they toggle. Light is
the primary design: warm paper, white plates, the tones in their deeper `-line` steps for anything drawn as a line. Dark
is warm ink with the same restraint: the plates a raised ink, the dither a whisper, the tones themselves. The island and
the terminal are ink screens in both. Every canvas (fields, island ink, meters, blobs, the dissolve) re-inks on a flip.
Tokens only: no raw colour outside `app/globals.css` and `styles/kit.css`.

## The phone (390 × 844)

The bar keeps its four items at 40 px; the island shrinks to fit and docks at 0.6. The hero sets the h1 on one line with
its stop, the blob standing over it at 108 px, and the lead, both calls and the terms line all in the first screen. Every
section stacks words first, then its plate; plates reflow by container query (the router, the cards and the table stack,
their wires drop). Every control is at least 40 px. No sideways scroll.

## The share pictures (`app/card`, `scripts/make-cards.sh`)

The Open Graph card (`public/og.png`, 1200 × 630), the repository's social preview (1280 × 640), the README's banners
(1280 × 480, light and dark, stored at 2x) and the README's GIF (798 × 315) are one family: the h1 on one line in Newsreader with the
blob as its full stop, lit, two stars of a burst round its head and one eye flaring, on the accent dithered up from the
foot. The card and the social preview add the glass Install as a keycap under the line (the blob looks at it) and the host
centred at the foot, clear of the chip X lays over a card's corner and of a preview's rounded corners. The banners are the
line alone over a low pool that thins to the ground before the bottom edge. The GIF is the hero's action without the line
(the banner just above it in the README is the line; a frame's `line: false`): the blob standing over the two-line key,
the key pressed (it sinks, the blob squints and hops), the pointer leaving and coming back (the blob looks away, then
turns back with a squint of joy and a burst of stars), 100 frames at 50 ms, the loop cut on the press, and it opens on a
lit frame for a reader with animated images off. They are the site's art. The README says what the app is and never shows these eyes as
the app's.

- **Metadata** (`lib/metadata.ts`): `og:image` is the static `/og.png?v=2`, 1200 × 630, its alt `ALT.og` (the deck); the
  Twitter card is `summary_large_image` with the same picture. Nothing is rendered at build. Feeds cache a picture by its
  URL for days, and `/og.png` first served the launch card, so the URL carries a version (`OG_VERSION`): bump it whenever
  `og.png` changes. After the deploy, re-scrape the home page in LinkedIn's Post Inspector and Facebook's Sharing Debugger;
  X fetches the new picture once its card cache lets go.
- **The route** (`app/card/page.tsx`, development only: production answers 404, nothing links to it, `noindex`):
  `/card?f=<frame>` shows one frame of `app/card/frames.ts` (`og-light`, `og-dark`, `social`, `banner-light`,
  `banner-dark`, `gif`, `gif-dark`), composed from the page's own pieces: the blob engine (`lib/blob.ts`) mounted directly,
  `InstallKey`, `renderToneField`, the page's fonts and tokens. Any number in a frame can be tried from the query
  (`frames.ts` `tuned`: `line=0`, `fs`, `disc`, `drop`, `seed`, `t`, `lit`, `kx=c`, `mark=0`, the pool's `peak`, `r`, `ay` and more).
- **The clock** (`app/card/clock.ts`): the page's requestAnimationFrame runs on synthetic time at 60 fps, and while a frame
  runs `performance.now` reads that time and `Math.random` a seeded generator (mulberry32). A frame's `seed`, `lit` (when
  what it loves lights up) and `t` (when it is captured) give the same picture every run: two runs differ by at most one
  antialias level in a couple of pixels. A still's moment is read straight from `t`; stepping to the same time plays other
  frames, so a moment is chosen by opening a run of `&t=` values, never by stepping.
- **The capture** (`scripts/make-cards.sh` with `scripts/cards.py`, python3 and Pillow; agent-browser, headless): each
  still is laid out at half its size, captured at 4x and halved with a box filter, so the blob's 1.5 px cells are crisp
  3 px cells and the pool's 2 px cells are 4 px. The banners keep the whole 4x capture (2560 × 960, cells of 6 and 8 px)
  and the README shows them at `width="1280"`: GitHub's column is 830 to 1012 px wide, so a 1x banner would be stretched
  on a Retina screen and its cells would blur. The GIF is laid out at two thirds and captured at 1.5x (whole 2 px cells,
  nothing resampled), stepped 50 ms a frame by `window.__cardStep` with the pointer's beats from `window.__cardDo`, on one
  palette of 127 colours with no dither. The README's pictures have rounded corners (12 px on the banners, a hard 8 px on
  the GIF), so each reads as a plate on GitHub's white and on its dark.
- **The Apple mark**: the key wears it, as the hero's does. `mark: false` in a frame (or `Q="&mark=0"`) takes it off the
  card if a picture should travel without it.
- **To regenerate**: start the dev server (`pnpm -C site dev`), then from the repo root run `site/scripts/make-cards.sh`
  (its two arguments are the base URL and the media folder, by default `http://localhost:3939` and `docs/media`). It
  writes `site/public/og.png` and, in the media folder, `banner-light.png`, `banner-dark.png`, `hero.gif`,
  `hero-dark.gif` and `social-preview.png`. `ONLY="og-light"` takes those stills alone (`og-dark` only when named), `GIF=0`
  skips the GIF, `GIF=only` takes it alone and `GIFS="dark"` takes one theme of it, `Q="&seed=12"` tries numbers,
  `SHEET=<png>` writes a sheet of every fifth GIF frame to choose `POSTER` by. To choose a new moment, open `/card?f=<frame>&seed=<n>&t=<ms>` over a run of values, judge each at 600
  and 300 px wide (`cards.py small`), and write the seed and `t` beside the frame with the reason. Bump `OG_VERSION` in
  `lib/metadata.ts` when `og.png` changed. Commit `og.png` and the
  README's four pictures; upload `social-preview.png` by hand in the repository's settings (General, Social preview).

## Adding a demo

1. Take its words from `content/deck.ts` only, cut with `lib/cut.ts` (`part`, `nth`, `quoted`, `row`, ...), never reworded.
   A control word the deck lacks goes in `UI` (verbs only, six at most; today `Replay` and `Hold`).
2. Add a row to `components/site/sections.ts` (id, deck name, resting island kind, plate tone).
3. Write `components/play/<Name>.tsx` as a client component on a `Plate`: a server-rendered still that explains the idea, a
   `Character` where the blob belongs, `Utter` for anything said, `claim("<id>", …)` for the island, `useSteps` for its beats,
   `useCalm` for cuts, `Replay` to start again, and `useFirstView` if it should play itself once.
4. Put it in `app/page.tsx` inside `<Section meta h2 lead notes layout>`; style it in `styles/play.css` on tokens, with its
   container query for narrow plates and its short-desk rule.
5. Typecheck, build with `--webpack`, and look at it at 1440 × 900, 1280 × 720, 1920 × 1080 and 390 × 844 in both themes,
   with the bundles blocked, under reduced motion, and by keyboard alone.
